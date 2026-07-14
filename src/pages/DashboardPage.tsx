import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../data/StoreContext'
import { deriveJobStatus, stockSummary } from '../data/logic'
import { JobStatusBadge } from '../ui/components'
import { fmtDateTime } from '../ui/format'
import type { JobStatus } from '../types'

export default function DashboardPage() {
  const { db } = useStore()
  const [showAudit, setShowAudit] = useState(false)

  const totals = db.projectStocks.reduce(
    (acc, s) => {
      const sum = stockSummary(db, s.id)
      acc.total += sum.total; acc.available += sum.available
      acc.allocated += sum.allocated; acc.issued += sum.issued
      return acc
    },
    { total: 0, available: 0, allocated: 0, issued: 0 },
  )

  const statusCount = new Map<JobStatus, number>()
  db.jobs.forEach(j => {
    const st = deriveJobStatus(db, j)
    statusCount.set(st, (statusCount.get(st) ?? 0) + 1)
  })

  const pendingPr = db.prs.filter(p => p.status === 'pending')
  const openPo = db.pos.filter(p => p.status === 'issued')
  const recent = db.auditLogs.slice(0, 10)
  const userName = (id: string) => db.users.find(u => u.id === id)?.fullName ?? id

  return (
    <div className="dash">
      <div className="aurora" aria-hidden="true"><span className="a1" /><span className="a2" /><span className="a3" /></div>
      <div className="page-title">Dashboard</div>
      <div className="page-sub">ภาพรวมสต็อก 115kV LBS, สถานะ Job และงานค้างระหว่างแผนก</div>

      <div className="cards">
        <div className="card">
          <div className="label">LBS ทั้งหมดในระบบ</div>
          <div className="value">{totals.total} <span className="muted">เครื่อง</span></div>
          <div className="hint">คงเหลือพร้อมดึง {totals.available} · ถูกดึงเข้า Job {totals.allocated} · เบิกติดตั้งแล้ว {totals.issued}</div>
        </div>
        <div className="card">
          <div className="label">Job กำลังดำเนินการ</div>
          <div className="value">{db.jobs.filter(j => !j.terminalStatus || j.terminalStatus === 'issued').length}</div>
          <div className="hint">พร้อมเบิก {statusCount.get('ready_to_issue') ?? 0} · รอติดตั้ง {statusCount.get('issued') ?? 0} งาน</div>
        </div>
        <div className="card">
          <div className="label">PR รอ Purchasing ออก PO</div>
          <div className="value">{pendingPr.length}</div>
          <div className="hint"><Link to="/purchasing">ไปหน้า Purchasing →</Link></div>
        </div>
        <div className="card">
          <div className="label">PO รอรับของ</div>
          <div className="value">{openPo.length}</div>
          <div className="hint">รับของครบแล้ว Job จะขยับสถานะอัตโนมัติ</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>สต็อก LBS รายคลัง</h3><Link to="/stocks">จัดการสต็อก →</Link></div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Stock No.</th><th>ทั้งหมด</th><th>คงเหลือ</th><th>ถูกดึงเข้า Job</th><th>เบิกติดตั้งแล้ว</th></tr>
            </thead>
            <tbody>
              {db.projectStocks.map(s => {
                const sum = stockSummary(db, s.id)
                return (
                  <tr key={s.id}>
                    <td><b>{s.stockNo}</b></td>
                    <td>{sum.total}</td>
                    <td><span className={`badge ${sum.available > 0 ? 'green' : 'red'}`}>{sum.available}</span></td>
                    <td>{sum.allocated}</td>
                    <td>{sum.issued}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Job ล่าสุด</h3><Link to="/jobs">ดูทั้งหมด →</Link></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job No.</th><th>ลูกค้า</th><th>สถานะ</th><th>LBS</th></tr></thead>
            <tbody>
              {db.jobs.slice(-6).reverse().map(j => {
                const allocated = db.lbsUnits.filter(u => u.jobId === j.id && u.status !== 'in_stock').length
                return (
                  <tr key={j.id}>
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
