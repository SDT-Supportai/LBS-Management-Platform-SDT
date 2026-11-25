// =============================================================================
// เฟส 2 (2026-11-23) — ตารางแผนก × สถานะ + ขั้นต่อไป + ด่านปุ่ม (src/data/flow.ts)
//
// ไฟล์ docs/dept-status-matrix.md สร้างจากเทสต์นี้ (toMatchFileSnapshot) — ใครแก้กติกาแล้วตารางเปลี่ยน
// เทสต์จะแดงจนกว่าจะอัปเดตเอกสารด้วย `vitest -u` (= ต้องตั้งใจเปลี่ยน และเห็นใน diff ของ commit)
// =============================================================================
import { describe, it, expect } from 'vitest'
import type { DB, Job, LbsUnit, User, AccessoryRequest, ApprovalRequest, UnitInstallation, Department } from '../types'
import {
  jobActions, jobAction, jobNextStep, isMyTurn, pendingApprovals, pendingGate, permGate, jobCloseReason, deptNames,
  JOB_ACTION_ORDER, myWork, approvalFacts, bkkDate, jobListMatches, prsAwaitingPo, posAwaitingGoods, prStatusLabel,
  pendingReceipts, purchasingCounts, stockPanelOpen, type JobActionKey,
} from './flow'
import { jobDelivery, jobInstallSummary, jobStatusPhase, memberSchedule, jobCancelBlockReason } from './logic'
import { unassignedJobs } from './field'

const TODAY = '2026-11-23'
const T = '2026-11-01T03:00:00.000Z'

const EMPTY: DB = {
  users: [], publicShareLinks: [],
  items: [], projectStocks: [], lbsUnits: [], lbsUnitFiles: [], jobs: [], allocations: [],
  accessoryStock: [], accessoryRequests: [], prs: [], pos: [], approvalRequests: [], approvalComments: [],
  auditLogs: [], notifications: [], siteVisits: [], unitInstallations: [],
  teamMembers: [], jobAssignments: [], stockMovements: [], jobPayments: [],
  jobPaymentFiles: [], jobDueExtensions: [], jobWarranties: [], jobCloseoutFiles: [], stockReturns: [],
  stdDrawings: [], stdPrices: [], stdBoms: [], stdBomLines: [],
  serviceLetters: [], serviceLetterFiles: [], letterSigners: [],
}
const U = (id: string, department: Department, fullName: string): User =>
  ({ id, email: `${id}@x.co`, password: '', fullName, department, isActive: true })
const USERS = {
  division: U('u-sales', 'sales', 'สมชาย Division'),
  owner: U('u-p', 'project', 'วิชัย เจ้าของงาน'),
  other: U('u-p2', 'project', 'สุดา Project อื่น'),
  purchasing: U('u-pur', 'purchasing', 'มาลี Purchasing'),
  service: U('u-svc', 'service', 'ประสิทธิ์ Service'),
  manage: U('u-adm', 'admin', 'Manage'),
  vip: U('u-vip', 'vip', 'VIP'),
}
const COLS: [keyof typeof USERS, string][] = [
  ['division', 'Division'], ['owner', 'Project (เจ้าของ)'], ['other', 'Project (คนอื่น)'],
  ['purchasing', 'Purchasing'], ['service', 'Service'], ['manage', 'Manage'], ['vip', 'VIP'],
]

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', jobNo: 'J-001', customerName: 'กฟภ.', scope: 'ติดตั้ง LBS', installLocation: 'สถานี A',
  requiredDate: '2026-12-31', lbsQtyRequired: 2, terminalStatus: null, openedBy: 'u-p', createdAt: T, ...over,
})
const unit = (id: string, over: Partial<LbsUnit> = {}): LbsUnit => ({
  id, serialLvb: `LVB-${id}`, serialOm: `OM-${id}`, projectStockId: 's1', status: 'allocated', jobId: 'j1', ...over,
})
const acc = (id: string, over: Partial<AccessoryRequest> = {}): AccessoryRequest => ({
  id, jobId: 'j1', itemId: 'i1', qtyRequested: 1, qtyReceived: 0, source: 'purchasing', status: 'pending', prId: null,
  requestedBy: 'u-p', createdAt: T, ...over,
})
const appr = (type: ApprovalRequest['type'], over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: `ap-${type}`, type, jobId: 'j1', payload: {}, status: 'pending', requestedBy: 'u-p', requestedAt: T, ...over,
})
const inst = (unitId: string, outcome: UnitInstallation['outcome'], over: Partial<UnitInstallation> = {}): UnitInstallation => ({
  id: `in-${unitId}-${outcome}`, unitId, jobId: 'j1', outcome, performedBy: 'u-svc', performedAt: T,
  ...(outcome === 'installed' ? { installedDate: '2026-11-01' } : { reason: 'เสาไม่พร้อม' }), ...over,
})
const db = (over: Partial<DB>): DB => ({ ...EMPTY, users: Object.values(USERS), ...over })

// ---------- สถานการณ์ของงาน 1 ใบ ตลอดเส้นทาง ----------
/** เครื่องว่างในคลังที่มี Contract No. แล้ว (ดึงเข้า Job ได้ — 0084) */
const spare = unit('s', { status: 'in_stock', jobId: null, contractNo: 'C-1' })
const fieldJob = { terminalStatus: 'issued' as const, issuedAt: T, installStartDate: '2026-11-20', installEndDate: '2026-11-30' }
const SCENARIOS: { key: string; name: string; db: DB }[] = [
  { key: 'draft', name: 'Draft — ยังไม่ดึง LBS', db: db({ jobs: [job()], lbsUnits: [spare] }) },
  { key: 'draft_no_contract', name: 'Draft — ในคลังไม่มีเครื่องที่มี Contract No.', db: db({
    jobs: [job()], lbsUnits: [unit('x', { status: 'in_stock', jobId: null })],
  }) },
  { key: 'allocated', name: 'ดึง LBS แล้ว 1/2 เครื่อง', db: db({
    jobs: [job()], lbsUnits: [unit('a'), spare], allocations: [{ id: 'al', jobId: 'j1', projectStockId: 's1', txnType: 'draw', serialNos: ['LVB-a'], performedBy: 'u-p', performedAt: T }],
  }) },
  { key: 'procuring', name: 'LBS ครบ · วัสดุยังไม่ออก PR', db: db({
    jobs: [job()], lbsUnits: [unit('a'), unit('b'), unit('x', { status: 'in_stock', jobId: null })], accessoryRequests: [acc('r1')],
  }) },
  { key: 'ready', name: 'ของครบ พร้อมเบิก', db: db({
    jobs: [job()], lbsUnits: [unit('a'), unit('b'), unit('x', { status: 'in_stock', jobId: null })],
  }) },
  { key: 'ready_cancel_pending', name: 'พร้อมเบิก · มีคำขอยกเลิก Job รอพิจารณา', db: db({
    jobs: [job()], lbsUnits: [unit('a'), unit('b')], approvalRequests: [appr('cancel_job')],
  }) },
  { key: 'installing', name: 'เบิกครบ · ช่างกำลังติดตั้ง (1/2)', db: db({
    jobs: [job(fieldJob)], lbsUnits: [unit('a', { status: 'issued' }), unit('b', { status: 'issued' })],
    unitInstallations: [inst('a', 'installed')],
  }) },
  { key: 'awaiting_close', name: 'ติดตั้งครบ รอปิดงาน', db: db({
    jobs: [job(fieldJob)], lbsUnits: [unit('a', { status: 'issued' }), unit('b', { status: 'issued' })],
    unitInstallations: [inst('a', 'installed'), inst('b', 'installed')],
  }) },
  { key: 'blocked', name: 'ติดตั้งได้ 1 · ติดตั้งไม่ได้ 1', db: db({
    jobs: [job(fieldJob)], lbsUnits: [unit('a', { status: 'issued' }), unit('b', { status: 'issued' })],
    unitInstallations: [inst('a', 'installed'), inst('b', 'blocked')],
  }) },
  { key: 'closed_warranty', name: 'ปิดงานแล้ว · เริ่มนับประกัน', db: db({
    jobs: [job({ ...fieldJob, terminalStatus: 'installed', installedAt: T })],
    lbsUnits: [unit('a', { status: 'issued' }), unit('b', { status: 'issued' })],
    unitInstallations: [inst('a', 'installed'), inst('b', 'installed')],
    jobWarranties: [{ id: 'w', jobId: 'j1', kind: 'installation', startDate: '2026-01-01', endDate: '2027-01-01', createdAt: T }],
  }) },
  { key: 'closed_no_warranty', name: 'ปิดงานแล้ว · ยังไม่เริ่มประกัน', db: db({
    jobs: [job({ ...fieldJob, terminalStatus: 'installed', installedAt: T })],
    lbsUnits: [unit('a', { status: 'issued' }), unit('b', { status: 'issued' })],
    unitInstallations: [inst('a', 'installed'), inst('b', 'installed')],
  }) },
  { key: 'cancelled', name: 'ยกเลิกแล้ว', db: db({ jobs: [job({ terminalStatus: 'cancelled', cancelledAt: T })] }) },
]
const sc = (key: string) => SCENARIOS.find(s => s.key === key)!
const J = (d: DB) => d.jobs[0]
const gateOf = (key: string, who: keyof typeof USERS, action: JobActionKey) =>
  jobAction(sc(key).db, J(sc(key).db), USERS[who], action, TODAY).gate

