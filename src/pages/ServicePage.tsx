import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can, ownsJob } from '../data/StoreContext'
import { jobCloseReason } from '../data/flow'
import { closeoutFiles, deriveJobStatus, jobDelivery, jobInstallSummary, jobIsFieldActive, qtyOutToField, effectiveQty, unitInstallState, unitJobSite, pendingRevertRequest, lbsReturnBlockReason, jobTeam, memberFullName, serviceIssues, bangkokTodayIso } from '../data/logic'
import {
  todayFieldJobs, jobNeedsTeam, distanceMeters, gpsQuality, mapsUrl, safeHttpUrl,
  DRAFT_STORE_KEY, LEGACY_DRAFT_KEY, parseDraftStore, serializeDraftStore, putDraft, removeDraft, getDraft,
  draftHasContent, resumableDraft, createLatestGuard, type DraftStore,
} from '../data/field'
import { draftPhotoKey, putDraftPhoto, getDraftPhoto, deleteDraftPhoto, pruneDraftPhotos } from '../ui/draftPhotos'
import { compressImage } from '../ui/photo'
import { AssignTeamModal } from '../ui/AssignTeamModal'
import { UnitEvidenceCard } from '../ui/UnitEvidenceCard'
import type { ServiceIssueKind } from '../data/logic'

const ISSUE_KIND: Record<ServiceIssueKind, { label: string; cls: string }> = {
  close_summary: { label: 'สรุปตอนปิดงาน', cls: 'amber' },
  site_visit: { label: 'ติดปัญหาหน้างาน', cls: 'red' },
  unit_blocked: { label: 'เครื่องติดตั้งไม่ได้', cls: 'red' },
}
import { DeliveryBadge, Modal, useToast, useTryAction } from '../ui/components'
import { CloseoutForm, initCloseoutDraft, closeoutMissing, buildCloseoutInput, type CloseoutDraft } from '../ui/CloseoutForm'
import { fmtDate, fmtDateTime } from '../ui/format'
import { supabase } from '../lib/supabase'

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ'))
    r.readAsDataURL(file)
  })
}

