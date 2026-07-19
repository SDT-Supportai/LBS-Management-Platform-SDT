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
  const canDecide = can(user, 'approval.decide')

  const jobOf = (id: string) => db.jobs.find(j => j.id === id)
  const userName = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  const pending = db.approvalRequests.filter(r => r.status === 'pending')
  const decided = db.approvalRequests.filter(r => r.status !== 'pending').slice().reverse().slice(0, 30)

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
    return `เหตุผล: ${r.payload.reason ?? '-'}${r.payload.receivedToCentral ? ' (วัสดุที่รับแล้วคืนเข้าสต็อกกลาง)' : ''}`
  }

  return (
    <div>
      <div className="page-title">รออนุมัติ (Approvals)</div>
      <div className="page-sub">
        คำขอจาก Project ที่ต้องให้ Division อนุมัติ: ออก PR · เบิกให้ Service · ยกเลิก Job
        {canDecide ? ' — อนุมัติแล้วระบบทำรายการให้ทันที' : ' — สถานะคำขอของแผนกคุณ'}
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

      <div className="panel">
        <div className="panel-head"><h3>ประวัติการตัดสิน (ล่าสุด {decided.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>ประเภท</th><th>Job No.</th><th>สถานะ</th><th>ผู้ขอ</th><th>ผู้ตัดสิน</th><th>ตัดสินเมื่อ</th></tr>
            </thead>
            <tbody>
              {decided.length === 0 && (
                <tr><td colSpan={6}><div className="empty">ยังไม่มีประวัติ</div></td></tr>
              )}
              {decided.map(r => (
                <tr key={r.id}>
                  <td>{APPROVAL_TYPE_LABEL[r.type]}</td>
                  <td>{jobOf(r.jobId)?.jobNo ?? '-'}</td>
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
      </div>

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
