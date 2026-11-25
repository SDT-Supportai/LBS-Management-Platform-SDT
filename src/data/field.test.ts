// =============================================================================
// เฟส 5 (2026-11-23) — งานหน้างาน: Site Installation (มือถือ) · Assignment & Schedule · Warranty
// ตรรกะล้วนอยู่ที่ src/data/field.ts · หมุดแผนที่อยู่ที่ src/data/mapPins.ts
// =============================================================================
import { describe, it, expect } from 'vitest'
import type { DB, Job, LbsUnit, User, UnitInstallation, TeamMember, JobWarranty } from '../types'
import {
  jobNeedsTeam, unassignedJobs, memberDeleteBlock, todayFieldJobs, distanceMeters, gpsQuality, fitWithin,
  mapsUrl, safeHttpUrl, scheduleAgenda,
  parseDraftStore, serializeDraftStore, putDraft, removeDraft, getDraft, draftHasContent, resumableDraft, type ConfirmDraft,
  createLatestGuard, docTypeForJob,
  warrantyRowMatches, warrantyCounts, warrantyMatches, type WarrantyRow,
} from './field'

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
const db = (over: Partial<DB>): DB => ({ ...EMPTY, ...over })
const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', jobNo: 'J-001', customerName: 'กฟภ.', scope: 'LBS', installLocation: 'สถานี A',
  requiredDate: '2026-12-31', lbsQtyRequired: 2, terminalStatus: 'issued', openedBy: 'u-p', createdAt: T,
  installStartDate: '2026-11-20', installEndDate: '2026-11-30', ...over,
})
const unit = (id: string, over: Partial<LbsUnit> = {}): LbsUnit =>
  ({ id, serialLvb: `LVB-${id}`, serialOm: `OM-${id}`, projectStockId: 's1', status: 'issued', jobId: 'j1', ...over })
const inst = (unitId: string, outcome: UnitInstallation['outcome'], over: Partial<UnitInstallation> = {}): UnitInstallation =>
  ({ id: `in-${unitId}-${outcome}`, unitId, jobId: 'j1', outcome, performedBy: 'u-svc', performedAt: T,
    ...(outcome === 'installed' ? { installedDate: '2026-11-21', checkinLat: 14, checkinLng: 100.5 } : {}), ...over })
const member = (id: string, over: Partial<TeamMember> = {}): TeamMember =>
  ({ id, firstName: 'ช่าง', lastName: id, phone: '080', position: 'ช่าง', isActive: true, createdAt: T, ...over })
const assign = (jobId: string, memberId: string) =>
  ({ id: `as-${jobId}-${memberId}`, jobId, memberId, isLead: true, assignedBy: 'u-svc', assignedAt: T })
const U = (id: string, department: User['department']): User => ({ id, email: `${id}@x`, password: '', fullName: id, department, isActive: true })

// ---------------------------------------------------------------------------
describe('ยังไม่มอบหมายทีม — กติกาเดียวทุกหน้า (ค้างจากเฟส 3)', () => {
  it('ของออกหน้างานแล้ว + ยังมีเครื่องรอติดตั้ง + ไม่มีทีม = ต้องมอบหมาย', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), unit('b')], unitInstallations: [inst('a', 'installed')] })
    expect(jobNeedsTeam(d, d.jobs[0])).toBe(true)
  })
  it('🔴 ติดตั้งครบทุกเครื่องแล้ว (รอปิดงาน) ไม่ต้องมีทีม — เดิมนับค้างตลอดไป (มอบหมายก็ไม่ได้ ระบบกันไว้)', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), unit('b')], unitInstallations: [inst('a', 'installed'), inst('b', 'installed')] })
    expect(jobNeedsTeam(d, d.jobs[0])).toBe(false)
    expect(unassignedJobs(d)).toEqual([])
  })
  it('มีทีมแล้ว / ยังไม่เบิกออก / ปิดงานแล้ว = ไม่นับ', () => {
    expect(jobNeedsTeam(db({ jobs: [job()], lbsUnits: [unit('a')], jobAssignments: [assign('j1', 'm1')] }), job())).toBe(false)
    expect(jobNeedsTeam(db({ jobs: [job({ terminalStatus: null })], lbsUnits: [unit('a', { status: 'allocated' })] }), job({ terminalStatus: null }))).toBe(false)
    expect(jobNeedsTeam(db({ jobs: [job({ terminalStatus: 'installed' })], lbsUnits: [unit('a')] }), job({ terminalStatus: 'installed' }))).toBe(false)
  })
  it('เบิกบางส่วน: เครื่องที่ออกไปติดตั้งครบ แต่ยังมีเครื่องค้างที่คลัง = ยังต้องมีทีม (ล็อตถัดไป)', () => {
    const j = job({ terminalStatus: null })
    const d = db({ jobs: [j], lbsUnits: [unit('a'), unit('b', { status: 'allocated' })], unitInstallations: [inst('a', 'installed')] })
    expect(jobNeedsTeam(d, j)).toBe(true)
  })
})

