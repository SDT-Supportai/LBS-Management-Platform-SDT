// =============================================================================
// Service Letter — ยกจาก ServiceMS (Instance 1) · เตรียมรวมเข้า LBS (2026-11-25)
//   ผูกระบบแล้ว 2026-11-25: DB (types.ts) · action demo (logic.ts) · LIVE (remote.ts + migration 0100) · หน้า /letters
//   ต้นฉบับ: D:\Claude Code.md\15. ...\docs\templates\service-letter (frontend/backend/database)
//
//   ต่างจาก ServiceMS โดยตั้งใจ:
//   • เลขที่ออกใน RPC ฝั่ง DB (advisory lock + UNIQUE) — demo ใช้ nextLetterNo ตัวเดียวกัน
//   • รับเฉพาะคอลัมน์ที่อนุญาต (ServiceMS เดิม spread ทั้งก้อน ⇒ created_by ปลอมได้ + stored XSS ผ่านลายเซ็น)
//   • created_by = ผู้ใช้ที่ล็อกอินจริง · ไฟล์แนบเป็นตารางแยก (ไม่ใช่สตริง "name::url||…")
//
//   คำตอบผู้ใช้ 2026-11-25 (ดู docs/service-letter-integration.md):
//   1) ออกจดหมาย = Service + Project + Manage · ลบ = Manage
//   2) เลข PSP-LBS-YYYY-NNN แยกจาก ServiceMS
//   3) หัวกระดาษตามแม่แบบ + โลโก้ LBS เดิม (letterPdf.ts lbsLetterOrg)
//   4) ผู้ลงนามเลือกจาก dropdown รายชื่อที่ Manage ตั้ง · เซ็นอิเล็กทรอนิกส์ หรือเว้นที่เซ็นมือ (ไม่มีลายเซ็นเก็บไว้)
//   5) แจ้งกระดิ่งในเว็บ (ไม่ส่ง LINE) — อ้าง Job = แจ้ง Project ของงานนั้น
//   6) ปุ่ม "ออก Warranty Letter" ในหน้า Warranty เติมข้อมูลประกันให้ (warrantyLetterPrefill)
//   เทสต์: letters.test.ts
// =============================================================================
import type { User, Job, JobWarranty } from '../types'
import { can } from './permissions'

export type LetterCategory = 'GENERAL' | 'SM' | 'WARRANTY'
export type LetterType = 'EXTERNAL' | 'INTERNAL'
export type LetterStatus = 'ISSUED' | 'DRAFT'

export interface ServiceLetter {
  id: string
  letterNo: string
  letterDate: string             // YYYY-MM-DD
  category: LetterCategory       // GENERAL = Official Letter · SM = Service Official Letter · WARRANTY
  letterType: LetterType         // หนังสือภายนอก / ภายใน (GENERAL)
  status: LetterStatus
  recipient: string              // GENERAL = "เรียน" · SM/WARRANTY = ผู้รับ + ที่อยู่หลายบรรทัด
  recipientOrg?: string
  subject: string
  reference?: string             // อ้างถึง
  enclosure?: string             // สิ่งที่ส่งมาด้วย
  body: string
  body2?: string                 // ย่อหน้า 2 (SM/WARRANTY)
  attention?: string             // บรรทัด "เรียน" (SM/WARRANTY)
  site?: string                  // สถานที่ ใต้เรื่อง (SM/WARRANTY)
  techList?: string              // "ชื่อ | เบอร์" บรรทัดละคน (SM)
  jobId?: string                 // อ้างอิง Job ของ LBS (ServiceMS: ref_job เป็นข้อความ)
  cc?: string
  signerId?: string              // ผู้ลงนามจากรายชื่อที่ Manage ตั้ง
  signerName?: string            // snapshot ณ วันออก (แก้รายชื่อทีหลังไม่กระทบจดหมายเก่า)
  signerPosition?: string
  sigImage?: string              // ลายเซ็นอิเล็กทรอนิกส์ (data URL) · ว่าง = เว้นที่เซ็นมือ
  warrantyType?: string
  warrantyStart?: string
  warrantyEnd?: string
  warrantyDetail?: string
  createdBy: string              // user id
  createdAt: string              // ISO timestamp
}