// =============================================================================
describe('ตารางแผนก × สถานะ (เอกสาร docs/dept-status-matrix.md)', () => {
  it('ตรงกับเอกสารที่ commit ไว้', async () => {
    const out: string[] = [
      '# ตารางแผนก × สถานะ — คำสั่งบนหน้า Job',
      '',
      '> สร้างอัตโนมัติจาก `src/data/flow.test.ts` (เฟส 2, 2026-11-23) — **ห้ามแก้มือ** · กติกาอยู่ที่ `src/data/flow.ts`',
      '> ✅ กดได้ · 🔒 กดไม่ได้ (เหตุผลอยู่ใต้ตาราง) · — ไม่ใช่หน้าที่ของแผนกนี้ (ปุ่มบอก "สำหรับ …")',
      '',
    ]
    for (const s of SCENARIOS) {
      const actions = (who: keyof typeof USERS) => jobActions(s.db, J(s.db), USERS[who], TODAY)
      const step = jobNextStep(s.db, J(s.db), TODAY)
      out.push(`## ${s.name}`, '', `ขั้นต่อไป: **${step.title}** · ใครทำ: ${deptNames(step.who) || '-'}`, '')
      out.push(`| คำสั่ง | ${COLS.map(c => c[1]).join(' | ')} |`, `|---|${COLS.map(() => ':-:').join('|')}|`)
      const reasons = new Map<string, string>()
      for (const k of JOB_ACTION_ORDER) {
        const cells = COLS.map(([who]) => {
          const g = actions(who).find(a => a.key === k)!.gate
          if (g.ok) return '✅'
          if (g.who) return '—'
          if (who === 'owner') reasons.set(k, g.reason)
          return '🔒'
        })
        const label = actions('owner').find(a => a.key === k)!.label
        out.push(`| ${label} | ${cells.join(' | ')} |`)
      }
      if (reasons.size) {
        out.push('', 'เหตุผลที่เจ้าของงานกดไม่ได้:')
        for (const [k, r] of reasons) out.push(`- ${actions('owner').find(a => a.key === k)!.label}: ${r}`)
      }
      out.push('')
    }
    await expect(out.join('\n')).toMatchFileSnapshot('../../docs/dept-status-matrix.md')
  })
})

// =============================================================================
describe('ด่านปุ่ม — ปุ่มไม่หายเงียบ ต้องบอกเหตุผล', () => {
  it('แผนกที่ไม่มีสิทธิ์ ได้เหตุผล "สำหรับ …" พร้อมรายชื่อแผนกที่ทำได้ (ไม่รวม Manage)', () => {
    const g = gateOf('draft', 'purchasing', 'draw_lbs')
    expect(g).toEqual({ ok: false, reason: 'สำหรับ Project', who: ['project'] })
    const c = gateOf('awaiting_close', 'division', 'close_install')
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toBe('สำหรับ Service / Project')
  })

  it('VIP และ Division กดคำสั่งหน้า Job ไม่ได้เลยทุกสถานะ (ดู/ให้ความเห็น/อนุมัติ อยู่หน้าอื่น)', () => {
    for (const s of SCENARIOS) for (const who of ['vip', 'division'] as const) {
      const open = jobActions(s.db, J(s.db), USERS[who], TODAY).filter(a => a.gate.ok).map(a => a.key)
      expect(open, `${s.key} · ${who}`).toEqual([])
    }
  })

  it('Project คนอื่น: ทุกปุ่มบอกชื่อเจ้าของงาน (0042) ไม่ใช่ "ไม่มีสิทธิ์" เฉย ๆ', () => {
    const g = gateOf('ready', 'other', 'issue')
    expect(g).toEqual({ ok: false, reason: 'เฉพาะเจ้าของงาน (วิชัย เจ้าของงาน) หรือ Manage' })
  })

  it('Draft: ดึง LBS ได้ · ลบ Draft ได้ · เบิกไม่ได้เพราะยังไม่ครบ Scope', () => {
    expect(gateOf('draft', 'owner', 'draw_lbs').ok).toBe(true)
    expect(gateOf('draft', 'owner', 'delete_draft').ok).toBe(true)
    expect(gateOf('draft', 'owner', 'issue')).toMatchObject({ ok: false, reason: 'ดึง LBS ยังไม่ครบ Scope — ขาดอีก 2 เครื่อง' })
    expect(gateOf('allocated', 'owner', 'delete_draft')).toMatchObject({ ok: false })
    expect(gateOf('ready', 'owner', 'delete_draft')).toMatchObject({ ok: false })     // มีเครื่องบน Job แม้ไม่มีประวัติดึง
  })

  it('ดึงครบ Scope แล้ว — ปุ่มดึงบอกว่าครบแล้ว', () => {
    expect(gateOf('ready', 'owner', 'draw_lbs')).toMatchObject({ ok: false, reason: 'ดึงครบ Scope แล้ว (2 เครื่อง)' })
  })

  it('ชื่อปุ่มตามแผนก: Project = "ขออนุมัติ…" (ส่งคำขอ) · Manage = ทำทันที', () => {
    const d = sc('ready').db
    expect(jobAction(d, J(d), USERS.owner, 'cancel_job', TODAY)).toMatchObject({ label: 'ขออนุมัติยกเลิก Job', approval: true })
    expect(jobAction(d, J(d), USERS.manage, 'cancel_job', TODAY)).toMatchObject({ label: 'ยกเลิก Job', approval: false })
    expect(jobAction(d, J(d), USERS.owner, 'issue', TODAY).approval).toBe(true)      // LBS อย่างเดียว = ผ่าน Division
  })

  it('มีคำขอค้าง = ปุ่มขอซ้ำกดไม่ได้ พร้อมบอกว่ารอ Division', () => {
    const d = sc('procuring').db
    expect(jobAction(d, J(d), USERS.owner, 'request_pr', TODAY).gate.ok).toBe(true)
    const d2: DB = { ...d, approvalRequests: [appr('create_pr')] }
    expect(jobAction(d2, J(d2), USERS.owner, 'request_pr', TODAY).gate)
      .toEqual({ ok: false, reason: 'มีคำขอออก PR รอ Division พิจารณาอยู่แล้ว' })
    expect(pendingGate(d2, 'j1', 'cancel_job').ok).toBe(true)                        // คนละประเภท ไม่กัน
  })

  it('ปิดงาน: Service/Project ทุกคน/Manage กดได้ (0080) · มีเครื่องติดตั้งไม่ได้ = บอกให้คืนเข้าคลังก่อน', () => {
    for (const who of ['service', 'owner', 'other', 'manage'] as const) expect(gateOf('awaiting_close', who, 'close_install').ok).toBe(true)
    for (const who of ['division', 'purchasing', 'vip'] as const) expect(gateOf('awaiting_close', who, 'close_install').ok).toBe(false)
    const g = gateOf('blocked', 'service', 'close_install')
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.reason).toContain('ส่งคำขอคืนเข้า LBS Inventory ก่อน')
    expect(gateOf('blocked', 'service', 'return_issued_lbs').ok).toBe(true)
    expect(gateOf('installing', 'service', 'return_issued_lbs')).toMatchObject({ ok: false, reason: 'ไม่มีเครื่องที่ติดตั้งไม่ได้' })
    expect(gateOf('procuring', 'service', 'close_install')).toMatchObject({ ok: false, reason: 'ยังไม่ได้เบิกของออกหน้างาน — ปิดงานได้หลังติดตั้งครบ' })
    expect(gateOf('installing', 'owner', 'issue')).toMatchObject({ ok: false, reason: 'J-001 เบิกครบทั้งใบแล้ว' })
  })

  it('มติ Q2: เริ่มนับประกันแล้ว เปิดงานใหม่ไม่ได้ (ชี้ไปขอแก้ข้อมูล) · ยังไม่เริ่ม = เปิดได้', () => {
    expect(gateOf('closed_warranty', 'owner', 'reopen_job')).toMatchObject({ ok: false, reason: 'เริ่มนับประกันแล้ว — ใช้ "ขอแก้ข้อมูลที่บันทึกผิด" แทน' })
    expect(gateOf('closed_warranty', 'owner', 'correct_closeout').ok).toBe(true)
    expect(gateOf('closed_warranty', 'service', 'correct_closeout').ok).toBe(true)
    expect(gateOf('closed_no_warranty', 'owner', 'reopen_job').ok).toBe(true)
    expect(gateOf('closed_no_warranty', 'owner', 'correct_closeout').ok).toBe(false)
  })

  it('งานที่ยกเลิกแล้ว: ทุกปุ่มของทุกแผนกกดไม่ได้', () => {
    const d = sc('cancelled').db
    for (const who of Object.keys(USERS) as (keyof typeof USERS)[])
      expect(jobActions(d, J(d), USERS[who], TODAY).filter(a => a.gate.ok).map(a => a.key), who).toEqual([])
  })

  it('ยังไม่ login = ทุกปุ่มบอกให้เข้าสู่ระบบ', () => {
    expect(permGate(null, 'job.manage')).toEqual({ ok: false, reason: 'กรุณาเข้าสู่ระบบ' })
  })
})

