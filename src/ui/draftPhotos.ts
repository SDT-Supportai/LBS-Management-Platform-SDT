// =============================================================================
// รูปของแบบร่างยืนยันติดตั้ง — เก็บใน IndexedDB แยกจากตัวร่าง (รีวิวเฟส 5 #8 · 2026-11-24)
//   เดิมเก็บเป็น data URL ใน localStorage พร้อมตัวร่าง ⇒ พิมพ์บันทึกทีละตัวเขียนรูป ~400 KB ซ้ำทุกครั้ง
//   และกินโควตาเดียวกับฐานข้อมูล demo · ตอนนี้: เก็บ Blob ตรง ๆ เขียนเฉพาะตอนรูปเปลี่ยน
//   ใช้ไม่ได้ (โหมดส่วนตัว/ปิดไว้) = ไม่มีรูปในร่าง ต้องถ่ายใหม่ — ไม่ทำให้ยืนยันติดตั้งไม่ได้
// =============================================================================
const DB_NAME = 'lbs-install-drafts'
const STORE = 'photos'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

/** คีย์ = ผู้ใช้ + เครื่อง (ร่างผูกผู้ใช้ — #9) */
export const draftPhotoKey = (userId: string, unitId: string) => `${userId}:${unitId}`

export async function putDraftPhoto(key: string, blob: Blob): Promise<void> {
  try { await run('readwrite', s => s.put(blob, key)) } catch { /* เก็บไม่ได้ = ร่างไม่มีรูป */ }
}
export async function getDraftPhoto(key: string): Promise<Blob | null> {
  try { const b = await run<unknown>('readonly', s => s.get(key)); return b instanceof Blob ? b : null } catch { return null }
}
export async function deleteDraftPhoto(key: string): Promise<void> {
  try { await run('readwrite', s => s.delete(key)) } catch { /* ไม่มีอะไรให้ลบ */ }
}
/** ลบรูปที่ไม่มีร่างแล้ว (ร่างหมดอายุ/ถูกตัดออก) */
export async function pruneDraftPhotos(keep: Set<string>): Promise<void> {
  try {
    const keys = await run<IDBValidKey[]>('readonly', s => s.getAllKeys())
    await Promise.all(keys.map(String).filter(k => !keep.has(k)).map(k => run('readwrite', s => s.delete(k))))
  } catch { /* ไม่เป็นไร */ }
}