describe('ลบช่าง — บอกก่อนกด (กติกาเดียวกับ deleteTeamMember)', () => {
  it('เคยถูกมอบหมาย / มีประวัติติดตั้ง = ลบไม่ได้ พร้อมเหตุผล · ไม่มี = ลบได้', () => {
    expect(memberDeleteBlock(db({ jobAssignments: [assign('j1', 'm1')] }), 'm1')).toMatch(/เคยถูกมอบหมาย/)
    expect(memberDeleteBlock(db({ unitInstallations: [inst('a', 'installed', { installedByMemberId: 'm1' })] }), 'm1')).toMatch(/ประวัติติดตั้ง/)
    expect(memberDeleteBlock(db({}), 'm1')).toBeNull()
  })
})

describe('งานของฉันวันนี้ (หน้า Site Installation บนมือถือ)', () => {
  const svc = U('u-svc', 'service')
  const base = () => db({
    teamMembers: [member('m1', { userId: 'u-svc' }), member('m2')],
    jobs: [
      job({ id: 'j1', jobNo: 'J-001' }),                                                   // อยู่ในช่วงนัด
      job({ id: 'j2', jobNo: 'J-002', installStartDate: '2026-11-10', installEndDate: '2026-11-15' }),   // เลยวันนัด
      job({ id: 'j3', jobNo: 'J-003', installStartDate: '2026-12-01', installEndDate: '2026-12-02' }),   // ยังไม่ถึง
      job({ id: 'j4', jobNo: 'J-004' }),                                                   // ทีมอื่น
    ],
    lbsUnits: [unit('a'), unit('b', { jobId: 'j2' }), unit('c', { jobId: 'j3' }), unit('d', { jobId: 'j4' })],
    jobAssignments: [assign('j1', 'm1'), assign('j2', 'm1'), assign('j3', 'm1'), assign('j4', 'm2')],
  })
  it('ช่างที่ผูกบัญชี: เฉพาะงานของทีมตัวเองที่ถึงวันนัดแล้ว (เลยนัดขึ้นก่อน) · ไม่รวมงานที่ยังไม่ถึงนัด', () => {
    expect(todayFieldJobs(base(), svc, TODAY).map(x => [x.job.jobNo, x.overdueDays, x.pendingUnits])).toEqual([['J-002', 8, 1], ['J-001', 0, 1]])
  })
  it('Service ที่ไม่ได้ผูกเป็นช่าง (หัวหน้า) / Manage = เห็นทุกทีม', () => {
    expect(todayFieldJobs(base(), U('u-head', 'service'), TODAY).map(x => x.job.jobNo)).toEqual(['J-002', 'J-001', 'J-004'])
  })
  it('เครื่องติดตั้งครบแล้ว = ไม่อยู่ในรายการวันนี้ · แผนกอื่น = ว่าง', () => {
    const d: DB = { ...base(), unitInstallations: [inst('a', 'installed')] }
    expect(todayFieldJobs(d, svc, TODAY).map(x => x.job.jobNo)).toEqual(['J-002'])
    expect(todayFieldJobs(base(), U('u-p', 'project'), TODAY)).toEqual([])
  })
})

