// =============================================================================
// เฟส 5 (2026-11-23) — ตรรกะล้วนของงานหน้างาน (มีเทสต์ที่ field.test.ts)
//   Site Installation (มือถือ) · Assignment & Schedule · Warranty
// =============================================================================
import type { DB, Job, User, JobWarranty } from '../types'
import { jobIsFieldActive, jobInstallSummary, daysBetweenIso, warrantyStatus, addDaysIso, memberDeleteBlock } from './logic'
import { bkkDate, jobNeedsTeam } from './flow'

export { memberDeleteBlock, jobNeedsTeam }

// ---------------- ยังไม่มอบหมายทีม (กติกาเดียวทุกหน้า) ----------------
// jobNeedsTeam ย้ายไปอยู่ที่ flow.ts (รีวิว Flow ข้อ 3 · 2026-11-24) — งานของฉันใช้ตัวเดียวกัน · re-export ด้านบน
export const unassignedJobs = (db: DB) => db.jobs.filter(j => jobNeedsTeam(db, j))

// ---------------- งานของฉันวันนี้ (Site Installation บนมือถือ) ----------------
export interface FieldJobToday { job: Job; overdueDays: number; pendingUnits: number }

/**
 * งานหน้างานที่ถึงวันนัดแล้ว (อยู่ในช่วงนัด หรือเลยนัด) และยังมีเครื่องที่ออกไปแล้วรอยืนยัน — เลยนัดขึ้นก่อน
 *   ช่างที่ผูกบัญชี (TeamMember.userId) = เฉพาะงานที่ทีมตัวเองได้รับมอบหมาย
 *   Service ที่ไม่ได้ผูกเป็นช่าง (หัวหน้างาน) / Manage = ทุกทีม · แผนกอื่น = ว่าง
 */
export function todayFieldJobs(db: DB, user: User | null, today: string): FieldJobToday[] {
  if (!user || (user.department !== 'service' && user.department !== 'admin')) return []
  const me = db.teamMembers.find(m => m.userId === user.id && m.isActive)
  const out: FieldJobToday[] = []
  for (const job of db.jobs) {
    if (job.terminalStatus === 'installed' || job.terminalStatus === 'cancelled') continue
    if (!jobIsFieldActive(db, job)) continue
    if (me && !db.jobAssignments.some(a => a.jobId === job.id && a.memberId === me.id)) continue
    const start = job.installStartDate?.slice(0, 10)
    if (!start || start > today) continue
    const end = job.installEndDate?.slice(0, 10) || start
    const pendingUnits = jobInstallSummary(db, job.id).outPending
    if (pendingUnits === 0) continue
    out.push({ job, overdueDays: end < today ? daysBetweenIso(end, today) : 0, pendingUnits })
  }
  return out.sort((a, b) => b.overdueDays - a.overdueDays)
}

// ---------------- GPS · รูปถ่าย · ลิงก์ ----------------
/** ระยะทางบนผิวโลก (เมตร) — haversine */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, rad = (x: number) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** ความแม่นยำ GPS (เมตร) — มากกว่า 100 m มักมาจากเสาสัญญาณ/Wi-Fi ไม่ใช่ดาวเทียม */
export function gpsQuality(accuracyM: number): 'good' | 'fair' | 'poor' {
  return accuracyM <= 30 ? 'good' : accuracyM <= 100 ? 'fair' : 'poor'
}

/** ขนาดรูปหลังย่อให้ด้านยาวไม่เกิน max (คงสัดส่วน · ไม่ขยายรูปเล็ก) */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h))
  return { w: Math.round(w * k), h: Math.round(h * k) }
}

