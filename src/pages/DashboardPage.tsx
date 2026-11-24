import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import {
  deriveJobStatus, jobStatusPhase, stockSummary, jobInstallSummary, jobIsFieldActive, jobAllocatedQty,
  jobDelivery, todayIso, DUE_WARN_DAYS, stockComments,
} from '../data/logic'
import { DeliveryBadge, JobStatusBadge, useTryAction } from '../ui/components'
import { MyWorkPanel } from '../ui/flow'
import { StackBar, KpiLegend, ProgressRing, lbsCountTone } from '../ui/kpi'
import { StockBalanceCard } from '../ui/StockBalance'
import { myWork, purchasingCounts } from '../data/flow'
import { jobNeedsTeam } from '../data/field'
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
      acc.noContract += sum.noContract; acc.drawable += sum.drawable
      return acc
    },
    // ไม่เก็บ available (= in_stock ทั้งหมด) แยก — ทับซ้อนกับ onHand + pending + unknown
    { total: 0, pending: 0, onHand: 0, unknown: 0, allocated: 0, issued: 0, noContract: 0, drawable: 0 },
  )

  const statusCount = new Map<JobStatus, number>()
  db.jobs.forEach(j => {
    const st = deriveJobStatus(db, j)
    statusCount.set(st, (statusCount.get(st) ?? 0) + 1)
  })

  // เฟส 3: กล่องงานของฉัน — สิ่งที่รอผู้ใช้คนนี้จากทุกหน้า · คำขอที่รอ Division (ช่องใหม่บนเส้นทางงาน)
  const work = myWork(db, user, today)
  const pendingReqs = db.approvalRequests.filter(r => r.status === 'pending')

  // รีวิวเฟส 4: ตัวนับชุดเดียวกับหน้า Purchasing (รวม PR ที่ออก PO บางส่วน)
  const { prAwaitingPo, poAwaitingGoods } = purchasingCounts(db)

  // ฝั่ง Service — คืบหน้าติดตั้งรายเครื่องของงานที่เบิกแล้ว + งานที่ยังไม่มอบหมายทีม
  // 0071: นับงานที่เบิกบางส่วนด้วย ไม่งั้นการ์ดนี้ขัดกับหน้า Service/Scheduling ที่นับไปแล้ว
  //   และนับ "เครื่อง" จากของที่ออกไปอยู่กับช่างจริง (outTotal) ไม่ใช่ทุกเครื่องบนใบ
  //   — งานที่เบิกครบแล้ว outTotal === total จึงไม่เปลี่ยนตัวเลขเดิมของงานปกติ
  const issuedJobs = db.jobs.filter(j => jobIsFieldActive(db, j))
  const svc = issuedJobs.reduce((acc, j) => {
    const s = jobInstallSummary(db, j.id)
    acc.units += s.outTotal; acc.installed += s.outInstalled; acc.blocked += s.outBlocked
    if (jobNeedsTeam(db, j)) acc.unassigned++          // เฟส 5: กติกาเดียวทุกหน้า (ติดตั้งครบแล้วไม่นับ)
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
  // "เลยกำหนดส่ง" = เลยจริงและของยังไม่ออกจากคลัง · งานที่เดินอยู่หน้างานแยกไปอีกตัวนับ
  const overdue = jobList.filter(x => x.d.state === 'overdue').length
  const blocked = jobList.filter(x => x.d.state === 'blocked').length
  const visitOverdue = jobList.filter(x => x.d.state === 'visit_overdue').length
  // เลยกำหนดส่งแล้ว แต่งานเดินอยู่จริง (อยู่ในช่วงนัด / รอถึงวันนัด) — ต้องตามให้ขยายกำหนดส่ง ไม่ใช่เร่ง
  const lateButMoving = jobList.filter(x => x.d.isLate && !x.d.atRisk
    && (x.d.state === 'installing' || x.d.state === 'awaiting_visit')).length
  const dueSoon = jobList.filter(x => x.d.state === 'due_soon').length
  const awaitingClose = jobList.filter(x => x.d.state === 'awaiting_close').length
  // ติดตั้งครบแต่ยังกดปิดไม่ได้ (รอ Division/Purchasing) — แยกจาก "รอปิดงาน" ไม่ให้ยอดเกินจริง (รีวิวเฟส 2)
  const awaitingClearance = jobList.filter(x => x.d.state === 'awaiting_clearance').length
  // การ์ด KPI Glass — ตัวเลขชุดเดิม ตั้งชื่อไว้ใช้หลายจุด
  const activeJobs = db.jobs.filter(j => !j.terminalStatus || j.terminalStatus === 'issued').length
  const partial = statusCount.get('partially_issued') ?? 0
  const installDone = svc.units > 0 && svc.installed >= svc.units

  return (
    <div className="dash">
      <div className="aurora" aria-hidden="true"><span className="a1" /><span className="a2" /><span className="a3" /></div>
      <div className="page-title">Dashboard</div>
      <div className="page-sub">ภาพรวมเรียลไทม์ — สต็อก 115kV LBS · สถานะงานโครงการ · งานค้างระหว่างแผนก</div>

      {/* เฟส 3 — งานของฉัน: เห็นงานที่รอตัวเองทันทีหลัง login ไม่ต้องไล่เปิดทุกหน้า */}
      <MyWorkPanel items={work} user={user} today={today} />

      {/* การ์ด KPI แบบ Glass (canvas หน้า 2 · 2026-11-24) — ตัวเลข/ลิงก์/คำเตือนมาจากที่มาเดิมทั้งหมด
          เดิม 5 การ์ด → 4 (PR + PO รวมเป็นการ์ด Purchasing) · คำเตือนที่แบบไม่มีแต่แอปมี ขึ้นเป็นบรรทัดเล็ก (.kpi-notes) เมื่อมีค่า */}
      <div className="kpi-grid">
        <section className="card kpi-card" aria-label="Total LBS Target Plan">
          <div className="kpi-label blue">Total LBS Target Plan</div>
          <div className="kpi-big">{totals.total} <span className="kpi-unit">เครื่อง</span></div>
          <StackBar total={totals.total} parts={[
            { label: 'พร้อมดึง', value: totals.drawable, tone: 'green' },
            { label: 'รอเข้าคลัง', value: totals.pending, tone: 'amber' },
            { label: 'ถูกดึงเข้า Job', value: totals.allocated, tone: 'violet' },
            { label: 'เบิกติดตั้งแล้ว', value: totals.issued, tone: 'blue' },
          ]} />
          <KpiLegend items={[
            { label: 'พร้อมดึง', value: totals.drawable, tone: 'green', title: `ถึงคลังแล้ว และมี Contract No. — ดึงเข้า Job ได้ทันที (On Hand ${totals.onHand})` },
            { label: 'รอเข้าคลัง', value: totals.pending, tone: 'amber', emphasis: 'amber', title: 'ของยังไม่ถึงคลัง — ดึงจองเข้า Job ได้ (ถ้ามี Contract No.) แต่เบิกให้ Service ไม่ได้จนกว่าจะถึง' },
            { label: 'ถูกดึงเข้า Job', value: totals.allocated, tone: 'violet' },
            { label: 'เบิกติดตั้งแล้ว', value: totals.issued, tone: 'blue' },
          ]} />
          {(totals.noContract > 0 || totals.unknown > 0) && (
            <div className="kpi-notes">
              {totals.noContract > 0 && <Link to="/stocks?f=no_contract" title="ดึงเข้า Job ได้เฉพาะเครื่องที่มี Contract No. แล้ว — Division กรอกที่ LBS Inventory"><b style={{ color: 'var(--danger)' }}>ไม่มี Contract No. {totals.noContract} (ดึงไม่ได้)</b></Link>}
              {totals.unknown > 0 && <b title="ยังไม่ระบุ ETA to WH — กรอก FOB date ให้ครบเพื่อให้ระบบคำนวณ Status ได้">ไม่ระบุ ETA {totals.unknown}</b>}
            </div>
          )}
        </section>

        <section className="card kpi-card" aria-label="Jobs In Progress">
          <div className="kpi-label violet">Jobs In Progress</div>
          <div className="kpi-big"><Link to="/jobs?f=active">{activeJobs}</Link> <span className="kpi-unit">งาน</span></div>
          <StackBar total={activeJobs} parts={[
            { label: 'Draft', value: statusCount.get('draft') ?? 0, tone: 'violet' },
            { label: 'พร้อมเบิก', value: statusCount.get('ready_to_issue') ?? 0, tone: 'green' },
            { label: 'รอปิดงาน', value: awaitingClose, tone: 'blue' },
          ]} />
          <KpiLegend items={[
            { label: 'Draft', value: statusCount.get('draft') ?? 0, tone: 'violet' },
            { label: 'รอปิดงาน', value: awaitingClose, tone: 'blue', emphasis: 'blue', title: 'ติดตั้งครบ กดปิดงานได้แล้ว' },
            { label: 'พร้อมเบิก', value: statusCount.get('ready_to_issue') ?? 0, tone: 'green', to: '/jobs?f=ready_to_issue' },
            /* 0075: "ต้องเร่ง" = ใบที่ไม่มีใครเดินอยู่จริง — เลยกำหนดส่งทั้งที่ของยังไม่ออกจากคลัง ·
               ติดปัญหาหน้างาน · เลยวันนัดติดตั้งแล้วยังไม่มีผลยืนยัน (ใบที่อยู่ในช่วงนัดไม่นับ) */
            { label: 'ต้องเร่ง', value: overdue + blocked + visitOverdue, tone: 'red', emphasis: 'red', to: '/jobs?f=at_risk',
              title: 'เลยกำหนดส่งทั้งที่ของยังไม่ออกจากคลัง · ติดปัญหาหน้างาน · หรือเลยวันนัดติดตั้งแล้วยังไม่มีผลยืนยัน' },
          ]} />
          {(lateButMoving > 0 || dueSoon > 0 || partial > 0 || (statusCount.get('issued') ?? 0) > 0 || pendingReqs.length > 0) && (
            <div className="kpi-notes">
              {lateButMoving > 0 && <b style={{ color: 'var(--amber, #d97706)' }} title="งานเดินอยู่ตามวันนัดติดตั้ง แต่เลยกำหนดส่งที่ให้ลูกค้าไว้ — ถ้าตกลงเลื่อนแล้วให้บันทึกขยายกำหนดส่ง">เลยกำหนดส่งแต่งานเดินอยู่ {lateButMoving} งาน</b>}
              {dueSoon > 0 && <b style={{ color: 'var(--amber, #d97706)' }}>ใกล้ครบกำหนด {dueSoon} งาน</b>}
              {partial > 0 && <Link to="/jobs?f=partially_issued"><b style={{ color: '#8a5a00' }}>เบิกบางส่วน {partial}</b></Link>}
              {(statusCount.get('issued') ?? 0) > 0 && <Link to="/jobs?f=issued">รอติดตั้ง {statusCount.get('issued')} งาน</Link>}
              {pendingReqs.length > 0 && <Link to="/approvals"><b style={{ color: 'var(--amber, #d97706)' }} title="คำสั่งที่ยังไม่มีผลจนกว่า Division จะอนุมัติ">⏳ รอ Division พิจารณา {pendingReqs.length}</b></Link>}
            </div>
          )}
        </section>

        <section className="card kpi-card" aria-label="Purchasing">
          <div className="kpi-label amber">Purchasing (PR / PO)</div>
          <div className="kpi-tiles">
            {/* รีวิวเฟส 4: ตัวนับชุดเดียวกับหน้า Purchasing (รวม PR ที่ออก PO บางส่วน) */}
            <Link className="kpi-tile" to="/purchasing"><b className={prAwaitingPo > 0 ? 'warn' : undefined}>{prAwaitingPo}</b><span>PR รอออก PO</span></Link>
            <Link className="kpi-tile" to="/purchasing" title="รับของครบแล้ว Job จะขยับสถานะอัตโนมัติ"><b className={poAwaitingGoods > 0 ? 'warn' : undefined}>{poAwaitingGoods}</b><span>PO รอรับของ</span></Link>
          </div>
          {prAwaitingPo + poAwaitingGoods === 0
            ? <div className="kpi-ok"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>ไม่มีงานจัดซื้อค้าง</div>
            : <div className="kpi-ok warn">มีงานจัดซื้อค้าง {prAwaitingPo + poAwaitingGoods} รายการ</div>}
          <Link className="kpi-foot" to="/purchasing">ไปหน้า Purchasing →</Link>
        </section>

        <section className="card kpi-card" aria-label="Installation Work">
          <div className="kpi-label green">Installation Work (Service)</div>
          <div className="kpi-ring-wrap">
            <ProgressRing done={svc.installed} total={svc.units} />
            <div>
              <div className={`kpi-ring-val${installDone ? ' done' : ''}`}>{svc.installed}<small>/{svc.units} เครื่อง</small></div>
              <div style={{ marginTop: 6, color: '#334155', fontSize: 12.5 }}>
                {issuedJobs.length} งาน
                {installDone
                  ? <> · ติดตั้งครบ{awaitingClose > 0 ? ` รอปิดงาน ${awaitingClose} งาน` : ''}</>
                  : issuedJobs.length > 0 ? 'รอติดตั้ง' : ''}
              </div>
            </div>
          </div>
          {(svc.unassigned > 0 || svc.blocked > 0) && (
            <div className="kpi-notes">
              {svc.unassigned > 0 && <Link to="/scheduling"><b style={{ color: 'var(--danger)' }}>ยังไม่มอบหมายทีม {svc.unassigned} งาน</b></Link>}
              {svc.blocked > 0 && <span>ติดตั้งไม่ได้ {svc.blocked} เครื่อง</span>}
            </div>
          )}
          <Link className="kpi-foot" to="/scheduling">ตารางทีม →</Link>
        </section>
      </div>

      {/* Job List (ซ้าย) + LBS Stock Balance (ขวา) เคียงกันตามแบบ — จอแคบเรียงลง */}
      <div className="dash-split">
        <div className="dash-main">
      {/* Job List — เรียงตามกำหนดส่งที่มีผล (ใกล้สุดก่อน)
          0075: คอลัมน์ "เหลือ" กลายเป็น "สถานะกำหนดส่ง" ที่บอกทั้งเรื่องวันและเรื่องหน้างาน
          เดิมโชว์แค่ "เลย N วัน" สีแดง ⇒ งานที่ช่างกำลังติดตั้งอยู่ดูเหมือนงานที่ยังไม่มีใครแตะ */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            Job List <span className="muted" style={{ fontWeight: 400 }}>· เรียงตามกำหนดส่ง — งานที่ยังไม่ปิด</span>
            {overdue > 0 && <span className="badge red" style={{ marginLeft: 8 }} title="เลยกำหนดส่งทั้งที่ของยังไม่ออกจากคลัง">เลยกำหนดส่ง {overdue}</span>}
            {blocked > 0 && <span className="badge red" style={{ marginLeft: 6 }}>ติดปัญหาหน้างาน {blocked}</span>}
            {visitOverdue > 0 && <span className="badge red" style={{ marginLeft: 6 }} title="เลยวันนัดติดตั้งแล้วแต่ยังไม่มีผลยืนยันรายเครื่อง">เลยวันนัดติดตั้ง {visitOverdue}</span>}
            {lateButMoving > 0 && <span className="badge amber" style={{ marginLeft: 6 }} title="งานเดินอยู่ตามวันนัด แต่เลยกำหนดส่งที่ให้ลูกค้าไว้">เลยกำหนดส่งแต่งานเดินอยู่ {lateButMoving}</span>}
            {dueSoon > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>≤{DUE_WARN_DAYS} วัน {dueSoon}</span>}
            {awaitingClose > 0 && <span className="badge blue" style={{ marginLeft: 6 }} title="ติดตั้งครบ กดปิดงานได้แล้ว">รอปิดงาน {awaitingClose}</span>}
            {awaitingClearance > 0 && <span className="badge amber" style={{ marginLeft: 6 }} title="ติดตั้งครบแล้ว แต่ยังปิดงานไม่ได้ — มีคำขอรอ Division พิจารณา หรือของคืนรอ Purchasing ตรวจรับ">รอเคลียร์ก่อนปิดงาน {awaitingClearance}</span>}
          </h3>
          <Link to="/jobs">ดูทั้งหมด →</Link>
        </div>
        <div className="table-scroll">
          {/* Glass (canvas หน้า 2): เส้นคั่นแถว ไม่มีเส้นตั้ง · Job No. + ลูกค้าคอลัมน์เดียว · LBS ชิดขวา สีตามดึงครบ/ยังไม่ครบ */}
          <table className="job-list-tb">
            <thead><tr><th>กำหนดส่ง</th><th>สถานะกำหนดส่ง</th><th>Job No. / ลูกค้า</th><th>สถานะงาน</th><th style={{ textAlign: 'right' }}>LBS</th></tr></thead>
            <tbody>
              {jobList.length === 0 && (
                <tr><td colSpan={5}><div className="empty">ไม่มีงานที่กำลังดำเนินการ</div></td></tr>
              )}
              {jobList.slice(0, 8).map(({ job: j, d }) => {
                const allocated = jobAllocatedQty(db, j.id)   // 0059: allocated + issued (แหล่งเดียวกับหน้า Jobs)
                // หลายจุดติดตั้ง → วันที่แสดงคือจุดที่ใกล้ที่สุด บอกจำนวนจุดที่เหลือให้เห็นด้วย
                const extraSites = (j.installSites?.length ?? 0)
                return (
                  <tr key={j.id}>
                    <td className="due">
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
                      {/* 🔴 นาฬิกาเรือนที่ 2 — ต้องเห็นคู่กันเสมอ ไม่งั้นผู้บริหารอ่านป้าย
                          "เลยกำหนดส่ง" แล้วนึกว่าทีมยังไม่ได้ทำอะไร ทั้งที่อยู่ในช่วงนัดที่ตกลงกันไว้ */}
                      {d.visitStart && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          นัดติดตั้ง {fmtDate(d.visitStart)}
                          {d.visitEnd && d.visitEnd !== d.visitStart && <> – {fmtDate(d.visitEnd)}</>}
                        </div>
                      )}
                    </td>
                    <td style={{ minWidth: 150 }}><DeliveryBadge d={d} /></td>
                    <td>
                      <Link className="job-no" to={`/jobs/${j.id}`}>{j.jobNo}</Link>
                      <div className="cust">{j.customerName}</div>
                    </td>
                    <td><JobStatusBadge status={deriveJobStatus(db, j)} phase={jobStatusPhase(db, j)} /></td>
                    <td className={`lbs-count ${lbsCountTone(allocated, j.lbsQtyRequired)}`}>{allocated}/{j.lbsQtyRequired}</td>
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
        </div>

        {/* LBS — Stock Balance แบบการ์ด Glass (canvas หน้า 2 · 2026-11-24) — เดิมเป็นตาราง 8 คอลัมน์เหนือ Job List
            ตัวเลขชุดเดิมจาก stockSummary ครบทุกคอลัมน์ (แยก On Hand / Pending / ไม่ระบุ ETA เหมือนเดิม) */}
        <div className="dash-side">
          <StockBalanceCard
            rows={db.projectStocks.map(s => ({ id: s.id, stockNo: s.stockNo, closed: s.status === 'closed', sum: stockSummary(db, s.id) }))}
            totals={totals} />
        </div>
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