/** ผู้ลงนาม — Manage ตั้งรายชื่อ · ปิดใช้งานแทนการลบ (จดหมายเก่ายังอ้างถึง) */
export interface LetterSigner {
  id: string
  fullName: string
  position: string
  sortOrder: number
  isActive: boolean
}

/** ไฟล์แนบ — ตารางแยก (กติกาเดียวกับ job_closeout_files: private bucket เก็บ path ขอ signed URL ตอนเปิด) */
export interface ServiceLetterFile {
  id: string
  letterId: string
  filePath: string
  fileName: string
  mimeType: string
  sizeBytes: number
  uploadedBy: string
  uploadedAt: string
}

// คำตอบผู้ใช้ข้อ 2 (2026-11-25): เลขชุดของ LBS แยกจาก ServiceMS ("PSP Service-…")
export const LETTER_PREFIX = 'PSP-LBS'
export const LETTER_FILES_BUCKET = 'letter-docs'
export const LETTER_FILE_MAX_BYTES = 10 * 1024 * 1024

/** เลขถัดไปของปี — รันร่วมทุกประเภท · นับเฉพาะเลขของ LBS (prefix นี้) ไม่นับเลข ServiceMS */
export function nextLetterNo(existing: string[], todayIso: string): string {
  const yr = todayIso.slice(0, 4)
  let max = 0
  for (const no of existing) {
    if (!no.startsWith(`${LETTER_PREFIX}-${yr}-`)) continue
    const m = no.match(/(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `${LETTER_PREFIX}-${yr}-${String(max + 1).padStart(3, '0')}`
}

// ลายเซ็นถูกวางใน <img src="..."> ของเอกสารพิมพ์ — แท็บพิมพ์เป็น origin เดียวกับแอป
// ⇒ รับเฉพาะ data URL รูป PNG/JPEG base64 ล้วน (ไม่มีช่องให้ " onerror=... หลุด)
const SIG_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/
const SIG_MAX = 400_000
export function safeSigImage(s: unknown): string {
  const v = typeof s === 'string' ? s : ''
  return v.length <= SIG_MAX && SIG_RE.test(v) ? v : ''
}

/** ข้อมูลที่ฟอร์มส่งมา — ไม่มี id / letterNo / createdBy / createdAt / ชื่อผู้ลงนาม (ระบบกำหนดเองจาก signerId) */
export type LetterInput = Partial<Omit<ServiceLetter, 'id' | 'letterNo' | 'createdBy' | 'createdAt' | 'signerName' | 'signerPosition'>>

const TEXT_FIELDS = [
  'letterDate', 'recipient', 'recipientOrg', 'subject', 'reference', 'enclosure', 'body', 'body2', 'attention',
  'site', 'techList', 'jobId', 'cc', 'signerId',
  'warrantyType', 'warrantyStart', 'warrantyEnd', 'warrantyDetail',
] as const
const ONE_OF = {
  category: ['GENERAL', 'SM', 'WARRANTY'],
  letterType: ['EXTERNAL', 'INTERNAL'],
  status: ['ISSUED', 'DRAFT'],
} as const
const TEXT_MAX = 20_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** YYYY-MM-DD ที่เป็นวันจริงในปฏิทิน (กัน 2026-02-30 / 2026-13-45) */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export type CleanLetter =Omit<ServiceLetter, 'id' | 'letterNo' | 'createdBy' | 'createdAt' | 'letterDate'> & { letterDate?: string }

/** รับเฉพาะคอลัมน์ที่อนุญาต + ตรวจค่า — คืน error ภาษาไทยแทนการ throw (ให้ฟอร์มแสดงได้) */
export function cleanLetterInput(input: LetterInput): { ok: true; value: CleanLetter } | { ok: false; error: string } {
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of TEXT_FIELDS) {
    const v = src[k]
    if (v == null) continue
    const t = String(v).slice(0, TEXT_MAX).trim()   // ข้อความหลายบรรทัดคงรูป · ตัดช่องว่างหัวท้ายเท่านั้น
    if (t) out[k] = t
  }
  for (const [k, allowed] of Object.entries(ONE_OF) as [keyof typeof ONE_OF, readonly string[]][]) {
    const v = src[k] == null || src[k] === '' ? allowed[0] : String(src[k])
    if (!allowed.includes(v)) return { ok: false, error: `ค่า ${k} ไม่ถูกต้อง` }
    out[k] = v
  }
  if (src.sigImage) {
    const sig = safeSigImage(src.sigImage)
    if (!sig) return { ok: false, error: 'ลายเซ็นไม่ถูกต้อง (ต้องเป็นรูป PNG/JPEG ไม่เกิน 300 KB) — กรุณาวาดใหม่' }
    out.sigImage = sig
  }
  // [debug 2026-11-25] วันที่ต้องเป็น YYYY-MM-DD ที่มีจริง — เดิมรับอะไรก็ได้ ⇒ RPC ::date error อังกฤษ
  //   หรือ "01/02/2026" ถูกอ่านแบบ MDY เป็น 2 ม.ค. เงียบ ๆ (ข้อมูลผิดโดยไม่มีใครรู้)
  for (const k of ['letterDate', 'warrantyStart', 'warrantyEnd'] as const) {
    if (out[k] && !isIsoDate(String(out[k])))
      return { ok: false, error: `รูปแบบวันที่ไม่ถูกต้อง (${k}: ${String(out[k]).slice(0, 20)}) — ต้องเป็นวันที่จริงแบบ YYYY-MM-DD` }
  }
  if (out.jobId && !UUID_RE.test(String(out.jobId))) return { ok: false, error: 'ไม่พบ Job ที่อ้างถึง (รหัสไม่ถูกต้อง)' }
  if (!out.recipient || !out.subject || !out.body) return { ok: false, error: 'กรุณากรอก ผู้รับ / เรื่อง / เนื้อความ ให้ครบ' }
  if (!out.signerId) return { ok: false, error: 'กรุณาเลือกผู้ลงนาม' }
  if (out.warrantyStart && out.warrantyEnd && String(out.warrantyStart) > String(out.warrantyEnd))
    return { ok: false, error: 'วันเริ่มรับประกันต้องไม่หลังวันสิ้นสุด' }
  return { ok: true, value: out as unknown as CleanLetter }
}

/** "ชื่อ | เบอร์" บรรทัดละคน · มี | = ตัดที่ | ตัวแรกเท่านั้น · ไม่มี | ค่อยใช้ tab หรือ comma (รูปแบบเก่าของ ServiceMS)
 *  [debug 2026-11-25] เดิมตัดที่ | , tab พร้อมกัน ⇒ "บจก. ก, สาขา 2 | 081" ได้เบอร์ "สาขา 2" และ 081 หาย */
export function parseTechList(text?: string): { name: string; phone: string }[] {
  return String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const sep = l.includes('|') ? /\s*\|\s*/ : /\s*[\t,]\s*/
    const i = l.search(sep)
    if (i < 0) return { name: l, phone: '' }
    const m = l.slice(i).match(sep)!
    return { name: l.slice(0, i), phone: l.slice(i + m[0].length) }
  })
}

