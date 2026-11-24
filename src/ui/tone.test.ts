// ธีม LBS Glass UI รอบ 2 (2026-11-24) — สีป้ายรายหน้าตาม canvas (หน้า 9 / 12 / 14 / 15)
//   หน้าตาล้วน: เปลี่ยนแค่ className ของป้าย ไม่แตะข้อมูล/สิทธิ์/Flow
import { describe, it, expect } from 'vitest'
import { auditEntityTone, deptTone, movementTone, returnKindTone, acceptanceTone, procurementTone } from './tone'
import { AUDIT_ENTITY_LABEL } from '../data/audit'
import type { Department, StockMovementType } from '../types'

const TONES = ['blue', 'green', 'amber', 'red', 'violet', 'neutral']

describe('Audit — สีป้ายประเภทข้อมูล (แบบ: อนุมัติ เหลือง · จัดซื้อ เขียว · สต็อก ฟ้า · งวดเงิน ม่วง · ระบบ เทา)', () => {
  it('ตามหมวด', () => {
    expect(auditEntityTone('approval_request')).toBe('amber')
    expect(auditEntityTone('purchase_requisition')).toBe('green')
    expect(auditEntityTone('purchase_order')).toBe('green')
    expect(auditEntityTone('job_payment')).toBe('violet')
    for (const t of ['project_stock', 'lbs_unit', 'stock_allocation', 'accessory_stock', 'item', 'accessory_request', 'job_accessory_request'])
      expect(auditEntityTone(t), t).toBe('blue')
    for (const t of ['user', 'profile', 'app_settings', 'line_bind', 'share_link']) expect(auditEntityTone(t), t).toBe('neutral')
  })
  it('ไม่ใช้สีแดงกับทั้งประเภท (แดง = ผิดปกติ) · ชนิดที่ไม่รู้จัก = เทา', () => {
    for (const t of Object.keys(AUDIT_ENTITY_LABEL)) {
      expect(TONES).toContain(auditEntityTone(t))
      expect(auditEntityTone(t), t).not.toBe('red')
    }
    expect(auditEntityTone('something_new')).toBe('neutral')
  })
})

describe('Users — สีป้ายแผนก', () => {
  it('ทุกแผนกมีสี · Division (sales) ม่วง · Project ฟ้า · Purchasing เหลือง · Service เขียว · Manage เทา', () => {
    const want: Record<Department, string> = { admin: 'neutral', project: 'blue', sales: 'violet', purchasing: 'amber', service: 'green', vip: 'violet' }
    for (const [d, t] of Object.entries(want)) expect(deptTone(d as Department), d).toBe(t)
  })
})

describe('Material Master — สีป้าย', () => {
  it('ประวัติคลัง: เบิกออก แดง · รับเข้า เขียว · ปรับยอด/ย้อน เหลือง · ยอดยกมา เทา', () => {
    const want: Record<StockMovementType, string> = {
      issue_to_job: 'red', return_from_job: 'green', transfer_from_job: 'green', job_cancelled: 'green',
      adjust: 'amber', import_adjust: 'amber', reverse_to_job: 'amber', initial: 'neutral',
    }
    for (const [m, t] of Object.entries(want)) expect(movementTone(m as StockMovementType), m).toBe(t)
  })
  it('รอตรวจรับ: ช่างคืนของเหลือ เขียว · โอน/คืนคลัง ฟ้า', () => {
    expect(returnKindTone('field_return')).toBe('green')
    expect(returnKindTone('transfer')).toBe('blue')
    expect(returnKindTone('return')).toBe('blue')
  })
  it('วิธีจัดหา: เก็บคลังคงเหลือ ฟ้า · สั่งซื้อเท่านั้น ม่วง', () => {
    expect(procurementTone(true)).toBe('blue')
    expect(procurementTone(false)).toBe('violet')
  })
})

describe('Warranty — สีป้ายเอกสารรับมอบ', () => {
  it('PAC เขียว · อื่น ๆ ฟ้า (เหมือนเดิม)', () => {
    expect(acceptanceTone('PAC')).toBe('green')
    for (const t of ['AC', 'COD', 'HANDOVER', undefined] as const) expect(acceptanceTone(t)).toBe('blue')
  })
})
