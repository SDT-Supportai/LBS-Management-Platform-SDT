// =============================================================================
// เฟส 6 (2026-11-24) — ผู้ดูแลระบบ: Users & Settings · Audit
// =============================================================================
import { describe, it, expect } from 'vitest'
import type { DB, User, Job, AuditLog } from '../types'
import { updateUser } from './logic'
import { PERMISSIONS } from './permissions'
import { userOpenWork, deptPermissionLabels, PERM_LABEL, userEditBlock } from './admin'
import {
  filterAuditLogs, auditRangeIso, auditLink, AUDIT_ENTITY_LABEL, auditTypeOptions, auditTypesFor,
  createAuditSearch, type AuditFilter, type AuditSearchState,
} from './audit'
import { fetchAuditLogs } from './remote'

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
const U = (id: string, department: User['department'], isActive = true): User =>
  ({ id, email: `${id}@x.co`, password: 'x', fullName: id, department, isActive })
const job = (id: string, over: Partial<Job> = {}): Job => ({
  id, jobNo: `J-${id}`, customerName: 'กฟภ.', scope: 'LBS', installLocation: 'A', requiredDate: '2026-12-31',
  lbsQtyRequired: 1, terminalStatus: null, openedBy: 'p1', createdAt: T, ...over,
})
const edit = (u: User, over: Partial<{ department: User['department']; isActive: boolean }> = {}) =>
  ({ userId: u.id, fullName: u.fullName, department: over.department ?? u.department, isActive: over.isActive ?? u.isActive })

describe('ผู้ใช้: กันล็อกตัวเองออกจากระบบ', () => {
  const a1 = U('a1', 'admin'), a2 = U('a2', 'admin'), p1 = U('p1', 'project')
  it('🔴 เปลี่ยนแผนกของบัญชีตัวเองไม่ได้ (เดิมกันแค่ปิดบัญชีตัวเอง — Manage ลดตัวเองเป็น Project แล้วกลับมาแก้ไม่ได้)', () => {
    const db = { ...EMPTY, users: [a1, a2, p1] }
    expect(() => updateUser(db, a1, edit(a1, { department: 'project' }))).toThrow(/แผนกของบัญชีตัวเอง/)
    expect(() => updateUser(db, a1, edit(a1, { isActive: false }))).toThrow(/บัญชีตัวเอง/)
    // แก้ชื่อตัวเองยังได้
    expect(updateUser(db, a1, { ...edit(a1), fullName: 'ชื่อใหม่' }).users.find(u => u.id === 'a1')?.fullName).toBe('ชื่อใหม่')
  })
  it('🔴 ต้องเหลือ Manage ที่ใช้งานได้อย่างน้อย 1 บัญชี — ลด/ปิดคนสุดท้ายไม่ได้', () => {
    const inactiveA2 = { ...a2, isActive: false }
    const db = { ...EMPTY, users: [a1, inactiveA2, p1] }
    // a2 (ปิดอยู่) ไม่นับ ⇒ a1 คือคนสุดท้าย — สมมติให้ a2 เปิดอยู่แล้วลด a1 ผ่าน a2
    const db2 = { ...EMPTY, users: [a1, a2, p1] }
    expect(updateUser(db2, a2, edit(a1, { department: 'sales' })).users.find(u => u.id === 'a1')?.department).toBe('sales')
    // เหลือ a2 คนเดียว: ใครก็ลด a2 ไม่ได้ (Manage อีกคนถูกปิดไปแล้ว)
    const db3 = { ...EMPTY, users: [{ ...a1, isActive: false }, a2, p1] }
    expect(() => updateUser(db3, a2, edit(a2, { department: 'sales' }))).toThrow()
    expect(db.users.length).toBe(3)
  })
})