// =============================================================================
describe('ขั้นต่อไป · ใครทำ · ภายในวันที่', () => {
  const step = (key: string) => { const d = sc(key).db; return jobNextStep(d, J(d), TODAY) }

  it('ก่อนเบิก: Project ทำ · กำหนด = กำหนดส่ง', () => {
    expect(step('draft')).toMatchObject({ title: 'ดึง LBS เข้างาน', who: ['project'], due: '2026-12-31', dueLabel: 'กำหนดส่ง' })
    expect(step('allocated')).toMatchObject({ title: 'ดึง LBS ให้ครบ Scope', who: ['project'] })
    expect(step('procuring')).toMatchObject({ title: 'ขออนุมัติออก PR', who: ['project'] })
    expect(step('ready')).toMatchObject({ title: 'เบิกให้ Service', who: ['project'] })
  })

  it('จัดซื้อ: PR ส่งแล้ว → Purchasing ออก PO · ออก PO แล้ว → Purchasing รับของ (LBS ยังรอ ETA — Project ไม่มีอะไรให้ทำ)', () => {
    const eta = { planPoReceiptDate: '2026-12-15' }
    const base = db({ jobs: [job()], lbsUnits: [unit('a', eta), unit('b', eta)] })
    const prSent: DB = { ...base, accessoryRequests: [acc('r1', { status: 'pr_sent', prId: 'pr1' })] }
    expect(jobNextStep(prSent, J(prSent), TODAY)).toMatchObject({ title: 'ออก PO', who: ['purchasing'] })
    const poOrd: DB = { ...base, accessoryRequests: [acc('r1', { status: 'po_ordered', prId: 'pr1', poId: 'po1' })] }
    expect(jobNextStep(poOrd, J(poOrd), TODAY)).toMatchObject({ title: 'รับของตาม PO', who: ['purchasing'] })
  })

  it('หน้างาน: Service ทำ · กำหนด = วันนัดสุดท้าย (ไม่ใช่กำหนดส่ง — คนละนาฬิกา)', () => {
    expect(step('installing')).toMatchObject({ title: 'ยืนยันติดตั้งรายเครื่อง', who: ['service'], due: '2026-11-30', dueLabel: 'วันนัดสุดท้าย' })
    expect(step('awaiting_close')).toMatchObject({ title: 'ปิดงานติดตั้ง', who: ['service', 'project'] })
  })

  it('มติ Q1: เครื่องติดตั้งไม่ได้ → ขั้นต่อไปคือขอคืนเข้า LBS Inventory', () => {
    const s = step('blocked')
    expect(s.title).toBe('คืนเครื่องที่ติดตั้งไม่ได้เข้า LBS Inventory ก่อนปิดงาน')
    expect(s.who).toEqual(expect.arrayContaining(['service', 'project']))
  })

  it('คำขอที่ตรงกับขั้นนี้ค้างอยู่ → ขั้นต่อไปเป็น "รอ Division พิจารณา" (Division ทำ)', () => {
    const d: DB = { ...sc('procuring').db, approvalRequests: [appr('create_pr')] }
    const s = jobNextStep(d, J(d), TODAY)
    expect(s).toMatchObject({ title: 'รอ Division พิจารณา: ออก PR', who: ['sales'], tone: 'amber' })
    expect(s.detail).toContain('วิชัย เจ้าของงาน')
    expect(s.detail).toContain('ถ้าอนุมัติ: ระบบออก PR ให้ Purchasing ออก PO ต่อ')
  })

  it('คำขอยกเลิก Job ค้าง → หยุดทั้งใบ · คำขอคนละเรื่องไม่แย่งขั้นต่อไป แต่ยังอยู่ในป้าย', () => {
    expect(step('ready_cancel_pending')).toMatchObject({ title: 'รอ Division พิจารณา: ยกเลิก Job', who: ['sales'] })
    const d: DB = { ...sc('ready').db, approvalRequests: [appr('swap_lbs')] }
    const s = jobNextStep(d, J(d), TODAY)
    expect(s.title).toBe('เบิกให้ Service')
    expect(s.pending.map(r => r.type)).toEqual(['swap_lbs'])
  })

  it('ปิด/ยกเลิกแล้ว = ไม่มีผู้ต้องทำ', () => {
    expect(step('closed_warranty').who).toEqual([])
    expect(step('cancelled')).toMatchObject({ title: 'ยกเลิกแล้ว', who: [] })
  })

  it('ถึงคิวใคร: แผนกที่ต้องทำ + Manage · VIP ไม่เคยถึงคิว', () => {
    const s = step('ready')
    expect(isMyTurn(s, USERS.owner)).toBe(true)
    expect(isMyTurn(s, USERS.other)).toBe(true)       // ไม่ส่ง job = ดูแค่แผนก
    expect(isMyTurn(s, USERS.other, J(sc('ready').db))).toBe(false)   // 🔴 ใบของคนอื่น ต้องไม่ขึ้น "ถึงคิวคุณ" (พบในหน้าจอจริง)
    expect(isMyTurn(s, USERS.owner, J(sc('ready').db))).toBe(true)
    expect(isMyTurn(step('awaiting_close'), USERS.service, J(sc('awaiting_close').db))).toBe(true)   // Service ไม่ติดเจ้าของงาน
    expect(isMyTurn(s, USERS.manage)).toBe(true)
    expect(isMyTurn(s, USERS.service)).toBe(false)
    expect(isMyTurn(s, USERS.vip)).toBe(false)
    expect(isMyTurn(step('cancelled'), USERS.manage)).toBe(false)
  })

  it('คำขอเรียงตามเวลาส่ง (เก่าสุดก่อน)', () => {
    const d: DB = { ...sc('ready').db, approvalRequests: [
      appr('swap_lbs', { id: 'b', requestedAt: '2026-11-10T00:00:00Z' }),
      appr('cancel_job', { id: 'a', requestedAt: '2026-11-05T00:00:00Z' }),
      appr('create_pr', { id: 'c', status: 'approved' }),
    ] }
    expect(pendingApprovals(d, 'j1').map(r => r.id)).toEqual(['a', 'b'])
  })
})

// =============================================================================
describe('สถานะกำหนดส่ง: ติดตั้งครบ + เบิกครบ แต่ติดเรื่องอื่นก่อนปิด (บั๊กป้ายเดิม)', () => {
  it('🔴 ของคืนรอ Purchasing ตรวจรับ → ต้องไม่ขึ้น "รอเบิกของที่เหลือ" (ไม่มีอะไรให้เบิก)', () => {
    const d: DB = {
      ...sc('awaiting_close').db,
      stockReturns: [{ id: 'sr', requestId: 'r1', jobId: 'j1', itemId: 'i1', kind: 'return', qty: 1, status: 'pending', requestedAt: T }],
    }
    const del = jobDelivery(d, J(d), TODAY)
    expect(del.label).not.toContain('รอเบิกของที่เหลือ')
    expect(del.label).toContain('ค้าง 1 เรื่องก่อนปิดงาน')
    expect(del.nextStep).toContain('Purchasing ตรวจรับ')
    const s = jobNextStep(d, J(d), TODAY)
    expect(s).toMatchObject({ title: 'เคลียร์เรื่องค้างก่อนปิดงาน', who: ['purchasing'] })
  })
})

// =============================================================================
describe('เหตุผลปิดงาน (ย้ายจาก ServicePage — ข้อความเดิมทุกตัว)', () => {
  const s = (over: Partial<ReturnType<typeof jobInstallSummary>>) => ({
    ...jobInstallSummary(sc('awaiting_close').db, 'j1'), ...over,
  })
  it.each([
    [{ closeBlockers: ['A', 'B'] }, 'A · B'],
    [{ total: 0 }, 'ไม่มีเครื่องที่เบิกไว้'],
    [{ waiting: 1 }, 'ยังมี 1 เครื่องที่ Project ยังไม่ได้เบิกให้ — ปิดงานได้เมื่อของออกครบ Scope'],
    [{ pending: 2 }, 'ต้องได้ข้อสรุปทุกเครื่องก่อน (เหลือ 2 เครื่อง)'],
    [{ installed: 0 }, 'ต้องมีเครื่องที่ติดตั้งสำเร็จอย่างน้อย 1 เครื่อง'],
    [{ issueComplete: false, lbsShort: 1, pendingAccessories: 0 }, 'ติดตั้งครบแล้ว แต่ใบยังเบิกของไม่ครบ (LBS ขาดอีก 1 เครื่องจาก Scope) — Project ต้องเบิก/โอนคืน/ตัดจำหน่ายให้ครบก่อน จึงปิดงานได้'],
    [{}, ''],
  ])('%o → %s', (over, expected) => {
    expect(jobCloseReason(s(over))).toBe(expected)
  })
})

// =============================================================================
// รีวิวเฟส 2 (2026-11-23) — เทสต์ที่ชี้ปัญหาก่อนแก้ (แดงบนโค้ดเดิม)
// =============================================================================
describe('รีวิวเฟส 2 · ข้อ 2 — ใครปิดงานได้ (0080 · มติผู้ใช้: Service + Project ทุกคน + Manage)', () => {
  it('Project ที่ไม่ใช่เจ้าของงานปิดงานได้ — ตรงกับ closeJobInstall/rpc_close_job_install', () => {
    expect(gateOf('awaiting_close', 'other', 'close_install').ok).toBe(true)
  })
})