// สิทธิ์ — อยู่ใน permissions.ts ('letter.manage' / 'letter.delete' / 'letter.signers') ที่เดียว · ที่นี่เป็นทางลัด
//   คำตอบผู้ใช้ข้อ 1: ออก = Service + Project + Manage · ข้อ 4: รายชื่อผู้ลงนาม = Manage
export function canLetter(user: User | null, perm: 'manage' | 'delete' | 'signers'): boolean {
  return can(user, `letter.${perm}`)
}

/** ชนิดไฟล์แนบที่รับ — ตรงกับ CHECK service_letter_files_type_ck (0100): PDF / Word / Excel / รูป (ไม่รับ SVG) */
const LETTER_FILE_MIMES = [
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]
export function isAllowedLetterFile(mime: string): boolean {
  return LETTER_FILE_MIMES.includes(mime) || (/^image\//.test(mime) && mime !== 'image/svg+xml')
}

/** ตัวเลือกใน dropdown ผู้ลงนาม — เฉพาะที่ใช้งาน เรียงตาม sortOrder */
export function activeSigners(signers: LetterSigner[]): LetterSigner[] {
  return signers.filter(s => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.fullName.localeCompare(b.fullName))
}

/** โหมดเดโม — เพิ่ม/แก้ผู้ลงนาม (sync กับ rpc_upsert_letter_signer) · ปิดใช้งานแทนการลบ */
export function upsertSignerDemo(signers: LetterSigner[], actor: User,
  p: { id?: string; fullName: string; position: string; sortOrder?: number; isActive?: boolean }): LetterSigner[] {
  if (!canLetter(actor, 'signers')) throw new Error('แผนกของคุณไม่มีสิทธิ์ตั้งรายชื่อผู้ลงนาม (เฉพาะ Manage)')
  const fullName = p.fullName.trim()
  if (!fullName) throw new Error('กรุณาระบุชื่อผู้ลงนาม')
  const row = { fullName, position: p.position.trim(), isActive: p.isActive ?? true }
  if (p.id) {
    if (!signers.some(s => s.id === p.id)) throw new Error('ไม่พบผู้ลงนามนี้')
    return signers.map(s => s.id === p.id ? { ...s, ...row, sortOrder: p.sortOrder ?? s.sortOrder } : s)
  }
  const sortOrder = p.sortOrder ?? (signers.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1)
  return [...signers, { id: crypto.randomUUID(), sortOrder, ...row }]
}

/** วันที่ตามเวลาไทยของ timestamp (ปีของเลขที่ต้องเป็นปีไทย ไม่ใช่ UTC) */
const bkkDate = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(0, 10)

/** การแจ้งเตือนที่ชั้นผูกระบบต้องเพิ่มลง notifications (กระดิ่ง · ไม่ส่ง LINE — คำตอบผู้ใช้ข้อ 5) */
export interface LetterNotify { type: 'letter_issued'; dept: 'project'; jobId: string; message: string }

/** โหมดเดโม — ออกจดหมาย (sync กับ rpc_create_service_letter ใน drafts/0100) */
export function createLetterDemo(letters: ServiceLetter[], actor: User, input: LetterInput, nowIso: string, signers: LetterSigner[],
  /** เลขที่เคยออกแล้ว (รวมฉบับที่ถูกลบ) — เลขไม่ถูกนำกลับมาใช้ · sync letter_no_counters (0100) */
  issuedNos: string[] = [])
  : { letters: ServiceLetter[]; letter: ServiceLetter; notify?: LetterNotify } {
  if (!canLetter(actor, 'manage')) throw new Error('แผนกของคุณไม่มีสิทธิ์ออกจดหมาย')
  const r = cleanLetterInput(input)
  if (!r.ok) throw new Error(r.error)
  const signer = signers.find(s => s.id === r.value.signerId && s.isActive)
  if (!signer) throw new Error('ไม่พบผู้ลงนามในรายชื่อที่ใช้งาน — กรุณาเลือกใหม่')
  const today = bkkDate(nowIso)
  const letter: ServiceLetter = {
    ...r.value,
    letterDate: r.value.letterDate || today,
    signerName: signer.fullName,
    signerPosition: signer.position,
    id: crypto.randomUUID(),
    letterNo: nextLetterNo([...letters.map(l => l.letterNo), ...issuedNos], today),
    createdBy: actor.id,
    createdAt: nowIso,
  }
  const notify: LetterNotify | undefined = letter.jobId
    ? { type: 'letter_issued', dept: 'project', jobId: letter.jobId, message: `✉️ ออกจดหมาย ${letter.letterNo} — ${letter.subject}` }
    : undefined
  return { letters: [letter, ...letters], letter, notify }
}

/** โหมดเดโม — ลบจดหมาย (Manage) · ไฟล์แนบต้องลบตามที่ชั้นผูกระบบ */
export function deleteLetterDemo(letters: ServiceLetter[], actor: User, id: string): ServiceLetter[] {
  if (!canLetter(actor, 'delete')) throw new Error('แผนกของคุณไม่มีสิทธิ์ลบจดหมาย (เฉพาะ Manage)')
  if (!letters.some(l => l.id === id)) throw new Error('ไม่พบจดหมายนี้')
  return letters.filter(l => l.id !== id)
}

const dmyDash = (s?: string) => { const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : '-' }

/**
 * ปุ่ม "ออก Warranty Letter" ในหน้า Warranty (คำตอบผู้ใช้ข้อ 6) — เติมฟอร์มจากข้อมูลที่ระบบมีอยู่แล้ว
 *   ช่วงประกันหลัก = ประกันงานติดตั้ง · ไม่มี = ช่วงกว้างสุดของประกันตัวเครื่อง
 *   ประกันตัวเครื่องจัดกลุ่มตามช่วงวันที่ (เครื่องที่ช่วงเดียวกันรวมบรรทัดเดียว)
 *   ผู้ใช้แก้ทุกช่องได้ก่อนบันทึก (ผู้ลงนาม/เรียน ยังต้องเลือก/กรอกเอง)
 */
export function warrantyLetterPrefill(job: Job, warranties: JobWarranty[]): LetterInput {
  const ws = warranties.filter(w => w.jobId === job.id)
  const inst = ws.find(w => w.kind === 'installation')
  const lbs = ws.filter(w => w.kind === 'lbs')
  const groups = new Map<string, number>()
  for (const w of lbs) { const k = `${w.startDate}|${w.endDate}`; groups.set(k, (groups.get(k) ?? 0) + 1) }
  const lines: string[] = []
  if (inst) lines.push(`ประกันงานติดตั้ง: ${dmyDash(inst.startDate)} ถึง ${dmyDash(inst.endDate)}`)
  for (const [k, n] of groups) { const [s, e] = k.split('|'); lines.push(`ประกันตัวเครื่อง LBS ${n} เครื่อง: ${dmyDash(s)} ถึง ${dmyDash(e)}`) }
  const start = inst?.startDate ?? lbs.map(w => w.startDate).sort()[0]
  const end = inst?.endDate ?? lbs.map(w => w.endDate).sort().slice(-1)[0]
  const site = job.issueLocation || job.installLocation
  return {
    category: 'WARRANTY',
    jobId: job.id,
    recipient: job.customerName,
    site: site || undefined,
    subject: `แจ้งระยะเวลารับประกัน ${job.jobNo}`,
    reference: job.acceptanceType
      ? `${job.acceptanceType}${job.acceptanceDocNo ? ` เลขที่ ${job.acceptanceDocNo}` : ''}${job.acceptanceDate ? ` ลงวันที่ ${dmyDash(job.acceptanceDate)}` : ''}`
      : undefined,
    body: `ตามที่บริษัทฯ ได้ดำเนินการติดตั้ง Load Break Switch ตามงาน ${job.jobNo} แล้วเสร็จ บริษัทฯ ขอแจ้งระยะเวลาการรับประกันตามรายละเอียดด้านล่าง`,
    warrantyType: [inst && 'งานติดตั้ง', lbs.length > 0 && 'ตัวเครื่อง LBS'].filter(Boolean).join(' + ') || undefined,
    warrantyStart: start,
    warrantyEnd: end,
    warrantyDetail: lines.join('\n') || undefined,
  }
}