describe('GPS · รูปถ่าย · ลิงก์ (ยืนยันติดตั้งบนมือถือ)', () => {
  it('ระยะทาง (haversine) ≈ จริง', () => {
    expect(Math.round(distanceMeters({ lat: 13.7563, lng: 100.5018 }, { lat: 13.7563, lng: 100.5118 }))).toBeGreaterThan(1070)
    expect(Math.round(distanceMeters({ lat: 13.7563, lng: 100.5018 }, { lat: 13.7563, lng: 100.5118 }))).toBeLessThan(1090)
  })
  it('คุณภาพ GPS: ≤30 m ดี · ≤100 m พอใช้ · มากกว่านั้น = หยาบ (น่าจะมาจากเสาสัญญาณ)', () => {
    expect([gpsQuality(12), gpsQuality(30), gpsQuality(80), gpsQuality(900)]).toEqual(['good', 'good', 'fair', 'poor'])
  })
  it('ย่อรูปให้ด้านยาวไม่เกินที่กำหนด (คงสัดส่วน · รูปเล็กอยู่แล้วไม่ขยาย)', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ w: 1600, h: 1200 })
    expect(fitWithin(3000, 4000, 1600)).toEqual({ w: 1200, h: 1600 })
    expect(fitWithin(800, 600, 1600)).toEqual({ w: 800, h: 600 })
  })
  it('ลิงก์นำทาง Google Maps · ลิงก์รูปรับเฉพาะ http(s)/รูป data ( javascript: ถูกตัดทิ้ง)', () => {
    expect(mapsUrl(13.75, 100.5)).toBe('https://www.google.com/maps/dir/?api=1&destination=13.75,100.5')
    expect(safeHttpUrl('https://x.supabase.co/a.jpg')).toBe('https://x.supabase.co/a.jpg')
    expect(safeHttpUrl('data:image/jpeg;base64,AAA')).toBe('data:image/jpeg;base64,AAA')
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeHttpUrl('x.jpg')).toBeUndefined()
  })
})

describe('แบบร่างยืนยันติดตั้ง (ข้อมูลไม่หายเมื่อเปิดกล้อง/เน็ตหลุด) — เก็บรายเครื่อง', () => {
  const NOW = '2026-11-23T02:00:00.000Z'
  const draft = (unitId: string, over: Partial<ConfirmDraft> = {}): ConfirmDraft =>
    ({ unitId, userId: 'u-svc', installedDate: '2026-11-23', lat: 14, lng: 100.5, accuracy: 12, memberId: 'm1', note: 'ok', hasPhoto: true, startedAt: NOW, savedAt: NOW, ...over })
  it('อ่านกลับได้ครบ เฉพาะเครื่องเดียวกัน · เก่าเกิน 2 วัน / ข้อมูลเสีย = ทิ้ง', () => {
    const s = putDraft({}, draft('a'), NOW)
    expect(getDraft(parseDraftStore(serializeDraftStore(s)), 'a', 'u-svc', TODAY)).toMatchObject({ unitId: 'a', note: 'ok', hasPhoto: true })
    expect(getDraft(s, 'b', 'u-svc', TODAY)).toBeNull()
    expect(getDraft(putDraft({}, draft('a', { startedAt: '2026-11-20T02:00:00.000Z' }), '2026-11-20T02:00:00.000Z'), 'a', 'u-svc', TODAY)).toBeNull()
    expect(parseDraftStore('{bad')).toEqual({})
    expect(parseDraftStore(null)).toEqual({})
  })
  it('🔴 #1 เปิดฟอร์มเครื่องอื่นแล้วบันทึก = ร่างของเครื่องแรกยังอยู่ (เดิมช่องเดียว ถูกเขียนทับ)', () => {
    let s = putDraft({}, draft('a', { note: 'รูป+บันทึกของ A' }), NOW)
    s = putDraft(s, draft('b', { note: 'B' }), NOW)
    expect(getDraft(s, 'a', 'u-svc', TODAY)?.note).toBe('รูป+บันทึกของ A')
    expect(getDraft(s, 'b', 'u-svc', TODAY)?.note).toBe('B')
    expect(getDraft(removeDraft(s, 'b'), 'a', 'u-svc', TODAY)).not.toBeNull()
  })
  it('🔴 #4 GPS ที่จับอัตโนมัติอย่างเดียว ไม่นับเป็นร่าง (เดิมเปิดดูแล้วกดกลับ = ขึ้นแถบ "ยังไม่บันทึก")', () => {
    expect(draftHasContent({ hasPhoto: false, note: '' })).toBe(false)
    expect(draftHasContent({ hasPhoto: false, note: '   ' })).toBe(false)
    expect(draftHasContent({ hasPhoto: true, note: '' })).toBe(true)
    expect(draftHasContent({ hasPhoto: false, note: 'ทดสอบผ่าน' })).toBe(true)
  })
  it('🔴 #8 ตัวร่างที่เก็บใน localStorage ไม่มีรูป (รูปแยกที่เก็บ เขียนเฉพาะตอนรูปเปลี่ยน) — พิมพ์ทีละตัวไม่เขียนรูปซ้ำ', () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(5000)
    const s = putDraft({}, { ...draft('a'), photo: big } as ConfirmDraft & { photo: string }, NOW)
    expect(serializeDraftStore(s)).not.toContain('AAAA')
    expect(serializeDraftStore(s).length).toBeLessThan(600)
  })
  it('🔴 #9 ร่างผูกกับผู้ใช้ · กู้ร่างแล้วบันทึกต่อ อายุนับจากวันที่เริ่ม (เดิมเลื่อนออกไปเรื่อย ๆ)', () => {
    const s = putDraft({}, draft('a'), NOW)
    expect(getDraft(s, 'a', 'u-other', TODAY)).toBeNull()
    // เริ่ม 21 พ.ย. · บันทึกต่อทุกวัน → ยังนับจาก 21 = หมดอายุวันที่ 24
    let s2 = putDraft({}, draft('a', { startedAt: '2026-11-21T02:00:00.000Z' }), '2026-11-21T02:00:00.000Z')
    s2 = putDraft(s2, draft('a', { startedAt: undefined, note: 'ต่อ' }), '2026-11-23T02:00:00.000Z')
    expect(s2.a.startedAt).toBe('2026-11-21T02:00:00.000Z')
    expect(getDraft(s2, 'a', 'u-svc', '2026-11-24')).toBeNull()
  })
  it('🔴 #5 แถบ "ทำต่อ" ไม่ชวนเครื่องที่ยืนยันไม่ได้: ติดตั้งแล้ว · มีคำขอคืนเข้าคลังรอพิจารณา · มีผลบันทึกหลังเริ่มร่าง (ติดตั้งไม่ได้)', () => {
    const s = putDraft(putDraft(putDraft({}, draft('a'), NOW), draft('b'), NOW), draft('c'), NOW)
    const pending = { id: 'r1', type: 'return_lbs', status: 'pending', jobId: 'j1', requestedBy: 'u-svc', requestedAt: NOW, payload: { unitIds: ['b'] } } as unknown as DB['approvalRequests'][number]
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), unit('b'), unit('c')], approvalRequests: [pending],
      unitInstallations: [inst('c', 'blocked', { reason: 'ฐานราก', performedAt: '2026-11-23T03:00:00.000Z' })] })
    expect(resumableDraft(d, s, 'u-svc', TODAY)?.d.unitId).toBe('a')
    expect(resumableDraft({ ...d, unitInstallations: [...d.unitInstallations, inst('a', 'installed', { performedAt: '2026-11-23T03:00:00.000Z' })] }, s, 'u-svc', TODAY)).toBeNull()
    // ติดตั้งไม่ได้ "ก่อน" เริ่มร่าง = ตั้งใจกลับมายืนยันใหม่ → ยังชวนได้
    const older = { ...d, approvalRequests: [], unitInstallations: [inst('c', 'blocked', { performedAt: '2026-11-22T03:00:00.000Z' })] }
    expect(resumableDraft(older, removeDraft(removeDraft(s, 'a'), 'b'), 'u-svc', TODAY)?.d.unitId).toBe('c')
    expect(resumableDraft(d, s, 'u-other', TODAY)).toBeNull()
  })
})

