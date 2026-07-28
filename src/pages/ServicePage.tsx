import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { deriveJobStatus, jobInstallSummary, unitInstallState } from '../data/logic'
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
  // หลักฐานต่อเครื่อง (เฟส B) — วันที่ / GPS / รูป
  const [installedDate, setInstalledDate] = useState('')
  const [note, setNote] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = useState(false)
  const [photo, setPhoto] = useState<{ file: File; preview: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // modal รายเครื่องของ Job + ขั้นตอนย่อย (ยืนยัน / ติดตั้งไม่ได้)
  const [unitJobId, setUnitJobId] = useState<string | null>(null)
  const [step, setStep] = useState<{ unitId: string; mode: 'confirm' | 'block' } | null>(null)
  const [blockReason, setBlockReason] = useState('')
  // ปิดงานติดตั้ง
  const [closeFor, setCloseFor] = useState<string | null>(null)
  const [closeNote, setCloseNote] = useState('')
  // เลื่อน/ติดปัญหาหน้างาน (เฟส A)
  const [visitFor, setVisitFor] = useState<string | null>(null)
  const [visitOutcome, setVisitOutcome] = useState<'rescheduled' | 'failed'>('rescheduled')
  const [visitReason, setVisitReason] = useState('')
  const [visitStart, setVisitStart] = useState('')
  const [visitEnd, setVisitEnd] = useState('')

  const ready = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue')
  const issued = db.jobs.filter(j => j.terminalStatus === 'issued')
  const installed = db.jobs.filter(j => j.terminalStatus === 'installed')

  const unitsOf = (jobId: string) => db.lbsUnits.filter(u => u.jobId === jobId)
  const accOf = (jobId: string) => db.accessoryRequests.filter(r =>
    r.jobId === jobId && (r.status === 'issued' || r.status === 'received'))
  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const userOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  // เหตุผลที่ปิดงานยังไม่ได้ (ใช้เป็น tooltip) — '' = ปิดได้
  const closeBlockedReason = (s: ReturnType<typeof jobInstallSummary>) =>
    s.total === 0 ? 'ไม่มีเครื่องที่เบิกไว้'
      : s.pending > 0 ? `ต้องได้ข้อสรุปทุกเครื่องก่อน (เหลือ ${s.pending} เครื่อง)`
      : s.installed === 0 ? 'ต้องมีเครื่องที่ติดตั้งสำเร็จอย่างน้อย 1 เครื่อง'
      : ''
  // แถวยืนยันล่าสุดของเครื่อง (ใช้โชว์หลักฐาน/เหตุผล)
  const lastInstallRow = (unitId: string) =>
    db.unitInstallations.filter(r => r.unitId === unitId)
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0]

  const unitJob = unitJobId ? db.jobs.find(j => j.id === unitJobId) : null
  const stepUnit = step ? db.lbsUnits.find(u => u.id === step.unitId) : null
  const closeJob = closeFor ? db.jobs.find(j => j.id === closeFor) : null
  const visitJob = visitFor ? db.jobs.find(j => j.id === visitFor) : null
  // ประวัติออกหน้างานล่าสุดต่อ Job (ใหม่สุด)
  const lastVisit = (jobId: string) =>
    db.siteVisits.filter(v => v.jobId === jobId).sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0]

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
  const resolvePhotoUrl = async (jobId: string, unitId: string): Promise<string> => {
    if (!photo) throw new Error('ต้องแนบรูปถ่ายของเครื่องนี้ก่อนยืนยัน')
    if (!supabase) return photo.preview
    const ext = (photo.file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${jobId}/${unitId}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('install-photos').upload(path, photo.file, { upsert: false })
    if (error) throw new Error(`อัปโหลดรูปไม่สำเร็จ: ${error.message} (ตรวจว่าสร้าง bucket install-photos แล้ว)`)
    return supabase.storage.from('install-photos').getPublicUrl(path).data.publicUrl
  }

  // เปิดฟอร์มยืนยันเครื่อง — reset หลักฐานทุกครั้ง (หลักฐานต่อเครื่อง ห้ามใช้ซ้ำ)
  const openUnitConfirm = (unitId: string) => {
    setInstalledDate(new Date().toISOString().slice(0, 10))
    setNote(''); setCoords(null); setPhoto(null)
    setStep({ unitId, mode: 'confirm' })
  }
  const openUnitBlock = (unitId: string) => { setBlockReason(''); setStep({ unitId, mode: 'block' }) }
  const backToList = () => { setStep(null); setCoords(null); setPhoto(null) }

  const submitUnitConfirm = async () => {
    if (!step || !unitJobId || !coords || !photo) return
    setSubmitting(true)
    try {
      const photoUrl = await resolvePhotoUrl(unitJobId, step.unitId)
      const ok = await tryAction(
        () => act.confirmUnitInstall({
          unitId: step.unitId, installedDate, note,
          checkinLat: coords.lat, checkinLng: coords.lng, photoUrl,
        }),
        `ยืนยันติดตั้ง ${stepUnit?.serialLvb ?? ''} แล้ว`)
      if (ok) backToList()
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
    setSubmitting(false)
  }

  const submitUnitBlock = async () => {
    if (!step) return
    const ok = await tryAction(
      () => act.blockUnitInstall({ unitId: step.unitId, reason: blockReason }),
      `บันทึกว่า ${stepUnit?.serialLvb ?? ''} ติดตั้งไม่ได้ + แจ้ง Project แล้ว`)
    if (ok) backToList()
  }

  const submitClose = async () => {
    if (!closeFor) return
    const ok = await tryAction(() => act.closeJobInstall({ jobId: closeFor, note: closeNote }),
      'ปิดงานติดตั้งแล้ว — แจ้ง Project อัตโนมัติ')
    if (ok) { setCloseFor(null); setUnitJobId(null) }
  }

  const openVisit = (jobId: string) => {
    setVisitOutcome('rescheduled'); setVisitReason(''); setVisitStart(''); setVisitEnd(''); setVisitFor(jobId)
  }
  const submitVisit = async () => {
    if (!visitFor) return
    const ok = await tryAction(
      () => act.logSiteVisit({
        jobId: visitFor, outcome: visitOutcome, reason: visitReason,
        newStartDate: visitOutcome === 'rescheduled' ? visitStart : undefined,
        newEndDate: visitOutcome === 'rescheduled' ? (visitEnd || visitStart) : undefined,
      }),
      visitOutcome === 'rescheduled' ? 'บันทึกเลื่อนนัด + แจ้ง Project แล้ว' : 'บันทึกปัญหาหน้างาน + แจ้ง Project แล้ว')
    if (ok) setVisitFor(null)
  }

  return (
    <>
      <div className="page-title">Service (Installation)</div>
      <div className="page-sub">
        รับงานที่เบิกแล้ว → เข้าติดตั้งหน้างาน → ยืนยัน<b>รายเครื่อง</b> (Check-in GPS + รูปถ่าย ต่อเครื่อง) → ปิดงาน
      </div>

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
            <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ของที่เบิก</th><th>ติดตั้ง</th><th></th></tr></thead>
            <tbody>
              {issued.length === 0 && <tr><td colSpan={5}><div className="empty">ไม่มีงานรอติดตั้ง</div></td></tr>}
              {issued.map(j => {
                const s = jobInstallSummary(db, j.id)
                return (
                  <tr key={j.id}>
                    <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                    <td>{j.customerName}
                      <div className="muted">
                        📍 {j.issueLocation || j.installLocation || '-'}
                        {j.installStartDate && <> · 📅 นัดติดตั้ง <b>{fmtDate(j.installStartDate)} – {fmtDate(j.installEndDate)}</b></>}
                      </div>
                      {j.issuedNote && <div className="muted">📝 {j.issuedNote}</div>}
                      {(() => { const v = lastVisit(j.id); return v && (
                        <div className="muted" style={{ color: v.outcome === 'failed' ? 'var(--danger)' : undefined }}>
                          {v.outcome === 'rescheduled' ? '⏰ เลื่อนนัดแล้ว' : '⚠️ ติดปัญหา'}: {v.reason}
                        </div>
                      )})()}</td>
                    <td>
                      <div>LBS {unitsOf(j.id).length} เครื่อง <span className="muted mono">({unitsOf(j.id).map(u => u.serialLvb).join(', ')})</span></div>
                      {accOf(j.id).map(r => {
                        const it = itemOf(r.itemId)!
                        return <div key={r.id} className="muted">{it.name} × {r.qtyRequested} {it.uom}</div>
                      })}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={`badge ${s.canClose ? 'green' : s.installed > 0 ? 'blue' : 'neutral'}`}>
                        {s.installed}/{s.total} เครื่อง
                      </span>
                      {s.blocked > 0 && <div className="muted" style={{ color: 'var(--danger)' }}>ติดตั้งไม่ได้ {s.blocked}</div>}
                      <div className="muted">เบิก {fmtDateTime(j.issuedAt)}</div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canConfirm && (
                        <>
                          <button className="small" style={{ marginRight: 6 }}
                            onClick={() => { setStep(null); setUnitJobId(j.id) }}>
                            🔧 ยืนยันรายเครื่อง
                          </button>
                          <button className="small success" style={{ marginRight: 6 }}
                            disabled={!s.canClose} title={closeBlockedReason(s)}
                            onClick={() => { setCloseNote(''); setCloseFor(j.id) }}>
                            🏁 ปิดงาน
                          </button>
                          <button className="small" onClick={() => openVisit(j.id)}>เลื่อน/ติดปัญหา</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>ติดตั้งเสร็จแล้ว ({installed.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ปิดงานเมื่อ</th><th>ยืนยันโดย</th><th>หลักฐานรายเครื่อง</th></tr></thead>
            <tbody>
              {installed.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่มีงานติดตั้งเสร็จ</div></td></tr>}
              {installed.map(j => {
                const s = jobInstallSummary(db, j.id)
                return (
                  <tr key={j.id}>
                    <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                    <td>{j.customerName}<div className="muted">{j.installLocation}</div></td>
                    <td>{fmtDate(j.installedAt)}
                      <div className="muted">{s.installed}/{s.total} เครื่อง{s.blocked > 0 ? ` · ติดปัญหา ${s.blocked}` : ''}</div>
                    </td>
                    <td>{userOf(j.installConfirmedBy)}</td>
                    <td>
                      {unitsOf(j.id).map(u => {
                        const r = lastInstallRow(u.id)
                        if (!r) return <div key={u.id} className="muted mono">{u.serialLvb} —</div>
                        if (r.outcome === 'blocked') return (
                          <div key={u.id} className="muted" style={{ color: 'var(--danger)' }}>
                            <span className="mono">{u.serialLvb}</span> ⚠️ {r.reason}
                          </div>
                        )
                        return (
                          <div key={u.id} className="muted">
                            <span className="mono">{u.serialLvb}</span>{' '}
                            {r.photoUrl && <a href={r.photoUrl} target="_blank" rel="noreferrer">🖼️</a>}{' '}
                            {r.checkinLat != null && r.checkinLng != null && (
                              <a href={`https://www.google.com/maps?q=${r.checkinLat},${r.checkinLng}`} target="_blank" rel="noreferrer">
                                📍 {r.checkinLat.toFixed(5)}, {r.checkinLng.toFixed(5)}
                              </a>
                            )}
                          </div>
                        )
                      })}
                      {j.installNote && <div className="muted">📝 {j.installNote}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* modal รายเครื่อง — step null = รายการ, step = ฟอร์มยืนยัน/ติดตั้งไม่ได้ */}
      {unitJob && !step && (() => {
        const s = jobInstallSummary(db, unitJob.id)
        return (
          <Modal title={`ยืนยันติดตั้งรายเครื่อง — ${unitJob.jobNo}`} onClose={() => setUnitJobId(null)}
            footer={<>
              <button onClick={() => setUnitJobId(null)}>ปิด</button>
              <button className="success" disabled={!s.canClose} title={closeBlockedReason(s)}
                onClick={() => { setUnitJobId(null); setCloseNote(''); setCloseFor(unitJob.id) }}>
                🏁 ปิดงาน ({s.installed}/{s.total})
              </button>
            </>}>
            <p className="muted" style={{ marginBottom: 12 }}>
              {unitJob.customerName} · 📍 {unitJob.issueLocation || unitJob.installLocation || '-'} — ยืนยันทีละเครื่อง
              พร้อม Check-in GPS + รูปถ่ายของเครื่องนั้น ๆ
            </p>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Serial (LVB / OM)</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {unitsOf(unitJob.id).map(u => {
                    const st = unitInstallState(db, u.id)
                    const r = lastInstallRow(u.id)
                    return (
                      <tr key={u.id}>
                        <td className="mono">{u.serialLvb}<div className="muted mono">{u.serialOm}</div></td>
                        <td>
                          {st === 'installed' && <span className="badge green">✅ ติดตั้งแล้ว {fmtDate(r?.installedDate)}</span>}
                          {st === 'blocked' && <><span className="badge red">⚠️ ติดตั้งไม่ได้</span><div className="muted">{r?.reason}</div></>}
                          {st === 'pending' && <span className="badge neutral">รอติดตั้ง</span>}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {st !== 'installed' && (
                            <>
                              <button className="small success" style={{ marginRight: 6 }}
                                onClick={() => openUnitConfirm(u.id)}>
                                {st === 'blocked' ? 'ยืนยันใหม่' : '✅ ยืนยันติดตั้ง'}
                              </button>
                              {st === 'pending' && (
                                <button className="small danger" onClick={() => openUnitBlock(u.id)}>ติดตั้งไม่ได้</button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Modal>
        )
      })()}

      {/* ฟอร์มยืนยันเครื่อง — บังคับ วันที่ + GPS + รูป ต่อเครื่อง */}
      {unitJob && stepUnit && step?.mode === 'confirm' && (
        <Modal title={`ยืนยันติดตั้ง — ${stepUnit.serialLvb}`} onClose={backToList}
          footer={<>
            <button onClick={backToList}>← กลับรายการ</button>
            <button className="success" disabled={submitting || !installedDate || !coords || !photo}
              title={!coords ? 'ต้อง Check-in ตำแหน่งก่อน' : !photo ? 'ต้องแนบรูปก่อน' : ''}
              onClick={submitUnitConfirm}>
              {submitting ? 'กำลังบันทึก...' : 'ยืนยันเครื่องนี้'}
            </button>
          </>}>
          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="panel-body">
              <b>ตรวจ Serial ให้ตรงกับเครื่องหน้างาน</b>
              <div className="mono">LVB: {stepUnit.serialLvb}</div>
              <div className="mono">OM: {stepUnit.serialOm}</div>
              <div className="muted">{unitJob.jobNo} · {unitJob.customerName}</div>
            </div>
          </div>
          <label className="field"><span>วันที่ติดตั้งจริง *</span>
            <input type="date" value={installedDate} onChange={e => setInstalledDate(e.target.value)} />
          </label>

          <label className="field"><span>Check-in ตำแหน่งของเครื่องนี้ (GPS) *</span></label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <button type="button" onClick={captureLocation} disabled={locating}>
              {locating ? 'กำลังระบุ...' : coords ? '📍 ระบุตำแหน่งใหม่' : '📍 Check-in ตำแหน่ง'}
            </button>
            {coords
              ? <span className="badge green">{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</span>
              : <span className="muted">ยังไม่ได้ Check-in</span>}
          </div>

          <label className="field"><span>รูปถ่ายเครื่องนี้หน้างาน *</span>
            <input type="file" accept="image/*" capture="environment"
              onChange={e => pickPhoto(e.target.files?.[0])} />
          </label>
          {photo && <img src={photo.preview} alt="preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, marginBottom: 12, display: 'block' }} />}

          <label className="field"><span>บันทึกของเครื่องนี้ (ทีม/ผลการทดสอบ ฯลฯ)</span>
            <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="ทีม A ติดตั้ง + test energize ผ่าน" />
          </label>
        </Modal>
      )}

      {/* ฟอร์มติดตั้งไม่ได้ */}
      {stepUnit && step?.mode === 'block' && (
        <Modal title={`ติดตั้งไม่ได้ — ${stepUnit.serialLvb}`} onClose={backToList}
          footer={<>
            <button onClick={backToList}>← กลับรายการ</button>
            <button className="danger" disabled={!blockReason.trim()} onClick={submitUnitBlock}>
              บันทึก + แจ้ง Project
            </button>
          </>}>
          <p className="muted" style={{ marginBottom: 12 }}>
            เครื่อง <span className="mono">{stepUnit.serialLvb}</span> ติดตั้งไม่ได้ — Project จะได้รับแจ้งทันทีเพื่อหาทางแก้
            (ยืนยันใหม่ได้ภายหลังถ้าแก้ปัญหาได้)
          </p>
          <label className="field"><span>เหตุผล *</span>
            <textarea rows={3} value={blockReason} onChange={e => setBlockReason(e.target.value)}
              placeholder="เช่น เครื่องเสียหายจากการขนส่ง / จุดติดตั้งยังไม่เดินสายเมน" />
          </label>
        </Modal>
      )}

      {/* ปิดงานติดตั้ง */}
      {closeJob && (() => {
        const s = jobInstallSummary(db, closeJob.id)
        return (
          <Modal title={`ปิดงานติดตั้ง — ${closeJob.jobNo}`} onClose={() => setCloseFor(null)}
            footer={<>
              <button onClick={() => setCloseFor(null)}>ยกเลิก</button>
              <button className="success" onClick={submitClose}>ยืนยันปิดงาน</button>
            </>}>
            <p style={{ marginBottom: 12 }}>
              ติดตั้งสำเร็จ <b>{s.installed}/{s.total}</b> เครื่อง
              {s.blocked > 0 && <span style={{ color: 'var(--danger)' }}> · ติดตั้งไม่ได้ {s.blocked} เครื่อง</span>}
              <br />
              หลังปิดงาน Job จะเป็นสถานะ <b>Installed</b> (terminal) และแจ้ง Project อัตโนมัติ
            </p>
            {s.blocked > 0 && (
              <div className="panel" style={{ marginBottom: 12 }}>
                <div className="panel-body" style={{ color: 'var(--danger)' }}>
                  ⚠️ ยังมีเครื่องที่ติดตั้งไม่ได้ {s.blocked} เครื่อง — ปิดงานได้ แต่จะถูกบันทึกไว้ในประวัติและแจ้ง Project
                </div>
              </div>
            )}
            <label className="field"><span>บันทึกสรุปงาน (ถ้ามี)</span>
              <textarea rows={2} value={closeNote} onChange={e => setCloseNote(e.target.value)}
                placeholder="เช่น ส่งมอบลูกค้าเรียบร้อย รอเอกสารรับรอง" />
            </label>
          </Modal>
        )
      })()}

      {visitJob && (
        <Modal title={`ออกหน้างานยังไม่จบ — ${visitJob.jobNo}`} onClose={() => setVisitFor(null)}
          footer={<>
            <button onClick={() => setVisitFor(null)}>ยกเลิก</button>
            <button className="success"
              disabled={!visitReason.trim() || (visitOutcome === 'rescheduled' && !visitStart)}
              onClick={submitVisit}>บันทึก + แจ้ง Project</button>
          </>}>
          <p className="muted" style={{ marginBottom: 12 }}>
            {visitJob.customerName} · {visitJob.issueLocation || visitJob.installLocation || '-'} — งานยังคงสถานะ <b>Issued</b> (ไม่ปิดงาน)
          </p>
          <label className="field"><span>ผลการออกหน้างาน *</span>
            <select value={visitOutcome} onChange={e => setVisitOutcome(e.target.value as 'rescheduled' | 'failed')}>
              <option value="rescheduled">⏰ เลื่อนนัดติดตั้ง (มีวันนัดใหม่)</option>
              <option value="failed">⚠️ ติดปัญหาหน้างาน (ยังไม่มีนัดใหม่)</option>
            </select>
          </label>
          {visitOutcome === 'rescheduled' && (
            <div className="row">
              <label className="field"><span>วันนัดใหม่ (เริ่ม) *</span>
                <input type="date" value={visitStart} onChange={e => setVisitStart(e.target.value)} />
              </label>
              <label className="field"><span>ถึง (เว้นว่าง = วันเดียว)</span>
                <input type="date" value={visitEnd} onChange={e => setVisitEnd(e.target.value)} />
              </label>
            </div>
          )}
          <label className="field"><span>เหตุผล / รายละเอียดหน้างาน *</span>
            <textarea rows={3} value={visitReason} onChange={e => setVisitReason(e.target.value)}
              placeholder={visitOutcome === 'rescheduled' ? 'เช่น ลูกค้าขอเลื่อน ยังไม่พร้อมหน้างาน' : 'เช่น จุดติดตั้งยังไม่เดินสายเมน รอผู้รับเหมา'} />
          </label>
        </Modal>
      )}
    </>
  )
}
