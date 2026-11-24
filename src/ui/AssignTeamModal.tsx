// =============================================================================
// มอบหมายทีมให้งาน — ใช้ร่วมหน้า Site Installation กับ Assignment & Schedule (เฟส 5 · 2026-11-23)
//   เดิมอยู่ในหน้า Service อย่างเดียว ⇒ หน้าตารางทีมต้องพาไปอีกหน้า · ย้ายมาเป็นชิ้นเดียวใช้สองที่
//   ส่งรายชื่อทั้งชุด (แทนที่ของเดิม) · ไม่เลือกใครเลย = ยกเลิกมอบหมาย (act.assignJobTeam)
// =============================================================================
import { useState } from 'react'
import { useStore } from '../data/StoreContext'
import { jobTeam } from '../data/logic'
import { Modal, useTryAction } from './components'
import { fmtDate } from './format'
import type { Job } from '../types'

export function AssignTeamModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const { db, act } = useStore()
  const tryAction = useTryAction()
  const team = jobTeam(db, job.id)
  const [ids, setIds] = useState<string[]>(() => team.map(t => t.member.id))
  const [lead, setLead] = useState(() => team.find(t => t.assignment.isLead)?.member.id ?? '')
  const activeMembers = db.teamMembers.filter(m => m.isActive)
    .sort((a, b) => a.firstName.localeCompare(b.firstName))
  const toggle = (id: string) => setIds(prev => {
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    if (!next.includes(lead)) setLead('')
    return next
  })
  const changed = ids.length !== team.length || ids.some(id => !team.some(t => t.member.id === id))
    || lead !== (team.find(t => t.assignment.isLead)?.member.id ?? '')
  const submit = async () => {
    const ok = await tryAction(
      () => act.assignJobTeam({ jobId: job.id, memberIds: ids, leadMemberId: lead || undefined }),
      ids.length === 0 ? 'ยกเลิกมอบหมายทีมแล้ว' : `มอบหมายทีม ${ids.length} คนแล้ว`)
    if (ok) onClose()
  }
  return (
    <Modal title={`มอบหมายทีม — ${job.jobNo}`} onClose={onClose} dirty={changed}
      footer={<>
        <button onClick={onClose}>ยกเลิก</button>
        <button className="success" onClick={submit} disabled={!changed}>
          {ids.length === 0 ? 'ยกเลิกมอบหมายทั้งหมด' : `บันทึก (${ids.length} คน)`}
        </button>
      </>}>
      <p className="muted" style={{ marginBottom: 12 }}>
        {job.customerName} · 📍 {job.issueLocation || job.installLocation || '-'}
        {job.installStartDate && <> · 📅 {fmtDate(job.installStartDate)} – {fmtDate(job.installEndDate)}</>}
      </p>
      {activeMembers.length === 0 ? (
        <div className="empty">ยังไม่มีช่างในทะเบียน — เพิ่มที่หน้า Assignment &amp; Schedule ก่อน</div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead><tr><th>เลือก</th><th>ชื่อ - สกุล</th><th>ตำแหน่ง / เบอร์</th><th>หัวหน้าทีม</th></tr></thead>
              <tbody>
                {activeMembers.map(m => (
                  <tr key={m.id} className="clickable" onClick={() => toggle(m.id)}>
                    <td><input type="checkbox" checked={ids.includes(m.id)} readOnly aria-label={`เลือก ${m.firstName}`} /></td>
                    <td><b>{m.firstName} {m.lastName}</b></td>
                    <td className="muted">{m.position} · <span className="mono">{m.phone}</span></td>
                    <td onClick={e => e.stopPropagation()}>
                      <input type="radio" name="lead" checked={lead === m.id} disabled={!ids.includes(m.id)}
                        onChange={() => setLead(m.id)} aria-label={`หัวหน้าทีม ${m.firstName}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            มอบหมายเป็น <b>แผนงาน</b> — ไม่ได้จำกัดสิทธิ์การยืนยันติดตั้ง (ผู้บันทึกในระบบยังเป็นบัญชีที่ login) ·
            ช่างที่ผูกบัญชีจะเห็นงานนี้ใน "งานของฉันวันนี้"
          </p>
        </>
      )}
    </Modal>
  )
}
