import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  type Cell, type ReportCol,
  SHEET_SUMMARY, SHEET_GUIDE, buildWorkbook, dataSheet, dataSheetName,
  guideSheet, orDash, summarySheet,
} from './xlsxReport'

/**
 * เทสต์ชุดนี้คุม "สัญญา" ของไฟล์รายงานผู้บริหาร 2 ข้อที่พังเงียบได้ง่ายที่สุด:
 *   1. ชีตข้อมูลต้อง Import กลับได้ — หัวตารางแถว 1 · ไม่มีแถวรวม · หาชีตเจอแม้ชีตสรุปมาก่อน
 *   2. แถวรวมต้องไม่ถูก autofilter คลุม (กรองแล้วยอดรวมต้องไม่หายไปกับแถวที่ถูกซ่อน)
 * ทั้งสองข้อเป็นของที่ "เปิดไฟล์ดูด้วยตาแล้วดูปกติ" แต่พังตอนอัปกลับ/ตอนกรอง
 */

const CATALOG_COLS: ReportCol[] = [
  { key: 'รหัส Epicor', width: 14, note: '' },
  { key: 'ชื่ออุปกรณ์', width: 32, note: '' },
  { key: 'หน่วย', width: 9, note: '' },
  { key: 'คลังคงเหลือ', width: 12, note: '', num: 'int', total: true },
  { key: 'มูลค่า', width: 16, note: '', num: 'money', total: true },
]

const catalogRows: Record<string, Cell>[] = [
  { 'รหัส Epicor': 'EPC-001', 'ชื่ออุปกรณ์': 'Bracket', 'หน่วย': 'ชิ้น', 'คลังคงเหลือ': 10, 'มูลค่า': 1500.5 },
  { 'รหัส Epicor': 'EPC-002', 'ชื่ออุปกรณ์': 'Cable lug', 'หน่วย': 'ตัว', 'คลังคงเหลือ': 4, 'มูลค่า': 220 },
]

const roundTrip = (wb: XLSX.WorkBook): XLSX.WorkBook =>
  XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { cellDates: true })

describe('dataSheet', () => {
  it('วางหัวตารางไว้แถว 1 ตามลำดับที่กำหนด', () => {
    const ws = dataSheet(XLSX, catalogRows, CATALOG_COLS)
    const head = (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] as string[])
    expect(head).toEqual(CATALOG_COLS.map(c => c.key))
  })

  it('ไม่มีข้อมูลก็ยังได้หัวตารางครบ (คลังเปล่าต้องใช้เป็นแบบฟอร์มกรอกได้)', () => {
    const ws = dataSheet(XLSX, [], CATALOG_COLS)
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as string[][]
    expect(rows[0]).toEqual(CATALOG_COLS.map(c => c.key))
    expect(rows).toHaveLength(1)
  })

  it('ใส่รูปแบบตัวเลขให้เซลล์ที่เป็นตัวเลข (ตัวคั่นหลักพันมาจากไฟล์ ไม่ต้องตั้งใน Excel)', () => {
    const ws = dataSheet(XLSX, catalogRows, CATALOG_COLS)
    expect(ws['D2'].z).toBe('#,##0')      // คลังคงเหลือ = int
    expect(ws['E2'].z).toBe('#,##0.00')   // มูลค่า = money
    expect(ws['A2'].z).toBeUndefined()    // ข้อความไม่ต้องมีรูปแบบตัวเลข
  })

  it('ไม่ใส่แถวรวมถ้าไม่สั่ง — ชีตที่ Import กลับได้ต้องมีแต่แถวข้อมูล', () => {
    const ws = dataSheet(XLSX, catalogRows, CATALOG_COLS)
    expect(XLSX.utils.sheet_to_json(ws)).toHaveLength(catalogRows.length)
  })

  it('แถวรวมรวมเฉพาะคอลัมน์ที่ตั้ง total และ autofilter ไม่คลุมแถวรวม', () => {
    const ws = dataSheet(XLSX, catalogRows, CATALOG_COLS, { totalRow: true, totalLabel: 'รวม 2 รายการ' })
    const rows = XLSX.utils.sheet_to_json<Record<string, Cell>>(ws)
    const total = rows[rows.length - 1]
    expect(total['รหัส Epicor']).toBe('รวม 2 รายการ')
    expect(total['คลังคงเหลือ']).toBe(14)
    expect(total['มูลค่า']).toBe(1720.5)
    expect(total['ชื่ออุปกรณ์']).toBe('')          // ไม่ได้ตั้ง total → เว้นว่าง ไม่ใช่เลข 0

    // autofilter สิ้นสุดที่แถวข้อมูลสุดท้าย (แถว 3) ไม่ใช่แถวรวม (แถว 4)
    const ref = (ws['!autofilter'] as { ref: string }).ref
    expect(XLSX.utils.decode_range(ref).e.r).toBe(catalogRows.length)
  })
})

