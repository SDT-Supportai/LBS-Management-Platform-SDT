import type { JobStatus, Department, AccReqStatus, AccessoryRequest, CostCategoryKey, EpicorTxnType } from '../types'
import { EPICOR_TXN_LABEL } from '../data/logic'

// 7 หมวดต้นทุน Project Budget (0021) — เรียงตามลำดับที่แสดง
// fromPR = true → actual มาจากมูลค่าวัสดุ PR/PO ที่ตัดเข้าหมวดนี้ (เลือกตอนเพิ่มวัสดุ)
// fromPR = false → กรอก actual เอง
export const COST_CATEGORIES: { key: CostCategoryKey; label: string; fromPR: boolean }[] = [
  { key: 'raw_mat', label: 'Raw Material', fromPR: true },
  { key: 'outsourcing', label: 'Outsourcing', fromPR: true },
  { key: 'trans', label: 'Transportation', fromPR: false },
  { key: 'eng', label: 'Engineering', fromPR: false },
  { key: 'ove', label: 'Overhead', fromPR: false },
  { key: 'pm', label: 'Project Management', fromPR: false },
  { key: 'fin', label: 'Finance', fromPR: false },
]

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  draft: 'Draft',
  allocated: 'Allocated',
  procuring_accessory: 'Procuring Accessory',
  ready_to_issue: 'Ready to Issue',
  // 0059: เบิกออกไปแล้วบางส่วน (LBS หรือวัสดุบาง PO) แต่ยังไม่ครบทั้งใบ
  partially_issued: 'Partially Issued (เบิกบางส่วน)',
  issued: 'Issued (รอติดตั้ง)',
  installed: 'Installed',
  cancelled: 'Cancelled',
}

// Status รายเครื่องใน Project Stock (0052) — flow เดียวจบ derive อัตโนมัติทั้งหมด
//   ? → Pending → On Hand → ถูกดึงเข้า Job → เบิกแล้ว รอติดตั้ง → ติดตั้งแล้ว / ติดตั้งไม่ได้
// label = ที่แสดงบนจอ/ไฟล์ Excel · cls = สีป้าย · hint = tooltip อธิบายว่าทำไมได้สถานะนี้
export const UNIT_FLOW: Record<string, { label: string; cls: string; hint: string }> = {
  unknown:   { label: '?',                cls: 'neutral', hint: 'ยังไม่ระบุ ETA to WH — กรอก FOB date (หรือ ETA) ก่อน ระบบถึงจะบอกได้ว่าของถึงคลังหรือยัง' },
  pending:   { label: 'Pending',          cls: 'amber',   hint: 'ยังไม่ถึง ETA to WH — ของอยู่ระหว่างขนส่ง' },
  on_hand:   { label: 'On Hand',          cls: 'green',   hint: 'ถึง/เกิน ETA to WH แล้ว — ของอยู่ที่คลัง พร้อมดึงเข้า Job' },
  allocated: { label: 'ถูกดึงเข้า Job',      cls: 'blue',    hint: 'ถูกดึงเข้า Job แล้ว — รอเบิกให้ Service' },
  issued:    { label: 'เบิกแล้ว รอติดตั้ง',   cls: 'neutral', hint: 'เบิกให้ Service แล้ว — รอยืนยันติดตั้งหน้างาน' },
  installed: { label: 'ติดตั้งแล้ว',         cls: 'green',   hint: 'Service ยืนยันติดตั้งเสร็จแล้ว' },
  blocked:   { label: 'ติดตั้งไม่ได้',        cls: 'red',     hint: 'ออกหน้างานแล้วติดตั้งไม่ได้ — ดูเหตุผลที่หน้า Service' },
}

export const PR_STATUS_LABEL: Record<string, string> = {
  pending: 'รอ Purchasing ออก PO',
  po_issued: 'ออก PO แล้ว รอรับของ',
  received: 'รับของครบ',
  rejected: 'ถูกตีกลับ',
  cancelled: 'ยกเลิก',
}

// ค่าใน DB ยังเป็น 'sales'/'admin' — เปลี่ยนเฉพาะชื่อที่แสดง (มติ 2026-07-19)
export const DEPT_LABEL: Record<Department, string> = {
  sales: 'Division',      // ผู้อนุมัติ: ออก PR / เบิก / ยกเลิก Job ของ project
  project: 'Project',
  purchasing: 'Purchasing',
  service: 'Service',
  admin: 'Manage',        // ทำได้ทุกอย่าง + ข้ามขั้นอนุมัติ
  vip: 'VIP',             // ผู้บริหารสูงสุด (0050) — ดูได้ทุกหน้า · ให้ความเห็นบนคำขออนุมัติ · ไม่แก้ข้อมูล
}

export const APPROVAL_TYPE_LABEL: Record<string, string> = {
  create_pr: 'ออก PR',
  // 0059: คำขอนี้ครอบเฉพาะ LBS แล้ว — Accessory ตาม PO ที่รับของครบ Project เบิกเองได้
  issue_job: 'เบิก LBS ให้ Service',
  cancel_job: 'ยกเลิก Job',
  swap_lbs: 'สลับ LBS',
  reopen_job: 'เปิดงานใหม่',
}

// งวดเงินต่อ Job (0044) — ชื่อตามที่ใช้ในสัญญางานติดตั้ง
export const PAYMENT_TYPE_LABEL: Record<string, string> = {
  advance: 'Advance',
  progress: 'Progress / Delivery',
  retention: 'PAC / Retention',
}

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ตีกลับ',
}

