import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { Modal, useTryAction } from '../ui/components'
import { APPROVAL_TYPE_LABEL, APPROVAL_STATUS_LABEL, fmtDate, fmtDateTime } from '../ui/format'
import type { ApprovalRequest } from '../types'

// หน้ารออนุมัติ (Division approval inbox)
// - division/admin: เห็นปุ่มอนุมัติ/ตีกลับ
// - project: เห็นสถานะคำขอของตัวเอง (อ่านอย่างเดียว)
export default function ApprovalsPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const navigate = useNavigate()
  const [rejectTarget, setRejectTarget] = useState<ApprovalRequest | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [openJob, setOpenJob] = useState<Record<string, boolean>>({})   // ประวัติต่อ Job (เริ่มซ่อน)
  const canDecide = can(user, 'approval.decide')
  const toggleJob = (id: string) => setOpenJob(p => ({ ...p, [id]: !p[id] }))

  const jobOf = (id: string) => db.jobs.find(j => j.id === id)
  const userName = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  const pending = db.approvalRequests.filter(r => r.status === 'pending')
  const decided = db.approvalRequests.filter(r => r.status !== 'pending').slice().reverse()
  // จัดกลุ่มประวัติการตัดสินแยกตาม Job (คงลำดับล่าสุดก่อน)
  const decidedGroups: [string, ApprovalRequest[]][] = (() => {
    const m = new Map<string, ApprovalRequest[]>()
    decided.forEach(r => { const a = m.get(r.jobId) ?? []; a.push(r); m.set(r.jobId, a) })
    return [...m.entries()]
  })()

  // สรุปเนื้อหาคำขอต่อ type ให้ division เห็นข้อมูลก่อนตัดสิน
  const payloadSummary = (r: ApprovalRequest): string => {
    if (r.type === 'create_pr') {
      const n = r.payload.requestIds?.length ?? 0
      const names = (r.payload.requestIds ?? [])
        .map(id => db.accessoryRequests.find(a => a.id === id))
        .filter(Boolean)
        .map(a => `${db.items.find(i => i.id === a!.itemId)?.name ?? '?'} ×${a!.qtyRequested}`)
      return `${n} รายการ: ${names.join(', ') || '-'}`
    }
    if (r.type === 'issue_job') {
      const range = r.payload.startDate === r.payload.endDate
        ? fmtDate(r.payload.startDate)
        : `${fmtDate(r.payload.startDate)} – ${fmtDate(r.payload.endDate)}`
      return `ติดตั้ง ${range} ที่ ${r.payload.location ?? '-'}${r.payload.note ? ` — ${r.payload.note}` : ''}`
    }
    if (r.type === 'swap_lbs') {
      const a = db.lbsUnits.find(u => u.id === r.payload.swapAllocatedUnitId)
      const b = db.lbsUnits.find(u => u.id === r.payload.swapStockUnitId)
      const sn = (u?: typeof a) => u ? `${u.serialLvb}/${u.serialOm}` : '?'
      return `สลับ ${sn(a)} (บน Job) ↔ ${sn(b)} (คลัง) · เหตุผล: ${r.payload.reason ?? '-'}`
    }
    return `เหตุผล: ${r.payload.reason ?? '-'}${r.payload.receivedToCentral ? ' (วัสดุที่รับแล้วคืนเข้าสต็อกกลาง)' : ''}`
  }

  return (
    <div>
      <div className="page-title">Awaiting Approval</div>
      <div className="page-sub">
        คำขอจากงานโครงการที่รอ Division พิจารณา — ออก PR · เบิกให้ Service · ยกเลิก Job · สลับ LBS
        {canDecide ? ' · อนุมัติแล้วระบบดำเนินการให้ทันที' : ' · ติดตามสถานะคำขอของแผนกคุณที่นี่'}
      </div>

      <div className="panel">
        <div className="panel-head"><h3>รอตัดสิน ({pending.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ประเภท</th><th>Job No.</th><th>รายละเอียด</th><th>ผู้ขอ</th><th>ขอเมื่อ</th>
                {canDecide && <th style={{ textAlign: 'right' }}>ตัดสิน</th>}
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 && (
                <tr><td colSpan={canDecide ? 6 : 5}><div className="empty">ไม่มีคำขอค้างอนุมัติ</div></td></tr>
              )}
              {pending.map(r => {
                const job = jobOf(r.jobId)
                return (
                  <tr key={r.id}>
                    <td><span className="badge blue">{APPROVAL_TYPE_LABEL[r.type]}</span></td>
                    <td>
                      <a style={{ cursor: 'pointer', color: 'var(--primary)', fontWeight: 600 }}
                        onClick={() => navigate(`/jobs/${r.jobId}`)}>{job?.jobNo ?? '-'}</a>
                      <div className="muted">{job?.customerName}</div>
                    </td>
                    <td style={{ maxWidth: 340 }}>{payloadSummary(r)}</td>
                    <td>{userName(r.requestedBy)}</td>
                    <td>{fmtDateTime(r.requestedAt)}</td>
                    {canDecide && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="success small" style={{ marginRight: 6 }}
                          onClick={() => tryAction(() => act.approveRequest({ requestId: r.id }),
                            `อนุมัติ${APPROVAL_TYPE_LABEL[r.type]} ${job?.jobNo ?? ''} แล้ว — ระบบทำรายการให้เรียบร้อย`)}>
                          ✔ อนุมัติ
                        </button>
                        <button className="danger small"
                          onClick={() => { setRejectReason(''); setRejectTarget(r) }}>
                          ✖ ตีกลับ
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="page-sub" style={{ marginTop: 24, marginBottom: 8, fontWeight: 700, color: 'var(--text)' }}>
        ประวัติการตัดสิน — สรุปแยกตาม Job ({decidedGroups.length} งาน)
      </div>
      {decidedGroups.length === 0 && (
        <div className="panel"><div className="empty">ยังไม่มีประวัติการตัดสิน</div></div>
      )}
      {decidedGroups.map(([jobId, list]) => {
        const approved = list.filter(r => r.status === 'approved').length
        const rejected = list.filter(r => r.status === 'rejected').length
        return (
          <div className="panel" key={jobId}>
            <div className="panel-head" style={{ cursor: 'pointer' }} onClick={() => toggleJob(jobId)}>
              <h3>
                {openJob[jobId] ? '▾' : '▸'} {jobOf(jobId)?.jobNo ?? '-'}{' '}
                <span className="muted" style={{ fontWeight: 400 }}>{jobOf(jobId)?.customerName}</span>
              </h3>
              <span className="muted">
                {approved > 0 && <span className="badge green">อนุมัติ {approved}</span>}{' '}
                {rejected > 0 && <span className="badge red">ตีกลับ {rejected}</span>}
              </span>
            </div>
            {openJob[jobId] && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>ประเภท</th><th>สถานะ</th><th>ผู้ขอ</th><th>ผู้ตัดสิน</th><th>ตัดสินเมื่อ</th></tr>
                  </thead>
                  <tbody>
                    {list.map(r => (
                      <tr key={r.id}>
                        <td>{APPROVAL_TYPE_LABEL[r.type]}</td>
                        <td>
                          <span className={`badge ${r.status === 'approved' ? 'green' : 'red'}`}>
                            {APPROVAL_STATUS_LABEL[r.status]}
                          </span>
                          {r.rejectReason && <div className="muted">เหตุผล: {r.rejectReason}</div>}
                        </td>
                        <td>{userName(r.requestedBy)}</td>
                        <td>{userName(r.decidedBy)}</td>
                        <td>{fmtDateTime(r.decidedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      {rejectTarget && (
        <Modal title={`ตีกลับคำขอ${APPROVAL_TYPE_LABEL[rejectTarget.type]} — ${jobOf(rejectTarget.jobId)?.jobNo ?? ''}`}
          onClose={() => setRejectTarget(null)}>
          <label className="field">
            <span>เหตุผลที่ตีกลับ (แจ้งกลับ Project)</span>
            <textarea rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)}
              placeholder="เช่น ข้อมูลนัดติดตั้งไม่ตรงกับลูกค้า / งบประมาณยังไม่อนุมัติ" />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={() => setRejectTarget(null)}>ยกเลิก</button>
            <button className="danger"
              onClick={async () => {
                if (await tryAction(() => act.rejectApprovalRequest({ requestId: rejectTarget.id, reason: rejectReason }),
                  'ตีกลับคำขอและแจ้ง Project แล้ว')) setRejectTarget(null)
              }}>
              ยืนยันตีกลับ
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
