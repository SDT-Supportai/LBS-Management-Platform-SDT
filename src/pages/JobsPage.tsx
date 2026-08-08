import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { deriveJobStatus, jobAllocatedQty, jobDueDate, jobDaysLeft, todayIso, DUE_WARN_DAYS } from '../data/logic'
import { BudgetFields, InstallSitesEditor, JobStatusBadge, Modal, toBudgetNum, useTryAction, emptyCostForm, costFormToApi, type CostForm, type InstallSite } from '../ui/components'
import { fmtDate, JOB_STATUS_LABEL } from '../ui/format'
import type { JobStatus } from '../types'

const FILTERS: (JobStatus | 'all' | 'active')[] = ['all', 'active', 'draft', 'allocated', 'procuring_accessory', 'ready_to_issue', 'issued', 'installed', 'cancelled']

export default function JobsPage() {
  const { db, user, act } = useStore()
  const navigate = useNavigate()
  const tryAction = useTryAction()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active')
  const [mineOnly, setMineOnly] = useState(false)   // 0042: กรองเฉพาะงานที่ตัวเองเปิด
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ jobNo: '', customerName: '', contactPhone: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '' })
  const [costs, setCosts] = useState<CostForm>(emptyCostForm())
  const [installSites, setInstallSites] = useState<InstallSite[]>([])

  const canManage = can(user, 'job.manage')
  // 0042: Project ทำรายการได้เฉพาะงานที่ตัวเองเปิด → ต้องเห็นว่าใบไหนของใคร + กรองเฉพาะของตัวเองได้
  const isProject = user?.department === 'project'
  const userOf = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  const today = todayIso()
  // เรียงตาม "กำหนดส่ง" ใกล้สุดก่อน (sync Dashboard Job List) — งานที่ยังไม่ระบุกำหนดไปท้ายรายการ
  // งานที่จบแล้ว (installed/cancelled) ไม่มีอะไรต้องเร่ง → เรียงใหม่→เก่าตามเดิม
  const jobs = db.jobs
    .map(j => ({ job: j, status: deriveJobStatus(db, j), due: jobDueDate(j), daysLeft: jobDaysLeft(j, today) }))
    .filter(({ status }) =>
      filter === 'all' ? true
      : filter === 'active' ? status !== 'installed' && status !== 'cancelled'
      : status === filter)
    .filter(({ job }) => !mineOnly || job.openedBy === user?.id)
    .reverse()
    .sort((a, b) => {
      const done = (s: typeof a.status) => s === 'installed' || s === 'cancelled'
      if (done(a.status) !== done(b.status)) return done(a.status) ? 1 : -1   // งานที่จบแล้วลงล่างสุด
      if (done(a.status)) return 0                                            // คงลำดับใหม่→เก่าจาก reverse()
      return (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31')
    })
  const overdue = jobs.filter(x => x.daysLeft !== undefined && x.daysLeft < 0
    && x.status !== 'installed' && x.status !== 'cancelled').length
  const dueSoon = jobs.filter(x => x.daysLeft !== undefined && x.daysLeft >= 0 && x.daysLeft <= DUE_WARN_DAYS
    && x.status !== 'installed' && x.status !== 'cancelled').length

  const submit = async () => {
    const { salePrice, ...rest } = form
    // จุดติดตั้งเพิ่มเติมมีผลเฉพาะ LBS > 1
    const sites = rest.lbsQtyRequired > 1 ? installSites : []
    if (await tryAction(
      () => act.createJob({ ...rest, budgetSalePrice: toBudgetNum(salePrice), budgetCosts: costFormToApi(costs), installSites: sites }),
      'เปิด Job ใหม่เรียบร้อย',
    )) {
      setShowCreate(false)
      setForm({ jobNo: '', customerName: '', contactPhone: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '' })
      setCosts(emptyCostForm())
      setInstallSites([])
    }
  }

  return (
    <>
      <div className="page-title">Project ID (Jobs)</div>
      <div className="page-sub">
        เปิดและติดตามงานโครงการตาม Scope ลูกค้า — สถานะไหลอัตโนมัติ Draft → Allocated → Procuring Accessory → Ready to Issue → Issued → Installed ·
        <b> เรียงตามกำหนดส่ง (ใกล้สุดก่อน)</b> · 🔴 เลยกำหนด · ⚠️ เหลือ ≤{DUE_WARN_DAYS} วัน
        {(overdue > 0 || dueSoon > 0) && (
          <>
            {' '}
            {overdue > 0 && <span className="badge red">เลยกำหนด {overdue}</span>}{' '}
            {dueSoon > 0 && <span className="badge amber">≤{DUE_WARN_DAYS} วัน {dueSoon}</span>}
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {canManage && <button className="primary" onClick={() => setShowCreate(true)}>+ เปิด Job ใหม่</button>}
        <select style={{ width: 'auto' }} value={filter} onChange={e => setFilter(e.target.value as typeof FILTERS[number])}>
          <option value="active">เฉพาะงานที่กำลังดำเนินการ</option>
          <option value="all">ทุกสถานะ</option>
          {FILTERS.slice(2).map(f => <option key={f} value={f}>{JOB_STATUS_LABEL[f as JobStatus]}</option>)}
        </select>
        {isProject && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} />
            <span>เฉพาะงานของฉัน</span>
          </label>
        )}
      </div>
      {isProject && (
        <div className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
          🔒 ดำเนินการได้เฉพาะ Job ที่คุณเปิดเอง — ใบอื่นเปิดดูข้อมูลได้ครบ แต่ทำรายการไม่ได้
        </div>
      )}

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Job No.</th><th>ลูกค้า / Scope</th><th>ผู้รับผิดชอบ</th><th>สถานที่ติดตั้ง</th><th>กำหนดส่ง</th><th>เหลือ</th>
                <th>LBS (ดึงแล้ว/Scope)</th><th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && <tr><td colSpan={8}><div className="empty">ไม่มี Job ในสถานะนี้</div></td></tr>}
              {jobs.map(({ job, status, due, daysLeft }) => {
                const allocated = (status === 'issued' || status === 'installed')
                  ? db.lbsUnits.filter(u => u.jobId === job.id && u.status === 'issued').length
                  : jobAllocatedQty(db, job.id)
                // งานที่จบแล้วไม่ต้องเตือน — เหลือแต่ข้อมูลกำหนดส่งไว้อ้างอิง
                const active = status !== 'installed' && status !== 'cancelled'
                const late = active && daysLeft !== undefined && daysLeft < 0
                const soon = active && daysLeft !== undefined && daysLeft >= 0 && daysLeft <= DUE_WARN_DAYS
                return (
                  <tr key={job.id} className="clickable" onClick={() => navigate(`/jobs/${job.id}`)}>
                    <td><b>{job.jobNo}</b></td>
                    <td>{job.customerName}<div className="muted">{job.scope}</div></td>
                    <td>
                      {job.openedBy ? userOf(job.openedBy) : <span className="muted">ไม่ระบุ</span>}
                      {isProject && job.openedBy === user?.id && <span className="badge green" style={{ marginLeft: 6 }}>ของฉัน</span>}
                    </td>
                    <td>{job.installLocation || '-'}{job.installSites?.length ? <span className="badge blue" style={{ marginLeft: 6 }}>+{job.installSites.length} จุด</span> : null}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {late && <span title="เลยกำหนดส่งแล้ว">🔴 </span>}
                      {soon && <span title={`เหลือ ≤ ${DUE_WARN_DAYS} วันก่อนกำหนดส่ง`}>⚠️ </span>}
                      {due ? fmtDate(due) : <span className="muted">ยังไม่ระบุ</span>}
                      {(job.installSites?.length ?? 0) > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>ใกล้สุดจาก {(job.installSites?.length ?? 0) + 1} จุด</div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!active || daysLeft === undefined ? <span className="muted">-</span>
                        : late ? <span className="badge red">เลย {Math.abs(daysLeft)} วัน</span>
                        : soon ? <span className="badge amber">{daysLeft} วัน</span>
                        : <span className="muted">{daysLeft} วัน</span>}
                    </td>
                    <td>
                      {allocated}/{job.lbsQtyRequired}
                      <div className="progress"><div style={{ width: `${Math.min(100, (allocated / job.lbsQtyRequired) * 100)}%` }} /></div>
                    </td>
                    <td><JobStatusBadge status={status} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <Modal
          title="เปิด Job ใหม่ (Project Dept)"
          size="wide"
          onClose={() => setShowCreate(false)}
          footer={<>
            <button onClick={() => setShowCreate(false)}>ยกเลิก</button>
            <button className="primary" onClick={submit}>เปิด Job</button>
          </>}
        >
          <label className="field"><span>Job No. * (กรอกเลขงานเอง — ห้ามซ้ำ)</span>
            <input className="mono" value={form.jobNo} onChange={e => setForm({ ...form, jobNo: e.target.value })} placeholder="เช่น JOB-2026-0005" />
          </label>
          <div className="row">
            <label className="field"><span>ชื่อลูกค้า *</span>
              <input value={form.customerName} onChange={e => setForm({ ...form, customerName: e.target.value })} placeholder="PEA เชียงใหม่" />
            </label>
            <label className="field"><span>เบอร์ติดต่อ</span>
              <input value={form.contactPhone} onChange={e => setForm({ ...form, contactPhone: e.target.value })} placeholder="08x-xxx-xxxx" />
            </label>
          </div>
          <label className="field"><span>Scope งาน</span>
            <textarea rows={2} value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })} placeholder="ติดตั้ง LBS สถานีย่อย 4 จุด" />
          </label>
          <div className="row">
            <label className="field"><span>สถานที่ติดตั้ง{form.lbsQtyRequired > 1 ? ' (จุดที่ 1)' : ''}</span>
              <input value={form.installLocation} onChange={e => setForm({ ...form, installLocation: e.target.value })} />
            </label>
            <label className="field"><span>วันที่ต้องการติดตั้ง</span>
              <input type="date" value={form.requiredDate} onChange={e => setForm({ ...form, requiredDate: e.target.value })} />
            </label>
          </div>
          <label className="field"><span>จำนวน LBS ตาม Scope (เครื่อง) *</span>
            <input type="number" min={1} value={form.lbsQtyRequired}
              onChange={e => setForm({ ...form, lbsQtyRequired: Number(e.target.value) })} />
          </label>
          {form.lbsQtyRequired > 1 && (
            <div style={{ marginBottom: 4 }}>
              <div className="muted" style={{ marginBottom: 6 }}>จุดติดตั้งเพิ่มเติม (ติดตั้งหลายจุดได้เมื่อมี LBS มากกว่า 1 เครื่อง)</div>
              <InstallSitesEditor sites={installSites} onChange={setInstallSites} max={form.lbsQtyRequired - 1} />
            </div>
          )}
          <div className="budget-legend">Project Budget</div>
          <BudgetFields
            sale={form.salePrice} costs={costs}
            onSale={v => setForm({ ...form, salePrice: v })}
            onCosts={setCosts}
          />
        </Modal>
      )}
    </>
  )
}
