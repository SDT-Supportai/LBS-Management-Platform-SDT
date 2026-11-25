// =============================================================================
// เฟส 6 (2026-11-24) — Users & Settings: ตรรกะล้วน (เทสต์ที่ admin.test.ts)
// =============================================================================
import type { DB, Department, Job, ApprovalRequest, TeamMember } from '../types'
import { PERMISSIONS } from './permissions'

type PermKey = keyof typeof PERMISSIONS

/**
 * คำอธิบายสิทธิ์แต่ละข้อ — ป้ายใต้ช่อง "แผนก" ในฟอร์มผู้ใช้สร้างจาก PERMISSIONS จริง
 * (เดิมเขียนคำอธิบายมือต่อแผนก ⇒ เพิ่มสิทธิ์ใหม่แล้วป้ายไม่ตาม) · เทสต์บังคับว่าทุกสิทธิ์ต้องมีคำอธิบาย
 */
export const PERM_LABEL: Record<PermKey, string> = {
  'stock.manage': 'คลัง LBS (สร้างคลัง · รับเข้า · แก้ข้อมูลรายเครื่อง)',
  'job.manage': 'เปิด/แก้ Job (Project: เฉพาะงานที่ตัวเองเปิด)',
  'purchasing.manage': 'ออก PO · รับของ · ราคาจริง',
  'service.confirm': 'ยืนยันติดตั้ง · ทีมช่าง · มอบหมายงาน',
  'closeout.manage': 'เอกสารรับมอบ / Warranty',
  'job.closeInstall': 'ปิดงานติดตั้ง',
  'stockReturn.receive': 'ตรวจรับของคืนเข้าคลัง',
  'master.manage': 'จัดการผู้ใช้ · ตั้งค่าระบบ · ข้ามขั้นอนุมัติ',
  'material.manage': 'ฐานข้อมูลวัสดุ (เพิ่ม/แก้/ลบ · Import Excel)',
  'accessoryStock.manage': 'ยอดคลังวัสดุ (ปรับยอด · Lot)',
  'epicor.issue': 'ทำเบิก Epicor',
  'approval.decide': 'อนุมัติ/ตีกลับคำขอ',
  'install.revertRequest': 'ขอยกเลิกผลติดตั้ง (รอ Division พิจารณา)',
  'approval.comment': 'ให้ความเห็นบนคำขอ',
  'accessory.cleanup': 'ล้างรายการวัสดุที่ยกเลิก',
  'standards.manage': 'แก้ Standard Price / Drawing / BOM',
  'report.exec': 'ดาวน์โหลดรายงานผู้บริหาร (Excel)',
  'letter.manage': 'ออกจดหมาย (PSP-LBS) · แนบไฟล์',
  'letter.delete': 'ลบจดหมาย',
  'letter.signers': 'ตั้งรายชื่อผู้ลงนามจดหมาย',
}

/** สิทธิ์ของแผนก (ตามลำดับในตาราง) — ใช้ทำป้ายในฟอร์มผู้ใช้ */
export function deptPermissionLabels(dept: Department): string[] {
  return (Object.keys(PERMISSIONS) as PermKey[])
    .filter(k => PERMISSIONS[k].includes(dept))
    .map(k => PERM_LABEL[k])
}

/**
 * แก้ผู้ใช้ได้ไหม — เหตุผลที่ไม่ได้ (null = ได้) · ใช้ร่วม updateUser (logic.ts) กับปุ่มบันทึกในหน้าผู้ใช้
 *   รีวิวเฟส 6 #6: เดิมหน้าจอถามยืนยันปิดบัญชีก่อน แล้วค่อยเจอ error ตอนบันทึก — ตอนนี้บอกก่อนกด
 *   ฝั่ง server: 0099 trg_profile_self_guard (ข้อความเดียวกัน)
 */
export function userEditBlock(
  db: DB, actor: { id: string }, target: { id: string; department: Department; isActive: boolean },
  next: { department: Department; isActive: boolean },
): string | null {
  if (target.id === actor.id && target.isActive && !next.isActive) return 'ปิดการใช้งานบัญชีตัวเองไม่ได้'
  if (target.id === actor.id && next.department !== target.department) return 'เปลี่ยนแผนกของบัญชีตัวเองไม่ได้ — ให้ Manage อีกคนเปลี่ยนให้'
  const stillAdmin = next.department === 'admin' && next.isActive
  if (target.department === 'admin' && target.isActive && !stillAdmin
    && !db.users.some(u => u.id !== target.id && u.department === 'admin' && u.isActive))
    return 'ต้องเหลือผู้ดูแลระบบ (Manage) ที่ใช้งานได้อย่างน้อย 1 บัญชี — เพิ่ม/เปิด Manage อีกคนก่อน'
  return null
}

const openJob = (j: Job) => j.terminalStatus !== 'installed' && j.terminalStatus !== 'cancelled'

export interface UserOpenWork {
  /** Job ที่บัญชีนี้เปิดและยังไม่จบ (Project ทำได้เฉพาะงานของตัวเอง — ปิดบัญชีแล้วต้องมีคนรับช่วง) */
  jobs: Job[]
  /** คำขอที่บัญชีนี้ส่งและยังรอ Division พิจารณา */
  requests: ApprovalRequest[]
  /** ช่างในทะเบียนที่ผูกกับบัญชีนี้ (ถ้ามี) + งานที่ยังถืออยู่ */
  member?: TeamMember
  memberJobs: Job[]
  total: number
}

/** งานค้างของบัญชี — โชว์ก่อนปิดบัญชี / เปลี่ยนแผนก (แผน 14) */
export function userOpenWork(db: DB, userId: string): UserOpenWork {
  const jobs = db.jobs.filter(j => j.openedBy === userId && openJob(j))
  const requests = db.approvalRequests.filter(r => r.requestedBy === userId && r.status === 'pending')
  const member = db.teamMembers.find(m => m.userId === userId)
  const memberJobs = member
    ? db.jobs.filter(j => openJob(j) && db.jobAssignments.some(a => a.jobId === j.id && a.memberId === member.id))
    : []
  return { jobs, requests, member, memberJobs, total: jobs.length + requests.length + memberJobs.length }
}