describe('ปิดบัญชี: บอกงานและคำขอที่ค้างของบัญชีนั้นก่อน', () => {
  it('Job ที่เปิดไว้และยังไม่จบ · คำขอรอ Division พิจารณา · ช่างที่ผูกบัญชีและงานที่ถืออยู่', () => {
    const db: DB = {
      ...EMPTY,
      users: [U('p1', 'project'), U('s1', 'service')],
      jobs: [job('j1'), job('j2', { terminalStatus: 'installed' }), job('j3', { terminalStatus: 'cancelled' }), job('j4', { openedBy: 'other', terminalStatus: 'issued' })],
      approvalRequests: [
        { id: 'r1', type: 'create_pr', status: 'pending', jobId: 'j1', requestedBy: 'p1', requestedAt: T, payload: {} },
        { id: 'r2', type: 'create_pr', status: 'approved', jobId: 'j1', requestedBy: 'p1', requestedAt: T, payload: {} },
      ] as unknown as DB['approvalRequests'],
      teamMembers: [{ id: 'm1', firstName: 'ช่าง', lastName: 'ก', phone: '0', position: 'ช่าง', isActive: true, createdAt: T, userId: 's1' }],
      jobAssignments: [{ id: 'as1', jobId: 'j4', memberId: 'm1', isLead: true, assignedBy: 'x', assignedAt: T }],
    }
    const w = userOpenWork(db, 'p1')
    expect(w.jobs.map(j => j.jobNo)).toEqual(['J-j1'])
    expect(w.requests.map(r => r.id)).toEqual(['r1'])
    expect(w.total).toBe(2)
    const s = userOpenWork(db, 's1')
    expect(s.member?.id).toBe('m1')
    expect(s.memberJobs.map(j => j.jobNo)).toEqual(['J-j4'])
    expect(s.total).toBe(1)
  })
})

describe('ป้ายสิทธิ์สร้างจากตารางสิทธิ์จริง (permissions.ts)', () => {
  it('🔴 ทุกสิทธิ์ในตารางมีคำอธิบาย — เพิ่มสิทธิ์ใหม่แล้วลืมเขียนป้าย = เทสต์ล้ม (เดิมเขียนมือแยก ตกหล่นได้)', () => {
    for (const k of Object.keys(PERMISSIONS)) expect(PERM_LABEL[k as keyof typeof PERM_LABEL], k).toBeTruthy()
  })
  it('VIP = ความเห็นบนคำขอ + รายงาน · Manage = ทุกสิทธิ์', () => {
    expect(deptPermissionLabels('vip')).toEqual([PERM_LABEL['approval.comment'], PERM_LABEL['report.exec']])
    expect(deptPermissionLabels('admin').length).toBe(Object.keys(PERMISSIONS).length)
    expect(deptPermissionLabels('purchasing')).toContain(PERM_LABEL['purchasing.manage'])
    expect(deptPermissionLabels('purchasing')).not.toContain(PERM_LABEL['approval.decide'])
  })
})

