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
  JOB_ACTION_ORDER, type JobActionKey,
} from './flow'
import { jobDelivery, jobInstallSummary, jobStatusPhase, memberSchedule } from './logic'

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
const fieldJob = { terminalStatus: 'issued' as const, issuedAt: T, installStartDate: '2026-11-20', installEndDate: '2026-11-30' }
const SCENARIOS: { key: string; name: string; db: DB }[] = [
  { key: 'draft', name: 'Draft — ยังไม่ดึง LBS', db: db({ jobs: [job()] }) },
  { key: 'allocated', name: 'ดึง LBS แล้ว 1/2 เครื่อง', db: db({
    jobs: [job()], lbsUnits: [unit('a')], allocations: [{ id: 'al', jobId: 'j1', projectStockId: 's1', txnType: 'draw', serialNos: ['LVB-a'], performedBy: 'u-p', performedAt: T }],
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
    const d = db({ jobs: [job()], lbsUnits: [unit('a')], accessoryRequests: [issuedAcc] })
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
    const d = db({ jobs: [job()], lbsUnits: [unit('a')], accessoryRequests: [issuedAcc, prSent] })
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
      if (!g.ok) expect(g.reason).toBe('J-001 เบิกของให้ Service ไปแล้วบางส่วน — ยกเลิกไม่ได้ ให้ Service คืนของเข้าคลังก่อน แล้วให้ Manage จัดการเป็นเคส')
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
