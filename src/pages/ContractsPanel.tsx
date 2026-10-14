import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { contractUnits, contractRemaining, unitEta, unitFlowState, unitStockState } from '../data/logic'
import { Modal, useConfirm, useTryAction } from '../ui/components'
import { fmtDate, UNIT_FLOW } from '../ui/format'
import type { Contract, LbsUnit } from '../types'

/**
 * 📄 ทะเบียนสัญญา (0085) — แท็บในหน้า Project Stock
 * PO ลูกค้า 1 ใบ = สัญญา 1 ใบ ผูก LBS ได้หลายเครื่องตามจำนวน set
 * Customer/Contact กรอกที่สัญญาครั้งเดียว ทุกเครื่องในสัญญาอ่านค่าจากที่นี่
 */

interface ContractForm {
  id?: string
  contractNo: string; customerName: string; contactPhone: string; installLocation: string
  customerPoNo: string; poDate: string; qtySets: string; note: string
}
const emptyForm = (): ContractForm => ({
  contractNo: '', customerName: '', contactPhone: '', installLocation: '',
  customerPoNo: '', poDate: '', qtySets: '1', note: '',
})
const toForm = (c: Contract): ContractForm => ({
  id: c.id, contractNo: c.contractNo, customerName: c.customerName, contactPhone: c.contactPhone ?? '',
  installLocation: c.installLocation, customerPoNo: c.customerPoNo ?? '', poDate: c.poDate ?? '',
  qtySets: String(c.qtySets), note: c.note ?? '',
})