/** ลิงก์นำทางไปพิกัด (เปิดแอป Google Maps บนมือถือ) */
export const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`

/** ลิงก์ที่ปลอดภัยสำหรับ href — รับเฉพาะ http(s) และรูปแบบ data:image (กัน javascript: ฯลฯ) */
export function safeHttpUrl(u?: string): string | undefined {
  if (!u) return undefined
  return /^https?:\/\//i.test(u) || /^data:image\//i.test(u) ? u : undefined
}

// ---------------- แบบร่างยืนยันติดตั้ง (รายเครื่อง) ----------------
//   รีวิวเฟส 5: #1 เก็บรายเครื่อง (เดิมช่องเดียว เปิดเครื่องอื่น = ร่างเดิมหาย) · #4 GPS อัตโนมัติอย่างเดียวไม่นับเป็นร่าง ·
//   #5 ไม่ชวนทำต่อเครื่องที่ยืนยันไม่ได้ · #8 ตัวร่างไม่มีรูป (รูปอยู่ IndexedDB — src/ui/draftPhotos.ts) ·
//   #9 ผูกผู้ใช้ + อายุนับจากวันที่เริ่ม
export interface ConfirmDraft {
  unitId: string
  /** ผู้ใช้ที่เริ่มร่าง — แท็บเล็ตหน้างานที่ใช้ร่วมกัน คนอื่นไม่เห็น */
  userId?: string
  installedDate: string
  lat?: number; lng?: number; accuracy?: number
  memberId?: string; note?: string
  /** มีรูปเก็บแยกไว้ (IndexedDB) */
  hasPhoto?: boolean
  /** เริ่มร่างเมื่อ — อายุ 2 วันนับจากนี้ (บันทึกต่อไม่ต่ออายุ) */
  startedAt?: string
  savedAt: string
}
export type DraftStore = Record<string, ConfirmDraft>
export const DRAFT_STORE_KEY = 'lbs-install-drafts-v2'
/** ร่างเก่าแบบช่องเดียว (ก่อนรีวิว) — ลบทิ้งตอนเปิดหน้า */
export const LEGACY_DRAFT_KEY = 'lbs-install-draft-v1'
const DRAFT_MAX = 10
const DRAFT_MAX_DAYS = 2

export function parseDraftStore(raw: string | null): DraftStore {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: DraftStore = {}
    for (const [k, v] of Object.entries(o as Record<string, ConfirmDraft>)) {
      if (v && v.unitId === k && typeof v.savedAt === 'string' && typeof v.installedDate === 'string') out[k] = v
    }
    return out
  } catch { return {} }
}
export const serializeDraftStore = (s: DraftStore) => JSON.stringify(s)

/** มีอะไรที่ผู้ใช้กรอกเองไหม — GPS จับอัตโนมัติตอนเปิดฟอร์ม ไม่นับ (จับใหม่ได้เสมอ) */
export const draftHasContent = (p: { hasPhoto: boolean; note?: string }) => p.hasPhoto || !!p.note?.trim()

/** เพิ่ม/แทนร่างของเครื่องนี้ (เครื่องอื่นคงไว้) · ไม่เก็บรูปในตัวร่าง · คงวันที่เริ่มเดิม · เก็บสูงสุด 10 เครื่องล่าสุด */
export function putDraft(store: DraftStore, d: ConfirmDraft, nowIso: string): DraftStore {
  const { photo: _photo, ...rest } = d as ConfirmDraft & { photo?: unknown }
  const prev = store[d.unitId]
  const startedAt = (prev && prev.userId === d.userId ? prev.startedAt : undefined) ?? d.startedAt ?? nowIso
  const next: DraftStore = { ...store, [d.unitId]: { ...rest, startedAt, savedAt: nowIso } }
  const keys = Object.keys(next).sort((a, b) => next[b].savedAt.localeCompare(next[a].savedAt))
  return Object.fromEntries(keys.slice(0, DRAFT_MAX).map(k => [k, next[k]]))
}
export function removeDraft(store: DraftStore, unitId: string): DraftStore {
  if (!store[unitId]) return store
  const next = { ...store }
  delete next[unitId]
  return next
}
const draftAlive = (d: ConfirmDraft, userId: string | undefined, today: string) => {
  if (!userId || d.userId !== userId) return false
  const started = bkkDate(d.startedAt ?? d.savedAt)
  return !!started && daysBetweenIso(started, today) <= DRAFT_MAX_DAYS
}
/** ร่างของเครื่องนี้ — เฉพาะผู้ใช้คนเดิม · ไม่เกิน 2 วันนับจากวันที่เริ่ม */
export function getDraft(store: DraftStore, unitId: string, userId: string | undefined, today: string): ConfirmDraft | null {
  const d = store[unitId]
  return d && draftAlive(d, userId, today) ? d : null
}

/**
 * ร่างที่ควรชวน "ทำต่อ" (ล่าสุดก่อน) — ตัดเครื่องที่ยืนยันไม่ได้แล้ว: ไม่ได้อยู่หน้างาน · ติดตั้งแล้ว ·
 * มีคำขอคืนเข้าคลังรอ Division พิจารณา (0098 ปฏิเสธ) · มีผลบันทึกหลังเริ่มร่าง (เช่น บันทึกติดตั้งไม่ได้ไปแล้ว)
 */
export function resumableDraft(db: DB, store: DraftStore, userId: string | undefined, today: string):
  { d: ConfirmDraft; unit: DB['lbsUnits'][number]; jobId: string } | null {
  const list = Object.values(store).filter(d => draftAlive(d, userId, today))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  for (const d of list) {
    const unit = db.lbsUnits.find(u => u.id === d.unitId && u.status === 'issued')
    if (!unit?.jobId) continue
    const rows = db.unitInstallations.filter(r => r.unitId === unit.id)
    const latest = rows.reduce<typeof rows[number] | undefined>((b, r) => !b || r.performedAt >= b.performedAt ? r : b, undefined)
    if (latest?.outcome === 'installed') continue
    if (latest && latest.performedAt >= (d.startedAt ?? d.savedAt)) continue
    if (db.approvalRequests.some(r => r.status === 'pending' && r.type === 'return_lbs' && (r.payload.unitIds ?? []).includes(unit.id))) continue
    return { d, unit, jobId: unit.jobId }
  }
  return null
}

// ---------------- คำขอ async ล่าสุดเท่านั้น (GPS) ----------------
/** ผลของคำขอเก่าที่ตอบกลับช้า (GPS รอได้ถึง 15 วิ) ห้ามทับฟอร์มที่เปิดใหม่แล้ว — รีวิวเฟส 5 #6 */
export function createLatestGuard() {
  let cur = 0
  return {
    next: () => ++cur,
    isCurrent: (t: number) => t === cur,
    invalidate: () => { cur++ },
  }
}

// ---------------- Warranty: ประเภทเอกสารที่จะแนบ ----------------
/** ประเภทที่เลือกผูกกับงาน — เปิดงานอื่น = ว่าง ไม่ว่าจะปิดกล่องทางไหน (รีวิวเฟส 5 #2) */
export function docTypeForJob<T extends string>(sel: { jobId: string; type: T | '' } | null, jobId: string | null | undefined): T | '' {
  return sel && jobId && sel.jobId === jobId ? sel.type : ''
}

// ---------------- ตารางนัดติดตั้ง ----------------
export interface AgendaItem {
  kind: 'install' | 'rescheduled'; jobId: string; jobNo: string; customer: string; detail?: string
  /** install: งานนี้ยังต้องมอบหมายทีม (jobNeedsTeam — กติกาเดียวทุกหน้า · รีวิวเฟส 5 #3) */
  needsTeam?: boolean
}

/**
 * นัดรายวัน `days` วันนับจาก `from` — จากข้อมูลจริงเท่านั้น
 *   install     = วันในช่วงนัดติดตั้ง (jobs.install_start/end_date) ของงานที่ยังไม่ปิด/ยกเลิก
 *   rescheduled = วันที่บันทึกเลื่อนนัด (site_visits) พร้อมเหตุผล/นัดใหม่
 * คืนเฉพาะวันที่มีรายการ
 */
export function scheduleAgenda(db: DB, from: string, days: number): { date: string; items: AgendaItem[] }[] {
  const out: { date: string; items: AgendaItem[] }[] = []
  for (let i = 0; i < days; i++) {
    const date = addDaysIso(from, i)
    const items: AgendaItem[] = []
    for (const v of db.siteVisits) {
      if (v.outcome !== 'rescheduled' || bkkDate(v.performedAt) !== date) continue
      const j = db.jobs.find(x => x.id === v.jobId)
      if (!j) continue
      items.push({ kind: 'rescheduled', jobId: j.id, jobNo: j.jobNo, customer: j.customerName,
        detail: `${v.reason}${v.newStartDate ? ` → นัดใหม่ ${v.newStartDate}${v.newEndDate && v.newEndDate !== v.newStartDate ? `–${v.newEndDate}` : ''}` : ''}` })
    }
    for (const j of db.jobs) {
      if (j.terminalStatus === 'installed' || j.terminalStatus === 'cancelled') continue
      const start = j.installStartDate?.slice(0, 10)
      if (!start) continue
      const end = j.installEndDate?.slice(0, 10) || start
      if (start <= date && date <= end) items.push({ kind: 'install', jobId: j.id, jobNo: j.jobNo, customer: j.customerName,
        detail: j.issueLocation || j.installLocation, needsTeam: jobNeedsTeam(db, j) })
    }
    if (items.length) out.push({ date, items })
  }
  return out
}

// ---------------- Warranty ----------------
export const WARRANTY_URGENT_DAYS = 30
export type WarrantyFilter = 'all' | 'active' | 'expiring' | 'urgent' | 'expired' | 'not_started'
export interface WarrantyRow { inst: JobWarranty; lbs: JobWarranty[] }

function tier(w: JobWarranty, today: string) {
  const s = warrantyStatus(w, today)
  return { state: s.state, urgent: s.state === 'expiring' && s.daysLeft <= WARRANTY_URGENT_DAYS }
}

/**
 * แถว (1 Job) ผ่านตัวกรองไหม — ดูทั้งประกันงานติดตั้งและประกัน LBS รายเครื่อง
 * 🔴 เฟส 5: เดิมป้ายนับแต่ LBS แต่ตัวกรองดูประกันงานติดตั้งด้วย ⇒ ป้าย 0 แต่มีแถวขึ้น — ตอนนี้ป้ายนับทั้งสองแบบ
 */
/** ประกันใบเดียวเข้าเงื่อนไขไหม — ใช้กรองรายเครื่องในแถว */
export function warrantyMatches(w: JobWarranty, filter: WarrantyFilter, today: string): boolean {
  if (filter === 'all') return true
  const t = tier(w, today)
  return filter === 'urgent' ? t.urgent : t.state === filter
}

export function warrantyRowMatches(row: WarrantyRow, filter: WarrantyFilter, today: string): boolean {
  return [row.inst, ...row.lbs].some(w => warrantyMatches(w, filter, today))
}

type Tally = { active: number; expiring: number; urgent: number; expired: number; not_started: number }
const zero = (): Tally => ({ active: 0, expiring: 0, urgent: 0, expired: 0, not_started: 0 })

/** นับแยก LBS รายเครื่อง / ประกันงานติดตั้งรายงาน — ป้ายบนหน้า Warranty (urgent = ใกล้หมด ≤30 วัน ซ้อนใน expiring) */
export function warrantyCounts(rows: WarrantyRow[], today: string): { lbs: Tally; installation: Tally } {
  const lbs = zero(), installation = zero()
  const add = (t: Tally, w: JobWarranty) => { const x = tier(w, today); t[x.state]++; if (x.urgent) t.urgent++ }
  rows.forEach(r => { add(installation, r.inst); r.lbs.forEach(w => add(lbs, w)) })
  return { lbs, installation }
}
