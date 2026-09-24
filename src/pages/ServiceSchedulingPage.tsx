import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { jobDelivery, jobInstallSummary, jobIsFieldActive, memberSchedule, jobTeam } from '../data/logic'
import { DeliveryBadge, Modal, useConfirm, useTryAction } from '../ui/components'
import { fmtDate } from '../ui/format'
import type { TeamMember } from '../types'

const EMPTY_FORM = { firstName: '', lastName: '', phone: '', position: '', userId: '', isActive: true }

/**
 * ป้ายสรุปงานในมือช่าง — ใช้ทั้งตารางทะเบียนและตารางงานรายบุคคล **ตัวเดียวกัน**
 * 🔴 ห้ามเรียกงานในมือทั้งก้อนว่า "รอติดตั้ง" — งานที่ติดตั้งครบแล้วรอแค่กดปิดงาน
 *    ก็ยังอยู่ในมือช่าง ถ้าเหมารวมป้ายจะขัดกับสถานะของใบนั้นเองที่เขียนว่า "รอปิดงาน"
 *    (ผู้ใช้จับได้ 2026-09-22) · ยอดแต่ละก้อนมาจาก state ของ jobDelivery ชุดเดียวกับป้ายในตาราง
 */
function WorkloadChips({ s }: { s: ReturnType<typeof memberSchedule> }) {
  if (s.active.length === 0) return <span className="badge neutral">ว่าง</span>
  return (
    <>
      {s.blockedJobs > 0 && <span className="badge red">ติดปัญหา {s.blockedJobs}</span>}
      {s.pendingInstall > 0 && <span className="badge blue" style={{ marginLeft: s.blockedJobs > 0 ? 6 : 0 }}>รอติดตั้ง {s.pendingInstall}</span>}
      {s.awaitingClose > 0 && (
        <span className="badge green" style={{ marginLeft: s.blockedJobs + s.pendingInstall > 0 ? 6 : 0 }}
          title="ติดตั้งครบแล้ว เหลือกดปิดงานที่หน้า Service (Installation)">รอปิดงาน {s.awaitingClose}</span>
      )}
      {s.awaitingIssueRest > 0 && (
        <span className="badge amber" style={{ marginLeft: s.blockedJobs + s.pendingInstall + s.awaitingClose > 0 ? 6 : 0 }}
          title="ติดตั้งครบแล้ว แต่ใบยังเบิกของไม่ครบ — รอ Project เบิก/เคลียร์ของที่เหลือก่อนปิดงาน">
          รอ Project เบิกของ {s.awaitingIssueRest}
        </span>
      )}
    </>
  )
}

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
  // แยก "คนที่มีงานค้าง" ออกจาก "คนว่าง" แล้วเรียงคนมีงานตามวันนัดที่ใกล้ที่สุด
  //   ⇒ หัวตารางคือคิวที่ต้องจัดการจริง · คนว่างไปรวมท้ายตารางเป็นบรรทัดเดียว
  const memberRows = activeMembers.map(m => ({ m, s: memberSchedule(db, m.id) }))
  const firstVisit = (x: typeof memberRows[number]) =>
    x.s.active[0]?.installStartDate ?? '9999-12-31'
  const busyMembers = memberRows.filter(x => x.s.active.length > 0)
    .sort((a, b) => firstVisit(a).localeCompare(firstVisit(b)))
  const freeMembers = memberRows.filter(x => x.s.active.length === 0)
  // 0071: รวมงานที่เบิกบางส่วน — ของออกไปแล้วต้องมีทีมรับผิดชอบ ไม่ใช่รอจนใบครบ
  const issuedJobs = db.jobs.filter(j => jobIsFieldActive(db, j))
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
          {/* ทะเบียน = ตารางอ่านอย่างเดียว ใช้ความหนาแน่นชุดเดียวกับตารางข้อมูลอื่นในระบบ
              (ไม่ใส่ fixed-cols เพราะไม่มี colgroup — จะกลายเป็นทุกคอลัมน์กว้างเท่ากัน) */}
          <table className="dense">
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
                    {/* nowrap 3 ช่องนี้ — ชื่อคน/เบอร์/ตัวเลขสรุป ถูกตัดขึ้นบรรทัดใหม่แล้วอ่านยาก
                        และทำให้ทุกแถวสูงขึ้นทั้งตาราง · ตารางแคบเกินให้เลื่อนแนวนอนแทน */}
                    <td style={{ whiteSpace: 'nowrap' }}><b>{m.firstName} {m.lastName}</b></td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{m.phone}</td>
                    <td>{m.position}</td>
                    <td className="muted">{linked ? linked.email : '— (ไม่มี login)'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <WorkloadChips s={s} />{' '}
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
            <table className="dense">
              <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>นัดติดตั้ง</th><th>สถานะกำหนดส่ง</th><th>ติดตั้ง</th></tr></thead>
              <tbody>
                {unassigned.map(j => {
                  const s = jobInstallSummary(db, j.id)
                  return (
                    <tr key={j.id}>
                      <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                      <td>{j.customerName}<div className="muted">📍 {j.issueLocation || j.installLocation || '-'}</div></td>
                      {/* "นัดติดตั้ง" = วันที่ทีมจะออกไซต์ · คนละตัวกับกำหนดส่งตามสัญญา (0075)
                          ตารางนี้จึงต้องมีทั้งคู่ ไม่งั้นคนจัดคิวจะไม่รู้ว่าใบไหนเลยกำหนดไปแล้ว */}
                      <td>{j.installStartDate ? `${fmtDate(j.installStartDate)} – ${fmtDate(j.installEndDate)}` : '-'}</td>
                      <td><DeliveryBadge d={jobDelivery(db, j)} /></td>
                      <td><span className="badge neutral">{s.installed}/{s.total}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 🔴 ตารางเดียวสำหรับทุกคน · ช่างเป็น "แถวหัวกลุ่ม" (2026-09-22)
          เดิมเป็น 1 panel + 1 ตารางต่อช่าง 1 คน ⇒ หัวตารางซ้ำทุกคน · คอลัมน์เหลื่อมกัน
          เพราะแต่ละตารางคำนวณความกว้างเอง · และช่างที่ว่างยังกินพื้นที่คนละแผงเต็ม ๆ
          เรียง "คนที่มีงาน" ขึ้นก่อน แล้วค่อยคนว่าง — หัวตารางคือสิ่งที่ต้องลงมือ */}
      <div className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h3>ตารางงานรายบุคคล
            <span className="muted" style={{ fontWeight: 400 }}> · งานที่ของออกไปแล้วและยังไม่ปิด (เรียงตามวันนัด)</span>
          </h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {busyMembers.length > 0 && <span className="badge blue">มีงาน {busyMembers.length} คน</span>}
            {freeMembers.length > 0 && <span className="badge green">ว่าง {freeMembers.length} คน</span>}
          </div>
        </div>
        {activeMembers.length === 0
          ? <div className="empty">ยังไม่มีช่างที่ใช้งาน</div>
          : (
            <div className="table-scroll">
              <table className="grid dense fixed-cols">
                <colgroup>
                  <col style={{ width: 130 }} />{/* นัดติดตั้ง */}
                  <col style={{ width: 140 }} />{/* Job No. */}
                  <col />{/* ลูกค้า / สถานที่ */}
                  <col style={{ width: 230 }} />{/* สถานะกำหนดส่ง */}
                  <col style={{ width: 110 }} />{/* บทบาท */}
                  <col style={{ width: 95 }} />{/* ติดตั้ง */}
                </colgroup>
                <thead><tr>
                  <th>นัดติดตั้ง</th><th>Job No.</th><th>ลูกค้า / สถานที่</th>
                  <th>สถานะกำหนดส่ง</th><th>บทบาท</th><th style={{ textAlign: 'right' }}>ติดตั้ง</th>
                </tr></thead>
                {[...busyMembers, ...freeMembers].map(({ m, s }) => (
                  <tbody key={m.id}>
                    <tr className="group-row">
                      <td colSpan={6}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <b>{m.firstName} {m.lastName}</b>
                          <span className="muted">{m.position} · 📞 {m.phone}</span>
                          <WorkloadChips s={s} />
                          {/* สถิติสะสมย้ายมาอยู่บรรทัดเดียวกับชื่อ — เดิมกินพื้นที่ทั้งแผงเมื่อช่างว่าง */}
                          <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                            ปิดงานแล้ว {s.doneCount} งาน · ติดตั้งสะสม {s.unitsInstalled} เครื่อง
                          </span>
                        </div>
                      </td>
                    </tr>
                    {s.active.map(j => {
                      const sum = jobInstallSummary(db, j.id)
                      const mine = jobTeam(db, j.id).find(t => t.member.id === m.id)
                      return (
                        <tr key={j.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {j.installStartDate ? <b>{fmtDate(j.installStartDate)}</b> : <span className="muted">ไม่ระบุ</span>}
                            {j.installEndDate && j.installEndDate !== j.installStartDate &&
                              <div className="muted" style={{ fontSize: 11 }}>ถึง {fmtDate(j.installEndDate)}</div>}
                          </td>
                          <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                          <td>{j.customerName}<div className="muted" style={{ fontSize: 11 }}>📍 {j.issueLocation || j.installLocation || '-'}</div></td>
                          {/* คนจัดคิวต้องเห็นว่าใบไหนเลยกำหนดส่งแล้ว ไม่ใช่เห็นแค่วันนัด (0075) */}
                          <td><DeliveryBadge d={jobDelivery(db, j)} /></td>
                          <td>{mine?.assignment.isLead
                            ? <span className="badge amber">หัวหน้าทีม</span>
                            : <span className="muted">ช่างติดตั้ง</span>}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <span className={`badge ${sum.unitsDone ? 'green' : sum.installed > 0 ? 'blue' : 'neutral'}`}>
                              {sum.installed}/{sum.total}
                            </span>
                            {sum.blocked > 0 && <div style={{ fontSize: 11, color: 'var(--danger)' }}>ติดปัญหา {sum.blocked}</div>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          )}
      </div>

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
