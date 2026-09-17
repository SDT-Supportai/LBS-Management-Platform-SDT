import { describe, it, expect } from 'vitest'
import type { DB, Job, AccessoryRequest, AccReqStatus, LbsUnit } from '../types'
import { accStatusLabel, accStatusBadge, accBlockNeedsDetail, ACC_STATUS_LABEL } from '../ui/format'
import {
  effectiveQty, poCostSummary, jobMaterialValue, jobLbsCost, jobBudgetSummary,
  deriveJobStatus, jobDueDate, jobDaysLeft, jobAllocatedQty,
  unitIssueBlockReason, accIssueBlockReason, jobPendingIssueAccessories, jobIssuePlan,
  issueJobLbs, issueJobAccessory, cancelJob,
  parseLatLng, fmtLatLng, inThailand, createJob, updateJob,
  unitEta, unitLeadDays, normalizeLeadDays, leadDaysToStore,
  ETA_LEAD_DAYS, ETA_LEAD_MIN, ETA_LEAD_MAX,
  addDaysIso, daysBetweenIso, nextNo,
  markEpicorIssued, undoEpicorIssued, LINE_PUSH_TYPES, drawLbs,
  qtyPendingIssue, qtyIssuedToService, accSettled, transferJobMaterialToStock, writeOffJobMaterial,
  createShareLink, revokeShareLink, publicStockView, touchShareLink, newShareToken,
  adjustPoLine, confirmUnitInstall, blockUnitInstall, assignJobTeam, logSiteVisit, closeJobInstall,
  jobInstallSummary, jobHasIssuedUnits, jobIsFieldActive, unitInstallState, jobTeam, qtyOutToField,
  updateUnitPlan, unitCustomerInfo, importUnitsToStock,
  addUnitFile, deleteUnitFile, unitFiles, unitFileCount, isAllowedDocFile,
  MAX_DOC_FILE_MB, DEMO_MAX_DOC_FILE_MB,
  jobDelivery, jobEffectiveDue, jobDueExtensions, extendJobDue, deleteJobDueExtension,
  addJobPayment, addPaymentFile, deletePaymentFile, paymentFiles, paymentFileCount, deleteJobPayment,
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

// =============================================================================
// ลิงก์สาธารณะดูคลัง LBS โดยไม่ต้อง login (0069)
//
// 🔴 เทสต์ชุดนี้คือ "ตัวกันข้อมูลหลุด" — ไม่ใช่เทสต์ความสะดวก
//    ถ้าวันหลังมีใครเติมคอลัมน์ลง payload แล้วเผลอพาต้นทุน/เบอร์โทรออกไป ต้องแดงที่นี่
//    (ฝั่ง LIVE มี DO block ใน 0069 ตรวจ body ของ rpc_public_lbs_stock ด้วยกติกาเดียวกัน)
// =============================================================================
// ---------- fixture ----------
const EMPTY: DB = {
  users: [], publicShareLinks: [],
  items: [], projectStocks: [], lbsUnits: [], lbsUnitFiles: [], jobs: [], allocations: [],
  accessoryStock: [], accessoryRequests: [], prs: [], pos: [], approvalRequests: [], approvalComments: [],
  auditLogs: [], notifications: [], siteVisits: [], unitInstallations: [],
  teamMembers: [], jobAssignments: [], stockMovements: [], jobPayments: [],
  jobPaymentFiles: [], jobDueExtensions: [],
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
describe('ลิงก์สาธารณะดูคลัง LBS (0069) — กันข้อมูลหลุด', () => {
  const actor = { id: 'u1', email: 'd@x.co', password: '', fullName: 'สมชาย', department: 'sales' as const, isActive: true }
  const base = () => db({
    users: [actor],
    projectStocks: [
      { id: 's1', stockNo: 'Project Stock No.1', itemId: 'i1', status: 'open' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 's2', stockNo: 'Project Stock No.2', itemId: 'i1', status: 'open' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    jobs: [job({ id: 'j1', contactPhone: '081-234-5678', budgetSalePrice: 9_000_000, budgetCost: 7_000_000 })],
    lbsUnits: [
      unit({ id: 'a', projectStockId: 's1', status: 'allocated', jobId: 'j1', unitCost: 1_200_000 }),
      unit({ id: 'b', serialLvb: 'LVB-002', serialOm: 'OM-002', projectStockId: 's2', unitCost: 999_999 }),
    ],
  })
  const tokenOf = (d: DB) => d.publicShareLinks[d.publicShareLinks.length - 1].token!

  it('🔴 payload ต้องไม่มีต้นทุนรายเครื่อง · ไม่มีเบอร์โทร · ไม่มีงบ Job', () => {
    const d = createShareLink(base(), actor, {})
    const v = publicStockView(d, tokenOf(d))
    const json = JSON.stringify(v)
    expect(json).not.toContain('1200000')         // unitCost
    expect(json).not.toContain('999999')
    expect(json).not.toContain('081-234-5678')    // contactPhone (PDPA)
    expect(json).not.toContain('9000000')         // budgetSalePrice
    expect(json).not.toContain('7000000')         // budgetCost
    // ตรวจที่ชื่อคีย์ด้วย — เผื่อวันหลังค่าบังเอิญไม่ตรงรูปแบบข้างบน
    v.units.forEach(u => expect(Object.keys(u)).not.toContain('unitCost'))
    v.jobs.forEach(j => expect(Object.keys(j)).not.toContain('contactPhone'))
  })

  it('ของที่ต้องเห็นยังอยู่ครบ (Serial · สถานะ · ETA · Job · ลูกค้า · สถานที่)', () => {
    const d = createShareLink(base(), actor, {})
    const v = publicStockView(d, tokenOf(d))
    expect(v.units.map(u => u.serialLvb).sort()).toEqual(['LVB-001', 'LVB-002'])
    expect(v.jobs[0].jobNo).toBe('J-001')
    expect(v.jobs[0].customerName).toBe('กฟภ.')
    expect(v.jobs[0].installLocation).toBe('สถานีไฟฟ้า A')
  })

  it('ลิงก์เจาะจงคลัง เห็นเฉพาะคลังนั้น', () => {
    const d = createShareLink(base(), actor, { projectStockId: 's2' })
    const v = publicStockView(d, tokenOf(d))
    expect(v.stockNo).toBe('Project Stock No.2')
    expect(v.units.map(u => u.id)).toEqual(['b'])
    expect(v.jobs).toHaveLength(0)          // เครื่องในคลังนี้ยังไม่เข้า Job
  })

  it('token มั่ว หรือลิงก์ที่เพิกถอนแล้ว เปิดไม่ได้', () => {
    const d = createShareLink(base(), actor, {})
    const tok = tokenOf(d)
    expect(() => publicStockView(d, 'ไม่ใช่โทเคน')).toThrow(/ไม่ถูกต้อง/)
    const revoked = revokeShareLink(d, actor, { linkId: d.publicShareLinks[0].id })
    expect(() => publicStockView(revoked, tok)).toThrow(/เพิกถอน/)
    expect(() => revokeShareLink(revoked, actor, { linkId: d.publicShareLinks[0].id })).toThrow(/เพิกถอนไปแล้ว/)
  })

  it('token สุ่มยาวพอและไม่ซ้ำ · เพิกถอนแล้วลบ token ทิ้งจากแถว', () => {
    const t1 = newShareToken(); const t2 = newShareToken()
    expect(t1).toHaveLength(64)
    expect(t1).not.toBe(t2)
    expect(/^[0-9a-f]{64}$/.test(t1)).toBe(true)
    const d = createShareLink(base(), actor, {})
    const revoked = revokeShareLink(d, actor, { linkId: d.publicShareLinks[0].id })
    expect(revoked.publicShareLinks[0].token).toBeUndefined()
    expect(revoked.publicShareLinks[0].tokenHint).toHaveLength(6)   // ยังระบุแถวได้
  })

  it('นับยอดเปิดดูให้ Division เห็นว่าลิงก์ถูกใช้แค่ไหน', () => {
    let d = createShareLink(base(), actor, {})
    const tok = tokenOf(d)
    expect(d.publicShareLinks[0].viewCount).toBe(0)
    d = touchShareLink(d, tok); d = touchShareLink(d, tok)
    expect(d.publicShareLinks[0].viewCount).toBe(2)
    expect(d.publicShareLinks[0].lastViewedAt).toBeTruthy()
  })
})

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

  // 0067 — "เบิกไปแล้ว" ต้องวัดด้วยจำนวน ไม่ใช่ธง issuedToServiceAt (ธงขึ้นตั้งแต่เบิกรอบแรก)
  it('เบิกครบจำนวนแล้วไม่ถูกนับเป็นของค้างอีก', () => {
    const r = req({ status: 'received', qtyRequested: 3, qtyIssuedToService: 3,
      issuedToServiceAt: '2026-06-01T00:00:00.000Z' })
    expect(accIssueBlockReason(db(), r)).toContain('เบิกครบแล้ว')
    expect(jobPendingIssueAccessories(db({ accessoryRequests: [r] }), 'j1')).toHaveLength(0)
  })

  it('เบิกบางส่วนยังค้างอยู่ — ขวางการปิดใบจนกว่าทุกชิ้นจะมีที่ไป', () => {
    const r = req({ status: 'received', qtyRequested: 10, qtyIssuedToService: 4,
      issuedToServiceAt: '2026-06-01T00:00:00.000Z' })
    expect(qtyPendingIssue(r)).toBe(6)
    expect(accSettled(r)).toBe(false)
    expect(accIssueBlockReason(db({ pos: [poReceived] }), r)).toBeUndefined()   // เบิกต่อได้
    expect(jobPendingIssueAccessories(db({ accessoryRequests: [r] }), 'j1')).toHaveLength(1)
  })

  it('เบิกบางส่วน + โอนคืนคลังส่วนที่เหลือ = รายการจบ (มติ 2026-09-11)', () => {
    const r = req({ status: 'received', qtyRequested: 10, qtyIssuedToService: 4, qtyTransferred: 6 })
    expect(qtyPendingIssue(r)).toBe(0)
    expect(accSettled(r)).toBe(true)
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
    const beforeLbs = d.notifications.length
    d = issueJobLbs(d, actor, { jobId: 'j1' })            // ไม่ต้องกรอกนัดซ้ำ
    expect(d.jobs[0].terminalStatus).toBe('issued')
    expect(d.jobs[0].issuedAt).toBeTruthy()
    expect(d.accessoryRequests[0].issuedToServiceAt).toBeTruthy()
    // 2026-08-28: ก้าวที่ทำให้ใบครบต้องได้ **ข้อความเดียว** ที่มีหาง "ครบทั้งใบแล้ว"
    // เดิมยิง 2 ใบติดกันในกลุ่ม (lbs_issued_to_service + job_issued) ที่พูดเรื่องเดียวกัน
    const fromLbs = d.notifications.slice(beforeLbs)
    expect(fromLbs).toHaveLength(1)
    expect(fromLbs[0].type).toBe('lbs_issued_to_service')
    expect(fromLbs[0].message).toContain('ครบทั้งใบแล้ว')
    expect(d.notifications.some(n => n.type === 'job_issued')).toBe(false)
  })
  // Location ยาวจนดันข้อความในกลุ่มตกบรรทัด กลบส่วนที่ต้องอ่านจริง (Job No./จำนวน/วันที่)
  it('ข้อความเบิกให้ Service ต้องไม่มี Location (มติ 2026-08-28)', () => {
    let d = issueJobAccessory(base(), actor, { jobId: 'j1', ...plan })
    d = issueJobLbs(d, actor, { jobId: 'j1' })
    const msgs = d.notifications
      .filter(n => n.type === 'accessory_issued_to_service' || n.type === 'lbs_issued_to_service')
      .map(n => n.message)
    expect(msgs).toHaveLength(2)
    for (const m of msgs) expect(m).not.toContain(plan.location)
    // แต่ยังต้องมีวันนัดติดตั้ง — เป็นข้อมูลที่ทีมช่างใช้วางแผนจริง
    expect(msgs.every(m => m.includes('2026-07-01'))).toBe(true)
  })
  // เบิกแยกกันคนละครั้ง = แจ้งตามการเบิก ครั้งละใบ (ข้อ 2 ของมติ 2026-08-28)
  it('เบิกวัสดุอย่างเดียว ยังไม่ครบใบ → 1 ข้อความ ไม่มีหาง "ครบทั้งใบแล้ว"', () => {
    const before = base()
    const d = issueJobAccessory(before, actor, { jobId: 'j1', ...plan })
    const fresh = d.notifications.slice(before.notifications.length)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].type).toBe('accessory_issued_to_service')
    expect(fresh[0].message).not.toContain('ครบทั้งใบแล้ว')
  })

  it('เบิก LBS ที่ ETA ยังไม่ถึงไม่ได้ — กันทีมออกหน้างานเสียเที่ยว', () => {
    const d = { ...base(), lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1', planPoReceiptDate: '2099-01-01' })] }
    expect(() => issueJobLbs(d, actor, { jobId: 'j1', ...plan })).toThrow(/ETA/)
  })

  it('เบิกวัสดุของ PO ที่ยังรอรับของไม่ได้', () => {
    const d = { ...base(), pos: [{ ...poReceived, status: 'issued' as const }] }
    expect(() => issueJobAccessory(d, actor, { jobId: 'j1', requestIds: ['r1'], ...plan })).toThrow(/PO-001/)
  })

  it('เบิกซ้ำรายการที่เบิกครบแล้วไม่ได้', () => {
    const d = issueJobAccessory(base(), actor, { jobId: 'j1', ...plan })
    expect(() => issueJobAccessory(d, actor, { jobId: 'j1', requestIds: ['r1'] })).toThrow(/เบิกครบแล้ว/)
  })

  // ---- เบิกตามจำนวน (0067 · มติผู้ใช้ 2026-09-11) ----
  it('เบิกบางส่วนได้ · ของที่เหลือค้างที่ Job · Job ยังไม่ปิดเป็น issued', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, status: 'received' })] }
    const d = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 4 }, ...plan })
    const r = d.accessoryRequests[0]
    expect(r.qtyIssuedToService).toBe(4)
    expect(qtyPendingIssue(r)).toBe(6)
    expect(effectiveQty(r)).toBe(10)                     // ต้นทุนไม่เปลี่ยน — ของยังเป็นของงานนี้
    expect(d.jobs.find(j => j.id === 'j1')!.terminalStatus).toBeNull()
    // เบิกรอบ 2 ต่อได้จนครบ แล้วรายการจึงจบ
    const d2 = issueJobAccessory(d, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 6 } })
    expect(d2.accessoryRequests[0].qtyIssuedToService).toBe(10)
    expect(accSettled(d2.accessoryRequests[0])).toBe(true)
  })

  it('เบิกเกินจำนวนที่ค้างไม่ได้ · เบิก 0 หรือค่าติดลบไม่ได้', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, status: 'received' })] }
    expect(() => issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 11 }, ...plan }))
      .toThrow(/ไม่เกิน 10/)
    expect(() => issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 0 }, ...plan }))
      .toThrow(/มากกว่า 0/)
    const d1 = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 7 }, ...plan })
    expect(() => issueJobAccessory(d1, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 4 } }))
      .toThrow(/ไม่เกิน 3/)                              // เพดานคือ "ที่ยังค้าง" ไม่ใช่จำนวนที่ขอ
  })

  it('ไม่ส่ง qtys = เบิกที่ค้างทั้งหมด (เคสปกติ "เบิกครบ" ไม่ต้องกรอกอะไร)', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 8, status: 'received' })] }
    const d = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], ...plan })
    expect(d.accessoryRequests[0].qtyIssuedToService).toBe(8)
    expect(accSettled(d.accessoryRequests[0])).toBe(true)
  })

  // ---- โอนคืนคลังคงเหลือ คู่กับการเบิกบางส่วน (0067) ----
  it('โอนของที่ค้างที่ Job เข้าคลัง = รายการจบ + ต้นทุนถูกตัดออก', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, unitPrice: 100, status: 'received' })] }
    const d1 = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 4 }, ...plan })
    const d2 = transferJobMaterialToStock(d1, actor, { requestId: 'r1', qty: 6 })
    const r = d2.accessoryRequests[0]
    expect(r.qtyTransferred).toBe(6)
    expect(qtyIssuedToService(r)).toBe(4)      // ของที่ออกหน้างานแล้วไม่ถูกแตะ
    expect(effectiveQty(r)).toBe(4)            // ต้นทุนเหลือ 4 ชิ้น = 400 บาท
    expect(accSettled(r)).toBe(true)
    expect(d2.accessoryStock.find(s => s.itemId === 'i1')!.qtyOnHand).toBe(6)
    expect(d2.stockMovements.some(m => m.type === 'transfer_from_job')).toBe(true)
  })

  it('โอนเกินของที่ค้าง = ดึงของที่เบิกออกหน้างานแล้วกลับคืน (หัก qtyIssuedToService)', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, unitPrice: 100, status: 'received' })] }
    const d1 = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 8 }, ...plan })
    const d2 = transferJobMaterialToStock(d1, actor, { requestId: 'r1', qty: 5 })   // ค้างที่ Job 2 → เกิน 3
    const r = d2.accessoryRequests[0]
    expect(r.qtyTransferred).toBe(5)
    expect(qtyIssuedToService(r)).toBe(5)      // 8 − 3 ที่ช่างส่งคืน
    expect(qtyPendingIssue(r)).toBe(0)         // บัญชี 3 ช่องยังรวมได้ 10 เสมอ
    expect(effectiveQty(r)).toBe(5)
    expect(d2.auditLogs.some(a => /ส่งคืนกลับคลัง/.test(a.detail))).toBe(true)
  })

  it('โอนคืนเกินจำนวนที่ Job ถือตามบัญชีไม่ได้', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, unitPrice: 100, status: 'received' })] }
    expect(() => transferJobMaterialToStock(d0, actor, { requestId: 'r1', qty: 11 })).toThrow(/ไม่เกิน 10/)
  })

  // ---- ✂️ ตัดจำหน่ายของเหลือ (0068) ----
  it('ตัดจำหน่ายของเหลือ = บรรทัดจบ · ต้นทุนยังอยู่กับ Job · ไม่เข้าคลัง ไม่ลง ledger', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, unitPrice: 100, status: 'received' })] }
    const d1 = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 7 }, ...plan })
    const d2 = writeOffJobMaterial(d1, actor, { requestId: 'r1', qty: 3, reason: 'เศษไม่คุ้มค่าขนส่งกลับ' })
    const r = d2.accessoryRequests[0]
    expect(r.qtyWrittenOff).toBe(3)
    expect(r.writeOffReason).toBe('เศษไม่คุ้มค่าขนส่งกลับ')
    expect(qtyPendingIssue(r)).toBe(0)
    expect(accSettled(r)).toBe(true)
    // ต้นทุนไม่ลด (ต่างจากโอนคืนคลัง) · ของไม่เข้าคลัง · ไม่มีแถวในบัญชีเดินสะพัด
    expect(effectiveQty(r)).toBe(10)
    expect(r.qtyTransferred ?? 0).toBe(0)
    expect(d2.accessoryStock.find(s => s.itemId === 'i1')?.qtyOnHand ?? 0).toBe(0)
    expect(d2.stockMovements).toHaveLength(0)
    expect(d2.auditLogs.some(a => a.action === 'write_off_at_job' && /เศษไม่คุ้ม/.test(a.detail))).toBe(true)
  })

  it('ตัดจำหน่ายต้องมีเหตุผล · ห้ามเกินของที่ค้างที่ Job', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, unitPrice: 100, status: 'received' })] }
    expect(() => writeOffJobMaterial(d0, actor, { requestId: 'r1', qty: 2, reason: '  ' })).toThrow(/เหตุผล/)
    expect(() => writeOffJobMaterial(d0, actor, { requestId: 'r1', qty: 11, reason: 'x' })).toThrow(/ไม่เกิน 10/)
    const d1 = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 8 }, ...plan })
    // ของที่ออกหน้างานแล้วตัดจำหน่ายไม่ได้ — เพดานคือ 2 ที่ค้างอยู่ที่ Job
    expect(() => writeOffJobMaterial(d1, actor, { requestId: 'r1', qty: 3, reason: 'x' })).toThrow(/ไม่เกิน 2/)
  })

  it('ตัดจำหน่ายแล้วโอนคืนคลังเกินของที่มีจริงไม่ได้ (เพดานหัก qtyWrittenOff)', () => {
    const d0 = { ...base(), accessoryRequests: [req({ id: 'r1', qtyRequested: 10, unitPrice: 100, status: 'received' })] }
    const d1 = writeOffJobMaterial(d0, actor, { requestId: 'r1', qty: 4, reason: 'ของเสียหายหน้างาน' })
    expect(() => transferJobMaterialToStock(d1, actor, { requestId: 'r1', qty: 7 })).toThrow(/ไม่เกิน 6/)
    const d2 = transferJobMaterialToStock(d1, actor, { requestId: 'r1', qty: 6 })
    expect(accSettled(d2.accessoryRequests[0])).toBe(true)
    expect(effectiveQty(d2.accessoryRequests[0])).toBe(4)   // เหลือต้นทุนเฉพาะส่วนที่ตัดจำหน่าย
  })

  // 🔴 บั๊กที่ 0067 ทิ้งไว้ (เจอตอนเขียน 0068): บรรทัดจบได้ด้วยการโอนคืน/ตัดจำหน่าย ไม่ใช่แค่การเบิก
  //   ถ้า action เหล่านั้นไม่เรียก finalizeIssue ใบจะค้าง partially_issued ทั้งที่ไม่มีของค้างแล้ว
  it('โอนคืนคลังเป็นชิ้นสุดท้าย → ปิดใบเป็น Issued เอง', () => {
    const d0 = issueJobLbs(base(), actor, { jobId: 'j1', ...plan })       // LBS ออกครบแล้ว
    expect(d0.jobs[0].terminalStatus).toBeNull()                          // ยังมีวัสดุค้าง
    const d1 = transferJobMaterialToStock(d0, actor, { requestId: 'r1', qty: 1 })
    expect(d1.jobs[0].terminalStatus).toBe('issued')
  })

  it('ตัดจำหน่ายเป็นชิ้นสุดท้าย → ปิดใบเป็น Issued เอง', () => {
    const d0 = issueJobLbs(base(), actor, { jobId: 'j1', ...plan })
    const d1 = writeOffJobMaterial(d0, actor, { requestId: 'r1', qty: 1, reason: 'เศษ' })
    expect(d1.jobs[0].terminalStatus).toBe('issued')
  })

  // 🔴 บั๊กที่ผู้ใช้แจ้ง 2026-09-11: Job ที่ปิดเป็น Issued แล้วมี "ซื้อเพิ่มหลังเบิก" (0037)
  //   ปุ่มเบิกหายเพราะ UI ครอบด้วย locked ทั้งก้อน · หลังบ้านอนุญาตอยู่แล้ว — ล็อกกติกานั้นไว้ที่นี่
  //   ถ้าวันหลังมีใครไปเติม guard ให้ issueJobAccessory ปิดตอน issued เทสต์นี้จะจับได้ทันที
  it('Job ที่ปิดเป็น Issued แล้ว ยังเบิกวัสดุที่ซื้อเพิ่มหลังเบิกได้ (สถานะใบไม่เปลี่ยน)', () => {
    const closed = issueJobLbs(issueJobAccessory(base(), actor, { jobId: 'j1', ...plan }), actor, { jobId: 'j1', ...plan })
    expect(closed.jobs[0].terminalStatus).toBe('issued')
    // วัสดุที่ซื้อเพิ่มรอบหลัง (รับของครบแล้ว) — ต้องยังอยู่ในรายการที่เบิกได้
    const withExtra: DB = {
      ...closed,
      accessoryRequests: [...closed.accessoryRequests,
        req({ id: 'r2', status: 'received', poId: 'po1', qtyRequested: 4 })],
    }
    expect(jobIssuePlan(withExtra, 'j1', '2026-06-01').accReady.map(r => r.id)).toEqual(['r2'])
    const after = issueJobAccessory(withExtra, actor, { jobId: 'j1', requestIds: ['r2'], qtys: { r2: 4 } })
    expect(after.accessoryRequests.find(r => r.id === 'r2')!.qtyIssuedToService).toBe(4)
    expect(after.jobs[0].terminalStatus).toBe('issued')   // ปิดอยู่แล้ว ไม่เปลี่ยน ไม่ error
  })

  it('Job ที่ปิดงานติดตั้งแล้ว (installed) เบิกเพิ่มไม่ได้ — เส้นแบ่งอยู่ที่ installed ไม่ใช่ issued', () => {
    const d0 = { ...base(), jobs: [{ ...base().jobs[0], terminalStatus: 'installed' as const }] }
    expect(() => issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], ...plan }))
      .toThrow(/ปิดงานติดตั้งแล้ว/)
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

