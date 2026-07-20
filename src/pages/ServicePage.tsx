import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { deriveJobStatus } from '../data/logic'
import { Modal, useToast, useTryAction } from '../ui/components'
import { fmtDate, fmtDateTime } from '../ui/format'
import { supabase } from '../lib/supabase'

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ'))
    r.readAsDataURL(file)
  })
}

export default function ServicePage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { show } = useToast()
  const canConfirm = can(user, 'service.confirm')
  const [confirmFor, setConfirmFor] = useState<string | null>(null)
  const [installedDate, setInstalledDate] = useState('')
  const [note, setNote] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = useState(false)
  const [photo, setPhoto] = useState<{ file: File; preview: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const ready = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue')
  const issued = db.jobs.filter(j => j.terminalStatus === 'issued')
  const installed = db.jobs.filter(j => j.terminalStatus === 'installed')

  const unitsOf = (jobId: string) => db.lbsUnits.filter(u => u.jobId === jobId)
  const accOf = (jobId: string) => db.accessoryRequests.filter(r =>
    r.jobId === jobId && (r.status === 'issued' || r.status === 'received'))
  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const userOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  const confirmJob = confirmFor ? db.jobs.find(j => j.id === confirmFor) : null

  const openConfirm = (jobId: string) => {
    setInstalledDate(new Date().toISOString().slice(0, 10))
    setNote(''); setCoords(null); setPhoto(null); setConfirmFor(jobId)
  }

  const captureLocation = () => {
    if (!navigator.geolocation) { show('อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง', true); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      pos => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocating(false) },
      err => { show(`ระบุตำแหน่งไม่สำเร็จ: ${err.message} — เปิดสิทธิ์ Location ให้เบราว์เซอร์`, true); setLocating(false) },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  const pickPhoto = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { show('กรุณาเลือกไฟล์รูปภาพ', true); return }
    setPhoto({ file, preview: await readAsDataUrl(file) })
  }

  // LIVE: อัปโหลดเข้า Supabase Storage คืน public URL · demo: เก็บ data URL ตรงๆ
  const resolvePhotoUrl = async (jobId: string): Promise<string> => {
    if (!photo) throw new Error('ต้องแนบรูปถ่ายหน้างานก่อนยืนยัน')
    if (!supabase) return photo.preview
    const ext = (photo.file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${jobId}/${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('install-photos').upload(path, photo.file, { upsert: false })
    if (error) throw new Error(`อัปโหลดรูปไม่สำเร็จ: ${error.message} (ตรวจว่าสร้าง bucket install-photos แล้ว)`)
    return supabase.storage.from('install-photos').getPublicUrl(path).data.publicUrl
  }

  const submitConfirm = async () => {
    if (!confirmFor || !coords || !photo) return
    setSubmitting(true)
    try {
      const photoUrl = await resolvePhotoUrl(confirmFor)
      const ok = await tryAction(
        () => act.confirmInstall({ jobId: confirmFor, installedDate, note, checkinLat: coords.lat, checkinLng: coords.lng, photoUrl }),
        'ยืนยันติดตั้งเสร็จแล้ว — แจ้ง Project อัตโนมัติ')
      if (ok) { setConfirmFor(null); setPhoto(null); setCoords(null) }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
    setSubmitting(false)
  }

  return (
    <>
      <div className="page-title">Service (Installation)</div>
      <div className="page-sub">รับงานที่เบิกแล้ว → เข้าติดตั้งหน้างาน → ยืนยันเสร็จพร้อม Check-in ตำแหน่ง GPS + รูปถ่าย (บังคับทุกครั้ง)</div>

      <div className="panel">
        <div className="panel-head"><h3>รอ Project เบิกให้ ({ready.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า</th><th>สถานที่</th><th>กำหนดติดตั้ง</th></tr></thead>
            <tbody>
              {ready.length === 0 && <tr><td colSpan={4}><div className="empty">ไม่มีงานพร้อมเบิก</div></td></tr>}
              {ready.map(j => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                  <td>{j.customerName}</td>
                  <td>{j.installLocation || '-'}</td>
                  <td>{fmtDate(j.requiredDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>เบิกแล้ว — รอติดตั้ง ({issued.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ของที่เบิก</th><th>เบิกเมื่อ</th><th></th></tr></thead>
            <tbody>
              {issued.length === 0 && <tr><td colSpan={5}><div className="empty">ไม่มีงานรอติดตั้ง</div></td></tr>}
              {issued.map(j => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                  <td>{j.customerName}
                    <div className="muted">
                      📍 {j.issueLocation || j.installLocation || '-'}
                      {j.installStartDate && <> · 📅 นัดติดตั้ง <b>{fmtDate(j.installStartDate)} – {fmtDate(j.installEndDate)}</b></>}
                    </div>
                    {j.issuedNote && <div className="muted">📝 {j.issuedNote}</div>}</td>
                  <td>
                    <div>LBS {unitsOf(j.id).length} เครื่อง <span className="muted mono">({unitsOf(j.id).map(u => u.serialLvb).join(', ')})</span></div>
                    {accOf(j.id).map(r => {
                      const it = itemOf(r.itemId)!
                      return <div key={r.id} className="muted">{it.name} × {r.qtyRequested} {it.uom}</div>
                    })}
                  </td>
                  <td className="muted">{fmtDateTime(j.issuedAt)}</td>
                  <td>
                    {canConfirm && (
                      <button className="small success" onClick={() => openConfirm(j.id)}>ยืนยันติดตั้งเสร็จ</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>ติดตั้งเสร็จแล้ว ({installed.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ติดตั้งเสร็จเมื่อ</th><th>ยืนยันโดย</th><th>หลักฐาน</th></tr></thead>
            <tbody>
              {installed.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่มีงานติดตั้งเสร็จ</div></td></tr>}
              {installed.map(j => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                  <td>{j.customerName}<div className="muted">{j.installLocation}</div></td>
                  <td>{fmtDate(j.installedAt)}</td>
                  <td>{userOf(j.installConfirmedBy)}</td>
                  <td>
                    {j.installPhotoUrl && <a href={j.installPhotoUrl} target="_blank" rel="noreferrer">🖼️ รูปหน้างาน</a>}
                    {j.installCheckinLat != null && j.installCheckinLng != null && (
                      <div className="muted">
                        <a href={`https://www.google.com/maps?q=${j.installCheckinLat},${j.installCheckinLng}`} target="_blank" rel="noreferrer">
                          📍 {j.installCheckinLat.toFixed(5)}, {j.installCheckinLng.toFixed(5)}
                        </a>
                      </div>
                    )}
                    {j.installNote && <div className="muted">📝 {j.installNote}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirmJob && (
        <Modal title={`ยืนยันติดตั้งเสร็จ — ${confirmJob.jobNo}`} onClose={() => setConfirmFor(null)}
          footer={<>
            <button onClick={() => setConfirmFor(null)}>ยกเลิก</button>
            <button className="success" disabled={submitting || !installedDate || !coords || !photo}
              title={!coords ? 'ต้อง Check-in ตำแหน่งก่อน' : !photo ? 'ต้องแนบรูปก่อน' : ''}
              onClick={submitConfirm}>
              {submitting ? 'กำลังบันทึก...' : 'ยืนยันติดตั้งเสร็จ'}
            </button>
          </>}>
          <p style={{ marginBottom: 12 }}>
            {confirmJob.customerName} · {confirmJob.installLocation || '-'} — หลังยืนยัน Job จะเป็นสถานะ <b>Installed</b> (terminal) และแจ้ง Project อัตโนมัติ
          </p>
          <label className="field"><span>วันที่ติดตั้งจริง *</span>
            <input type="date" value={installedDate} onChange={e => setInstalledDate(e.target.value)} />
          </label>

          <label className="field"><span>Check-in ตำแหน่งหน้างาน (GPS) *</span></label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <button type="button" onClick={captureLocation} disabled={locating}>
              {locating ? 'กำลังระบุ...' : coords ? '📍 ระบุตำแหน่งใหม่' : '📍 Check-in ตำแหน่ง'}
            </button>
            {coords
              ? <span className="badge green">{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</span>
              : <span className="muted">ยังไม่ได้ Check-in</span>}
          </div>

          <label className="field"><span>รูปถ่ายหน้างาน *</span>
            <input type="file" accept="image/*" capture="environment"
              onChange={e => pickPhoto(e.target.files?.[0])} />
          </label>
          {photo && <img src={photo.preview} alt="preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, marginBottom: 12, display: 'block' }} />}

          <label className="field"><span>บันทึกหน้างาน (ทีม/ผลการทดสอบ ฯลฯ)</span>
            <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="ทีม A ติดตั้ง + test energize ผ่าน" />
          </label>
        </Modal>
      )}
    </>
  )
}