describe('รีวิวเฟส 2 · ข้อ 3 — "รอปิดงาน" ต้องนับเฉพาะงานที่กดปิดได้จริง', () => {
  const withCrew = (d: DB): DB => ({
    ...d,
    teamMembers: [{ id: 'm1', firstName: 'ช่าง', lastName: 'หนึ่ง', phone: '-', position: 'หัวหน้าช่าง', isActive: true, createdAt: T }],
    jobAssignments: [{ id: 'as1', jobId: 'j1', memberId: 'm1', isLead: true, assignedBy: 'u-svc', assignedAt: T }],
  })
  const returnPending: DB = withCrew({
    ...sc('awaiting_close').db,
    stockReturns: [{ id: 'sr', requestId: 'r1', jobId: 'j1', itemId: 'i1', kind: 'return', qty: 1, status: 'pending', requestedAt: T }],
  })
  const extraMaterial: DB = withCrew({
    ...sc('awaiting_close').db,
    accessoryRequests: [acc('r9', { status: 'received', qtyReceived: 1 })],
  })

  it('ค้างเรื่องก่อนปิด (ของคืนรอตรวจรับ) = สถานะแยก ไม่ใช่ "รอปิดงาน"', () => {
    const d = jobDelivery(returnPending, J(returnPending), TODAY)
    expect(d.state).toBe('awaiting_clearance')
    const ms = memberSchedule(returnPending, 'm1')
    expect(ms.awaitingClose).toBe(0)
    expect(ms.awaitingClearance).toBe(1)
    expect(ms.pendingInstall).toBe(0)
  })

  it('งานที่ปิดได้จริงยังนับ "รอปิดงาน" ตามเดิม', () => {
    const d = withCrew(sc('awaiting_close').db)
    expect(jobDelivery(d, J(d), TODAY).state).toBe('awaiting_close')
    expect(memberSchedule(d, 'm1')).toMatchObject({ awaitingClose: 1, awaitingClearance: 0 })
  })

  it('วัสดุเพิ่มหลังเบิกครบใบที่ยังไม่ได้เบิก = ยัง "รอ Project เบิกของ" (ไม่หลุดไปนับเป็นรอปิด)', () => {
    const d = jobDelivery(extraMaterial, J(extraMaterial), TODAY)
    expect(d.state).toBe('awaiting_issue_rest')
    expect(memberSchedule(extraMaterial, 'm1')).toMatchObject({ awaitingIssueRest: 1, awaitingClose: 0 })
    expect(jobNextStep(extraMaterial, J(extraMaterial), TODAY)).toMatchObject({ who: ['project'] })
  })

  it('คอลัมน์สถานะงานพูดตรงกับป้ายกำหนดส่ง (ไม่ขึ้น "ติดตั้งแล้ว 2/2" เฉย ๆ ทั้งที่ค้างก่อนปิด)', () => {
    expect(jobStatusPhase(returnPending, J(returnPending))).toBe('ติดตั้งครบ · ค้างก่อนปิดงาน')
    expect(jobStatusPhase(extraMaterial, J(extraMaterial))).toBe('ติดตั้งครบ · ค้างเบิกของ')
  })
})

describe('รีวิวเฟส 2 · ข้อ 4 — คำขอรอพิจารณา บอกผลที่จะเกิดจริงถ้าอนุมัติ', () => {
  it('คำขอยกเลิก Job: ถ้าอนุมัติ = ยกเลิกใบ · ถ้าไม่อนุมัติ = ทำต่อขั้นเดิม', () => {
    const d = sc('ready_cancel_pending').db
    const s = jobNextStep(d, J(d), TODAY)
    expect(s.detail).not.toContain('ขั้นถัดไปคือ')
    expect(s.detail).toContain('ถ้าอนุมัติ: ยกเลิก J-001')
    expect(s.detail).toContain('ถ้าไม่อนุมัติ: ทำต่อที่ "เบิกให้ Service"')
  })

  it('คำขอเปิดงานใหม่: ถ้าอนุมัติ = งานกลับมาเปิด · ถ้าไม่อนุมัติ = ยังปิดอยู่', () => {
    const d: DB = { ...sc('closed_no_warranty').db, approvalRequests: [appr('reopen_job')] }
    const s = jobNextStep(d, J(d), TODAY)
    expect(s.title).toBe('รอ Division พิจารณา: เปิดงานใหม่')
    expect(s.detail).toContain('ถ้าอนุมัติ: งานกลับมาเปิด')
    expect(s.detail).toContain('ถ้าไม่อนุมัติ: งานยังปิดอยู่ตามเดิม')
  })

  it('คำขอที่ตรงกับขั้น: บอกผลของคำขอ ไม่วนกลับไปชื่อขั้นเดิม', () => {
    const d: DB = { ...sc('procuring').db, approvalRequests: [appr('create_pr')] }
    const s = jobNextStep(d, J(d), TODAY)
    expect(s.detail).not.toContain('ขั้นถัดไปคือ "ขออนุมัติออก PR"')
    expect(s.detail).toContain('Purchasing ออก PO')
  })
})

describe('รีวิวเฟส 2 · ข้อ 5 — เบิกวัสดุไปบางส่วนแล้ว ขั้นต่อไปต้องมีคนรับผิดชอบเสมอ', () => {
  const issuedAcc = acc('r2', { status: 'received', qtyReceived: 1, qtyIssuedToService: 1 })

  it('LBS ยังไม่ถึงคลัง + วัสดุใหม่ยังไม่ออก PR → "ขออนุมัติออก PR" · Project (ไม่ใช่ "รอของถึงคลัง" ไม่มีผู้ทำ)', () => {
    const eta = { planPoReceiptDate: '2026-12-15' }
    const d = db({ jobs: [job()], lbsUnits: [unit('a', eta), unit('b', eta)], accessoryRequests: [issuedAcc, acc('r1')] })
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({ title: 'ขออนุมัติออก PR', who: ['project'] })
  })

  it('PR ส่งแล้ว → Purchasing ออก PO', () => {
    const eta = { planPoReceiptDate: '2026-12-15' }
    const d = db({ jobs: [job()], lbsUnits: [unit('a', eta), unit('b', eta)],
      accessoryRequests: [issuedAcc, acc('r1', { status: 'pr_sent', prId: 'pr1' })] })
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({ title: 'ออก PO', who: ['purchasing'] })
  })

  it('LBS ยังไม่ครบ Scope + วัสดุยังไม่ออก PR → ขอ PR ก่อน (ของซื้อใช้เวลานานกว่า · ลำดับเดียวกับ procuring_accessory) และบอกว่า LBS ยังขาด', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a')], accessoryRequests: [issuedAcc, acc('r1')] })
    const s = jobNextStep(d, J(d), TODAY)
    expect(s).toMatchObject({ title: 'ขออนุมัติออก PR', who: ['project'] })
    expect(s.detail).toBe('วัสดุ 1 รายการยังไม่ได้ออก PR · LBS ยังขาดอีก 1 เครื่อง')
  })

  it('LBS ยังไม่ครบ Scope (จัดซื้อเสร็จแล้ว) → "ดึง LBS ให้ครบ Scope" · Project', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), spare]   /* มีเครื่องให้ดึง (รีวิว Flow ข้อ 2) */, accessoryRequests: [issuedAcc] })
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({ title: 'ดึง LBS ให้ครบ Scope', who: ['project'] })
  })
})

describe('รีวิวเฟส 2 · ข้อ 6 — ปุ่มเบิกบอกว่า LBS รอ Division แต่วัสดุเบิกได้ตามปกติ', () => {
  it('มีคำขอเบิก LBS ค้าง + มีวัสดุพร้อมเบิก → กดได้ พร้อมหมายเหตุ', () => {
    const d: DB = { ...sc('ready').db, accessoryRequests: [acc('r1', { status: 'received', qtyReceived: 1 })], approvalRequests: [appr('issue_job')] }
    expect(jobAction(d, J(d), USERS.owner, 'issue', TODAY).gate)
      .toEqual({ ok: true, note: 'มีคำขอเบิก LBS ให้ Service รอ Division พิจารณาอยู่แล้ว — เบิกวัสดุได้ตามปกติ' })
  })
  it('ไม่มีคำขอค้าง = ไม่มีหมายเหตุ', () => {
    const d: DB = { ...sc('ready').db, accessoryRequests: [acc('r1', { status: 'received', qtyReceived: 1 })] }
    expect(jobAction(d, J(d), USERS.owner, 'issue', TODAY).gate).toEqual({ ok: true })
  })
})

// =============================================================================
describe('รีวิวรอบสุดท้าย · ข้อ 1 — งานที่ Project ทำได้เอง ต้องไม่ถูกบังด้วยขั้นจัดซื้อของแผนกอื่น', () => {
  const issuedAcc = acc('r2', { status: 'received', qtyReceived: 1, qtyIssuedToService: 1 })
  const prSent = acc('r1', { status: 'pr_sent', prId: 'pr1' })

  it('เบิกวัสดุไปบางส่วน + LBS พร้อมเบิก + PR ส่งแล้ว → "เบิกส่วนที่เหลือให้ Service" · Project และบอกสถานะจัดซื้อต่อท้าย', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), unit('b')], accessoryRequests: [issuedAcc, prSent] })
    const s = jobNextStep(d, J(d), TODAY)
    expect(s).toMatchObject({ title: 'เบิกส่วนที่เหลือให้ Service', who: ['project'] })
    expect(s.detail).toContain('PR ส่งแล้ว 1 รายการ รอ Purchasing ออก PO')
  })

  it('ยังไม่เบิกอะไร + LBS พร้อมเบิก + ออก PO แล้ว → "เบิกให้ Service" · Project', () => {
    const d: DB = { ...sc('procuring').db, accessoryRequests: [acc('r1', { status: 'po_ordered', prId: 'pr1', poId: 'po1' })] }
    const s = jobNextStep(d, J(d), TODAY)
    expect(s).toMatchObject({ title: 'เบิกให้ Service', who: ['project'] })
    expect(s.detail).toContain('รอรับของ 1 รายการ')
    // ป้ายสถานะ/สิ่งที่ต้องทำต่อ ต้องไม่บอกให้รอวัสดุครบก่อนเบิก ทั้งที่ปุ่มเบิกกดได้
    expect(s.detail).not.toContain('ครบก่อนเบิก')
    expect(jobDelivery(d, J(d), TODAY).nextStep).toBe('ของบางส่วนพร้อมแล้ว — Project เบิกให้ Service ก่อนได้ · วัสดุที่เหลือรอฝ่ายจัดซื้อ (ดูหน้า Purchasing)')
  })

  it('LBS ไม่ครบ Scope + PR ส่งแล้ว → "ดึง LBS ให้ครบ Scope" · Project (สถานะจัดซื้อต่อท้าย)', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), spare]   /* มีเครื่องให้ดึง (รีวิว Flow ข้อ 2) */, accessoryRequests: [issuedAcc, prSent] })
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({
      title: 'ดึง LBS ให้ครบ Scope', who: ['project'], detail: 'ขาดอีก 1 เครื่อง · PR ส่งแล้ว 1 รายการ รอ Purchasing ออก PO',
    })
  })

  it('วัสดุยังไม่ออก PR ยังมาก่อน แม้ LBS พร้อมเบิก (Project ทำเอง · ของซื้อใช้เวลานานกว่า)', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), unit('b')], accessoryRequests: [issuedAcc, acc('r1')] })
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({ title: 'ขออนุมัติออก PR', who: ['project'] })
  })
})