describe('🔴 Audit LIVE: ค้นที่ฐานข้อมูลตามช่วงวันที่ (เดิมค้นแค่ 500 รายการล่าสุดที่โหลดมา)', () => {
  const stub = (rows: Record<string, unknown>[]) => {
    const c: Record<string, unknown[]> = {}
    const client = {
      from(t: string) {
        expect(t).toBe('audit_logs')
        const b = {
          select() { return b },
          gte(col: string, v: string) { c.gte = [col, v]; return b },
          lt(col: string, v: string) { c.lt = [col, v]; return b },
          lte(col: string, v: string) { c.lte = [col, v]; return b },
          eq(col: string, v: string) { (c.eq ??= []).push([col, v]); return b },
          in(col: string, v: string[]) { c.in = [col, v]; return b },
          or(s: string) { c.or = [s]; return b },
          order(col: string, o: unknown) { (c.order ??= []).push([col, o]); return b },
          range(a: number, z: number) { c.range = [a, z]; return Promise.resolve({ data: rows.slice(a, z + 1), error: null }) },
        }
        return b
      },
    }
    return { client, c }
  }
  const row = (i: number) => ({ id: 'a' + i, entity_type: 'job', entity_id: 'j1', action: 'x', actor_id: 'u1', detail: 'd', created_at: T })
  it('ส่งช่วงเวลาไทย · ผู้ทำ · ประเภท · ข้อความ (ตัดอักขระที่ทำให้ตัวกรองพัง) · หน้าละ n แถว · บอกว่ายังมีต่อไหม', async () => {
    const { client, c } = stub(Array.from({ length: 3 }, (_, i) => row(i)))
    const r = await fetchAuditLogs(client as never, { from: '2026-11-10', to: '2026-11-10', actorId: 'u1', entityType: 'job', q: 'PO-001,(x)' }, { limit: 2 })
    expect(c.gte).toEqual(['created_at', '2026-11-09T17:00:00.000Z'])
    expect(c.lt).toEqual(['created_at', '2026-11-10T17:00:00.000Z'])
    expect(c.eq).toEqual([['actor_id', 'u1']])
    expect(c.in).toEqual(['entity_type', ['job']])
    expect(c.or).toEqual(['detail.ilike.%PO-001 x%,action.ilike.%PO-001 x%'])
    expect(c.order).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]])
    expect(c.range).toEqual([0, 2])                          // ขอเกิน 1 แถวเพื่อรู้ว่ายังมีหน้าถัดไป
    expect(c.lte).toBeUndefined()
    expect(r.logs.map(l => l.id)).toEqual(['a0', 'a1'])
    expect(r.hasMore).toBe(true)
  })
  it('🔴 #2 หน้าถัดไปอ้างเวลาของแถวสุดท้าย (ไม่ใช้ offset — มีรายการใหม่เข้ามาระหว่างโหลดแล้วแถวซ้ำ)', async () => {
    const { client, c } = stub([row(0)])
    await fetchAuditLogs(client as never, {}, { limit: 2, before: '2026-11-05T01:02:03.000Z' })
    expect(c.lte).toEqual(['created_at', '2026-11-05T01:02:03.000Z'])
    expect(c.range).toEqual([0, 2])
  })
  it('🔴 #3 คำค้นเป็นรหัสข้อมูล (UUID) = ค้นรหัสด้วย (เดิมบนเดโมเจอ บน LIVE ไม่เจอ)', async () => {
    const { client, c } = stub([])
    const id = '3c45bba8-e4fa-4cc4-b1fe-fb59b67a7f65'
    await fetchAuditLogs(client as never, { q: ` ${id.toUpperCase()} ` }, { limit: 2 })
    expect(c.or).toEqual([`entity_id.eq.${id},detail.ilike.%${id.toUpperCase()}%,action.ilike.%${id.toUpperCase()}%`])
  })
  it('🔴 #5 ประเภทที่ชื่อซ้ำ (วัสดุของ Job 2 ชนิด) ส่งไปค้นพร้อมกัน', async () => {
    const { client, c } = stub([])
    await fetchAuditLogs(client as never, { entityType: 'job_accessory_request' }, { limit: 2 })
    expect(c.in).toEqual(['entity_type', ['job_accessory_request', 'accessory_request']])
  })
})

