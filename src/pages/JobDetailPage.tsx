import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { deriveJobStatus, jobBudgetSummary, pendingPurchasingReqs, stockSummary } from '../data/logic'
import { BudgetFields, JobStatusBadge, Modal, toBudgetNum, useTryAction } from '../ui/components'
import { ACC_STATUS_LABEL, PR_STATUS_LABEL, fmtBaht, fmtDate, fmtDateTime } from '../ui/format'
import type { LbsUnit } from '../types'

function SerialPicker({ units, selected, toggle }: {
  units: LbsUnit[]
  selected: Set<string>
  toggle: (id: string) => void
}) {
  return (
    <div className="serial-grid">
      {units.map(u => (
        <div key={u.id} className={`serial-pick${selected.has(u.id) ? ' selected' : ''}`} onClick={() => toggle(u.id)}>
          <input type="checkbox" readOnly checked={selected.has(u.id)} />
          <span className="mono">{u.serialLvb}</span>
        </div>
      ))}
      {units.length === 0 && <div className="muted">ไม่มีเครื่องให้เลือก</div>}
    </div>
  )
}

export default function JobDetailPage() {
  const { jobId } = useParams()
  const { db, user, act } = useStore()
  const navigate = useNavigate()
  const tryAction = useTryAction()

  const job = db.jobs.find(j => j.id === jobId)
  const [modal, setModal] = useState<'draw' | 'return' | 'accessory' | 'issue' | 'cancel' | 'edit' | null>(null)
  const [drawStock, setDrawStock] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [returnTarget, setReturnTarget] = useState('')
  const [accForm, setAccForm] = useState({ itemId: '', qty: 1, source: 'central_stock' as 'central_stock' | 'purchasing', unitPrice: '' })
  const [issueNote, setIssueNote] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [receivedToCentral, setReceivedToCentral] = useState(true)
  const [editForm, setEditForm] = useState({ customerName: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '', cost: '' })

  const status = job ? deriveJobStatus(db, job) : 'draft'
  const canManage = can(user, 'job.manage')
  const locked = !job || job.terminalStatus !== null

  const allocatedUnits = useMemo(
    () => db.lbsUnits.filter(u => u.jobId === jobId && (u.status === 'allocated' || u.status === 'issued')),
    [db.lbsUnits, jobId],
  )
  const accReqs = db.accessoryRequests.filter(r => r.jobId === jobId)
  const pendingReqs = job ? pendingPurchasingReqs(db, job.id) : []
  const receivedFromPo = accReqs.filter(r => r.source === 'purchasing' && r.status === 'received')
  const jobPrs = db.prs.filter(p => p.jobId === jobId)

  if (!job) return <div className="empty">ไม่พบ Job นี้ <Link to="/jobs">กลับหน้า Jobs</Link></div>

  const budget = jobBudgetSummary(db, job)
  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const stockOf = (id: string) => db.projectStocks.find(s => s.id === id)
  const userOf = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  const togglePick = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const openModal = (m: typeof modal) => { setPicked(new Set()); setModal(m) }
  const close = () => setModal(null)

  const drawableUnits = db.lbsUnits.filter(u => u.projectStockId === drawStock && u.status === 'in_stock')
  const returnableUnits = db.lbsUnits.filter(u => u.jobId === jobId && u.status === 'allocated')

  const accessoryItems = db.items.filter(i => i.itemType === 'accessory')
  const selAccItem = itemOf(accForm.itemId)
  const selAccStockQty = db.accessoryStock.find(r => r.itemId === accForm.itemId)?.qtyOnHand ?? 0

  return (
    <>
      <div style={{ marginBottom: 6 }}><Link to="/jobs">← กลับหน้า Jobs</Link></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="page-title">{job.jobNo}</div>
        <JobStatusBadge status={status} />
      </div>
      <div className="page-sub">
        {job.customerName} · {job.scope || 'ไม่ระบุ scope'} · ติดตั้งที่ {job.installLocation || '-'} · กำหนด {fmtDate(job.requiredDate)}
      </div>

      {job.terminalStatus === 'issued' && (
        <div className="panel"><div className="panel-body">
          <b>เบิกให้ Service แล้ว — รอติดตั้ง</b> เบิกเมื่อ {fmtDateTime(job.issuedAt)} — {job.issuedNote || 'ไม่มีบันทึกเพิ่มเติม'}
          <div className="muted">Job ถูกล็อก แก้ไข allocation หรือคืนของไม่ได้อีก · Service จะกดยืนยันเมื่อติดตั้งเสร็จ</div>
        </div></div>
      )}
      {job.terminalStatus === 'installed' && (
        <div className="panel"><div className="panel-body">
          <b style={{ color: 'var(--green)' }}>ติดตั้งเสร็จแล้ว</b> วันที่จริง {fmtDate(job.installedAt)} ยืนยันโดย {userOf(job.installConfirmedBy ?? '')}
          {job.installNote && <> — {job.installNote}</>}
          <div className="muted">เบิกเมื่อ {fmtDateTime(job.issuedAt)} · {job.issuedNote || ''}</div>
        </div></div>
      )}
      {job.terminalStatus === 'cancelled' && (
        <div className="panel"><div className="panel-body">
          <b style={{ color: 'var(--red)' }}>Job ถูกยกเลิก</b> เมื่อ {fmtDateTime(job.cancelledAt)} โดย {userOf(job.cancelledBy!)}
          — เหตุผล: {job.cancelReason} (LBS และ Accessory จากสต็อกกลางถูกคืนกลับสต็อกอัตโนมัติแล้ว)
        </div></div>
      )}

      {canManage && !locked && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => { setDrawStock(db.projectStocks.find(s => s.status === 'open')?.id ?? ''); openModal('draw') }}>+ ดึง LBS เข้า Job</button>
          <button onClick={() => { setReturnTarget(''); openModal('return') }} disabled={returnableUnits.length === 0}>คืน LBS กลับสต็อก</button>
          <button className="success" onClick={() => openModal('issue')} disabled={status !== 'ready_to_issue'}
            title={status !== 'ready_to_issue' ? 'ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ' : ''}>
            เบิกทั้งหมดให้ Service
          </button>
          <button onClick={() => {
            setEditForm({
              customerName: job.customerName, scope: job.scope, installLocation: job.installLocation,
              requiredDate: job.requiredDate, lbsQtyRequired: job.lbsQtyRequired,
              salePrice: job.budgetSalePrice !== undefined ? String(job.budgetSalePrice) : '',
              cost: job.budgetCost !== undefined ? String(job.budgetCost) : '',
            })
            openModal('edit')
          }}>แก้ไขข้อมูล Job</button>
          <button className="danger" onClick={() => { setCancelReason(''); setReceivedToCentral(true); openModal('cancel') }}>ยกเลิก Job</button>
          {db.allocations.every(a => a.jobId !== job.id) && accReqs.length === 0 && (
            <button className="danger" onClick={() => {
              if (confirm(`ลบ ${job.jobNo}? (ลบได้เฉพาะ Draft ที่ไม่มี transaction)`))
                tryAction(async () => { await act.deleteDraftJob({ jobId: job.id }); navigate('/jobs') }, `ลบ ${job.jobNo} แล้ว`)
            }}>ลบ Draft</button>
          )}
        </div>
      )}

      {/* ---------------- Project Budget ---------------- */}
      <div className="panel">
        <div className="panel-head"><h3>Project Budget</h3>
          <span className="muted">กำไร = ราคาขาย − ต้นทุน · ต้นทุนคงเหลือ = ต้นทุน − มูลค่าวัสดุ</span>
        </div>
        <div className="panel-body">
          <div className="budget-grid">
            <div className="budget-cell"><div className="b-label">ราคาขาย</div><div className="b-value">{fmtBaht(budget.salePrice)}</div></div>
            <div className="budget-cell"><div className="b-label">ต้นทุน</div><div className="b-value">{fmtBaht(budget.cost)}</div></div>
            <div className="budget-cell"><div className="b-label">กำไร{budget.margin !== undefined ? ` (${budget.margin.toFixed(1)}%)` : ''}</div>
              <div className={`b-value ${budget.profit !== undefined && budget.profit < 0 ? 'neg' : 'pos'}`}>{fmtBaht(budget.profit)}</div></div>
            <div className="budget-cell"><div className="b-label">มูลค่าวัสดุ (Purchase Orders)</div><div className="b-value">{fmtBaht(budget.materialValue)}</div></div>
            <div className="budget-cell"><div className="b-label">ต้นทุนคงเหลือ</div>
              <div className={`b-value ${budget.remainingCost !== undefined && budget.remainingCost < 0 ? 'neg' : 'pos'}`}>{fmtBaht(budget.remainingCost)}</div></div>
          </div>
        </div>
      </div>

      {/* ---------------- LBS allocation ---------------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>LBS ที่ดึงเข้า Job — {allocatedUnits.length}/{job.lbsQtyRequired} เครื่อง</h3>
          {allocatedUnits.length >= job.lbsQtyRequired
            ? <span className="badge green">ครบตาม Scope</span>
            : <span className="badge amber">ขาดอีก {job.lbsQtyRequired - allocatedUnits.length} เครื่อง</span>}
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th>มาจาก Stock</th><th>สถานะ</th></tr></thead>
            <tbody>
              {allocatedUnits.length === 0 && <tr><td colSpan={4}><div className="empty">ยังไม่ได้ดึง LBS — Job อยู่สถานะ Draft</div></td></tr>}
              {allocatedUnits.map(u => (
                <tr key={u.id}>
                  <td className="mono">{u.serialLvb}</td>
                  <td className="mono">{u.serialOm}</td>
                  <td>{stockOf(u.projectStockId)?.stockNo}</td>
                  <td>{u.status === 'allocated' ? <span className="badge blue">Allocated</span> : <span className="badge neutral">Issued</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Purchase Orders (วัสดุของ Job) ---------------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>Purchase Orders <span className="muted" style={{ fontWeight: 400 }}>· มูลค่าวัสดุ {fmtBaht(budget.materialValue)} · ต้นทุนคงเหลือ {fmtBaht(budget.remainingCost)}</span></h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {canManage && !locked && (
              <button className="small" onClick={() => { setAccForm({ itemId: accessoryItems[0]?.id ?? '', qty: 1, source: 'central_stock', unitPrice: '' }); openModal('accessory') }}>+ เพิ่มวัสดุ</button>
            )}
            {canManage && !locked && pendingReqs.length > 0 && (
              <button className="small primary" onClick={() =>
                tryAction(() => act.createPR({ jobId: job.id, requestIds: pendingReqs.map(r => r.id) }),
                  'ออก PR ส่งให้ Purchasing แล้ว')
              }>ออก PR ส่ง Purchasing ({pendingReqs.length} รายการ)</button>
            )}
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>รายการ</th><th>จำนวน</th><th>ราคา/หน่วย</th><th>มูลค่า</th><th>แหล่ง</th><th>สถานะ</th><th>PR / PO</th><th></th></tr></thead>
            <tbody>
              {accReqs.length === 0 && <tr><td colSpan={8}><div className="empty">ยังไม่มีรายการวัสดุ</div></td></tr>}
              {accReqs.map(r => {
                const item = itemOf(r.itemId)!
                const pr = db.prs.find(p => p.id === r.prId)
                const po = db.pos.find(p => p.prId === r.prId && p.status !== 'cancelled')
                const active = r.status !== 'cancelled' && r.status !== 'returned'
                const lineValue = active && r.unitPrice !== undefined ? r.unitPrice * r.qtyRequested : undefined
                return (
                  <tr key={r.id}>
                    <td>{item.name} <span className="muted mono">{item.code}</span></td>
                    <td>
                      {r.qtyRequested} {item.uom}
                      {r.source === 'purchasing' && (r.status === 'po_ordered' || r.status === 'received') && (
                        <div className="muted">รับแล้ว {r.qtyReceived}/{r.qtyRequested}</div>
                      )}
                    </td>
                    <td>{fmtBaht(r.unitPrice)}</td>
                    <td>{fmtBaht(lineValue)}</td>
                    <td>{r.source === 'central_stock' ? <span className="badge green">สต็อกกลาง</span> : <span className="badge amber">Purchasing</span>}</td>
                    <td><span className={`badge ${r.status === 'issued' || r.status === 'received' ? 'green' : r.status === 'cancelled' || r.status === 'returned' ? 'neutral' : 'amber'}`}>{ACC_STATUS_LABEL[r.status]}</span></td>
                    <td className="mono">{[pr?.prNo, po?.poNo].filter(Boolean).join(' / ') || '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canManage && !locked && active && (
                        <button className="small" onClick={() => {
                          const v = window.prompt(`ราคาต่อหน่วยของ ${item.name} (บาท/${item.uom})`, r.unitPrice !== undefined ? String(r.unitPrice) : '')
                          if (v !== null) tryAction(() => act.updateAccessoryRequestPrice({ requestId: r.id, unitPrice: v.trim() === '' ? undefined : Number(v) }), 'แก้ราคาแล้ว')
                        }}>แก้ราคา</button>
                      )}{' '}
                      {canManage && !locked && r.source === 'central_stock' && r.status === 'issued' && (
                        <button className="small" onClick={() => tryAction(() => act.returnAccessory({ requestId: r.id }), 'คืน Accessory กลับสต็อกกลางแล้ว')}>คืนสต็อก</button>
                      )}
                      {canManage && !locked && r.status === 'pending' && (
                        <>
                          <button className="small" onClick={() => {
                            const v = window.prompt(`จำนวนใหม่ของ ${item.name} (${item.uom})`, String(r.qtyRequested))
                            if (v !== null) tryAction(() => act.updateAccessoryRequestQty({ requestId: r.id, qty: Number(v) }), 'แก้จำนวนแล้ว')
                          }}>แก้จำนวน</button>{' '}
                          <button className="small danger" onClick={() => tryAction(() => act.cancelAccessoryRequest({ requestId: r.id }), 'ยกเลิกคำขอแล้ว')}>ยกเลิก</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {jobPrs.length > 0 && (
          <div className="panel-body muted">
            PR ของ Job นี้: {jobPrs.map(p =>
              `${p.prNo} (${PR_STATUS_LABEL[p.status]}${p.status === 'rejected' ? `: ${p.rejectReason}` : ''})`).join(' · ')}
          </div>
        )}
      </div>

      {/* ---------------- ประวัติ ---------------- */}
      <div className="panel">
        <div className="panel-head"><h3>ประวัติดึง/คืน LBS</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>เวลา</th><th>รายการ</th><th>Stock</th><th>Serial No.</th><th>โดย</th></tr></thead>
            <tbody>
              {db.allocations.filter(a => a.jobId === jobId).length === 0 &&
                <tr><td colSpan={5}><div className="empty">ยังไม่มีการดึง/คืน</div></td></tr>}
              {db.allocations.filter(a => a.jobId === jobId).map(a => (
                <tr key={a.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.performedAt)}</td>
                  <td>{a.txnType === 'draw' ? <span className="badge blue">ดึงเข้า Job</span> : <span className="badge green">คืนเข้าสต็อก</span>}{a.note && <div className="muted">{a.note}</div>}</td>
                  <td>{stockOf(a.projectStockId)?.stockNo}</td>
                  <td className="mono">{a.serialNos.join(', ')}</td>
                  <td>{userOf(a.performedBy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Modals ---------------- */}
      {modal === 'draw' && (
        <Modal title="ดึง LBS เข้า Job (เลือกรายเครื่อง)" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary" disabled={picked.size === 0}
              onClick={async () => { if (await tryAction(() => act.drawLbs({ jobId: job.id, stockId: drawStock, unitIds: [...picked] }), `ดึง LBS ${picked.size} เครื่องเข้า ${job.jobNo} แล้ว`)) close() }}>
              ดึง {picked.size} เครื่อง
            </button>
          </>}>
          <label className="field"><span>เลือก Project Stock (ดึงผสมหลาย Stock ได้ — ทำทีละ Stock, คลังที่ปิดแล้วไม่แสดง)</span>
            <select value={drawStock} onChange={e => { setDrawStock(e.target.value); setPicked(new Set()) }}>
              {db.projectStocks.filter(s => s.status === 'open').map(s => {
                const sum = stockSummary(db, s.id)
                return <option key={s.id} value={s.id}>{s.stockNo} — คงเหลือ {sum.available} เครื่อง</option>
              })}
            </select>
          </label>
          <div className="muted" style={{ marginBottom: 8 }}>เลือก Serial No. ที่จะดึง (ห้ามดึงเกินยอดคงเหลือ — ระบบแสดงเฉพาะเครื่องที่ว่าง):</div>
          <SerialPicker units={drawableUnits} selected={picked} toggle={togglePick} />
        </Modal>
      )}

      {modal === 'return' && (
        <Modal title="คืน LBS กลับสต็อก" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary" disabled={picked.size === 0 || !returnTarget}
              onClick={async () => { if (await tryAction(() => act.returnLbs({ jobId: job.id, unitIds: [...picked], targetStockId: returnTarget }), `คืน LBS ${picked.size} เครื่องแล้ว`)) close() }}>
              คืน {picked.size} เครื่อง
            </button>
          </>}>
          <div className="muted" style={{ marginBottom: 8 }}>เลือกเครื่องที่จะคืน:</div>
          <SerialPicker units={returnableUnits} selected={picked} toggle={togglePick} />
          <label className="field" style={{ marginTop: 12 }}><span>คืนเข้า Stock No. (ผู้ใช้เลือกเอง ไม่ auto)</span>
            <select value={returnTarget} onChange={e => setReturnTarget(e.target.value)}>
              <option value="">— เลือกสต็อกปลายทาง —</option>
              {db.projectStocks.map(s => <option key={s.id} value={s.id}>{s.stockNo}</option>)}
            </select>
          </label>
        </Modal>
      )}

      {modal === 'accessory' && (
        <Modal title="Purchase Orders — เพิ่มวัสดุให้ Job" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary" disabled={!accForm.itemId}
              onClick={async () => { if (await tryAction(() => act.addAccessoryRequest({ jobId: job.id, itemId: accForm.itemId, qty: accForm.qty, source: accForm.source, unitPrice: toBudgetNum(accForm.unitPrice) }), accForm.source === 'central_stock' ? 'เบิกจากสต็อกกลางเรียบร้อย' : 'เพิ่มรายการรอออก PR แล้ว')) close() }}>
              {accForm.source === 'central_stock' ? 'เบิกจากสต็อกกลาง' : 'เพิ่มรายการ (รอออก PR)'}
            </button>
          </>}>
          <label className="field"><span>รายการวัสดุ (Accessory)</span>
            <select value={accForm.itemId} onChange={e => {
              const item = itemOf(e.target.value)
              setAccForm({ ...accForm, itemId: e.target.value, source: item?.stockableCentrally ? 'central_stock' : 'purchasing' })
            }}>
              {accessoryItems.map(i => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}
            </select>
          </label>
          <div className="row">
            <label className="field"><span>จำนวน{selAccItem ? ` (${selAccItem.uom})` : ''}</span>
              <input type="number" min={1} value={accForm.qty} onChange={e => setAccForm({ ...accForm, qty: Number(e.target.value) })} />
            </label>
            <label className="field"><span>ราคาต่อหน่วย (บาท)</span>
              <input type="number" min={0} value={accForm.unitPrice} placeholder="0" onChange={e => setAccForm({ ...accForm, unitPrice: e.target.value })} />
            </label>
          </div>
          {toBudgetNum(accForm.unitPrice) !== undefined && (
            <div className="budget-profit" style={{ marginBottom: 12 }}>
              <span>มูลค่ารายการนี้</span><b className="pos">{fmtBaht((toBudgetNum(accForm.unitPrice) ?? 0) * accForm.qty)}</b>
            </div>
          )}
          <label className="field"><span>แหล่งที่มา</span>
            <select value={accForm.source} onChange={e => setAccForm({ ...accForm, source: e.target.value as typeof accForm.source })}>
              <option value="central_stock" disabled={!selAccItem?.stockableCentrally}>
                เบิกจากสต็อกกลาง {selAccItem?.stockableCentrally ? `(คงเหลือ ${selAccStockQty} ${selAccItem.uom})` : '(item นี้ไม่มีสต็อกกลาง)'}
              </option>
              <option value="purchasing">สั่งซื้อผ่าน Purchasing (ออก PR → PO)</option>
            </select>
          </label>
          {accForm.source === 'central_stock' && selAccItem && selAccStockQty < accForm.qty && (
            <div className="muted" style={{ color: 'var(--red)' }}>สต็อกกลางคงเหลือ {selAccStockQty} ไม่พอ — เปลี่ยนเป็นสั่งซื้อผ่าน Purchasing</div>
          )}
        </Modal>
      )}

      {modal === 'issue' && (
        <Modal title="เบิกทั้งหมดให้ Service ติดตั้ง" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="success"
              onClick={async () => { if (await tryAction(() => act.issueJob({ jobId: job.id, note: issueNote }), `เบิก ${job.jobNo} ให้ Service แล้ว`)) close() }}>
              ยืนยันการเบิก
            </button>
          </>}>
          <p style={{ marginBottom: 10 }}>
            เบิก <b>LBS {allocatedUnits.length} เครื่อง</b> + Accessory ทั้งหมดของ <b>{job.jobNo}</b> ให้ Service
            ไปติดตั้งที่ <b>{job.installLocation || '-'}</b> กำหนด {fmtDate(job.requiredDate)}
          </p>
          <p className="muted" style={{ marginBottom: 12 }}>หลังยืนยัน Job จะล็อก แก้ไข allocation หรือคืนของไม่ได้อีก</p>
          <label className="field"><span>บันทึกถึงทีม Service (ทีม/นัดหมาย)</span>
            <textarea rows={2} value={issueNote} onChange={e => setIssueNote(e.target.value)} placeholder="ทีม Service A นัดเข้าไซต์ ..." />
          </label>
        </Modal>
      )}

      {modal === 'cancel' && (
        <Modal title={`ยกเลิก ${job.jobNo}`} onClose={close}
          footer={<>
            <button onClick={close}>กลับ</button>
            <button className="danger"
              onClick={async () => { if (await tryAction(() => act.cancelJob({ jobId: job.id, reason: cancelReason, receivedAccessoryToCentral: receivedToCentral }), `ยกเลิก ${job.jobNo} และคืนของกลับสต็อกแล้ว`)) { close(); navigate('/jobs') } }}>
              ยืนยันยกเลิก Job
            </button>
          </>}>
          <p style={{ marginBottom: 10 }}>
            ระบบจะ <b>คืน LBS {returnableUnits.length} เครื่องกลับ Stock No. เดิม</b>ตาม allocation record
            และคืน Accessory ที่เบิกจากสต็อกกลางโดยอัตโนมัติ พร้อมยกเลิก PR/PO ที่ค้างอยู่
          </p>
          <label className="field"><span>เหตุผลการยกเลิก *</span>
            <textarea rows={2} value={cancelReason} onChange={e => setCancelReason(e.target.value)} />
          </label>
          {receivedFromPo.length > 0 && (
            <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={receivedToCentral} onChange={e => setReceivedToCentral(e.target.checked)} />
              <span style={{ margin: 0 }}>
                นำ Accessory ที่สั่งซื้อและรับของแล้ว ({receivedFromPo.length} รายการ) เข้าสต็อกกลางไว้ใช้ Job อื่นต่อ
                <div className="muted">ถ้าไม่เลือก ระบบจะคงสถานะ "รับของแล้ว" ไว้ให้พิจารณาเป็นเคสไป</div>
              </span>
            </label>
          )}
        </Modal>
      )}

      {modal === 'edit' && (
        <Modal title={`แก้ไขข้อมูล ${job.jobNo}`} onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary"
              onClick={async () => {
                const { salePrice, cost, ...rest } = editForm
                if (await tryAction(() => act.updateJob({ jobId: job.id, ...rest, budgetSalePrice: toBudgetNum(salePrice), budgetCost: toBudgetNum(cost) }), 'บันทึกแล้ว')) close()
              }}>บันทึก</button>
          </>}>
          <label className="field"><span>ชื่อลูกค้า</span>
            <input value={editForm.customerName} onChange={e => setEditForm({ ...editForm, customerName: e.target.value })} />
          </label>
          <label className="field"><span>Scope</span>
            <textarea rows={2} value={editForm.scope} onChange={e => setEditForm({ ...editForm, scope: e.target.value })} />
          </label>
          <div className="row">
            <label className="field"><span>สถานที่ติดตั้ง</span>
              <input value={editForm.installLocation} onChange={e => setEditForm({ ...editForm, installLocation: e.target.value })} />
            </label>
            <label className="field"><span>วันที่ต้องการติดตั้ง</span>
              <input type="date" value={editForm.requiredDate} onChange={e => setEditForm({ ...editForm, requiredDate: e.target.value })} />
            </label>
          </div>
          <label className="field"><span>จำนวน LBS ตาม Scope (เครื่อง)</span>
            <input type="number" min={1} value={editForm.lbsQtyRequired} onChange={e => setEditForm({ ...editForm, lbsQtyRequired: Number(e.target.value) })} />
          </label>
          <div className="budget-legend">Project Budget</div>
          <BudgetFields
            sale={editForm.salePrice} cost={editForm.cost}
            onSale={v => setEditForm({ ...editForm, salePrice: v })}
            onCost={v => setEditForm({ ...editForm, cost: v })}
          />
        </Modal>
      )}
    </>
  )
}