export default function ContractsPanel() {
  const { db, user, act } = useStore()
  const canManage = can(user, 'stock.manage')
  const tryAction = useTryAction()
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  const [form, setForm] = useState<ContractForm | null>(null)
  const [assignFor, setAssignFor] = useState<string | null>(null)       // contract id
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const stockNo = (id: string) => db.projectStocks.find(s => s.id === id)?.stockNo ?? '-'
  const jobNo = (id: string | null) => (id ? db.jobs.find(j => j.id === id)?.jobNo : undefined)
  const q = search.trim().toLowerCase()
  const rows = [...db.contracts]
    .sort((a, b) => b.contractNo.localeCompare(a.contractNo))
    .filter(c => !q || [c.contractNo, c.customerName, c.customerPoNo ?? ''].some(s => s.toLowerCase().includes(q)))
  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  return (
    <>
      {/* วิธีใช้ 3 ขั้น — ให้คนที่เพิ่งเปิดแท็บนี้ครั้งแรกเห็นภาพรวมก่อนเริ่มกรอก */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
          {[
            ['1', 'สร้างสัญญาจาก PO ลูกค้า', 'กรอกเลขสัญญา · ลูกค้า · สถานที่ · จำนวน set ครั้งเดียว'],
            ['2', 'ผูกเครื่องเข้าสัญญา', 'ติ๊กเลือกหลายเครื่องพร้อมกัน — ไม่ต้องกรอกเลขซ้ำทีละเครื่อง'],
            ['3', 'Project ดึงเครื่องเข้า Job', 'ดึงได้เฉพาะเครื่องที่ผูกสัญญาแล้ว (0084)'],
          ].map(([n, title, hint], i) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 220px' }}>
              <span className="badge blue" style={{ fontSize: 14, minWidth: 28, justifyContent: 'center' }}>{n}</span>
              <div>
                <b>{title}</b>
                <div className="muted" style={{ fontSize: 12 }}>{hint}</div>
              </div>
              {i < 2 && <span className="muted" style={{ marginLeft: 'auto', fontSize: 18 }}>→</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {canManage && <button className="primary" onClick={() => setForm(emptyForm())}>+ สร้างสัญญาใหม่</button>}
        <input placeholder="ค้นหา Contract No. / Customer / PO ลูกค้า" value={search}
          onChange={e => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
      </div>

      <div className="panel">
        <div className="panel-head"><h3>📄 ทะเบียนสัญญา <span className="badge neutral">{db.contracts.length}</span></h3></div>
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Contract No.</th><th>Customer</th><th>PO ลูกค้า</th><th>สถานที่หลัก</th>
                <th style={{ minWidth: 160 }}>เครื่องที่ผูก</th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={canManage ? 7 : 6}><div className="empty">
                  {db.contracts.length === 0 ? 'ยังไม่มีสัญญา — กด "+ สร้างสัญญาใหม่" เมื่อได้ PO จากลูกค้า' : 'ไม่พบสัญญาที่ค้นหา'}
                </div></td></tr>
              )}
              {rows.map(c => {
                const units = contractUnits(db, c.contractNo)
                const remaining = contractRemaining(db, c)
                const expanded = open.has(c.id)
                return [
                  <tr key={c.id}>
                    <td>
                      <button className="small" title={expanded ? 'ซ่อนเครื่อง' : 'ดูเครื่องในสัญญา'} onClick={() => toggle(c.id)}>
                        {expanded ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="mono"><b>{c.contractNo}</b></td>
                    <td>
                      {c.customerName}
                      {c.contactPhone && <div className="muted" style={{ fontSize: 12 }}>📞 {c.contactPhone}</div>}
                    </td>
                    <td>
                      {c.customerPoNo ?? '-'}
                      {c.poDate && <div className="muted" style={{ fontSize: 12 }}>{fmtDate(c.poDate)}</div>}
                    </td>
                    <td>{c.installLocation}</td>
                    <td>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <b>{units.length}/{c.qtySets} set</b>
                        {remaining > 0
                          ? <span className="badge amber">ขาด {remaining}</span>
                          : <span className="badge green">ครบ</span>}
                      </div>
                      <div className="progress"><div style={{ width: `${Math.min(100, (units.length / c.qtySets) * 100)}%` }} /></div>
                    </td>
                    {canManage && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="small" disabled={remaining === 0}
                          title={remaining === 0 ? 'ผูกครบจำนวน set แล้ว — เพิ่มจำนวน set ในสัญญาก่อนถ้าลูกค้าซื้อเพิ่ม' : undefined}
                          onClick={() => setAssignFor(c.id)}>🔗 ผูกเครื่อง</button>{' '}
                        <button className="small" onClick={() => setForm(toForm(c))}>แก้ไข</button>{' '}
                        {units.length === 0 && (
                          <button className="small danger" onClick={async () => {
                            if (await askConfirm({
                              title: `ลบสัญญา ${c.contractNo}`,
                              description: <>สัญญานี้ยังไม่ผูกเครื่อง · ลบแล้วประวัติยังอยู่ใน Audit Log</>,
                              confirmLabel: 'ลบสัญญา',
                            })) tryAction(() => act.deleteContract({ contractId: c.id }), `ลบสัญญา ${c.contractNo} แล้ว`)
                          }}>ลบ</button>
                        )}
                      </td>
                    )}
                  </tr>,
                  expanded && (
                    <tr key={`${c.id}-units`}>
                      <td></td>
                      <td colSpan={canManage ? 6 : 5} style={{ background: 'var(--stripe)' }}>
                        {units.length === 0
                          ? <div className="muted">ยังไม่ได้ผูกเครื่อง{canManage ? ' — กด 🔗 ผูกเครื่อง' : ''}</div>
                          : (
                            <table className="dense">
                              <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th>Stock</th><th>Location / Site</th><th>Job</th><th>Status</th>{canManage && <th></th>}</tr></thead>
                              <tbody>
                                {units.map(u => {
                                  const flow = UNIT_FLOW[unitFlowState(db, u)]
                                  return (
                                    <tr key={u.id}>
                                      <td className="mono">{u.serialLvb}</td>
                                      <td className="mono">{u.serialOm}</td>
                                      <td>{stockNo(u.projectStockId)}</td>
                                      <td>{u.planInstallLocation
                                        ? <>{u.planInstallLocation} <span className="badge neutral">เฉพาะเครื่องนี้</span></>
                                        : <span className="muted">ตามสัญญา</span>}</td>
                                      <td>{u.jobId ? <Link to={`/jobs/${u.jobId}`}>{jobNo(u.jobId)}</Link> : '-'}</td>
                                      <td><span className={`badge ${flow.cls}`} title={flow.hint}>{flow.label}</span></td>
                                      {canManage && (
                                        <td>
                                          {u.status === 'in_stock'
                                            ? <button className="small" onClick={async () => {
                                                if (await askConfirm({
                                                  title: `ถอด ${u.serialLvb} ออกจากสัญญา ${c.contractNo}`,
                                                  description: <>เครื่องจะกลับเป็นเครื่องว่างในคลัง (ไม่มีสัญญา) และ<b>ดึงเข้า Job ไม่ได้</b>จนกว่าจะผูกสัญญาใหม่</>,
                                                  confirmLabel: 'ถอดออก',
                                                })) tryAction(() => act.unassignUnitContract({ unitId: u.id }), `ถอด ${u.serialLvb} ออกจากสัญญาแล้ว`)
                                              }}>ถอดออก</button>
                                            : <span className="muted" title={u.status === 'issued' ? 'เบิกให้ Service แล้ว' : 'อยู่ใน Job — คืนเข้าคลังก่อนถอดสัญญา'}>🔒</span>}
                                        </td>
                                      )}
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          )}
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      </div>

      {form && <ContractFormModal form={form} setForm={setForm} onDone={() => setForm(null)} />}
      {assignFor && <AssignModal contractId={assignFor} onClose={() => setAssignFor(null)} />}
      {confirmEl}
    </>
  )
}

function ContractFormModal({ form, setForm, onDone }: {
  form: ContractForm; setForm: (f: ContractForm) => void; onDone: () => void
}) {
  const { db, act } = useStore()
  const tryAction = useTryAction()
  const old = form.id ? db.contracts.find(c => c.id === form.id) : undefined
  const assigned = old ? contractUnits(db, old.contractNo).length : 0
  const set = (k: keyof ContractForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const renamed = !!old && form.contractNo.trim() !== old.contractNo
  return (
    <Modal title={old ? `แก้สัญญา ${old.contractNo}` : 'สร้างสัญญาใหม่ (จาก PO ลูกค้า)'} size="wide" onClose={onDone}
      footer={<>
        <button onClick={onDone}>ยกเลิก</button>
        <button className="primary" onClick={async () => {
          if (await tryAction(() => act.saveContract({
            id: form.id, contractNo: form.contractNo, customerName: form.customerName,
            contactPhone: form.contactPhone, installLocation: form.installLocation,
            customerPoNo: form.customerPoNo, poDate: form.poDate, qtySets: Number(form.qtySets), note: form.note,
          }), old ? 'บันทึกสัญญาแล้ว' : `สร้างสัญญา ${form.contractNo.trim()} แล้ว — กด 🔗 ผูกเครื่อง เพื่อเลือกเครื่องเข้าสัญญา`)) onDone()
        }}>บันทึก</button>
      </>}>
      <div className="row">
        <label className="field"><span>Contract No. *</span>
          <input className="mono" value={form.contractNo} onChange={set('contractNo')} placeholder="เช่น CT-2026-0101" />
        </label>
        <label className="field"><span>จำนวน set ตาม PO *</span>
          <input type="number" min={Math.max(1, assigned)} step={1} value={form.qtySets} onChange={set('qtySets')} />
        </label>
      </div>
      {renamed && assigned > 0 && (
        <div style={{ margin: '-4px 0 10px', fontSize: 12, color: 'var(--primary)' }}>
          เครื่อง {assigned} เครื่องในสัญญานี้จะเปลี่ยนเป็นเลขใหม่ตามไปด้วย
        </div>
      )}
      {old && assigned > 0 && (
        <div className="muted" style={{ margin: '-4px 0 10px', fontSize: 12 }}>
          ผูกเครื่องไว้แล้ว {assigned} เครื่อง — ลดจำนวน set ต่ำกว่านี้ไม่ได้
        </div>
      )}
      <div className="row">
        <label className="field"><span>Customer *</span>
          <input value={form.customerName} onChange={set('customerName')} placeholder="PEA เชียงใหม่" />
        </label>
        <label className="field"><span>Contact Number</span>
          <input value={form.contactPhone} onChange={set('contactPhone')} placeholder="08x-xxx-xxxx" />
        </label>
      </div>
      <label className="field"><span>สถานที่ติดตั้งหลัก (Location / Site) *</span>
        <input value={form.installLocation} onChange={set('installLocation')} placeholder="สถานีไฟฟ้าสันทราย จ.เชียงใหม่" />
      </label>
      <div className="muted" style={{ margin: '-6px 0 10px', fontSize: 12 }}>
        ทุกเครื่องในสัญญาใช้สถานที่นี้ — ถ้าบาง set ไปคนละสถานี แก้ทับรายเครื่องได้ที่ "แก้ข้อมูล" ในแท็บคลัง LBS
      </div>
      <div className="row">
        <label className="field"><span>เลขที่ PO ลูกค้า</span>
          <input value={form.customerPoNo} onChange={set('customerPoNo')} placeholder="PEA-CM-69/0412" />
        </label>
        <label className="field"><span>วันที่ PO</span>
          <input type="date" value={form.poDate} onChange={set('poDate')} />
        </label>
      </div>
      <label className="field"><span>หมายเหตุ</span>
        <textarea value={form.note} onChange={set('note')} rows={2} />
      </label>
    </Modal>
  )
}

function AssignModal({ contractId, onClose }: { contractId: string; onClose: () => void }) {
  const { db, act } = useStore()
  const tryAction = useTryAction()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [stockFilter, setStockFilter] = useState('')
  const [search, setSearch] = useState('')
  const c = db.contracts.find(x => x.id === contractId)
  if (!c) return null
  const remaining = contractRemaining(db, c)
  const locked = (u: LbsUnit) => {
    if (u.status === 'issued') return true
    const t = db.jobs.find(j => j.id === u.jobId)?.terminalStatus
    return t === 'issued' || t === 'installed'
  }
  const openStocks = db.projectStocks.filter(s => s.status === 'open')
  const q = search.trim().toLowerCase()
  // เครื่องที่ผูกได้ = ยังไม่มีสัญญา + ยังไม่ล็อก · คลังที่ปิดแล้วไม่แสดง
  const candidates = db.lbsUnits.filter(u =>
    !u.contractNo && !locked(u) && openStocks.some(s => s.id === u.projectStockId)
    && (!stockFilter || u.projectStockId === stockFilter)
    && (!q || u.serialLvb.toLowerCase().includes(q) || u.serialOm.toLowerCase().includes(q)))
  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else if (next.size < remaining) next.add(id)
    return next
  })
  const pickFirst = () => setPicked(new Set(candidates.slice(0, remaining).map(u => u.id)))
  const stockNo = (id: string) => db.projectStocks.find(s => s.id === id)?.stockNo ?? '-'

  return (
    <Modal title={`ผูกเครื่องเข้าสัญญา ${c.contractNo}`} size="xl" onClose={onClose}
      footer={<>
        <button onClick={onClose}>ยกเลิก</button>
        <button className="primary" disabled={picked.size === 0} onClick={async () => {
          if (await tryAction(() => act.assignUnitsToContract({ contractId: c.id, unitIds: [...picked] }),
            `ผูก ${picked.size} เครื่องเข้าสัญญา ${c.contractNo} แล้ว`)) onClose()
        }}>ผูก {picked.size} เครื่อง</button>
      </>}>
      <div style={{ marginBottom: 10 }}>
        <b>{c.customerName}</b> · {c.installLocation}
        <div className="muted">
          สัญญา {c.qtySets} set · ผูกแล้ว {c.qtySets - remaining} · <b>เลือกได้อีก {remaining - picked.size} เครื่อง</b>
          {picked.size > 0 && ` (เลือกแล้ว ${picked.size})`}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={stockFilter} onChange={e => { setStockFilter(e.target.value); setPicked(new Set()) }} style={{ maxWidth: 260 }}>
          <option value="">ทุกคลังที่เปิดอยู่</option>
          {openStocks.map(s => <option key={s.id} value={s.id}>{s.stockNo}</option>)}
        </select>
        <input placeholder="ค้นหา Serial" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
        <button className="small" disabled={candidates.length === 0 || remaining === 0} onClick={pickFirst}>
          เลือก {Math.min(remaining, candidates.length)} เครื่องแรก
        </button>
        {picked.size > 0 && <button className="small" onClick={() => setPicked(new Set())}>ล้างที่เลือก</button>}
      </div>
      <div className="table-scroll">
        <table className="grid dense">
          <thead><tr><th style={{ width: 36 }}></th><th>Serial.LVB</th><th>Serial.OM</th><th>Stock</th><th>สถานะในคลัง</th><th>Job</th><th>ลูกค้าตามแผนเดิม</th></tr></thead>
          <tbody>
            {candidates.map(u => {
              const st = unitStockState(u)
              const sel = picked.has(u.id)
              return (
                <tr key={u.id} className="clickable" onClick={() => toggle(u.id)} style={sel ? { fontWeight: 600 } : undefined}>
                  <td><input type="checkbox" readOnly checked={sel} /></td>
                  <td className="mono">{u.serialLvb}</td>
                  <td className="mono">{u.serialOm}</td>
                  <td>{stockNo(u.projectStockId)}</td>
                  <td>
                    {st === 'pending'
                      ? <span className="badge amber">ETA {fmtDate(unitEta(u))}</span>
                      : st === 'on_hand' ? <span className="badge green">On Hand</span>
                      : <span className="badge neutral">ไม่ระบุ ETA</span>}
                  </td>
                  <td>{u.jobId ? db.jobs.find(j => j.id === u.jobId)?.jobNo : '-'}</td>
                  <td className="muted">{u.planCustomerName ?? '-'}</td>
                </tr>
              )
            })}
            {candidates.length === 0 && (
              <tr><td colSpan={7}><div className="empty">ไม่มีเครื่องว่างที่ยังไม่ผูกสัญญา{stockFilter || q ? 'ตามตัวกรองนี้' : ''}</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