describe('🔴 #1/#2 ตัวคุมการค้น Audit: ผลของการค้นเก่าไม่ทับผลใหม่ · โหลดเพิ่มไม่ซ้ำ', () => {
  const L = (id: string, createdAt = T): AuditLog => ({ id, entityType: 'job', entityId: 'j', action: 'a', actorId: 'u', detail: id, createdAt })
  const deferred = () => { let res!: (v: { logs: AuditLog[]; hasMore: boolean }) => void; const p = new Promise<{ logs: AuditLog[]; hasMore: boolean }>(r => { res = r }); return { p, res } }
  it('ค้นครั้งแรกตอบช้ากว่าครั้งที่สอง = เก็บผลครั้งที่สอง · ระหว่างค้นไม่โชว์ผลเก่า', async () => {
    const calls: { f: AuditFilter; d: ReturnType<typeof deferred> }[] = []
    const states: AuditSearchState[] = []
    const s = createAuditSearch((f) => { const d = deferred(); calls.push({ f, d }); return d.p }, st => states.push(st), 2)
    const p1 = s.search({ q: 'พฤศจิกายน' })
    expect(states[states.length - 1]).toMatchObject({ rows: [], loading: true })
    const p2 = s.search({ q: '10 พ.ย.' })
    calls[1].d.res({ logs: [L('new')], hasMore: false }); await p2
    calls[0].d.res({ logs: [L('old')], hasMore: true }); await p1
    expect(states[states.length - 1]).toMatchObject({ rows: [L('new')], hasMore: false, loading: false })
  })
  it('โหลดเพิ่มต่อจากเวลาของแถวสุดท้าย · ตัดแถวซ้ำ · ค้นใหม่ระหว่างโหลดเพิ่ม = ทิ้งผลโหลดเพิ่ม', async () => {
    const calls: { page: { before?: string }; d: ReturnType<typeof deferred> }[] = []
    let last: AuditSearchState | undefined
    const s = createAuditSearch((_f, page) => { const d = deferred(); calls.push({ page, d }); return d.p }, st => { last = st }, 2)
    const p1 = s.search({}); calls[0].d.res({ logs: [L('a', '2026-11-05T03:00:00Z'), L('b', '2026-11-05T02:00:00Z')], hasMore: true }); await p1
    const p2 = s.more()
    expect(calls[1].page.before).toBe('2026-11-05T02:00:00Z')
    calls[1].d.res({ logs: [L('b', '2026-11-05T02:00:00Z'), L('c', '2026-11-05T01:00:00Z')], hasMore: false }); await p2
    expect(last?.rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
    // โหลดเพิ่มค้าง แล้วผู้ใช้ค้นใหม่
    const p3 = s.search({ q: 'x' }); const p4Calls = calls.length
    calls[p4Calls - 1].d.res({ logs: [L('x')], hasMore: true }); await p3
    const p5 = s.more(); const p6 = s.search({ q: 'y' })
    calls[calls.length - 2].d.res({ logs: [L('stale-more')], hasMore: false }); await p5
    calls[calls.length - 1].d.res({ logs: [L('y')], hasMore: false }); await p6
    expect(last?.rows.map(r => r.id)).toEqual(['y'])
  })
  it('error ของการค้นเก่าไม่โผล่ทับผลใหม่', async () => {
    let n = 0; let last: AuditSearchState | undefined
    let rejectOld!: (e: Error) => void
    const s = createAuditSearch(() => ++n === 1 ? new Promise((_r, j) => { rejectOld = j }) : Promise.resolve({ logs: [L('ok')], hasMore: false }), st => { last = st }, 2)
    const p1 = s.search({}); await s.search({ q: 'b' })
    rejectOld(new Error('timeout')); await p1
    expect(last).toMatchObject({ error: null, rows: [L('ok')] })
  })
})

describe('🔴 #5 ตัวเลือกประเภทข้อมูลไม่ซ้ำชื่อ · ชื่อเดียวกันกรองครบทุกชนิด', () => {
  it('ป้ายไม่ซ้ำ · "วัสดุของ Job" ครอบ 2 ชนิด · "ผู้ใช้" ครอบ user/profile', () => {
    const opts = auditTypeOptions(['mystery'])
    expect(new Set(opts.map(o => o.label)).size).toBe(opts.length)
    expect(opts.find(o => o.label === 'วัสดุของ Job')?.types.sort()).toEqual(['accessory_request', 'job_accessory_request'])
    expect(auditTypesFor('profile').sort()).toEqual(['profile', 'user'])
    expect(opts.some(o => o.key === 'mystery')).toBe(true)
  })
})

describe('🔴 #6 กติกาแก้ผู้ใช้ชุดเดียว — หน้าจอรู้ก่อนถามยืนยัน (เดิมถามยืนยันแล้วค่อยเจอ error)', () => {
  const a1 = U('a1', 'admin'), a2 = U('a2', 'admin'), p1 = U('p1', 'project')
  it('เหตุผลเดียวกับ updateUser: ตัวเองเปลี่ยนแผนก/ปิด · Manage คนสุดท้าย · ปกติ = null', () => {
    const db = { ...EMPTY, users: [a1, { ...a2, isActive: false }, p1] }
    const cases: [User, User, Partial<{ department: User['department']; isActive: boolean }>][] = [
      [a1, a1, { department: 'project' }], [a1, a1, { isActive: false }], [a2, a1, { department: 'sales' }],
    ]
    for (const [actor, target, over] of cases) {
      const reason = userEditBlock(db, actor, target, { department: over.department ?? target.department, isActive: over.isActive ?? target.isActive })
      expect(reason).toBeTruthy()
      expect(() => updateUser(db, actor, edit(target, over))).toThrow(reason!)
    }
    expect(userEditBlock(db, a1, p1, { department: 'sales', isActive: false })).toBeNull()
  })
})

describe('Audit: ค้นตามช่วงวันที่ (เวลาไทย) · ลิงก์ไปหน้าที่ตรงกับข้อมูล', () => {
  const log = (id: string, createdAt: string, over: Partial<AuditLog> = {}): AuditLog =>
    ({ id, entityType: 'job', entityId: 'j1', action: 'create_job', actorId: 'p1', detail: `รายการ ${id}`, createdAt, ...over })
  const logs = [
    log('a', '2026-11-09T16:59:00.000Z'),                          // = 9 พ.ย. 23:59 น. เวลาไทย
    log('b', '2026-11-09T17:00:00.000Z'),                          // = 10 พ.ย. 00:00 น.
    log('c', '2026-11-20T10:00:00.000Z', { entityType: 'purchase_order', actorId: 'u2', detail: 'ออก PO-001' }),
  ]
  it('🔴 ช่วงวันที่นับตามเวลาไทย (ขอบวัน 00:00 น. = 17:00 UTC วันก่อน)', () => {
    expect(filterAuditLogs(logs, { from: '2026-11-10' }).map(l => l.id)).toEqual(['b', 'c'])
    expect(filterAuditLogs(logs, { to: '2026-11-09' }).map(l => l.id)).toEqual(['a'])
    expect(filterAuditLogs(logs, { from: '2026-11-10', to: '2026-11-10' }).map(l => l.id)).toEqual(['b'])
    expect(auditRangeIso('2026-11-10', '2026-11-10')).toEqual({ gte: '2026-11-09T17:00:00.000Z', lt: '2026-11-10T17:00:00.000Z' })
    expect(auditRangeIso(undefined, undefined)).toEqual({})
  })
  it('ค้นข้อความ (ไม่สนตัวพิมพ์) · ผู้ทำ · ประเภทข้อมูล', () => {
    expect(filterAuditLogs(logs, { q: 'po-001' }).map(l => l.id)).toEqual(['c'])
    expect(filterAuditLogs(logs, { actorId: 'u2' }).map(l => l.id)).toEqual(['c'])
    expect(filterAuditLogs(logs, { entityType: 'job' }).map(l => l.id)).toEqual(['a', 'b'])
  })
  it('🔴 ลิงก์ตามประเภทข้อมูล — งวดเงิน/คำขอวัสดุไปหน้า Job ของมัน · ประเภทที่ไม่รู้จัก = ไม่มีลิงก์', () => {
    const db: DB = { ...EMPTY,
      jobPayments: [{ id: 'pay1', jobId: 'j9' } as unknown as DB['jobPayments'][number]],
      accessoryRequests: [{ id: 'ar1', jobId: 'j8' } as unknown as DB['accessoryRequests'][number]] }
    expect(auditLink(log('x', T), db)).toBe('/jobs/j1')
    expect(auditLink(log('x', T, { entityType: 'job_payment', entityId: 'pay1' }), db)).toBe('/jobs/j9')
    expect(auditLink(log('x', T, { entityType: 'job_accessory_request', entityId: 'ar1' }), db)).toBe('/jobs/j8')
    expect(auditLink(log('x', T, { entityType: 'purchase_order' }), db)).toBe('/purchasing')
    expect(auditLink(log('x', T, { entityType: 'std_bom' }), db)).toBe('/standards')
    expect(auditLink(log('x', T, { entityType: 'team_member' }), db)).toBe('/scheduling')
    expect(auditLink(log('x', T, { entityType: 'mystery' }), db)).toBeNull()
    expect(AUDIT_ENTITY_LABEL.purchase_order).toBeTruthy()
  })
})