describe('🔴 #6 GPS: ผลของคำขอเก่าไม่ทับฟอร์มปัจจุบัน', () => {
  it('ขอใหม่ / ยกเลิก = ผลของคำขอก่อนหน้าไม่ใช่ปัจจุบัน', () => {
    const g = createLatestGuard()
    const a = g.next()
    const b = g.next()
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
    g.invalidate()
    expect(g.isCurrent(b)).toBe(false)
  })
})

describe('ตารางนัดติดตั้ง (Assignment & Schedule) — จากข้อมูลจริงเท่านั้น', () => {
  it('นัดหลายวัน = ขึ้นทุกวันในช่วง · งานปิด/ยกเลิก/ไม่มีนัด ไม่ขึ้น · บันทึกเลื่อนนัดขึ้นวันที่บันทึก', () => {
    const d = db({
      jobs: [job({ installStartDate: '2026-11-24', installEndDate: '2026-11-25' }),
        job({ id: 'j2', jobNo: 'J-002', installStartDate: undefined, installEndDate: undefined }),
        job({ id: 'j3', jobNo: 'J-003', terminalStatus: 'installed', installStartDate: '2026-11-24', installEndDate: '2026-11-24' })],
      siteVisits: [{ id: 'v1', jobId: 'j1', outcome: 'rescheduled', reason: 'ฝนตก', newStartDate: '2026-11-24', newEndDate: '2026-11-25', performedBy: 'u-svc', performedAt: '2026-11-23T02:00:00.000Z' }],
    })
    const ag = scheduleAgenda(d, TODAY, 3)
    expect(ag.map(x => [x.date, x.items.map(i => `${i.kind}:${i.jobNo}`)])).toEqual([
      ['2026-11-23', ['rescheduled:J-001']],
      ['2026-11-24', ['install:J-001']],
      ['2026-11-25', ['install:J-001']],
    ])
  })
  it('🔴 #3 ป้าย "ยังไม่มีทีม" ใช้กติกา jobNeedsTeam — งานติดตั้งครบแล้ว / ยังไม่เบิกของ ไม่ขึ้นแดง (มอบหมายไม่ได้)', () => {
    const range = { installStartDate: '2026-11-23', installEndDate: '2026-11-23' }
    const d = db({
      jobs: [job(range), job({ id: 'j2', jobNo: 'J-002', ...range }), job({ id: 'j3', jobNo: 'J-003', terminalStatus: null, ...range })],
      lbsUnits: [unit('a'), unit('b', { jobId: 'j2' }), unit('c', { jobId: 'j3', status: 'allocated' })],
      unitInstallations: [inst('b', 'installed', { jobId: 'j2' })],
    })
    const items = scheduleAgenda(d, TODAY, 1)[0].items
    expect(items.map(i => `${i.jobNo}:${i.needsTeam}`)).toEqual(['J-001:true', 'J-002:false', 'J-003:false'])
  })
})

