import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../data/StoreContext'
import {
  deriveJobStatus, stockSummary, jobInstallSummary,
  jobDueDate, jobDaysLeft, todayIso, DUE_WARN_DAYS,
} from '../data/logic'
import { JobStatusBadge } from '../ui/components'
import { fmtDate, fmtDateTime } from '../ui/format'
import type { JobStatus } from '../types'

export default function DashboardPage() {
  const { db } = useStore()
  const [showAudit, setShowAudit] = useState(false)
  const today = todayIso()

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
  const issuedJobs = db.jobs.filter(j => j.terminalStatus === 'issued')
  const svc = issuedJobs.reduce((acc, j) => {
    const s = jobInstallSummary(db, j.id)
    acc.units += s.total; acc.installed += s.installed; acc.blocked += s.blocked
    if (!db.jobAssignments.some(a => a.jobId === j.id)) acc.unassigned++
    return acc
  }, { units: 0, installed: 0, blocked: 0, unassigned: 0 })
  const recent = db.auditLogs.slice(0, 10)
  const userName = (id: string) => db.users.find(u => u.id === id)?.fullName ?? id

  // ---- Job List: เรียงตาม "กำหนดส่ง" ใกล้สุดก่อน + เตือน 30 วันก่อนถึงกำหนด ----
  // นับเฉพาะงานที่ยังไม่จบ (installed/cancelled = จบแล้ว ไม่ต้องเตือน)
  // งานที่ยังไม่ระบุกำหนดส่งไปอยู่ท้ายรายการ — ไม่ใช่หัวรายการ (สำคัญ: ถ้า sort ค่าว่างจะขึ้นก่อน)
  const jobList = db.jobs
    .filter(j => j.terminalStatus !== 'installed' && j.terminalStatus !== 'cancelled')
    .map(j => ({ job: j, due: jobDueDate(j), daysLeft: jobDaysLeft(j, today) }))
    .sort((a, b) => (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31'))
  const overdue = jobList.filter(x => x.daysLeft !== undefined && x.daysLeft < 0).length
  const dueSoon = jobList.filter(x => x.daysLeft !== undefined && x.daysLeft >= 0 && x.daysLeft <= DUE_WARN_DAYS).length

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
            {overdue > 0 && <><b style={{ color: 'var(--danger)' }}>เลยกำหนดส่ง {overdue} งาน</b> · </>}
            {dueSoon > 0 && <><b style={{ color: 'var(--amber, #d97706)' }}>ใกล้ครบกำหนด {dueSoon} งาน</b> · </>}
            พร้อมเบิก {statusCount.get('ready_to_issue') ?? 0} · รอติดตั้ง {statusCount.get('issued') ?? 0} งาน
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

      {/* Job List — เรียงตามกำหนดส่ง (ใกล้สุดก่อน) + ทำเครื่องหมายเตือนเมื่อเหลือ ≤ 30 วัน
          เดิมเรียงตามลำดับที่สร้าง (slice(-6)) และรวมงานที่ปิด/ยกเลิกแล้ว = ไม่ได้ช่วยจัดลำดับงานจริง */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            Job List <span className="muted" style={{ fontWeight: 400 }}>· เรียงตามกำหนดส่ง — งานที่ยังไม่ปิด</span>
            {overdue > 0 && <span className="badge red" style={{ marginLeft: 8 }}>เลยกำหนด {overdue}</span>}
            {dueSoon > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>≤{DUE_WARN_DAYS} วัน {dueSoon}</span>}
          </h3>
          <Link to="/jobs">ดูทั้งหมด →</Link>
        </div>
        <div className="table-scroll">
          <table className="grid">
            <thead><tr><th>กำหนดส่ง</th><th>เหลือ</th><th>Job No.</th><th>ลูกค้า</th><th>สถานะ</th><th>LBS</th></tr></thead>
            <tbody>
              {jobList.length === 0 && (
                <tr><td colSpan={6}><div className="empty">ไม่มีงานที่กำลังดำเนินการ</div></td></tr>
              )}
              {jobList.slice(0, 8).map(({ job: j, due, daysLeft }) => {
                const allocated = db.lbsUnits.filter(u => u.jobId === j.id && u.status !== 'in_stock').length
                const late = daysLeft !== undefined && daysLeft < 0
                const soon = daysLeft !== undefined && daysLeft >= 0 && daysLeft <= DUE_WARN_DAYS
                // หลายจุดติดตั้ง → วันที่แสดงคือจุดที่ใกล้ที่สุด บอกจำนวนจุดที่เหลือให้เห็นด้วย
                const extraSites = (j.installSites?.length ?? 0)
                return (
                  <tr key={j.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {late && <span title="เลยกำหนดส่งแล้ว">🔴 </span>}
                      {soon && <span title={`เหลือ ≤ ${DUE_WARN_DAYS} วันก่อนกำหนดส่ง`}>⚠️ </span>}
                      {due ? fmtDate(due) : <span className="muted">ยังไม่ระบุ</span>}
                      {extraSites > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>+{extraSites} จุดติดตั้ง</div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {daysLeft === undefined ? <span className="muted">-</span>
                        : late ? <span className="badge red">เลย {Math.abs(daysLeft)} วัน</span>
                        : soon ? <span className="badge amber">{daysLeft} วัน</span>
                        : <span className="muted">{daysLeft} วัน</span>}
                    </td>
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