describe('รีวิวรอบสุดท้าย · ข้อ 2 — ยกเลิก Job ที่เบิกของออกไปแล้วบางส่วน', () => {
  const partial = () => db({ jobs: [job()], lbsUnits: [unit('a'), unit('b')],
    accessoryRequests: [acc('r2', { status: 'received', qtyReceived: 1, qtyIssuedToService: 1 })] })

  it('ปุ่มยกเลิก Job กดไม่ได้ (ทั้ง Project และ Manage) พร้อมเหตุผลเดียวกับ cancelJob', () => {
    const d = partial()
    for (const who of ['owner', 'manage'] as const) {
      const g = jobAction(d, J(d), USERS[who], 'cancel_job', TODAY).gate
      expect(g.ok, who).toBe(false)
      if (!g.ok) expect(g.reason).toBe(jobCancelBlockReason(d, 'j1'))
    }
  })

  it('ยังไม่ได้เบิกอะไรออก = ยกเลิกได้ตามเดิม', () => {
    expect(gateOf('ready', 'owner', 'cancel_job').ok).toBe(true)
    expect(gateOf('procuring', 'manage', 'cancel_job').ok).toBe(true)
  })
})

describe('รีวิวรอบสุดท้าย · ข้อ 4 — ติดตั้งครบแต่ใบยังเบิกไม่ครบ (awaiting_issue_rest)', () => {
  const rest = (accessoryRequests: AccessoryRequest[], lbsQtyRequired = 3) => db({
    jobs: [job({ installStartDate: '2026-11-20', installEndDate: '2026-11-30', lbsQtyRequired })],
    lbsUnits: [unit('a', { status: 'issued' }), unit('b', { status: 'issued' })],
    unitInstallations: [inst('a', 'installed'), inst('b', 'installed')], accessoryRequests,
  })

  it('วัสดุยังไม่ออก PR + LBS ไม่ครบ Scope → ขอ PR และบอกว่า LBS ยังขาด', () => {
    const d = rest([acc('r1')])
    expect(jobDelivery(d, J(d), TODAY).state).toBe('awaiting_issue_rest')
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({
      title: 'ขออนุมัติออก PR', who: ['project'], detail: 'วัสดุ 1 รายการยังไม่ได้ออก PR · LBS ยังขาดอีก 1 เครื่อง',
    })
  })

  it('PR ส่งแล้ว + LBS ไม่ครบ Scope → Project ดึง/เบิก LBS ต่อ (ไม่ใช่ "ออก PO" บังงานของ Project)', () => {
    const d = rest([acc('r1', { status: 'pr_sent', prId: 'pr1' })])
    const s = jobNextStep(d, J(d), TODAY)
    expect(s).toMatchObject({ title: 'เบิกของที่เหลือให้ครบใบ', who: ['project'] })
    expect(s.detail).toContain('PR ส่งแล้ว 1 รายการ รอ Purchasing ออก PO')
  })

  it('PR ส่งแล้ว + LBS ครบ Scope (ใบยังไม่ issued เพราะวัสดุค้าง) → Purchasing ออก PO', () => {
    const d = rest([acc('r1', { status: 'pr_sent', prId: 'pr1' })], 2)
    expect(jobDelivery(d, J(d), TODAY).state).toBe('awaiting_issue_rest')
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({ title: 'ออก PO', who: ['purchasing'] })
  })
})

// =============================================================================
// เฟส 3 (2026-11-23) — กล่อง "งานของฉัน": รวมทุกอย่างที่รอผู้ใช้คนนี้จากทุกหน้า แยกตามแผนก
// =============================================================================
describe('เฟส 3 · งานของฉัน (myWork)', () => {
  const W = (d: DB, who: keyof typeof USERS) => myWork(d, USERS[who], TODAY)
  const etaUnits = [unit('a', { planPoReceiptDate: '2026-12-15' }), unit('b', { planPoReceiptDate: '2026-12-15' })]
  const pr = (over: Partial<DB['prs'][number]> = {}): DB['prs'][number] =>
    ({ id: 'pr1', prNo: 'PR-001', jobId: 'j1', status: 'pending', requestIds: ['r1'], createdBy: 'u-p', createdAt: T, ...over })
  const po = (over: Partial<DB['pos'][number]> = {}): DB['pos'][number] =>
    ({ id: 'po1', poNo: 'PO-001', prId: 'pr1', jobId: 'j1', supplierName: 'ซัพ A', expectedDate: '2026-11-20', status: 'issued', createdBy: 'u-pur', createdAt: T, ...over })

  it('Project เจ้าของงาน: ขั้นต่อไปของงานตัวเอง ลิงก์ไปหน้า Job · Project คนอื่น/VIP/ไม่ login = ไม่มีงาน', () => {
    const d = sc('ready').db
    expect(W(d, 'owner')).toEqual([expect.objectContaining({
      key: 'job:j1', title: 'เบิกให้ Service', jobId: 'j1', jobNo: 'J-001', link: '/jobs/j1', due: '2026-12-31', lateDays: 0,
    })])
    expect(W(d, 'other')).toEqual([])
    expect(W(d, 'vip')).toEqual([])
    expect(myWork(d, null, TODAY)).toEqual([])
  })

  it('Division: คำขอรอพิจารณาเป็นรายการละใบ ลิงก์ตรงไปคำขอ · ค้างกี่วัน · ไม่ซ้ำกับขั้นต่อไปของงาน', () => {
    const d = sc('ready_cancel_pending').db
    expect(W(d, 'division')).toEqual([expect.objectContaining({
      key: 'appr:ap-cancel_job', title: 'พิจารณาคำขอ: ยกเลิก Job', jobNo: 'J-001',
      link: '/approvals?id=ap-cancel_job', waitingDays: 22, lateDays: 0,
    })])
    expect(W(d, 'division')[0].detail).toContain('ส่งโดย วิชัย เจ้าของงาน')
  })

  it('Manage ไม่เห็นคำขอที่ตัวเองส่งเป็นงานต้องพิจารณา (มติ D1)', () => {
    const d: DB = { ...sc('ready').db, approvalRequests: [appr('swap_lbs', { requestedBy: 'u-adm' })] }
    expect(W(d, 'manage').some(w => w.key.startsWith('appr:'))).toBe(false)
    expect(W(d, 'division').map(w => w.key)).toContain('appr:ap-swap_lbs')
  })

  it('Purchasing: PR รอออก PO เป็นรายการละใบ (ไม่ซ้ำกับขั้นต่อไปของงานเดียวกัน)', () => {
    const d = db({ jobs: [job()], lbsUnits: etaUnits, accessoryRequests: [acc('r1', { status: 'pr_sent', prId: 'pr1' })], prs: [pr()] })
    expect(W(d, 'purchasing')).toEqual([expect.objectContaining({
      key: 'pr:pr1', title: 'ออก PO', jobNo: 'J-001', link: '/purchasing', waitingDays: 22,
    })])
    expect(W(d, 'purchasing')[0].detail).toContain('PR-001')
  })

  it('Purchasing: PO เลยวันส่งของ = เลยกำหนด ขึ้นก่อน · ของคืนรอตรวจรับเป็นรายการลิงก์ไป Material Master', () => {
    const d = db({
      jobs: [job()], lbsUnits: etaUnits,
      accessoryRequests: [acc('r1', { status: 'po_ordered', prId: 'pr1', poId: 'po1' }), acc('r2', { status: 'received', qtyReceived: 1, qtyIssuedToService: 1 })],
      prs: [pr({ status: 'po_issued' })], pos: [po()],
      stockReturns: [{ id: 'sr', requestId: 'r2', jobId: 'j1', itemId: 'i1', kind: 'return', qty: 1, status: 'pending', requestedAt: '2026-11-20T03:00:00.000Z' }],
    })
    const w = W(d, 'purchasing')
    expect(w.map(x => x.key)).toEqual(['po:po1', 'ret:sr'])
    expect(w[0]).toMatchObject({ title: 'รับของตาม PO', due: '2026-11-20', lateDays: 3, tone: 'red' })
    expect(w[1]).toMatchObject({ title: 'ตรวจรับของคืน', link: '/master', waitingDays: 3 })
  })

  it('Service: ของออกหน้างานแล้วแต่ยังไม่มอบหมายทีม → "มอบหมายทีมช่าง" ก่อน · มอบหมายแล้ว = ขั้นหน้างานปกติ ลิงก์หน้า Site Installation', () => {
    const d = sc('installing').db
    expect(W(d, 'service')).toEqual([expect.objectContaining({ key: 'job:j1', title: 'มอบหมายทีมช่าง', link: '/service' })])
    expect(W(d, 'service')[0].detail).toContain('ยืนยันติดตั้งรายเครื่อง')
    const withTeam: DB = { ...d, jobAssignments: [{ id: 'as', jobId: 'j1', memberId: 'm1', isLead: true, assignedBy: 'u-svc', assignedAt: T }] }
    expect(W(withTeam, 'service')).toEqual([expect.objectContaining({ key: 'job:j1', title: 'ยืนยันติดตั้งรายเครื่อง', link: '/service' })])
  })

  it('ติดตั้งครบแล้ว (รอปิดงาน) แม้ไม่มีทีมในระบบ = ขั้นปิดงาน ไม่ใช่ "มอบหมายทีมช่าง" (งานหน้างานจบแล้ว)', () => {
    const d = sc('awaiting_close').db
    expect(W(d, 'service')).toEqual([expect.objectContaining({ key: 'job:j1', title: 'ปิดงานติดตั้ง', link: '/service' })])
  })

  it('เรียง: เลยกำหนดก่อน (เลยมากก่อน) → มีวันกำหนด (ใกล้ก่อน) → ค้างนานก่อน', () => {
    const j2 = job({ id: 'j2', jobNo: 'J-002', requiredDate: '2026-11-10' })
    const j3 = job({ id: 'j3', jobNo: 'J-003', requiredDate: '2026-11-21' })
    const d = db({
      jobs: [job(), j2, j3],
      lbsUnits: [unit('a'), unit('b'), unit('c', { jobId: 'j2' }), unit('d', { jobId: 'j2' }), unit('e', { jobId: 'j3' }), unit('f', { jobId: 'j3' })],
    })
    expect(W(d, 'owner').map(w => [w.jobNo, w.lateDays])).toEqual([['J-002', 13], ['J-003', 2], ['J-001', 0]])
  })

  it('Manage เห็นงานทุกแผนก (ทำแทนได้ทุกขั้น) แต่ไม่ซ้ำ', () => {
    const d: DB = { ...db({ jobs: [job()], lbsUnits: etaUnits, accessoryRequests: [acc('r1', { status: 'pr_sent', prId: 'pr1' })], prs: [pr()] }),
      approvalRequests: [appr('swap_lbs')] }
    const keys = W(d, 'manage').map(w => w.key)
    expect(keys.sort()).toEqual(['appr:ap-swap_lbs', 'pr:pr1'])
  })
})