// =============================================================================
// คอลัมน์ "สถานะ" ของตาราง Purchase Orders — คอลัมน์เดียวเล่าทั้งสาย (มติ 2026-08-27)
//
// เดิมแยกเป็น "สถานะ" (ขั้นจัดซื้อ) + "เบิกให้ Service" (ส่งออกหน้างานหรือยัง) → อ่านแล้ว
// เหมือนบอกเรื่องเดียวกันซ้ำ 2 ที่ · ยุบเหลือคอลัมน์เดียวแล้วต้องไม่ทำข้อมูลหาย
//
// กฎที่ต้องล็อก:
//   1) ทุกค่าของ AccReqStatus ต้องมีป้าย และป้ายต้องไม่ซ้ำกัน (ไม่งั้น 2 ขั้นอ่านเหมือนกัน)
//   2) ธง issuedToServiceAt ต้องชนะ status เสมอ — ยกเว้นรายการที่ยกเลิก/คืนคลัง
//   3) ขั้นที่ป้ายบอกเหตุผลอยู่ในตัวแล้ว ห้ามเอา block reason มาย้ำใต้ป้ายซ้ำ
// =============================================================================
describe('สถานะวัสดุ — คอลัมน์เดียวเล่าทั้งสาย', () => {
  it('ทุกสถานะมีป้าย และไม่มีป้ายซ้ำกัน', () => {
    const all: AccReqStatus[] = ['pending', 'pr_sent', 'po_ordered', 'received', 'issued', 'returned', 'cancelled']
    all.forEach(st => expect(ACC_STATUS_LABEL[st], st).toBeTruthy())
    const labels = all.map(st => ACC_STATUS_LABEL[st])
    expect(new Set(labels).size).toBe(all.length)
  })

  it('สายสั่งซื้อเดินครบจนถึงเบิกให้ Service', () => {
    expect(accStatusLabel(req({ status: 'pending' }))).toBe('รอออก PR')
    expect(accStatusLabel(req({ status: 'pr_sent' }))).toBe('ส่ง PR แล้ว รอออก PO')
    expect(accStatusLabel(req({ status: 'po_ordered' }))).toBe('ออก PO แล้ว รอรับของ')
    expect(accStatusLabel(req({ status: 'received' }))).toBe('รับของแล้ว รอนำใช้')
    expect(accStatusLabel(req({ status: 'received', issuedToServiceAt: '2026-08-27T00:00:00.000Z' })))
      .toBe('เบิกให้ Service แล้ว')
  })

  it('สายคลังคงเหลือเดิน 2 ขั้นจบ', () => {
    const inHand = req({ source: 'central_stock', status: 'issued', poId: null, prId: null })
    expect(accStatusLabel(inHand)).toBe('เบิกคลัง รอนำใช้')
    expect(accStatusLabel({ ...inHand, issuedToServiceAt: '2026-08-27T00:00:00.000Z' }))
      .toBe('เบิกให้ Service แล้ว')
  })

  it('2 ขั้นที่ "ของอยู่กับ Job พร้อมส่งออก" ต้องอ่านเป็นชุดเดียวกัน (ลงท้าย รอนำใช้)', () => {
    // ตั้งใจให้คู่ขนานกัน — คนกวาดตาเห็น "รอนำใช้" ต้องรู้ทันทีว่าเบิกให้ Service ได้แล้ว
    expect(accStatusLabel(req({ status: 'issued' }))).toMatch(/รอนำใช้$/)
    expect(accStatusLabel(req({ status: 'received' }))).toMatch(/รอนำใช้$/)
  })

  it('สีป้ายแยก 3 ความหมาย: รอ (amber) · ของอยู่กับ Job (green) · ออกไปแล้ว (blue)', () => {
    expect(accStatusBadge(req({ status: 'po_ordered' }))).toBe('amber')
    expect(accStatusBadge(req({ status: 'received' }))).toBe('green')
    expect(accStatusBadge(req({ status: 'issued' }))).toBe('green')
    expect(accStatusBadge(req({ status: 'received', issuedToServiceAt: '2026-08-27T00:00:00.000Z' }))).toBe('blue')
  })

  it('รายการที่ยกเลิก/คืนคลัง — status เป็นคำตอบสุดท้าย ธงเบิกไม่ทับ', () => {
    const cancelled = req({ status: 'cancelled', issuedToServiceAt: '2026-08-27T00:00:00.000Z' })
    expect(accStatusLabel(cancelled)).toBe('ยกเลิก')
    expect(accStatusBadge(cancelled)).toBe('neutral')
    expect(accStatusLabel(req({ status: 'returned' }))).toBe('คืนสต็อกแล้ว')
  })

  it('ขั้นจัดซื้อไม่ต้องมีบรรทัดเหตุผลย้ำใต้ป้าย — ป้ายบอกอยู่แล้ว', () => {
    expect(accBlockNeedsDetail(req({ status: 'pending' }))).toBe(false)
    expect(accBlockNeedsDetail(req({ status: 'pr_sent' }))).toBe(false)
    expect(accBlockNeedsDetail(req({ status: 'po_ordered' }))).toBe(false)
  })

  it('เคสที่ป้ายบอกไม่ได้ ต้องยังมีบรรทัดเหตุผล — รับของครบแล้วแต่ PO ทั้งใบยังไม่ครบ', () => {
    // ป้ายจะเขียนว่า "รับของแล้ว รอนำใช้" ซึ่งดูเหมือนเบิกได้ แต่จริง ๆ ติดที่ PO ทั้งใบ
    expect(accBlockNeedsDetail(req({ status: 'received' }))).toBe(true)
    const poWaiting = { id: 'po2', poNo: 'PO-002', prId: 'pr1', jobId: 'j1', supplierName: 'ซัพ A', expectedDate: '2026-06-01', status: 'issued' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }
    const d = db({ pos: [poWaiting], accessoryRequests: [req({ status: 'received', poId: 'po2' })] })
    expect(accIssueBlockReason(d, d.accessoryRequests[0])).toContain('PO-002')
  })
})

