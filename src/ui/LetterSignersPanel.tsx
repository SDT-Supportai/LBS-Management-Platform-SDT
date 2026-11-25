import { useState } from 'react'
import { useStore } from '../data/StoreContext'
import { canLetter, type LetterSigner } from '../data/letters'
import { Modal, useTryAction } from './components'

// =============================================================================
// รายชื่อผู้ลงนามจดหมาย (0100 · คำตอบผู้ใช้ข้อ 4) — หน้า Users & System Settings · Manage เท่านั้น
//   ปิดใช้งานแทนการลบ: จดหมายเก่าอ้างถึง (ชื่อ/ตำแหน่ง snapshot ลงจดหมายแล้ว แก้ที่นี่ไม่กระทบฉบับเก่า)
// =============================================================================
type Form = { id?: string; fullName: string; position: string; sortOrder: string; isActive: boolean }

export function LetterSignersPanel() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const [form, setForm] = useState<Form | null>(null)
  if (!canLetter(user, 'signers')) return null

  const rows = [...db.letterSigners].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.sortOrder - b.sortOrder)
  const open = (s?: LetterSigner) => setForm(s
    ? { id: s.id, fullName: s.fullName, position: s.position, sortOrder: String(s.sortOrder), isActive: s.isActive }
    : { fullName: '', position: '', sortOrder: '', isActive: true })
  const save = async () => {
    if (!form) return
    const sortOrder = form.sortOrder.trim() ? Number(form.sortOrder) : undefined
    const ok = await tryAction(() => act.upsertLetterSigner({
      id: form.id, fullName: form.fullName, position: form.position, sortOrder, isActive: form.isActive,
    }), form.id ? 'บันทึกผู้ลงนามแล้ว' : 'เพิ่มผู้ลงนามแล้ว')
    if (ok) setForm(null)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>รายชื่อผู้ลงนามจดหมาย ({db.letterSigners.filter(s => s.isActive).length} ใช้งาน)</h3>
        <button className="small primary" onClick={() => open()}>+ เพิ่มผู้ลงนาม</button>
      </div>
      <div className="panel-body muted" style={{ paddingBottom: 0, fontSize: 12 }}>
        ตัวเลือก "ผู้ลงนาม" ในฟอร์มออกจดหมาย (หน้า Letters) · ไม่ใช้แล้วให้ปิดใช้งาน — จดหมายเก่าคงชื่อเดิม
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>ลำดับ</th><th>ชื่อ</th><th>ตำแหน่ง</th><th>สถานะ</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่มีผู้ลงนาม — ออกจดหมายไม่ได้จนกว่าจะเพิ่มอย่างน้อย 1 คน</div></td></tr>}
            {rows.map(s => (
              <tr key={s.id} style={s.isActive ? undefined : { opacity: 0.6 }}>
                <td>{s.sortOrder}</td>
                <td><b>{s.fullName}</b></td>
                <td>{s.position || <span className="muted">-</span>}</td>
                <td><span className={`badge ${s.isActive ? 'green' : 'neutral'}`}>{s.isActive ? 'ใช้งาน' : 'ปิดใช้งาน'}</span></td>
                <td style={{ textAlign: 'right' }}><button className="small" onClick={() => open(s)}>แก้ไข</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <Modal title={form.id ? 'แก้ไขผู้ลงนาม' : 'เพิ่มผู้ลงนาม'} onClose={() => setForm(null)}
          footer={<>
            <button onClick={() => setForm(null)}>ยกเลิก</button>
            <button className="success" disabled={!form.fullName.trim()} onClick={save}>บันทึก</button>
          </>}>
          <label className="field"><span>ชื่อ-นามสกุล *</span>
            <input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} />
          </label>
          <div className="row">
            <label className="field"><span>ตำแหน่ง (พิมพ์ใต้ชื่อในจดหมาย)</span>
              <input value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} placeholder="ผู้จัดการฝ่าย…" />
            </label>
            <label className="field"><span>ลำดับใน dropdown</span>
              <input type="number" min={0} value={form.sortOrder} onChange={e => setForm({ ...form, sortOrder: e.target.value })} placeholder="ต่อท้าย" />
            </label>
          </div>
          {form.id && (
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />
              <span>ใช้งาน (ติ๊กออก = ไม่ขึ้นในตัวเลือกผู้ลงนามอีก)</span>
            </label>
          )}
        </Modal>
      )}
    </div>
  )
}