export default function ServicePage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { show } = useToast()
  const canConfirm = can(user, 'service.confirm')
  // 0080 — ปิดงานติดตั้ง: Project ทุกคน + Service + Manage (มติผู้ใช้ 2026-09-29) · ปุ่มอื่นของช่างยังเป็นของ Service
  const canCloseJob = can(user, 'job.closeInstall')
  // 0090 — ขอยกเลิกผลติดตั้งที่บันทึกผิด (Service + Project) → รอ Division พิจารณา
  const canRequestRevert = can(user, 'install.revertRequest')
  const [revertFor, setRevertFor] = useState<string | null>(null)        // jobId
  const [revertIds, setRevertIds] = useState<string[]>([])
  const [revertReason, setRevertReason] = useState('')
  // 0094 (มติ Q1) — เครื่องติดตั้งไม่ได้ → ขอคืนเข้า LBS Inventory → Division ตรวจรับ
  const [returnFor, setReturnFor] = useState<string | null>(null)        // jobId
  const [returnIds, setReturnIds] = useState<string[]>([])
  const [returnReason, setReturnReason] = useState('')
  // หลักฐานต่อเครื่อง (เฟส B) — วันที่ / GPS / รูป
  const [installedDate, setInstalledDate] = useState('')
  const [note, setNote] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [, setDraftTick] = useState(0)                                // วาดใหม่หลังล้างแบบร่าง (อ่านจาก localStorage)
  const [accuracy, setAccuracy] = useState<number | null>(null)   // เฟส 5: ±m ของ GPS (ไม่เก็บลง DB — โชว์/เตือนเท่านั้น)
  const [locating, setLocating] = useState(false)
  const [photo, setPhoto] = useState<{ file: File; preview: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // modal รายเครื่องของ Job + ขั้นตอนย่อย (ยืนยัน / ติดตั้งไม่ได้)
  const [unitJobId, setUnitJobId] = useState<string | null>(null)
  const [step, setStep] = useState<{ unitId: string; mode: 'confirm' | 'block' } | null>(null)
  const [blockReason, setBlockReason] = useState('')
  // ปิดงานติดตั้ง + สรุปปัญหาของงาน (บังคับตอบก่อนปิด — 0040)
  const [closeFor, setCloseFor] = useState<string | null>(null)
  const [closeNote, setCloseNote] = useState('')
  const [hasIssues, setHasIssues] = useState<boolean | null>(null)   // null = ยังไม่ตอบ
  const [issueDetail, setIssueDetail] = useState('')
  // dataUrl เก็บทุกชนิดไฟล์ (โหมด demo ใช้เป็น URL) · isImage ใช้แค่ตัดสินว่าจะโชว์ preview
  const [issueFile, setIssueFile] = useState<{ file: File; dataUrl: string; isImage: boolean } | null>(null)
  const [closeDraft, setCloseDraft] = useState<CloseoutDraft | null>(null)   // 0079 — เอกสารรับมอบ + Warranty
  const [closing, setClosing] = useState(false)
  // มอบหมายทีม (เฟส C)
  const [assignFor, setAssignFor] = useState<string | null>(null)
  const [installerId, setInstallerId] = useState('')   // ช่างที่ลงมือติดตั้งเครื่องนี้
  // เลื่อน/ติดปัญหาหน้างาน (เฟส A)
  const [visitFor, setVisitFor] = useState<string | null>(null)
  const [visitOutcome, setVisitOutcome] = useState<'rescheduled' | 'failed'>('rescheduled')
  const [visitReason, setVisitReason] = useState('')
  const [visitStart, setVisitStart] = useState('')
  const [visitEnd, setVisitEnd] = useState('')

  const [showIssues, setShowIssues] = useState(false)   // พาเนลรวมปัญหา — เริ่มต้นซ่อน
  // รายการวัสดุในคอลัมน์ "ของที่เบิก" — เก็บ jobId ที่กางอยู่ · เริ่มต้นซ่อนทุกงาน
  // เหตุผล: ช่างเปิดหน้านี้เพื่อดูว่า "งานไหนต้องไปวันไหน ทีมใคร" — รายการวัสดุยาวจนดันแถวสูง
  // แล้วเห็นงานได้น้อยลงต่อจอ · ของจริงจะเปิดดูตอนจะหยิบของขึ้นรถเท่านั้น
  const [openMat, setOpenMat] = useState<Set<string>>(new Set())
  const toggleMat = (jobId: string) => setOpenMat(prev => {
    const next = new Set(prev)
    if (next.has(jobId)) next.delete(jobId); else next.add(jobId)
    return next
  })
  const issues = serviceIssues(db)
  const openIssues = issues.filter(i => !i.jobClosed).length

  const ready = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue')
  // 0071: งานที่ "เบิกบางส่วน" ก็ต้องอยู่ในตารางนี้ — ของอยู่กับช่างแล้ว แค่ใบยังไม่ครบ
  //   เดิมกรอง terminalStatus === 'issued' อย่างเดียว ⇒ งาน partially_issued หลุดทั้ง 2 พาเนล
  //   (ไม่อยู่ใน "รอ Project เบิกให้" เพราะไม่ใช่ ready_to_issue แล้ว) = หายไปจากหน้านี้ทั้งใบ
  const issued = db.jobs.filter(j => jobIsFieldActive(db, j))
  const installed = db.jobs.filter(j => j.terminalStatus === 'installed')

  const unitsOf = (jobId: string) => db.lbsUnits.filter(u => u.jobId === jobId)
  /** เครื่องที่ออกจากคลังไปอยู่กับช่างแล้ว — ตารางงานหน้าไซต์ต้องดูตัวนี้ ไม่ใช่ทุกเครื่องบนใบ (0071) */
  const unitsOut = (jobId: string) => db.lbsUnits.filter(u => u.jobId === jobId && u.status === 'issued')
  // วัสดุของงานนี้ที่ "อยู่ในมือ Job" (เบิกจากคลังแล้ว หรือรับของจาก PO ครบแล้ว)
  const accOf = (jobId: string) => db.accessoryRequests.filter(r =>
    r.jobId === jobId && (r.status === 'issued' || r.status === 'received'))
  /**
   * 0071 — แยก "ของที่ส่งถึงช่างแล้ว" ออกจาก "ของที่ยังค้างอยู่กับ Project"
   * ตั้งแต่ 0067 วัสดุเบิกทีละบางส่วนได้ ⇒ คอลัมน์นี้เคยโชว์ qtyRequested เต็มจำนวนเสมอ
   * ช่างจึงอ่านว่าได้ของครบทั้งที่จริงได้มาแค่บางส่วน (คลาสเดียวกับที่ Serial LBS เคยโชว์เกิน)
   */
  const accSplit = (jobId: string) => {
    const rows = accOf(jobId)
    return {
      sent: rows.map(r => ({ r, out: qtyOutToField(r) })).filter(x => x.out > 0),
      waitingCount: rows.filter(r => qtyOutToField(r) === 0).length,
    }
  }
  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const userOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  // เหตุผลที่ปิดงานยังไม่ได้ — ตัวเดียวกับ Job Detail/แถบขั้นต่อไป (เฟส 2 ย้ายไป src/data/flow.ts) · '' = ปิดได้
  const closeReason = (_jobId: string, s: ReturnType<typeof jobInstallSummary>) => jobCloseReason(s)
  const canCloseNow = (_jobId: string, s: ReturnType<typeof jobInstallSummary>) => s.canClose
  // แถวยืนยันล่าสุดของเครื่อง (ใช้โชว์หลักฐาน/เหตุผล)
  //   เวลาเท่ากัน = แถวที่ต่อท้ายทีหลังชนะ (ตรงกับ unitInstallState — 0090 reverted ต้องชนะแถวที่มันยกเลิก)
  const lastInstallRow = (unitId: string) =>
    db.unitInstallations.reduce<typeof db.unitInstallations[number] | undefined>(
      (best, r) => r.unitId === unitId && (!best || r.performedAt >= best.performedAt) ? r : best, undefined)

  // เฟส 5: พิกัดนำทางของงาน — จุดติดตั้งของเครื่องที่ยังรอยืนยันก่อน · ไม่มี = จุดที่ 1 ตามแผน
  const jobSitesWithCoords = (j: typeof db.jobs[number]): { lat: number; lng: number } | null => {
    for (const u of unitsOut(j.id)) {
      if (unitInstallState(db, u.id) === 'installed') continue
      const s = unitJobSite(db, u)
      if (s?.lat != null && s?.lng != null) return { lat: s.lat, lng: s.lng }
    }
    return j.planLat != null && j.planLng != null ? { lat: j.planLat, lng: j.planLng } : null
  }
  const unitJob = unitJobId ? db.jobs.find(j => j.id === unitJobId) : null
  const stepUnit = step ? db.lbsUnits.find(u => u.id === step.unitId) : null
  const closeJob = closeFor ? db.jobs.find(j => j.id === closeFor) : null
  const assignJob = assignFor ? db.jobs.find(j => j.id === assignFor) : null
  const visitJob = visitFor ? db.jobs.find(j => j.id === visitFor) : null
  const activeMembers = db.teamMembers.filter(m => m.isActive)
  // ตัวเลือกช่างในฟอร์มยืนยัน: ทีมที่มอบหมายไว้ก่อน (ถ้ายังไม่มอบหมาย = ช่างที่ใช้งานทั้งหมด)
  const installerOptions = (jobId: string) => {
    const team = jobTeam(db, jobId).map(t => t.member).filter(m => m.isActive)
    return team.length > 0 ? team : activeMembers
  }
  // ประวัติออกหน้างานล่าสุดต่อ Job (ใหม่สุด)
  const lastVisit = (jobId: string) =>
    db.siteVisits.filter(v => v.jobId === jobId).sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0]

  // รีวิวเฟส 5 #6: GPS รอได้ถึง 15 วิ — ผลของคำขอเก่า (ฟอร์มเครื่องก่อน / กดกลับไปแล้ว) ไม่ทับฟอร์มปัจจุบัน
  const gpsGuard = useRef(createLatestGuard()).current
  const restoreGuard = useRef(createLatestGuard()).current
  const captureLocation = () => {
    if (!navigator.geolocation) { show('อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง', true); return }
    const t = gpsGuard.next()
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (!gpsGuard.isCurrent(t)) return
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setAccuracy(Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null)
        setLocating(false)
      },
      err => {
        if (!gpsGuard.isCurrent(t)) return
        show(`ระบุตำแหน่งไม่สำเร็จ: ${err.message} — เปิดสิทธิ์ Location ให้เบราว์เซอร์`, true); setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  const pickPhoto = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) { show('กรุณาเลือกไฟล์รูปภาพ', true); return }
    // เฟส 5: ย่อด้านยาว ≤1600 px เป็น JPEG ก่อน — เน็ตหน้างานส่งไว · HEIC เปิดได้ทุกเบราว์เซอร์ · demo ไม่เต็มพื้นที่
    const c = await compressImage(file)
    setPhoto({ file: c.file, preview: c.dataUrl })
  }

  // LIVE: อัปโหลดเข้า Supabase Storage คืน public URL · demo: เก็บ data URL ตรงๆ
  const resolvePhotoUrl = async (jobId: string, unitId: string): Promise<string> => {
    if (!photo) throw new Error('ต้องแนบรูปถ่ายของเครื่องนี้ก่อนยืนยัน')
    if (!supabase) return photo.preview
    const ext = (photo.file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${jobId}/${unitId}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('install-photos').upload(path, photo.file, { upsert: false })
    if (error) throw new Error(`อัปโหลดรูปไม่สำเร็จ: ${error.message} (ตรวจว่าสร้าง bucket install-photos แล้ว)`)
    return supabase.storage.from('install-photos').getPublicUrl(path).data.publicUrl
  }

  // เปิดฟอร์มยืนยันเครื่อง — reset หลักฐานทุกครั้ง (หลักฐานต่อเครื่อง ห้ามใช้ซ้ำ)
  //   เฟส 5: วันที่ตั้งต้น = วันนี้เวลาไทย (เดิม UTC ⇒ 00:00–06:59 ได้เมื่อวาน) · กู้แบบร่างที่ค้างในเครื่อง ·
  //   ไม่มีแบบร่าง = ขอ GPS ทันทีที่เปิด (ช่างไม่ต้องกดเอง — ยืนข้างเครื่องอยู่แล้ว)
  const openUnitConfirm = async (unitId: string, jobId = unitJobId) => {
    const today = bangkokTodayIso()
    gpsGuard.invalidate(); setLocating(false)
    const seq = restoreGuard.next()
    const draft = getDraft(readStore(), unitId, user?.id, today)
    const lead = jobId ? jobTeam(db, jobId).find(t => t.assignment.isLead) : undefined
    setInstalledDate(draft?.installedDate ?? today)
    setNote(draft?.note ?? '')
    setCoords(draft?.lat != null && draft?.lng != null ? { lat: draft.lat, lng: draft.lng } : null)
    setAccuracy(draft?.accuracy ?? null)
    setInstallerId(draft?.memberId ?? lead?.member.id ?? '')
    setPhoto(null)
    setStep({ unitId, mode: 'confirm' })
    if (!draft || draft.lat == null) captureLocation()
    // รูปของร่างอยู่ IndexedDB (#8) — โหลดเสร็จช้ากว่าการเปิดฟอร์ม: เปิดเครื่องอื่น/กดกลับไปแล้ว = ไม่ใส่
    if (draft?.hasPhoto && user) {
      const blob = await getDraftPhoto(draftPhotoKey(user.id, unitId))
      if (blob && restoreGuard.isCurrent(seq)) {
        const file = new File([blob], `${unitId}.jpg`, { type: blob.type || 'image/jpeg' })
        try { const preview = await readAsDataUrl(file); if (restoreGuard.isCurrent(seq)) setPhoto({ file, preview }) } catch { /* รูปเสีย = ถ่ายใหม่ */ }
      }
    }
  }

  const openAssign = (jobId: string) => setAssignFor(jobId)   // เฟส 5: กล่องมอบหมายทีมใช้ร่วมกับหน้า Schedule
  const openUnitBlock = (unitId: string) => { setBlockReason(''); setStep({ unitId, mode: 'block' }) }

  // 0090 — คำขอยกเลิกผลติดตั้งที่ค้างอยู่ของ Job (มีได้ใบเดียวต่อ Job)
  const pendingRevert = (jobId: string) => pendingRevertRequest(db, jobId)
  const openRevert = (jobId: string, unitId: string) => {
    // ปิด modal รายเครื่องก่อน — ไม่ซ้อน 2 modal (ฟอร์มนี้มีรายการเครื่องให้เลือกในตัวอยู่แล้ว)
    setUnitJobId(null); setStep(null)
    setRevertIds([unitId]); setRevertReason(''); setRevertFor(jobId)
  }
  const pendingReturn = (jobId: string) =>
    db.approvalRequests.find(r => r.jobId === jobId && r.type === 'return_lbs' && r.status === 'pending')
  const openReturn = (jobId: string, unitId: string | string[]) => {
    setUnitJobId(null); setStep(null)                       // ไม่ซ้อน 2 popup
    setReturnIds(Array.isArray(unitId) ? unitId : [unitId]); setReturnReason(''); setReturnFor(jobId)
  }
  const submitReturn = async () => {
    if (!returnFor) return
    const ok = await tryAction(
      () => act.requestReturnLbs({ jobId: returnFor, unitIds: returnIds, reason: returnReason }),
      `ส่งคำขอคืน LBS ${returnIds.length} เครื่องเข้าคลังแล้ว — รอ Division พิจารณา`)
    if (ok) setReturnFor(null)
  }
  const submitRevert = async () => {
    if (!revertFor) return
    const ok = await tryAction(
      () => act.requestRevertInstall({ jobId: revertFor, unitIds: revertIds, reason: revertReason }),
      `ส่งคำขอยกเลิกผลติดตั้ง ${revertIds.length} เครื่องแล้ว — รอ Division พิจารณา`)
    if (ok) setRevertFor(null)
  }
  // ---- แบบร่างยืนยันติดตั้ง (เฟส 5) — ข้อมูลไม่หายเมื่อเปิดกล้องแล้วหน้าโหลดใหม่ / เน็ตหลุด / ปิดกล่องไปก่อน ----
  //   รีวิวเฟส 5: เก็บรายเครื่อง (#1) · GPS อัตโนมัติอย่างเดียวไม่นับเป็นร่าง (#4) · ตัวร่างเล็ก (localStorage · หน่วง 400 ms
  //   + บันทึกทันทีตอนหน้าถูกซ่อน เช่น เปิดกล้อง) รูปแยกไป IndexedDB เขียนเฉพาะตอนรูปเปลี่ยน (#8) · ผูกผู้ใช้ (#9)
  function readStore(): DraftStore { try { return parseDraftStore(localStorage.getItem(DRAFT_STORE_KEY)) } catch { return {} } }
  const writeStore = (st: DraftStore) => { try { localStorage.setItem(DRAFT_STORE_KEY, serializeDraftStore(st)) } catch { /* เต็ม/ปิดไว้ = ไม่เก็บ */ } }
  const clearDraft = (unitId: string) => {
    writeStore(removeDraft(readStore(), unitId))
    if (user) void deleteDraftPhoto(draftPhotoKey(user.id, unitId))
    setDraftTick(t => t + 1)
  }
  // ครั้งแรกที่เปิดหน้า: ลบร่างแบบเก่า (ช่องเดียว) + รูปที่ไม่มีร่างแล้ว
  useEffect(() => {
    try { localStorage.removeItem(LEGACY_DRAFT_KEY) } catch { /* ไม่มี */ }
    const keep = new Set(Object.values(readStore()).map(d => d.userId ? draftPhotoKey(d.userId, d.unitId) : ''))
    void pruneDraftPhotos(keep)
  }, [])
  const pendingSave = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (step?.mode !== 'confirm' || !user) return
    if (!draftHasContent({ hasPhoto: !!photo, note })) return   // GPS ที่จับเองอย่างเดียว = ยังไม่ได้กรอกอะไร
    const unitId = step.unitId, userId = user.id
    const save = () => {
      pendingSave.current = null
      writeStore(putDraft(readStore(), {
        unitId, userId, installedDate, lat: coords?.lat, lng: coords?.lng, accuracy: accuracy ?? undefined,
        memberId: installerId || undefined, note: note || undefined, hasPhoto: !!photo, savedAt: '',
      }, new Date().toISOString()))
    }
    pendingSave.current = save
    const t = window.setTimeout(save, 400)
    return () => window.clearTimeout(t)
  }, [step, installedDate, coords, accuracy, installerId, note, photo, user])
  useEffect(() => {
    // เปิดกล้องบนมือถือ = หน้าถูกซ่อน (และอาจถูกปิดทิ้ง) — บันทึกที่ค้างหน่วงอยู่ทันที
    const flush = () => { if (document.visibilityState === 'hidden') pendingSave.current?.() }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [])
  // รูปเขียนแยก เฉพาะตอนรูปเปลี่ยน (ไม่ใช่ทุกตัวอักษรที่พิมพ์)
  useEffect(() => {
    if (step?.mode !== 'confirm' || !user || !photo) return
    void putDraftPhoto(draftPhotoKey(user.id, step.unitId), photo.file)
  }, [photo, step, user])
  // แบบร่างที่ค้างจากรอบก่อน — โชว์แถบ "ทำต่อ" บนสุด · ไม่ชวนเครื่องที่ยืนยันไม่ได้แล้ว (#5)
  const pendingDraft = !canConfirm || step ? null : resumableDraft(db, readStore(), user?.id, bangkokTodayIso())
  const backToList = () => {
    gpsGuard.invalidate(); restoreGuard.invalidate(); pendingSave.current = null
    setLocating(false); setStep(null); setCoords(null); setAccuracy(null); setPhoto(null)
  }

  const submitUnitConfirm = async () => {
    if (!step || !unitJobId || !coords || !photo) return
    setSubmitting(true)
    try {
      const photoUrl = await resolvePhotoUrl(unitJobId, step.unitId)
      const ok = await tryAction(
        () => act.confirmUnitInstall({
          unitId: step.unitId, installedDate, note,
          checkinLat: coords.lat, checkinLng: coords.lng, photoUrl,
          installedByMemberId: installerId || undefined,
        }),
        `ยืนยันติดตั้ง ${stepUnit?.serialLvb ?? ''} แล้ว`)
      if (ok) { clearDraft(step.unitId); backToList() }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
    setSubmitting(false)
  }

  const submitUnitBlock = async () => {
    if (!step) return
    const ok = await tryAction(
      () => act.blockUnitInstall({ unitId: step.unitId, reason: blockReason }),
      `บันทึกว่า ${stepUnit?.serialLvb ?? ''} ติดตั้งไม่ได้ + แจ้ง Project แล้ว`)
    if (ok) { clearDraft(step.unitId); backToList() }    // #5: บันทึกติดตั้งไม่ได้แล้ว ไม่ต้องชวนยืนยันต่อ
  }

  // อัปโหลดไฟล์แนบปัญหา — LIVE: เข้า Storage · demo: เก็บ data URL
  const resolveIssueFileUrl = async (jobId: string): Promise<string | undefined> => {
    if (!issueFile) return undefined
    if (!supabase) return issueFile.dataUrl   // demo: เก็บเป็น data URL (ทุกชนิดไฟล์)
    const ext = (issueFile.file.name.split('.').pop() || 'bin').toLowerCase()
    const path = `job-issues/${jobId}/${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('install-photos').upload(path, issueFile.file, { upsert: false })
    if (error) throw new Error(`แนบไฟล์ไม่สำเร็จ: ${error.message}`)
    return supabase.storage.from('install-photos').getPublicUrl(path).data.publicUrl
  }

  // เปิดโมดัลปิดงาน — เคลียร์คำตอบเรื่องปัญหาทุกครั้ง ห้ามค้างจากงานก่อน
  const openClose = (jobId: string) => {
    setCloseNote(''); setHasIssues(null); setIssueDetail(''); setIssueFile(null)
    const job = db.jobs.find(j => j.id === jobId)
    setCloseDraft(job ? initCloseoutDraft(db, job) : null)
    setCloseFor(jobId)
  }

  const submitClose = async () => {
    if (!closeFor || hasIssues === null || !closeDraft) return
    setClosing(true)
    try {
      const issueFileUrl = hasIssues ? await resolveIssueFileUrl(closeFor) : undefined
      // อัปโหลดเอกสารรับมอบ/Warranty ก่อน แล้วส่ง path ไปกับ RPC (RPC พัง = ไฟล์ค้างเป็นขยะ ไม่ใช่ข้อมูลรั่ว)
      const closeout = await buildCloseoutInput(closeDraft, closeFor)
      const ok = await tryAction(() => act.closeJobInstall({
        jobId: closeFor, note: closeNote,
        hasIssues, issueDetail: hasIssues ? issueDetail : undefined, issueFileUrl,
        closeout,
      }), hasIssues ? 'ปิดงานแล้ว — บันทึกปัญหาและแจ้ง Project' : 'ปิดงานติดตั้งแล้ว — แจ้ง Project อัตโนมัติ')
      if (ok) { setCloseFor(null); setUnitJobId(null); setIssueFile(null); setHasIssues(null); setIssueDetail(''); setCloseDraft(null) }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
    setClosing(false)
  }

  const openVisit = (jobId: string) => {
    setVisitOutcome('rescheduled'); setVisitReason(''); setVisitStart(''); setVisitEnd(''); setVisitFor(jobId)
  }
  const submitVisit = async () => {
    if (!visitFor) return
    const ok = await tryAction(
      () => act.logSiteVisit({
        jobId: visitFor, outcome: visitOutcome, reason: visitReason,
        newStartDate: visitOutcome === 'rescheduled' ? visitStart : undefined,
        newEndDate: visitOutcome === 'rescheduled' ? (visitEnd || visitStart) : undefined,
      }),
      visitOutcome === 'rescheduled' ? 'บันทึกเลื่อนนัด + แจ้ง Project แล้ว' : 'บันทึกปัญหาหน้างาน + แจ้ง Project แล้ว')
    if (ok) setVisitFor(null)
  }

  return (
    <>
      <div className="page-title">Service (Installation)</div>
      <div className="page-sub">
        รับงานที่เบิกแล้ว → เข้าติดตั้งหน้างาน → ยืนยัน<b>รายเครื่อง</b> (Check-in GPS + รูปถ่าย ต่อเครื่อง) → ปิดงาน
      </div>

      {/* มุมมองรวมปัญหางานบริการ — ดึงจาก 3 แหล่ง (สรุปตอนปิดงาน / ติดปัญหาหน้างาน / เครื่องติดตั้งไม่ได้) */}
      {issues.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>⚠️ ปัญหางานบริการ ({issues.length})
              {openIssues > 0 && <span className="badge red" style={{ marginLeft: 8 }}>ยังไม่ปิดงาน {openIssues}</span>}
            </h3>
            <button className="small" onClick={() => setShowIssues(v => !v)}>
              {showIssues ? 'ซ่อนรายการ' : `แสดงรายการ (${issues.length})`}
            </button>
          </div>
          {showIssues && (
            <div className="table-scroll">
              <table>
                <thead><tr><th>ประเภท</th><th>Job No.</th><th>รายละเอียด</th><th>เมื่อ</th><th>โดย</th></tr></thead>
                <tbody>
                  {issues.map(is => (
                    <tr key={is.key} style={{ opacity: is.jobClosed ? 0.65 : 1 }}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className={`badge ${ISSUE_KIND[is.kind].cls}`}>{ISSUE_KIND[is.kind].label}</span>
                        {is.jobClosed && <div className="muted">ปิดงานแล้ว</div>}
                      </td>
                      <td>
                        <Link to={`/jobs/${is.jobId}`}><b>{is.jobNo}</b></Link>
                        <div className="muted">{is.customerName}</div>
                      </td>
                      <td style={{ maxWidth: 380 }}>
                        {is.serial && <span className="mono">{is.serial}: </span>}{is.detail}
                        {is.fileUrl && <> · <a href={is.fileUrl} target="_blank" rel="noreferrer">📎 ไฟล์แนบ</a></>}
                      </td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(is.at)}</td>
                      <td className="muted">{userOf(is.by)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {pendingDraft && (
        <div className="draft-banner" role="status">
          <span>📝 มีข้อมูลยืนยันติดตั้ง <b className="mono">{pendingDraft.unit.serialLvb}</b> ที่ยังไม่บันทึก
            <span className="muted"> · เก็บไว้ในเครื่องนี้เมื่อ {fmtDateTime(pendingDraft.d.savedAt)}</span></span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="small primary" onClick={() => { setUnitJobId(pendingDraft.jobId); openUnitConfirm(pendingDraft.unit.id, pendingDraft.jobId) }}>ทำต่อ</button>
            <button className="small" onClick={() => { clearDraft(pendingDraft.unit.id); show('ล้างข้อมูลที่ค้างแล้ว') }}>ล้าง</button>
          </span>
        </div>
      )}

      {/* เฟส 5 — งานของฉันวันนี้: การ์ดใหญ่ใช้บนมือถือ (ช่างที่ผูกบัญชีเห็นเฉพาะงานของทีมตัวเอง) */}
      {canConfirm && (() => {
        const todays = todayFieldJobs(db, user, bangkokTodayIso())
        return (
          <div className="panel">
            <div className="panel-head"><h3>📍 งานของฉันวันนี้ ({todays.length})
              <span className="muted" style={{ fontWeight: 400 }}> · ถึงวันนัดแล้ว ยังมีเครื่องรอยืนยัน</span></h3></div>
            {todays.length === 0 ? <div className="panel-body muted">ไม่มีงานที่ถึงวันนัดวันนี้</div> : (
              <div className="today-list">
                {todays.map(({ job: j, overdueDays, pendingUnits }) => {
                  const site = jobSitesWithCoords(j)
                  return (
                    <div key={j.id} className={`today-card${overdueDays > 0 ? ' is-late' : ''}`}>
                      <div className="today-head">
                        <b>{j.jobNo}</b>
                        {overdueDays > 0 ? <span className="badge red">เลยวันนัด {overdueDays} วัน</span>
                          : <span className="badge blue">นัดถึง {fmtDate(j.installEndDate || j.installStartDate)}</span>}
                      </div>
                      <div>{j.customerName}</div>
                      <div className="muted">📍 {j.issueLocation || j.installLocation || '-'} · รอยืนยัน {pendingUnits} เครื่อง</div>
                      <div className="today-actions">
                        <button className="primary" onClick={() => { setStep(null); setUnitJobId(j.id) }}>🔧 ยืนยันรายเครื่อง</button>
                        {site && <a className="btn-like" href={mapsUrl(site.lat, site.lng)} target="_blank" rel="noreferrer">🧭 นำทาง</a>}
                        {j.contactPhone && <a className="btn-like" href={`tel:${j.contactPhone.replace(/[^0-9+]/g, '')}`}>📞 โทรลูกค้า</a>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })()}

      <div className="panel">
        <div className="panel-head"><h3>รอ Project เบิกให้ ({ready.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า</th><th>สถานที่</th><th>กำหนดติดตั้ง</th><th>สถานะกำหนดส่ง</th></tr></thead>
            <tbody>
              {ready.length === 0 && <tr><td colSpan={5}><div className="empty">ไม่มีงานพร้อมเบิก</div></td></tr>}
              {ready.map(j => {
                // 0075: ฝั่ง Service เคยไม่เห็นสัญญาณเรื่องกำหนดส่งเลย — เห็นแต่วันที่เปล่า ๆ
                //   ทั้งที่เป็นคนที่ต้องเร่งจริงเมื่อของพร้อมแล้วแต่ยังไม่ออกหน้างาน
                const d = jobDelivery(db, j)
                return (
                  <tr key={j.id}>
                    <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                    <td>{j.customerName}</td>
                    <td>{j.installLocation || '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {d.due ? fmtDate(d.due) : '-'}
                      {d.extension && d.contractDue && (
                        <div className="muted" style={{ fontSize: 11 }}>เลื่อนจาก {fmtDate(d.contractDue)}</div>
                      )}
                    </td>
                    <td><DeliveryBadge d={d} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>เบิกแล้ว — งานที่อยู่กับทีมช่าง ({issued.length}) <span className="muted" style={{ fontWeight: 400 }}>· รวมงานที่ติดตั้งครบแล้วแต่ยังไม่กดปิดงาน</span></h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ของที่เบิก</th><th>ติดตั้ง</th><th></th></tr></thead>
            <tbody>
              {issued.length === 0 && <tr><td colSpan={5}><div className="empty">ไม่มีงานที่อยู่กับทีมช่าง</div></td></tr>}
              {issued.map(j => {
                const s = jobInstallSummary(db, j.id)
                return (
                  <tr key={j.id}>
                    <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link>
                      {/* 0071: งานที่ของยังออกไม่ครบ ต้องบอกให้ชัดตั้งแต่คอลัมน์แรก — ช่างจะได้รู้ว่า
                          ที่ยกไปหน้างานไม่ใช่ทั้งใบ และปุ่มปิดงานที่กดไม่ได้ไม่ใช่ระบบเสีย */}
                      {s.waiting > 0 && (
                        <div style={{ marginTop: 3 }}>
                          <span className="badge amber">เบิกบางส่วน {s.outTotal}/{s.total}</span>
                          <div className="muted" style={{ fontSize: 11 }}>ค้างอีก {s.waiting} เครื่อง</div>
                        </div>
                      )}
                    </td>
                    <td>{j.customerName}
                      {j.contactPhone && <> · <a href={`tel:${j.contactPhone.replace(/[^0-9+]/g, '')}`}>📞 {j.contactPhone}</a></>}
                      <div className="muted">
                        📍 {j.issueLocation || j.installLocation || '-'}
                        {(() => { const c = jobSitesWithCoords(j); return c && <> · <a href={mapsUrl(c.lat, c.lng)} target="_blank" rel="noreferrer">🧭 นำทาง</a></> })()}
                        {j.installStartDate && <> · 📅 นัดติดตั้ง <b>{fmtDate(j.installStartDate)} – {fmtDate(j.installEndDate)}</b></>}
                      </div>
                      {/* 0075 — สถานะกำหนดส่งเทียบกำหนดที่มีผล (ไม่ใช่ requiredDate ดิบ) */}
                      <div style={{ marginTop: 3 }}><DeliveryBadge d={jobDelivery(db, j)} /></div>
                      {j.issuedNote && <div className="muted">📝 {j.issuedNote}</div>}
                      {(() => { const v = lastVisit(j.id); return v && (
                        <div className="muted" style={{ color: v.outcome === 'failed' ? 'var(--danger)' : undefined }}>
                          {v.outcome === 'rescheduled' ? '⏰ เลื่อนนัดแล้ว' : '⚠️ ติดปัญหา'}: {v.reason}
                        </div>
                      )})()}
                      {(() => {
                        const team = jobTeam(db, j.id)
                        // เฟส 5: ติดตั้งครบแล้วไม่ต้องมีทีม — ไม่ขึ้นแดง (มอบหมายก็ไม่ได้แล้ว)
                        return team.length === 0
                          ? (jobNeedsTeam(db, j) ? <div className="muted" style={{ color: 'var(--danger)' }}>👷 ยังไม่มอบหมายทีม</div> : null)
                          : <div className="muted">👷 {team.map(t =>
                              `${t.member.firstName} ${t.member.lastName}${t.assignment.isLead ? ' (หัวหน้า)' : ''}`).join(', ')}</div>
                      })()}</td>
                    <td>
                      {(() => {
                        // 0071: คอลัมน์นี้คือ "ของที่อยู่กับช่างแล้ว" — ต้องนับเฉพาะเครื่องที่ออกจากคลังจริง
                        //   เดิมใช้ unitsOf (ทุกเครื่องบนใบ) ซึ่งเท่ากันตอนที่เบิกทั้งใบเท่านั้น
                        //   พอเบิกทีละล็อต จะโชว์ Serial ของเครื่องที่ยังอยู่คลัง = ช่างออกไปหาของที่ไม่มี
                        const units = unitsOut(j.id)
                        const { sent: acc, waitingCount } = accSplit(j.id)
                        const matOpen = openMat.has(j.id)
                        return <>
                          <div><b>LBS {units.length} เครื่อง</b>
                            {s.waiting > 0 && <span className="muted"> (ยังไม่เบิกอีก {s.waiting})</span>}
                          </div>
                          {/* Serial คู่ LVB + OM รายเครื่อง — ช่างต้องเทียบกับป้ายบนตัวเครื่องหน้างาน
                              ทั้ง 2 เลข เดิมโชว์แค่ LVB ต่อกันเป็นพืดจึงเทียบไม่ได้ (2026-08-28) */}
                          {units.map(u => (
                            <div key={u.id} className="mono" style={{ fontSize: 12, lineHeight: 1.5 }}>
                              {u.serialLvb || '-'}
                              <span className="muted mono"> / {u.serialOm || '-'}</span>
                            </div>
                          ))}
                          {acc.length > 0 && <>
                            <button className="small" style={{ marginTop: 6 }}
                              onClick={() => toggleMat(j.id)}
                              aria-expanded={matOpen}>
                              {matOpen ? 'ซ่อนรายการวัสดุ' : `วัสดุ ${acc.length} รายการ`}
                            </button>
                            {matOpen && acc.map(({ r, out }) => {
                              const it = itemOf(r.itemId)!
                              const ordered = effectiveQty(r)
                              return (
                                <div key={r.id} className="muted">
                                  {it.name} × <b>{out}</b> {it.uom}
                                  {/* ส่งมาไม่ครบบรรทัด — ต้องเห็นว่ายังมีของตามมาอีก ไม่งั้นช่างนับของหน้างานแล้วคิดว่าขาด */}
                                  {out < ordered && (
                                    <span style={{ color: 'var(--amber, #d97706)' }}> (จาก {ordered} · ตามมาอีก {ordered - out})</span>
                                  )}
                                </div>
                              )
                            })}
                          </>}
                          {/* วัสดุที่รับของ/เบิกคลังแล้วแต่ยังไม่ได้ส่งต่อให้ช่างเลยสักชิ้น */}
                          {waitingCount > 0 && (
                            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                              ยังไม่ได้ส่งอีก {waitingCount} รายการ (อยู่กับ Project)
                            </div>
                          )}
                        </>
                      })()}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* ตัวเลขที่ช่างต้องใช้คือ "ของที่ยกไปแล้วติดตั้งไปกี่เครื่อง" (รอบนี้)
                          ส่วน n/ทั้งใบ เป็นภาพรวมที่ใช้ตัดสินว่าปิดงานได้หรือยัง — โชว์แยกบรรทัด (0071) */}
                      <span className={`badge ${s.unitsDone ? 'green' : s.outInstalled > 0 ? 'blue' : 'neutral'}`}>
                        {s.outInstalled}/{s.outTotal} เครื่อง
                      </span>
                      {s.waiting > 0 && <div className="muted" style={{ fontSize: 11 }}>ทั้งใบ {s.installed}/{s.total}</div>}
                      {s.blocked > 0 && <div className="muted" style={{ color: 'var(--danger)' }}>ติดตั้งไม่ได้ {s.blocked}</div>}
                      {/* issuedAt ตั้งตอนปิดใบครบเท่านั้น — งานที่เบิกบางส่วนต้องใช้ lbsIssuedAt
                          (เวลาที่ LBS ออกจากคลังรอบแรก) ไม่งั้นโชว์ "เบิก -" ทั้งที่ของออกไปแล้ว */}
                      <div className="muted">เบิก {fmtDateTime(j.issuedAt ?? j.lbsIssuedAt)}</div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* 0089: ติดตั้งครบทุกเครื่องแล้ว = งานหน้าไซต์จบ เหลือขั้นเดียวคือปิดงาน
                          ซ่อนมอบหมายทีม / เลื่อน-ติดปัญหา (ทำได้ผิดอย่างเดียว — เลื่อนนัดงานที่จบแล้ว ·
                          ยิง LINE "ติดปัญหา" หา Project) · ปุ่มรายเครื่องเหลือไว้ดูหลักฐานอย่างเดียว
                          กติกาตัวจริงอยู่ที่ logic.ts + trigger 0089 ฝั่ง SQL — ซ่อนปุ่มอย่างเดียวไม่พอ */}
                      {(() => {
                        const done = s.total > 0 && s.installed === s.total
                        return <>
                          {done && (
                            <div style={{ marginBottom: 6, fontSize: 12.5, color: '#15803d', fontWeight: 600 }}>
                              ✅ ติดตั้งครบทุกเครื่อง — ขั้นต่อไป: ปิดงาน
                            </div>
                          )}
                          {canConfirm && !done && (
                            <button className="small" style={{ marginRight: 6 }}
                              onClick={() => openAssign(j.id)}>
                              👷 มอบหมายทีม
                            </button>
                          )}
                          {/* 0090: Project เปิดดูหลักฐาน + ขอยกเลิกผลได้ (ยืนยัน/ติดตั้งไม่ได้ ยังเป็นของ Service) */}
                          {(canConfirm || canRequestRevert) && (
                            <button className="small" style={{ marginRight: 6 }}
                              onClick={() => { setStep(null); setUnitJobId(j.id) }}>
                              {done || !canConfirm ? '📋 ดูหลักฐานรายเครื่อง' : '🔧 ยืนยันรายเครื่อง'}
                            </button>
                          )}
                          {pendingRevert(j.id) && (
                            <span className="badge amber" style={{ marginRight: 6 }}>⏳ ขอยกเลิกผลติดตั้ง — รอ Division พิจารณา</span>
                          )}
                          {pendingReturn(j.id) && (
                            <span className="badge amber" style={{ marginRight: 6 }}>⏳ ขอคืนเข้าคลัง — รอ Division พิจารณา</span>
                          )}
                          {/* เฟส 5: เครื่องติดตั้งไม่ได้ต้องคืนเข้าคลังก่อนปิดงาน (0094) — บอกบนแถวพร้อมปุ่ม (เดิมอยู่ใน tooltip/ในกล่องรายเครื่อง) */}
                          {(() => {
                            const blockedIds = unitsOut(j.id).filter(u => unitInstallState(db, u.id) === 'blocked').map(u => u.id)
                            if (blockedIds.length === 0 || pendingReturn(j.id)) return null
                            // รีวิว Flow ข้อ 1 (มติ 2026-11-24): ใบยังเบิกไม่ครบ = ยังขอคืนไม่ได้ — ปุ่มจาง + เหตุผล (เดิมกดได้แล้วเจอ error ทางตัน)
                            const notYet = lbsReturnBlockReason(j)
                            return (
                              <div className="row-cta">
                                ⚠️ ติดตั้งไม่ได้ {blockedIds.length} เครื่อง — ต้องขอคืนเข้า LBS Inventory ก่อนปิดงาน
                                {notYet && <> (ขอคืนได้หลังเบิกของที่เหลือครบใบ)</>}
                                {canRequestRevert && ownsJob(user, j) && (
                                  <button className="small" style={{ marginLeft: 6 }} onClick={() => openReturn(j.id, blockedIds)}
                                    disabled={!!notYet} title={notYet ?? undefined}>{notYet ? '🔒 ' : ''}📦 ขอคืนเข้าคลัง</button>
                                )}
                              </div>
                            )
                          })()}
                          {canCloseJob && (
                            <button className="small success" style={{ marginRight: 6 }}
                              disabled={!canCloseNow(j.id, s)} title={closeReason(j.id, s)}
                              onClick={() => { openClose(j.id) }}>
                              🏁 ปิดงาน
                            </button>
                          )}
                          {canConfirm && !done && <button className="small" onClick={() => openVisit(j.id)}>เลื่อน/ติดปัญหา</button>}
                          {/* ติดตั้งครบแต่ปิดไม่ได้ (เช่น วัสดุค้างเบิก) — บอกเหตุผลตรง ๆ ไม่ต้องไปชี้ tooltip */}
                          {s.unitsDone && canCloseJob && !canCloseNow(j.id, s) && (
                            <div className="muted" style={{ marginTop: 4, fontSize: 11.5, whiteSpace: 'normal', maxWidth: 360 }}>
                              {closeReason(j.id, s)}
                            </div>
                          )}
                        </>
                      })()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>ติดตั้งเสร็จแล้ว ({installed.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ปิดงานเมื่อ</th><th>ยืนยันโดย</th><th>หลักฐานรายเครื่อง</th></tr></thead>
            <tbody>
              {installed.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่มีงานติดตั้งเสร็จ</div></td></tr>}
              {installed.map(j => {
                const s = jobInstallSummary(db, j.id)
                return (
                  <tr key={j.id}>
                    <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                    <td>{j.customerName}<div className="muted">{j.installLocation}</div></td>
                    <td>{fmtDate(j.installedAt)}
                      <div className="muted">{s.installed}/{s.total} เครื่อง{s.blocked > 0 ? ` · ติดปัญหา ${s.blocked}` : ''}</div>
                    </td>
                    <td>{userOf(j.installConfirmedBy)}</td>
                    <td>
                      {unitsOf(j.id).map(u => {
                        const r = lastInstallRow(u.id)
                        if (!r) return <div key={u.id} className="muted mono">{u.serialLvb} —</div>
                        if (r.outcome === 'blocked') return (
                          <div key={u.id} className="muted" style={{ color: 'var(--danger)' }}>
                            <span className="mono">{u.serialLvb}</span> ⚠️ {r.reason}
                          </div>
                        )
                        return (
                          <div key={u.id} className="muted">
                            <span className="mono">{u.serialLvb}</span>{' '}
                            {safeHttpUrl(r.photoUrl) && <a href={safeHttpUrl(r.photoUrl)} target="_blank" rel="noreferrer">🖼️</a>}{' '}
                            {r.checkinLat != null && r.checkinLng != null && (
                              <a href={`https://www.google.com/maps?q=${r.checkinLat},${r.checkinLng}`} target="_blank" rel="noreferrer">
                                📍 {r.checkinLat.toFixed(5)}, {r.checkinLng.toFixed(5)}
                              </a>
                            )}
                            {r.installedByMemberId && <> · 👷 {memberFullName(db, r.installedByMemberId)}</>}
                          </div>
                        )
                      })}
                      {j.installNote && <div className="muted">📝 {j.installNote}</div>}
                      {/* สรุปปัญหาของงาน (0040) */}
                      {j.closeHasIssues === true && (
                        <div className="muted" style={{ color: 'var(--danger)' }}>
                          ⚠️ <b>มีปัญหา:</b> {j.closeIssueDetail}
                          {j.closeIssueFileUrl && <> · <a href={j.closeIssueFileUrl} target="_blank" rel="noreferrer">📎 ไฟล์แนบ</a></>}
                        </div>
                      )}
                      {j.closeHasIssues === false && <div className="muted">✅ ไม่มีปัญหา</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* modal รายเครื่อง — step null = รายการ, step = ฟอร์มยืนยัน/ติดตั้งไม่ได้ */}
      {unitJob && !step && (() => {
        const s = jobInstallSummary(db, unitJob.id)
        return (
          <Modal title={`${s.total > 0 && s.installed === s.total ? 'หลักฐานติดตั้งรายเครื่อง' : 'ยืนยันติดตั้งรายเครื่อง'} — ${unitJob.jobNo}`}
            onClose={() => setUnitJobId(null)}
            footer={<>
              <button onClick={() => setUnitJobId(null)}>ปิด</button>
              <button className="success" disabled={!canCloseNow(unitJob.id, s)} title={closeReason(unitJob.id, s)}
                onClick={() => { setUnitJobId(null); openClose(unitJob.id) }}>
                🏁 ปิดงาน ({s.installed}/{s.total})
              </button>
            </>}>
            {/* ธีม Glass (canvas หน้า 7): หัว = ป้ายติดตั้งครบ x/y + ลูกค้า · สถานที่ — การ์ดรายเครื่องด้านล่าง */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span className={`badge ${s.total > 0 && s.installed === s.total ? 'green' : 'neutral'}`}>ติดตั้งแล้ว {s.installed}/{s.total} เครื่อง</span>
              {s.blocked > 0 && <span className="badge red">ติดตั้งไม่ได้ {s.blocked}</span>}
            </div>
            <p className="muted" style={{ marginBottom: 12 }}>
              {unitJob.customerName} · 📍 {unitJob.issueLocation || unitJob.installLocation || '-'} — ยืนยันทีละเครื่อง
              พร้อม Check-in GPS + รูปถ่ายของเครื่องนั้น ๆ
              {/* 0071: เครื่องที่ยังอยู่คลังไม่ขึ้นในตารางนี้ — ยืนยันไม่ได้อยู่แล้วทั้งฝั่ง demo และ RPC
                  ถ้าโชว์ไว้ช่างจะกดแล้วเจอ error ทั้งที่ไม่ใช่ความผิดตัวเอง จึงบอกเป็นบรรทัดสรุปแทน */}
              {s.waiting > 0 && (
                <><br />แสดงเฉพาะ <b>{s.outTotal} เครื่องที่เบิกออกมาแล้ว</b> · อีก <b>{s.waiting} เครื่อง</b> รอ Project เบิกให้ในรอบถัดไป</>
              )}
            </p>
            {/* ธีม Glass (canvas หน้า 7): เดิมเป็นตาราง → การ์ดหลักฐานรายเครื่อง (รูปย่อ · วันที่ · ช่าง · GPS · บันทึก)
                สถานะ/ปุ่ม/เงื่อนไขสิทธิ์ ยกมาจากตารางเดิมทั้งชุด ไม่เปลี่ยน — การ์ด (UnitEvidenceCard) แสดงผลอย่างเดียว */}
            <div className="unit-ev-sec">หลักฐานรายเครื่อง</div>
            <div className="unit-ev-list">
                  {unitsOut(unitJob.id).map(u => {
                    const st = unitInstallState(db, u.id)
                    const r = lastInstallRow(u.id)
                    const revertReq = pendingRevert(unitJob.id)
                    const revertPending = !!revertReq?.payload.unitIds?.includes(u.id)
                    const returnReq = pendingReturn(unitJob.id)
                    const returnPending = !!returnReq?.payload.unitIds?.includes(u.id)
                    // 0086: งานหลายจุด — ช่างต้องรู้ว่าเครื่องนี้ไปสถานีไหน กำหนดวันไหน
                    const site = unitJobSite(db, u)
                    return (
                      <UnitEvidenceCard key={u.id} serialLvb={u.serialLvb} serialOm={u.serialOm}
                        evidence={st === 'installed' && r ? {
                          date: r.installedDate, lat: r.checkinLat, lng: r.checkinLng, photoUrl: r.photoUrl, note: r.note,
                          by: r.installedByMemberId ? memberFullName(db, r.installedByMemberId) : undefined,
                        } : undefined}
                        photoLabel={st === 'blocked' ? 'ติดตั้งไม่ได้' : 'รอติดตั้ง'}
                        site={<>
                          📍 {site ? `จุดที่ ${site.no} · ${site.location || '-'}` : '-'}
                          {site?.lat != null && site?.lng != null && <> · <a href={mapsUrl(site.lat, site.lng)} target="_blank" rel="noreferrer">🧭 นำทาง</a></>}
                          {site?.requiredDate && <div className="muted" style={{ fontSize: 12 }}>กำหนด {fmtDate(site.requiredDate)}</div>}
                        </>}
                        status={<>
                          {st === 'installed' && <span className="badge green">✅ ติดตั้งแล้ว</span>}
                          {st === 'blocked' && <><span className="badge red">⚠️ ติดตั้งไม่ได้</span><div className="muted">{r?.reason}</div></>}
                          {st === 'pending' && <span className="badge neutral">รอติดตั้ง</span>}
                          {/* 0090: ผลเดิมถูกยกเลิก (Division อนุมัติแล้ว) — บอกช่างว่าทำไมเครื่องนี้กลับมารอติดตั้ง */}
                          {st === 'pending' && r?.outcome === 'reverted' && (
                            <div className="muted" style={{ fontSize: 12, maxWidth: 260, whiteSpace: 'normal' }}>
                              ↩️ ยกเลิกผลเดิมแล้ว: {r.reason}
                            </div>
                          )}
                          {revertPending && (
                            <div><span className="badge amber" title={revertReq?.payload.reason}>⏳ ขอยกเลิกผล — รอ Division พิจารณา</span></div>
                          )}
                          {returnPending && (
                            <div><span className="badge amber" title={returnReq?.payload.reason}>⏳ ขอคืนเข้าคลัง — รอ Division พิจารณา</span></div>
                          )}
                        </>}
                        actions={<>
                          {/* 0090: ยืนยันผิดเครื่อง → ขอยกเลิกผล (ไม่แก้ตรง · ต้องผ่าน Division) */}
                          {/* 0091: Project ขอได้เฉพาะงานที่ตัวเองเปิด (DB ตรวจซ้ำที่ rpc_request_revert_install) */}
                          {/* 0094 (มติ Q1): ติดตั้งไม่ได้ → ขอคืนเข้า LBS Inventory (ต้องคืนก่อนปิดงาน · ไม่มีตัดจำหน่าย) */}
                          {st === 'blocked' && canRequestRevert && ownsJob(user, unitJob) && !returnReq && (
                            <button className="small" style={{ marginRight: 6 }} onClick={() => openReturn(unitJob.id, u.id)}
                              disabled={!!lbsReturnBlockReason(unitJob)}
                              title={lbsReturnBlockReason(unitJob) ?? 'เครื่องนี้ติดตั้งไม่ได้ — ส่งคำขอให้ Division ตรวจรับกลับเข้า LBS Inventory'}>
                              {lbsReturnBlockReason(unitJob) ? '🔒 ' : ''}📦 ขอคืนเข้าคลัง
                            </button>
                          )}
                          {st === 'installed' && canRequestRevert && ownsJob(user, unitJob) && !revertReq && (
                            <button className="small" onClick={() => openRevert(unitJob.id, u.id)}
                              title="ยืนยันผิดเครื่อง/ข้อมูลผิด — ส่งคำขอให้ Division พิจารณา">
                              ↩️ ขอยกเลิกผลติดตั้ง
                            </button>
                          )}
                          {/* เฟส 5 (0098): ระหว่างรอ Division พิจารณาคืนเข้าคลัง ยืนยันติดตั้งไม่ได้ — เดิมกดได้แล้วคำขอค้าง ปิดงานไม่ได้ */}
                          {st !== 'installed' && canConfirm && returnPending && (
                            <span className="muted" style={{ fontSize: 12 }}>ยืนยันไม่ได้ระหว่างรอคืนเข้าคลัง</span>
                          )}
                          {st !== 'installed' && canConfirm && !returnPending && (
                            <>
                              <button className="small success" style={{ marginRight: 6 }}
                                onClick={() => openUnitConfirm(u.id)}>
                                {st === 'blocked' ? 'ยืนยันใหม่' : '✅ ยืนยันติดตั้ง'}
                              </button>
                              {st === 'pending' && (
                                <button className="small danger" onClick={() => openUnitBlock(u.id)}>ติดตั้งไม่ได้</button>
                              )}
                            </>
                          )}
                        </>} />
                    )
                  })}
            </div>
          </Modal>
        )
      })()}

      {/* ฟอร์มยืนยันเครื่อง — บังคับ วันที่ + GPS + รูป ต่อเครื่อง */}
      {unitJob && stepUnit && step?.mode === 'confirm' && (
        <Modal title={`ยืนยันติดตั้ง — ${stepUnit.serialLvb}`} onClose={backToList}
          footer={<>
            <button onClick={backToList}>← กลับรายการ</button>
            <button className="success" disabled={submitting || !installedDate || !coords || !photo}
              title={!coords ? 'ต้อง Check-in ตำแหน่งก่อน' : !photo ? 'ต้องแนบรูปก่อน' : ''}
              onClick={submitUnitConfirm}>
              {submitting ? 'กำลังบันทึก...' : 'ยืนยันเครื่องนี้'}
            </button>
          </>}>
          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="panel-body">
              <b>ตรวจ Serial ให้ตรงกับเครื่องหน้างาน</b>
              <div className="mono">LVB: {stepUnit.serialLvb}</div>
              <div className="mono">OM: {stepUnit.serialOm}</div>
              <div className="muted">{unitJob.jobNo} · {unitJob.customerName}</div>
            </div>
          </div>
          <label className="field"><span>วันที่ติดตั้งจริง *</span>
            <input type="date" value={installedDate} max={bangkokTodayIso()} onChange={e => setInstalledDate(e.target.value)} />
          </label>

          <label className="field"><span>Check-in ตำแหน่งของเครื่องนี้ (GPS) *</span></label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <button type="button" onClick={captureLocation} disabled={locating}>
              {locating ? 'กำลังระบุ...' : coords ? '📍 ระบุตำแหน่งใหม่' : '📍 Check-in ตำแหน่ง'}
            </button>
            {coords
              ? <span className={`badge ${accuracy == null ? 'green' : gpsQuality(accuracy) === 'poor' ? 'red' : gpsQuality(accuracy) === 'fair' ? 'amber' : 'green'}`}>
                  {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}{accuracy != null && ` · ±${Math.round(accuracy)} m`}
                </span>
              : <span className="muted">{locating ? 'กำลังหาตำแหน่ง…' : 'ยังไม่ได้ Check-in'}</span>}
          </div>
          {/* เฟส 5: เตือนพิกัดหยาบ (มักมาจากเสาสัญญาณ) + ห่างจากจุดติดตั้งตามแผน */}
          {coords && accuracy != null && gpsQuality(accuracy) === 'poor' && (
            <div className="gps-warn">⚠️ ความแม่นยำต่ำ (±{Math.round(accuracy)} m) — ออกไปที่โล่ง รอสักครู่แล้วกด "ระบุตำแหน่งใหม่"</div>
          )}
          {coords && (() => {
            const site = unitJobSite(db, stepUnit)
            if (site?.lat == null || site?.lng == null) return null
            const m = distanceMeters(coords, { lat: site.lat, lng: site.lng })
            return (
              <div className={m > 500 ? 'gps-warn' : 'muted'} style={{ marginBottom: 12, fontSize: 12.5 }}>
                {m > 500 ? '⚠️ ' : ''}ห่างจากจุดที่ {site.no} ตามแผน {m >= 1000 ? `${(m / 1000).toFixed(1)} กม.` : `${Math.round(m)} ม.`}
                {m > 500 && ' — ตรวจว่าอยู่ถูกจุด/ถูกเครื่อง'}
              </div>
            )
          })()}

          <label className="field"><span>รูปถ่ายเครื่องนี้หน้างาน *</span>
            <input type="file" accept="image/*" capture="environment"
              onChange={e => pickPhoto(e.target.files?.[0])} />
          </label>
          {photo && <img src={photo.preview} alt="preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, marginBottom: 12, display: 'block' }} />}

          <label className="field"><span>ช่างที่ติดตั้งเครื่องนี้</span>
            <select value={installerId} onChange={e => setInstallerId(e.target.value)}>
              <option value="">— ไม่ระบุ —</option>
              {installerOptions(unitJob.id).map(m => (
                <option key={m.id} value={m.id}>{m.firstName} {m.lastName} · {m.position}</option>
              ))}
            </select>
          </label>
          {activeMembers.length === 0 && (
            <div className="muted" style={{ marginBottom: 12 }}>
              ยังไม่มีช่างในทะเบียน — เพิ่มได้ที่หน้า Service &amp; Scheduling
            </div>
          )}

          <label className="field"><span>บันทึกของเครื่องนี้ (ผลการทดสอบ ฯลฯ)</span>
            <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="test energize ผ่าน" />
          </label>
          <div className="muted" style={{ fontSize: 12 }}>
            💾 ข้อมูลที่กรอก (รวมรูปที่ย่อแล้ว) เก็บไว้ในเครื่องนี้ให้อัตโนมัติ — หน้าโหลดใหม่ตอนเปิดกล้อง/เน็ตหลุด แล้วกลับมาทำต่อได้
            {' '}<button className="link-btn" onClick={() => { pendingSave.current = null; clearDraft(stepUnit.id); setCoords(null); setAccuracy(null); setPhoto(null); setNote('') }}>ล้างข้อมูลที่กรอก</button>
          </div>
        </Modal>
      )}

      {/* มอบหมายทีมให้งาน (เฟส C · เฟส 5 ย้ายเป็นชิ้นกลาง src/ui/AssignTeamModal.tsx) */}
      {assignJob && <AssignTeamModal job={assignJob} onClose={() => setAssignFor(null)} />}

      {/* ฟอร์มติดตั้งไม่ได้ */}
      {stepUnit && step?.mode === 'block' && (
        <Modal title={`ติดตั้งไม่ได้ — ${stepUnit.serialLvb}`} onClose={backToList}
          footer={<>
            <button onClick={backToList}>← กลับรายการ</button>
            <button className="danger" disabled={!blockReason.trim()} onClick={submitUnitBlock}>
              บันทึก + แจ้ง Project
            </button>
          </>}>
          <p className="muted" style={{ marginBottom: 12 }}>
            เครื่อง <span className="mono">{stepUnit.serialLvb}</span> ติดตั้งไม่ได้ — Project จะได้รับแจ้งทันทีเพื่อหาทางแก้
            (ยืนยันใหม่ได้ภายหลังถ้าแก้ปัญหาได้)
          </p>
          <label className="field"><span>เหตุผล *</span>
            <textarea rows={3} value={blockReason} onChange={e => setBlockReason(e.target.value)}
              placeholder="เช่น เครื่องเสียหายจากการขนส่ง / จุดติดตั้งยังไม่เดินสายเมน" />
          </label>
        </Modal>
      )}

      {/* 0090 — ขอยกเลิกผลติดตั้งที่บันทึกผิด → รอ Division พิจารณา */}
      {revertFor && (() => {
        const rj = db.jobs.find(j => j.id === revertFor)
        if (!rj) return null
        const candidates = unitsOf(rj.id).filter(u => unitInstallState(db, u.id) === 'installed')
        const toggle = (id: string) => setRevertIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
        return (
          <Modal title={`ขอยกเลิกผลติดตั้ง — ${rj.jobNo}`} onClose={() => setRevertFor(null)}
            footer={<>
              <button onClick={() => setRevertFor(null)}>ยกเลิก</button>
              <button className="danger" disabled={revertIds.length === 0 || !revertReason.trim()} onClick={submitRevert}>
                ส่งคำขอ ({revertIds.length} เครื่อง)
              </button>
            </>}>
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-body muted" style={{ fontSize: 13 }}>
                ใช้เมื่อ <b>บันทึกผลติดตั้งผิด</b> เช่น กดยืนยันผิดเครื่อง · Serial สลับกัน · รูป/GPS ผิดจุด<br />
                ① คำขอไปรอ Division พิจารณา → ② อนุมัติแล้วเครื่องกลับเป็น <b>"รอติดตั้ง"</b> ยืนยันใหม่พร้อมหลักฐานที่ถูกต้องได้<br />
                หลักฐานเดิม (วันที่ · GPS · รูป · ช่าง) <b>ไม่ถูกลบ</b> — เก็บไว้ในประวัติพร้อมเหตุผลที่ยกเลิก
              </div>
            </div>
            <label className="field"><span>เครื่องที่จะยกเลิกผล *</span></label>
            <div style={{ marginBottom: 12 }}>
              {candidates.map(u => (
                <label key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                  <input type="checkbox" checked={revertIds.includes(u.id)} onChange={() => toggle(u.id)} />
                  <span className="mono">{u.serialLvb}</span>
                  <span className="muted mono">{u.serialOm}</span>
                  <span className="muted">· ติดตั้ง {fmtDate(lastInstallRow(u.id)?.installedDate)}</span>
                </label>
              ))}
            </div>
            <label className="field"><span>เหตุผล *</span>
              <textarea rows={3} value={revertReason} onChange={e => setRevertReason(e.target.value)}
                placeholder="เช่น กดยืนยันผิดเครื่อง — เครื่องที่ติดตั้งจริงคือ C106407 ไม่ใช่ C106406" />
            </label>
          </Modal>
        )
      })()}

      {/* 0094 — ขอคืน LBS ที่ติดตั้งไม่ได้เข้าคลัง → รอ Division พิจารณา */}
      {returnFor && (() => {
        const rj = db.jobs.find(j => j.id === returnFor)
        if (!rj) return null
        const candidates = unitsOut(rj.id).filter(u => unitInstallState(db, u.id) !== 'installed')
        const toggle = (id: string) => setReturnIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
        return (
          <Modal title={`ขอคืน LBS เข้าคลัง — ${rj.jobNo}`} onClose={() => setReturnFor(null)}
            footer={<>
              <button onClick={() => setReturnFor(null)}>ยกเลิก</button>
              <button className="primary" disabled={returnIds.length === 0 || !returnReason.trim()} onClick={submitReturn}>
                ส่งคำขอ ({returnIds.length} เครื่อง)
              </button>
            </>}>
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-body muted" style={{ fontSize: 13 }}>
                ใช้กับเครื่องที่ <b>ติดตั้งไม่ได้</b> — ต้องคืนเข้า LBS Inventory ก่อนจึงปิดงานได้<br />
                ① คำขอไปรอ Division พิจารณา → ② Division ตรวจรับแล้วเครื่องกลับเป็น <b>ว่างในคลังเดิม</b> ดึงไปใช้งานอื่นได้<br />
                ประวัติการติดตั้งไม่ได้ของเครื่องนี้ยังเก็บไว้ครบ
              </div>
            </div>
            <label className="field"><span>เครื่องที่จะคืน *</span></label>
            <div style={{ marginBottom: 12 }}>
              {candidates.map(u => (
                <label key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                  <input type="checkbox" checked={returnIds.includes(u.id)} onChange={() => toggle(u.id)} />
                  <span className="mono">{u.serialLvb}</span>
                  <span className="muted mono">{u.serialOm}</span>
                  {unitInstallState(db, u.id) === 'blocked' && <span className="muted">· ติดตั้งไม่ได้: {lastInstallRow(u.id)?.reason}</span>}
                </label>
              ))}
            </div>
            <label className="field"><span>เหตุผล *</span>
              <textarea rows={3} value={returnReason} onChange={e => setReturnReason(e.target.value)}
                placeholder="เช่น ลูกค้ายกเลิกจุดติดตั้งที่ 2 / ฐานรากไม่พร้อม เลื่อนไม่มีกำหนด" />
            </label>
          </Modal>
        )
      })()}

      {/* ปิดงานติดตั้ง */}
      {closeJob && (() => {
        const s = jobInstallSummary(db, closeJob.id)
        // ทุกข้อที่ยังขาด — ปุ่มปิดงานกดได้เมื่อรายการนี้ว่าง (ตัวตัดสินจริงคือ RPC)
        const missing = [
          ...(closeDraft ? closeoutMissing(closeDraft, closeoutFiles(db, closeJob.id)) : ['ฟอร์มเอกสารรับมอบ']),
          ...(hasIssues === null ? ['ระบุว่างานนี้มีปัญหาหรือไม่'] : []),
          ...(hasIssues && !issueDetail.trim() ? ['รายละเอียดปัญหา'] : []),
        ]
        return (
          <Modal title={`ปิดงานติดตั้ง — ${closeJob.jobNo}`} size="xl" locked={closing} onClose={() => { if (!closing) setCloseFor(null) }}
            footer={<>
              {missing.length > 0 && (
                <div className="closeout-missing">ยังขาด {missing.length} รายการ: {missing.join(' · ')}</div>
              )}
              <button onClick={() => setCloseFor(null)} disabled={closing}>ยกเลิก</button>
              <button className="success" onClick={submitClose}
                disabled={closing || missing.length > 0}
                title={missing.length ? `ยังขาด: ${missing.join(' · ')}` : ''}>
                {closing ? 'กำลังอัปโหลดเอกสารและปิดงาน...' : 'ยืนยันปิดงาน'}
              </button>
            </>}>
            <p style={{ marginBottom: 12 }}>
              ติดตั้งสำเร็จ <b>{s.installed}/{s.total}</b> เครื่อง
              {s.blocked > 0 && <span style={{ color: 'var(--danger)' }}> · ติดตั้งไม่ได้ {s.blocked} เครื่อง</span>}
              <br />
              หลังปิดงาน Job จะเป็นสถานะ <b>Installed</b> (terminal) และแจ้ง Project อัตโนมัติ
            </p>
            {/* เฟส 5: ตัดคำเตือน "ติดตั้งไม่ได้/วัสดุค้าง — ปิดงานได้" ออก — ขัดกติกา 0094 (ทั้งสองข้อเป็นเรื่องค้างก่อนปิด) */}
            {/* ①② เอกสารรับมอบ + Warranty (0079) — บังคับทั้งหมด */}
            {closeDraft && (
              <CloseoutForm db={db} job={closeJob} draft={closeDraft} onChange={setCloseDraft}
                onError={m => show(m, true)} disabled={closing} />
            )}

            {/* ③ บังคับสรุปปัญหาก่อนปิดงาน (0040) */}
            <h4 style={{ margin: '14px 0 8px', fontSize: 14 }}>③ สรุปงาน</h4>
            <div className="field">
              <span>งานนี้มีปัญหาหรือไม่ ? *</span>
              <div style={{ display: 'flex', gap: 18, alignItems: 'center', paddingTop: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="radio" name="hasIssues" checked={hasIssues === false}
                    onChange={() => { setHasIssues(false); setIssueDetail(''); setIssueFile(null) }} />
                  <span>ไม่มีปัญหา</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="radio" name="hasIssues" checked={hasIssues === true}
                    onChange={() => setHasIssues(true)} />
                  <span style={{ color: 'var(--danger)' }}>มีปัญหา</span>
                </label>
              </div>
            </div>
            {hasIssues === null && (
              <div className="muted" style={{ color: 'var(--danger)', marginBottom: 10 }}>
                ต้องเลือกก่อนจึงจะปิดงานได้
              </div>
            )}

            {hasIssues === true && (
              <>
                <label className="field"><span>รายละเอียดปัญหา *</span>
                  <textarea rows={3} value={issueDetail} onChange={e => setIssueDetail(e.target.value)}
                    placeholder="เช่น จุดติดตั้งที่ 2 พื้นที่คับแคบต้องใช้เครนเพิ่ม · ลูกค้าขอเปลี่ยนตำแหน่งหน้างาน" />
                </label>
                <label className="field"><span>แนบไฟล์ประกอบ (รูป / PDF / เอกสาร — ถ้ามี)</span>
                  <input type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
                    onChange={async e => {
                      const f = e.target.files?.[0]
                      if (!f) { setIssueFile(null); return }
                      if (f.size > 10 * 1024 * 1024) { show('ไฟล์ใหญ่เกิน 10 MB', true); e.target.value = ''; return }
                      setIssueFile({ file: f, dataUrl: await readAsDataUrl(f), isImage: f.type.startsWith('image/') })
                    }} />
                </label>
                {issueFile && (
                  <div className="muted" style={{ marginBottom: 10 }}>
                    📎 {issueFile.file.name} ({Math.round(issueFile.file.size / 1024)} KB)
                    {issueFile.isImage && (
                      <img src={issueFile.dataUrl} alt="preview"
                        style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 8, marginTop: 8, display: 'block' }} />
                    )}
                  </div>
                )}
              </>
            )}

            <label className="field"><span>บันทึกสรุปงาน (ถ้ามี)</span>
              <textarea rows={2} value={closeNote} onChange={e => setCloseNote(e.target.value)}
                placeholder="เช่น ส่งมอบลูกค้าเรียบร้อย รอเอกสารรับรอง" />
            </label>
          </Modal>
        )
      })()}

      {visitJob && (
        <Modal title={`ออกหน้างานยังไม่จบ — ${visitJob.jobNo}`} onClose={() => setVisitFor(null)}
          footer={<>
            <button onClick={() => setVisitFor(null)}>ยกเลิก</button>
            <button className="success"
              disabled={!visitReason.trim() || (visitOutcome === 'rescheduled' && !visitStart)}
              onClick={submitVisit}>บันทึก + แจ้ง Project</button>
          </>}>
          <p className="muted" style={{ marginBottom: 12 }}>
            {visitJob.customerName} · {visitJob.issueLocation || visitJob.installLocation || '-'} — งานยังคงสถานะ <b>Issued</b> (ไม่ปิดงาน)
          </p>
          <label className="field"><span>ผลการออกหน้างาน *</span>
            <select value={visitOutcome} onChange={e => setVisitOutcome(e.target.value as 'rescheduled' | 'failed')}>
              <option value="rescheduled">⏰ เลื่อนนัดติดตั้ง (มีวันนัดใหม่)</option>
              <option value="failed">⚠️ ติดปัญหาหน้างาน (ยังไม่มีนัดใหม่)</option>
            </select>
          </label>
          {visitOutcome === 'rescheduled' && (
            <>
              <div className="row">
                <label className="field"><span>วันนัดใหม่ (เริ่ม) *</span>
                  <input type="date" value={visitStart} onChange={e => setVisitStart(e.target.value)} />
                </label>
                <label className="field"><span>ถึง (เว้นว่าง = วันเดียว)</span>
                  <input type="date" value={visitEnd} onChange={e => setVisitEnd(e.target.value)} />
                </label>
              </div>
              {/* 0075 — เลื่อนนัดทีมช่าง ≠ เลื่อนกำหนดส่งตามสัญญา · แยกกันโดยตั้งใจ
                  ทีมช่างเลื่อนคิวเองได้ แต่การเลื่อนวันส่งมอบเป็นเรื่องที่ต้องตกลงกับลูกค้า
                  ⇒ เตือนเฉพาะตอนที่นัดใหม่เลยกำหนดส่งจริง ให้ Project ไปบันทึกที่หน้า Job */}
              {(() => {
                const d = jobDelivery(db, visitJob)
                const pastDue = !!visitStart && !!d.due && visitStart > d.due
                return pastDue && (
                  <div className="muted" style={{ color: 'var(--danger)', marginBottom: 10 }}>
                    ⚠️ วันนัดใหม่เลยกำหนดส่ง ({fmtDate(d.due)}) — การเลื่อนนัดนี้<b>ไม่ได้</b>เลื่อนกำหนดส่งตามสัญญา
                    ถ้าตกลงเลื่อนวันส่งมอบกับลูกค้าแล้ว ให้ Project บันทึก "ขยายกำหนดส่ง" ที่หน้า{' '}
                    <Link to={`/jobs/${visitJob.id}`}>{visitJob.jobNo}</Link> ด้วย
                  </div>
                )
              })()}
            </>
          )}
          <label className="field"><span>เหตุผล / รายละเอียดหน้างาน *</span>
            <textarea rows={3} value={visitReason} onChange={e => setVisitReason(e.target.value)}
              placeholder={visitOutcome === 'rescheduled' ? 'เช่น ลูกค้าขอเลื่อน ยังไม่พร้อมหน้างาน' : 'เช่น จุดติดตั้งยังไม่เดินสายเมน รอผู้รับเหมา'} />
          </label>
        </Modal>
      )}
    </>
  )
}