describe('🔴 #2 Warranty: ประเภทเอกสารที่เลือกผูกกับงาน — ไม่ค้างไปงานถัดไป (ทุกทางที่ปิดกล่อง)', () => {
  it('เลือก PAC ไว้ที่งาน A แล้วเปิดงาน B = ว่าง', () => {
    const sel = { jobId: 'A', type: 'PAC' as const }
    expect(docTypeForJob(sel, 'A')).toBe('PAC')
    expect(docTypeForJob(sel, 'B')).toBe('')
    expect(docTypeForJob(null, 'A')).toBe('')
  })
})

describe('Warranty — ป้ายนับกับตัวกรองนับสิ่งเดียวกัน · ชั้น ≤30 วัน', () => {
  const w = (kind: JobWarranty['kind'], endDate: string, unitId?: string): JobWarranty =>
    ({ id: `w-${kind}-${unitId ?? ''}`, jobId: 'j1', kind, unitId, startDate: '2025-01-01', endDate, createdAt: T })
  const row: WarrantyRow = { inst: w('installation', '2026-12-10'), lbs: [w('lbs', '2027-06-01', 'a'), w('lbs', '2026-12-31', 'b')] }
  it('🔴 งานที่ประกันงานติดตั้งใกล้หมด = ผ่านตัวกรอง "ใกล้หมด" และป้ายนับด้วย (เดิมป้ายนับแต่ LBS = 0 แต่มีแถวขึ้น)', () => {
    expect(warrantyRowMatches(row, 'expiring', TODAY)).toBe(true)
    expect(warrantyCounts([row], TODAY)).toMatchObject({ lbs: { active: 1, expiring: 1, urgent: 0, expired: 0 }, installation: { expiring: 1, urgent: 1 } })
  })
  it('รายเครื่อง: กรองแต่ละประกันตามสถานะของตัวเอง (ใช้ซ่อนเครื่องที่ไม่เข้าเงื่อนไขในแถว)', () => {
    expect(warrantyMatches(w('lbs', '2027-06-01', 'a'), 'active', TODAY)).toBe(true)
    expect(warrantyMatches(w('lbs', '2026-01-01', 'a'), 'active', TODAY)).toBe(false)
    expect(warrantyMatches(w('lbs', '2026-12-10', 'a'), 'urgent', TODAY)).toBe(true)
    expect(warrantyMatches(w('lbs', '2026-12-31', 'a'), 'urgent', TODAY)).toBe(false)
    expect(warrantyMatches(w('lbs', '2020-01-01', 'a'), 'all', TODAY)).toBe(true)
  })
  it('ชั้น ≤30 วัน: เหลือ ≤30 วัน (ยังไม่หมด)', () => {
    expect(warrantyRowMatches(row, 'urgent', TODAY)).toBe(true)
    expect(warrantyRowMatches({ inst: w('installation', '2027-12-01'), lbs: [] }, 'urgent', TODAY)).toBe(false)
  })
})
