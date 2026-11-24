// =============================================================================
// หมุดแผนที่ (Map Tracking) — ย้ายออกจาก MapTrackingPage (เฟส 5 · 2026-11-23) ให้เทสต์ได้
//   unit = ผลติดตั้งราย Serial (unit_installations — แถวล่าสุดต่อเครื่อง)
//   job  = Check-in ระดับงาน (งานเก่าก่อน 0035)
//   plan = จุดติดตั้งตามแผน (jobs.plan_lat/lng + install_sites — 0060) ที่ยังไม่ติดตั้งครบ
// =============================================================================
import type { DB, UnitInstallation } from '../types'
import { inThailand, jobSites, unitJobSite, memberFullName, deriveJobStatus } from './logic'
import { JOB_STATUS_LABEL } from '../ui/format'
import { safeHttpUrl } from './field'

export type Pin = {
  key: string
  lat: number
  lng: number
  level: 'unit' | 'job' | 'plan'
  outcome: 'installed' | 'blocked' | 'planned'
  jobId: string
  jobNo: string
  customer: string
  location: string
  serial?: string
  serialOm?: string
  siteNo?: number          // จุดที่เท่าไรของงาน
  statusLabel?: string     // plan: สถานะงานตอนนี้
  date?: string            // unit/job = วันติดตั้ง · plan = กำหนดตามแผน
  by?: string
  photoUrl?: string        // ผ่าน safeHttpUrl แล้ว (กัน javascript:)
  note?: string
  /** เหตุผลที่ติดตั้งไม่ได้ (outcome = blocked) */
  reason?: string
  /** true = ไม่มีพิกัดเช็คอิน ใช้จุดติดตั้งตามแผนแทน (ติดตั้งไม่ได้ไม่บังคับเช็คอิน) */
  approx?: boolean
}

export type UnpinnedBlocked = { jobId: string; jobNo: string; serial: string; reason?: string }

export function buildMapPins(db: DB): Pin[] {
  return collectPins(db).pins
}

/** 🔴 เฟส 5: เครื่องติดตั้งไม่ได้ที่ไม่มีพิกัดเลย (ไม่เช็คอิน + งานไม่มีพิกัดแผน/จุด) — เดิมหายจากแผนที่เงียบ ๆ
 *  หน้าแผนที่บอกจำนวนไว้ ไม่ให้เข้าใจว่าไม่มีปัญหา */
export function unpinnedBlocked(db: DB): UnpinnedBlocked[] {
  return collectPins(db).unpinned
}

