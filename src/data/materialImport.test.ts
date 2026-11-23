// เฟส 4 (2026-11-23) — ตัวอ่านไฟล์ Import ของ Material Master (ย้ายออกจากหน้าเพื่อให้เทสต์ได้)
import { describe, it, expect } from 'vitest'
import type { Item } from '../types'
import { parseImportRows, parseCountRows } from './materialImport'

const item = (over: Partial<Item>): Item =>
  ({ id: 'i1', code: 'ACC-1', epicorCode: 'EP-1', name: 'ลูกถ้วย', itemType: 'accessory', uom: 'ea', stockableCentrally: false, ...over })

describe('parseImportRows — ไฟล์ฐานข้อมูลวัสดุ', () => {
  const none = () => undefined
  it('🔴 วัสดุเดิมที่เป็น "สั่งซื้อเท่านั้น" + ช่องการจัดหาว่าง + มียอดคงเหลือ = error (เดิมผ่าน preview แล้วพังตอนนำเข้า)', () => {
    const rows = parseImportRows([{ 'รหัส Epicor': 'EP-1', 'ชื่ออุปกรณ์': 'ลูกถ้วย', 'คลังคงเหลือ': '5' }], [item({})], () => 0, none)
    expect(rows[0]).toMatchObject({ action: 'error' })
    expect(rows[0].error).toContain('สั่งซื้อเท่านั้น')
  })
  it('ช่องการจัดหาว่าง แต่วัสดุเดิมเก็บคลังอยู่แล้ว = อัปเดตยอดได้ตามเดิม', () => {
    const rows = parseImportRows([{ 'รหัส Epicor': 'EP-1', 'ชื่ออุปกรณ์': 'ลูกถ้วย', 'คลังคงเหลือ': '5' }],
      [item({ stockableCentrally: true })], () => 2, none)
    expect(rows[0]).toMatchObject({ action: 'update', stockQty: 5, curQty: 2 })
  })
  it('ระบุการจัดหาเป็นคลังในไฟล์ = เปลี่ยนเป็นเก็บคลัง + ตั้งยอดได้', () => {
    const rows = parseImportRows([{ 'รหัส Epicor': 'EP-1', 'ชื่ออุปกรณ์': 'ลูกถ้วย', 'การจัดหา': 'เก็บคลังคงเหลือ', 'คลังคงเหลือ': '5' }],
      [item({})], () => 0, none)
    expect(rows[0]).toMatchObject({ action: 'update', supply: true })
  })
})

describe('parseCountRows — ไฟล์ตรวจนับคลัง', () => {
  const cols = { code: 'รหัสระบบ', epicor: 'รหัส Epicor', newQty: 'ยอดนับจริง', newCost: 'ต้นทุนใหม่' }
  const items = [item({ stockableCentrally: true }), item({ id: 'lbs', code: 'LBS-115', epicorCode: 'LBS', name: 'LBS 115kV', itemType: 'main_equipment' })]
  it('🔴 วัสดุซ้ำในไฟล์ = error แม้แถวแรกจะเท่ากับยอดในระบบ (เดิมแถวแรกถูกข้ามเงียบ แถวที่สองผ่าน)', () => {
    const r = parseCountRows([{ 'รหัสระบบ': 'ACC-1', 'ยอดนับจริง': '3' }, { 'รหัสระบบ': 'ACC-1', 'ยอดนับจริง': '9' }],
      items, () => 3, () => 0, cols)
    expect(r.rows).toEqual([])
    expect(r.errors).toEqual(['แถว 3 ลูกถ้วย: มีซ้ำในไฟล์'])
  })
  it('🔴 LBS หลัก (main_equipment) นำเข้าตรวจนับไม่ได้ — ไม่ใช่วัสดุคลังคงเหลือ', () => {
    const r = parseCountRows([{ 'รหัสระบบ': 'LBS-115', 'ยอดนับจริง': '2' }], items, () => 0, () => 0, cols)
    expect(r.rows).toEqual([])
    expect(r.errors[0]).toContain('LBS หลัก')
  })
  it('ยอดต่างจากระบบ = รายการปรับ · เท่ากัน = ข้าม', () => {
    const r = parseCountRows([{ 'รหัสระบบ': 'ACC-1', 'ยอดนับจริง': '7' }], items, () => 3, () => 0, cols)
    expect(r.rows.map(x => [x.item.id, x.curQty, x.qty])).toEqual([['i1', 3, 7]])
    expect(parseCountRows([{ 'รหัสระบบ': 'ACC-1', 'ยอดนับจริง': '3' }], items, () => 3, () => 0, cols).rows).toEqual([])
  })
})
