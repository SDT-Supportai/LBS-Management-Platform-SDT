// =============================================================================
// คง EXIF ของรูปหน้างานไว้หลังย่อรูป (รีวิวเฟส 5 #7 · 2026-11-24)
//   ย่อผ่าน canvas = ได้ JPEG ใหม่ที่ไม่มี EXIF ⇒ เวลาถ่าย/พิกัดในรูป (หลักฐานประกอบการเช็คอิน) หาย
//   ⇒ คัดลอก APP1 "Exif" ของต้นฉบับใส่รูปใหม่ · ตั้ง Orientation = 1 เพราะ createImageBitmap หมุนภาพให้แล้ว
//     (ไม่ตั้ง = โปรแกรมดูรูปหมุนซ้ำอีกรอบ)
//   ต้นฉบับไม่ใช่ JPEG / ไม่มี EXIF (PNG · HEIC) = คืนรูปใหม่ตามเดิม
// =============================================================================

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]   // "Exif\0\0"

/** ตำแหน่ง segment ใน JPEG (marker FFxx ก่อนข้อมูลภาพ SOS) */
function segments(b: Uint8Array): { marker: number; start: number; end: number }[] {
  const out: { marker: number; start: number; end: number }[] = []
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return out
  let i = 2
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]
    if (marker === 0xda || marker === 0xd9) break                    // เริ่มข้อมูลภาพ / จบไฟล์
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len < 2 || i + 2 + len > b.length) break
    out.push({ marker, start: i, end: i + 2 + len })
    i += 2 + len
  }
  return out
}

function findExif(b: Uint8Array) {
  return segments(b).find(s => s.marker === 0xe1 && EXIF_ID.every((v, k) => b[s.start + 4 + k] === v))
}

/** ตำแหน่ง (ใน b) ของค่า Orientation ใน IFD0 + byte order · ไม่พบ = null */
function orientationAt(b: Uint8Array, seg: { start: number; end: number }): { pos: number; le: boolean } | null {
  const t = seg.start + 4 + EXIF_ID.length                            // จุดเริ่ม TIFF
  if (t + 8 > seg.end) return null
  const le = b[t] === 0x49 && b[t + 1] === 0x49
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return null
  const u16 = (p: number) => le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]
  const u32 = (p: number) => le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
    : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
  const ifd = t + u32(t + 4)
  if (ifd + 2 > seg.end) return null
  const n = u16(ifd)
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > seg.end) return null
    if (u16(e) === 0x0112) return { pos: e + 8, le }
  }
  return null
}

/** อ่านค่า Orientation จาก EXIF ของ JPEG (ไม่มี = null) — ใช้ในเทสต์/ตรวจผล */
export function readExifOrientation(b: Uint8Array): number | null {
  const seg = findExif(b)
  const o = seg && orientationAt(b, seg)
  if (!o) return null
  return o.le ? b[o.pos] | (b[o.pos + 1] << 8) : (b[o.pos] << 8) | b[o.pos + 1]
}

/** ใส่ EXIF ของ `orig` ลงใน JPEG `out` (ต่อจาก APP0 JFIF ถ้ามี) · Orientation = 1 */
export function transplantExif(orig: Uint8Array, out: Uint8Array): Uint8Array {
  const seg = findExif(orig)
  if (!seg) return out
  const outSegs = segments(out)
  if (out.length < 2 || out[0] !== 0xff || out[1] !== 0xd8) return out
  const app1 = orig.slice(seg.start, seg.end)                          // สำเนา — ไม่แก้ต้นฉบับ
  const o = orientationAt(app1, { start: 0, end: app1.length })
  if (o) { app1[o.pos] = o.le ? 1 : 0; app1[o.pos + 1] = o.le ? 0 : 1 }
  const alreadyHasExif = outSegs.filter(s => s.marker === 0xe1 && EXIF_ID.every((v, k) => out[s.start + 4 + k] === v))
  if (alreadyHasExif.length) return out                                // รูปใหม่มี EXIF อยู่แล้ว (ไม่ควรเกิดจาก canvas)
  const app0 = outSegs.find(s => s.marker === 0xe0)
  const at = app0 && app0.start === 2 ? app0.end : 2
  const r = new Uint8Array(out.length + app1.length)
  r.set(out.subarray(0, at), 0)
  r.set(app1, at)
  r.set(out.subarray(at), at + app1.length)
  return r
}
