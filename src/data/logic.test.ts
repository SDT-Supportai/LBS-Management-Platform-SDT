import { describe, it, expect } from 'vitest'
import type { DB, Job, AccessoryRequest, LbsUnit } from '../types'
import {
  effectiveQty, poCostSummary, jobMaterialValue, jobLbsCost, jobBudgetSummary,
  deriveJobStatus, jobDueDate, jobDaysLeft, jobAllocatedQty,
  unitIssueBlockReason, accIssueBlockReason, jobPendingIssueAccessories, jobIssuePlan,
  issueJobLbs, issueJobAccessory, cancelJob,
  parseLatLng, fmtLatLng, inThailand, createJob, updateJob,
  unitEta, unitLeadDays, normalizeLeadDays, leadDaysToStore,
  ETA_LEAD_DAYS, ETA_LEAD_MIN, ETA_LEAD_MAX,
  addDaysIso, daysBetweenIso, nextNo,
} from './logic'

// =============================================================================
// เทสต์ชุดแรกของโปรเจกต์ (2026-08-22) — Vitest ขั้น 1
//
// เลือกเทสต์เฉพาะ "กฎที่เคยพังจริง" ไม่ใช่ไล่เทสต์ให้ครบทุกฟังก์ชัน
// ทุก describe อ้างถึงบั๊กใน HANDOFF §9 หรือรายงาน code review ที่เป็นต้นเรื่อง
//
// ทำไมเริ่มที่ logic.ts: ทุกฟังก์ชันเป็น pure `(db, actor, p) => DB`
// ไม่มี DOM ไม่มี network ไม่มี state ซ่อน → ไม่ต้อง mock อะไรเลย
//
// ⚠️ ชุดนี้พิสูจน์ได้แค่ว่า **demo mode ถูก** — ยังไม่ได้พิสูจน์ว่า SQL ฝั่ง LIVE ตรงกัน
//    ตัวที่จะพิสูจน์เรื่องนั้นคือ parity suite (ขั้น 3 ของแผน) ที่รัน scenario ชุดเดียวกัน
//    ผ่านทั้ง logic.ts และ RPC จริงแล้ว diff ผลลัพธ์
// =============================================================================

