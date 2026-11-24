// เฟส 5 รีวิว #7 — ย่อรูปแล้วข้อมูล EXIF (เวลาถ่าย/พิกัด) ต้องไม่หาย · Orientation ต้องเป็น 1 (ภาพถูกหมุนแล้ว)
import { describe, it, expect } from 'vitest'
import { transplantExif, readExifOrientation } from './exif'

/** APP1 Exif จำลอง: TIFF little-endian · IFD0 2 รายการ (Orientation=6, DateTime offset ชี้ไปข้อความ) */
function exifApp1(orientation: number, le = true): number[] {
  const u16 = (v: number) => le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]
  const u32 = (v: number) => le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  const date = [...'2026:11:23 09:15:00'].map(c => c.charCodeAt(0)).concat(0)        // 20 bytes
  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),                 // header → IFD0 @8
    ...u16(2),                                                                      // 2 entries
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,                // Orientation SHORT
    ...u16(0x0132), ...u16(2), ...u32(20), ...u32(8 + 2 + 24 + 4),                  // DateTime ASCII → หลัง IFD
    ...u32(0),                                                                      // next IFD
    ...date,
  ]
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]                             // "Exif\0\0"
  const len = body.length + 2
  return [0xff, 0xe1, len >> 8, len & 0xff, ...body]
}
const SOI = [0xff, 0xd8], EOI = [0xff, 0xd9]
const APP0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]  // JFIF (canvas ใส่มาเอง)
const SCAN = [0xff, 0xda, 0, 2, 1, 2, 3]

describe('transplantExif — คง EXIF ของรูปต้นฉบับไว้ในรูปที่ย่อแล้ว', () => {
  it('🔴 ย้าย APP1 Exif ไปไว้ต่อจาก JFIF ของรูปใหม่ · Orientation ตั้งเป็น 1 · เวลาถ่ายยังอยู่', () => {
    const orig = new Uint8Array([...SOI, ...exifApp1(6), ...SCAN, ...EOI])
    const out = new Uint8Array([...SOI, ...APP0, ...SCAN, ...EOI])
    const r = transplantExif(orig, out)
    expect([...r.slice(0, 2)]).toEqual(SOI)
    expect([...r.slice(2, 2 + APP0.length)]).toEqual(APP0)
    expect([r[2 + APP0.length], r[3 + APP0.length]]).toEqual([0xff, 0xe1])
    expect(readExifOrientation(r)).toBe(1)
    expect(new TextDecoder().decode(r)).toContain('2026:11:23 09:15:00')
    expect(readExifOrientation(orig)).toBe(6)            // ไม่แก้ต้นฉบับ
  })
  it('big-endian (MM) ก็ได้', () => {
    const r = transplantExif(new Uint8Array([...SOI, ...exifApp1(8, false), ...EOI]), new Uint8Array([...SOI, ...SCAN, ...EOI]))
    expect(readExifOrientation(r)).toBe(1)
    expect([r[2], r[3]]).toEqual([0xff, 0xe1])
  })
  it('ต้นฉบับไม่มี EXIF / ไม่ใช่ JPEG (เช่น PNG/HEIC) = คืนรูปใหม่ตามเดิม', () => {
    const out = new Uint8Array([...SOI, ...APP0, ...SCAN, ...EOI])
    expect(transplantExif(new Uint8Array([...SOI, ...SCAN, ...EOI]), out)).toBe(out)
    expect(transplantExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), out)).toBe(out)
  })
})