// =============================================================================
// ทำเบิก-Epicor (0064) — ธงกระทบยอดกับ ERP
//
// กฎที่ต้องล็อก:
//   1) กดได้เฉพาะบรรทัดที่ของอยู่กับ Job แล้ว (issued = เบิกคลัง · received = รับของครบ)
//   2) ธงนี้ **ไม่แตะ status และไม่แตะ issuedToServiceAt** — ถ้าหลุดไปแตะ จะกลายเป็น
//      ด่านบังคับที่ทำให้ทีมช่างออกหน้างานไม่ได้เพราะรอเอกสาร (มติ 2026-09-01: ไม่บล็อก)
//   3) ยกเลิกธงต้องมีเหตุผลเสมอ (ไม่งั้น audit ตอบไม่ได้ว่าทำไมธงหาย)
// =============================================================================
describe('ทำเบิก-Epicor (0064)', () => {
  const actor = { id: 'u9', email: 'pur@x.co', password: '', fullName: 'มาลี', department: 'purchasing' as const, isActive: true }
  const withReq = (over: Partial<AccessoryRequest>) =>
    db({ jobs: [job({ id: 'j1', jobNo: 'JOB-001' })], accessoryRequests: [req({ id: 'r1', ...over })] })

  it('กดได้เมื่อ "รับของแล้ว รอนำใช้" — เก็บเลขเอกสาร + คนกด', () => {
    const d = markEpicorIssued(withReq({ status: 'received' }), actor, { requestId: 'r1', txnType: 'issue_mis', docNo: ' ISS-2026-001 ' })
    expect(d.accessoryRequests[0].epicorIssuedAt).toBeTruthy()
    expect(d.accessoryRequests[0].epicorDocNo).toBe('ISS-2026-001')   // trim ให้
    expect(d.accessoryRequests[0].epicorIssuedBy).toBe('u9')
  })

  it('กดได้เมื่อ "เบิกคลัง รอนำใช้" · เลขเอกสารเว้นว่างได้', () => {
    const d = markEpicorIssued(withReq({ status: 'issued', source: 'central_stock' }), actor, { requestId: 'r1', txnType: 'issue_mis' })
    expect(d.accessoryRequests[0].epicorIssuedAt).toBeTruthy()
    expect(d.accessoryRequests[0].epicorDocNo).toBeUndefined()
  })

  it('ขั้นที่ของยังไม่ถึง Job กดไม่ได้', () => {
    for (const s of ['pending', 'pr_sent', 'po_ordered'] as const)
      expect(() => markEpicorIssued(withReq({ status: s }), actor, { requestId: 'r1', txnType: 'issue_mis' })).toThrow(/ของอยู่กับ Job แล้ว/)
  })

  it('กดซ้ำไม่ได้', () => {
    const d = markEpicorIssued(withReq({ status: 'received' }), actor, { requestId: 'r1', txnType: 'cust_ship' })
    expect(() => markEpicorIssued(d, actor, { requestId: 'r1', txnType: 'cust_ship' })).toThrow(/ไปแล้ว/)
  })

  // ข้อ 2 ของโจทย์ — ธงต้องไม่กลายเป็นด่านบังคับ
  it('ไม่แตะ status และไม่แตะ issuedToServiceAt', () => {
    const before = withReq({ status: 'received', issuedToServiceAt: '2026-07-01T00:00:00.000Z' })
    const d = markEpicorIssued(before, actor, { requestId: 'r1', txnType: 'cust_ship', docNo: 'X' })
    expect(d.accessoryRequests[0].status).toBe('received')
    expect(d.accessoryRequests[0].issuedToServiceAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('ยกเลิกธงได้ แต่ต้องมีเหตุผล', () => {
    const d = markEpicorIssued(withReq({ status: 'received' }), actor, { requestId: 'r1', txnType: 'cust_ship', docNo: 'X' })
    expect(() => undoEpicorIssued(d, actor, { requestId: 'r1', reason: '  ' })).toThrow(/เหตุผล/)
    const u = undoEpicorIssued(d, actor, { requestId: 'r1', reason: 'กดผิดบรรทัด' })
    expect(u.accessoryRequests[0].epicorIssuedAt).toBeUndefined()
    expect(u.accessoryRequests[0].epicorDocNo).toBeUndefined()
    expect(u.auditLogs[0].detail).toContain('กดผิดบรรทัด')   // audit ใหม่ถูก prepend
  })

  // 0065 — บังคับเลือกประเภท เพราะ 2 ทางนี้กระทบยอดคนละฝั่ง (รายได้ / ต้นทุน)
  it('ไม่เลือกประเภทกดไม่ได้', () => {
    // @ts-expect-error จงใจส่งค่าไม่ถูกต้องเพื่อทดสอบ guard ฝั่ง logic (UI บังคับด้วย required อีกชั้น)
    expect(() => markEpicorIssued(withReq({ status: 'received' }), actor, { requestId: 'r1' }))
      .toThrow(/เลือกประเภท/)
  })

  it('เก็บประเภทที่เลือก และยกเลิกแล้วล้างประเภทด้วย', () => {
    const d = markEpicorIssued(withReq({ status: 'received' }), actor, { requestId: 'r1', txnType: 'cust_ship' })
    expect(d.accessoryRequests[0].epicorTxnType).toBe('cust_ship')
    expect(d.auditLogs[0].detail).toContain('Cust-Ship')
    const u = undoEpicorIssued(d, actor, { requestId: 'r1', reason: 'เลือกประเภทผิด' })
    expect(u.accessoryRequests[0].epicorTxnType).toBeUndefined()
  })
  it('ยังไม่ได้ทำเบิก จะยกเลิกไม่ได้', () => {
    expect(() => undoEpicorIssued(withReq({ status: 'received' }), actor, { requestId: 'r1', reason: 'x' }))
      .toThrow(/ยังไม่ได้ทำเบิก/)
  })
})

// =============================================================================
// โควตา LINE (0066) — Messaging API มี 300 ข้อความ/เดือน
//
// กฎที่ต้องล็อก:
//   1) เฉพาะชนิดใน LINE_PUSH_TYPES เท่านั้นที่เข้าคิวส่ง LINE (lineStatus = 'pending')
//   2) ชนิดที่ตัดออก **ยังต้องถูกบันทึกครบ** — แค่ lineStatus = 'off'
//      (ถ้าเผลอทำให้หายไปเลย หน้า Notifications กับ Audit จะโหว่โดยไม่มีใครรู้)
//   3) รับของ "บางส่วน" ต้องไม่กินโควตา — รับครบเท่านั้นที่เข้า LINE
// =============================================================================
describe('โควตา LINE — allowlist (0066)', () => {
  const actor = { id: 'u1', email: 'a@x.co', password: '', fullName: 'สมชาย', department: 'admin' as const, isActive: true }

  it('ตัวที่บล็อกงานคนอื่นอยู่ในลิสต์ครบ', () => {
    for (const t of ['pr_created', 'approval_requested', 'po_received',
                     'lbs_issued_to_service', 'accessory_issued_to_service', 'job_cancelled'])
      expect(LINE_PUSH_TYPES.has(t)).toBe(true)
  })

  it('ตัวที่กินโควตาแต่ไม่บล็อกใครถูกตัดออก', () => {
    for (const t of ['accessory_issued', 'lbs_drawn', 'po_created', 'approval_approved',
                     'job_installed', 'team_assigned', 'unit_install_blocked', 'po_received_partial'])
      expect(LINE_PUSH_TYPES.has(t)).toBe(false)
  })

  it('ชนิดที่ตัดออกยังถูกบันทึก แค่ไม่เข้าคิว LINE', () => {
    const before = db({
      jobs: [job({ id: 'j1', jobNo: 'JOB-001', lbsQtyRequired: 1 })],
      projectStocks: [{ id: 's1', stockNo: 'ST-1', itemId: 'i-lbs', status: 'open' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }],
      lbsUnits: [unit({ id: 'a', status: 'in_stock', projectStockId: 's1' })],
    })
    const d = drawLbs(before, actor, { jobId: 'j1', stockId: 's1', unitIds: ['a'] })
    const n = d.notifications.find(x => x.type === 'lbs_drawn')
    expect(n).toBeTruthy()               // ยังบันทึกอยู่
    expect(n!.lineStatus).toBe('off')    // แต่ไม่ส่ง LINE
  })
})
// =============================================================================
// แก้จำนวนสั่งใน PO / ตัด item ที่สั่งเกิน (0070)
//
// ต้นเรื่อง: PO ที่จำนวนสั่งผิด รับของไม่มีวันครบ → line ค้าง po_ordered → PO ค้าง issued
//   → Job เบิกให้ Service ไม่ได้ทั้งใบ · ของเดิมมีแค่ cancelPO ที่ใช้ได้เฉพาะใบที่ยังไม่รับของเลย
//
// กฎที่ต้องไม่หลุด (ถ้าแดงที่นี่ = บัญชีกับของจริงเริ่มไม่ตรงกัน):
//   1) ลดได้อย่างเดียว — เพิ่มจำนวนต้องไปออก PR/PO ใบใหม่ ไม่งั้นเลขต่างจากใบที่ส่งซัพไปแล้ว
//   2) ลดต่ำกว่าของที่รับมาแล้วไม่ได้ — ของอยู่ในมือจริง
//   3) ปิดบรรทัดสุดท้ายแล้ว PO/PR ต้องปิดตามเอง ไม่งั้นแก้แล้ว Job ยังตันเหมือนเดิม
//   4) ใบที่ไม่เคยรับของเลยต้องปิดเป็น 'cancelled' ไม่ใช่ 'received' (ไม่มีของเข้าจริงสักชิ้น)
// =============================================================================
describe('แก้จำนวนสั่งใน PO (0070)', () => {
  const actor = { id: 'u9', email: 'pur@x.co', password: '', fullName: 'มาลี', department: 'purchasing' as const, isActive: true }
  const poIssued = {
    id: 'po1', poNo: 'PO-001', prId: 'pr1', jobId: 'j1', supplierName: 'ซัพ A',
    expectedDate: '2026-06-01', status: 'issued' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z',
  }
  const base = (lines: Partial<AccessoryRequest>[]) => db({
    users: [actor],
    items: [{ id: 'i1', code: 'ACC-1', name: 'ลูกถ้วย', itemType: 'accessory' as const, uom: 'ea', stockableCentrally: false }],
    jobs: [job({ lbsQtyRequired: 1 })],
    pos: [poIssued],
    accessoryRequests: lines.map(l => req({ status: 'po_ordered', poId: 'po1', prId: 'pr1', ...l })),
  })

  it('สั่งเกิน รับมาเท่าที่มีจริง → ลดจำนวนเท่าที่รับ = บรรทัดจบ + PO ปิดเป็น "รับของครบ"', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 10, qtyReceived: 8 }])
    const d = adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 8, reason: 'กรอกจำนวนเกินตอนออก PR' })
    expect(d.accessoryRequests[0].qtyRequested).toBe(8)
    expect(d.accessoryRequests[0].qtyReceived).toBe(8)      // ของที่รับจริงห้ามเปลี่ยน
    expect(d.accessoryRequests[0].status).toBe('received')
    expect(d.pos[0].status).toBe('received')
    expect(d.pos[0].receivedAt).toBeTruthy()
  })

  it('ใส่ item เกินมาทั้งบรรทัด (ยังไม่เคยรับ) → ตั้ง 0 = ตัดออก · ใบที่ไม่มีของเข้าเลยปิดเป็น "ยกเลิก"', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 5, qtyReceived: 0 }])
    const d = adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 0, reason: 'รายการนี้ไม่ได้สั่งจริง' })
    expect(d.accessoryRequests[0].qtyRequested).toBe(0)
    expect(d.accessoryRequests[0].status).toBe('cancelled')
    expect(d.pos[0].status).toBe('cancelled')               // ไม่ใช่ received — ไม่มีของเข้าสักชิ้น
    expect(d.prs.length).toBe(0)
  })

  it('ตัดบรรทัดเกินทิ้ง แต่บรรทัดอื่นรับของมาแล้ว → PO ปิดเป็น "รับของครบ"', () => {
    const d0 = base([
      { id: 'r1', qtyRequested: 3, qtyReceived: 3, status: 'received' },
      { id: 'r2', qtyRequested: 2, qtyReceived: 0 },
    ])
    const d = adjustPoLine(d0, actor, { requestId: 'r2', qtyRequested: 0, reason: 'ใส่เกินมา' })
    expect(d.pos[0].status).toBe('received')
  })

  it('ลดบางส่วนแต่ยังไม่ถึงของที่รับ → บรรทัดยังค้างรับ · PO ยังไม่ปิด', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 10, qtyReceived: 4 }])
    const d = adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 6, reason: 'ซัพส่งได้แค่ 6' })
    expect(d.accessoryRequests[0].status).toBe('po_ordered')
    expect(d.pos[0].status).toBe('issued')
  })

  it('เพิ่มจำนวนไม่ได้ (ต้องออก PR/PO ใบใหม่)', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 5, qtyReceived: 0 }])
    expect(() => adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 8, reason: 'ขอเพิ่ม' }))
      .toThrow(/ลดจำนวนได้อย่างเดียว/)
    expect(() => adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 5, reason: 'เท่าเดิม' }))
      .toThrow(/ลดจำนวนได้อย่างเดียว/)
  })

  it('ลดต่ำกว่าของที่รับมาแล้วไม่ได้', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 10, qtyReceived: 8 }])
    expect(() => adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 5, reason: 'อยากลด' }))
      .toThrow(/รับของเข้ามาแล้ว 8/)
  })

  it('บังคับกรอกเหตุผล · จำนวนต้องเป็นจำนวนเต็มไม่ติดลบ', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 10, qtyReceived: 0 }])
    expect(() => adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 5, reason: '  ' }))
      .toThrow(/เหตุผล/)
    expect(() => adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 2.5, reason: 'x' }))
      .toThrow(/จำนวนเต็ม/)
  })

  it('แตะได้เฉพาะบรรทัดที่ออก PO แล้วและยังรับไม่ครบ', () => {
    for (const s of ['pending', 'pr_sent', 'received', 'cancelled'] as const) {
      const d0 = base([{ id: 'r1', qtyRequested: 10, qtyReceived: 0, status: s }])
      expect(() => adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 5, reason: 'x' }))
        .toThrow(/ออก PO แล้วและยังรับของไม่ครบ/)
    }
  })

  it('ลดจำนวนแล้วต้นทุนที่ตัดเข้างานลดตาม (นี่คือเหตุผลที่ต้องแก้ที่ qtyRequested)', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 10, qtyReceived: 8, unitPrice: 100 }])
    expect(poCostSummary(d0, 'po1').ordered).toBe(1000)
    const d = adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 8, reason: 'สั่งเกิน' })
    expect(poCostSummary(d, 'po1').ordered).toBe(800)
    expect(jobMaterialValue(d, 'j1')).toBe(800)
  })

  it('ลง audit + แจ้ง Project ทุกครั้ง (ไม่เข้าคิว LINE)', () => {
    const d0 = base([{ id: 'r1', qtyRequested: 10, qtyReceived: 8 }])
    const d = adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 8, reason: 'กรอกเกิน' })
    expect(d.auditLogs.some(a => a.action === 'adjust_po_line')).toBe(true)
    const n = d.notifications.find(x => x.type === 'po_line_adjusted')
    expect(n?.dept).toBe('project')
    expect(n?.message).toContain('กรอกเกิน')
    expect(n?.lineStatus).toBe('off')
  })

  it('ตัดบรรทัดสุดท้ายที่ค้าง แล้ว LBS เบิกครบแล้ว → Job ปิดเป็น Issued เอง', () => {
    let d0 = base([{ id: 'r1', qtyRequested: 2, qtyReceived: 0 }])
    d0 = { ...d0, lbsUnits: [unit({ id: 'a', status: 'issued', jobId: 'j1' })] }
    const d = adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 0, reason: 'ไม่ได้สั่งจริง' })
    expect(d.jobs[0].terminalStatus).toBe('issued')
  })
})