// ⚠️ ป้ายทุกตัวต้อง "อ่านจบในตัวเอง" ว่าของอยู่ขั้นไหนและรออะไรอยู่ (มติ 2026-08-27)
//    เพราะคอลัมน์ "เบิกให้ Service" ที่เคยมาขยายความถูกยุบรวมเข้ามาที่คอลัมน์นี้แล้ว
//    2 ขั้นที่เป็น "ของอยู่กับ Job พร้อมส่งออกหน้างาน" ตั้งชื่อคู่ขนานกันตั้งใจ
//    (เบิกคลัง รอนำใช้ / รับของแล้ว รอนำใช้) — คนกวาดตาเห็น "รอนำใช้" ก็รู้ทันทีว่าเบิกได้
/**
 * ประเภท transaction ที่ใช้ตัดยอดใน Epicor (0065) — เลือกตอนกด Done ที่คอลัมน์ "ทำเบิก-Epicor"
 * แยก 2 ทางเพราะกระทบยอดคนละฝั่ง: Cust-Ship ไปฝั่งรายได้ (มี Invoice) · Issue-Mis ไปฝั่งต้นทุน
 * ⚠️ ป้ายต้องตรงกับชื่อ transaction ใน Epicor เป๊ะ ๆ — คนกระทบยอดค้นด้วยคำนี้
 */
export const EPICOR_TXN: Record<EpicorTxnType, { label: string; desc: string; cls: string }> = {
  cust_ship: { label: EPICOR_TXN_LABEL.cust_ship, desc: 'Item ที่ออก Invoice', cls: 'blue' },
  issue_mis: { label: EPICOR_TXN_LABEL.issue_mis, desc: 'Item ที่เบิกออก', cls: 'amber' },
}
export const ACC_STATUS_LABEL: Record<AccReqStatus, string> = {
  pending: 'รอออก PR',
  issued: 'เบิกคลัง รอนำใช้',          // มาจากคลังคงเหลือ · ของอยู่กับ Job แล้ว
  pr_sent: 'ส่ง PR แล้ว รอออก PO',
  po_ordered: 'ออก PO แล้ว รอรับของ',
  received: 'รับของแล้ว รอนำใช้',      // มาจากการสั่งซื้อ · ของอยู่กับ Job แล้ว
  returned: 'คืนสต็อกแล้ว',
  cancelled: 'ยกเลิก',
}

/**
 * ป้ายในคอลัมน์ "สถานะ" ของตารางวัสดุ — ตอบคำถาม **"ของชิ้นนี้อยู่ที่ไหนตอนนี้"**
 * ไม่ใช่ "ของมาจากไหน" (มติ 2026-08-27 · แบบ B)
 *
 * ⚠️ AccReqStatus **ไม่ขยับ**ตอนเบิกให้ Service — 0059 ใช้ฟิลด์ issuedToServiceAt แยกอีกตัว
 *    ถ้าอ่าน status ตรง ๆ คอลัมน์นี้จะค้างที่ "เบิกคลัง รอนำใช้" / "รับของแล้ว"
 *    ทั้งที่ของออกไปหน้างานแล้ว ⇒ ขัดกับคอลัมน์ "เบิกให้ Service" ที่อยู่ถัดไปในตารางเดียวกัน
 *    คนอ่านตารางเร็ว ๆ ดูคอลัมน์สถานะก่อน จะเข้าใจผิดว่าของยังอยู่ในมือ Project
 *
 * ใช้กับทั้งของจากคลังคงเหลือและของที่ซื้อผ่าน PO — ความขัดแย้งเดียวกันเกิดกับทั้งสองทาง
 * ยกเว้นรายการที่ยกเลิก/คืนคลังไปแล้ว ซึ่ง status เป็นคำตอบสุดท้ายอยู่แล้ว
 */
export function accStatusLabel(r: Pick<AccessoryRequest, 'status' | 'issuedToServiceAt'>): string {
  if (r.issuedToServiceAt && r.status !== 'cancelled' && r.status !== 'returned')
    return 'เบิกให้ Service แล้ว'
  return ACC_STATUS_LABEL[r.status]
}

/**
 * ขั้นเหล่านี้ "ป้ายบอกเหตุผลอยู่ในตัวแล้ว" — ไม่ต้องเอา accIssueBlockReason มาย้ำใต้ป้ายอีก
 * (เช่น status = po_ordered ป้ายเขียนว่า "ออก PO แล้ว รอรับของ" ซึ่งตรงกับเหตุผลที่เบิกไม่ได้เป๊ะ)
 * เหลือไว้เฉพาะเหตุผลที่ **อ่านจากป้ายไม่ออก** เช่น บรรทัดนี้รับของครบแล้วแต่ PO ทั้งใบยังไม่ครบ
 */
const BLOCK_IMPLIED_BY_STATUS = new Set<AccReqStatus>(['pending', 'pr_sent', 'po_ordered'])

export function accBlockNeedsDetail(r: Pick<AccessoryRequest, 'status'>): boolean {
  return !BLOCK_IMPLIED_BY_STATUS.has(r.status)
}

/** สีป้ายให้ตรงกับความหมาย: เขียว = ของพร้อมใช้อยู่กับ Job · ฟ้า = ออกไปหน้างานแล้ว */
export function accStatusBadge(r: Pick<AccessoryRequest, 'status' | 'issuedToServiceAt'>): string {
  if (r.status === 'cancelled' || r.status === 'returned') return 'neutral'
  if (r.issuedToServiceAt) return 'blue'
  return r.status === 'issued' || r.status === 'received' ? 'green' : 'amber'
}

// จำนวนเงิน (บาท) — คืน '-' ถ้าไม่ได้ระบุ
export function fmtBaht(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-'
  return n.toLocaleString('th-TH', { maximumFractionDigits: 2 }) + ' ฿'
}

export function fmtDate(s?: string): string {
  if (!s) return '-'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function fmtDateTime(s?: string): string {
  if (!s) return '-'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('th-TH', { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