// =============================================================================
// เฟส 3 — Approval Queue: ข้อมูลตัดสินใจตามประเภทคำขอ (Division เห็นครบก่อนกดอนุมัติ)
// =============================================================================
describe('เฟส 3 · approvalFacts — ข้อมูลตัดสินใจตามประเภท', () => {
  const items = [
    { id: 'i1', code: 'A', name: 'ลูกถ้วย', itemType: 'accessory' as const, uom: 'ea', stockableCentrally: false },
    { id: 'i2', code: 'B', name: 'สายไฟ', itemType: 'accessory' as const, uom: 'm', stockableCentrally: false },
  ]
  const val = (f: ReturnType<typeof approvalFacts>, label: string) => f.facts.find(x => x.label === label)?.value

  it('ออก PR: รายการ + มูลค่ารวมจากสำเนา ณ ตอนขอ · บอกจำนวนรายการที่ยังไม่มีราคา', () => {
    const d = db({ jobs: [job()], items,
      accessoryRequests: [acc('r1', { qtyRequested: 4, unitPrice: 250 }), acc('r2', { itemId: 'i2', qtyRequested: 10 })],
      approvalRequests: [appr('create_pr', { payload: { requestIds: ['r1', 'r2'],
        snapshot: [{ id: 'r1', qty: 4, unitPrice: 250 }, { id: 'r2', qty: 10, unitPrice: null }] } })] })
    const f = approvalFacts(d, d.approvalRequests[0], TODAY)
    expect(f.money).toEqual({ total: 1000, unpriced: 1 })
    expect(val(f, 'รายการ')).toBe('ลูกถ้วย ×4 ea @ 250 · สายไฟ ×10 m (ยังไม่มีราคา)')
    expect(f.stale).toEqual([])
    expect(f.outcome).toBe('ถ้าอนุมัติ: ระบบออก PR ให้ Purchasing ออก PO ต่อ')
  })

  it('ออก PR: รายการถูกแก้หลังส่งคำขอ = เตือนว่าอนุมัติไม่ได้ (กติกาเดียวกับ approveRequest · 0093)', () => {
    const d = db({ jobs: [job()], items,
      accessoryRequests: [acc('r1', { qtyRequested: 6, unitPrice: 250 })],
      approvalRequests: [appr('create_pr', { payload: { requestIds: ['r1'], snapshot: [{ id: 'r1', qty: 4, unitPrice: 250 }] } })] })
    expect(approvalFacts(d, d.approvalRequests[0], TODAY).stale).toEqual(['ลูกถ้วย'])
  })

  it('เบิก LBS: Serial ที่จะเบิกจริง + นัดติดตั้ง', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), unit('b')],
      approvalRequests: [appr('issue_job', { payload: { unitIds: ['a', 'b'], startDate: '2026-12-01', endDate: '2026-12-02', location: 'สถานี A' } })] })
    const f = approvalFacts(d, d.approvalRequests[0], TODAY)
    expect(val(f, 'LBS ที่จะเบิก (2 เครื่อง)')).toBe('LVB-a, LVB-b')
    expect(val(f, 'นัดติดตั้ง')).toBe('1 ธ.ค. 2569 – 2 ธ.ค. 2569 · สถานี A')
  })

  it('สลับ LBS: คู่ที่สลับ + ต้นทุนที่เปลี่ยน + เหตุผล', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a', { unitCost: 100000 }), unit('x', { status: 'in_stock', jobId: null, unitCost: 120000 })],
      approvalRequests: [appr('swap_lbs', { payload: { swapAllocatedUnitId: 'a', swapStockUnitId: 'x', reason: 'เครื่องเดิมชำรุด' } })] })
    const f = approvalFacts(d, d.approvalRequests[0], TODAY)
    expect(val(f, 'สลับ')).toBe('LVB-a/OM-a (บน Job) ↔ LVB-x/OM-x (คลัง)')
    expect(val(f, 'ต้นทุน LBS ของงาน')).toBe('100,000 → 120,000 บาท')
    expect(val(f, 'เหตุผล')).toBe('เครื่องเดิมชำรุด')
  })

  it('ยกเลิก Job: บอกผลทั้งสองทาง + LBS ที่จะคืนสต็อก + วัสดุที่รับแล้วไปไหน', () => {
    const d = sc('ready_cancel_pending').db
    const r: ApprovalRequest = { ...d.approvalRequests[0], payload: { reason: 'ลูกค้ายกเลิก', receivedToCentral: true } }
    const f = approvalFacts({ ...d, approvalRequests: [r] }, r, TODAY)
    expect(val(f, 'เหตุผล')).toBe('ลูกค้ายกเลิก')
    expect(val(f, 'LBS คืนสต็อก')).toBe('2 เครื่อง')
    expect(val(f, 'วัสดุที่รับแล้ว')).toBe('คืนเข้าสต็อกกลาง')
    expect(f.outcome).toContain('ถ้าอนุมัติ: ยกเลิก J-001')
    expect(f.outcome).toContain('ถ้าไม่อนุมัติ: ทำต่อที่ "เบิกให้ Service"')
  })

  it('ยกเลิกผลติดตั้ง: เครื่อง + วันที่ที่ยืนยันไว้', () => {
    const d: DB = { ...sc('awaiting_close').db,
      approvalRequests: [appr('revert_install', { payload: { unitIds: ['a'], reason: 'บันทึกผิดเครื่อง' } })] }
    const f = approvalFacts(d, d.approvalRequests[0], TODAY)
    expect(val(f, 'เครื่อง (1)')).toBe('LVB-a (ติดตั้ง 1 พ.ย. 2569)')
    expect(val(f, 'เหตุผล')).toBe('บันทึกผิดเครื่อง')
  })
})

