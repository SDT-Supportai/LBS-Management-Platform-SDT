// เฟส 5 (2026-11-23) — หมุดแผนที่ (ย้ายออกจาก MapTrackingPage ให้เทสต์ได้)
import { describe, it, expect } from 'vitest'
import type { DB, Job, LbsUnit, UnitInstallation } from '../types'
import { buildMapPins, unpinnedBlocked, nextFit } from './mapPins'

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
  id: 'j1', jobNo: 'J-001', customerName: 'กฟภ.', scope: 'LBS', installLocation: 'สถานี A', requiredDate: '2026-12-31',
  lbsQtyRequired: 2, terminalStatus: 'issued', openedBy: 'u-p', createdAt: T, planLat: 14.0, planLng: 100.5,
  installSites: [{ id: 's2', location: 'สถานี B', requiredDate: '2027-01-15', lat: 15.0, lng: 101.0 }], ...over,
})
const unit = (id: string, over: Partial<LbsUnit> = {}): LbsUnit =>
  ({ id, serialLvb: `LVB-${id}`, serialOm: `OM-${id}`, projectStockId: 's1', status: 'issued', jobId: 'j1', ...over })
const row = (unitId: string, outcome: UnitInstallation['outcome'], over: Partial<UnitInstallation> = {}): UnitInstallation =>
  ({ id: `r-${unitId}-${outcome}`, unitId, jobId: 'j1', outcome, performedBy: 'u-svc', performedAt: T, ...over })

describe('buildMapPins', () => {
  it('🔴 เครื่องติดตั้งไม่ได้ (ไม่มีพิกัดเช็คอิน) ขึ้นหมุดแดงที่จุดติดตั้งตามแผน + เหตุผล (เดิมไม่เคยขึ้นเลย)', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a', { installSiteId: 's2' })], unitInstallations: [row('a', 'blocked', { reason: 'ฐานรากไม่พร้อม' })] })
    const p = buildMapPins(d).find(x => x.level === 'unit')!
    expect(p).toMatchObject({ outcome: 'blocked', lat: 15.0, lng: 101.0, approx: true, reason: 'ฐานรากไม่พร้อม', location: 'สถานี B' })
  })
  it('🔴 แถวเวลาเท่ากัน (แก้วันติดตั้งหลังปิดงาน: reverted + installed) = แถวหลังชนะ หมุดไม่หาย', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a')], unitInstallations: [
      row('a', 'reverted'), row('a', 'installed', { checkinLat: 14.1, checkinLng: 100.6, installedDate: '2026-11-02' }) ] })
    expect(buildMapPins(d).filter(x => x.level === 'unit').map(x => x.outcome)).toEqual(['installed'])
  })
  it('🔴 หมุดแผนของจุดที่ติดตั้งครบแล้วหายไป (แทนด้วยหมุดจริง) · จุดที่ยังมีเครื่องรอยังอยู่', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a'), unit('b', { installSiteId: 's2' })],
      unitInstallations: [row('a', 'installed', { checkinLat: 14.01, checkinLng: 100.51 })] })
    expect(buildMapPins(d).filter(x => x.level === 'plan').map(x => x.siteNo)).toEqual([2])
  })
  it('🔴 งานหลายจุด: หมุดเครื่องบอกสถานที่ของจุดที่เครื่องอยู่ (เดิมขึ้นจุดที่ 1 เสมอ)', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('b', { installSiteId: 's2' })],
      unitInstallations: [row('b', 'installed', { checkinLat: 15.01, checkinLng: 101.01 })] })
    expect(buildMapPins(d).find(x => x.level === 'unit')).toMatchObject({ location: 'สถานี B', siteNo: 2 })
  })
  it('ลิงก์รูป javascript: ถูกตัดทิ้ง · งานที่ยกเลิกไม่มีหมุด', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a')],
      unitInstallations: [row('a', 'installed', { checkinLat: 14.1, checkinLng: 100.6, photoUrl: 'javascript:alert(1)' })] })
    expect(buildMapPins(d).find(x => x.level === 'unit')?.photoUrl).toBeUndefined()
    expect(buildMapPins({ ...d, jobs: [job({ terminalStatus: 'cancelled' })] })).toEqual([])
  })
})

describe('🔴 #10 ปรับมุมมองแผนที่ (fit)', () => {
  it('รอบแรกยังไม่มีหมุด (ข้อมูลยังโหลด) แล้วหมุดมาทีหลัง ตัวกรองเดิม = ซูมไปที่หมุด (เดิมค้างที่มุมมองทั้งประเทศ)', () => {
    const r1 = nextFit(null, 'k', 0)
    expect(r1.action).toBe('center')
    const r2 = nextFit(r1.state, 'k', 3)
    expect(r2.action).toBe('bounds')
  })
  it('fit แล้ว ข้อมูลรีเฟรช ตัวกรองเดิม = ไม่รีเซ็ตมุมมองที่ผู้ใช้เลื่อนไว้ · เปลี่ยนตัวกรอง = fit ใหม่', () => {
    const r1 = nextFit(null, 'k', 2)
    expect(r1.action).toBe('bounds')
    expect(nextFit(r1.state, 'k', 3).action).toBeNull()
    expect(nextFit(r1.state, 'k2', 0).action).toBe('center')
    const empty = nextFit(r1.state, 'k2', 0).state
    expect(nextFit(empty, 'k2', 0).action).toBeNull()      // ว่างซ้ำ ไม่รีเซ็ตทุกรอบ
  })
})

describe('unpinnedBlocked', () => {
  it('🔴 เครื่องติดตั้งไม่ได้ที่ไม่มีพิกัดเลย (ไม่เช็คอิน · งานไม่มีพิกัดแผน) ถูกนับไว้ — เดิมหายจากแผนที่เงียบ ๆ', () => {
    const noCoord = job({ planLat: undefined, planLng: undefined, installSites: [] })
    const d = db({ jobs: [noCoord], lbsUnits: [unit('a'), unit('b')], unitInstallations: [
      row('a', 'blocked', { reason: 'ฐานรากไม่พร้อม' }), row('b', 'installed') ] })
    expect(buildMapPins(d).filter(x => x.level === 'unit')).toEqual([])
    // เฉพาะ blocked — เครื่องติดตั้งแล้วที่ไม่มีพิกัด (งานก่อนบังคับ GPS) ไม่นับ
    expect(unpinnedBlocked(d)).toEqual([{ jobId: 'j1', jobNo: 'J-001', serial: 'LVB-a', reason: 'ฐานรากไม่พร้อม' }])
  })
  it('มีพิกัดสำรอง (จุดตามแผน) = ขึ้นหมุดแล้ว ไม่นับซ้ำ · งานยกเลิก/คืนคลังแล้ว ไม่นับ', () => {
    const d = db({ jobs: [job()], lbsUnits: [unit('a')], unitInstallations: [row('a', 'blocked')] })
    expect(unpinnedBlocked(d)).toEqual([])
    const noCoord = job({ planLat: undefined, planLng: undefined, installSites: [] })
    expect(unpinnedBlocked(db({ jobs: [{ ...noCoord, terminalStatus: 'cancelled' }], lbsUnits: [unit('a')], unitInstallations: [row('a', 'blocked')] }))).toEqual([])
    expect(unpinnedBlocked(db({ jobs: [noCoord], lbsUnits: [unit('a')], unitInstallations: [
      row('a', 'blocked'), row('a', 'returned', { performedAt: '2026-11-02T03:00:00.000Z' })] }))).toEqual([])
  })
})
