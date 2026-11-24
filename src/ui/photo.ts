// =============================================================================
// ย่อรูปถ่ายก่อนส่ง (เฟส 5 · 2026-11-23) — รูปจากมือถือ 4–8 MB · ย่อด้านยาว ≤1600 px เป็น JPEG ~200–400 KB
//   ได้ทั้ง: อัปโหลดเร็วบนเน็ตหน้างาน · demo ไม่เต็ม localStorage · HEIC (iPhone) แปลงเป็น JPEG เปิดได้ทุกเบราว์เซอร์
//   ถอดรหัสรูปไม่ได้ (เช่น HEIC บน Chrome) = ใช้ไฟล์เดิม ไม่ทำให้ยืนยันติดตั้งไม่ได้
// ขนาดคำนวณด้วย fitWithin (src/data/field.ts — มีเทสต์)
// =============================================================================
import { fitWithin } from '../data/field'
import { transplantExif } from '../data/exif'

const readAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ'))
  r.readAsDataURL(blob)
})

export async function compressImage(file: File, max = 1600, quality = 0.8): Promise<{ file: File; dataUrl: string; compressed: boolean }> {
  try {
    const bmp = await createImageBitmap(file)
    const { w, h } = fitWithin(bmp.width, bmp.height, max)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close?.()
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality))
    if (!blob) throw new Error('encode failed')
    // ย่อแล้วใหญ่กว่าเดิม (รูปเล็กมากอยู่แล้ว) = ใช้ของเดิม
    if (blob.size >= file.size && file.type === 'image/jpeg') return { file, dataUrl: await readAsDataUrl(file), compressed: false }
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
    // รีวิวเฟส 5 #7: คง EXIF ต้นฉบับ (เวลาถ่าย/พิกัด = หลักฐานประกอบการเช็คอิน) · Orientation = 1 (หมุนแล้ว)
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer())
    try { bytes = transplantExif(new Uint8Array(await file.arrayBuffer()), bytes) } catch { /* อ่าน EXIF ไม่ได้ = ใช้รูปที่ย่อแล้วตามเดิม */ }
    const out = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'image/jpeg' })
    return { file: out, dataUrl: await readAsDataUrl(out), compressed: true }
  } catch {
    return { file, dataUrl: await readAsDataUrl(file), compressed: false }
  }
}
