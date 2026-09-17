import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { deriveJobStatus, jobAllocatedQty, jobDelivery, todayIso, parseLatLng, DUE_WARN_DAYS } from '../data/logic'
import { BudgetFields, CoordInput, DeliveryBadge, InstallSitesEditor, JobStatusBadge, Modal, toBudgetNum, useTryAction, emptyCostForm, costFormToApi, sitesToApi, type CostForm, type InstallSite } from '../ui/components'
import { fmtDate, JOB_STATUS_LABEL } from '../ui/format'
import type { JobStatus } from '../types'

const FILTERS: (JobStatus | 'all' | 'active' | 'at_risk')[] = ['all', 'active', 'at_risk', 'draft', 'allocated', 'procuring_accessory', 'ready_to_issue', 'partially_issued', 'issued', 'installed', 'cancelled']

export default function JobsPage() {
  const { db, user, act } = useStore()
  const navigate = useNavigate()
  const tryAction = useTryAction()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active')
  const [mineOnly, setMineOnly] = useState(false)   // 0042: กรองเฉพาะงานที่ตัวเองเปิด
  const [showCreate, setShowCreate] = useState(false)
  // planCoord = พิกัดจุดติดตั้งที่ 1 (0060) — เก็บเป็นข้อความ "lat, lng" แปลงตอน submit
  const [form, setForm] = useState({ jobNo: '', customerName: '', contactPhone: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '', planCoord: '' })
  const [costs, setCosts] = useState<CostForm>(emptyCostForm())
  const [installSites, setInstallSites] = useState<InstallSite[]>([])

  const canManage = can(user, 'job.manage')
  // 0042: Project ทำรายการได้เฉพาะงานที่ตัวเองเปิด → ต้องเห็นว่าใบไหนของใคร + กรองเฉพาะของตัวเองได้
  const isProject = user?.department === 'project'
  const userOf = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  const today = todayIso()
  // เรียงตาม "กำหนดส่ง" ใกล้สุดก่อน (sync Dashboard Job List) — งานที่ยังไม่ระบุกำหนดไปท้ายรายการ
  // งานที่จบแล้ว (installed/cancelled) ไม่มีอะไรต้องเร่ง → เรียงใหม่→เก่าตามเดิม
  // 0075: เรียง/เตือนจาก jobDelivery ตัวเดียวกับ Dashboard — ห้ามคำนวณ daysLeft < 0 เองอีก
  const allJobs = db.jobs.map(j => ({ job: j, status: deriveJobStatus(db, j), d: jobDelivery(db, j, today) }))
  const jobs = allJobs
    .filter(({ status, d }) =>
      filter === 'all' ? true
      : filter === 'active' ? status !== 'installed' && status !== 'cancelled'
      : filter === 'at_risk' ? d.atRisk          // ไม่ใช่สถานะงาน แต่เป็น "ใบที่ต้องลงมือวันนี้"
      : status === filter)
    .filter(({ job }) => !mineOnly || job.openedBy === user?.id)
    .reverse()
    .sort((a, b) => {
      const done = (s: typeof a.status) => s === 'installed' || s === 'cancelled'
      if (done(a.status) !== done(b.status)) return done(a.status) ? 1 : -1   // งานที่จบแล้วลงล่างสุด
      if (done(a.status)) return 0                                            // คงลำดับใหม่→เก่าจาก reverse()
      return (a.d.due ?? '9999-12-31').localeCompare(b.d.due ?? '9999-12-31')
    })
  // นับจากงานทั้งหมด ไม่ใช่จากรายการที่ถูกกรองอยู่ — ไม่งั้นตัวเลขเตือนเปลี่ยนตามตัวกรองที่เพิ่งเลือก
  const overdue = allJobs.filter(x => x.d.state === 'overdue').length
  const blocked = allJobs.filter(x => x.d.state === 'blocked').length
  const visitOverdue = allJobs.filter(x => x.d.state === 'visit_overdue').length
  const lateButMoving = allJobs.filter(x => x.d.isLate && !x.d.atRisk
    && (x.d.state === 'installing' || x.d.state === 'awaiting_visit')).length
  const dueSoon = allJobs.filter(x => x.d.state === 'due_soon').length

  const submit = async () => {
    const { salePrice, planCoord, ...rest } = form
    // จุดติดตั้งเพิ่มเติมมีผลเฉพาะ LBS > 1
    const sites = rest.lbsQtyRequired > 1 ? installSites : []
    if (await tryAction(
      // parseLatLng/sitesToApi โยน error ถ้าพิกัดใช้ไม่ได้ → ต้องอยู่ในนี้ให้ tryAction จับ
      () => {
        const c = parseLatLng(planCoord)
        return act.createJob({
          ...rest, budgetSalePrice: toBudgetNum(salePrice), budgetCosts: costFormToApi(costs),
          installSites: sitesToApi(sites), planLat: c?.lat, planLng: c?.lng,
        })
      },
      'เปิด Job ใหม่เรียบร้อย',
    )) {
      setShowCreate(false)
      setForm({ jobNo: '', customerName: '', contactPhone: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '', planCoord: '' })
      setCosts(emptyCostForm())
      setInstallSites([])
    }
  }

  return (
    <>
      <div className="page-title">Project ID (Jobs)</div>
      <div className="page-sub">
        เปิดและติดตามงานโครงการตาม Scope ลูกค้า — สถานะไหลอัตโนมัติ Draft → Allocated → Procuring Accessory → Ready to Issue → Issued → Installed ·
        <b> เรียงตามกำหนดส่ง (ใกล้สุดก่อน)</b> · 🔴 เลยกำหนดส่งทั้งที่ของยังไม่ออกจากคลัง ·
        🚚 เบิกของแล้วรอถึงวันนัด · 🔧 กำลังติดตั้งตามนัด · ⏰ เลยวันนัดติดตั้ง · ⚠️ ใกล้ครบกำหนด ≤{DUE_WARN_DAYS} วัน
        {(overdue > 0 || blocked > 0 || visitOverdue > 0 || lateButMoving > 0 || dueSoon > 0) && (
          <>
            {' '}
            {overdue > 0 && <span className="badge red">เลยกำหนดส่ง {overdue}</span>}{' '}
            {blocked > 0 && <span className="badge red">ติดปัญหาหน้างาน {blocked}</span>}{' '}
            {visitOverdue > 0 && <span className="badge red">เลยวันนัดติดตั้ง {visitOverdue}</span>}{' '}
            {lateButMoving > 0 && <span className="badge amber">เลยกำหนดส่งแต่งานเดินอยู่ {lateButMoving}</span>}{' '}
            {dueSoon > 0 && <span className="badge amber">≤{DUE_WARN_DAYS} วัน {dueSoon}</span>}
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {canManage && <button className="primary" onClick={() => setShowCreate(true)}>+ เปิด Job ใหม่</button>}
        <select style={{ width: 'auto' }} value={filter} onChange={e => setFilter(e.target.value as typeof FILTERS[number])}>
          <option value="active">เฉพาะงานที่กำลังดำเนินการ</option>
          <option value="all">ทุกสถานะ</option>
          <option value="at_risk">⚠️ เฉพาะงานที่ต้องเร่ง ({overdue + blocked + visitOverdue})</option>
          {FILTERS.slice(3).map(f => <option key={f} value={f}>{JOB_STATUS_LABEL[f as JobStatus]}</option>)}
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
                <th>Job No.</th><th>ลูกค้า / Scope</th><th>ผู้รับผิดชอบ</th><th>สถานที่ติดตั้ง</th><th>กำหนดส่ง</th><th>สถานะกำหนดส่ง</th>
                <th>LBS (ดึงแล้ว/Scope)</th><th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && <tr><td colSpan={8}><div className="empty">ไม่มี Job ในสถานะนี้</div></td></tr>}
              {jobs.map(({ job, status, d }) => {
                // 0059: jobAllocatedQty นับ allocated + issued แล้ว — ไม่ต้องแยกเคสตามสถานะอีก
                //   (workaround เดิมมีเพราะฟังก์ชันนับแค่ allocated ทำให้งานที่เบิกแล้วโชว์ 0/N)
                const allocated = jobAllocatedQty(db, job.id)
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
                      {d.due ? fmtDate(d.due) : <span className="muted">ยังไม่ระบุ</span>}
                      {/* ขยายกำหนดแล้วต้องเห็นกำหนดตามสัญญาเดิมคู่กันเสมอ */}
                      {d.extension && d.contractDue && (
                        <div className="muted" style={{ fontSize: 11 }}
                          title={`เลื่อน ${d.extensionCount} ครั้ง · ล่าสุด: ${d.extension.reason}`}>
                          เลื่อนจาก {fmtDate(d.contractDue)} ({d.extensionCount} ครั้ง)
                        </div>
                      )}
                      {(job.installSites?.length ?? 0) > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>ใกล้สุดจาก {(job.installSites?.length ?? 0) + 1} จุด</div>
                      )}
                      {/* นาฬิกาเรือนที่ 2 — วันนัดที่ทีมช่างออกไซต์ ต้องเห็นคู่กับกำหนดส่งเสมอ (0075) */}
                      {d.visitStart && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          นัดติดตั้ง {fmtDate(d.visitStart)}
                          {d.visitEnd && d.visitEnd !== d.visitStart && <> – {fmtDate(d.visitEnd)}</>}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {d.state === 'closed' ? <span className="muted">-</span> : <DeliveryBadge d={d} />}
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
            <label className="field"><span>พิกัดจุดที่ 1 (ว่างได้ — ใส่แล้วขึ้นหมุดบนหน้า Map Tracking)</span>
              <CoordInput value={form.planCoord} onChange={v => setForm({ ...form, planCoord: v })} />
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
