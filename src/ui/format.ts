import type { JobStatus, Department, AccReqStatus } from '../types'

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  draft: 'Draft',
  allocated: 'Allocated',
  procuring_accessory: 'Procuring Accessory',
  ready_to_issue: 'Ready to Issue',
  issued: 'Issued (รอติดตั้ง)',
  installed: 'Installed',
  cancelled: 'Cancelled',
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
}

export const APPROVAL_TYPE_LABEL: Record<string, string> = {
  create_pr: 'ออก PR',
  issue_job: 'เบิกให้ Service',
  cancel_job: 'ยกเลิก Job',
}

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว',
  rejected: 'ตีกลับ',
}

export const ACC_STATUS_LABEL: Record<AccReqStatus, string> = {
  pending: 'รอออก PR',
  issued: 'เบิกจากคลังสินค้าแล้ว',
  pr_sent: 'ส่ง PR แล้ว',
  po_ordered: 'ออก PO แล้ว',
  received: 'รับของแล้ว',
  returned: 'คืนสต็อกแล้ว',
  cancelled: 'ยกเลิก',
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
