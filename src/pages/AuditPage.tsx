import { useState } from 'react'
import { useStore } from '../data/StoreContext'
import { fmtDateTime } from '../ui/format'

export default function AuditPage() {
  const { db } = useStore()
  const [q, setQ] = useState('')
  const [actor, setActor] = useState('')

  const logs = db.auditLogs.filter(a =>
    (!actor || a.actorId === actor) &&
    (!q || a.detail.toLowerCase().includes(q.toLowerCase()) || a.action.includes(q.toLowerCase())))

  const userOf = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  return (
    <>
      <div className="page-title">Audit Log</div>
      <div className="page-sub">ทุก transaction ถูกบันทึก: ใคร ทำอะไร เมื่อไหร่ จำนวนเท่าไหร่ Stock/Job ไหน — trace ย้อนหลังได้ทั้งหมด</div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <input style={{ maxWidth: 320 }} placeholder="ค้นหา (Job No., Serial, รายการ...)" value={q} onChange={e => setQ(e.target.value)} />
        <select style={{ width: 'auto' }} value={actor} onChange={e => setActor(e.target.value)}>
          <option value="">ทุกคน</option>
          {db.users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </select>
      </div>

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead><tr><th>เวลา</th><th>ผู้ทำรายการ</th><th>Action</th><th>รายละเอียด</th></tr></thead>
            <tbody>
              {logs.length === 0 && <tr><td colSpan={4}><div className="empty">ไม่พบรายการ</div></td></tr>}
              {logs.map(a => (
                <tr key={a.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{userOf(a.actorId)}</td>
                  <td><span className="badge neutral mono">{a.action}</span></td>
                  <td>{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