// =============================================================================
// ด่านงานหน้าไซต์เป็น "รายเครื่อง" (0071)
//
// ต้นเรื่อง: 0059 แยกการเบิกเป็นรายชิ้นแล้ว แต่ด่านปลายน้ำยังล็อกที่ terminalStatus = 'issued'
//   ⇒ ส่ง LBS 2 จาก 5 เครื่องให้ช่างได้ แต่ช่างยืนยันติดตั้งไม่ได้ · มอบหมายทีมไม่ได้ ·
//     บันทึกออกหน้างานไม่ได้ · และงานหายไปจากหน้า Service ทั้งใบ
//
// กฎที่ต้องไม่หลุด:
//   1) เครื่องที่ออกจากคลังแล้ว ยืนยันติดตั้งได้ แม้ใบยังไม่ครบ
//   2) เครื่องที่ยังอยู่คลัง ยืนยันไม่ได้ (เดิมด่าน "ทั้งใบ" กันให้โดยอ้อม ตอนนี้ต้องกันเอง)
//   3) งานที่ปิด/ยกเลิกแล้ว แตะผลติดตั้งไม่ได้ (เดิมด่าน '= issued' กันให้ฟรี)
//   4) 🔴 ปิดงานยังต้องเบิกครบทั้งใบ — ข้อนี้คือสิ่งที่ 0071 สัญญาว่าจะไม่ปลด
// =============================================================================
describe('งานหน้าไซต์รายเครื่อง (0071)', () => {
  const actor = { id: 'u1', email: 'p@x.co', password: '', fullName: 'สมชาย', department: 'admin' as const, isActive: true }
  const svc = { ...actor, id: 'u2', department: 'service' as const }
  const member = {
    id: 'm1', firstName: 'ช่าง', lastName: 'เอ', phone: '0800000000',
    position: 'หัวหน้าช่าง', isActive: true, createdAt: '2026-01-01T00:00:00.000Z',
  }
  // งาน 3 เครื่อง: a เบิกออกไปแล้ว · b, c ยังอยู่คลัง (allocated) = เบิกบางส่วนของจริง
  const partial = () => db({
    users: [actor, svc],
    teamMembers: [member],
    jobs: [job({ lbsQtyRequired: 3 })],
    lbsUnits: [
      unit({ id: 'a', serialLvb: 'LVB-A', status: 'issued', jobId: 'j1' }),
      unit({ id: 'b', serialLvb: 'LVB-B', status: 'allocated', jobId: 'j1' }),
      unit({ id: 'c', serialLvb: 'LVB-C', status: 'allocated', jobId: 'j1' }),
    ],
  })
  const proof = { installedDate: '2026-07-01', checkinLat: 13.75, checkinLng: 100.5, photoUrl: 'x.jpg' }

  it('ใบยังไม่ครบ แต่เครื่องที่เบิกออกไปแล้ว ยืนยันติดตั้งได้', () => {
    const d0 = partial()
    expect(d0.jobs[0].terminalStatus).toBeNull()            // ใบยังไม่ปิด
    expect(deriveJobStatus(d0, d0.jobs[0])).toBe('partially_issued')
    const d = confirmUnitInstall(d0, svc, { unitId: 'a', ...proof })
    expect(unitInstallState(d, 'a')).toBe('installed')
  })

  it('เครื่องที่ยังอยู่คลัง ยืนยัน/บล็อกไม่ได้', () => {
    const d0 = partial()
    expect(() => confirmUnitInstall(d0, svc, { unitId: 'b', ...proof }))
      .toThrow(/ยังไม่ถูกเบิกให้ Service/)
    expect(() => blockUnitInstall(d0, svc, { unitId: 'b', reason: 'จุดติดตั้งไม่พร้อม' }))
      .toThrow(/ยังไม่ถูกเบิกให้ Service/)
  })

  it('งานที่ปิด/ยกเลิกแล้ว แตะผลติดตั้งไม่ได้ (ด่านเดิมเคยกันให้โดยบังเอิญ)', () => {
    const d0 = partial()
    const closed = { ...d0, jobs: [{ ...d0.jobs[0], terminalStatus: 'installed' as const }] }
    expect(() => confirmUnitInstall(closed, svc, { unitId: 'a', ...proof })).toThrow(/ปิดงานติดตั้งแล้ว/)
    const killed = { ...d0, jobs: [{ ...d0.jobs[0], terminalStatus: 'cancelled' as const }] }
    expect(() => confirmUnitInstall(killed, svc, { unitId: 'a', ...proof })).toThrow(/ถูกยกเลิก/)
  })

  it('มอบหมายทีม + บันทึกออกหน้างาน ทำได้ตั้งแต่ของออกล็อตแรก', () => {
    const d0 = partial()
    const d1 = assignJobTeam(d0, svc, { jobId: 'j1', memberIds: ['m1'], leadMemberId: 'm1' })
    expect(jobTeam(d1, 'j1')).toHaveLength(1)
    const d2 = logSiteVisit(d1, svc, { jobId: 'j1', outcome: 'rescheduled', reason: 'ฝนตก', newStartDate: '2026-07-10' })
    expect(d2.siteVisits).toHaveLength(1)
    expect(d2.jobs[0].installStartDate).toBe('2026-07-10')
  })

  it('ยังไม่มีเครื่องออกจากคลังเลย = ยังทำงานหน้าไซต์ไม่ได้', () => {
    const d0 = partial()
    const noneOut = { ...d0, lbsUnits: d0.lbsUnits.map(u => ({ ...u, status: 'allocated' as const })) }
    expect(jobHasIssuedUnits(noneOut, 'j1')).toBe(false)
    expect(jobIsFieldActive(noneOut, noneOut.jobs[0])).toBe(false)
    expect(() => assignJobTeam(noneOut, svc, { jobId: 'j1', memberIds: ['m1'] }))
      .toThrow(/ยังไม่มี LBS ที่เบิกให้ Service/)
    expect(() => logSiteVisit(noneOut, svc, { jobId: 'j1', outcome: 'failed', reason: 'ไปไม่ได้' }))
      .toThrow(/ยังไม่มี LBS ที่เบิกให้ Service/)
  })

  it('สรุปความคืบหน้าแยก "รอบนี้" กับ "ทั้งใบ"', () => {
    const d = confirmUnitInstall(partial(), svc, { unitId: 'a', ...proof })
    const s = jobInstallSummary(d, 'j1')
    expect([s.outInstalled, s.outTotal]).toEqual([1, 1])   // ของที่อยู่กับช่าง ติดตั้งครบแล้ว
    expect([s.installed, s.total]).toEqual([1, 3])          // ทั้งใบยังเหลืออีก 2
    expect(s.waiting).toBe(2)                               // รอ Project เบิกให้
  })

  it('🔴 ปิดงานยังต้องเบิกครบทั้งใบ — 0071 ไม่ปลดด่านนี้', () => {
    const d = confirmUnitInstall(partial(), svc, { unitId: 'a', ...proof })
    expect(jobInstallSummary(d, 'j1').canClose).toBe(false)
    expect(() => closeJobInstall(d, svc, { jobId: 'j1', hasIssues: false }))
      .toThrow(/ปิดงานได้เฉพาะงานที่เบิกแล้ว/)
  })

  it('งานที่ปิด/ยกเลิกแล้วหลุดจากคิวงานหน้าไซต์', () => {
    const d0 = partial()
    expect(jobIsFieldActive(d0, d0.jobs[0])).toBe(true)
    for (const st of ['installed', 'cancelled'] as const) {
      const closed = { ...d0.jobs[0], terminalStatus: st }
      expect(jobIsFieldActive({ ...d0, jobs: [closed] }, closed)).toBe(false)
    }
  })
})

