import type {
  DB, Job, JobStatus, User, AccessoryRequest, Department,
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

// เช็คว่า action ทำให้ Job ขยับเป็น ready_to_issue หรือไม่ → แจ้ง Project
function notifyIfBecameReady(before: DB, after: DB, jobId: string): DB {
  const jobB = before.jobs.find(j => j.id === jobId)
  const jobA = after.jobs.find(j => j.id === jobId)
  if (!jobB || !jobA) return after
  if (deriveJobStatus(before, jobB) !== 'ready_to_issue' && deriveJobStatus(after, jobA) === 'ready_to_issue') {
    return notify(after, {
      type: 'job_ready', dept: 'project', jobId,
      message: `✅ ${jobA.jobNo} (${jobA.customerName}) ของครบแล้ว — พร้อมเบิกให้ Service`,
    })
  }
  return after
}

// ---------------- Project Stock (Sales) ----------------

export function createProjectStock(
  db: DB, actor: User,
  p: { stockNo: string; itemId: string; serialNos: string[]; notes?: string },
): DB {
  const stockNo = p.stockNo.trim()
  if (!stockNo) throw new Error('กรุณาระบุ Stock No.')
  if (db.projectStocks.some(s => s.stockNo === stockNo))
    throw new Error(`Stock No. "${stockNo}" มีอยู่แล้ว`)
  const serials = p.serialNos.map(s => s.trim()).filter(Boolean)
  if (serials.length === 0) throw new Error('กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง')
  const dup = serials.find(s => db.lbsUnits.some(u => u.serialNo === s))
  if (dup) throw new Error(`Serial No. "${dup}" มีอยู่ในระบบแล้ว`)
  const dupIn = serials.find((s, i) => serials.indexOf(s) !== i)
  if (dupIn) throw new Error(`Serial No. "${dupIn}" ซ้ำกันในรายการที่กรอก`)

  const stockId = uid()
  let next: DB = {
    ...db,
    projectStocks: [...db.projectStocks, {
      id: stockId, stockNo, itemId: p.itemId, status: 'open',
      notes: p.notes, createdBy: actor.id, createdAt: now(),
    }],
    lbsUnits: [
      ...db.lbsUnits,
      ...serials.map(sn => ({
        id: uid(), serialNo: sn, projectStockId: stockId,
        status: 'in_stock' as const, jobId: null,
      })),
    ],
  }
  next = notify(next, {
    type: 'stock_created', dept: 'project',
    message: `📦 Sales รับ LBS เข้า ${stockNo} จำนวน ${serials.length} เครื่อง — พร้อมให้ดึงเข้า Job`,
  })
  return audit(next, actor, 'project_stock', stockId, 'create_stock',
    `สร้าง ${stockNo} รับ LBS เข้า ${serials.length} เครื่อง`)
}

export function addUnitsToStock(db: DB, actor: User, p: { stockId: string; serialNos: string[] }): DB {
  const stock = db.projectStocks.find(s => s.id === p.stockId)
  if (!stock) throw new Error('ไม่พบ Project Stock')
  const serials = p.serialNos.map(s => s.trim()).filter(Boolean)
  if (serials.length === 0) throw new Error('กรุณาระบุ Serial No.')
  const dup = serials.find(s => db.lbsUnits.some(u => u.serialNo === s))
  if (dup) throw new Error(`Serial No. "${dup}" มีอยู่ในระบบแล้ว`)
  let next: DB = {
    ...db,
    lbsUnits: [
      ...db.lbsUnits,
      ...serials.map(sn => ({
        id: uid(), serialNo: sn, projectStockId: p.stockId,
        status: 'in_stock' as const, jobId: null,
      })),
    ],
  }
  return audit(next, actor, 'project_stock', p.stockId, 'add_units',
    `รับ LBS เพิ่มเข้า ${stock.stockNo} จำนวน ${serials.length} เครื่อง`)
}

export function updateProjectStock(
  db: DB, actor: User,
  p: { stockId: string; notes: string; status: 'open' | 'closed' },
): DB {
  const stock = db.projectStocks.find(s => s.id === p.stockId)
  if (!stock) throw new Error('ไม่พบ Project Stock')
  let next: DB = {
    ...db,
    projectStocks: db.projectStocks.map(s =>
      s.id === p.stockId ? { ...s, notes: p.notes, status: p.status } : s),
  }
  return audit(next, actor, 'project_stock', p.stockId, 'update_stock',
    `แก้ไข ${stock.stockNo}${stock.status !== p.status ? ` (${p.status === 'closed' ? 'ปิดคลัง — ห้ามดึงเพิ่ม' : 'เปิดคลังอีกครั้ง'})` : ''}`)
}

// ---------------- Job (Project Dept) ----------------

export function createJob(
  db: DB, actor: User,
  p: { customerName: string; scope: string; installLocation: string; requiredDate: string; lbsQtyRequired: number },
): DB {
  if (!p.customerName.trim()) throw new Error('กรุณาระบุชื่อลูกค้า')
  if (!p.lbsQtyRequired || p.lbsQtyRequired < 1) throw new Error('จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง')
  const jobNo = nextNo('JOB', db.jobs.map(j => j.jobNo))
  const jobId = uid()
  let next: DB = {
    ...db,
    jobs: [...db.jobs, {
      id: jobId, jobNo,
      customerName: p.customerName.trim(), scope: p.scope,
      installLocation: p.installLocation, requiredDate: p.requiredDate,
      lbsQtyRequired: p.lbsQtyRequired,
      terminalStatus: null, openedBy: actor.id, createdAt: now(),
    }],
  }
  return audit(next, actor, 'job', jobId, 'create_job',
    `เปิด ${jobNo} ลูกค้า ${p.customerName} ต้องการ LBS ${p.lbsQtyRequired} เครื่อง`)
}

export function updateJob(
  db: DB, actor: User,
  p: { jobId: string; customerName: string; scope: string; installLocation: string; requiredDate: string; lbsQtyRequired: number },
): DB {
  const job = assertJobEditable(db, p.jobId)
  if (!p.lbsQtyRequired || p.lbsQtyRequired < 1) throw new Error('จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง')
  let next: DB = {
    ...db,
    jobs: db.jobs.map(j => j.id === p.jobId ? {
      ...j, customerName: p.customerName.trim(), scope: p.scope,
      installLocation: p.installLocation, requiredDate: p.requiredDate,
      lbsQtyRequired: p.lbsQtyRequired,
    } : j),
  }
  next = notifyIfBecameReady(db, next, p.jobId)
  return audit(next, actor, 'job', p.jobId, 'update_job', `แก้ไขข้อมูล ${job.jobNo}`)
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
      serialNos: units.map(u => u.serialNo),
      performedBy: actor.id, performedAt: now(),
    }],
  }
  next = notifyIfBecameReady(db, next, p.jobId)
  return audit(next, actor, 'stock_allocation', p.jobId, 'draw_lbs',
    `${job.jobNo} ดึง LBS ${units.length} เครื่องจาก ${stock.stockNo} (SN: ${units.map(u => u.serialNo).join(', ')})`)
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
      serialNos: units.map(u => u.serialNo),
      performedBy: actor.id, performedAt: now(), note: p.note,
    }],
  }
  return audit(next, actor, 'stock_allocation', p.jobId, 'return_lbs',
    `${job.jobNo} คืน LBS ${units.length} เครื่องเข้า ${target.stockNo} (SN: ${units.map(u => u.serialNo).join(', ')})`)
}