function collectPins(db: DB): { pins: Pin[]; unpinned: UnpinnedBlocked[] } {
  const out: Pin[] = []
  const unpinned: UnpinnedBlocked[] = []
  const userOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  const liveJob = (id: string) => {
    const j = db.jobs.find(x => x.id === id)
    return j && j.terminalStatus !== 'cancelled' ? j : undefined   // งานที่ยกเลิกไม่มีหมุด
  }

  // 1) ราย Serial — แถวล่าสุดต่อเครื่อง · 🔴 เวลาเท่ากัน = แถวหลังชนะ (เหมือน latestInstallRow)
  //    เดิมแถวแรกชนะ ⇒ แก้วันติดตั้งหลังปิดงาน (reverted + installed เวลาเดียวกัน) แล้วหมุดหาย
  const latest = new Map<string, UnitInstallation>()
  db.unitInstallations.forEach(r => {
    const cur = latest.get(r.unitId)
    if (!cur || r.performedAt >= cur.performedAt) latest.set(r.unitId, r)
  })
  latest.forEach(r => {
    if (r.outcome === 'reverted' || r.outcome === 'returned') return   // ผลถูกยกเลิก / คืนเข้าคลังแล้ว
    const job = liveJob(r.jobId)
    if (!job) return
    const unit = db.lbsUnits.find(u => u.id === r.unitId)
    const site = unit ? unitJobSite(db, unit) : undefined
    let lat = r.checkinLat, lng = r.checkinLng, approx = false
    if (lat == null || lng == null || !inThailand(lat, lng)) {
      // 🔴 เฟส 5: ติดตั้งไม่ได้ไม่บังคับเช็คอิน ⇒ เดิมไม่เคยมีหมุดแดงเลย — ใช้จุดติดตั้งตามแผนแทน (บอกว่าเป็นตำแหน่งโดยประมาณ)
      if (r.outcome !== 'blocked') return
      const fb = [site, { lat: job.planLat, lng: job.planLng }].find(p => p?.lat != null && p?.lng != null && inThailand(p.lat, p.lng))
      if (!fb) {
        unpinned.push({ jobId: job.id, jobNo: job.jobNo, serial: unit?.serialLvb ?? r.unitId, reason: r.reason })
        return
      }
      lat = fb.lat!; lng = fb.lng!; approx = true
    }
    out.push({
      key: `u:${r.id}`, lat, lng, level: 'unit', outcome: r.outcome === 'blocked' ? 'blocked' : 'installed',
      jobId: job.id, jobNo: job.jobNo, customer: job.customerName,
      // 🔴 เฟส 5: งานหลายจุด = สถานที่ของจุดที่เครื่องอยู่ (เดิมขึ้นจุดที่ 1 เสมอ)
      location: site?.location || job.issueLocation || job.installLocation || '-', siteNo: site?.no,
      serial: unit?.serialLvb, serialOm: unit?.serialOm,
      date: r.installedDate ?? r.performedAt,
      by: r.installedByMemberId ? memberFullName(db, r.installedByMemberId) : userOf(r.performedBy),
      photoUrl: safeHttpUrl(r.photoUrl), note: r.note,
      reason: r.outcome === 'blocked' ? r.reason : undefined, approx: approx || undefined,
    })
  })

  // 2) ระดับงาน (งานเก่าก่อน 0035) — ข้ามงานที่มีหมุดราย Serial อยู่แล้ว กันหมุดซ้อน
  const jobsWithUnitPins = new Set(out.map(p => p.jobId))
  db.jobs.forEach(j => {
    if (j.terminalStatus === 'cancelled') return
    if (j.installCheckinLat == null || j.installCheckinLng == null) return
    if (jobsWithUnitPins.has(j.id)) return
    if (!inThailand(j.installCheckinLat, j.installCheckinLng)) return
    out.push({
      key: `j:${j.id}`, lat: j.installCheckinLat, lng: j.installCheckinLng, level: 'job',
      outcome: 'installed', jobId: j.id, jobNo: j.jobNo, customer: j.customerName,
      location: j.issueLocation || j.installLocation || '-',
      date: j.installedAt, by: userOf(j.installConfirmedBy),
      photoUrl: safeHttpUrl(j.installPhotoUrl), note: j.installNote,
    })
  })

  // 3) จุดติดตั้งตามแผน — งานที่ยังไม่ปิด/ยกเลิก · 🔴 เฟส 5: จุดที่ทุกเครื่องติดตั้งแล้ว = ไม่ขึ้นหมุดแผน
  //    (หมุดจริงแทนแล้ว) — เดิมคอมเมนต์บอกว่าแทนที่ แต่ไม่มีโค้ด ⇒ "📌 ยังไม่ติดตั้ง" ค้างข้างหมุดเขียว
  db.jobs.forEach(j => {
    if (j.terminalStatus === 'installed' || j.terminalStatus === 'cancelled') return
    const statusLabel = JOB_STATUS_LABEL[deriveJobStatus(db, j)]
    const units = db.lbsUnits.filter(u => u.jobId === j.id)
    for (const s of jobSites(j)) {
      if (s.lat == null || s.lng == null || !inThailand(s.lat, s.lng)) continue
      const atSite = units.filter(u => unitJobSite(db, u)?.id === s.id)
      if (atSite.length > 0 && atSite.every(u => latest.get(u.id)?.outcome === 'installed')) continue
      out.push({
        key: `p:${j.id}:${s.no}`, lat: s.lat, lng: s.lng, level: 'plan', outcome: 'planned',
        jobId: j.id, jobNo: j.jobNo, customer: j.customerName,
        location: s.location || '-', siteNo: s.no, date: s.requiredDate, statusLabel,
      })
    }
  })
  return { pins: out, unpinned }
}

export type FitState = { key: string; hadPins: boolean }
/**
 * ควรปรับมุมมองแผนที่ไหม — fit เมื่อเปลี่ยนตัวกรอง และเมื่อหมุด "ชุดแรก" มาถึง (ข้อมูลโหลดทีหลัง)
 * ข้อมูลรีเฟรชระหว่างที่ผู้ใช้เลื่อนดูอยู่ = ไม่ยุ่งมุมมอง · รีวิวเฟส 5 #10: เดิมรอบแรกว่างแล้วจำ key ไว้ ⇒ หมุดมาทีหลังไม่ซูมเลย
 */
export function nextFit(prev: FitState | null, key: string, count: number): { action: 'bounds' | 'center' | null; state: FitState } {
  const state = { key, hadPins: count > 0 }
  if (!prev || prev.key !== key) return { action: count > 0 ? 'bounds' : 'center', state }
  if (!prev.hadPins && count > 0) return { action: 'bounds', state }
  return { action: null, state: prev.hadPins ? prev : state }
}

/** หมุดที่พิกัดเดียวกัน (ปัดทศนิยม 5 ตำแหน่ง ≈ 1 เมตร) รวมเป็นหมุดเดียว ไม่งั้นทับกันอ่านไม่ออก */
export function groupPins(pins: Pin[]): Pin[][] {
  const m = new Map<string, Pin[]>()
  pins.forEach(p => {
    const k = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
    const arr = m.get(k) ?? []
    arr.push(p)
    m.set(k, arr)
  })
  return [...m.values()]
}