// =============================================================================
// จำนวนวัสดุที่ "ถึงมือช่างหน้างานจริง" (0071)
//
// หน้า Service เคยโชว์ qtyRequested เต็มจำนวนเสมอ ⇒ ตั้งแต่ 0067 ที่เบิกทีละบางส่วนได้
// ช่างจะอ่านว่าได้ของครบทั้งที่จริงได้มาแค่บางส่วน (คลาสเดียวกับ Serial LBS ที่เคยโชว์เกิน)
//
// ⚠️ กติกาแถวเก่าต้องตรงกับ backfill ของ 0067 เป๊ะ (`WHERE issued_to_service_at IS NOT NULL`)
//    ไม่งั้นเดโมกับ LIVE จะนับของหน้างานไม่เท่ากัน
// =============================================================================
describe('จำนวนวัสดุที่ถึงมือช่าง (0071)', () => {
  it('เบิกบางส่วน = นับเฉพาะที่ออกไปจริง', () => {
    expect(qtyOutToField(req({ qtyRequested: 10, qtyIssuedToService: 3, issuedToServiceAt: '2026-08-01T00:00:00.000Z' }))).toBe(3)
  })

  it('ยังไม่เคยเบิกออกไปเลย = 0 (ของอยู่กับ Project ไม่ใช่กับช่าง)', () => {
    expect(qtyOutToField(req({ qtyRequested: 10, status: 'received' }))).toBe(0)
  })

  it('แถวก่อน 0067 (ไม่มีคอลัมน์จำนวน แต่มีธงวันที่เบิก) = เบิกครบทั้งบรรทัด', () => {
    expect(qtyOutToField(req({ qtyRequested: 10, issuedToServiceAt: '2026-08-01T00:00:00.000Z' }))).toBe(10)
    // หักของที่โอนคืนคลังไปแล้ว — ตรงกับสูตร backfill GREATEST(qty_requested - qty_transferred, 0)
    expect(qtyOutToField(req({ qtyRequested: 10, qtyTransferred: 4, issuedToServiceAt: '2026-08-01T00:00:00.000Z' }))).toBe(6)
  })

  it('เบิกครบแล้วผ่าน issueJobAccessory = ตรงกับจำนวนที่ขอ', () => {
    const actor = { id: 'u1', email: 'p@x.co', password: '', fullName: 'สมชาย', department: 'admin' as const, isActive: true }
    const d0 = db({
      users: [actor],
      items: [{ id: 'i1', code: 'ACC-1', name: 'ลูกถ้วย', itemType: 'accessory' as const, uom: 'ea', stockableCentrally: false }],
      jobs: [job({ lbsQtyRequired: 1 })],
      pos: [{ id: 'po1', poNo: 'PO-001', prId: 'pr1', jobId: 'j1', supplierName: 'ซัพ A', expectedDate: '2026-06-01', status: 'received' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }],
      lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1' })],
      accessoryRequests: [req({ id: 'r1', qtyRequested: 10, status: 'received', poId: 'po1' })],
    })
    const plan = { startDate: '2026-07-01', endDate: '2026-07-02', location: 'สถานีไฟฟ้า A' }
    const d1 = issueJobAccessory(d0, actor, { jobId: 'j1', requestIds: ['r1'], qtys: { r1: 4 }, ...plan })
    expect(qtyOutToField(d1.accessoryRequests[0])).toBe(4)      // รอบแรก 4
    const d2 = issueJobAccessory(d1, actor, { jobId: 'j1', requestIds: ['r1'], ...plan })
    expect(qtyOutToField(d2.accessoryRequests[0])).toBe(10)     // เบิกที่เหลือจนครบ
  })
})

// เพิ่มจากรอบตรวจบั๊ก 0071 — ข้อความในฟังก์ชันอ้างว่า "ตรงกับ backfill ของ 0067 เป๊ะ"
// แต่ backfill มี `AND status NOT IN ('cancelled','returned')` ด้วย ซึ่งตอนแรกลืมใส่
describe('qtyOutToField ต้องกันแถวที่จบไปแล้ว (parity กับ backfill 0067)', () => {
  it('ยกเลิก/คืนสต็อกแล้ว = 0 แม้ธงวันที่เบิกยังค้างอยู่บนแถว', () => {
    for (const st of ['cancelled', 'returned'] as const)
      expect(qtyOutToField(req({ qtyRequested: 10, status: st, qtyIssuedToService: 6, issuedToServiceAt: '2026-08-01T00:00:00.000Z' }))).toBe(0)
  })
})

