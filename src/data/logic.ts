import type {
  DB, Job, JobStatus, User, AccessoryRequest, Department,
  ApprovalType, ApprovalPayload, BudgetCosts, CostCategoryKey,
} from '../types'

// ---------------------------------------------------------------
// Business logic ทั้งหมดเป็น pure function: รับ DB เดิม คืน DB ใหม่
// ทุก rule อ้างอิง lbs-stock-project-instructions.md เป็น source of truth
// (แก้ไขตามมติ 2026-07-12: Issued → Installed, Reject PR, Partial Receive)
// ---------------------------------------------------------------

export function uid(): string {
  return crypto.randomUUID()
}

function now(): string {
  return new Date().toISOString()
}

export function nextNo(prefix: string, existing: string[]): string {
  const year = new Date().getFullYear()
  const nums = existing
    .map(no => {
      const m = no.match(new RegExp(`^${prefix}-(\\d{4})-(\\d+)$`))
      return m && Number(m[1]) === year ? Number(m[2]) : 0
    })
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`
}

function audit(db: DB, actor: User, entityType: string, entityId: string, action: string, detail: string): DB {
  return {
    ...db,
    auditLogs: [
      {
        id: uid(), entityType, entityId, action,
        actorId: actor.id, detail, createdAt: now(),
      },
      ...db.auditLogs,
    ],
  }
}

// แจ้งเตือนข้ามแผนก (in-app + คิวส่ง LINE — StoreContext เป็นคน resolve lineStatus)
function notify(db: DB, p: { type: string; message: string; dept: Department | 'all'; jobId?: string }): DB {
  return {
    ...db,
    notifications: [
      ...db.notifications,
      { id: uid(), createdAt: now(), readBy: [], lineStatus: 'pending', ...p },
    ],
  }
}

// ---------------- Job status (derive อัตโนมัติ ไม่ใช่ manual toggle) ----------------

export function deriveJobStatus(db: DB, job: Job): JobStatus {
  if (job.terminalStatus) return job.terminalStatus
  const allocated = db.lbsUnits.filter(u => u.jobId === job.id && u.status === 'allocated').length
  const activeReqs = db.accessoryRequests.filter(
    r => r.jobId === job.id && r.status !== 'cancelled' && r.status !== 'returned',
  )
  const pendingReqs = activeReqs.filter(r => r.status !== 'issued' && r.status !== 'received')
  const lbsComplete = job.lbsQtyRequired > 0 && allocated >= job.lbsQtyRequired
  if (lbsComplete && pendingReqs.length === 0) return 'ready_to_issue'
  if (allocated > 0 && pendingReqs.length > 0) return 'procuring_accessory'
  if (allocated > 0) return 'allocated'
  return 'draft'
}

export function jobAllocatedQty(db: DB, jobId: string): number {
  return db.lbsUnits.filter(u => u.jobId === jobId && u.status === 'allocated').length
}

function assertJobEditable(db: DB, jobId: string): Job {
  const job = db.jobs.find(j => j.id === jobId)
  if (!job) throw new Error('ไม่พบ Job')
  if (job.terminalStatus === 'issued' || job.terminalStatus === 'installed')
    throw new Error(`${job.jobNo} เบิกให้ Service แล้ว — ล็อก แก้ไข allocation ไม่ได้`)
  if (job.terminalStatus === 'cancelled')
    throw new Error(`${job.jobNo} ถูกยกเลิกไปแล้ว แก้ไขไม่ได้`)
  return job
}

// no-op (2026-07-19 · sync 0020): เลิกแจ้ง job_ready — ใช้แจ้งตอนดึง LBS แทน
// คง signature ไว้ให้ caller เดิม (addAccessory/receivePO/updateJob/cancelAccessory) ทำงานได้
function notifyIfBecameReady(_before: DB, after: DB, _jobId: string): DB {
  return after
}

// ---------------- Project Stock (Sales) ----------------

// รับคู่ serial (LVB + OM) ต่อเครื่อง — ตรวจครบถ้วน + unique ทั้งสอง field
export interface UnitSerialInput { lvb: string; om: string; cost?: number }

function normalizeUnits(rows: UnitSerialInput[]): UnitSerialInput[] {
  return rows
    .map(r => ({ lvb: r.lvb.trim(), om: r.om.trim(), cost: r.cost }))
    .filter(r => r.lvb || r.om)
}

function assertUnitsValid(db: DB, units: { lvb: string; om: string; cost?: number }[]): void {
  if (units.length === 0) throw new Error('กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง')
  const missing = units.find(u => !u.lvb || !u.om)
  if (missing) throw new Error('ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง')
  const badCost = units.find(u => u.cost !== undefined && (Number.isNaN(u.cost) || u.cost < 0))
  if (badCost) throw new Error('ต้นทุนตัว LBS ต้องเป็นตัวเลขไม่ติดลบ')
  const allSerials = db.lbsUnits.flatMap(u => [u.serialLvb, u.serialOm])
  for (const field of ['lvb', 'om'] as const) {
    const label = field === 'lvb' ? 'Serial.LVB' : 'Serial.OM'
    const dupExisting = units.find(u => allSerials.includes(u[field]))
    if (dupExisting) throw new Error(`${label} "${dupExisting[field]}" มีอยู่ในระบบแล้ว`)
  }
  // กันซ้ำภายในรายการที่กรอก (ข้าม field ด้วย — LVB ห้ามชนกับ OM)
  const seen = new Set<string>()
  for (const u of units) {
    for (const v of [u.lvb, u.om]) {
      if (seen.has(v)) throw new Error(`Serial No. "${v}" ซ้ำกันในรายการที่กรอก`)
      seen.add(v)
    }
  }
}

export function createProjectStock(
  db: DB, actor: User,
  p: { stockNo: string; itemId: string; units: UnitSerialInput[]; notes?: string; poNo?: string },
): DB {
  const stockNo = p.stockNo.trim()
  if (!stockNo) throw new Error('กรุณาระบุ Stock No.')
  if (db.projectStocks.some(s => s.stockNo === stockNo))
    throw new Error(`Stock No. "${stockNo}" มีอยู่แล้ว`)
  const units = normalizeUnits(p.units)
  assertUnitsValid(db, units)

  const stockId = uid()
  let next: DB = {
    ...db,
    projectStocks: [...db.projectStocks, {
      id: stockId, stockNo, itemId: p.itemId, status: 'open',
      poNo: p.poNo?.trim() || undefined, notes: p.notes, createdBy: actor.id, createdAt: now(),
    }],
    lbsUnits: [
      ...db.lbsUnits,
      ...units.map(u => ({
        id: uid(), serialLvb: u.lvb, serialOm: u.om, projectStockId: stockId,
        status: 'in_stock' as const, jobId: null, unitCost: u.cost,
      })),
    ],
  }
  next = notify(next, {
    type: 'stock_created', dept: 'project',
    message: `📦 Sales รับ LBS เข้า ${stockNo} จำนวน ${units.length} เครื่อง — พร้อมให้ดึงเข้า Job`,
  })
  return audit(next, actor, 'project_stock', stockId, 'create_stock',
    `สร้าง ${stockNo} รับ LBS เข้า ${units.length} เครื่อง`)
}

export function addUnitsToStock(db: DB, actor: User, p: { stockId: string; units: UnitSerialInput[] }): DB {
  const stock = db.projectStocks.find(s => s.id === p.stockId)
  if (!stock) throw new Error('ไม่พบ Project Stock')
  const units = normalizeUnits(p.units)
  assertUnitsValid(db, units)
  let next: DB = {
    ...db,
    lbsUnits: [
      ...db.lbsUnits,
      ...units.map(u => ({
        id: uid(), serialLvb: u.lvb, serialOm: u.om, projectStockId: p.stockId,
        status: 'in_stock' as const, jobId: null, unitCost: u.cost,
      })),
    ],
  }
  // แจ้งเข้า LINE ว่ามี LBS เพิ่มเข้าคลัง (sync 0018 — เดิมเงียบ ทั้งรับเข้าคลังเดิมและ Excel import)
  next = notify(next, {
    type: 'stock_received', dept: 'project',
    message: `📦 Division รับ LBS เพิ่มเข้า ${stock.stockNo} จำนวน ${units.length} เครื่อง — พร้อมให้ดึงเข้า Job`,
  })
  return audit(next, actor, 'project_stock', p.stockId, 'add_units',
    `รับ LBS เพิ่มเข้า ${stock.stockNo} จำนวน ${units.length} เครื่อง`)
}

// Import Excel: รับเครื่องใหม่ + อัพเดทต้นทุนของเครื่องที่ "ซ้ำในคลังนี้ (คู่ Serial ตรงกัน)" ในคราวเดียว
// newUnits = แถวที่ยังไม่มีในระบบ (insert) · updateUnits = แถวที่ตรงคู่ Serial กับเครื่องในคลังนี้ (อัพเดทต้นทุน)
// การแยกแยะ new/update/conflict ทำฝั่ง UI (import preview) — ฟังก์ชันนี้เชื่อผลที่ผ่านการตัดสินใจแล้ว
export function importUnitsToStock(
  db: DB, actor: User,
  p: { stockId: string; newUnits: UnitSerialInput[]; updateUnits: UnitSerialInput[] },
): DB {
  const stock = db.projectStocks.find(s => s.id === p.stockId)
  if (!stock) throw new Error('ไม่พบ Project Stock')
  const newUnits = normalizeUnits(p.newUnits)
  const updateUnits = normalizeUnits(p.updateUnits)
  if (newUnits.length) assertUnitsValid(db, newUnits)   // เครื่องใหม่: กันซ้ำกับระบบ/ในไฟล์ + validate cost
  const badCost = updateUnits.find(u => u.cost !== undefined && (Number.isNaN(u.cost) || u.cost < 0))
  if (badCost) throw new Error('ต้นทุนตัว LBS ต้องเป็นตัวเลขไม่ติดลบ')
  if (newUnits.length === 0 && updateUnits.length === 0) throw new Error('ไม่มีรายการให้นำเข้า')

  // อัพเดทต้นทุน: match คู่ Serial (lvb+om) เฉพาะเครื่องในคลังนี้ · cost ว่าง = คงค่าเดิม (ไม่ลบทิ้ง)
  const costByKey = new Map<string, number>()
  for (const u of updateUnits) if (u.cost !== undefined) costByKey.set(`${u.lvb}|${u.om}`, u.cost)
  let updatedCount = 0
  let lbsUnits = db.lbsUnits.map(x => {
    if (x.projectStockId === p.stockId) {
      const c = costByKey.get(`${x.serialLvb}|${x.serialOm}`)
      if (c !== undefined) { updatedCount++; return { ...x, unitCost: c } }
    }
    return x
  })
  // รับเครื่องใหม่เข้าคลัง
  lbsUnits = [
    ...lbsUnits,
    ...newUnits.map(u => ({
      id: uid(), serialLvb: u.lvb, serialOm: u.om, projectStockId: p.stockId,
      status: 'in_stock' as const, jobId: null, unitCost: u.cost,
    })),
  ]
  let next: DB = { ...db, lbsUnits }
  if (newUnits.length > 0) next = notify(next, {
    type: 'stock_received', dept: 'project',
    message: `📦 Division รับ LBS เพิ่มเข้า ${stock.stockNo} จำนวน ${newUnits.length} เครื่อง — พร้อมให้ดึงเข้า Job`,
  })
  return audit(next, actor, 'project_stock', p.stockId, 'import_units',
    `Import เข้า ${stock.stockNo}: รับใหม่ ${newUnits.length} เครื่อง${updatedCount ? ` · อัพเดทต้นทุน ${updatedCount} เครื่อง` : ''}`)
}

export function updateProjectStock(
  db: DB, actor: User,
  p: { stockId: string; notes: string; status: 'open' | 'closed'; poNo?: string },
): DB {
  const stock = db.projectStocks.find(s => s.id === p.stockId)
  if (!stock) throw new Error('ไม่พบ Project Stock')
  let next: DB = {
    ...db,
    projectStocks: db.projectStocks.map(s =>
      s.id === p.stockId ? { ...s, poNo: p.poNo?.trim() || undefined, notes: p.notes, status: p.status } : s),
  }
  return audit(next, actor, 'project_stock', p.stockId, 'update_stock',
    `แก้ไข ${stock.stockNo}${stock.status !== p.status ? ` (${p.status === 'closed' ? 'ปิดคลัง — ห้ามดึงเพิ่ม' : 'เปิดคลังอีกครั้ง'})` : ''}`)
}

// ลบ Project Stock ได้เฉพาะคลัง "เปล่า" (ทุกเครื่องยัง in_stock + ไม่เคยมีประวัติดึง/คืน)
export function deleteProjectStock(db: DB, actor: User, p: { stockId: string }): DB {
  const stock = db.projectStocks.find(s => s.id === p.stockId)
  if (!stock) throw new Error('ไม่พบ Project Stock')
  const units = db.lbsUnits.filter(u => u.projectStockId === p.stockId)
  const bad = units.filter(u => u.status !== 'in_stock').length
  if (bad > 0)
    throw new Error(`${stock.stockNo} มีเครื่องที่ถูกดึงเข้า Job/เบิกแล้ว ${bad} เครื่อง ลบไม่ได้ — ใช้ "ปิดคลัง" แทน`)
  if (db.allocations.some(a => a.projectStockId === p.stockId))
    throw new Error(`${stock.stockNo} มีประวัติดึง/คืนแล้ว ลบไม่ได้ — ใช้ "ปิดคลัง" แทนเพื่อคง audit trail`)
  const next: DB = {
    ...db,
    projectStocks: db.projectStocks.filter(s => s.id !== p.stockId),
    lbsUnits: db.lbsUnits.filter(u => u.projectStockId !== p.stockId),
  }
  return audit(next, actor, 'project_stock', p.stockId, 'delete_stock',
    `ลบ ${stock.stockNo} (LBS ในคลัง ${units.length} เครื่อง ไม่เคยมีประวัติดึง/คืน)`)
}

// แก้ Serial รายเครื่อง — เฉพาะเครื่องที่ยังอยู่ในสต็อก (กัน snapshot serial ใน allocation/audit เพี้ยน)
export function updateUnitInfo(
  db: DB, actor: User,
  p: { unitId: string; serialLvb: string; serialOm: string },
): DB {
  const unit = db.lbsUnits.find(u => u.id === p.unitId)
  if (!unit) throw new Error('ไม่พบเครื่อง LBS')
  if (unit.status !== 'in_stock')
    throw new Error('แก้ Serial ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (ยังไม่ถูกดึงเข้า Job)')
  const lvb = p.serialLvb.trim(), om = p.serialOm.trim()
  if (!lvb || !om) throw new Error('ต้องกรอกทั้ง Serial.LVB และ Serial.OM')
  if (lvb === om) throw new Error('Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน')
  const clash = db.lbsUnits.find(u => u.id !== p.unitId && [u.serialLvb, u.serialOm].some(s => s === lvb || s === om))
  if (clash) throw new Error(`Serial No. "${lvb}" / "${om}" ซ้ำกับเครื่องอื่นในระบบ`)
  const next: DB = {
    ...db,
    lbsUnits: db.lbsUnits.map(u => u.id === p.unitId ? { ...u, serialLvb: lvb, serialOm: om } : u),
  }
  return audit(next, actor, 'lbs_unit', p.unitId, 'update_serials',
    `แก้ Serial: ${unit.serialLvb}/${unit.serialOm} → ${lvb}/${om}`)
}

// ---------------- Job (Project Dept) ----------------

// budget: undefined = ไม่ระบุ; ค่าติดลบไม่ยอมรับ
function normalizeBudget(v: number | undefined): number | undefined {
  if (v === undefined || v === null || Number.isNaN(v)) return undefined
  if (v < 0) throw new Error('มูลค่างบประมาณติดลบไม่ได้')
  return v
}

export interface JobBudgetInput { budgetSalePrice?: number; budgetCosts?: BudgetCosts }

// จุดติดตั้งเพิ่มเติม (จุดที่ 2+) — trim + ตัดแถวว่างทิ้ง · คืน undefined ถ้าไม่เหลือจุด
function normalizeInstallSites(
  sites?: { location: string; requiredDate: string }[],
): { location: string; requiredDate: string }[] | undefined {
  if (!sites) return undefined
  const out = sites
    .map(s => ({ location: (s.location ?? '').trim(), requiredDate: s.requiredDate ?? '' }))
    .filter(s => s.location || s.requiredDate)
  return out.length ? out : undefined
}

// ต้นทุนรวม (planned) = Σ งบ 7 หมวด
export function totalBudgetCost(costs?: BudgetCosts): number | undefined {
  if (!costs) return undefined
  const vals = Object.values(costs).map(c => c?.budget ?? 0)
  return vals.length ? vals.reduce((s, v) => s + v, 0) : undefined
}

function assertBudgetCosts(costs?: BudgetCosts): BudgetCosts | undefined {
  if (!costs) return undefined
  for (const c of Object.values(costs)) {
    if ((c?.budget ?? 0) < 0 || (c?.actual ?? 0) < 0) throw new Error('มูลค่างบประมาณติดลบไม่ได้')
  }
  return costs
}

export function createJob(
  db: DB, actor: User,
  p: { jobNo: string; customerName: string; contactPhone?: string; scope: string; installLocation: string; requiredDate: string; lbsQtyRequired: number; installSites?: { location: string; requiredDate: string }[] } & JobBudgetInput,
): DB {
  const jobNo = p.jobNo.trim()
  if (!jobNo) throw new Error('กรุณาระบุ Job No.')
  if (db.jobs.some(j => j.jobNo.toLowerCase() === jobNo.toLowerCase()))
    throw new Error(`Job No. "${jobNo}" มีอยู่แล้ว`)
  if (!p.customerName.trim()) throw new Error('กรุณาระบุชื่อลูกค้า')
  if (!p.lbsQtyRequired || p.lbsQtyRequired < 1) throw new Error('จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง')
  const salePrice = normalizeBudget(p.budgetSalePrice)
  const costs = assertBudgetCosts(p.budgetCosts)
  const jobId = uid()
  let next: DB = {
    ...db,
    jobs: [...db.jobs, {
      id: jobId, jobNo,
      customerName: p.customerName.trim(), contactPhone: p.contactPhone?.trim() || undefined,
      scope: p.scope,
      installLocation: p.installLocation, requiredDate: p.requiredDate,
      lbsQtyRequired: p.lbsQtyRequired, installSites: normalizeInstallSites(p.installSites),
      budgetSalePrice: salePrice, budgetCost: totalBudgetCost(costs), budgetCosts: costs,
      terminalStatus: null, openedBy: actor.id, createdAt: now(),
    }],
  }
  return audit(next, actor, 'job', jobId, 'create_job',
    `เปิด ${jobNo} ลูกค้า ${p.customerName} ต้องการ LBS ${p.lbsQtyRequired} เครื่อง`)
}

export function updateJob(
  db: DB, actor: User,
  p: { jobId: string; jobNo: string; customerName: string; contactPhone?: string; scope: string; installLocation: string; requiredDate: string; lbsQtyRequired: number; installSites?: { location: string; requiredDate: string }[] } & JobBudgetInput,
): DB {
  const job = assertJobEditable(db, p.jobId)   // แก้ Job No. ได้ก่อนเบิกเท่านั้น (issued/installed/cancelled ล็อกอยู่แล้ว)
  const jobNo = p.jobNo.trim()
  if (!jobNo) throw new Error('กรุณาระบุ Job No.')
  if (db.jobs.some(j => j.id !== p.jobId && j.jobNo.toLowerCase() === jobNo.toLowerCase()))
    throw new Error(`Job No. "${jobNo}" ซ้ำกับ Job อื่น`)
  if (!p.lbsQtyRequired || p.lbsQtyRequired < 1) throw new Error('จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง')
  // ห้ามลด Scope ต่ำกว่าจำนวนที่ถืออยู่ — ไม่งั้น cap การดึง LBS ถูก bypass ได้
  const held = db.lbsUnits.filter(u => u.jobId === p.jobId && u.status === 'allocated').length
  if (p.lbsQtyRequired < held)
    throw new Error(`ลดจำนวนตาม Scope ต่ำกว่าที่ถืออยู่ (${held} เครื่อง) ไม่ได้ — คืน LBS กลับสต็อกก่อน`)
  const salePrice = normalizeBudget(p.budgetSalePrice)
  const costs = assertBudgetCosts(p.budgetCosts)
  let next: DB = {
    ...db,
    jobs: db.jobs.map(j => j.id === p.jobId ? {
      ...j, jobNo, customerName: p.customerName.trim(), contactPhone: p.contactPhone?.trim() || undefined,
      scope: p.scope,
      installLocation: p.installLocation, requiredDate: p.requiredDate,
      lbsQtyRequired: p.lbsQtyRequired, installSites: normalizeInstallSites(p.installSites),
      budgetSalePrice: salePrice, budgetCost: totalBudgetCost(costs), budgetCosts: costs,
    } : j),
  }
  next = notifyIfBecameReady(db, next, p.jobId)
  return audit(next, actor, 'job', p.jobId, 'update_job',
    `แก้ไขข้อมูล ${job.jobNo}${jobNo !== job.jobNo ? ` (เปลี่ยนเลขเป็น ${jobNo})` : ''}`)
}

// แก้เฉพาะงบประมาณ (ราคาขาย + ต้นทุน 7 หมวด) — Manage แก้ได้แม้ Job ล็อกแล้ว
// (ไม่แตะ scope/allocation/Job No. จึงไม่ผ่าน assertJobEditable) — สำหรับแก้ตัวเลขบัญชีย้อนหลัง
export function updateJobBudget(
  db: DB, actor: User,
  p: { jobId: string } & JobBudgetInput,
): DB {
  const job = db.jobs.find(j => j.id === p.jobId)
  if (!job) throw new Error('ไม่พบ Job')
  const salePrice = normalizeBudget(p.budgetSalePrice)
  const costs = assertBudgetCosts(p.budgetCosts)
  const next: DB = {
    ...db,
    jobs: db.jobs.map(j => j.id === p.jobId ? {
      ...j, budgetSalePrice: salePrice, budgetCost: totalBudgetCost(costs), budgetCosts: costs,
    } : j),
  }
  return audit(next, actor, 'job', p.jobId, 'update_job',
    `แก้ไขงบประมาณ ${job.jobNo}`)
}

// ลบได้เฉพาะ Job เปล่า (Draft ที่ยังไม่เคยมี transaction ใดๆ)
export function deleteDraftJob(db: DB, actor: User, p: { jobId: string }): DB {
  const job = assertJobEditable(db, p.jobId)
  const hasAlloc = db.allocations.some(a => a.jobId === p.jobId)
  const hasAcc = db.accessoryRequests.some(r => r.jobId === p.jobId)
  if (hasAlloc || hasAcc)
    throw new Error(`${job.jobNo} มีประวัติ transaction แล้ว ลบไม่ได้ — ใช้ "ยกเลิก Job" แทนเพื่อคง audit trail`)
  let next: DB = { ...db, jobs: db.jobs.filter(j => j.id !== p.jobId) }
  return audit(next, actor, 'job', p.jobId, 'delete_draft_job',
    `ลบ ${job.jobNo} (Draft เปล่า ไม่มี transaction)`)
}

// ดึง LBS: หลายครั้งได้ / ผสมหลาย Stock ได้ / ห้ามเกินยอดคงเหลือ
export function drawLbs(db: DB, actor: User, p: { jobId: string; stockId: string; unitIds: string[] }): DB {
  const job = assertJobEditable(db, p.jobId)
  const stock = db.projectStocks.find(s => s.id === p.stockId)
  if (!stock) throw new Error('ไม่พบ Project Stock')
  if (stock.status === 'closed') throw new Error(`${stock.stockNo} ถูกปิดคลังแล้ว ดึงเพิ่มไม่ได้`)
  if (p.unitIds.length === 0) throw new Error('กรุณาเลือก Serial No. ที่จะดึง')
  // cap ตาม Scope: ดึงรวมแล้วห้ามเกินจำนวนที่ระบุตอนเปิด Job (คืนแล้วดึงใหม่ได้)
  const held = db.lbsUnits.filter(u => u.jobId === p.jobId && u.status === 'allocated').length
  if (held + p.unitIds.length > job.lbsQtyRequired)
    throw new Error(`ดึงเกินจำนวนตาม Scope ไม่ได้ — Scope ${job.lbsQtyRequired} เครื่อง ถืออยู่ ${held} เครื่อง (ดึงได้อีก ${job.lbsQtyRequired - held})`)
  const units = db.lbsUnits.filter(u => p.unitIds.includes(u.id))
  const bad = units.find(u => u.projectStockId !== p.stockId || u.status !== 'in_stock')
  if (bad || units.length !== p.unitIds.length)
    throw new Error('มีเครื่องที่ไม่อยู่ในสต็อกนี้หรือถูกดึงไปแล้ว — ห้ามดึงเกินยอดคงเหลือ')

  let next: DB = {
    ...db,
    lbsUnits: db.lbsUnits.map(u =>
      p.unitIds.includes(u.id) ? { ...u, status: 'allocated' as const, jobId: p.jobId } : u),
    allocations: [...db.allocations, {
      id: uid(), jobId: p.jobId, projectStockId: p.stockId, txnType: 'draw' as const,
      serialNos: units.map(u => u.serialLvb),
      performedBy: actor.id, performedAt: now(),
    }],
  }
  // แจ้งเตือนตอนดึง LBS — serial คู่ + Stock No. ต้นทาง (sync 0020, เข้า LINE + ทุกแผนก)
  next = notify(next, {
    type: 'lbs_drawn', dept: 'all', jobId: p.jobId,
    message: `✅ ${job.jobNo} (${job.customerName}) ดึง LBS ${units.length} เครื่องจาก ${stock.stockNo} — Serial.LVB: ${units.map(u => u.serialLvb).join(', ')} · Serial.OM: ${units.map(u => u.serialOm).join(', ')}`,
  })
  return audit(next, actor, 'stock_allocation', p.jobId, 'draw_lbs',
    `${job.jobNo} ดึง LBS ${units.length} เครื่องจาก ${stock.stockNo} (SN: ${units.map(u => u.serialLvb).join(', ')})`)
}

// คืน LBS: ผู้ใช้เลือกเองว่าคืนเข้า Stock No. ไหน (ไม่ auto FIFO)
export function returnLbs(
  db: DB, actor: User,
  p: { jobId: string; unitIds: string[]; targetStockId: string; note?: string },
): DB {
  const job = assertJobEditable(db, p.jobId)
  const target = db.projectStocks.find(s => s.id === p.targetStockId)
  if (!target) throw new Error('กรุณาเลือก Stock No. ปลายทางที่จะคืน')
  if (p.unitIds.length === 0) throw new Error('กรุณาเลือก Serial No. ที่จะคืน')
  const units = db.lbsUnits.filter(u => p.unitIds.includes(u.id))
  const bad = units.find(u => u.jobId !== p.jobId || u.status !== 'allocated')
  if (bad || units.length !== p.unitIds.length) throw new Error('มีเครื่องที่ไม่ได้ถูกดึงเข้า Job นี้')

  let next: DB = {
    ...db,
    lbsUnits: db.lbsUnits.map(u =>
      p.unitIds.includes(u.id)
        ? { ...u, status: 'in_stock' as const, jobId: null, projectStockId: p.targetStockId }
        : u),
    allocations: [...db.allocations, {
      id: uid(), jobId: p.jobId, projectStockId: p.targetStockId, txnType: 'return' as const,
      serialNos: units.map(u => u.serialLvb),
      performedBy: actor.id, performedAt: now(), note: p.note,
    }],
  }
  return audit(next, actor, 'stock_allocation', p.jobId, 'return_lbs',
    `${job.jobNo} คืน LBS ${units.length} เครื่องเข้า ${target.stockNo} (SN: ${units.map(u => u.serialLvb).join(', ')})`)
}

// สลับเลข Serial (LVB+OM เป็นคู่) ระหว่างเครื่องที่ดึงเข้า Job (allocated) กับเครื่องในคลัง (in_stock)
// เครื่องไม่ย้าย/ไม่เปลี่ยนสถานะ-สังกัดคลัง — แค่แลกคู่เลข · ทำได้หลังดึง LBS จนถึงก่อนเบิก (assertJobEditable)
// เป็น core execute — ถูกเรียกโดย Manage ตรง หรือ approveRequest (หลัง Division อนุมัติ)
export function swapLbs(
  db: DB, actor: User,
  p: { jobId: string; allocatedUnitId: string; stockUnitId: string; reason: string },
): DB {
  const job = assertJobEditable(db, p.jobId)
  if (!p.reason.trim()) throw new Error('กรุณาระบุเหตุผลการสลับ LBS')
  const a = db.lbsUnits.find(u => u.id === p.allocatedUnitId)
  if (!a || a.jobId !== p.jobId || a.status !== 'allocated')
    throw new Error('เครื่องต้นทางต้องเป็น LBS ที่ดึงเข้า Job นี้อยู่ (allocated)')
  const b = db.lbsUnits.find(u => u.id === p.stockUnitId)
  if (!b || b.status !== 'in_stock')
    throw new Error('เครื่องที่จะสลับต้องเป็นเครื่องว่างในคลัง (in_stock)')
  if (a.id === b.id) throw new Error('เลือกเครื่องสลับซ้ำกันไม่ได้')
  // แลกคู่ Serial (permutation → ไม่ชน unique)
  const next: DB = {
    ...db,
    lbsUnits: db.lbsUnits.map(u => {
      if (u.id === a.id) return { ...u, serialLvb: b.serialLvb, serialOm: b.serialOm }
      if (u.id === b.id) return { ...u, serialLvb: a.serialLvb, serialOm: a.serialOm }
      return u
    }),
  }
  return audit(next, actor, 'lbs_unit', a.id, 'swap_lbs_serial',
    `${job.jobNo} สลับ LBS: ${a.serialLvb}/${a.serialOm} ↔ ${b.serialLvb}/${b.serialOm} (คลัง) — เหตุผล: ${p.reason.trim()}`)
}

// ---------------- Accessory ----------------

export function addAccessoryRequest(
  db: DB, actor: User,
  p: { jobId: string; itemId: string; qty: number; source: 'central_stock' | 'purchasing'; unitPrice?: number; phaseBudget?: string },
): DB {
  const job = assertJobEditable(db, p.jobId)
  const item = db.items.find(i => i.id === p.itemId)
  if (!item) throw new Error('ไม่พบ Accessory')
  if (!p.qty || p.qty < 1) throw new Error('จำนวนต้องอย่างน้อย 1')
  const unitPrice = normalizeBudget(p.unitPrice)
  const phaseBudget = p.phaseBudget?.trim() || undefined

  const reqId = uid()
  let next: DB

  if (p.source === 'central_stock') {
    if (!item.stockableCentrally) throw new Error(`${item.name} ไม่มีในสต็อกกลาง ต้องสั่งซื้อผ่าน Purchasing`)
    const row = db.accessoryStock.find(r => r.itemId === p.itemId)
    const onHand = row?.qtyOnHand ?? 0
    if (onHand < p.qty)
      throw new Error(`สต็อกกลาง ${item.name} คงเหลือ ${onHand} ${item.uom} ไม่พอ (ขอ ${p.qty}) — เปลี่ยนเป็นสั่งซื้อผ่าน Purchasing ได้`)
    next = {
      ...db,
      accessoryStock: db.accessoryStock.map(r =>
        r.itemId === p.itemId ? { ...r, qtyOnHand: r.qtyOnHand - p.qty } : r),
      accessoryRequests: [...db.accessoryRequests, {
        id: reqId, jobId: p.jobId, itemId: p.itemId, qtyRequested: p.qty, qtyReceived: 0,
        unitPrice, phaseBudget, source: 'central_stock' as const, status: 'issued' as const, prId: null,
        requestedBy: actor.id, createdAt: now(),
      }],
    }
    // แจ้ง Division เจ้าของสต็อก — ยอดคงเหลือลด (sync 0017)
    next = notify(next, {
      type: 'accessory_issued', dept: 'sales', jobId: p.jobId,
      message: `📤 ${job.jobNo} เบิก ${item.name} ${p.qty} ${item.uom} จากสต็อกกลาง (คงเหลือ ${onHand - p.qty} ${item.uom})`,
    })
    next = notifyIfBecameReady(db, next, p.jobId)
    return audit(next, actor, 'job_accessory_request', reqId, 'issue_accessory_from_stock',
      `${job.jobNo} เบิก ${item.name} ${p.qty} ${item.uom} จากสต็อกกลาง`)
  }

  next = {
    ...db,
    accessoryRequests: [...db.accessoryRequests, {
      id: reqId, jobId: p.jobId, itemId: p.itemId, qtyRequested: p.qty, qtyReceived: 0,
      unitPrice, phaseBudget, source: 'purchasing' as const, status: 'pending' as const, prId: null,
      requestedBy: actor.id, createdAt: now(),
    }],
  }
  return audit(next, actor, 'job_accessory_request', reqId, 'request_accessory_purchase',
    `${job.jobNo} ขอซื้อ ${item.name} ${p.qty} ${item.uom} (รอออก PR)`)
}

// แก้จำนวนได้เฉพาะรายการที่ยังไม่ส่ง PR
export function updateAccessoryRequestQty(db: DB, actor: User, p: { requestId: string; qty: number }): DB {
  const req = db.accessoryRequests.find(r => r.id === p.requestId)
  if (!req) throw new Error('ไม่พบรายการ Accessory')
  const job = assertJobEditable(db, req.jobId)
  if (req.status !== 'pending') throw new Error('แก้จำนวนได้เฉพาะรายการที่ยังไม่ออก PR')
  if (!p.qty || p.qty < 1) throw new Error('จำนวนต้องอย่างน้อย 1')
  const item = db.items.find(i => i.id === req.itemId)!
  let next: DB = {
    ...db,
    accessoryRequests: db.accessoryRequests.map(r =>
      r.id === p.requestId ? { ...r, qtyRequested: p.qty } : r),
  }
  return audit(next, actor, 'job_accessory_request', p.requestId, 'update_accessory_qty',
    `${job.jobNo} แก้จำนวน ${item.name}: ${req.qtyRequested} → ${p.qty} ${item.uom}`)
}

// แก้ราคาต่อหน่วยของวัสดุ (ได้ทุกรายการที่ยัง active) — กระทบมูลค่าวัสดุ/ต้นทุนคงเหลือ
export function updateAccessoryRequestPrice(db: DB, actor: User, p: { requestId: string; unitPrice?: number }): DB {
  const req = db.accessoryRequests.find(r => r.id === p.requestId)
  if (!req) throw new Error('ไม่พบรายการวัสดุ')
  const job = assertJobEditable(db, req.jobId)
  if (req.status === 'cancelled' || req.status === 'returned')
    throw new Error('แก้ราคาได้เฉพาะรายการที่ยังใช้งานอยู่')
  const unitPrice = normalizeBudget(p.unitPrice)
  const item = db.items.find(i => i.id === req.itemId)!
  let next: DB = {
    ...db,
    accessoryRequests: db.accessoryRequests.map(r =>
      r.id === p.requestId ? { ...r, unitPrice } : r),
  }
  return audit(next, actor, 'job_accessory_request', p.requestId, 'update_accessory_price',
    `${job.jobNo} แก้ราคา ${item.name} เป็น ${unitPrice ?? 0} บาท/${item.uom}`)
}

// คืน Accessory ที่เบิกจากสต็อกกลาง (ทำได้เหมือน LBS)
export function returnAccessory(db: DB, actor: User, p: { requestId: string }): DB {
  const req = db.accessoryRequests.find(r => r.id === p.requestId)
  if (!req) throw new Error('ไม่พบรายการ Accessory')
  const job = assertJobEditable(db, req.jobId)
  if (req.source !== 'central_stock' || req.status !== 'issued')
    throw new Error('คืนได้เฉพาะรายการที่เบิกจากสต็อกกลางแล้วเท่านั้น')
  const item = db.items.find(i => i.id === req.itemId)!
  let next: DB = {
    ...db,
    accessoryStock: db.accessoryStock.map(r =>
      r.itemId === req.itemId ? { ...r, qtyOnHand: r.qtyOnHand + req.qtyRequested } : r),
    accessoryRequests: db.accessoryRequests.map(r =>
      r.id === p.requestId ? { ...r, status: 'returned' as const } : r),
  }
  return audit(next, actor, 'job_accessory_request', p.requestId, 'return_accessory',
    `${job.jobNo} คืน ${item.name} ${req.qtyRequested} ${item.uom} กลับสต็อกกลาง`)
}

export function cancelAccessoryRequest(db: DB, actor: User, p: { requestId: string }): DB {
  const req = db.accessoryRequests.find(r => r.id === p.requestId)
  if (!req) throw new Error('ไม่พบรายการ Accessory')
  const job = assertJobEditable(db, req.jobId)
  if (req.status !== 'pending')
    throw new Error('ยกเลิกได้เฉพาะรายการที่ยังไม่ส่ง PR — ถ้าออก PR/PO แล้วให้ประสาน Purchasing')
  const item = db.items.find(i => i.id === req.itemId)!
  let next: DB = {
    ...db,
    accessoryRequests: db.accessoryRequests.map(r =>
      r.id === p.requestId ? { ...r, status: 'cancelled' as const } : r),
  }
  next = notifyIfBecameReady(db, next, req.jobId)
  return audit(next, actor, 'job_accessory_request', p.requestId, 'cancel_accessory_request',
    `${job.jobNo} ยกเลิกคำขอ ${item.name} ${req.qtyRequested} ${item.uom}`)
}

// ลบรายการวัสดุที่ยกเลิกออกจากการ์ด (Project/Division/Manage) — เฉพาะที่ยังไม่เคยผูก PR/PO
// (audit การยกเลิกยังอยู่ใน auditLogs · รายการที่เคยเข้า PR/PO เก็บไว้คงประวัติเอกสาร)
export function deleteAccessoryRequest(db: DB, actor: User, p: { requestId: string }): DB {
  const req = db.accessoryRequests.find(r => r.id === p.requestId)
  if (!req) throw new Error('ไม่พบรายการวัสดุ')
  if (req.status !== 'cancelled')
    throw new Error('ลบออกจากการ์ดได้เฉพาะรายการที่ยกเลิกแล้ว')
  if (req.prId || req.poId)
    throw new Error('รายการนี้เคยผูก PR/PO ลบไม่ได้ (คงประวัติเอกสาร)')
  const job = db.jobs.find(j => j.id === req.jobId)
  const item = db.items.find(i => i.id === req.itemId)
  const next: DB = {
    ...db,
    accessoryRequests: db.accessoryRequests.filter(r => r.id !== p.requestId),
  }
  return audit(next, actor, 'job_accessory_request', p.requestId, 'delete_accessory_request',
    `${job?.jobNo ?? ''} ลบรายการวัสดุที่ยกเลิก ${item?.name ?? ''} ออกจากการ์ด`)
}

// ---------------- PR / PO (Project ↔ Purchasing) ----------------

export function createPR(db: DB, actor: User, p: { jobId: string; requestIds: string[] }): DB {
  const job = assertJobEditable(db, p.jobId)
  const reqs = db.accessoryRequests.filter(r => p.requestIds.includes(r.id))
  if (reqs.length === 0) throw new Error('กรุณาเลือกรายการที่จะออก PR')
  const bad = reqs.find(r => r.jobId !== p.jobId || r.source !== 'purchasing' || r.status !== 'pending')
  if (bad) throw new Error('เลือกได้เฉพาะรายการสั่งซื้อที่ยังไม่ออก PR')

  const prNo = nextNo('PR', db.prs.map(x => x.prNo))
  const prId = uid()
  let next: DB = {
    ...db,
    prs: [...db.prs, {
      id: prId, prNo, jobId: p.jobId, status: 'pending' as const,
      requestIds: p.requestIds, createdBy: actor.id, createdAt: now(),
    }],
    accessoryRequests: db.accessoryRequests.map(r =>
      p.requestIds.includes(r.id) ? { ...r, status: 'pr_sent' as const, prId } : r),
  }
  next = notify(next, {
    type: 'pr_created', dept: 'purchasing', jobId: p.jobId,
    message: `📄 ${prNo} จาก ${job.jobNo} (${job.customerName}) รอออก PO — ${reqs.length} รายการ`,
  })
  return audit(next, actor, 'purchase_requisition', prId, 'create_pr',
    `${job.jobNo} ออก ${prNo} ส่ง Purchasing (${reqs.length} รายการ)`)
}

// Purchasing ตีกลับ PR พร้อมเหตุผล → รายการเด้งกลับเป็น pending ให้ Project แก้/ออกใหม่
export function rejectPR(db: DB, actor: User, p: { prId: string; reason: string }): DB {
  const pr = db.prs.find(x => x.id === p.prId)
  if (!pr) throw new Error('ไม่พบ PR')
  if (pr.status !== 'pending') throw new Error(`${pr.prNo} ออก PO ไปแล้วหรือปิดไปแล้ว ตีกลับไม่ได้`)
  if (!p.reason.trim()) throw new Error('กรุณาระบุเหตุผลที่ตีกลับ')
  const job = db.jobs.find(j => j.id === pr.jobId)!
  let next: DB = {
    ...db,
    prs: db.prs.map(x => x.id === p.prId
      ? { ...x, status: 'rejected' as const, rejectReason: p.reason.trim(), rejectedAt: now() }
      : x),
    accessoryRequests: db.accessoryRequests.map(r =>
      r.prId === p.prId && r.status === 'pr_sent'
        ? { ...r, status: 'pending' as const, prId: null }
        : r),
  }
  next = notify(next, {
    type: 'pr_rejected', dept: 'project', jobId: pr.jobId,
    message: `⛔ Purchasing ตีกลับ ${pr.prNo} (${job.jobNo}) เหตุผล: ${p.reason.trim()} — รายการเด้งกลับให้แก้ไข/ออก PR ใหม่`,
  })
  return audit(next, actor, 'purchase_requisition', p.prId, 'reject_pr',
    `ตีกลับ ${pr.prNo} (${job.jobNo}) เหตุผล: ${p.reason.trim()}`)
}

// ออก PO จาก PR — เลือก line ที่จะสั่ง (1 PR แตกได้หลาย PO), sync 0022
export function createPO(
  db: DB, actor: User,
  p: { prId: string; poNo: string; supplierName: string; expectedDate: string; requestIds?: string[] },
): DB {
  const pr = db.prs.find(x => x.id === p.prId)
  if (!pr) throw new Error('ไม่พบ PR')
  if (pr.status !== 'pending' && pr.status !== 'po_issued') throw new Error(`${pr.prNo} ถูกตีกลับหรือปิดไปแล้ว`)
  const poNo = p.poNo.trim()
  if (!poNo) throw new Error('กรุณาระบุ PO No.')
  if (db.pos.some(x => x.poNo.toLowerCase() === poNo.toLowerCase()))
    throw new Error(`PO No. "${poNo}" มีอยู่แล้ว`)
  if (!p.supplierName.trim()) throw new Error('กรุณาระบุ Supplier')
  const job = db.jobs.find(j => j.id === pr.jobId)!

  // ไม่ระบุ line = เอาทุก line ที่ยังไม่ได้สั่ง (pr_sent) ของ PR นี้
  const sentLines = db.accessoryRequests.filter(r => r.prId === p.prId && r.status === 'pr_sent')
  const ids = p.requestIds && p.requestIds.length ? p.requestIds : sentLines.map(r => r.id)
  const chosen = db.accessoryRequests.filter(r => ids.includes(r.id))
  if (chosen.length === 0) throw new Error('ไม่มีรายการที่จะออก PO (เลือกรายการที่ยังไม่ได้สั่ง)')
  if (chosen.some(r => r.prId !== p.prId || r.status !== 'pr_sent'))
    throw new Error('เลือกได้เฉพาะรายการใน PR นี้ที่ยังไม่ได้ออก PO')

  const poId = uid()
  let next: DB = {
    ...db,
    pos: [...db.pos, {
      id: poId, poNo, prId: p.prId, jobId: pr.jobId,
      supplierName: p.supplierName.trim(), expectedDate: p.expectedDate,
      status: 'issued' as const, createdBy: actor.id, createdAt: now(),
    }],
    prs: db.prs.map(x => x.id === p.prId ? { ...x, status: 'po_issued' as const } : x),
    accessoryRequests: db.accessoryRequests.map(r =>
      ids.includes(r.id) ? { ...r, status: 'po_ordered' as const, poId } : r),
  }
  next = notify(next, {
    type: 'po_created', dept: 'project', jobId: pr.jobId,
    message: `🛒 ${poNo} ออกแล้วจาก ${pr.prNo} (${job.jobNo}) ${chosen.length} รายการ · Supplier: ${p.supplierName.trim()} กำหนดส่ง ${p.expectedDate || 'ไม่ระบุ'}`,
  })
  return audit(next, actor, 'purchase_order', poId, 'create_po',
    `ออก ${poNo} จาก ${pr.prNo} (${job.jobNo}) ${chosen.length} รายการ · Supplier: ${p.supplierName}`)
}

// ยกเลิก PO เดี่ยว (ยังไม่รับของเลย): คืน line ของ PO → pr_sent; PR กลับ pending ถ้าไม่เหลือ line po_ordered
export function cancelPO(db: DB, actor: User, p: { poId: string; reason: string }): DB {
  const po = db.pos.find(x => x.id === p.poId)
  if (!po) throw new Error('ไม่พบ PO')
  if (po.status !== 'issued') throw new Error(`${po.poNo} รับของครบแล้วหรือถูกยกเลิกไปแล้ว`)
  if (!p.reason.trim()) throw new Error('กรุณาระบุเหตุผลที่ยกเลิก PO')
  const got = db.accessoryRequests
    .filter(r => r.poId === p.poId)
    .reduce((s, r) => s + r.qtyReceived, 0)
  if (got > 0)
    throw new Error(`${po.poNo} รับของเข้าระบบแล้ว ${got} หน่วย ยกเลิกไม่ได้ — รับส่วนที่เหลือให้จบ หรือติดต่อ Manager`)
  const job = db.jobs.find(j => j.id === po.jobId)!

  const reqs2 = db.accessoryRequests.map(r =>
    r.poId === p.poId && r.status === 'po_ordered' ? { ...r, status: 'pr_sent' as const, poId: null } : r)
  const stillOrdered = reqs2.some(r => r.prId === po.prId && r.status === 'po_ordered')
  let next: DB = {
    ...db,
    pos: db.pos.map(x => x.id === p.poId ? { ...x, status: 'cancelled' as const } : x),
    prs: db.prs.map(x => x.id === po.prId && !stillOrdered ? { ...x, status: 'pending' as const } : x),
    accessoryRequests: reqs2,
  }
  next = notify(next, {
    type: 'po_cancelled', dept: 'project', jobId: po.jobId,
    message: `🗑️ ยกเลิก ${po.poNo} (${job.jobNo}) เหตุผล: ${p.reason.trim()} — รายการกลับมารอออก PO ใหม่`,
  })
  return audit(next, actor, 'purchase_order', p.poId, 'cancel_po',
    `ยกเลิก ${po.poNo} (${job.jobNo}) เหตุผล: ${p.reason.trim()}`)
}

// Partial receive: รับของทีละรายการ/ทีละจำนวนได้
export function receivePOItems(
  db: DB, actor: User,
  p: { poId: string; receipts: { requestId: string; qty: number }[] },
): DB {
  const po = db.pos.find(x => x.id === p.poId)
  if (!po) throw new Error('ไม่พบ PO')
  if (po.status !== 'issued') throw new Error(`${po.poNo} รับของครบแล้วหรือถูกยกเลิก`)
  const job = db.jobs.find(j => j.id === po.jobId)!
  const receipts = p.receipts.filter(r => r.qty > 0)
  if (receipts.length === 0) throw new Error('กรุณาระบุจำนวนที่รับอย่างน้อย 1 รายการ')

  // match line ด้วย poId (1 PR → หลาย PO)
  const lines = db.accessoryRequests.filter(r => r.poId === po.id)
  const parts: string[] = []
  for (const rc of receipts) {
    const line = lines.find(l => l.id === rc.requestId)
    if (!line) throw new Error('มีรายการที่ไม่อยู่ใน PO นี้')
    const remaining = line.qtyRequested - line.qtyReceived
    if (rc.qty > remaining) {
      const item = db.items.find(i => i.id === line.itemId)!
      throw new Error(`${item.name} ค้างรับแค่ ${remaining} ${item.uom} (กรอก ${rc.qty})`)
    }
  }

  let updatedReqs = db.accessoryRequests.map(r => {
    const rc = receipts.find(x => x.requestId === r.id)
    if (!rc) return r
    const newQty = r.qtyReceived + rc.qty
    const item = db.items.find(i => i.id === r.itemId)!
    parts.push(`${item.name} ${rc.qty} ${item.uom}${newQty >= r.qtyRequested ? ' (ครบ)' : ` (รวม ${newQty}/${r.qtyRequested})`}`)
    return {
      ...r,
      qtyReceived: newQty,
      status: newQty >= r.qtyRequested ? ('received' as const) : ('po_ordered' as const),
    }
  })

  const done = (r: AccessoryRequest) => r.status === 'received' || r.status === 'cancelled' || r.status === 'returned'
  const poComplete = updatedReqs.filter(r => r.poId === po.id).every(done)          // PO เสร็จเมื่อ line ของ PO ครบ
  const prComplete = updatedReqs.filter(r => r.prId === po.prId).every(done)        // PR เสร็จเมื่อทุก line ของ PR ครบ

  let next: DB = {
    ...db,
    accessoryRequests: updatedReqs,
    pos: db.pos.map(x => x.id === p.poId && poComplete
      ? { ...x, status: 'received' as const, receivedAt: now() } : x),
    prs: db.prs.map(x => x.id === po.prId && prComplete
      ? { ...x, status: 'received' as const } : x),
  }
  next = notify(next, {
    type: 'po_received', dept: 'project', jobId: po.jobId,
    message: poComplete
      ? `📬 ${po.poNo} (${job.jobNo}) รับของครบทุกรายการแล้ว`
      : `📬 ${po.poNo} (${job.jobNo}) รับของบางส่วน: ${parts.join(', ')}`,
  })
  next = notifyIfBecameReady(db, next, po.jobId)
  return audit(next, actor, 'purchase_order', p.poId, poComplete ? 'receive_po_complete' : 'receive_po_partial',
    `${po.poNo} (${job.jobNo}) รับของ${poComplete ? 'ครบ' : 'บางส่วน'}: ${parts.join(', ')}`)
}

// ---------------- Issue / Install / Cancel ----------------

export function issueJob(
  db: DB, actor: User,
  p: { jobId: string; startDate: string; endDate: string; location: string; note?: string },
): DB {
  const job = assertJobEditable(db, p.jobId)
  const status = deriveJobStatus(db, job)
  if (status !== 'ready_to_issue')
    throw new Error(`${job.jobNo} ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ`)
  if (!p.startDate || !p.endDate) throw new Error('กรุณาระบุกำหนดวันติดตั้ง (Start–End)')
  if (p.endDate < p.startDate) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง')
  if (!p.location.trim()) throw new Error('กรุณาระบุสถานที่ติดตั้ง (Location)')
  const units = db.lbsUnits.filter(u => u.jobId === p.jobId && u.status === 'allocated')
  const range = p.startDate === p.endDate ? p.startDate : `${p.startDate} – ${p.endDate}`
  let next: DB = {
    ...db,
    jobs: db.jobs.map(j => j.id === p.jobId
      ? {
          ...j, terminalStatus: 'issued' as const, issuedAt: now(), issuedNote: p.note,
          installStartDate: p.startDate, installEndDate: p.endDate, issueLocation: p.location.trim(),
        }
      : j),
    lbsUnits: db.lbsUnits.map(u =>
      u.jobId === p.jobId && u.status === 'allocated' ? { ...u, status: 'issued' as const } : u),
  }
  next = notify(next, {
    type: 'job_issued', dept: 'service', jobId: p.jobId,
    message: `🚚 ${job.jobNo} (${job.customerName}) เบิกของครบแล้ว — Service เข้าติดตั้งที่ ${p.location.trim()} กำหนด ${range}`,
  })
  return audit(next, actor, 'job', p.jobId, 'issue_to_service',
    `เบิก ${job.jobNo} ให้ Service ติดตั้ง (LBS ${units.length} เครื่อง) นัดติดตั้ง ${range} ที่ ${p.location.trim()}`)
}

// Service ยืนยันติดตั้งเสร็จ พร้อมวันที่จริง → Installed (terminal)
export function confirmInstall(
  db: DB, actor: User,
  p: { jobId: string; installedDate: string; note?: string; checkinLat?: number; checkinLng?: number; photoUrl?: string },
): DB {
  const job = db.jobs.find(j => j.id === p.jobId)
  if (!job) throw new Error('ไม่พบ Job')
  if (job.terminalStatus !== 'issued')
    throw new Error(`ยืนยันติดตั้งได้เฉพาะงานที่เบิกแล้ว (Issued) — ${job.jobNo} อยู่สถานะอื่น`)
  if (!p.installedDate) throw new Error('กรุณาระบุวันที่ติดตั้งจริง')
  // บังคับ Check-in ตำแหน่ง + รูปถ่ายทุกครั้ง (sync 0019)
  if (p.checkinLat === undefined || p.checkinLng === undefined) throw new Error('ต้อง Check-in ตำแหน่งหน้างานก่อนยืนยัน')
  if (!p.photoUrl) throw new Error('ต้องแนบรูปถ่ายหน้างานก่อนยืนยัน')
  let next: DB = {
    ...db,
    jobs: db.jobs.map(j => j.id === p.jobId
      ? {
          ...j, terminalStatus: 'installed' as const,
          installedAt: p.installedDate, installNote: p.note, installConfirmedBy: actor.id,
          installCheckinLat: p.checkinLat, installCheckinLng: p.checkinLng, installPhotoUrl: p.photoUrl,
        }
      : j),
  }
  next = notify(next, {
    type: 'job_installed', dept: 'project', jobId: p.jobId,
    message: `🏁 ${job.jobNo} (${job.customerName}) ติดตั้งเสร็จเมื่อ ${p.installedDate} — ยืนยันโดย ${actor.fullName} 📍 พิกัด ${p.checkinLat.toFixed(5)}, ${p.checkinLng.toFixed(5)}`,
  })
  return audit(next, actor, 'job', p.jobId, 'confirm_install',
    `${job.jobNo} ติดตั้งเสร็จ วันที่จริง ${p.installedDate} (check-in ${p.checkinLat.toFixed(5)},${p.checkinLng.toFixed(5)})${p.note ? ` — ${p.note}` : ''}`)
}

// ยกเลิก Job: auto คืน LBS กลับ Stock เดิมตาม allocation + คืน Accessory สต็อกกลาง
export function cancelJob(
  db: DB, actor: User,
  p: { jobId: string; reason: string; receivedAccessoryToCentral: boolean },
): DB {
  const job = assertJobEditable(db, p.jobId)
  if (!p.reason.trim()) throw new Error('กรุณาระบุเหตุผลการยกเลิก')

  let next: DB = db
  const ts = now()

  const units = db.lbsUnits.filter(u => u.jobId === p.jobId && u.status === 'allocated')
  const byStock = new Map<string, typeof units>()
  units.forEach(u => {
    const arr = byStock.get(u.projectStockId) ?? []
    arr.push(u)
    byStock.set(u.projectStockId, arr)
  })
  next = {
    ...next,
    lbsUnits: next.lbsUnits.map(u =>
      u.jobId === p.jobId && u.status === 'allocated'
        ? { ...u, status: 'in_stock' as const, jobId: null }
        : u),
    allocations: [
      ...next.allocations,
      ...Array.from(byStock.entries()).map(([stockId, us]) => ({
        id: uid(), jobId: p.jobId, projectStockId: stockId, txnType: 'return' as const,
        serialNos: us.map(u => u.serialLvb),
        performedBy: actor.id, performedAt: ts, note: 'auto-return จากการยกเลิก Job',
      })),
    ],
  }

  const reqs = next.accessoryRequests.filter(r => r.jobId === p.jobId)
  const restock = new Map<string, number>()
  const updatedReqs = next.accessoryRequests.map(r => {
    if (r.jobId !== p.jobId) return r
    if (r.source === 'central_stock' && r.status === 'issued') {
      restock.set(r.itemId, (restock.get(r.itemId) ?? 0) + r.qtyRequested)
      return { ...r, status: 'returned' as const }
    }
    // รับของจาก PO มาแล้วบางส่วน (po_ordered + qtyReceived > 0) — ห้ามทิ้งเงียบ ปฏิบัติเหมือน received (sync 0015)
    if (r.status === 'po_ordered' && r.qtyReceived > 0) {
      if (p.receivedAccessoryToCentral) {
        restock.set(r.itemId, (restock.get(r.itemId) ?? 0) + r.qtyReceived)
        return { ...r, status: 'returned' as const }
      }
      return { ...r, status: 'received' as const }   // ปิดยอดตามที่รับจริง (ส่วนค้างรับยกเลิกไปกับ PO) พิจารณาเป็นเคสไป
    }
    if (r.status === 'pending' || r.status === 'pr_sent' || r.status === 'po_ordered')
      return { ...r, status: 'cancelled' as const }
    if (r.status === 'received' && p.receivedAccessoryToCentral) {
      restock.set(r.itemId, (restock.get(r.itemId) ?? 0) + r.qtyReceived)
      return { ...r, status: 'returned' as const }
    }
    return r
  })
  let accessoryStock = [...next.accessoryStock]
  restock.forEach((qty, itemId) => {
    const row = accessoryStock.find(x => x.itemId === itemId)
    if (row) accessoryStock = accessoryStock.map(x => x.itemId === itemId ? { ...x, qtyOnHand: x.qtyOnHand + qty } : x)
    else accessoryStock.push({ itemId, qtyOnHand: qty })
  })

  const openPrIds = next.prs.filter(x => x.jobId === p.jobId && (x.status === 'pending' || x.status === 'po_issued')).map(x => x.id)
  next = {
    ...next,
    accessoryRequests: updatedReqs,
    accessoryStock,
    prs: next.prs.map(x => openPrIds.includes(x.id) ? { ...x, status: 'cancelled' as const } : x),
    pos: next.pos.map(x => x.jobId === p.jobId && x.status === 'issued' ? { ...x, status: 'cancelled' as const } : x),
    jobs: next.jobs.map(j => j.id === p.jobId
      ? { ...j, terminalStatus: 'cancelled' as const, cancelledAt: ts, cancelledBy: actor.id, cancelReason: p.reason }
      : j),
  }

  next = notify(next, {
    type: 'job_cancelled', dept: 'all', jobId: p.jobId,
    message: `❌ ยกเลิก ${job.jobNo} (${job.customerName}) เหตุผล: ${p.reason.trim()} — คืน LBS ${units.length} เครื่อง + Accessory กลับสต็อกอัตโนมัติ`,
  })
  // นับทั้งรับครบ (received) และรับบางส่วน (po_ordered + qtyReceived > 0) — สถานะ ณ ก่อนยกเลิก
  const receivedCount = reqs.filter(r => r.status === 'received' || (r.status === 'po_ordered' && r.qtyReceived > 0)).length
  return audit(next, actor, 'job', p.jobId, 'cancel_job',
    `ยกเลิก ${job.jobNo} (${p.reason}) — คืน LBS ${units.length} เครื่องกลับสต็อกเดิม` +
    (receivedCount > 0
      ? p.receivedAccessoryToCentral
        ? ` + Accessory ที่รับจาก PO แล้วเข้าสต็อกกลาง`
        : ` (Accessory ที่รับจาก PO แล้วพิจารณาเป็นเคสไป)`
      : ''))
}

// ---------------- Division approval (sync 0016) ----------------
// project ขออนุมัติ 3 action → division (dept 'sales') / admin อนุมัติ = execute ทันที
// admin ข้ามขั้นอนุมัติได้โดยเรียก createPR/issueJob/cancelJob ตรง (StoreContext คุมสิทธิ์)

const APPROVAL_TYPE_LABEL: Record<ApprovalType, string> = {
  create_pr: 'ออก PR', issue_job: 'เบิกให้ Service', cancel_job: 'ยกเลิก Job', swap_lbs: 'สลับ LBS',
}

export function requestApproval(
  db: DB, actor: User,
  p: { type: ApprovalType; jobId: string; payload: ApprovalPayload },
): DB {
  const job = assertJobEditable(db, p.jobId)
  if (db.approvalRequests.some(r => r.jobId === p.jobId && r.type === p.type && r.status === 'pending'))
    throw new Error(`${job.jobNo} มีคำขอประเภทนี้รอ Division อนุมัติอยู่แล้ว`)

  // validate ล่วงหน้าตาม type (validate เต็มอีกรอบตอน execute)
  let typeLabel: string = APPROVAL_TYPE_LABEL[p.type]
  if (p.type === 'create_pr') {
    const ids = p.payload.requestIds ?? []
    if (ids.length === 0) throw new Error('กรุณาเลือกรายการที่จะออก PR')
    const reqs = db.accessoryRequests.filter(r => ids.includes(r.id))
    if (reqs.length !== ids.length || reqs.some(r => r.jobId !== p.jobId || r.source !== 'purchasing' || r.status !== 'pending'))
      throw new Error('เลือกได้เฉพาะรายการสั่งซื้อที่ยังไม่ออก PR')
    typeLabel = `ออก PR (${ids.length} รายการ)`
  } else if (p.type === 'issue_job') {
    if (deriveJobStatus(db, job) !== 'ready_to_issue')
      throw new Error(`${job.jobNo} ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ`)
    if (!p.payload.startDate || !p.payload.endDate) throw new Error('กรุณาระบุกำหนดวันติดตั้ง (Start–End)')
    if (p.payload.endDate < p.payload.startDate) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง')
    if (!p.payload.location?.trim()) throw new Error('กรุณาระบุสถานที่ติดตั้ง (Location)')
  } else if (p.type === 'swap_lbs') {
    if (!p.payload.reason?.trim()) throw new Error('กรุณาระบุเหตุผลการสลับ LBS')
    const a = db.lbsUnits.find(u => u.id === p.payload.swapAllocatedUnitId)
    if (!a || a.jobId !== p.jobId || a.status !== 'allocated')
      throw new Error('เครื่องต้นทางต้องเป็น LBS ที่ดึงเข้า Job นี้อยู่ (allocated)')
    const b = db.lbsUnits.find(u => u.id === p.payload.swapStockUnitId)
    if (!b || b.status !== 'in_stock')
      throw new Error('เครื่องที่จะสลับต้องเป็นเครื่องว่างในคลัง (in_stock)')
    typeLabel = 'สลับ LBS'
  } else {
    if (!p.payload.reason?.trim()) throw new Error('กรุณาระบุเหตุผลการยกเลิก')
  }

  const reqId = uid()
  let next: DB = {
    ...db,
    approvalRequests: [...db.approvalRequests, {
      id: reqId, type: p.type, jobId: p.jobId, payload: p.payload,
      status: 'pending' as const, requestedBy: actor.id, requestedAt: now(),
    }],
  }
  next = notify(next, {
    type: 'approval_requested', dept: 'sales', jobId: p.jobId,
    message: `🔔 ${job.jobNo} (${job.customerName}) ขออนุมัติ${typeLabel} โดย ${actor.fullName}`,
  })
  return audit(next, actor, 'approval_request', reqId, 'request_approval',
    `${job.jobNo} ขออนุมัติ${typeLabel}`)
}

export function approveRequest(db: DB, actor: User, p: { requestId: string }): DB {
  const req = db.approvalRequests.find(r => r.id === p.requestId)
  if (!req) throw new Error('ไม่พบคำขออนุมัติ')
  if (req.status !== 'pending') throw new Error('คำขอนี้ถูกตัดสินไปแล้ว')
  const job = db.jobs.find(j => j.id === req.jobId)!

  let next: DB = {
    ...db,
    approvalRequests: db.approvalRequests.map(r =>
      r.id === p.requestId ? { ...r, status: 'approved' as const, decidedBy: actor.id, decidedAt: now() } : r),
  }
  // execute ทันที — ถ้า throw ระหว่างนี้ state ทั้งหมดไม่ถูก apply (StoreContext apply ตอนจบเท่านั้น)
  if (req.type === 'create_pr') {
    next = createPR(next, actor, { jobId: req.jobId, requestIds: req.payload.requestIds ?? [] })
  } else if (req.type === 'issue_job') {
    next = issueJob(next, actor, {
      jobId: req.jobId, startDate: req.payload.startDate ?? '', endDate: req.payload.endDate ?? '',
      location: req.payload.location ?? '', note: req.payload.note,
    })
  } else if (req.type === 'swap_lbs') {
    next = swapLbs(next, actor, {
      jobId: req.jobId, allocatedUnitId: req.payload.swapAllocatedUnitId ?? '',
      stockUnitId: req.payload.swapStockUnitId ?? '', reason: req.payload.reason ?? '',
    })
  } else {
    next = cancelJob(next, actor, {
      jobId: req.jobId, reason: req.payload.reason ?? '',
      receivedAccessoryToCentral: req.payload.receivedToCentral ?? true,
    })
  }
  next = notify(next, {
    type: 'approval_approved', dept: 'project', jobId: req.jobId,
    message: `✅ Division อนุมัติ${APPROVAL_TYPE_LABEL[req.type]} ของ ${job.jobNo} แล้ว (โดย ${actor.fullName})`,
  })
  return audit(next, actor, 'approval_request', p.requestId, 'approve_request',
    `อนุมัติ${APPROVAL_TYPE_LABEL[req.type]} ของ ${job.jobNo}`)
}

export function rejectApprovalRequest(db: DB, actor: User, p: { requestId: string; reason: string }): DB {
  const req = db.approvalRequests.find(r => r.id === p.requestId)
  if (!req) throw new Error('ไม่พบคำขออนุมัติ')
  if (req.status !== 'pending') throw new Error('คำขอนี้ถูกตัดสินไปแล้ว')
  if (!p.reason.trim()) throw new Error('กรุณาระบุเหตุผลที่ตีกลับ')
  const job = db.jobs.find(j => j.id === req.jobId)!

  let next: DB = {
    ...db,
    approvalRequests: db.approvalRequests.map(r =>
      r.id === p.requestId
        ? { ...r, status: 'rejected' as const, decidedBy: actor.id, decidedAt: now(), rejectReason: p.reason.trim() }
        : r),
  }
  next = notify(next, {
    type: 'approval_rejected', dept: 'project', jobId: req.jobId,
    message: `⛔ Division ตีกลับคำขอ${APPROVAL_TYPE_LABEL[req.type]} ของ ${job.jobNo} — เหตุผล: ${p.reason.trim()}`,
  })
  return audit(next, actor, 'approval_request', p.requestId, 'reject_request',
    `ตีกลับคำขอ${APPROVAL_TYPE_LABEL[req.type]} ของ ${job.jobNo} เหตุผล: ${p.reason.trim()}`)
}

// ---------------- Master Data: Items / Central stock ----------------

export function createItem(
  db: DB, actor: User,
  p: { code: string; epicorCode?: string; name: string; uom: string; stockableCentrally: boolean; initialQty?: number },
): DB {
  const code = p.code.trim()
  const epicorCode = p.epicorCode?.trim() || undefined
  if (!code || !p.name.trim()) throw new Error('กรุณาระบุรหัสและชื่อ Accessory')
  if (db.items.some(i => i.code.toLowerCase() === code.toLowerCase()))
    throw new Error(`รหัส "${code}" มีอยู่แล้ว`)
  if (epicorCode && db.items.some(i => i.epicorCode?.toLowerCase() === epicorCode.toLowerCase()))
    throw new Error(`รหัส Epicor "${epicorCode}" มีอยู่แล้ว`)
  const itemId = uid()
  let next: DB = {
    ...db,
    items: [...db.items, {
      id: itemId, code, epicorCode, name: p.name.trim(), itemType: 'accessory' as const,
      uom: p.uom.trim() || 'ชิ้น', stockableCentrally: p.stockableCentrally,
    }],
    accessoryStock: p.stockableCentrally
      ? [...db.accessoryStock, { itemId, qtyOnHand: Math.max(0, p.initialQty ?? 0) }]
      : db.accessoryStock,
  }
  return audit(next, actor, 'item', itemId, 'create_item',
    `เพิ่ม Accessory ${p.name.trim()} (${code}) ${p.stockableCentrally ? `มีสต็อกกลาง เริ่มต้น ${p.initialQty ?? 0}` : 'สั่งซื้อผ่าน Purchasing เท่านั้น'}`)
}

export function updateItem(
  db: DB, actor: User,
  p: { itemId: string; code: string; epicorCode?: string; name: string; uom: string; stockableCentrally: boolean },
): DB {
  const item = db.items.find(i => i.id === p.itemId)
  if (!item) throw new Error('ไม่พบรายการ')
  if (item.itemType === 'main_equipment') throw new Error('แก้ไข LBS หลักไม่ได้จากหน้านี้')
  const code = p.code.trim()
  const epicorCode = p.epicorCode?.trim() || undefined
  if (db.items.some(i => i.id !== p.itemId && i.code.toLowerCase() === code.toLowerCase()))
    throw new Error(`รหัส "${code}" ซ้ำกับรายการอื่น`)
  if (epicorCode && db.items.some(i => i.id !== p.itemId && i.epicorCode?.toLowerCase() === epicorCode.toLowerCase()))
    throw new Error(`รหัส Epicor "${epicorCode}" ซ้ำกับรายการอื่น`)
  const stockRow = db.accessoryStock.find(r => r.itemId === p.itemId)
  if (!p.stockableCentrally && (stockRow?.qtyOnHand ?? 0) > 0)
    throw new Error(`ยังมีของในสต็อกกลาง ${stockRow!.qtyOnHand} ${item.uom} — ปรับยอดเป็น 0 ก่อนจึงจะปิดการเก็บสต็อกกลางได้`)
  let next: DB = {
    ...db,
    items: db.items.map(i => i.id === p.itemId
      ? { ...i, code, epicorCode, name: p.name.trim(), uom: p.uom.trim() || i.uom, stockableCentrally: p.stockableCentrally }
      : i),
    accessoryStock: p.stockableCentrally && !stockRow
      ? [...db.accessoryStock, { itemId: p.itemId, qtyOnHand: 0 }]
      : db.accessoryStock,
  }
  return audit(next, actor, 'item', p.itemId, 'update_item', `แก้ไข Accessory ${p.name.trim()} (${code})`)
}

export function deleteItem(db: DB, actor: User, p: { itemId: string }): DB {
  const item = db.items.find(i => i.id === p.itemId)
  if (!item) throw new Error('ไม่พบรายการ')
  if (item.itemType === 'main_equipment') throw new Error('ลบ LBS หลักไม่ได้')
  if (db.accessoryRequests.some(r => r.itemId === p.itemId))
    throw new Error(`${item.name} ถูกใช้ใน Job แล้ว ลบไม่ได้ (คง audit trail)`)
  if ((db.accessoryStock.find(r => r.itemId === p.itemId)?.qtyOnHand ?? 0) > 0)
    throw new Error(`${item.name} ยังมีของในสต็อกกลาง ลบไม่ได้`)
  let next: DB = {
    ...db,
    items: db.items.filter(i => i.id !== p.itemId),
    accessoryStock: db.accessoryStock.filter(r => r.itemId !== p.itemId),
  }
  return audit(next, actor, 'item', p.itemId, 'delete_item', `ลบ Accessory ${item.name} (${item.code})`)
}

export function adjustAccessoryStock(
  db: DB, actor: User,
  p: { itemId: string; newQty: number; note: string },
): DB {
  const item = db.items.find(i => i.id === p.itemId)
  if (!item || !item.stockableCentrally) throw new Error('รายการนี้ไม่มีสต็อกกลาง')
  if (p.newQty < 0) throw new Error('ยอดคงเหลือติดลบไม่ได้')
  if (!p.note.trim()) throw new Error('กรุณาระบุเหตุผลการปรับยอด (เพื่อ audit)')
  const row = db.accessoryStock.find(r => r.itemId === p.itemId)
  const oldQty = row?.qtyOnHand ?? 0
  let next: DB = {
    ...db,
    accessoryStock: row
      ? db.accessoryStock.map(r => r.itemId === p.itemId ? { ...r, qtyOnHand: p.newQty } : r)
      : [...db.accessoryStock, { itemId: p.itemId, qtyOnHand: p.newQty }],
  }
  return audit(next, actor, 'accessory_stock', p.itemId, 'adjust_stock',
    `ปรับยอดสต็อกกลาง ${item.name}: ${oldQty} → ${p.newQty} ${item.uom} (${p.note.trim()})`)
}

// ---------------- Master Data: Users ----------------

export function createUser(
  db: DB, actor: User,
  p: { email: string; fullName: string; department: Department; password: string },
): DB {
  const email = p.email.trim().toLowerCase()
  if (!email || !p.fullName.trim()) throw new Error('กรุณาระบุอีเมลและชื่อ')
  if (!p.password) throw new Error('กรุณาระบุรหัสผ่าน')
  if (db.users.some(u => u.email.toLowerCase() === email)) throw new Error(`อีเมล ${email} มีอยู่แล้ว`)
  const userId = uid()
  let next: DB = {
    ...db,
    users: [...db.users, {
      id: userId, email, fullName: p.fullName.trim(),
      department: p.department, password: p.password, isActive: true,
    }],
  }
  return audit(next, actor, 'user', userId, 'create_user',
    `เพิ่มผู้ใช้ ${p.fullName.trim()} (${email}) แผนก ${p.department}`)
}

export function updateUser(
  db: DB, actor: User,
  p: { userId: string; email?: string; fullName: string; department: Department; password?: string; isActive: boolean },
): DB {
  const target = db.users.find(u => u.id === p.userId)
  if (!target) throw new Error('ไม่พบผู้ใช้')
  if (p.userId === actor.id && !p.isActive) throw new Error('ปิดการใช้งานบัญชีตัวเองไม่ได้')
  // แก้อีเมลได้ (= อีเมลที่ใช้ login) — เว้น undefined = ไม่เปลี่ยน (ฟีเจอร์ 2026-07-19, Manage เท่านั้น)
  const email = p.email?.trim().toLowerCase()
  if (email !== undefined) {
    if (!email) throw new Error('อีเมลว่างไม่ได้')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('รูปแบบอีเมลไม่ถูกต้อง')
    if (db.users.some(u => u.id !== p.userId && u.email.toLowerCase() === email))
      throw new Error(`อีเมล ${email} มีผู้ใช้อยู่แล้ว`)
  }
  let next: DB = {
    ...db,
    users: db.users.map(u => u.id === p.userId
      ? {
          ...u, email: email ?? u.email,
          fullName: p.fullName.trim() || u.fullName, department: p.department,
          password: p.password ? p.password : u.password, isActive: p.isActive,
        }
      : u),
  }
  return audit(next, actor, 'user', p.userId, 'update_user',
    `แก้ไขผู้ใช้ ${target.fullName} (แผนก ${p.department}` +
    `${email && email !== target.email.toLowerCase() ? `, เปลี่ยนอีเมลเป็น ${email}` : ''}${!p.isActive ? ', ปิดการใช้งาน' : ''})`)
}

// ---------------- Notifications ----------------

export function markAllNotificationsRead(db: DB, actor: User, _p: Record<string, never>): DB {
  return {
    ...db,
    notifications: db.notifications.map(n =>
      (n.dept === 'all' || n.dept === actor.department || actor.department === 'admin') && !n.readBy.includes(actor.id)
        ? { ...n, readBy: [...n.readBy, actor.id] }
        : n),
  }
}

export function setNotificationLineStatus(db: DB, p: { ids: string[]; status: 'off' | 'sent' | 'failed' }): DB {
  return {
    ...db,
    notifications: db.notifications.map(n => p.ids.includes(n.id) ? { ...n, lineStatus: p.status } : n),
  }
}

// ---------------- Query helpers ----------------

export function stockSummary(db: DB, stockId: string) {
  const units = db.lbsUnits.filter(u => u.projectStockId === stockId)
  const withCost = units.filter(u => u.unitCost !== undefined)
  return {
    total: units.length,
    available: units.filter(u => u.status === 'in_stock').length,
    allocated: units.filter(u => u.status === 'allocated').length,
    issued: units.filter(u => u.status === 'issued').length,
    // มูลค่าคลัง = Σ ต้นทุนต่อเครื่อง (เฉพาะเครื่องที่กรอกราคา) · undefined ถ้ายังไม่มีเครื่องใดกรอกราคา
    totalCost: withCost.length ? withCost.reduce((s, u) => s + (u.unitCost ?? 0), 0) : undefined,
    costedUnits: withCost.length,
  }
}

export function pendingPurchasingReqs(db: DB, jobId: string): AccessoryRequest[] {
  return db.accessoryRequests.filter(r => r.jobId === jobId && r.source === 'purchasing' && r.status === 'pending')
}

// มูลค่าวัสดุของ Job = Σ(ราคาต่อหน่วย × จำนวน) เฉพาะรายการที่ยัง active (ไม่นับ cancelled/returned)
export function jobMaterialValue(db: DB, jobId: string): number {
  return db.accessoryRequests
    .filter(r => r.jobId === jobId && r.status !== 'cancelled' && r.status !== 'returned')
    .reduce((sum, r) => sum + (r.unitPrice ?? 0) * r.qtyRequested, 0)
}

// ต้นทุนใช้จริงของหมวด raw_mat/outsourcing = Σ มูลค่าวัสดุ active ที่ตัดเข้าหมวดนั้น (phaseBudget = key)
function categoryMaterialActual(db: DB, jobId: string, key: CostCategoryKey): number {
  return db.accessoryRequests
    .filter(r => r.jobId === jobId && r.status !== 'cancelled' && r.status !== 'returned' && r.phaseBudget === key)
    .reduce((sum, r) => sum + (r.unitPrice ?? 0) * r.qtyRequested, 0)
}

// ต้นทุนตัว LBS ที่ดึงเข้า Job = Σ ต้นทุนต่อเครื่องของ unit ที่ยังถือ/เบิกให้ Job นี้ (allocated/issued)
// → บวกเข้า actual หมวด Raw Material (main equipment เป็นต้นทุนวัตถุดิบหลักของงาน)
export function jobLbsCost(db: DB, jobId: string): number {
  return db.lbsUnits
    .filter(u => u.jobId === jobId && (u.status === 'allocated' || u.status === 'issued'))
    .reduce((sum, u) => sum + (u.unitCost ?? 0), 0)
}

// สรุปงบประมาณ Job แยก 7 หมวด: raw_mat/outsourcing actual มาจาก PR/PO, อีก 5 หมวดกรอกเอง
// กำไร = ราคาขาย − ต้นทุนรวม(งบ), ต้นทุนคงเหลือ = ต้นทุนรวม(งบ) − ใช้จริงรวม
export function jobBudgetSummary(db: DB, job: Job) {
  const salePrice = job.budgetSalePrice
  const costs = job.budgetCosts ?? {}
  const categories = ([
    { key: 'raw_mat', fromPR: true }, { key: 'outsourcing', fromPR: true },
    { key: 'trans', fromPR: false }, { key: 'eng', fromPR: false }, { key: 'ove', fromPR: false },
    { key: 'pm', fromPR: false }, { key: 'fin', fromPR: false },
  ] as { key: CostCategoryKey; fromPR: boolean }[]).map(c => {
    const cat = costs[c.key]
    const budget = cat?.budget ?? 0
    // raw_mat actual = ค่าวัสดุ PR/PO + ต้นทุนตัว LBS ที่ดึงเข้า Job นี้
    const lbsCost = c.key === 'raw_mat' ? jobLbsCost(db, job.id) : 0
    const actual = c.fromPR ? categoryMaterialActual(db, job.id, c.key) + lbsCost : (cat?.actual ?? 0)
    return { key: c.key, fromPR: c.fromPR, phase: cat?.phase, budget, actual, remaining: budget - actual }
  })
  const cost = job.budgetCost ?? (categories.some(c => c.budget) ? categories.reduce((s, c) => s + c.budget, 0) : undefined)
  const totalActual = categories.reduce((s, c) => s + c.actual, 0)
  const lbsCost = jobLbsCost(db, job.id)
  // materialValue = ค่าวัสดุ PR/PO ล้วน (raw_mat + outsourcing) ไม่รวมต้นทุนตัว LBS — ใช้แสดงในแผง Purchase Orders
  const materialValue = categories.filter(c => c.fromPR).reduce((s, c) => s + c.actual, 0) - lbsCost
  const profit = salePrice !== undefined && cost !== undefined ? salePrice - cost : undefined
  const margin = profit !== undefined && salePrice ? (profit / salePrice) * 100 : undefined
  const remainingCost = cost !== undefined ? cost - totalActual : undefined
  return { salePrice, cost, profit, margin, materialValue, lbsCost, totalActual, remainingCost, categories }
}

export function unreadNotifications(db: DB, user: User) {
  return db.notifications.filter(n =>
    (n.dept === 'all' || n.dept === user.department || user.department === 'admin') && !n.readBy.includes(user.id))
}