// ---------------- Accessory ----------------

export function addAccessoryRequest(
  db: DB, actor: User,
  p: { jobId: string; itemId: string; qty: number; source: 'central_stock' | 'purchasing' },
): DB {
  const job = assertJobEditable(db, p.jobId)
  const item = db.items.find(i => i.id === p.itemId)
  if (!item) throw new Error('ไม่พบ Accessory')
  if (!p.qty || p.qty < 1) throw new Error('จำนวนต้องอย่างน้อย 1')

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
        source: 'central_stock' as const, status: 'issued' as const, prId: null,
        requestedBy: actor.id, createdAt: now(),
      }],
    }
    next = notifyIfBecameReady(db, next, p.jobId)
    return audit(next, actor, 'job_accessory_request', reqId, 'issue_accessory_from_stock',
      `${job.jobNo} เบิก ${item.name} ${p.qty} ${item.uom} จากสต็อกกลาง`)
  }

  next = {
    ...db,
    accessoryRequests: [...db.accessoryRequests, {
      id: reqId, jobId: p.jobId, itemId: p.itemId, qtyRequested: p.qty, qtyReceived: 0,
      source: 'purchasing' as const, status: 'pending' as const, prId: null,
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

export function createPO(
  db: DB, actor: User,
  p: { prId: string; supplierName: string; expectedDate: string },
): DB {
  const pr = db.prs.find(x => x.id === p.prId)
  if (!pr) throw new Error('ไม่พบ PR')
  if (pr.status !== 'pending') throw new Error(`${pr.prNo} ออก PO ไปแล้ว ถูกตีกลับ หรือถูกยกเลิก`)
  if (!p.supplierName.trim()) throw new Error('กรุณาระบุ Supplier')
  const job = db.jobs.find(j => j.id === pr.jobId)!

  const poNo = nextNo('PO', db.pos.map(x => x.poNo))
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
      r.prId === p.prId && r.status === 'pr_sent' ? { ...r, status: 'po_ordered' as const } : r),
  }
  next = notify(next, {
    type: 'po_created', dept: 'project', jobId: pr.jobId,
    message: `🛒 ${poNo} ออกแล้วจาก ${pr.prNo} (${job.jobNo}) Supplier: ${p.supplierName.trim()} กำหนดส่ง ${p.expectedDate || 'ไม่ระบุ'}`,
  })
  return audit(next, actor, 'purchase_order', poId, 'create_po',
    `ออก ${poNo} จาก ${pr.prNo} (${job.jobNo}) Supplier: ${p.supplierName} — แจ้งสถานะกลับ Project Dept แล้ว`)
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

  const lines = db.accessoryRequests.filter(r => r.prId === po.prId)
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

  const allComplete = updatedReqs
    .filter(r => r.prId === po.prId)
    .every(r => r.status === 'received' || r.status === 'cancelled' || r.status === 'returned')

  let next: DB = {
    ...db,
    accessoryRequests: updatedReqs,
    pos: db.pos.map(x => x.id === p.poId && allComplete
      ? { ...x, status: 'received' as const, receivedAt: now() } : x),
    prs: db.prs.map(x => x.id === po.prId && allComplete
      ? { ...x, status: 'received' as const } : x),
  }
  next = notify(next, {
    type: 'po_received', dept: 'project', jobId: po.jobId,
    message: allComplete
      ? `📬 ${po.poNo} (${job.jobNo}) รับของครบทุกรายการแล้ว`
      : `📬 ${po.poNo} (${job.jobNo}) รับของบางส่วน: ${parts.join(', ')}`,
  })
  next = notifyIfBecameReady(db, next, po.jobId)
  return audit(next, actor, 'purchase_order', p.poId, allComplete ? 'receive_po_complete' : 'receive_po_partial',
    `${po.poNo} (${job.jobNo}) รับของ${allComplete ? 'ครบ' : 'บางส่วน'}: ${parts.join(', ')}`)
}

// ---------------- Issue / Install / Cancel ----------------

export function issueJob(db: DB, actor: User, p: { jobId: string; note?: string }): DB {
  const job = assertJobEditable(db, p.jobId)
  const status = deriveJobStatus(db, job)
  if (status !== 'ready_to_issue')
    throw new Error(`${job.jobNo} ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ`)
  const units = db.lbsUnits.filter(u => u.jobId === p.jobId && u.status === 'allocated')
  let next: DB = {
    ...db,
    jobs: db.jobs.map(j => j.id === p.jobId
      ? { ...j, terminalStatus: 'issued' as const, issuedAt: now(), issuedNote: p.note }
      : j),
    lbsUnits: db.lbsUnits.map(u =>
      u.jobId === p.jobId && u.status === 'allocated' ? { ...u, status: 'issued' as const } : u),
  }
  next = notify(next, {
    type: 'job_issued', dept: 'service', jobId: p.jobId,
    message: `🚚 ${job.jobNo} (${job.customerName}) เบิกของครบแล้ว — Service เข้าติดตั้งที่ ${job.installLocation || '-'} กำหนด ${job.requiredDate || '-'}`,
  })
  return audit(next, actor, 'job', p.jobId, 'issue_to_service',
    `เบิก ${job.jobNo} ให้ Service ติดตั้ง (LBS ${units.length} เครื่อง) สถานที่: ${job.installLocation || '-'}`)
}

// Service ยืนยันติดตั้งเสร็จ พร้อมวันที่จริง → Installed (terminal)
export function confirmInstall(
  db: DB, actor: User,
  p: { jobId: string; installedDate: string; note?: string },
): DB {
  const job = db.jobs.find(j => j.id === p.jobId)
  if (!job) throw new Error('ไม่พบ Job')
  if (job.terminalStatus !== 'issued')
    throw new Error(`ยืนยันติดตั้งได้เฉพาะงานที่เบิกแล้ว (Issued) — ${job.jobNo} อยู่สถานะอื่น`)
  if (!p.installedDate) throw new Error('กรุณาระบุวันที่ติดตั้งจริง')
  let next: DB = {
    ...db,
    jobs: db.jobs.map(j => j.id === p.jobId
      ? {
          ...j, terminalStatus: 'installed' as const,
          installedAt: p.installedDate, installNote: p.note, installConfirmedBy: actor.id,
        }
      : j),
  }
  next = notify(next, {
    type: 'job_installed', dept: 'project', jobId: p.jobId,
    message: `🏁 ${job.jobNo} (${job.customerName}) ติดตั้งเสร็จเมื่อ ${p.installedDate} — ยืนยันโดย ${actor.fullName}`,
  })
  return audit(next, actor, 'job', p.jobId, 'confirm_install',
    `${job.jobNo} ติดตั้งเสร็จ วันที่จริง ${p.installedDate}${p.note ? ` — ${p.note}` : ''}`)
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
        serialNos: us.map(u => u.serialNo),
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
  const receivedCount = reqs.filter(r => r.status === 'received').length
  return audit(next, actor, 'job', p.jobId, 'cancel_job',
    `ยกเลิก ${job.jobNo} (${p.reason}) — คืน LBS ${units.length} เครื่องกลับสต็อกเดิม` +
    (receivedCount > 0
      ? p.receivedAccessoryToCentral
        ? ` + Accessory ที่รับจาก PO แล้วเข้าสต็อกกลาง`
        : ` (Accessory ที่รับจาก PO แล้วพิจารณาเป็นเคสไป)`
      : ''))
}

// ---------------- Master Data: Items / Central stock ----------------

export function createItem(
  db: DB, actor: User,
  p: { code: string; name: string; uom: string; stockableCentrally: boolean; initialQty?: number },
): DB {
  const code = p.code.trim()
  if (!code || !p.name.trim()) throw new Error('กรุณาระบุรหัสและชื่อ Accessory')
  if (db.items.some(i => i.code.toLowerCase() === code.toLowerCase()))
    throw new Error(`รหัส "${code}" มีอยู่แล้ว`)
  const itemId = uid()
  let next: DB = {
    ...db,
    items: [...db.items, {
      id: itemId, code, name: p.name.trim(), itemType: 'accessory' as const,
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
  p: { itemId: string; code: string; name: string; uom: string; stockableCentrally: boolean },
): DB {
  const item = db.items.find(i => i.id === p.itemId)
  if (!item) throw new Error('ไม่พบรายการ')
  if (item.itemType === 'main_equipment') throw new Error('แก้ไข LBS หลักไม่ได้จากหน้านี้')
  const code = p.code.trim()
  if (db.items.some(i => i.id !== p.itemId && i.code.toLowerCase() === code.toLowerCase()))
    throw new Error(`รหัส "${code}" ซ้ำกับรายการอื่น`)
  const stockRow = db.accessoryStock.find(r => r.itemId === p.itemId)
  if (!p.stockableCentrally && (stockRow?.qtyOnHand ?? 0) > 0)
    throw new Error(`ยังมีของในสต็อกกลาง ${stockRow!.qtyOnHand} ${item.uom} — ปรับยอดเป็น 0 ก่อนจึงจะปิดการเก็บสต็อกกลางได้`)
  let next: DB = {
    ...db,
    items: db.items.map(i => i.id === p.itemId
      ? { ...i, code, name: p.name.trim(), uom: p.uom.trim() || i.uom, stockableCentrally: p.stockableCentrally }
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
  p: { userId: string; fullName: string; department: Department; password?: string; isActive: boolean },
): DB {
  const target = db.users.find(u => u.id === p.userId)
  if (!target) throw new Error('ไม่พบผู้ใช้')
  if (p.userId === actor.id && !p.isActive) throw new Error('ปิดการใช้งานบัญชีตัวเองไม่ได้')
  let next: DB = {
    ...db,
    users: db.users.map(u => u.id === p.userId
      ? {
          ...u, fullName: p.fullName.trim() || u.fullName, department: p.department,
          password: p.password ? p.password : u.password, isActive: p.isActive,
        }
      : u),
  }
  return audit(next, actor, 'user', p.userId, 'update_user',
    `แก้ไขผู้ใช้ ${target.fullName} (แผนก ${p.department}${!p.isActive ? ', ปิดการใช้งาน' : ''})`)
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
  return {
    total: units.length,
    available: units.filter(u => u.status === 'in_stock').length,
    allocated: units.filter(u => u.status === 'allocated').length,
    issued: units.filter(u => u.status === 'issued').length,
  }
}

export function pendingPurchasingReqs(db: DB, jobId: string): AccessoryRequest[] {
  return db.accessoryRequests.filter(r => r.jobId === jobId && r.source === 'purchasing' && r.status === 'pending')
}

export function unreadNotifications(db: DB, user: User) {
  return db.notifications.filter(n =>
    (n.dept === 'all' || n.dept === user.department || user.department === 'admin') && !n.readBy.includes(user.id))
}
