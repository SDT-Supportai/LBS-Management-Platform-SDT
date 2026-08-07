import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { jobInstallSummary, memberSchedule, jobTeam } from '../data/logic'
import { Modal, useConfirm, useTryAction } from '../ui/components'
import { fmtDate } from '../ui/format'
import type { TeamMember } from '../types'

const EMPTY_FORM = { firstName: '', lastName: '', phone: '', position: '', userId: '', isActive: true }

// ทะเบียนทีมช่าง + ตารางงานรายบุคคล (เฟส C)
// วันนัดติดตั้ง derive จาก Job — เลื่อนนัด (เฟส A) แล้วตารางนี้ขยับตามเอง
export default function ServiceSchedulingPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  const canManage = can(user, 'service.confirm')
  const [modal, setModal] = useState<'create' | 'edit' | null>(null)
  const [target, setTarget] = useState<TeamMember | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)

  const members = [...db.teamMembers].sort((a, b) =>
    Number(b.isActive) - Number(a.isActive) || a.firstName.localeCompare(b.firstName))
  const activeMembers = members.filter(m => m.isActive)
  const issuedJobs = db.jobs.filter(j => j.terminalStatus === 'issued')
  const unassigned = issuedJobs.filter(j => !db.jobAssignments.some(a => a.jobId === j.id))
  // user แผนก service ให้เลือกผูกบัญชี (คนที่ยังไม่ถูกผูก + คนที่ผูกกับ record นี้อยู่)
  const linkableUsers = db.users.filter(u =>
    (u.department === 'service' || u.department === 'admin') &&
    (!db.teamMembers.some(m => m.userId === u.id) || u.id === target?.userId))

  const openCreate = () => { setForm(EMPTY_FORM); setTarget(null); setModal('create') }
  const openEdit = (m: TeamMember) => {
    setForm({
      firstName: m.firstName, lastName: m.lastName, phone: m.phone,
      position: m.position, userId: m.userId ?? '', isActive: m.isActive,
    })
    setTarget(m); setModal('edit')
  }
  const submit = async () => {
    const payload = {
      firstName: form.firstName, lastName: form.lastName, phone: form.phone,
      position: form.position, userId: form.userId || undefined,
    }
    const ok = modal === 'create'
      ? await tryAction(() => act.createTeamMember(payload), 'เพิ่มช่างในทะเบียนแล้ว')
      : await tryAction(() => act.updateTeamMember({ ...payload, memberId: target!.id, isActive: form.isActive }), 'บันทึกข้อมูลช่างแล้ว')
    if (ok) setModal(null)
  }

  return (
    <>
      <div className="page-title">Service &amp; Scheduling</div>
      <div className="page-sub">
        ทะเบียนทีมช่างติดตั้ง + ตารางงานรายบุคคล — มอบหมายทีมได้ที่หน้า <Link to="/service">Service (Installation)</Link>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>ทะเบียนทีมช่าง ({activeMembers.length} คนที่ใช้งาน)</h3>
          {canManage && <button className="small" onClick={openCreate}>+ เพิ่มช่าง (Add Team Member)</button>}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ชื่อ - สกุล</th><th>เบอร์ติดต่อ</th><th>ตำแหน่ง</th><th>บัญชีในระบบ</th>
                <th>งานที่รับ</th><th>สถานะ</th>{canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {members.length === 0 && (
                <tr><td colSpan={canManage ? 7 : 6}><div className="empty">ยังไม่มีช่างในทะเบียน — กด "เพิ่มช่าง" เพื่อเริ่ม</div></td></tr>
              )}
              {members.map(m => {
                const s = memberSchedule(db, m.id)
                const linked = db.users.find(u => u.id === m.userId)
                return (
                  <tr key={m.id} style={{ opacity: m.isActive ? 1 : 0.55 }}>
                    <td><b>{m.firstName} {m.lastName}</b></td>
                    <td className="mono">{m.phone}</td>
                    <td>{m.position}</td>
                    <td className="muted">{linked ? linked.email : '— (ไม่มี login)'}</td>
                    <td>
                      <span className="badge blue">รอติดตั้ง {s.active.length}</span>{' '}
                      <span className="muted">ปิดแล้ว {s.doneCount} · ติดตั้ง {s.unitsInstalled} เครื่อง</span>
                    </td>
                    <td>{m.isActive
                      ? <span className="badge green">ใช้งาน</span>
                      : <span className="badge neutral">ปิดใช้งาน</span>}</td>
                    {canManage && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="small" style={{ marginRight: 6 }} onClick={() => openEdit(m)}>แก้ไข</button>
                        <button className="small danger"
                          onClick={async () => {
                            if (await askConfirm({
                              title: `ลบ ${m.firstName} ${m.lastName} ออกจากทะเบียนช่าง`,
                              description: <>ช่างคนนี้จะเลือกมอบหมายงานใหม่ไม่ได้อีก · <b>ประวัติการติดตั้งที่เคยบันทึกไว้ยังอยู่ครบ</b> · ระบบจะไม่ให้ลบถ้ายังถูกมอบหมายงานที่ค้างอยู่</>,
                              confirmLabel: 'ลบออกจากทะเบียน',
                            })) tryAction(() => act.deleteTeamMember({ memberId: m.id }), 'ลบช่างออกจากทะเบียนแล้ว')
                          }}>ลบ</button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {unassigned.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h3>⚠️ งานที่เบิกแล้วแต่ยังไม่มอบหมายทีม ({unassigned.length})</h3></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>นัดติดตั้ง</th><th>ติดตั้ง</th></tr></thead>
              <tbody>
                {unassigned.map(j => {
                  const s = jobInstallSummary(db, j.id)
                  return (
                    <tr key={j.id}>
                      <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                      <td>{j.customerName}<div className="muted">📍 {j.issueLocation || j.installLocation || '-'}</div></td>
                      <td>{j.installStartDate ? `${fmtDate(j.installStartDate)} – ${fmtDate(j.installEndDate)}` : '-'}</td>
                      <td><span className="badge neutral">{s.installed}/{s.total}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="page-sub" style={{ marginTop: 24, marginBottom: 8, fontWeight: 700, color: 'var(--text)' }}>
        ตารางงานรายบุคคล — งานที่เบิกแล้วรอติดตั้ง (เรียงตามวันนัด)
      </div>
      {activeMembers.length === 0 && (
        <div className="panel"><div className="empty">ยังไม่มีช่างที่ใช้งาน</div></div>
      )}
      {activeMembers.map(m => {
        const s = memberSchedule(db, m.id)
        return (
          <div className="panel" key={m.id}>
            <div className="panel-head">
              <h3>{m.firstName} {m.lastName} <span className="muted" style={{ fontWeight: 400 }}>· {m.position} · 📞 {m.phone}</span></h3>
              <span className="muted">
                {s.active.length > 0
                  ? <span className="badge blue">{s.active.length} งานรอติดตั้ง</span>
                  : <span className="badge green">ว่าง</span>}
              </span>
            </div>
            {s.active.length === 0
              ? <div className="empty">ไม่มีงานค้าง — ปิดงานแล้ว {s.doneCount} งาน · ติดตั้งไปทั้งหมด {s.unitsInstalled} เครื่อง</div>
              : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr><th>นัดติดตั้ง</th><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>บทบาท</th><th>ติดตั้ง</th></tr>
                    </thead>
                    <tbody>
                      {s.active.map(j => {
                        const sum = jobInstallSummary(db, j.id)
                        const mine = jobTeam(db, j.id).find(t => t.member.id === m.id)
                        return (
                          <tr key={j.id}>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {j.installStartDate ? <b>{fmtDate(j.installStartDate)}</b> : <span className="muted">ไม่ระบุ</span>}
                              {j.installEndDate && j.installEndDate !== j.installStartDate &&
                                <div className="muted">ถึง {fmtDate(j.installEndDate)}</div>}
                            </td>
                            <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                            <td>{j.customerName}<div className="muted">📍 {j.issueLocation || j.installLocation || '-'}</div></td>
                            <td>{mine?.assignment.isLead
                              ? <span className="badge amber">หัวหน้าทีม</span>
                              : <span className="muted">ช่างติดตั้ง</span>}</td>
                            <td>
                              <span className={`badge ${sum.canClose ? 'green' : sum.installed > 0 ? 'blue' : 'neutral'}`}>
                                {sum.installed}/{sum.total}
                              </span>
                              {sum.blocked > 0 && <div className="muted" style={{ color: 'var(--danger)' }}>ติดปัญหา {sum.blocked}</div>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        )
      })}

      {modal && (
        <Modal title={modal === 'create' ? 'เพิ่มช่างในทะเบียน' : `แก้ข้อมูลช่าง — ${target?.firstName} ${target?.lastName}`}
          onClose={() => setModal(null)}
          footer={<>
            <button onClick={() => setModal(null)}>ยกเลิก</button>
            <button className="success"
              disabled={!form.firstName.trim() || !form.lastName.trim() || !form.phone.trim() || !form.position.trim()}
              onClick={submit}>บันทึก</button>
          </>}>
          <div className="row">
            <label className="field"><span>ชื่อ *</span>
              <input value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} placeholder="ประสิทธิ์" />
            </label>
            <label className="field"><span>นามสกุล *</span>
              <input value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} placeholder="ใจดี" />
            </label>
          </div>
          <div className="row">
            <label className="field"><span>เบอร์ติดต่อ *</span>
              <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="081-234-5678" />
            </label>
            <label className="field"><span>ตำแหน่ง *</span>
              <input value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} placeholder="หัวหน้าช่าง / ช่างไฟฟ้า / ผู้ช่วยช่าง" />
            </label>
          </div>
          <label className="field"><span>ผูกกับบัญชีในระบบ (ถ้าช่างคนนี้มี login)</span>
            <select value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}>
              <option value="">— ไม่ผูก (ช่างภาคสนาม/outsource) —</option>
              {linkableUsers.map(u => <option key={u.id} value={u.id}>{u.fullName} · {u.email}</option>)}
            </select>
          </label>
          {modal === 'edit' && (
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={form.isActive}
                onChange={e => setForm({ ...form, isActive: e.target.checked })} />
              <span>ใช้งาน (ติ๊กออก = ปิดใช้งาน — ต้องไม่มีงานรอติดตั้งค้าง)</span>
            </label>
          )}
        </Modal>
      )}
      {confirmEl}
    </>
  )
}