// =============================================================================
// รีวิวเฟส 3 (2026-11-23) — เทสต์ที่ชี้ปัญหาก่อนแก้
// =============================================================================
describe('รีวิวเฟส 3 · ข้อ 2 — งานของฉันไม่ซ้ำกับรายการคิว (รอเคลียร์ก่อนปิดงาน)', () => {
  const W = (d: DB, who: keyof typeof USERS) => myWork(d, USERS[who], TODAY)
  const ret = { id: 'sr', requestId: 'r1', jobId: 'j1', itemId: 'i1', kind: 'return' as const, qty: 1, status: 'pending' as const, requestedAt: T }

  it('Purchasing: ของคืนรอตรวจรับ = รายการ "ตรวจรับของคืน" รายการเดียว (ไม่มี "เคลียร์เรื่องค้างก่อนปิดงาน" ซ้ำ)', () => {
    const d: DB = { ...sc('awaiting_close').db, stockReturns: [ret] }
    expect(jobDelivery(d, J(d), TODAY).state).toBe('awaiting_clearance')
    expect(W(d, 'purchasing').map(w => w.key)).toEqual(['ret:sr'])
  })

  it('Division: คำขอที่ค้างก่อนปิด = รายการ "พิจารณาคำขอ" รายการเดียว', () => {
    const d: DB = { ...sc('awaiting_close').db, approvalRequests: [appr('swap_lbs')] }
    expect(jobDelivery(d, J(d), TODAY).state).toBe('awaiting_clearance')
    expect(W(d, 'division').map(w => w.key)).toEqual(['appr:ap-swap_lbs'])
  })

  it('Manage: ทั้งของคืน + คำขอ อยู่ในคิวครบแล้ว = ไม่มีรายการงานซ้ำ', () => {
    const d: DB = { ...sc('awaiting_close').db, stockReturns: [ret], approvalRequests: [appr('swap_lbs')] }
    expect(W(d, 'manage').map(w => w.key).sort()).toEqual(['appr:ap-swap_lbs', 'ret:sr'])
  })

  it('ส่วนที่ไม่มีคิวยังขึ้นตามเดิม: เครื่องติดตั้งไม่ได้ (Service/Project ต้องคืนเข้าคลัง)', () => {
    const d = sc('blocked').db
    expect(W(d, 'service').map(w => [w.key, w.title])).toEqual([['job:j1', 'คืนเครื่องที่ติดตั้งไม่ได้เข้า LBS Inventory ก่อนปิดงาน']])
    expect(W(d, 'owner').map(w => w.key)).toEqual(['job:j1'])
  })
})

describe('รีวิวเฟส 3 · ข้อ 3 — เวลาที่ว่าง/ผิดรูปไม่ทำให้หน้าล่ม', () => {
  it('bkkDate: ค่าว่าง/ผิดรูป = "" (ไม่ throw RangeError)', () => {
    expect(bkkDate('2026-11-22T20:00:00.000Z')).toBe('2026-11-23')
    expect(bkkDate('')).toBe('')
    expect(bkkDate('not-a-date')).toBe('')
    expect(bkkDate(undefined as unknown as string)).toBe('')
  })
  it('myWork: ของคืนที่ไม่มีเวลาขอ ยังขึ้นได้ (ค้าง 0 วัน)', () => {
    const d: DB = { ...sc('ready').db,
      stockReturns: [{ id: 'sr', requestId: 'r1', jobId: 'j1', itemId: 'i1', kind: 'return', qty: 1, status: 'pending', requestedAt: '' }] }
    expect(() => myWork(d, USERS.purchasing, TODAY)).not.toThrow()
    expect(myWork(d, USERS.purchasing, TODAY)).toEqual([expect.objectContaining({ key: 'ret:sr', waitingDays: 0 })])
  })
})

describe('รีวิวเฟส 3 · ข้อ 4 — ตัวกรองหน้า Jobs ใช้กติกาเดียวกับป้าย "ของฉัน"', () => {
  const row = (over: Partial<Job> = {}) => { const j = job(over); const d = db({ jobs: [j] }); return { job: j, status: 'draft' as const, d: jobDelivery(d, j, TODAY) } }
  it('"เฉพาะงานของฉัน": ใบเก่าที่ไม่มีผู้เปิด (ownsJob = ของทุกคน) ต้องอยู่ในรายการ · ใบของ Project คนอื่นไม่อยู่', () => {
    expect(jobListMatches(row(), 'all', true, USERS.owner)).toBe(true)
    expect(jobListMatches(row({ openedBy: undefined }), 'all', true, USERS.other)).toBe(true)
    expect(jobListMatches(row(), 'all', true, USERS.other)).toBe(false)
    expect(jobListMatches(row(), 'all', false, USERS.other)).toBe(true)
  })
  it('ตัวกรองสถานะเดิมไม่เปลี่ยน: active ไม่รวมงานจบ · at_risk ใช้ d.atRisk · สถานะตรงตัว', () => {
    expect(jobListMatches({ ...row(), status: 'installed' }, 'active', false, USERS.owner)).toBe(false)
    expect(jobListMatches(row(), 'active', false, USERS.owner)).toBe(true)
    expect(jobListMatches(row(), 'draft', false, USERS.owner)).toBe(true)
    expect(jobListMatches(row(), 'allocated', false, USERS.owner)).toBe(false)
    const r = row()
    expect(jobListMatches({ ...r, d: { ...r.d, atRisk: true } }, 'at_risk', false, USERS.owner)).toBe(true)
    expect(jobListMatches({ ...r, d: { ...r.d, atRisk: false } }, 'at_risk', false, USERS.owner)).toBe(false)
  })
})

// =============================================================================
// เฟส 4 (2026-11-23) — Purchasing: คิวรอออก PO / รอรับของ (ค้างนานก่อน) · ป้าย PR บางส่วน · รับของ
// =============================================================================
describe('เฟส 4 · คิว Purchasing', () => {
  const pr = (id: string, createdAt: string, status: DB['prs'][number]['status'] = 'pending'): DB['prs'][number] =>
    ({ id, prNo: id.toUpperCase(), jobId: 'j1', status, requestIds: [], createdBy: 'u-p', createdAt })
  const po = (id: string, createdAt: string, status: DB['pos'][number]['status'] = 'issued'): DB['pos'][number] =>
    ({ id, poNo: id.toUpperCase(), prId: 'p1', jobId: 'j1', supplierName: 'ซัพ', expectedDate: '2026-11-30', status, createdBy: 'u-pur', createdAt })

  it('PR รอออก PO: รวมใบที่ออก PO ไปบางส่วนแล้ว (ยังมีบรรทัดรอ) · ไม่รวมใบที่สั่งครบ/ตีกลับ · ค้างนานก่อน', () => {
    const d = db({ jobs: [job()],
      prs: [pr('p1', '2026-11-20T03:00:00Z'), pr('p2', '2026-11-05T03:00:00Z', 'po_issued'), pr('p3', '2026-11-01T03:00:00Z', 'po_issued'),
        pr('p4', '2026-11-02T03:00:00Z', 'rejected')],
      accessoryRequests: [acc('a', { prId: 'p1', status: 'pr_sent' }), acc('b', { prId: 'p2', status: 'pr_sent' }),
        acc('c', { prId: 'p2', status: 'po_ordered' }), acc('d', { prId: 'p3', status: 'po_ordered' })],
    })
    expect(prsAwaitingPo(d, TODAY).map(x => [x.pr.id, x.openLines, x.waitingDays])).toEqual([['p2', 1, 18], ['p1', 1, 3]])
  })

  it('PO รอรับของ: เฉพาะ issued · ค้างนานก่อน · บอกเลยกำหนดส่งของกี่วัน', () => {
    const d = db({ jobs: [job()], pos: [po('o1', '2026-11-10T03:00:00Z'), po('o2', '2026-11-02T03:00:00Z'), po('o3', '2026-11-01T03:00:00Z', 'received')] })
    expect(posAwaitingGoods(d, TODAY).map(x => [x.po.id, x.waitingDays, x.lateDays])).toEqual([['o2', 21, 0], ['o1', 13, 0]])
    const late: DB = { ...d, pos: [po('o1', '2026-11-10T03:00:00Z')].map(p => ({ ...p, expectedDate: '2026-11-20' })) }
    expect(posAwaitingGoods(late, TODAY)[0].lateDays).toBe(3)
  })

  it('งานของฉัน (Purchasing) นับ PR ที่ออก PO บางส่วนแล้วด้วย — เดิมนับแค่ pending', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a', { planPoReceiptDate: '2026-12-15' }), unit('b', { planPoReceiptDate: '2026-12-15' })],
      prs: [pr('p2', '2026-11-05T03:00:00Z', 'po_issued')],
      accessoryRequests: [acc('b', { prId: 'p2', status: 'pr_sent' }), acc('c', { prId: 'p2', status: 'po_ordered', poId: 'o9' })] })
    expect(myWork(d, USERS.purchasing, TODAY).map(w => w.key)).toEqual(['pr:p2'])
  })

  it('ป้ายสถานะ PR: ออก PO บางส่วน (ยังมีบรรทัดรอ) ≠ ออก PO แล้ว รอรับของ', () => {
    const d = db({ prs: [pr('p2', T, 'po_issued'), pr('p3', T, 'po_issued'), pr('p1', T)],
      accessoryRequests: [acc('b', { prId: 'p2', status: 'pr_sent' }), acc('c', { prId: 'p2', status: 'po_ordered' }), acc('d', { prId: 'p3', status: 'po_ordered' })] })
    expect(prStatusLabel(d, d.prs[0])).toBe('ออก PO บางส่วน · รอออก PO อีก 1 รายการ')
    expect(prStatusLabel(d, d.prs[1])).toBe('ออก PO แล้ว รอรับของ')
    expect(prStatusLabel(d, d.prs[2])).toBe('รอ Purchasing ออก PO')
  })
})

describe('เฟส 4 · รับของ — ส่งเฉพาะบรรทัดที่ยังค้างรับ', () => {
  const lines = [{ id: 'a', remaining: 5 }, { id: 'b', remaining: 2 }]
  it('🔴 ค่าที่กรอกค้างของบรรทัดที่หลุดจากตารางแล้ว (แก้จำนวนจนจบ) ต้องไม่ถูกส่ง', () => {
    expect(pendingReceipts({ a: '3', gone: '5' }, lines)).toEqual({ receipts: [{ requestId: 'a', qty: 3 }], over: [] })
  })
  it('ช่องว่าง/0 ไม่ส่ง · เกินจำนวนค้างรับ = รายการ over (ปุ่มบันทึกต้องปิด)', () => {
    expect(pendingReceipts({ a: '', b: '0' }, lines)).toEqual({ receipts: [], over: [] })
    expect(pendingReceipts({ a: '6', b: '2' }, lines)).toEqual({ receipts: [{ requestId: 'a', qty: 6 }, { requestId: 'b', qty: 2 }], over: ['a'] })
  })
})