// =============================================================================
// ปิดใบเงียบ (0072)
//
// 0063/2026-08-28 ย้ายการประกาศ "ครบทั้งใบแล้ว" ไปเป็นหางต่อท้ายข้อความของ action ที่ทำให้ครบ
// เพื่อกันกลุ่ม LINE ได้ 2 ใบติดกันเรื่องเดียวกัน — ใช้ได้ดีกับ issueJobLbs/issueJobAccessory
//
// แต่ตั้งแต่ 0067/0068/0070 มี action ที่ปิดใบได้ทั้งที่ไม่ได้ "เบิก" อะไร:
//   📦 โอนคืนคลัง · ✂️ ตัดจำหน่าย · ✏️ แก้จำนวนใน PO — ทั้งสามพูดกับ Project เท่านั้น
// ⇒ ใบพลิกเป็น Issued เงียบ ๆ ทั้งที่นาทีนั้นคือนาทีที่งานเข้าคิวหน้า Service ครั้งแรก
//
// กฎที่ต้องไม่หลุด:
//   1) 3 action นั้นปิดใบเมื่อไหร่ ต้องมีข้อความถึง **dept service**
//   2) ปิดไม่ได้ (ยังมีของค้าง) ต้องไม่ยิงอะไร — ไม่งั้นกลุ่มได้ข้อความปลอม
//   3) issueJobLbs/issueJobAccessory ต้อง **ไม่** ยิงตัวนี้ — ไม่งั้นกลับไปเป็น 2 ใบซ้ำเหมือนก่อน 0063
// =============================================================================
describe('ปิดใบเงียบ — ประกาศให้ Service รู้ (0072)', () => {
  const actor = { id: 'u1', email: 'p@x.co', password: '', fullName: 'สมชาย', department: 'admin' as const, isActive: true }
  const poReceived = { id: 'po1', poNo: 'PO-001', prId: 'pr1', jobId: 'j1', supplierName: 'ซัพ A', expectedDate: '2026-06-01', status: 'received' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }
  const base = () => db({
    users: [actor],
    items: [{ id: 'i1', code: 'ACC-1', name: 'ลูกถ้วย', itemType: 'accessory' as const, uom: 'ea', stockableCentrally: false }],
    jobs: [job({ lbsQtyRequired: 1, installStartDate: '2026-07-01', installEndDate: '2026-07-01' })],
    pos: [poReceived],
    lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1' })],
    accessoryRequests: [req({ id: 'r1', status: 'received', poId: 'po1' })],
  })
  // LBS ออกครบแล้ว เหลือวัสดุค้าง 1 บรรทัด = อยู่ในจุดที่ "ก้าวถัดไปทำให้ใบครบพอดี"
  const ready = () => issueJobLbs(base(), actor,
    { jobId: 'j1', startDate: '2026-07-01', endDate: '2026-07-01', location: 'สถานีไฟฟ้า A' })
  const announce = (d: DB) => d.notifications.filter(n => n.type === 'job_ready_to_install')

  it('โอนคืนคลังเป็นชิ้นสุดท้าย → ปิดใบ + แจ้ง Service', () => {
    const d = transferJobMaterialToStock(ready(), actor, { requestId: 'r1', qty: 1 })
    expect(d.jobs[0].terminalStatus).toBe('issued')
    const n = announce(d)
    expect(n).toHaveLength(1)
    expect(n[0].dept).toBe('service')
    expect(n[0].message).toContain('J-001')
    expect(n[0].lineStatus).toBe('pending')     // เข้าคิว LINE — ทีมช่างต้องรู้ทันที
  })

  it('ตัดจำหน่ายเป็นชิ้นสุดท้าย → ปิดใบ + แจ้ง Service', () => {
    const d = writeOffJobMaterial(ready(), actor, { requestId: 'r1', qty: 1, reason: 'เศษ' })
    expect(d.jobs[0].terminalStatus).toBe('issued')
    expect(announce(d)).toHaveLength(1)
  })

  it('แก้จำนวนใน PO ตัดบรรทัดสุดท้ายทิ้ง → ปิดใบ + แจ้ง Service', () => {
    const d0 = { ...ready(), accessoryRequests: [req({ id: 'r1', status: 'po_ordered', poId: 'po1', qtyRequested: 5, qtyReceived: 0 })],
      pos: [{ ...poReceived, status: 'issued' as const }] }
    const d = adjustPoLine(d0, actor, { requestId: 'r1', qtyRequested: 0, reason: 'ไม่ได้สั่งจริง' })
    expect(d.jobs[0].terminalStatus).toBe('issued')
    expect(announce(d)).toHaveLength(1)
  })

  it('ยังปิดใบไม่ได้ = ต้องไม่ยิงข้อความปลอก', () => {
    // เหลือวัสดุ 2 หน่วย โอนคืนแค่ 1 → บรรทัดยังไม่จบ ใบยังไม่ปิด
    const d0 = { ...ready(), accessoryRequests: [req({ id: 'r1', status: 'received', poId: 'po1', qtyRequested: 2 })] }
    const d = transferJobMaterialToStock(d0, actor, { requestId: 'r1', qty: 1 })
    expect(d.jobs[0].terminalStatus).toBeNull()
    expect(announce(d)).toHaveLength(0)
  })

  it('🔴 การเบิกต้องไม่ยิงตัวนี้ — ไม่งั้นกลุ่มได้ 2 ใบซ้ำเหมือนก่อน 0063', () => {
    const d = issueJobAccessory(ready(), actor, { jobId: 'j1', requestIds: ['r1'] })
    expect(d.jobs[0].terminalStatus).toBe('issued')       // ปิดใบจริง
    expect(announce(d)).toHaveLength(0)                    // แต่ไม่ยิง job_ready_to_install
    // หาง "ครบทั้งใบแล้ว" ยังอยู่ในข้อความของ action ตัวเองเหมือนเดิม
    expect(d.notifications.some(n => n.type === 'accessory_issued_to_service' && n.message.includes('ครบทั้งใบแล้ว'))).toBe(true)
  })
})

// =============================================================================
// Contract No. รายเครื่อง (0073)
//
// 0014 ตัดข้อมูลลูกค้าออกจาก lbs_units แล้วให้ Job เป็น source of truth เดียว · 0043 คืนมาเป็น
// "ข้อมูลแผน" ⇒ มี 2 สถานะ · 0073 แทรกสถานะกลาง "ตกลงตามสัญญาแล้ว"
//
// กฎที่ต้องไม่หลุด:
//   1) ลำดับความจริง Job > สัญญา > แผน — Job ชนะเสมอ (0014 ไม่เปลี่ยน)
//   2) ผูก Job แล้วเลขสัญญาเป็น Ref. · ถ้า 2 ฝั่งไม่ตรงต้องมีธงให้เห็น ไม่ใช่กลืนเงียบ
//   3) มีเลขสัญญาต้องมี Customer + Location ครบ — **ยกเว้นเครื่องที่ผูก Job แล้ว**
//      (ไม่ยกเว้นจะกรอกเลขสัญญาให้เครื่องที่มี Job ไม่ได้เลย ซึ่งเป็นเคสที่เจอบ่อยสุด)
// =============================================================================
describe('Contract No. รายเครื่อง (0073)', () => {
  const actor = { id: 'u1', email: 'd@x.co', password: '', fullName: 'สมชาย', department: 'sales' as const, isActive: true }
  const base = (over: Partial<DB> = {}) => db({
    users: [actor],
    projectStocks: [{ id: 's1', stockNo: 'ST-1', itemId: 'i-lbs', status: 'open' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }],
    lbsUnits: [unit({ id: 'a', projectStockId: 's1' })],
    ...over,
  })
  const plan = { planCustomerName: 'PEA เชียงใหม่', planInstallLocation: 'สถานีสันทราย' }

  it('ยังไม่มีทั้งสัญญาและ Job = ข้อมูลแผน', () => {
    const d = updateUnitPlan(base(), actor, { unitId: 'a', ...plan })
    expect(unitCustomerInfo(d, d.lbsUnits[0]).source).toBe('plan')
  })

  it('กรอกเลขสัญญาแล้ว = เลิกเป็นแผน', () => {
    const d = updateUnitPlan(base(), actor, { unitId: 'a', contractNo: ' CT-2026-001 ', ...plan })
    expect(d.lbsUnits[0].contractNo).toBe('CT-2026-001')     // trim ให้
    expect(unitCustomerInfo(d, d.lbsUnits[0]).source).toBe('contract')
  })

  it('มีเลขสัญญาแต่ไม่มี Customer/Location = ไม่ให้บันทึก', () => {
    expect(() => updateUnitPlan(base(), actor, { unitId: 'a', contractNo: 'CT-1', planCustomerName: 'PEA' }))
      .toThrow(/Location \/ Site/)
    expect(() => updateUnitPlan(base(), actor, { unitId: 'a', contractNo: 'CT-1', planInstallLocation: 'สถานี' }))
      .toThrow(/Customer/)
  })

  it('ผูก Job แล้ว: Job ชนะ · เลขสัญญาเป็น Ref. · กรอกได้โดยไม่ต้องมีข้อมูลแผน', () => {
    const d0 = base({
      jobs: [job({ customerName: 'EGAT บางปะกง', contactPhone: '02-111-2222', installLocation: 'โรงไฟฟ้าบางปะกง' })],
      lbsUnits: [unit({ id: 'a', projectStockId: 's1', status: 'allocated', jobId: 'j1' })],
    })
    // ไม่ส่งข้อมูลแผนมาเลย แต่กรอกเลขสัญญาได้ — เพราะข้อมูลจริงมาจาก Job
    const d = updateUnitPlan(d0, actor, { unitId: 'a', contractNo: 'CT-2026-009' })
    const info = unitCustomerInfo(d, d.lbsUnits[0])
    expect(info.source).toBe('job')
    expect(info.customer).toBe('EGAT บางปะกง')              // Job ชนะ ไม่ใช่ค่าจากสัญญา
    expect(info.location).toBe('โรงไฟฟ้าบางปะกง')
    expect(d.lbsUnits[0].contractNo).toBe('CT-2026-009')     // เลขสัญญายังอยู่เป็น Ref.
  })

  it('ผูก Job แล้วข้อมูลฝั่งสัญญาไม่ตรงกับ Job → ขึ้นธงเตือน (ไม่บล็อก)', () => {
    const d = base({
      jobs: [job({ customerName: 'EGAT บางปะกง', installLocation: 'โรงไฟฟ้าบางปะกง' })],
      lbsUnits: [unit({
        id: 'a', projectStockId: 's1', status: 'allocated', jobId: 'j1',
        contractNo: 'CT-9', planCustomerName: 'PEA เชียงใหม่', planInstallLocation: 'โรงไฟฟ้าบางปะกง',
      })],
    })
    const info = unitCustomerInfo(d, d.lbsUnits[0])
    expect(info.mismatch).toEqual(['Customer'])              // สถานที่ตรง จึงไม่ติดธง
    expect(info.customer).toBe('EGAT บางปะกง')               // ระบบยังใช้ค่าจาก Job
  })

  it('ไม่มีเลขสัญญา = ไม่เทียบ ไม่ขึ้นธง แม้ข้อมูลแผนจะต่างจาก Job', () => {
    const d = base({
      jobs: [job({ customerName: 'EGAT', installLocation: 'บางปะกง' })],
      lbsUnits: [unit({ id: 'a', projectStockId: 's1', status: 'allocated', jobId: 'j1', planCustomerName: 'PEA' })],
    })
    expect(unitCustomerInfo(d, d.lbsUnits[0]).mismatch).toEqual([])
  })

  it('Import Excel: เลขสัญญาเขียนได้แม้เครื่องผูก Job แล้ว (ต่างจาก Customer/Location ที่ถูกข้าม)', () => {
    const d0 = base({
      jobs: [job({ customerName: 'EGAT', installLocation: 'บางปะกง' })],
      lbsUnits: [unit({ id: 'a', serialLvb: 'LVB-1', serialOm: 'OM-1', projectStockId: 's1', status: 'allocated', jobId: 'j1' })],
    })
    const d = importUnitsToStock(d0, actor, {
      stockId: 's1', newUnits: [],
      updateUnits: [{ lvb: 'LVB-1', om: 'OM-1', contractNo: 'CT-777', customer: 'ลูกค้าอื่น' }],
    })
    expect(d.lbsUnits[0].contractNo).toBe('CT-777')          // เลขสัญญาเข้า
    expect(d.lbsUnits[0].planCustomerName).toBeUndefined()   // ช่องของ Job ถูกข้ามตาม 0014
  })

  it('Import Excel: เครื่องใหม่ที่มีเลขสัญญาแต่ข้อมูลไม่ครบ = ไม่ให้เข้า', () => {
    expect(() => importUnitsToStock(base(), actor, {
      stockId: 's1', newUnits: [{ lvb: 'LVB-9', om: 'OM-9', contractNo: 'CT-1', customer: 'PEA' }],
      updateUnits: [],
    })).toThrow(/Contract No./)
  })
})