describe('dataSheetName — หาชีตข้อมูลในไฟล์ที่ผู้ใช้อัปกลับมา', () => {
  it('หาชีตข้อมูลเจอ ทั้งที่ชีตสรุปผู้บริหารเป็นชีตแรกของไฟล์', () => {
    const wb = buildWorkbook(XLSX, [
      { name: SHEET_SUMMARY, ws: summarySheet(XLSX, { title: 'สรุป', meta: [], kpis: [] }) },
      { name: 'ฐานข้อมูลวัสดุ', ws: dataSheet(XLSX, catalogRows, CATALOG_COLS) },
      { name: 'คลังคงเหลือ', ws: dataSheet(XLSX, catalogRows, CATALOG_COLS, { totalRow: true }) },
      { name: SHEET_GUIDE, ws: guideSheet(XLSX, [['x']], CATALOG_COLS, ['y']) },
      { name: 'คำอธิบาย-คลังคงเหลือ', ws: guideSheet(XLSX, [['x']], CATALOG_COLS, ['y']) },
    ])
    const back = roundTrip(wb)
    expect(dataSheetName(back, ['ฐานข้อมูลวัสดุ', 'Accessory Catalog'])).toBe('ฐานข้อมูลวัสดุ')

    // อ่านค่ากลับได้เท่าเดิมทุกแถว — นี่คือขั้นที่ Import ใช้จริง
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      back.Sheets[dataSheetName(back, ['ฐานข้อมูลวัสดุ'])], { defval: '' })
    expect(raw).toHaveLength(2)
    expect(raw[0]['รหัส Epicor']).toBe('EPC-001')
    expect(raw[1]['คลังคงเหลือ']).toBe(4)
  })

  it('ไฟล์รุ่นเก่าที่มีชีตเดียวชื่อ Accessory Catalog ยังอ่านได้', () => {
    const wb = buildWorkbook(XLSX, [
      { name: 'Accessory Catalog', ws: dataSheet(XLSX, catalogRows, CATALOG_COLS) },
    ])
    expect(dataSheetName(roundTrip(wb), ['ฐานข้อมูลวัสดุ', 'Accessory Catalog'])).toBe('Accessory Catalog')
  })

  it('ชีตข้อมูลชื่อไม่ตรง (คลัง LBS ตั้งชื่อตาม stockNo) → fallback ข้ามชีตคู่มือให้', () => {
    const wb = buildWorkbook(XLSX, [
      { name: SHEET_SUMMARY, ws: summarySheet(XLSX, { title: 'สรุป', meta: [], kpis: [] }) },
      { name: 'Project Stock No.7', ws: dataSheet(XLSX, catalogRows, CATALOG_COLS) },
      { name: 'วิธีกรอก', ws: guideSheet(XLSX, [['x']], CATALOG_COLS, ['y']) },
    ])
    // ผู้ใช้ import ไฟล์ของคลัง No.7 เข้าคลัง No.9 → ชื่อที่คาดไม่ตรง ต้องยังได้ชีตข้อมูล
    expect(dataSheetName(roundTrip(wb), ['Project Stock No.9'])).toBe('Project Stock No.7')
  })
})

describe('summarySheet', () => {
  const ws = summarySheet(XLSX, {
    title: 'รายงานผู้บริหาร — ทดสอบ',
    scope: 'ทั้งระบบ',
    meta: [['ออกรายงานเมื่อ', '2026-09-09']],
    warnings: ['มี 2 รายการที่ยังไม่กรอกราคา'],
    kpis: [
      { label: 'มูลค่าคลัง', value: 1234567, unit: 'บาท', num: 'money0' },
      { label: 'ยังไม่กรอกต้นทุน', value: '-', unit: 'รายการ', num: 'int' },
    ],
    tables: [{
      title: 'สรุปตาม Job',
      head: ['Job No.', 'มูลค่า'],
      rows: [['JOB-1', 500], ['JOB-2', 700]],
      num: { 1: 'money0' },
      total: ['รวม', 1200],
    }],
    notes: ['ตัวเลขนับจากราคาจริงเท่านั้น'],
  })

  it('ชื่อรายงานอยู่เซลล์แรกของไฟล์', () => {
    expect(ws['A1'].v).toBe('รายงานผู้บริหาร — ทดสอบ')
  })

  it('merge หัวข้อคั่นเต็มแถว (แทนตัวหนาที่ SheetJS community เขียนไม่ได้)', () => {
    const merges = ws['!merges'] as { s: { r: number; c: number }; e: { r: number; c: number } }[]
    expect(merges.some(m => m.s.r === 0 && m.s.c === 0 && m.e.c === 5)).toBe(true)
  })

  it('ใส่รูปแบบตัวเลขให้ค่า KPI และตัวเลขในตารางสรุป', () => {
    const cells = Object.keys(ws).filter(k => !k.startsWith('!')).map(k => ws[k])
    expect(cells.find(c => c.v === 1234567)?.z).toBe('#,##0')
    expect(cells.find(c => c.v === 1200)?.z).toBe('#,##0')
    // ค่าที่ยังไม่มีข้อมูลส่งเป็น '-' ได้ ไม่พังและไม่กลายเป็น 0
    expect(cells.some(c => c.v === '-')).toBe(true)
  })

  it('เปิดไฟล์กลับมาแล้วยังอ่านคำเตือน/หมายเหตุได้ (ข้อความไม่หายตอน write)', () => {
    const back = roundTrip(buildWorkbook(XLSX, [{ name: SHEET_SUMMARY, ws }]))
    const text = XLSX.utils.sheet_to_csv(back.Sheets[SHEET_SUMMARY])
    expect(text).toContain('มี 2 รายการที่ยังไม่กรอกราคา')
    expect(text).toContain('ตัวเลขนับจากราคาจริงเท่านั้น')
  })
})

describe('orDash', () => {
  it('ค่าที่ยังไม่มี → "-" แต่ 0 ยังเป็น 0 (ไม่ถูกกลืน)', () => {
    expect(orDash(undefined)).toBe('-')
    expect(orDash(NaN)).toBe('-')
    expect(orDash(0)).toBe(0)
  })
})
