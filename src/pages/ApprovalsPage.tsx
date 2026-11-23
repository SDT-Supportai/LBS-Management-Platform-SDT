import { Fragment, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { approvalCommentsOf, daysBetweenIso, todayIso } from '../data/logic'
import { approvalFacts, bkkDate } from '../data/flow'
import { Modal, useToast, useTryAction } from '../ui/components'
import { supabase } from '../lib/supabase'
import { APPROVAL_TYPE_LABEL, APPROVAL_STATUS_LABEL, DEPT_LABEL, fmtBaht, fmtDateTime } from '../ui/format'
import type { ApprovalRequest, ApprovalType } from '../types'

// โชว์ LINE User ID แบบปิดบางส่วน — พอให้ยืนยันว่าเชื่อมเครื่องไหน แต่ไม่เผยค่าเต็ม
function maskLineId(id?: string): string {
  if (!id) return '-'
  return id.length <= 10 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`
}

// ปุ่มกรองครบทุกประเภท (เฟส 3) — ลำดับตามความถี่ที่ Division เจอ
const TYPES: ApprovalType[] = ['create_pr', 'issue_job', 'swap_lbs', 'cancel_job', 'return_lbs', 'revert_install', 'reopen_job', 'correct_closeout']

/**
 * หน้ารออนุมัติ — เฟส 3 (2026-11-23): 3 มุมมอง ข้อมูลตัดสินใจอยู่ในรายละเอียด
 *   • Division/Manage (approval.decide) = ตัดสิน — **อนุมัติได้เฉพาะในรายละเอียด** (ไม่มีปุ่มบนแถว · เห็นข้อมูลครบก่อนกด)
 *   • VIP = ให้ความเห็น (ไม่มีอำนาจอนุมัติ)
 *   • Project/แผนกอื่น = ติดตามคำขอ — Project เริ่มที่ "คำขอของฉัน"
 * กล่องเดียวสลับโหมด: รายละเอียด → ตีกลับ (กรอกเหตุผล) — ไม่ซ้อนกล่อง · ?id=<คำขอ> เปิดรายละเอียดตรง (ลิงก์จากงานของฉัน)
 * ความเห็น (VIP ↔ Division) แยกจากเหตุผลตีกลับ (เหตุผลตีกลับ = แจ้ง Project · ความเห็น = ประกอบการตัดสิน)
 */
export default function ApprovalsPage() {
  const { db, user, act, mode } = useStore()
  const { show } = useToast()
  const tryAction = useTryAction()
  const [params, setParams] = useSearchParams()
  const today = todayIso()
  const canDecide = can(user, 'approval.decide')
  // ความเห็นบนคำขอ (0050) — VIP (ผู้บริหาร) ฝากความเห็นให้ Division · Division ตอบกลับได้
  const canComment = can(user, 'approval.comment')
  const isVip = user?.department === 'vip'
  const isProject = user?.department === 'project'
  const view: 'decide' | 'comment' | 'track' = canDecide ? 'decide' : isVip ? 'comment' : 'track'

  const [typeFilter, setTypeFilter] = useState<ApprovalType | 'all'>('all')
  const [mineOnly, setMineOnly] = useState(isProject)            // Project เริ่มที่คำขอของตัวเอง
  const [openJob, setOpenJob] = useState<Record<string, boolean>>({})   // ประวัติต่อ Job (เริ่มซ่อน)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [comment, setComment] = useState('')

  // เชื่อมบัญชี LINE (รับคำขอ + กดอนุมัติจากแชท 1:1) — เฉพาะผู้อนุมัติ โหมด LIVE
  const [lineCode, setLineCode] = useState<string | null>(null)
  const [lineBusy, setLineBusy] = useState(false)
  const lineLinked = !!user?.lineUserId
  const genLineCode = async () => {
    if (!supabase) return
    setLineBusy(true)
    try {
      const { data, error } = await supabase.rpc('rpc_line_gen_code')
      if (error) throw error
      setLineCode(String(data))
    } catch (e) {
      show('สร้างโค้ดไม่สำเร็จ: ' + (e as Error).message, true)
    }
    setLineBusy(false)
  }

  const jobOf = (id: string) => db.jobs.find(j => j.id === id)
  const userName = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  const waited = (r: ApprovalRequest) => daysBetweenIso(bkkDate(r.requestedAt), today)   // นับแบบเดียวกับงานของฉัน

  // ---- รายละเอียดที่เปิดอยู่ (?id=) ----
  const openId = params.get('id')
  const selected = openId ? db.approvalRequests.find(r => r.id === openId) : undefined
  const openReq = (id: string) => {
    setRejecting(false); setRejectReason(''); setComment('')
    setParams(p => { const n = new URLSearchParams(p); n.set('id', id); return n })
  }
  const closeReq = () => {
    setRejecting(false); setRejectReason(''); setComment('')
    setParams(p => { const n = new URLSearchParams(p); n.delete('id'); return n }, { replace: true })
  }

  const inScope = (r: ApprovalRequest) =>
    (typeFilter === 'all' || r.type === typeFilter) && (!mineOnly || r.requestedBy === user?.id)
  const allPending = db.approvalRequests.filter(r => r.status === 'pending')
  const pending = allPending.filter(inScope)
  const decided = db.approvalRequests.filter(r => r.status !== 'pending' && inScope(r)).slice().reverse()
  // จัดกลุ่มประวัติการตัดสินแยกตาม Job (คงลำดับล่าสุดก่อน)
  const decidedGroups: [string, ApprovalRequest[]][] = (() => {
    const m = new Map<string, ApprovalRequest[]>()
    decided.forEach(r => { const a = m.get(r.jobId) ?? []; a.push(r); m.set(r.jobId, a) })
    return [...m.entries()]
  })()
  const countOf = (t: ApprovalType) => allPending.filter(r => r.type === t && (!mineOnly || r.requestedBy === user?.id)).length

  const openLabel = view === 'decide' ? 'พิจารณา →' : view === 'comment' ? 'ให้ความเห็น →' : 'ดู →'

  return (
    <div>
      <div className="page-title">Awaiting Approval</div>
      <div className="page-sub">
        {view === 'decide' && 'คำขอจากงานโครงการที่รอคุณพิจารณา — เปิดรายละเอียดเพื่อดูข้อมูลครบแล้วจึงอนุมัติ/ตีกลับ · อนุมัติแล้วระบบดำเนินการให้ทันที'}
        {view === 'comment' && 'คุณคือผู้บริหาร (VIP): เปิดคำขอเพื่อดูข้อมูลแล้วฝากความเห็นถึง Division ได้ทุกใบ — อำนาจอนุมัติยังอยู่ที่ Division'}
        {view === 'track' && 'ติดตามสถานะคำขอที่ส่งให้ Division พิจารณา — คำสั่งยังไม่มีผลจนกว่าจะอนุมัติ'}
      </div>

      {canDecide && mode === 'supabase' && (
        <div className="panel">
          <div className="panel-head">
            <h3>🔗 รับคำขออนุมัติทาง LINE</h3>
            {lineLinked
              ? <span className="badge green">✅ เชื่อมต่อแล้ว</span>
              : <span className="badge neutral">ยังไม่เชื่อมต่อ</span>}
          </div>
          <div className="panel-body">
            {lineLinked && !lineCode ? (
              <>
                <p style={{ marginBottom: 8 }}>
                  บัญชีนี้<b style={{ color: 'var(--green)' }}>เชื่อมกับ LINE แล้ว</b> — คำขออนุมัติจะส่งเข้าแชท 1:1 ของคุณ
                  และกดปุ่ม ✅ อนุมัติ จากมือถือได้ทันที
                </p>
                <p className="muted" style={{ marginBottom: 8 }}>
                  LINE User ID: <span className="mono">{maskLineId(user?.lineUserId)}</span>
                  {' '}· การตีกลับยังต้องทำที่หน้านี้ (ต้องระบุเหตุผล)
                </p>
                <button className="small" onClick={genLineCode} disabled={lineBusy}>
                  {lineBusy ? 'กำลังสร้าง...' : 'เชื่อมบัญชี LINE ใหม่ (เปลี่ยนเครื่อง)'}
                </button>
              </>
            ) : lineCode ? (
              <>
                <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 6 }}>{lineCode}</div>
                <p className="muted" style={{ marginTop: 6 }}>
                  เพิ่มบอทเป็นเพื่อนแล้ว <b>พิมพ์โค้ดนี้ในแชท 1:1</b> ภายใน 10 นาที — จากนั้นจะได้รับการ์ดคำขอพร้อมปุ่มอนุมัติที่แชทส่วนตัว
                </p>
                <button className="small" onClick={genLineCode} disabled={lineBusy}>สร้างโค้ดใหม่</button>
              </>
            ) : (
              <>
                <p className="muted" style={{ marginBottom: 8 }}>
                  เชื่อมบัญชี LINE ส่วนตัว เพื่อรับคำขอและ<b>กดอนุมัติจากแชทได้เลย</b> (การตีกลับยังทำที่หน้านี้ — ต้องระบุเหตุผล)
                </p>
                <button onClick={genLineCode} disabled={lineBusy}>{lineBusy ? 'กำลังสร้าง...' : 'สร้างโค้ดเชื่อม LINE'}</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ตัวกรอง: ครบทุกประเภท + คำขอของฉัน */}
      <div className="filter-chips" role="group" aria-label="กรองตามประเภทคำขอ">
        <button className={`chip${typeFilter === 'all' ? ' on' : ''}`} onClick={() => setTypeFilter('all')}>
          ทั้งหมด <span className="chip-n">{TYPES.reduce((n, t) => n + countOf(t), 0)}</span>
        </button>
        {TYPES.map(t => (
          <button key={t} className={`chip${typeFilter === t ? ' on' : ''}`} onClick={() => setTypeFilter(t)}>
            {APPROVAL_TYPE_LABEL[t]} {countOf(t) > 0 && <span className="chip-n">{countOf(t)}</span>}
          </button>
        ))}
        {user && (
          <label className="chip-check">
            <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} />
            <span>เฉพาะคำขอของฉัน</span>
          </label>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><h3>รอตัดสิน ({pending.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ประเภท</th><th>Job No.</th><th>สรุป</th><th>ผู้ขอ</th><th>รอมาแล้ว</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 && (
                <tr><td colSpan={6}><div className="empty">
                  {mineOnly ? 'ไม่มีคำขอของคุณที่รอพิจารณา' : 'ไม่มีคำขอค้างอนุมัติ'}
                </div></td></tr>
              )}
              {pending.map(r => {
                const job = jobOf(r.jobId)
                const cmts = approvalCommentsOf(db, r.id)
                const f = approvalFacts(db, r, today)
                const w = waited(r)
                return (
                  <tr key={r.id} className="clickable" onClick={() => openReq(r.id)}>
                    <td>
                      <span className="badge blue">{APPROVAL_TYPE_LABEL[r.type]}</span>
                      {cmts.length > 0 && <div><span className="badge amber" title="มีความเห็นจากผู้บริหาร/Division">💬 {cmts.length}</span></div>}
                    </td>
                    <td><b>{job?.jobNo ?? '-'}</b><div className="muted">{job?.customerName}</div></td>
                    <td style={{ maxWidth: 360 }}>
                      {f.facts[0] ? <><span className="muted">{f.facts[0].label}:</span> {f.facts[0].value}</> : <span className="muted">-</span>}
                      {f.money && <div className="muted">มูลค่า {fmtBaht(f.money.total)}{f.money.unpriced > 0 && ` · ยังไม่มีราคา ${f.money.unpriced} รายการ`}</div>}
                      {f.stale.length > 0 && <div><span className="badge red">⚠️ รายการถูกแก้หลังส่งคำขอ</span></div>}
                    </td>
                    <td>{userName(r.requestedBy)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={w >= 3 ? 'badge amber' : 'muted'}>{w > 0 ? `${w} วัน` : 'วันนี้'}</span>
                      <div className="muted" style={{ fontSize: 11 }}>{fmtDateTime(r.requestedAt)}</div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className={`small${view === 'decide' && r.requestedBy !== user?.id ? ' primary' : ''}`}
                        onClick={e => { e.stopPropagation(); openReq(r.id) }}>
                        {view === 'decide' && r.requestedBy === user?.id ? 'ดู →' : openLabel}
                      </button>
                    </td>
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
            <div className="panel-head" style={{ cursor: 'pointer' }} onClick={() => setOpenJob(p => ({ ...p, [jobId]: !p[jobId] }))}>
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
                    {list.map(r => {
                      const cmts = approvalCommentsOf(db, r.id).length
                      return (
                        <Fragment key={r.id}>
                          <tr className="clickable" onClick={() => openReq(r.id)}>
                            <td>{APPROVAL_TYPE_LABEL[r.type]}{cmts > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>💬 {cmts}</span>}</td>
                            <td>
                              <span className={`badge ${r.status === 'approved' ? 'green' : 'red'}`}>{APPROVAL_STATUS_LABEL[r.status]}</span>
                              {r.rejectReason && <div className="muted">เหตุผล: {r.rejectReason}</div>}
                            </td>
                            <td>{userName(r.requestedBy)}</td>
                            <td>{userName(r.decidedBy)}</td>
                            <td>{fmtDateTime(r.decidedAt)}</td>
                          </tr>
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      {openId && !selected && (
        <Modal title="ไม่พบคำขอ" onClose={closeReq} footer={<button onClick={closeReq}>ปิด</button>}>
          <div className="muted">คำขอนี้ไม่มีอยู่แล้ว (อาจถูกลบหรือลิงก์ไม่ถูกต้อง)</div>
        </Modal>
      )}
      {selected && (() => {
        const r = selected
        const job = jobOf(r.jobId)
        const f = approvalFacts(db, r, today)
        const cmts = approvalCommentsOf(db, r.id)
        const own = r.requestedBy === user?.id
        const mayDecide = canDecide && r.status === 'pending' && !own
        const label = APPROVAL_TYPE_LABEL[r.type]
        const approve = async () => {
          if (await tryAction(() => act.approveRequest({ requestId: r.id }),
            `อนุมัติ${label} ${job?.jobNo ?? ''} แล้ว — ระบบทำรายการให้เรียบร้อย`)) closeReq()
        }
        const reject = async () => {
          if (await tryAction(() => act.rejectApprovalRequest({ requestId: r.id, reason: rejectReason }),
            'ตีกลับคำขอและแจ้ง Project แล้ว')) closeReq()
        }
        const sendComment = async () => {
          if (await tryAction(() => act.addApprovalComment({ requestId: r.id, body: comment.trim() }),
            isVip ? 'ส่งความเห็นถึง Division แล้ว' : 'บันทึกความเห็นแล้ว — แจ้ง VIP ให้ทราบ')) setComment('')
        }
        return (
          <Modal size="wide" onClose={closeReq}
            title={rejecting ? `ตีกลับคำขอ${label} — ${job?.jobNo ?? ''}` : `${label} — ${job?.jobNo ?? '-'}`}
            subtitle={<>ส่งโดย {userName(r.requestedBy)} · {fmtDateTime(r.requestedAt)} · <span className={`badge ${r.status === 'pending' ? 'amber' : r.status === 'approved' ? 'green' : 'red'}`}>{APPROVAL_STATUS_LABEL[r.status]}</span></>}
            onBack={rejecting ? () => setRejecting(false) : undefined} backLabel="← กลับไปรายละเอียด"
            dirty={(rejecting && !!rejectReason.trim()) || !!comment.trim()}
            footer={rejecting ? <>
              <button onClick={() => setRejecting(false)}>กลับ</button>
              <button className="danger" disabled={!rejectReason.trim()} onClick={reject}>ยืนยันตีกลับ</button>
            </> : mayDecide ? <>
              <button onClick={closeReq}>ปิด</button>
              <button className="danger" onClick={() => setRejecting(true)}>✖ ตีกลับ</button>
              <button className="success" disabled={f.stale.length > 0} onClick={approve}
                title={f.stale.length > 0 ? 'คำขอล้าสมัย — รายการถูกแก้หลังส่งคำขอ ต้องตีกลับให้ส่งใหม่' : undefined}>
                ✔ อนุมัติ
              </button>
            </> : <button onClick={closeReq}>ปิด</button>}>
            {rejecting ? (
              <>
                <div className="muted" style={{ marginBottom: 10 }}>
                  เหตุผลนี้<b>แจ้งกลับ Project</b> และเก็บคู่กับคำขอ — แยกจากความเห็นผู้บริหาร
                </div>
                <label className="field">
                  <span>เหตุผลที่ตีกลับ *</span>
                  <textarea rows={3} autoFocus value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                    placeholder="เช่น ข้อมูลนัดติดตั้งไม่ตรงกับลูกค้า / งบประมาณยังไม่อนุมัติ" />
                </label>
              </>
            ) : (
              <>
                {f.stale.length > 0 && (
                  <div className="approval-warn" role="alert">
                    ⚠️ <b>คำขอล้าสมัย — อนุมัติไม่ได้</b>: รายการถูกแก้หลังส่งคำขอ ({f.stale.join(', ')}) · ตีกลับแล้วให้ Project ส่งคำขอใหม่
                  </div>
                )}
                <dl className="facts">
                  <dt>งาน</dt>
                  <dd>
                    {job ? <Link to={`/jobs/${job.id}`}>{job.jobNo} →</Link> : '-'}
                    {job && <span className="muted"> · {job.customerName}</span>}
                  </dd>
                  {f.facts.map(x => <Fragment key={x.label}><dt>{x.label}</dt><dd>{x.value}</dd></Fragment>)}
                  {f.money && (
                    <>
                      <dt>มูลค่ารวม</dt>
                      <dd>
                        <b>{fmtBaht(f.money.total)}</b>
                        {f.money.unpriced > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>ยังไม่มีราคา {f.money.unpriced} รายการ</span>}
                      </dd>
                    </>
                  )}
                </dl>
                {r.status === 'pending' ? (
                  <div className="approval-outcome"><b>ผลที่จะเกิด</b> — {f.outcome}</div>
                ) : (
                  <div className="approval-outcome">
                    <b>{APPROVAL_STATUS_LABEL[r.status]}</b> โดย {userName(r.decidedBy)} · {fmtDateTime(r.decidedAt)}
                    {r.rejectReason && <div>เหตุผลที่ตีกลับ (แจ้ง Project): {r.rejectReason}</div>}
                  </div>
                )}
                {own && canDecide && r.status === 'pending' && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    คำขอของคุณเอง — รอ Division พิจารณา (คนขอกับคนอนุมัติต้องเป็นคนละคน · มติ D1)
                  </div>
                )}

                {/* ความเห็นผู้บริหาร — ประวัติเต็ม · แยกจากเหตุผลตีกลับ */}
                <div className="approval-comments">
                  <div className="approval-comments-head">💬 ความเห็นผู้บริหาร (VIP ↔ Division) · {cmts.length}</div>
                  {cmts.length === 0 && <div className="muted">ยังไม่มีความเห็น</div>}
                  {cmts.map(c => {
                    const author = db.users.find(u => u.id === c.authorId)
                    return (
                      <div key={c.id} className="approval-comment">
                        <div className="muted" style={{ fontSize: 12 }}>
                          <b style={{ color: 'var(--text)' }}>{author?.fullName ?? '-'}</b>
                          {author && <span className="badge blue" style={{ marginLeft: 6 }}>{DEPT_LABEL[author.department]}</span>}
                          {' '}· {fmtDateTime(c.createdAt)}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                      </div>
                    )
                  })}
                  {canComment && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6 }}>
                      <textarea rows={2} style={{ flex: 1 }} value={comment} onChange={e => setComment(e.target.value)}
                        aria-label="ความเห็น"
                        placeholder={isVip
                          ? 'ความเห็น/ข้อสั่งการถึง Division เช่น "อนุมัติได้ แต่ให้ต่อรองราคากับซัพก่อน"'
                          : 'ตอบกลับความเห็นของผู้บริหาร'} />
                      <button className="primary small" disabled={!comment.trim()} onClick={sendComment}>ส่งความเห็น</button>
                    </div>
                  )}
                </div>
              </>
            )}
          </Modal>
        )
      })()}
    </div>
  )
}