// =============================================================================
// รีวิวเฟส 4 (2026-11-23)
// =============================================================================
describe('รีวิวเฟส 4 · ข้อ 1 — ตัวนับ Purchasing ชุดเดียวทุกหน้า (Dashboard · เมนู · หน้า Purchasing)', () => {
  it('🔴 PR ที่ออก PO บางส่วน (ยังมีบรรทัดรอ) นับเป็น "PR รอออก PO" · PO issued นับเป็นรอรับของ', () => {
    const d = db({ jobs: [job()],
      prs: [{ id: 'p1', prNo: 'PR-1', jobId: 'j1', status: 'po_issued', requestIds: [], createdBy: 'u-p', createdAt: T },
        { id: 'p2', prNo: 'PR-2', jobId: 'j1', status: 'pending', requestIds: [], createdBy: 'u-p', createdAt: T }],
      pos: [{ id: 'o1', poNo: 'PO-1', prId: 'p1', jobId: 'j1', supplierName: 'S', expectedDate: '2026-12-01', status: 'issued', createdBy: 'u-pur', createdAt: T }],
      accessoryRequests: [acc('a', { prId: 'p1', status: 'pr_sent' }), acc('b', { prId: 'p1', status: 'po_ordered', poId: 'o1' }), acc('c', { prId: 'p2', status: 'pr_sent' })] })
    expect(purchasingCounts(d)).toEqual({ prAwaitingPo: 2, poAwaitingGoods: 1 })
  })
})

describe('รีวิวเฟส 4 · ข้อ 3 — ตัวกรองไม่มี Contract No.: กาง/พับคลังได้', () => {
  const base = { openStock: null, collapsed: new Set<string>(), filterOn: true, hasMatches: true }
  it('ตัวกรองเปิด + มีเครื่องเข้าเงื่อนไข = กางเอง · 🔴 พับได้ (เดิมพับไม่ได้จนล้างตัวกรอง)', () => {
    expect(stockPanelOpen('s1', base)).toBe(true)
    expect(stockPanelOpen('s1', { ...base, collapsed: new Set(['s1']) })).toBe(false)
  })
  it('ตัวกรองปิด = กางเฉพาะคลังที่กดเปิด · คลังที่ไม่มีเครื่องเข้าเงื่อนไข = ไม่กางเอง', () => {
    expect(stockPanelOpen('s1', { ...base, filterOn: false })).toBe(false)
    expect(stockPanelOpen('s1', { ...base, filterOn: false, openStock: 's1' })).toBe(true)
    expect(stockPanelOpen('s1', { ...base, hasMatches: false })).toBe(false)
    expect(stockPanelOpen('s1', { ...base, hasMatches: false, openStock: 's1' })).toBe(true)
  })
})

// =============================================================================
// รีวิว Flow งานทีม LBS ทั้งระบบ (2026-11-24)
//   ข้อ 2: ขั้น "Division กรอก Contract No." ไม่ขึ้นในคิวใคร — Job ขึ้นให้ Project ดึงทั้งที่ไม่มีเครื่องให้ดึง
//   ข้อ 3: "มอบหมายทีมช่าง" ในงานของฉัน ใช้กติกาคนละชุดกับป้ายเมนู (jobNeedsTeam)
//   ข้อ 4: ด่านเปิดงานใหม่/ขอแก้ข้อมูล อ่านนาฬิกาจริง ไม่ใช้ today ที่ส่งมา
// =============================================================================
describe('รีวิว Flow ทั้งระบบ (2026-11-24)', () => {
  const noContract = sc('draft_no_contract').db

  it('ข้อ 2: ไม่มีเครื่องว่างที่มี Contract No. → ขั้นต่อไปเป็นของ Division · ปุ่มดึงบอกเหตุผล · งานของฉันของ Division ลิงก์ไปกรองคลัง', () => {
    expect(jobNextStep(noContract, J(noContract), TODAY)).toMatchObject({ title: 'รอ Division เตรียม LBS ที่มี Contract No.', who: ['sales'] })
    const g = jobAction(noContract, J(noContract), USERS.owner, 'draw_lbs', TODAY).gate
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.reason).toContain('Contract No.')
    expect(myWork(noContract, USERS.division, TODAY)).toEqual([expect.objectContaining({ key: 'job:j1', link: '/stocks?f=no_contract' })])
    expect(myWork(noContract, USERS.owner, TODAY)).toEqual([])
  })

  it('ข้อ 2: ดึงไปบางส่วนแล้ว ที่เหลือไม่มีเครื่องให้ดึง → Division เช่นกัน', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a')] })
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({ who: ['sales'] })
  })

  it('ข้อ 2: มีเครื่องที่มี Contract No. (คลังเปิด) → Project ดึงได้ตามเดิม · คลังที่ปิดแล้วไม่นับ', () => {
    const d = sc('draft').db
    expect(jobNextStep(d, J(d), TODAY)).toMatchObject({ title: 'ดึง LBS เข้างาน', who: ['project'] })
    expect(jobAction(d, J(d), USERS.owner, 'draw_lbs', TODAY).gate.ok).toBe(true)
    const closed: DB = { ...d, projectStocks: [{ id: 's1', stockNo: 'ST-1', itemId: 'i', status: 'closed', createdBy: 'u', createdAt: T }] }
    expect(jobNextStep(closed, J(closed), TODAY)).toMatchObject({ who: ['sales'] })
  })

  it('ข้อ 3: "มอบหมายทีมช่าง" ในงานของฉันของ Service ตรงกับป้ายเมนู (jobNeedsTeam) ทุกฉาก', () => {
    // ใบเบิกบางส่วน: เครื่องที่ออกไปติดตั้งครบแล้ว · อีกเครื่องรอเบิกรอบสอง · ยังไม่มีทีม
    const d = db({ jobs: [job({ installStartDate: '2026-11-20', installEndDate: '2026-11-30' })],
      lbsUnits: [unit('a', { status: 'issued' }), unit('b')], unitInstallations: [inst('a', 'installed')] })
    // 🔴 ฉากที่สองกติกาต่างกันจริง: ติดตั้งไม่ได้ 1 + อีกเครื่องที่ออกไปแล้วยังรอติดตั้ง · ไม่มีทีม
    //    (ตัวอย่างเดิมในรีวิว "เบิกบางส่วน" ไม่ต่าง — เครื่องที่ยังไม่เบิกนับเป็นรอติดตั้ง สถานะยังเป็น installing)
    const blockedPending = db({ jobs: [job({ ...fieldJob })],
      lbsUnits: [unit('a', { status: 'issued' }), unit('b', { status: 'issued' })], unitInstallations: [inst('a', 'blocked')] })
    const cases: [string, DB][] = [['partial', d], ['blocked_pending', blockedPending], ...SCENARIOS.map(s => [s.key, s.db] as [string, DB])]
    for (const [key, x] of cases) {
      const fromMenu = unassignedJobs(x).map(j => `job:${j.id}`)
      const fromWork = myWork(x, USERS.service, TODAY).filter(w => w.title === 'มอบหมายทีมช่าง').map(w => w.key)
      expect(fromWork, key).toEqual(fromMenu)
    }
    expect(unassignedJobs(d).map(j => j.id)).toEqual(['j1'])
    expect(unassignedJobs(blockedPending).map(j => j.id)).toEqual(['j1'])
  })

  it('ข้อ 1: ใบเบิกบางส่วน + เครื่องที่ออกไปติดตั้งไม่ได้ → ปุ่มขอคืนกดไม่ได้พร้อมเหตุผล · ขั้นต่อไปไม่สั่งให้ขอคืนตอนนี้', () => {
    const d = db({ jobs: [job({ installStartDate: '2026-11-20', installEndDate: '2026-11-30' })],
      lbsUnits: [unit('a', { status: 'issued' }), unit('b')], unitInstallations: [inst('a', 'blocked')] })
    for (const who of ['service', 'owner'] as const) {
      const g = jobAction(d, J(d), USERS[who], 'return_issued_lbs', TODAY).gate
      expect(g.ok, who).toBe(false)
      if (!g.ok) expect(g.reason).toMatch(/ครบใบ/)
    }
    expect(jobNextStep(d, J(d), TODAY).detail).toMatch(/หลังเบิกของที่เหลือครบใบ/)
    // เบิกครบใบแล้ว (ฉาก blocked) = ขอคืนได้ตามเดิม
    expect(gateOf('blocked', 'service', 'return_issued_lbs').ok).toBe(true)
  })

  it('ข้อ 4: ด่านเปิดงานใหม่/ขอแก้ข้อมูล ใช้ today ที่ส่งเข้ามา', () => {
    const d = db({ jobs: [job({ ...fieldJob, terminalStatus: 'installed', installedAt: T })],
      jobWarranties: [{ id: 'w', jobId: 'j1', kind: 'installation', startDate: '2026-12-01', endDate: '2027-11-30', createdAt: T }] })
    expect(jobAction(d, J(d), USERS.owner, 'reopen_job', '2026-12-05').gate.ok).toBe(false)
    expect(jobAction(d, J(d), USERS.owner, 'correct_closeout', '2026-12-05').gate.ok).toBe(true)
    expect(jobAction(d, J(d), USERS.owner, 'reopen_job', '2026-11-20').gate.ok).toBe(true)
  })
})