// =============================================================================
// เอกสารแนบรายเครื่อง (0074)
//
// กฎที่ต้องไม่หลุด:
//   1) รับเฉพาะ PDF + รูปภาพ · ไม่เกินเพดาน — <input accept> เป็นแค่ตัวกรองหน้าต่างเลือกไฟล์
//      ลากไฟล์ใส่/ยิง RPC ตรงก็ผ่าน ⇒ กติกาตัวจริงต้องอยู่ที่นี่ (+ CHECK ฝั่ง DB)
//   2) **ไม่บล็อกเครื่องที่เบิกไปแล้ว** ต่างจาก updateUnitPlan — ใบส่งของ/รูปตอนส่งมอบ
//      มาถึงหลังของออกจากคลังเสมอ
// =============================================================================
describe('เอกสารแนบรายเครื่อง (0074)', () => {
  const actor = { id: 'u1', email: 'd@x.co', password: '', fullName: 'สมชาย', department: 'sales' as const, isActive: true }
  const base = (over: Partial<DB> = {}) => db({
    users: [actor],
    projectStocks: [{ id: 's1', stockNo: 'ST-1', itemId: 'i-lbs', status: 'open' as const, createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }],
    lbsUnits: [unit({ id: 'a', projectStockId: 's1' })],
    ...over,
  })
  const file = (over: Partial<Parameters<typeof addUnitFile>[2]> = {}) => ({
    unitId: 'a', fileName: 'contract.pdf', filePath: 'unit/a/x.pdf',
    mimeType: 'application/pdf', sizeBytes: 500_000, ...over,
  })

  it('แนบ PDF/รูป ได้หลายไฟล์ · เรียงใหม่สุดก่อน', () => {
    let d = addUnitFile(base(), actor, file())
    d = addUnitFile(d, actor, file({ fileName: 'photo.jpg', mimeType: 'image/jpeg', filePath: 'unit/a/y.jpg' }))
    expect(unitFiles(d, 'a')).toHaveLength(2)
    expect(unitFileCount(d, 'a')).toBe(2)
    expect(unitFiles(d, 'a')[0].fileName).toBe('photo.jpg')     // ใหม่สุดขึ้นก่อน
  })

  it('ชนิดไฟล์อื่นไม่รับ', () => {
    for (const mt of ['application/zip', 'text/html', 'application/x-msdownload', ''])
      expect(() => addUnitFile(base(), actor, file({ mimeType: mt }))).toThrow(/PDF และรูปภาพ/)
  })

  it('ไฟล์ใหญ่เกินเพดาน / ไฟล์ว่าง ไม่รับ', () => {
    expect(() => addUnitFile(base(), actor, file({ sizeBytes: MAX_DOC_FILE_MB * 1024 * 1024 + 1 })))
      .toThrow(/ใหญ่เกิน/)
    expect(() => addUnitFile(base(), actor, file({ sizeBytes: 0 }))).toThrow(/ไฟล์ว่าง/)
  })

  it('อัปโหลดไม่สำเร็จ (ไม่ได้ path กลับมา) ต้องไม่ลงแถวค้างไว้', () => {
    expect(() => addUnitFile(base(), actor, file({ filePath: '  ' }))).toThrow(/ที่อยู่ไฟล์/)
  })

  it('🔴 เครื่องที่เบิกให้ Service ไปแล้วยังแนบเอกสารได้ (ใบส่งของมาทีหลังเสมอ)', () => {
    const d0 = base({ lbsUnits: [unit({ id: 'a', projectStockId: 's1', status: 'issued', jobId: 'j1' })] })
    const d = addUnitFile(d0, actor, file({ fileName: 'delivery-note.pdf' }))
    expect(unitFileCount(d, 'a')).toBe(1)
  })

  it('ลบเอกสารได้ + ลง audit', () => {
    const d0 = addUnitFile(base(), actor, file())
    const d = deleteUnitFile(d0, actor, { fileId: d0.lbsUnitFiles[0].id })
    expect(unitFileCount(d, 'a')).toBe(0)
    expect(d.auditLogs.some(a => a.action === 'delete_unit_file')).toBe(true)
  })

  it('เพดานโหมด demo ต้องต่ำกว่า LIVE (localStorage มีโควตาจำกัด)', () => {
    expect(DEMO_MAX_DOC_FILE_MB).toBeLessThan(MAX_DOC_FILE_MB)
    expect(isAllowedDocFile('IMAGE/PNG')).toBe(true)            // ไม่แคร์ตัวพิมพ์
    expect(isAllowedDocFile('application/pdf')).toBe(true)
  })
})

