// รีวิวเฟส 2 ข้อ 1 (2026-11-23) — Esc ต้องทำเหมือนคลิกพื้นหลัง: กล่องสั่น ไม่ปิด ข้อมูลไม่หาย
//   บั๊ก: เฟส 2 ให้ Esc ปิดกล่องที่ไม่มี dirty ทันที ⇒ ฟอร์มกว่า 40 กล่อง (แก้ไข Job / เพิ่มวัสดุ / เบิก /
//   งวดเงิน / ปิดงาน / Import) กด Esc พลาดครั้งเดียวข้อมูลที่กรอกหายหมด — ย้อนกลับมาตรการเฟส 0
//   ปิดได้ทางปุ่ม ✕ / ยกเลิก เท่านั้น (เหมือนเดิมก่อนเฟส 2)
import { describe, it, expect } from 'vitest'
import { modalKeyAction } from './components'

describe('Modal — ปุ่ม Esc', () => {
  it('Esc บนกล่องบนสุด = กล่องสั่นบอกให้ปิดที่ปุ่ม (ไม่ปิด ข้อมูลไม่หาย)', () => {
    expect(modalKeyAction('Escape', true)).toBe('poke')
  })
  it('Esc ไม่มีทางปิดกล่องได้เลย ไม่ว่ากล่องไหน', () => {
    for (const top of [true, false]) expect(modalKeyAction('Escape', top)).not.toBe('close')
  })
  it('กล่องที่ถูกกล่องอื่นทับอยู่ ไม่ตอบสนอง (สั่นเฉพาะกล่องบนสุด)', () => {
    expect(modalKeyAction('Escape', false)).toBeNull()
  })
  it('ปุ่มอื่นไม่เกี่ยว', () => {
    expect(modalKeyAction('Enter', true)).toBeNull()
  })
})
