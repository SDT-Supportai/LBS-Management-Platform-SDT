import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { deriveJobStatus } from '../data/logic'
import { Modal, useTryAction } from '../ui/components'
import { fmtDate, fmtDateTime } from '../ui/format'

export default function ServicePage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const canConfirm = can(user, 'service.confirm')
  const [confirmFor, setConfirmFor] = useState<string | null>(null)
  const [installedDate, setInstalledDate] = useState('')
  const [note, setNote] = useState('')

  const ready = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue')
  const issued = db.jobs.filter(j => j.terminalStatus === 'issued')
  const installed = db.jobs.filter(j => j.terminalStatus === 'installed')

  const unitsOf = (jobId: string) => db.lbsUnits.filter(u => u.jobId === jobId)
  const accOf = (jobId: string) => db.accessoryRequests.filter(r =>
    r.jobId === jobId && (r.status === 'issued' || r.status === 'received'))
  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const userOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  const confirmJob = confirmFor ? db.jobs.find(j => j.id === confirmFor) : null
  const submitConfirm = async () => {
    if (!confirmFor) return
    if (await tryAction(() => act.confirmInstall({ jobId: confirmFor, installedDate, note }),
      'ยืนยันติดตั้งเสร็จแล้ว — แจ้ง Project Dept อัตโนมัติ')) {
      setConfirmFor(null); setInstalledDate(''); setNote('')
    }
  }

  return (
    <>
      <div className="page-title">Service — งานติดตั้ง</div>
      <div className="page-sub">รับงานจาก Project Dept → เข้าติดตั้งตาม Scope/สถานที่/วันที่ → ยืนยัน "ติดตั้งเสร็จ" พร้อมวันที่จริง</div>

      <div className="panel">
        <div className="panel-head"><h3>รอ Project Dept เบิกให้ ({ready.length})</h3></div>
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
                  <td>{j.customerName}<div className="muted">{j.installLocation} · กำหนด {fmtDate(j.requiredDate)}</div>
                    {j.issuedNote && <div className="muted">📝 {j.issuedNote}</div>}</td>
                  <td>
                    <div>LBS {unitsOf(j.id).length} เครื่อง <span className="muted mono">({unitsOf(j.id).map(u => u.serialNo).join(', ')})</span></div>
                    {accOf(j.id).map(r => {
                      const it = itemOf(r.itemId)!
                      return <div key={r.id} className="muted">{it.name} × {r.qtyRequested} {it.uom}</div>
                    })}
                  </td>
                  <td className="muted">{fmtDateTime(j.issuedAt)}</td>
                  <td>
                    {canConfirm && (
                      <button className="small success" onClick={() => {
                        setInstalledDate(new Date().toISOString().slice(0, 10)); setNote(''); setConfirmFor(j.id)
                      }}>ยืนยันติดตั้งเสร็จ</button>
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
            <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ติดตั้งเสร็จเมื่อ</th><th>ยืนยันโดย</th><th>บันทึก</th></tr></thead>
            <tbody>
              {installed.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่มีงานติดตั้งเสร็จ</div></td></tr>}
              {installed.map(j => (
                <tr key={j.id}>
                  <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                  <td>{j.customerName}<div className="muted">{j.installLocation}</div></td>
                  <td>{fmtDate(j.installedAt)}</td>
                  <td>{userOf(j.installConfirmedBy)}</td>
                  <td className="muted">{j.installNote || '-'}</td>
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
            <button className="success" onClick={submitConfirm}>ยืนยันติดตั้งเสร็จ</button>
          </>}>
          <p style={{ marginBottom: 10 }}>
            {confirmJob.customerName} · {confirmJob.installLocation || '-'} — หลังยืนยัน Job จะเป็นสถานะ <b>Installed</b> (terminal)
            และแจ้ง Project Dept อัตโนมัติ
          </p>
          <label className="field"><span>วันที่ติดตั้งจริง *</span>
            <input type="date" value={installedDate} onChange={e => setInstalledDate(e.target.value)} />
          </label>
          <label className="field"><span>บันทึกหน้างาน (ทีม/ผลการทดสอบ ฯลฯ)</span>
            <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="ทีม A ติดตั้ง + test energize ผ่าน" />
          </label>
        </Modal>
      )}
    </>
  )
}