// =============================================================================
// สถานะกำหนดส่ง + ขยายกำหนดส่ง (0075)
//
// 🔴 บั๊กต้นเรื่อง: Dashboard ขึ้น "เลยกำหนด" (แดง) กับงานที่ช่างกำลังติดตั้งอยู่หน้างาน
//    เพราะทุกหน้าตัดสินด้วย daysLeft < 0 อย่างเดียว · เทสต์ชุดนี้ล็อกไว้ว่า
//    "เลยกำหนดจริง" (overdue) ต้องเกิดเฉพาะตอนที่ของ **ยังไม่ออกจากคลัง** เท่านั้น
// =============================================================================
describe('สถานะกำหนดส่ง (0075)', () => {
  const actor = { id: 'u1', email: 'p@x.co', password: '', fullName: 'โปรเจกต์', department: 'project' as const, isActive: true }
  const TODAY = '2026-09-17'
  const PAST = '2026-08-01'          // เลยมาแล้ว 47 วัน
  const SOON = '2026-10-01'          // เหลือ 14 วัน (≤ 30)
  const FAR = '2027-01-01'

  // งานที่ "ของออกไปอยู่กับช่างแล้ว" = มี unit status issued อย่างน้อย 1 เครื่อง
  // visit = ช่วงนัดติดตั้ง (installStartDate–EndDate) — นาฬิกาคนละเรือนกับกำหนดส่ง
  const inFieldDb = (due: string, over: Partial<DB> = {}, visit?: { start: string; end?: string }) => db({
    users: [actor],
    jobs: [job({
      requiredDate: due, openedBy: 'u1',
      installStartDate: visit?.start, installEndDate: visit?.end ?? visit?.start,
    })],
    lbsUnits: [
      unit({ id: 'a', status: 'issued', jobId: 'j1' }),
      unit({ id: 'b', serialLvb: 'LVB-002', serialOm: 'OM-002', status: 'issued', jobId: 'j1' }),
    ],
    ...over,
  })
  const notStartedDb = (due: string) => db({
    users: [actor],
    jobs: [job({ requiredDate: due, openedBy: 'u1' })],
    lbsUnits: [unit({ id: 'a', status: 'allocated', jobId: 'j1' })],
  })
  const d1 = (d: DB) => jobDelivery(d, d.jobs[0], TODAY)

  // 🔴🔴 2 เคสนี้คือบั๊กที่ผู้ใช้จับได้จากของจริง (2026-09-17) — ห้ามถอย
  it('🔴 เบิกของออกจากคลังแล้วแต่ยังไม่ถึงวันนัด = awaiting_visit ห้ามขึ้นว่า "กำลังติดตั้ง"', () => {
    // ของจริง: 102LB20J3189 นัดติดตั้ง 25 ก.ย. แต่วันนี้ 17 ก.ย. — ไม่มีใครไปไซต์เลย
    const d = d1(inFieldDb(FAR, {}, { start: '2026-09-25' }))
    expect(d.state).toBe('awaiting_visit')
    expect(d.label).toContain('รอถึงวันนัด')
    expect(d.label).not.toContain('กำลังติดตั้ง')
    expect(d.atRisk).toBe(false)
  })

  it('🔴 อยู่ในช่วงนัดติดตั้งแต่เลยกำหนดส่ง = installing + คำนำหน้า "เลยกำหนดส่ง N วัน" (ห้ามใช้คำว่า "เลยแผน")', () => {
    // ของจริง: 102LB10J3076 กำหนดส่ง 15 ก.ย. · นัดติดตั้ง 14–18 ก.ย. · วันนี้ 17 ก.ย.
    //   = เลยกำหนดส่ง 2 วันจริง แต่ทีมอยู่หน้างานตามนัด ⇒ ส้ม ไม่ใช่แดง และต้องไม่เขียนว่า "เลยแผน"
    const d = d1(inFieldDb('2026-09-15', {}, { start: '2026-09-14', end: '2026-09-18' }))
    expect(d.state).toBe('installing')
    expect(d.tone).toBe('amber')
    expect(d.isLate).toBe(true)
    expect(d.daysLate).toBe(2)
    expect(d.label).toContain('เลยกำหนดส่ง 2 วัน')
    expect(d.label).not.toContain('เลยแผน')
    expect(d.atRisk).toBe(false)               // งานเดินอยู่ — ไม่ใช่ใบที่ต้องเร่ง
  })

  it('อยู่ในช่วงนัดและยังไม่เลยกำหนดส่ง = installing (เขียว) ไม่มีคำนำหน้า', () => {
    const d = d1(inFieldDb(FAR, {}, { start: '2026-09-14', end: '2026-09-18' }))
    expect(d.state).toBe('installing')
    expect(d.tone).toBe('green')
    expect(d.isLate).toBe(false)
    expect(d.label).not.toContain('เลยกำหนดส่ง')
  })

  it('🔴 เลยวันนัดติดตั้งแล้วยังไม่มีผลยืนยัน = visit_overdue + ต้องเร่ง (ถึงกำหนดส่งยังไม่ถึงก็ตาม)', () => {
    const d = d1(inFieldDb(FAR, {}, { start: '2026-09-10', end: '2026-09-12' }))
    expect(d.state).toBe('visit_overdue')
    expect(d.atRisk).toBe(true)                // มีคนต้องตอบว่าเกิดอะไรขึ้นหน้างาน
    expect(d.tone).toBe('amber')               // ยังไม่เลยกำหนดส่ง → ส้ม
    expect(d.label).toContain('เลยวันนัดติดตั้ง 5 วัน')
    // เลยทั้งวันนัดและกำหนดส่ง = แดง
    expect(d1(inFieldDb(PAST, {}, { start: '2026-09-10', end: '2026-09-12' })).tone).toBe('red')
  })

  it('เบิกของแล้วแต่ยังไม่ได้นัดวันติดตั้ง = awaiting_visit + บอกให้ Service ไปนัด', () => {
    const d = d1(inFieldDb(FAR))
    expect(d.state).toBe('awaiting_visit')
    expect(d.label).toContain('ยังไม่ได้นัด')
    expect(d.nextStep).toContain('ระบุวันนัดติดตั้ง')
  })

  it('เริ่มยืนยันรายเครื่องก่อนถึงวันนัด = installing (ของจริงชนะวันนัดบนกระดาษ)', () => {
    const d = d1(inFieldDb(FAR, {
      unitInstallations: [{
        id: 'ui1', unitId: 'a', jobId: 'j1', outcome: 'installed', installedDate: '2026-09-16',
        performedBy: 'u1', performedAt: '2026-09-16T00:00:00.000Z',
      }],
    }, { start: '2026-09-25' }))
    expect(d.state).toBe('installing')
  })

  it('🔴 เลยกำหนดส่งและของยังไม่ออกจากคลัง = overdue (แดง) + บอกว่าใครค้าง', () => {
    const d = d1(notStartedDb(PAST))
    expect(d.state).toBe('overdue')
    expect(d.tone).toBe('red')
    expect(d.atRisk).toBe(true)
    expect(d.nextStep).toMatch(/LBS|PR|จัดซื้อ|เบิก/)
  })

  it('ใกล้กำหนด ≤30 วัน = due_soon · ไกลกว่านั้น = on_track · ไม่ระบุวัน = no_due', () => {
    expect(d1(notStartedDb(SOON)).state).toBe('due_soon')
    expect(d1(notStartedDb(FAR)).state).toBe('on_track')
    expect(d1(notStartedDb('')).state).toBe('no_due')
  })

  it('มีเครื่องติดตั้งไม่ได้ = blocked (แดง) มาก่อนเรื่องวันที่เสมอ', () => {
    const base = inFieldDb(FAR, {
      unitInstallations: [{
        id: 'ui1', unitId: 'a', jobId: 'j1', outcome: 'blocked', reason: 'ยังไม่เดินสายเมน',
        performedBy: 'u1', performedAt: '2026-09-10T00:00:00.000Z',
      }],
    })
    const d = d1(base)
    expect(d.state).toBe('blocked')
    expect(d.atRisk).toBe(true)                // ยังไม่เลยกำหนดด้วยซ้ำ แต่ต้องมีคนเข้าไปแก้
  })

  it('ทุกเครื่องได้ข้อสรุปแล้ว = awaiting_close (ฟ้า) ไม่ใช่แดง แม้เลยกำหนด', () => {
    const base = inFieldDb(PAST, {
      unitInstallations: [
        { id: 'ui1', unitId: 'a', jobId: 'j1', outcome: 'installed', installedDate: '2026-09-15', performedBy: 'u1', performedAt: '2026-09-15T00:00:00.000Z' },
        { id: 'ui2', unitId: 'b', jobId: 'j1', outcome: 'installed', installedDate: '2026-09-16', performedBy: 'u1', performedAt: '2026-09-16T00:00:00.000Z' },
      ],
    })
    const d = d1(base)
    expect(d.state).toBe('awaiting_close')
    expect(d.tone).toBe('blue')
    expect(d.atRisk).toBe(false)
  })

  it('งานที่ปิด/ยกเลิกแล้วไม่เตือนอะไรอีก', () => {
    for (const t of ['installed', 'cancelled'] as const) {
      const d = db({ users: [actor], jobs: [job({ requiredDate: PAST, terminalStatus: t })] })
      expect(jobDelivery(d, d.jobs[0], TODAY).state).toBe('closed')
      expect(jobDelivery(d, d.jobs[0], TODAY).atRisk).toBe(false)
    }
  })

  it('🔴 ขยายกำหนดส่งแล้วนับจากวันใหม่ — แต่ requiredDate เดิมต้องไม่ถูกแก้', () => {
    const d0 = notStartedDb(PAST)
    expect(d1(d0).state).toBe('overdue')
    const d = extendJobDue(d0, actor, { jobId: 'j1', newDueDate: FAR, reason: 'ลูกค้าขอเลื่อนดับไฟ' })
    expect(d.jobs[0].requiredDate).toBe(PAST)          // กำหนดตามสัญญาไม่หาย
    expect(jobEffectiveDue(d, d.jobs[0])).toBe(FAR)
    const dd = jobDelivery(d, d.jobs[0], TODAY)
    expect(dd.state).toBe('on_track')
    expect(dd.contractDue).toBe(PAST)
    expect(dd.extensionCount).toBe(1)
  })

  it('เลื่อนต้องมีเหตุผล · เลื่อนเป็นวันเดิมไม่ได้ · เก็บเป็นประวัติทุกครั้ง', () => {
    const d0 = notStartedDb(PAST)
    expect(() => extendJobDue(d0, actor, { jobId: 'j1', newDueDate: FAR, reason: '  ' })).toThrow(/เหตุผล/)
    expect(() => extendJobDue(d0, actor, { jobId: 'j1', newDueDate: PAST, reason: 'x' })).toThrow(/ตรงกับกำหนดเดิม/)
    let d = extendJobDue(d0, actor, { jobId: 'j1', newDueDate: SOON, reason: 'รอบที่ 1' })
    d = extendJobDue(d, actor, { jobId: 'j1', newDueDate: FAR, reason: 'รอบที่ 2' })
    expect(jobDueExtensions(d, 'j1')).toHaveLength(2)
    expect(jobDueExtensions(d, 'j1')[0].reason).toBe('รอบที่ 2')    // ใหม่สุดก่อน = ตัวที่มีผล
    expect(jobDueExtensions(d, 'j1')[0].prevDueDate).toBe(SOON)     // ต่อจากรอบที่ 1 ไม่ใช่จากสัญญา
    expect(jobEffectiveDue(d, d.jobs[0])).toBe(FAR)
  })

  it('ยกเลิกการเลื่อนได้เฉพาะครั้งล่าสุด (ประวัติก่อนหน้าเป็นหลักฐาน)', () => {
    let d = extendJobDue(notStartedDb(PAST), actor, { jobId: 'j1', newDueDate: SOON, reason: 'รอบที่ 1' })
    const first = d.jobDueExtensions[0].id
    d = extendJobDue(d, actor, { jobId: 'j1', newDueDate: FAR, reason: 'รอบที่ 2' })
    expect(() => deleteJobDueExtension(d, actor, { extensionId: first })).toThrow(/ล่าสุด/)
    const d2 = deleteJobDueExtension(d, actor, { extensionId: d.jobDueExtensions[1].id })
    expect(jobEffectiveDue(d2, d2.jobs[0])).toBe(SOON)              // กลับไปใช้รอบที่ 1
  })

  it('งานที่ปิด/ยกเลิกแล้วเลื่อนกำหนดส่งไม่ได้', () => {
    for (const t of ['installed', 'cancelled'] as const) {
      const d = db({ users: [actor], jobs: [job({ requiredDate: PAST, terminalStatus: t, openedBy: 'u1' })] })
      expect(() => extendJobDue(d, actor, { jobId: 'j1', newDueDate: FAR, reason: 'x' })).toThrow()
    }
  })

  it('Project ที่ไม่ใช่เจ้าของงานเลื่อนกำหนดส่งไม่ได้ (0042)', () => {
    const other = { ...actor, id: 'u9' }
    expect(() => extendJobDue(notStartedDb(PAST), other, { jobId: 'j1', newDueDate: FAR, reason: 'x' }))
      .toThrow(/ไม่ใช่งานที่คุณเปิด/)
  })

  it('การเลื่อนกำหนดส่งต้องไม่กินโควตา LINE (แจ้งในระบบอย่างเดียว)', () => {
    const d = extendJobDue(notStartedDb(PAST), actor, { jobId: 'j1', newDueDate: FAR, reason: 'x' })
    const n = d.notifications.find(x => x.type === 'job_due_extended')
    expect(n).toBeTruthy()
    expect(LINE_PUSH_TYPES.has('job_due_extended')).toBe(false)
    expect(n!.lineStatus).toBe('off')
  })
})

// =============================================================================
// เอกสารแนบรายงวดเงิน (0076)
// =============================================================================
describe('เอกสารแนบรายงวดเงิน (0076)', () => {
  const actor = { id: 'u1', email: 'p@x.co', password: '', fullName: 'โปรเจกต์', department: 'project' as const, isActive: true }
  const withPayment = (over: Partial<Job> = {}) => {
    const d0 = db({ users: [actor], jobs: [job({ openedBy: 'u1', budgetSalePrice: 1_000_000, ...over })] })
    const d = addJobPayment(d0, actor, { jobId: 'j1', payType: 'advance', percent: 15, invoiceNo: 'INV-001' })
    return { d, paymentId: d.jobPayments[0].id }
  }
  const f = (paymentId: string, over: Partial<Parameters<typeof addPaymentFile>[2]> = {}) => ({
    paymentId, fileName: 'invoice.pdf', filePath: `payment/${paymentId}/x.pdf`,
    mimeType: 'application/pdf', sizeBytes: 300_000, ...over,
  })

  it('แนบได้หลายไฟล์ต่องวด · ใหม่สุดขึ้นก่อน · นับต่องวดถูกต้อง', () => {
    const { d: d0, paymentId } = withPayment()
    let d = addPaymentFile(d0, actor, f(paymentId))
    d = addPaymentFile(d, actor, f(paymentId, { fileName: 'receipt.jpg', mimeType: 'image/jpeg' }))
    expect(paymentFileCount(d, paymentId)).toBe(2)
    expect(paymentFiles(d, paymentId)[0].fileName).toBe('receipt.jpg')
  })

  it('กติกาชนิด/ขนาดไฟล์ชุดเดียวกับเอกสารรายเครื่อง', () => {
    const { d, paymentId } = withPayment()
    expect(() => addPaymentFile(d, actor, f(paymentId, { mimeType: 'application/zip' }))).toThrow(/PDF และรูปภาพ/)
    expect(() => addPaymentFile(d, actor, f(paymentId, { sizeBytes: MAX_DOC_FILE_MB * 1024 * 1024 + 1 }))).toThrow(/ใหญ่เกิน/)
    expect(() => addPaymentFile(d, actor, f(paymentId, { sizeBytes: 0 }))).toThrow(/ไฟล์ว่าง/)
    expect(() => addPaymentFile(d, actor, f(paymentId, { filePath: ' ' }))).toThrow(/ที่อยู่ไฟล์/)
  })

  it('🔴 ปิดงานติดตั้งแล้วยังแนบได้ (PAC/Retention มาหลังปิดงานเสมอ) · ยกเลิกแล้วแนบไม่ได้', () => {
    const { d, paymentId } = withPayment({ terminalStatus: 'installed' })
    expect(paymentFileCount(addPaymentFile(d, actor, f(paymentId)), paymentId)).toBe(1)

    const cancelled = { ...d, jobs: [{ ...d.jobs[0], terminalStatus: 'cancelled' as const }] }
    expect(() => addPaymentFile(cancelled, actor, f(paymentId))).toThrow(/ยกเลิก/)
  })

  it('ลบงวดเงินแล้วเอกสารแนบของงวดนั้นหายตาม (CASCADE)', () => {
    const { d: d0, paymentId } = withPayment()
    const d1 = addPaymentFile(d0, actor, f(paymentId))
    const d2 = deleteJobPayment(d1, actor, { paymentId })
    expect(d2.jobPayments).toHaveLength(0)
    expect(d2.jobPaymentFiles).toHaveLength(0)
    expect(d2.auditLogs.some(a => a.action === 'delete_job_payment' && /เอกสารแนบ 1 ไฟล์/.test(a.detail))).toBe(true)
  })

  it('ลบเอกสารทีละไฟล์ได้ + ลง audit', () => {
    const { d: d0, paymentId } = withPayment()
    const d1 = addPaymentFile(d0, actor, f(paymentId))
    const d2 = deletePaymentFile(d1, actor, { fileId: d1.jobPaymentFiles[0].id })
    expect(paymentFileCount(d2, paymentId)).toBe(0)
    expect(d2.auditLogs.some(a => a.action === 'delete_payment_file')).toBe(true)
  })

  it('Project ที่ไม่ใช่เจ้าของงานแนบเอกสารไม่ได้ (0042)', () => {
    const { d, paymentId } = withPayment()
    expect(() => addPaymentFile(d, { ...actor, id: 'u9' }, f(paymentId))).toThrow(/ไม่ใช่งานที่คุณเปิด/)
  })
})
