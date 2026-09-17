import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import {
  deriveJobStatus, stockSummary, jobInstallSummary, jobIsFieldActive, jobAllocatedQty,
  jobDelivery, todayIso, DUE_WARN_DAYS, stockComments,
} from '../data/logic'
import { DeliveryBadge, JobStatusBadge, useTryAction } from '../ui/components'
import { fmtDate, fmtDateTime, DEPT_LABEL } from '../ui/format'
import type { JobStatus } from '../types'

export default function DashboardPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const [showAudit, setShowAudit] = useState(false)
  const [vipComment, setVipComment] = useState('')
  const today = todayIso()

  // ความเห็นผู้บริหาร (0050/0051) — ย้ายมาจากท้ายหน้า Project Stock (มติ 2026-08-23)
  //   เหตุผล: เป็นข้อสังเกต/ข้อสั่งการ "ภาพรวม" ที่ทุกแผนกควรเห็น แต่เดิมซ่อนอยู่ท้ายหน้าคลัง
  //   ซึ่งมีแต่ Division เข้าบ่อย · วางใต้ Job List (เห็นสถานะงานก่อน แล้วอ่านความเห็น)
  //   และเหนือ Audit (ซึ่งเป็นหลักฐานย้อนหลัง ไม่ใช่สิ่งที่ต้องอ่านทุกวัน)
  //   ⚠️ scope ใน DB ยังเป็น 'stock' ตาม 0051 — ไม่ rename เพราะต้อง migration แลกกับประโยชน์ศูนย์
  //      (เป็น thread เดียวกัน ความเห็นเก่าทั้งหมดยังอยู่ครบ)
  const canComment = can(user, 'approval.comment')
  const isVip = user?.department === 'vip'
  const vipComments = stockComments(db)

  const totals = db.projectStocks.reduce(
    (acc, s) => {
      const sum = stockSummary(db, s.id)
      acc.total += sum.total
      acc.pending += sum.pending; acc.onHand += sum.onHand; acc.unknown += sum.unknown
      acc.allocated += sum.allocated; acc.issued += sum.issued
      return acc
    },
    // ไม่เก็บ available (= in_stock ทั้งหมด) แยก — ทับซ้อนกับ onHand + pending + unknown
    { total: 0, pending: 0, onHand: 0, unknown: 0, allocated: 0, issued: 0 },
  )

  const statusCount = new Map<JobStatus, number>()
  db.jobs.forEach(j => {
    const st = deriveJobStatus(db, j)
    statusCount.set(st, (statusCount.get(st) ?? 0) + 1)
  })

  const pendingPr = db.prs.filter(p => p.status === 'pending')
  const openPo = db.pos.filter(p => p.status === 'issued')

  // ฝั่ง Service — คืบหน้าติดตั้งรายเครื่องของงานที่เบิกแล้ว + งานที่ยังไม่มอบหมายทีม
  // 0071: นับงานที่เบิกบางส่วนด้วย ไม่งั้นการ์ดนี้ขัดกับหน้า Service/Scheduling ที่นับไปแล้ว
  //   และนับ "เครื่อง" จากของที่ออกไปอยู่กับช่างจริง (outTotal) ไม่ใช่ทุกเครื่องบนใบ
  //   — งานที่เบิกครบแล้ว outTotal === total จึงไม่เปลี่ยนตัวเลขเดิมของงานปกติ
  const issuedJobs = db.jobs.filter(j => jobIsFieldActive(db, j))
  const svc = issuedJobs.reduce((acc, j) => {
    const s = jobInstallSummary(db, j.id)
    acc.units += s.outTotal; acc.installed += s.outInstalled; acc.blocked += s.outBlocked
    if (!db.jobAssignments.some(a => a.jobId === j.id)) acc.unassigned++
    return acc
  }, { units: 0, installed: 0, blocked: 0, unassigned: 0 })
  const recent = db.auditLogs.slice(0, 10)
  const userName = (id: string) => db.users.find(u => u.id === id)?.fullName ?? id

  // ---- Job List: เรียงตาม "กำหนดส่งที่มีผล" ใกล้สุดก่อน ----
  // นับเฉพาะงานที่ยังไม่จบ (installed/cancelled = จบแล้ว ไม่ต้องเตือน)
  // งานที่ยังไม่ระบุกำหนดส่งไปอยู่ท้ายรายการ — ไม่ใช่หัวรายการ (สำคัญ: ถ้า sort ค่าว่างจะขึ้นก่อน)
  // 0075: เรียงตาม d.due (กำหนดที่ขยายแล้ว) ไม่ใช่ requiredDate — ไม่งั้นงานที่ตกลงเลื่อนกับลูกค้า
  //       ยังค้างหัวรายการตลอดไป · และตัวนับใช้ d.state ไม่ใช่ daysLeft < 0 (ดู jobDelivery)
  const jobList = db.jobs
    .filter(j => j.terminalStatus !== 'installed' && j.terminalStatus !== 'cancelled')
    .map(j => ({ job: j, d: jobDelivery(db, j, today) }))
    .sort((a, b) => (a.d.due ?? '9999-12-31').localeCompare(b.d.due ?? '9999-12-31'))
  // "เลยกำหนด" = เลยจริงและของยังไม่ออกหน้างาน · งานที่กำลังติดตั้งอยู่แยกไปอีกตัวนับ
  const overdue = jobList.filter(x => x.d.state === 'overdue').length
  const inFieldLate = jobList.filter(x => x.d.state === 'in_field_late').length
  const blocked = jobList.filter(x => x.d.state === 'blocked').length
  const dueSoon = jobList.filter(x => x.d.state === 'due_soon').length
  const awaitingClose = jobList.filter(x => x.d.state === 'awaiting_close').length

  return (
    <div className="dash">
      <div className="aurora" aria-hidden="true"><span className="a1" /><span className="a2" /><span className="a3" /></div>
      <div className="page-title">Dashboard</div>
      <div className="page-sub">ภาพรวมเรียลไทม์ — สต็อก 115kV LBS · สถานะงานโครงการ · งานค้างระหว่างแผนก</div>

      <div className="cards">
        <div className="card">
          <div className="label">Total LBS Target Plan</div>
          <div className="value">{totals.total} <span className="muted">เครื่อง</span></div>
          <div className="hint">
            พร้อมดึง (On Hand) {totals.onHand}
            {totals.pending > 0 && <> · <b style={{ color: 'var(--amber, #d97706)' }}>รอเข้าคลัง {totals.pending}</b></>}
            {totals.unknown > 0 && <> · <b title="ยังไม่ระบุ ETA to WH — กรอก FOB date ให้ครบเพื่อให้ระบบคำนวณ Status ได้">ไม่ระบุ ETA {totals.unknown}</b></>}
            {' '}· ถูกดึงเข้า Job {totals.allocated} · เบิกติดตั้งแล้ว {totals.issued}
          </div>
        </div>
        <div className="card">
          <div className="label">Jobs In Progress</div>
          <div className="value">{db.jobs.filter(j => !j.terminalStatus || j.terminalStatus === 'issued').length}</div>
          <div className="hint">
            {/* 0075: "ต้องเร่ง" = เลยกำหนดทั้งที่ยังไม่ออกหน้างาน + งานที่ติดปัญหาหน้างาน
                งานที่กำลังติดตั้งอยู่แล้วเลยแผน ไม่ถูกนับรวม — มันเดินอยู่ ไม่ได้ค้าง */}
            {overdue + blocked > 0 && (
              <><b style={{ color: 'var(--danger)' }} title="เลยกำหนดทั้งที่ของยังไม่ออกจากคลัง หรือติดปัญหาหน้างาน">
                ต้องเร่ง {overdue + blocked} งาน
              </b> · </>
            )}
            {inFieldLate > 0 && <><b style={{ color: 'var(--amber, #d97706)' }} title="ทีมกำลังติดตั้งอยู่ แต่เลยกำหนดส่งเดิม — บันทึกขยายกำหนดส่งได้ที่หน้า Job">กำลังติดตั้ง เลยแผน {inFieldLate} งาน</b> · </>}
            {dueSoon > 0 && <><b style={{ color: 'var(--amber, #d97706)' }}>ใกล้ครบกำหนด {dueSoon} งาน</b> · </>}
            พร้อมเบิก {statusCount.get('ready_to_issue') ?? 0}
            {(statusCount.get('partially_issued') ?? 0) > 0 && (
              <> · <b style={{ color: '#8a5a00' }}>เบิกบางส่วน {statusCount.get('partially_issued')}</b></>
            )}
            {' '}· รอติดตั้ง {statusCount.get('issued') ?? 0} งาน
          </div>
        </div>
        <div className="card">
          <div className="label">PRs Awaiting PO Issuance</div>
          <div className="value">{pendingPr.length}</div>
          <div className="hint"><Link to="/purchasing">ไปหน้า Purchasing →</Link></div>
        </div>
        <div className="card">
          <div className="label">POs Pending Delivery</div>
          <div className="value">{openPo.length}</div>
          <div className="hint">รับของครบแล้ว Job จะขยับสถานะอัตโนมัติ</div>
        </div>
        <div className="card">
          <div className="label">Installation Work (Service)</div>
          <div className="value">{svc.installed}<span className="muted">/{svc.units} เครื่อง</span></div>
          <div className="hint">
            {svc.unassigned > 0
              ? <b style={{ color: 'var(--danger)' }}>ยังไม่มอบหมายทีม {svc.unassigned} งาน</b>
              : `${issuedJobs.length} งานรอติดตั้ง`}
            {svc.blocked > 0 && <> · ติดตั้งไม่ได้ {svc.blocked} เครื่อง</>}
            {' '}· <Link to="/scheduling">ตารางทีม →</Link>
          </div>
        </div>
      </div>

      {/* LBS — Stock Balance: แยก "คงเหลือ" ออกเป็น On Hand (ดึงเข้า Job ได้จริง) กับ Pending (รอเข้าคลังตาม ETA)
          เดิมโชว์ "คงเหลือ" ก้อนเดียว → ตัวเลขนับรวมของที่ยังไม่มาถึงคลัง ทำให้วางแผนงานผิด */}
      <div className="panel">
        <div className="panel-head">
          <h3>LBS — Stock Balance <span className="muted" style={{ fontWeight: 400 }}>· สต็อก LBS รายคลัง</span></h3>
          <Link to="/stocks">จัดการสต็อก →</Link>
        </div>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Stock No.</th><th>ทั้งหมด</th>
                <th>On Hand (พร้อมดึง)</th><th>Pending (รอเข้าคลัง)</th><th>? (ไม่ระบุ ETA)</th>
                <th>ถูกดึงเข้า Job</th><th>เบิกติดตั้งแล้ว</th>
              </tr>
            </thead>
            <tbody>
              {db.projectStocks.length === 0 && (
                <tr><td colSpan={7}><div className="empty">ยังไม่มี Project Stock</div></td></tr>
              )}
              {db.projectStocks.map(s => {
                const sum = stockSummary(db, s.id)
                return (
                  <tr key={s.id}>
                    <td>
                      <Link to="/stocks"><b>{s.stockNo}</b></Link>
                      {s.status === 'closed' && <span className="badge red" style={{ marginLeft: 6 }}>ปิดคลัง</span>}
                    </td>
                    <td>{sum.total}</td>
                    <td><span className={`badge ${sum.onHand > 0 ? 'green' : 'red'}`}>{sum.onHand}</span></td>
                    <td>{sum.pending > 0 ? <span className="badge amber">{sum.pending}</span> : <span className="muted">-</span>}</td>
                    <td>
                      {sum.unknown > 0
                        ? <span className="badge neutral" title="ยังไม่ระบุ ETA to WH — กรอก FOB date ที่หน้า Project Stock">{sum.unknown}</span>
                        : <span className="muted">-</span>}
                    </td>
                    <td>{sum.allocated}</td>
                    <td>{sum.issued}</td>
                  </tr>
                )
              })}
              {db.projectStocks.length > 1 && (
                <tr>
                  <td><b>รวมทุกคลัง</b></td>
                  <td><b>{totals.total}</b></td>
                  <td><b>{totals.onHand}</b></td>
                  <td><b>{totals.pending || '-'}</b></td>
                  <td><b>{totals.unknown || '-'}</b></td>
                  <td><b>{totals.allocated}</b></td>
                  <td><b>{totals.issued}</b></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Job List — เรียงตามกำหนดส่งที่มีผล (ใกล้สุดก่อน)
          0075: คอลัมน์ "เหลือ" กลายเป็น "สถานะกำหนดส่ง" ที่บอกทั้งเรื่องวันและเรื่องหน้างาน
          เดิมโชว์แค่ "เลย N วัน" สีแดง ⇒ งานที่ช่างกำลังติดตั้งอยู่ดูเหมือนงานที่ยังไม่มีใครแตะ */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            Job List <span className="muted" style={{ fontWeight: 400 }}>· เรียงตามกำหนดส่ง — งานที่ยังไม่ปิด</span>
            {overdue > 0 && <span className="badge red" style={{ marginLeft: 8 }} title="เลยกำหนดทั้งที่ของยังไม่ออกจากคลัง">เลยกำหนด {overdue}</span>}
            {blocked > 0 && <span className="badge red" style={{ marginLeft: 6 }}>ติดปัญหาหน้างาน {blocked}</span>}
            {inFieldLate > 0 && <span className="badge amber" style={{ marginLeft: 6 }} title="กำลังติดตั้งอยู่ แต่เลยกำหนดเดิม">กำลังติดตั้ง เลยแผน {inFieldLate}</span>}
            {dueSoon > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>≤{DUE_WARN_DAYS} วัน {dueSoon}</span>}
            {awaitingClose > 0 && <span className="badge blue" style={{ marginLeft: 6 }}>รอปิดงาน {awaitingClose}</span>}
          </h3>
          <Link to="/jobs">ดูทั้งหมด →</Link>
        </div>
        <div className="table-scroll">
          <table className="grid">
            <thead><tr><th>กำหนดส่ง</th><th>สถานะกำหนดส่ง</th><th>Job No.</th><th>ลูกค้า</th><th>สถานะงาน</th><th>LBS</th></tr></thead>
            <tbody>
              {jobList.length === 0 && (
                <tr><td colSpan={6}><div className="empty">ไม่มีงานที่กำลังดำเนินการ</div></td></tr>
              )}
              {jobList.slice(0, 8).map(({ job: j, d }) => {
                const allocated = jobAllocatedQty(db, j.id)   // 0059: allocated + issued (แหล่งเดียวกับหน้า Jobs)
                // หลายจุดติดตั้ง → วันที่แสดงคือจุดที่ใกล้ที่สุด บอกจำนวนจุดที่เหลือให้เห็นด้วย
                const extraSites = (j.installSites?.length ?? 0)
                return (
                  <tr key={j.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {d.due ? fmtDate(d.due) : <span className="muted">ยังไม่ระบุ</span>}
                      {/* ขยายกำหนดแล้ว → โชว์กำหนดตามสัญญาเดิมกำกับเสมอ ไม่งั้นตัวเลขในระบบ
                          กับในสัญญาไม่ตรงกันโดยไม่มีใครรู้ */}
                      {d.extension && d.contractDue && (
                        <div className="muted" style={{ fontSize: 11 }}
                          title={`เลื่อน ${d.extensionCount} ครั้ง · ล่าสุด: ${d.extension.reason}`}>
                          เลื่อนจาก {fmtDate(d.contractDue)}
                        </div>
                      )}
                      {extraSites > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>+{extraSites} จุดติดตั้ง</div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}><DeliveryBadge d={d} compact /></td>
                    <td><Link to={`/jobs/${j.id}`}><b>{j.jobNo}</b></Link></td>
                    <td>{j.customerName}</td>
                    <td><JobStatusBadge status={deriveJobStatus(db, j)} /></td>
                    <td>{allocated}/{j.lbsQtyRequired}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {jobList.length > 8 && (
          <div className="panel-body muted">แสดง 8 งานที่ใกล้กำหนดที่สุดจากทั้งหมด {jobList.length} งาน · <Link to="/jobs">ดูทั้งหมด →</Link></div>
        )}
      </div>

      {/* 💬 ความเห็นผู้บริหาร (VIP) — ใต้ Job List · เหนือ Audit
          อ่านได้ทุกแผนก · เขียนได้ VIP / Division / Manage (perm approval.comment) */}
      <div className="panel">
        <div className="panel-head">
          <h3>💬 ความเห็นผู้บริหาร (VIP)
            <span className="muted" style={{ fontWeight: 400 }}> · ข้อสังเกต/ข้อสั่งการภาพรวม — ไม่ผูกกับใบงานใดใบหนึ่ง</span>
          </h3>
          {vipComments.length > 0 && <span className="badge amber">{vipComments.length}</span>}
        </div>
        <div className="panel-body">
          {vipComments.length === 0 && (
            <div className="muted" style={{ marginBottom: canComment ? 12 : 0 }}>
              ยังไม่มีความเห็น{canComment ? ' — พิมพ์ด้านล่างเพื่อแจ้งให้อีกฝ่ายทราบ' : ''}
            </div>
          )}
          {vipComments.map(c => {
            const author = db.users.find(u => u.id === c.authorId)
            return (
              <div key={c.id} style={{ marginBottom: 10, paddingLeft: 10, borderLeft: '3px solid var(--border)' }}>
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
              <textarea rows={2} style={{ flex: 1 }} value={vipComment}
                onChange={e => setVipComment(e.target.value)}
                placeholder={isVip
                  ? 'เช่น "ล็อต Stock No.3 ETA ต.ค. ช้าไป ให้ตามซัพเรื่องวันลงเรืออีกครั้ง"'
                  : 'ตอบกลับความเห็นของผู้บริหาร'} />
              <button className="primary small" disabled={!vipComment.trim()}
                onClick={async () => {
                  if (await tryAction(
                    () => act.addStockComment({ body: vipComment }),
                    isVip ? 'ส่งความเห็นถึง Division แล้ว' : 'บันทึกความเห็นแล้ว — แจ้ง VIP ให้ทราบ',
                  )) setVipComment('')
                }}>ส่งความเห็น</button>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Transaction ล่าสุด (Audit)</h3>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="small" onClick={() => setShowAudit(!showAudit)}>{showAudit ? 'ซ่อนรายการ' : `แสดงรายการ (${recent.length})`}</button>
            <Link to="/audit">ดูทั้งหมด →</Link>
          </div>
        </div>
        {showAudit && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>เวลา</th><th>ผู้ทำรายการ</th><th>รายละเอียด</th></tr></thead>
              <tbody>
                {recent.map(a => (
                  <tr key={a.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                    <td>{userName(a.actorId)}</td>
                    <td>{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
