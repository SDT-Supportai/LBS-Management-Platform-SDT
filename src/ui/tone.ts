// =============================================================================
// สีป้าย (badge) รายหน้า — ธีม LBS Glass UI รอบ 2 (2026-11-24) ตาม canvas หน้า 9 / 12 / 14 / 15
//   คืนชื่อคลาสสีของ .badge (blue / green / amber / red / violet / neutral) เท่านั้น
//   หน้าตาล้วน: ไม่แตะข้อมูล สิทธิ์ หรือ Flow — เทสต์: tone.test.ts
// =============================================================================
import type { AcceptanceType, Department, StockMovementType, StockReturnKind } from '../types'

export type Tone = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'neutral'

const AUDIT_TONE: Record<string, Tone> = {
  approval_request: 'amber',
  purchase_requisition: 'green', purchase_order: 'green',
  job_payment: 'violet',
  project_stock: 'blue', lbs_unit: 'blue', stock_allocation: 'blue', accessory_stock: 'blue', item: 'blue',
  accessory_request: 'blue', job_accessory_request: 'blue',
}
/** Audit Log — สีตามหมวดของประเภทข้อมูล (ไม่ใช้แดงกับทั้งประเภท · ไม่รู้จัก = เทา) */
export const auditEntityTone = (entityType: string): Tone => AUDIT_TONE[entityType] ?? 'neutral'

const DEPT_TONE: Record<Department, Tone> = {
  admin: 'neutral', project: 'blue', sales: 'violet', purchasing: 'amber', service: 'green', vip: 'violet',
}
export const deptTone = (d: Department): Tone => DEPT_TONE[d] ?? 'neutral'

const MOVE_TONE: Record<StockMovementType, Tone> = {
  issue_to_job: 'red',
  return_from_job: 'green', transfer_from_job: 'green', job_cancelled: 'green',
  adjust: 'amber', import_adjust: 'amber', reverse_to_job: 'amber',
  initial: 'neutral',
}
/** ประวัติคลังวัสดุ — เบิกออก แดง · รับเข้า เขียว · ปรับยอด/ย้อน เหลือง · ยอดยกมา เทา */
export const movementTone = (t: StockMovementType): Tone => MOVE_TONE[t] ?? 'neutral'

/** รอตรวจรับเข้าคลัง — ช่างคืนของเหลือ เขียว · โอน/คืนคลัง ฟ้า */
export const returnKindTone = (k: StockReturnKind): Tone => (k === 'field_return' ? 'green' : 'blue')

/** วิธีจัดหาวัสดุ — เก็บคลังคงเหลือ ฟ้า · สั่งซื้อเท่านั้น ม่วง */
export const procurementTone = (stockableCentrally: boolean): Tone => (stockableCentrally ? 'blue' : 'violet')

/** เอกสารรับมอบ — PAC เขียว · อื่น ๆ ฟ้า */
export const acceptanceTone = (t?: AcceptanceType | string): Tone => (t === 'PAC' ? 'green' : 'blue')
