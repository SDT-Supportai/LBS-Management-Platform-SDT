import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { deriveJobStatus, jobAllocatedQty } from '../data/logic'
import { BudgetFields, JobStatusBadge, Modal, toBudgetNum, useTryAction } from '../ui/components'
import { fmtDate, JOB_STATUS_LABEL } from '../ui/format'
import type { JobStatus } from '../types'

const FILTERS: (JobStatus | 'all' | 'active')[] = ['all', 'active', 'draft', 'allocated', 'procuring_accessory', 'ready_to_issue', 'issued', 'installed', 'cancelled']

export default function JobsPage() {
  const { db, user, act } = useStore()
  const navigate = useNavigate()
  const tryAction = useTryAction()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ jobNo: '', customerName: '', contactPhone: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '', cost: '' })

  const canManage = can(user, 'job.manage')
  const jobs = db.jobs
    .map(j => ({ job: j, status: deriveJobStatus(db, j) }))
    .filter(({ status }) =>
      filter === 'all' ? true
      : filter === 'active' ? status !== 'installed' && status !== 'cancelled'
      : status === filter)
    .reverse()

  const submit = async () => {
    const { salePrice, cost, ...rest } = form
    if (await tryAction(
      () => act.createJob({ ...rest, budgetSalePrice: toBudgetNum(salePrice), budgetCost: toBudgetNum(cost) }),
      'เปิด Job ใหม่เรียบร้อย',
    )) {
      setShowCreate(false)
      setForm({ jobNo: '', customerName: '', contactPhone: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '', cost: '' })
    }
  }

  return (
    <>
      <div className="page-title">Jobs</div>
      <div className="page-sub">
        Project Dept เปิด Job ตาม Scope ลูกค้า — สถานะไหลอัตโนมัติ: Draft → Allocated → Procuring Accessory → Ready to Issue → Issued/Installed
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {canManage && <button className="primary" onClick={() => setShowCreate(true)}>+ เปิด Job ใหม่</button>}
        <select style={{ width: 'auto' }} value={filter} onChange={e => setFilter(e.target.value as typeof FILTERS[number])}>
          <option value="active">เฉพาะงานที่กำลังดำเนินการ</option>
          <option value="all">ทุกสถานะ</option>
          {FILTERS.slice(2).map(f => <option key={f} value={f}>{JOB_STATUS_LABEL[f as JobStatus]}</option>)}
        </select>
      </div>

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Job No.</th><th>ลูกค้า / Scope</th><th>สถานที่ติดตั้ง</th><th>กำหนดส่ง</th>
                <th>LBS (ดึงแล้ว/Scope)</th><th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && <tr><td colSpan={6}><div className="empty">ไม่มี Job ในสถานะนี้</div></td></tr>}
              {jobs.map(({ job, status }) => {
                const allocated = (status === 'issued' || status === 'installed')
                  ? db.lbsUnits.filter(u => u.jobId === job.id && u.status === 'issued').length
                  : jobAllocatedQty(db, job.id)
                return (
                  <tr key={job.id} className="clickable" onClick={() => navigate(`/jobs/${job.id}`)}>
                    <td><b>{job.jobNo}</b></td>
                    <td>{job.customerName}<div className="muted">{job.scope}</div></td>
                    <td>{job.installLocation || '-'}</td>
                    <td>{fmtDate(job.requiredDate)}</td>
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
            <label className="field"><span>สถานที่ติดตั้ง</span>
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
          <div className="budget-legend">Project Budget</div>
          <BudgetFields
            sale={form.salePrice} cost={form.cost}
            onSale={v => setForm({ ...form, salePrice: v })}
            onCost={v => setForm({ ...form, cost: v })}
          />
        </Modal>
      )}
    </>
  )
}