// ---------- fixture ----------
const EMPTY: DB = {
  users: [], items: [], projectStocks: [], lbsUnits: [], jobs: [], allocations: [],
  accessoryStock: [], accessoryRequests: [], prs: [], pos: [], approvalRequests: [], approvalComments: [],
  auditLogs: [], notifications: [], siteVisits: [], unitInstallations: [],
  teamMembers: [], jobAssignments: [], stockMovements: [], jobPayments: [],
  stdDrawings: [], stdPrices: [], stdBoms: [], stdBomLines: [],
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', jobNo: 'J-001', customerName: 'กฟภ.', scope: 'ติดตั้ง LBS',
  installLocation: 'สถานีไฟฟ้า A', requiredDate: '2026-12-31', lbsQtyRequired: 2,
  terminalStatus: null, openedBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const req = (over: Partial<AccessoryRequest> = {}): AccessoryRequest => ({
  id: 'r1', jobId: 'j1', itemId: 'i1', qtyRequested: 1, qtyReceived: 0,
  source: 'purchasing', status: 'received', prId: 'pr1', poId: 'po1',
  requestedBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const unit = (over: Partial<LbsUnit> = {}): LbsUnit => ({
  id: 'u1', serialLvb: 'LVB-001', serialOm: 'OM-001', projectStockId: 's1',
  status: 'in_stock', jobId: null,
  ...over,
})

const db = (over: Partial<DB> = {}): DB => ({ ...EMPTY, ...over })

// =============================================================================
describe('effectiveQty — จำนวนที่ Job ถืออยู่จริง', () => {
  it('ไม่เคยโอนคืน = เท่ากับจำนวนที่ขอ', () => {
    expect(effectiveQty(req({ qtyRequested: 5 }))).toBe(5)
  })

  it('โอนคืนคลังแล้วต้องหักออก', () => {
    expect(effectiveQty(req({ qtyRequested: 5, qtyTransferred: 2 }))).toBe(3)
  })

  it('โอนคืนหมด = 0 (ไม่ใช่ค่าติดลบ หรือ NaN)', () => {
    expect(effectiveQty(req({ qtyRequested: 5, qtyTransferred: 5 }))).toBe(0)
  })
})

// =============================================================================
// HANDOFF §9 ข้อ 13 — สูตรต้นทุนกระจาย 4 ที่แล้วไม่ตรงกัน
// หน้า Purchasing คิด unitPrice × qtyRequested แต่งบ Job หัก unitPrice × effectiveQty
// เคสจริงที่วัดได้: รับครบ 5 → โอนคืนคลัง 2 ⇒ 600,000 vs 360,000 ต่างกัน 240,000 บาท
// ใต้ป้ายที่เขียนว่า "มูลค่า" เหมือนกันทั้งคู่
//
// มติ: ไม่ยุบให้เท่ากัน เพราะสองมุมถูกทั้งคู่แต่คนละความหมาย
//   ordered = ยอดที่จ่ายซัพ · charged = ยอดที่หักงบ Job
// เทสต์นี้จึงล็อก "ความต่าง" ไว้ ไม่ใช่ล็อกให้เท่ากัน
// =============================================================================
describe('poCostSummary — ordered ต้องไม่เท่ากับ charged เมื่อมีการโอนคืนคลัง (§9.13)', () => {
  const withTransfer = db({
    accessoryRequests: [req({ qtyRequested: 5, qtyReceived: 5, qtyTransferred: 2, unitPrice: 120_000 })],
  })

  it('ordered = ราคา × จำนวนที่สั่ง (ยอดที่จ่ายซัพ)', () => {
    expect(poCostSummary(withTransfer, 'po1').ordered).toBe(600_000)
  })

  it('charged = ราคา × จำนวนที่ยังอยู่กับงาน (ยอดที่หักงบ Job)', () => {
    expect(poCostSummary(withTransfer, 'po1').charged).toBe(360_000)
  })

  it('ต่างกัน 240,000 บาท — ตัวเลขจากเคสจริงที่ทำให้เจอบั๊กนี้', () => {
    const s = poCostSummary(withTransfer, 'po1')
    expect(s.ordered - s.charged).toBe(240_000)
  })

  it('ไม่มีการโอนคืน = สองยอดต้องเท่ากัน (กรณีปกติ)', () => {
    const normal = db({ accessoryRequests: [req({ qtyRequested: 5, unitPrice: 120_000 })] })
    const s = poCostSummary(normal, 'po1')
    expect(s.ordered).toBe(s.charged)
  })

  it('รายการที่ยกเลิก/คืนของ ไม่นับเป็นต้นทุน แต่ถูกนับใน droppedCount', () => {
    const mixed = db({
      accessoryRequests: [
        req({ id: 'a', qtyRequested: 2, unitPrice: 100 }),
        req({ id: 'b', qtyRequested: 9, unitPrice: 100, status: 'cancelled' }),
        req({ id: 'c', qtyRequested: 9, unitPrice: 100, status: 'returned' }),
      ],
    })
    const s = poCostSummary(mixed, 'po1')
    expect(s.ordered).toBe(200)
    expect(s.lineCount).toBe(1)
    expect(s.droppedCount).toBe(2)
  })

  it('ยังไม่กรอกราคา = ไม่เข้ายอดรวม แต่ต้องรายงานผ่าน missingPrice', () => {
    const partial = db({
      accessoryRequests: [
        req({ id: 'a', qtyRequested: 2, unitPrice: 100 }),
        req({ id: 'b', qtyRequested: 3 }),   // ยังไม่กรอกราคาจริงจากซัพ
      ],
    })
    const s = poCostSummary(partial, 'po1')
    expect(s.ordered).toBe(200)
    expect(s.missingPrice).toBe(1)
  })
})

// =============================================================================
describe('jobLbsCost — ต้นทุนตัวเครื่องที่อยู่กับงาน', () => {
  const units = [
    unit({ id: 'a', status: 'allocated', jobId: 'j1', unitCost: 1_200_000 }),
    unit({ id: 'b', status: 'issued', jobId: 'j1', unitCost: 900_000 }),
    unit({ id: 'c', status: 'in_stock', jobId: null, unitCost: 500_000 }),   // ยังอยู่ในคลัง
    unit({ id: 'd', status: 'allocated', jobId: 'j2', unitCost: 700_000 }),  // งานอื่น
  ]

  it('นับเฉพาะเครื่องของงานนี้ที่ allocated หรือ issued', () => {
    expect(jobLbsCost(db({ lbsUnits: units }), 'j1')).toBe(2_100_000)
  })

  it('เครื่องที่เบิกไปติดตั้งแล้ว (issued) ยังต้องนับ — ไม่งั้นต้นทุนหายตอนงานใกล้จบ', () => {
    const onlyIssued = [unit({ id: 'b', status: 'issued', jobId: 'j1', unitCost: 900_000 })]
    expect(jobLbsCost(db({ lbsUnits: onlyIssued }), 'j1')).toBe(900_000)
  })

  it('เครื่องที่ไม่ได้กรอกต้นทุน นับเป็น 0 ไม่ใช่ NaN', () => {
    const noCost = [unit({ id: 'a', status: 'allocated', jobId: 'j1' })]
    expect(jobLbsCost(db({ lbsUnits: noCost }), 'j1')).toBe(0)
  })
})

// =============================================================================
describe('jobBudgetSummary — งบ 7 หมวด', () => {
  const j = job({
    budgetSalePrice: 5_000_000,
    budgetCosts: {
      raw_mat: { budget: 3_000_000 },
      outsourcing: { budget: 500_000 },
      trans: { budget: 200_000, actual: 150_000 },
    },
  })
  const base = db({
    jobs: [j],
    lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1', unitCost: 1_000_000 })],
    accessoryRequests: [
      req({ id: 'm1', phaseBudget: 'raw_mat', qtyRequested: 10, unitPrice: 50_000 }),      // 500,000
      req({ id: 'm2', phaseBudget: 'outsourcing', qtyRequested: 2, unitPrice: 100_000 }),  // 200,000
    ],
  })

  it('actual ของ raw_mat = ค่าวัสดุ + ต้นทุนตัว LBS', () => {
    const s = jobBudgetSummary(base, j)
    expect(s.categories.find(c => c.key === 'raw_mat')!.actual).toBe(1_500_000)
  })

  it('materialValue = ค่าวัสดุล้วน ไม่รวมต้นทุนตัว LBS', () => {
    // ถ้ารวม LBS เข้าไปด้วย แผง Purchase Orders จะโชว์มูลค่าเกินจริง 1,000,000
    expect(jobBudgetSummary(base, j).materialValue).toBe(700_000)
  })

  it('หมวดที่กรอกเอง (trans) ใช้ actual ที่กรอก ไม่ไปดึงจาก PR/PO', () => {
    expect(jobBudgetSummary(base, j).categories.find(c => c.key === 'trans')!.actual).toBe(150_000)
  })

  it('กำไรคิดจากงบต้นทุน ไม่ใช่ต้นทุนใช้จริง', () => {
    const s = jobBudgetSummary(base, j)
    expect(s.cost).toBe(3_700_000)              // 3,000,000 + 500,000 + 200,000
    expect(s.profit).toBe(1_300_000)            // 5,000,000 − 3,700,000
    expect(s.remainingCost).toBe(3_700_000 - s.totalActual)
  })

  it('ยังไม่ตั้งราคาขาย = ไม่มีกำไร/มาร์จิ้น (ไม่ใช่ 0 หรือ NaN)', () => {
    const noPrice = job({ budgetCosts: { raw_mat: { budget: 100 } } })
    const s = jobBudgetSummary(db({ jobs: [noPrice] }), noPrice)
    expect(s.profit).toBeUndefined()
    expect(s.margin).toBeUndefined()
  })

  it('รายการที่ยกเลิกไม่เข้า actual', () => {
    const withCancelled = db({
      ...base,
      accessoryRequests: [...base.accessoryRequests,
        req({ id: 'm3', phaseBudget: 'raw_mat', qtyRequested: 99, unitPrice: 50_000, status: 'cancelled' })],
    })
    expect(jobBudgetSummary(withCancelled, j).categories.find(c => c.key === 'raw_mat')!.actual)
      .toBe(1_500_000)
  })
})

// =============================================================================
describe('jobMaterialValue — หักของที่โอนคืนคลังออก', () => {
  it('ใช้ effectiveQty ไม่ใช่ qtyRequested (§9.13 จุดที่สอง)', () => {
    const d = db({
      accessoryRequests: [req({ qtyRequested: 5, qtyTransferred: 2, unitPrice: 120_000 })],
    })
    expect(jobMaterialValue(d, 'j1')).toBe(360_000)
  })
})

// =============================================================================
describe('deriveJobStatus — สถานะเป็นผลลัพธ์ ไม่ใช่ช่องให้กรอก', () => {
  const twoUnits = [
    unit({ id: 'a', status: 'allocated', jobId: 'j1' }),
    unit({ id: 'b', status: 'allocated', jobId: 'j1' }),
  ]

  it('ยังไม่ดึง LBS = draft', () => {
    expect(deriveJobStatus(db({}), job())).toBe('draft')
  })

  it('ดึง LBS แล้วแต่ยังไม่ครบ Scope = allocated', () => {
    const d = db({ lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1' })] })
    expect(deriveJobStatus(d, job({ lbsQtyRequired: 2 }))).toBe('allocated')
  })

  it('มี LBS + ยังมีวัสดุค้างรับ = procuring_accessory', () => {
    const d = db({ lbsUnits: twoUnits, accessoryRequests: [req({ status: 'pending' })] })
    expect(deriveJobStatus(d, job())).toBe('procuring_accessory')
  })

  it('LBS ครบ + วัสดุครบทุกรายการ = ready_to_issue', () => {
    const d = db({ lbsUnits: twoUnits, accessoryRequests: [req({ status: 'received' })] })
    expect(deriveJobStatus(d, job())).toBe('ready_to_issue')
  })

  it('รายการที่ยกเลิกไม่ถ่วงให้ค้างอยู่ที่ procuring', () => {
    const d = db({ lbsUnits: twoUnits, accessoryRequests: [req({ status: 'cancelled' })] })
    expect(deriveJobStatus(d, job())).toBe('ready_to_issue')
  })

  it('terminalStatus ชนะการคำนวณเสมอ', () => {
    const d = db({ lbsUnits: twoUnits })
    expect(deriveJobStatus(d, job({ terminalStatus: 'cancelled' }))).toBe('cancelled')
    expect(deriveJobStatus(d, job({ terminalStatus: 'issued' }))).toBe('issued')
  })

  it('เครื่องที่ issued แล้วยังนับว่าอยู่บน Job — ไม่ตกกลับเป็น Draft (0059)', () => {
    // §9.7 เดิม: v_job_status นับเฉพาะ allocated ทำให้บอทรายงาน "LBS: 0/N" หลังเบิก
    //   ตอนนั้นแก้ด้วยการให้ terminalStatus พาไป เพราะการเบิกเป็น all-or-nothing
    // 0059 เบิกแยกส่วนได้ → มีช่วงที่ "เครื่องออกไปแล้วแต่ terminalStatus ยังว่าง"
    //   ถ้ายังนับแค่ allocated งานจะโชว์ Draft ทั้งที่ของอยู่ในมือ Service แล้ว
    const issued = db({ lbsUnits: [unit({ id: 'a', status: 'issued', jobId: 'j1' })] })
    expect(deriveJobStatus(issued, job())).toBe('partially_issued')
    expect(deriveJobStatus(issued, job({ terminalStatus: 'issued' }))).toBe('issued')
    expect(jobAllocatedQty(issued, 'j1')).toBe(1)
  })
})

// =============================================================================
// เบิกให้ Service แบบแยกส่วน (0059) — Ready / Not Ready รายรายการ
//
// กฎที่ต้องล็อก:
//   1) PO ที่ยัง "รอรับของ" ทั้งใบเบิกไม่ได้ แม้บรรทัดนั้นจะรับของครบแล้ว
//   2) ของจากคลังคงเหลือเบิกได้ทันทีที่เบิกออกจากคลังเข้า Job แล้ว
//   3) LBS ที่ ETA ยังไม่ถึง (Pending) เบิกไม่ได้ · "ไม่ระบุ ETA (?)" ไม่บล็อก
//   4) เบิกครบทั้งใบเมื่อไหร่ terminalStatus ต้องเป็น 'issued' เอง ไม่ต้องกดปิด
// =============================================================================
describe('เบิกแยกส่วน — เกณฑ์ Ready / Not Ready', () => {
  const poReceived = { id: 'po1', poNo: 'PO-001', prId: 'pr1', jobId: 'j1', supplierName: 'ซัพ A', expectedDate: '2026-06-01', status: 'received' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }
  const poWaiting = { ...poReceived, id: 'po2', poNo: 'PO-002', status: 'issued' as const }

  it('PO รับของครบแล้ว = เบิกได้', () => {
    const d = db({ pos: [poReceived], accessoryRequests: [req({ status: 'received', poId: 'po1' })] })
    expect(accIssueBlockReason(d, d.accessoryRequests[0])).toBeUndefined()
  })

  it('PO ยังรอรับของ = เบิกไม่ได้ แม้บรรทัดนี้รับของครบแล้ว (ข้อ 3 ของโจทย์)', () => {
    const d = db({ pos: [poWaiting], accessoryRequests: [req({ status: 'received', poId: 'po2' })] })
    expect(accIssueBlockReason(d, d.accessoryRequests[0])).toContain('PO-002')
  })

  it('บรรทัดที่ยังไม่รับของบอกเหตุผลตามขั้นที่ค้างอยู่', () => {
    const d = db({ pos: [poWaiting] })
    expect(accIssueBlockReason(d, req({ status: 'pending', poId: null }))).toContain('PR')
    expect(accIssueBlockReason(d, req({ status: 'po_ordered', poId: 'po2' }))).toContain('รอรับของ')
  })

  it('ของจากคลังคงเหลือที่เบิกเข้า Job แล้ว = เบิกได้ทันที', () => {
    const d = db()
    expect(accIssueBlockReason(d, req({ source: 'central_stock', status: 'issued', poId: null, prId: null }))).toBeUndefined()
  })

  it('โอนคืนคลังหมดแล้ว = ไม่มีของให้เบิก (ไม่ค้างขวางการปิดใบ)', () => {
    const d = db({ pos: [poReceived] })
    const r = req({ status: 'received', qtyRequested: 5, qtyTransferred: 5 })
    expect(accIssueBlockReason(d, r)).toContain('โอนคืนคลัง')
    expect(jobPendingIssueAccessories(db({ accessoryRequests: [r] }), 'j1')).toHaveLength(0)
  })

  it('เบิกไปแล้วไม่ถูกนับเป็นของค้างอีก', () => {
    const r = req({ status: 'received', issuedToServiceAt: '2026-06-01T00:00:00.000Z' })
    expect(accIssueBlockReason(db(), r)).toBe('เบิกให้ Service ไปแล้ว')
    expect(jobPendingIssueAccessories(db({ accessoryRequests: [r] }), 'j1')).toHaveLength(0)
  })

  it('LBS: ETA ยังไม่ถึงเบิกไม่ได้ · ไม่ระบุ ETA ไม่บล็อก · On Hand เบิกได้', () => {
    const alloc = (over = {}) => unit({ status: 'allocated', jobId: 'j1', ...over })
    expect(unitIssueBlockReason(alloc({ planPoReceiptDate: '2026-12-31' }), '2026-06-01')).toContain('ETA')
    expect(unitIssueBlockReason(alloc(), '2026-06-01')).toBeUndefined()
    expect(unitIssueBlockReason(alloc({ planPoReceiptDate: '2026-01-01' }), '2026-06-01')).toBeUndefined()
    expect(unitIssueBlockReason(unit({ status: 'issued', jobId: 'j1' }), '2026-06-01')).toBe('เบิกให้ Service ไปแล้ว')
  })

  it('jobIssuePlan จัดกลุ่มตาม PO และแยก Ready / Not Ready ให้ครบ', () => {
    const d = db({
      jobs: [job({ lbsQtyRequired: 2 })],
      pos: [poReceived, poWaiting],
      lbsUnits: [
        unit({ id: 'a', status: 'allocated', jobId: 'j1' }),
        unit({ id: 'b', serialLvb: 'LVB-002', status: 'allocated', jobId: 'j1', planPoReceiptDate: '2099-01-01' }),
      ],
      accessoryRequests: [
        req({ id: 'r1', status: 'received', poId: 'po1' }),
        req({ id: 'r2', status: 'po_ordered', poId: 'po2' }),
      ],
    })
    const plan = jobIssuePlan(d, 'j1', '2026-06-01')
    expect(plan.lbsShort).toBe(0)
    expect(plan.lbsReady.map(u => u.id)).toEqual(['a'])
    expect(plan.lbsBlocked.map(x => x.unit.id)).toEqual(['b'])
    expect(plan.groups.map(g => g.label)).toEqual(['PO-001', 'PO-002'])
    expect(plan.accReady.map(r => r.id)).toEqual(['r1'])
    expect(plan.groups[1].block).toContain('รอรับของ')
    expect(plan.completeIfAllReady).toBe(false)   // ยังมีทั้ง LBS และวัสดุที่ยังไม่พร้อม
  })

  it('ดึง LBS ไม่ครบ Scope → lbsShort บอกจำนวนที่ขาด', () => {
    const d = db({
      jobs: [job({ lbsQtyRequired: 3 })],
      lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1' })],
    })
    expect(jobIssuePlan(d, 'j1', '2026-06-01').lbsShort).toBe(2)
  })
})

// =============================================================================
describe('เบิกแยกส่วน — เดินสถานะจนปิดใบเอง', () => {
  const actor = { id: 'u1', email: 'p@x.co', password: '', fullName: 'สมชาย', department: 'admin' as const, isActive: true }
  const poReceived = { id: 'po1', poNo: 'PO-001', prId: 'pr1', jobId: 'j1', supplierName: 'ซัพ A', expectedDate: '2026-06-01', status: 'received' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }
  const base = () => db({
    users: [actor],
    items: [{ id: 'i1', code: 'ACC-1', name: 'ลูกถ้วย', itemType: 'accessory' as const, uom: 'ea', stockableCentrally: false }],
    jobs: [job({ lbsQtyRequired: 1 })],
    pos: [poReceived],
    lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1' })],
    accessoryRequests: [req({ id: 'r1', status: 'received', poId: 'po1' })],
  })
  const plan = { startDate: '2026-07-01', endDate: '2026-07-02', location: 'สถานีไฟฟ้า A' }

  it('เบิก LBS ก่อน → Partially Issued (ยังไม่ปิดใบ เพราะวัสดุยังไม่ออก)', () => {
    const after = issueJobLbs(base(), actor, { jobId: 'j1', ...plan })
    expect(after.jobs[0].terminalStatus).toBeNull()
    expect(deriveJobStatus(after, after.jobs[0])).toBe('partially_issued')
    expect(after.lbsUnits[0].status).toBe('issued')
    expect(after.jobs[0].lbsIssuedAt).toBeTruthy()
  })

  it('เบิกวัสดุตามด้วย LBS → ปิดใบเป็น Issued เอง', () => {
    let d = issueJobAccessory(base(), actor, { jobId: 'j1', ...plan })
    expect(deriveJobStatus(d, d.jobs[0])).toBe('partially_issued')
    d = issueJobLbs(d, actor, { jobId: 'j1' })            // ไม่ต้องกรอกนัดซ้ำ
    expect(d.jobs[0].terminalStatus).toBe('issued')
    expect(d.jobs[0].issuedAt).toBeTruthy()
    expect(d.accessoryRequests[0].issuedToServiceAt).toBeTruthy()
    expect(d.notifications.some(n => n.type === 'job_issued')).toBe(true)
  })

  it('เบิก LBS ที่ ETA ยังไม่ถึงไม่ได้ — กันทีมออกหน้างานเสียเที่ยว', () => {
    const d = { ...base(), lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1', planPoReceiptDate: '2099-01-01' })] }
    expect(() => issueJobLbs(d, actor, { jobId: 'j1', ...plan })).toThrow(/ETA/)
  })

  it('เบิกวัสดุของ PO ที่ยังรอรับของไม่ได้', () => {
    const d = { ...base(), pos: [{ ...poReceived, status: 'issued' as const }] }
    expect(() => issueJobAccessory(d, actor, { jobId: 'j1', requestIds: ['r1'], ...plan })).toThrow(/PO-001/)
  })

  it('เบิกซ้ำรายการเดิมไม่ได้', () => {
    const d = issueJobAccessory(base(), actor, { jobId: 'j1', ...plan })
    expect(() => issueJobAccessory(d, actor, { jobId: 'j1', requestIds: ['r1'] })).toThrow(/เบิกให้ Service ไปแล้ว/)
  })

  it('เบิกก่อนดึง LBS ครบ Scope ไม่ได้', () => {
    const d = { ...base(), jobs: [job({ lbsQtyRequired: 3 })] }
    expect(() => issueJobLbs(d, actor, { jobId: 'j1', ...plan })).toThrow(/ครบ Scope/)
  })

  it('เบิกออกไปแล้วบางส่วน → ยกเลิก Job ไม่ได้ (ของอยู่ในมือ Service)', () => {
    const d = issueJobLbs(base(), actor, { jobId: 'j1', ...plan })
    expect(() => cancelJob(d, actor, { jobId: 'j1', reason: 'ลูกค้าเลื่อน', receivedAccessoryToCentral: true }))
      .toThrow(/ยกเลิกไม่ได้/)
  })

  it('ไม่มีนัดติดตั้งเดิมและไม่กรอกมา → ต้องเตือน ไม่ใช่เบิกผ่าน', () => {
    expect(() => issueJobLbs(base(), actor, { jobId: 'j1' })).toThrow(/กำหนดวันติดตั้ง/)
  })
})

// =============================================================================
describe('ETA to WH — FOB + ระยะขนส่ง', () => {
  it('มี FOB = คำนวณอัตโนมัติจากระยะขนส่งมาตรฐาน', () => {
    expect(unitEta({ fobDate: '2026-01-01' })).toBe(addDaysIso('2026-01-01', ETA_LEAD_DAYS))
  })

  it('ระยะขนส่งต่อล็อตชนะค่ามาตรฐาน', () => {
    expect(unitEta({ fobDate: '2026-01-01', etaLeadDays: 45 })).toBe('2026-02-15')
  })

  it('ไม่มี FOB = ใช้วันที่กรอกเอง', () => {
    expect(unitEta({ planPoReceiptDate: '2026-03-10' })).toBe('2026-03-10')
  })

  it('ไม่มีทั้งคู่ = undefined (ไม่ใช่วันนี้ ไม่ใช่ค่าว่าง)', () => {
    // สำคัญ: "ไม่รู้" ต้องต่างจาก "ของถึงแล้ว" ไม่งั้นวางแผนงานผิดโดยไม่รู้ตัว
    expect(unitEta({})).toBeUndefined()
  })

  it('FOB ชนะ planPoReceiptDate เมื่อมีทั้งคู่', () => {
    expect(unitEta({ fobDate: '2026-01-01', etaLeadDays: 45, planPoReceiptDate: '2026-09-09' }))
      .toBe('2026-02-15')
  })

  it('ระยะขนส่งที่ไม่ถูกต้องตกกลับไปใช้ค่ามาตรฐาน', () => {
    expect(unitLeadDays({ etaLeadDays: 0 })).toBe(ETA_LEAD_DAYS)
    expect(unitLeadDays({ etaLeadDays: undefined })).toBe(ETA_LEAD_DAYS)
    expect(unitLeadDays({ etaLeadDays: NaN })).toBe(ETA_LEAD_DAYS)
  })
})

describe('normalizeLeadDays / leadDaysToStore — แยก "ไม่ได้กรอก" ออกจาก "กรอก 60"', () => {
  it('ไม่ได้กรอก = undefined', () => {
    expect(normalizeLeadDays(undefined)).toBeUndefined()
  })

  it('กรอก 60 ต้องคืน 60 ไม่ใช่ undefined — ไม่งั้น import รีเซ็ตกลับค่ามาตรฐานไม่ได้', () => {
    expect(normalizeLeadDays(60)).toBe(60)
  })

  it('นอกช่วงที่อนุญาตต้อง throw', () => {
    expect(() => normalizeLeadDays(ETA_LEAD_MIN - 1)).toThrow()
    expect(() => normalizeLeadDays(ETA_LEAD_MAX + 1)).toThrow()
    expect(() => normalizeLeadDays(50.5)).toThrow()
  })

  it('ตอนเก็บลง DB ค่ามาตรฐานยุบเป็น undefined (แหล่งความจริงเดียว)', () => {
    expect(leadDaysToStore(ETA_LEAD_DAYS)).toBeUndefined()
    expect(leadDaysToStore(45)).toBe(45)
  })
})

// =============================================================================
describe('กำหนดส่ง — งานหลายจุดติดตั้งใช้จุดที่ใกล้ที่สุด', () => {
  it('ไม่มี installSites = ใช้ requiredDate', () => {
    expect(jobDueDate(job({ requiredDate: '2026-06-30' }))).toBe('2026-06-30')
  })

  it('มีหลายจุด = เอาวันที่เร็วที่สุด', () => {
    const j = job({
      requiredDate: '2026-06-30',
      installSites: [
        { location: 'B', requiredDate: '2026-05-15' },
        { location: 'C', requiredDate: '2026-08-01' },
      ],
    })
    expect(jobDueDate(j)).toBe('2026-05-15')
  })

  it('ไม่ระบุกำหนดเลย = undefined (ต้องไปอยู่ท้ายรายการ ไม่ใช่หัวรายการ)', () => {
    expect(jobDueDate(job({ requiredDate: '' }))).toBeUndefined()
    expect(jobDaysLeft(job({ requiredDate: '' }))).toBeUndefined()
  })

  it('เลยกำหนดแล้วได้ค่าติดลบ', () => {
    expect(jobDaysLeft(job({ requiredDate: '2026-01-01' }), '2026-01-11')).toBe(-10)
  })
})

// =============================================================================
describe('helper วันที่ + เลขที่เอกสาร', () => {
  it('addDaysIso ข้ามเดือน/ปีถูกต้อง', () => {
    expect(addDaysIso('2026-12-25', 10)).toBe('2027-01-04')
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29')   // ปีอธิกสุรทิน
  })

  it('daysBetweenIso', () => {
    expect(daysBetweenIso('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetweenIso('2026-01-31', '2026-01-01')).toBe(-30)
  })

  // รูปแบบจริงคือ PREFIX-YYYY-NNNN และรีเซ็ตเลขทุกปี
  const Y = new Date().getFullYear()

  it('เดินเลขต่อจากเลขสูงสุดที่มีอยู่ ไม่ใช่นับจำนวนแถว', () => {
    // นับจำนวนแถวจะชนกันทันทีที่มีการลบเอกสารกลางทาง
    expect(nextNo('PR', [`PR-${Y}-0001`, `PR-${Y}-0007`, `PR-${Y}-0003`])).toBe(`PR-${Y}-0008`)
  })

  it('ยังไม่มีเอกสารเลย = เริ่มที่ 0001', () => {
    expect(nextNo('PR', [])).toBe(`PR-${Y}-0001`)
  })

  it('เลขของปีก่อนไม่ถ่วงเลขปีนี้ (รีเซ็ตทุกปี)', () => {
    expect(nextNo('PR', [`PR-${Y - 1}-0099`])).toBe(`PR-${Y}-0001`)
  })

  it('เลขที่รูปแบบเพี้ยนไม่ทำให้พัง', () => {
    expect(nextNo('PR', ['ของเก่าไม่มีรูปแบบ', `PR-${Y}-0005`])).toBe(`PR-${Y}-0006`)
  })
})

// =============================================================================
// พิกัดจุดติดตั้งตามแผน (0060)
//
// กฎที่ต้องล็อก:
//   1) รับรูปแบบที่คนคัดลอกจาก Google Maps มาจริง ("13.75, 100.50" / ไม่มีเว้นวรรค / เว้นวรรคเดียว)
//   2) พิกัดสลับ lat/lng ต้องบอกว่า "สลับ" พร้อมค่าที่ถูก — ไม่ใช่แค่ "ค่าไม่ถูก"
//      (เป็นความผิดพลาดที่เจอบ่อยสุด และเดาเองไม่ได้ว่าผู้ใช้ตั้งใจอะไร)
//   3) ว่าง = null ไม่ใช่ error (พิกัดเป็นข้อมูลไม่บังคับ)
//   4) พิกัดครึ่งคู่หรือนอกกรอบ ต้องไม่ถูกเก็บลง Job — ไม่งั้นหน้าแผนที่กรองทิ้งเงียบ ๆ
// =============================================================================
describe('พิกัดจุดติดตั้งตามแผน — parseLatLng', () => {
  it('รับรูปแบบที่คัดลอกจาก Google Maps ได้ทุกแบบ', () => {
    expect(parseLatLng('13.7563, 100.5018')).toEqual({ lat: 13.7563, lng: 100.5018 })
    expect(parseLatLng('13.7563,100.5018')).toEqual({ lat: 13.7563, lng: 100.5018 })
    expect(parseLatLng('13.7563 100.5018')).toEqual({ lat: 13.7563, lng: 100.5018 })
    expect(parseLatLng('  18.7883 , 98.9853  ')).toEqual({ lat: 18.7883, lng: 98.9853 })
  })

  it('ว่าง = null ไม่ใช่ error (พิกัดไม่บังคับ)', () => {
    expect(parseLatLng('')).toBeNull()
    expect(parseLatLng('   ')).toBeNull()
    expect(parseLatLng(undefined)).toBeNull()
  })

  it('สลับ lat/lng ต้องบอกว่าสลับ พร้อมค่าที่ถูก', () => {
    expect(() => parseLatLng('100.5018, 13.7563')).toThrow(/สลับกัน/)
    expect(() => parseLatLng('100.5018, 13.7563')).toThrow(/13\.7563/)
  })

  it('นอกประเทศไทยและรูปแบบผิด ต้องเตือนคนละข้อความ', () => {
    expect(() => parseLatLng('35.6762, 139.6503')).toThrow(/นอกประเทศไทย/)   // โตเกียว
    expect(() => parseLatLng('13.7563')).toThrow(/รูปแบบพิกัด/)
    expect(() => parseLatLng('abc, def')).toThrow(/รูปแบบพิกัด/)
  })

  it('fmtLatLng คืนค่าว่างเมื่อยังไม่ระบุ — ไม่ใช่ "undefined, undefined"', () => {
    expect(fmtLatLng(13.75, 100.5)).toBe('13.75, 100.5')
    expect(fmtLatLng(undefined, 100.5)).toBe('')
    expect(fmtLatLng(13.75, undefined)).toBe('')
    expect(fmtLatLng()).toBe('')
  })

  it('inThailand ครอบกรอบไทย ไม่ครอบเพื่อนบ้าน', () => {
    expect(inThailand(18.7883, 98.9853)).toBe(true)    // เชียงใหม่
    expect(inThailand(6.5, 101.2)).toBe(true)          // นราธิวาส
    expect(inThailand(1.29, 103.85)).toBe(false)       // สิงคโปร์
    expect(inThailand(21.03, 105.85)).toBe(false)      // ฮานอย
  })
})

describe('พิกัดตามแผนบน Job — เก็บเฉพาะคู่ที่ใช้ได้', () => {
  const actor = { id: 'u1', email: 'p@x.co', password: '', fullName: 'วิชัย', department: 'project' as const, isActive: true }
  const base = { jobNo: 'J-900', customerName: 'กฟภ.', scope: 'ติดตั้ง', installLocation: 'สถานี A', requiredDate: '2026-12-01', lbsQtyRequired: 2 }

  it('พิกัดครบคู่และอยู่ในกรอบ = เก็บ', () => {
    const d = createJob(db(), actor, { ...base, planLat: 13.7563, planLng: 100.5018 })
    expect(d.jobs[0].planLat).toBe(13.7563)
    expect(d.jobs[0].planLng).toBe(100.5018)
  })

  it('พิกัดครึ่งคู่ = ไม่เก็บทั้งคู่ (หมุดวางไม่ได้อยู่ดี)', () => {
    const d = createJob(db(), actor, { ...base, planLat: 13.7563 })
    expect(d.jobs[0].planLat).toBeUndefined()
    expect(d.jobs[0].planLng).toBeUndefined()
  })

  it('พิกัดนอกกรอบไทย = ปฏิเสธตอนบันทึก ไม่ใช่ปล่อยผ่านแล้วหายบนแผนที่', () => {
    expect(() => createJob(db(), actor, { ...base, planLat: 35.6762, planLng: 139.6503 }))
      .toThrow(/นอกประเทศไทย/)
  })

  it('จุดติดตั้งเพิ่มเติม: เก็บพิกัดที่ใช้ได้ ตัดพิกัดที่เพี้ยนทิ้ง', () => {
    const d = createJob(db(), actor, {
      ...base, lbsQtyRequired: 3,
      installSites: [
        { location: 'จุด 2', requiredDate: '2026-12-05', lat: 18.7883, lng: 98.9853 },
        { location: 'จุด 3', requiredDate: '2026-12-10', lat: 35.6762, lng: 139.6503 },  // โตเกียว
      ],
    })
    const sites = d.jobs[0].installSites!
    expect(sites).toHaveLength(2)
    expect(sites[0].lat).toBe(18.7883)
    expect(sites[1].lat).toBeUndefined()     // จุดยังอยู่ แต่ไม่มีหมุด
    expect(sites[1].location).toBe('จุด 3')
  })

  it('แก้ Job แล้วล้างพิกัดได้ (เว้นว่าง = ไม่มีหมุด)', () => {
    let d = createJob(db(), actor, { ...base, planLat: 13.7563, planLng: 100.5018 })
    const jobId = d.jobs[0].id
    d = updateJob(d, actor, { jobId, ...base, planLat: undefined, planLng: undefined })
    expect(d.jobs[0].planLat).toBeUndefined()
  })

  it('ลด Scope ต่ำกว่าเครื่องที่เบิกให้ Service ไปแล้วไม่ได้ (บั๊กจาก 0059)', () => {
    // §0060: guard เดิมนับเฉพาะ allocated — เครื่องที่เบิกออกไปแล้วเป็น issued จึงหลุดการนับ
    const d = db({
      jobs: [job({ lbsQtyRequired: 2 })],
      lbsUnits: [
        unit({ id: 'a', status: 'issued', jobId: 'j1' }),
        unit({ id: 'b', serialLvb: 'LVB-002', status: 'issued', jobId: 'j1' }),
      ],
    })
    expect(() => updateJob(d, actor, {
      jobId: 'j1', jobNo: 'J-001', customerName: 'กฟภ.', scope: 'x',
      installLocation: 'A', requiredDate: '2026-12-01', lbsQtyRequired: 1,
    })).toThrow(/ต่ำกว่าที่ถืออยู่ \(2 เครื่อง\)/)
  })
})
