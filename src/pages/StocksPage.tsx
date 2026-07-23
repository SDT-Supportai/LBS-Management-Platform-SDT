import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { stockSummary } from '../data/logic'
import { Modal, useToast, useTryAction, toBudgetNum } from '../ui/components'
import { fmtBaht, fmtDate } from '../ui/format'

interface UnitRow { lvb: string; om: string; cost: string }
const emptyRow = (): UnitRow => ({ lvb: '', om: '', cost: '' })

// UnitRow (ฟอร์ม string) → payload logic/RPC ({ lvb, om, cost? })
const rowsToUnits = (rows: UnitRow[]) =>
  rows.map(r => ({ lvb: r.lvb, om: r.om, cost: toBudgetNum(r.cost) }))

// สเปกคงที่ของ LBS ที่รับเข้าคลัง (แสดงเป็น Description ทุกคลัง)
const LBS_DESCRIPTION = '115 kV Load Break Switch with SF6 Gas Interrupters, 2000A'

const UNIT_STATUS_LABEL: Record<string, string> = {
  in_stock: 'อยู่ในสต็อก', allocated: 'ถูกดึงเข้า Job', issued: 'เบิกติดตั้งแล้ว',
}

// อ่านค่าจากหัวตารางหลายรูปแบบ (ไทยตามไฟล์ export / อังกฤษ)
function cell(row: Record<string, unknown>, keys: string[]): string {
  for (const [k, v] of Object.entries(row)) {
    if (keys.some(key => k.trim().toLowerCase() === key.toLowerCase()))
      return String(v ?? '').trim()
  }
  return ''
}

// ตัวแก้ไขรายเครื่อง: กรอก Serial.LVB + Serial.OM ต่อแถว (บังคับทั้งคู่)
function UnitRowsEditor({ rows, setRows }: { rows: UnitRow[]; setRows: (r: UnitRow[]) => void }) {
  const update = (i: number, field: keyof UnitRow, v: string) =>
    setRows(rows.map((r, idx) => idx === i ? { ...r, [field]: v } : r))
  const remove = (i: number) => setRows(rows.length === 1 ? [emptyRow()] : rows.filter((_, idx) => idx !== i))
  const filled = rows.filter(r => r.lvb.trim() && r.om.trim()).length

  return (
    <div>
      <div className="unit-rows">
        <div className="unit-row unit-row-head">
          <span>#</span>
          <span>Serial.LVB *</span>
          <span>Serial.OM *</span>
          <span>ต้นทุน/เครื่อง (฿)</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div className="unit-row" key={i}>
            <span className="muted">{i + 1}</span>
            <input className="mono" value={r.lvb} placeholder="LBS26-001" onChange={e => update(i, 'lvb', e.target.value)} />
            <input className="mono" value={r.om} placeholder="OM26-001" onChange={e => update(i, 'om', e.target.value)} />
            <input type="number" min={0} value={r.cost} placeholder="0" onChange={e => update(i, 'cost', e.target.value)} />
            <button className="small danger" type="button" onClick={() => remove(i)} title="ลบแถว">✕</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <button className="small" type="button" onClick={() => setRows([...rows, emptyRow()])}>+ เพิ่มเครื่อง</button>
        <span className="muted">กรอกครบ {filled}/{rows.length} เครื่อง</span>
      </div>
    </div>
  )
}

export default function StocksPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { show } = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [addTo, setAddTo] = useState<string | null>(null)
  const [openStock, setOpenStock] = useState<string | null>(null)         // เริ่มต้นซ่อนรายการทุกคลัง
  const [showAccessory, setShowAccessory] = useState(false)               // คลังสินค้า (Ref.Job) เริ่มต้นซ่อน
  const [editStock, setEditStock] = useState<string | null>(null)
  const [editNotes, setEditNotes] = useState('')
  const [editStatus, setEditStatus] = useState<'open' | 'closed'>('open')
  const [editUnit, setEditUnit] = useState<{ id: string; lvb: string; om: string } | null>(null)
  const [importPreview, setImportPreview] = useState<{
    stockId: string; stockNo: string
    newUnits: UnitRow[]
    dupUnits: { row: UnitRow; oldCost?: number }[]   // ซ้ำในคลังนี้ (คู่ Serial ตรง) — เลือกอัพเดทต้นทุน/ข้าม
    errors: string[]
  } | null>(null)
  const [dupAction, setDupAction] = useState<'update' | 'skip'>('update')
  const [importing, setImporting] = useState(false)
  const importFileRef = useRef<HTMLInputElement>(null)
  const importToRef = useRef<{ id: string; no: string } | null>(null)

  const [stockNo, setStockNo] = useState(`Project Stock No.${db.projectStocks.length + 1}`)
  const [rows, setRows] = useState<UnitRow[]>([emptyRow()])
  const [notes, setNotes] = useState('')

  const lbsItem = db.items.find(i => i.itemType === 'main_equipment')!
  const canManage = can(user, 'stock.manage')
  // คลังสินค้า (Ref.Job): วัสดุที่รับของครบจาก PO เท่านั้น
  const receivedLines = db.pos
    .filter(p => p.status === 'received')
    .flatMap(po => db.accessoryRequests
      .filter(r => r.prId === po.prId && r.status === 'received')
      .map(r => ({ po, r })))
  const receivedLineCount = receivedLines.length
  const jobNo = (id: string | null) => db.jobs.find(j => j.id === id)?.jobNo
  const filledRows = (rs: UnitRow[]) => rs.filter(r => r.lvb.trim() && r.om.trim()).length

  const submitCreate = async () => {
    if (await tryAction(
      () => act.createProjectStock({ stockNo, itemId: lbsItem.id, units: rowsToUnits(rows), notes }),
      `สร้าง ${stockNo} เรียบร้อย`,
    )) {
      setShowCreate(false); setRows([emptyRow()]); setNotes('')
    }
  }

  const submitAdd = async () => {
    if (!addTo) return
    if (await tryAction(
      () => act.addUnitsToStock({ stockId: addTo, units: rowsToUnits(rows) }),
      'รับ LBS เข้าสต็อกเรียบร้อย',
    )) { setAddTo(null); setRows([emptyRow()]) }
  }

  // ---------------- Excel export / import (ต่อคลัง) ----------------

  // xlsx โหลดแบบ dynamic — ไม่ให้ bundle หลักบวม
  const exportStock = async (stockId: string) => {
    const XLSX = await import('xlsx')
    const s = db.projectStocks.find(x => x.id === stockId)!
    const units = db.lbsUnits.filter(u => u.projectStockId === stockId)
    // ข้อมูลลูกค้า ref จาก Job ที่เครื่องถูกดึงเข้า (single source of truth)
    const rows = units.map(u => {
      const job = u.jobId ? db.jobs.find(j => j.id === u.jobId) : undefined
      return {
        'Serial.LVB': u.serialLvb,
        'Serial.OM': u.serialOm,
        'ต้นทุน/เครื่อง': u.unitCost ?? '',
        'สถานะ': UNIT_STATUS_LABEL[u.status] ?? u.status,
        'Job No.': job?.jobNo ?? '',
        'ชื่อลูกค้า': job?.customerName ?? '',
        'เบอร์ติดต่อ': job?.contactPhone ?? '',
        'สถานที่ติดตั้ง': job?.installLocation ?? '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 24 }, { wch: 14 }, { wch: 28 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, s.stockNo.slice(0, 31))
    XLSX.writeFile(wb, `${s.stockNo.replace(/[\\/:*?"<>|]/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const onPickImportFile = async (file: File) => {
    const target = importToRef.current
    if (!target) return
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer())
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      if (raw.length === 0) return show('ไฟล์ไม่มีข้อมูล — ต้องมีหัวตาราง Serial.LVB, Serial.OM', true)

      const newUnits: UnitRow[] = []
      const dupUnits: { row: UnitRow; oldCost?: number }[] = []
      const errors: string[] = []
      const stockNoOf = (id: string) => db.projectStocks.find(s => s.id === id)?.stockNo ?? '?'
      const seenInFile = new Set<string>()          // กันซ้ำภายในไฟล์ (ข้าม field ด้วย)
      raw.forEach((row, i) => {
        const lvb = cell(row, ['Serial.LVB', 'serial.lvb', 'serial_lvb', 'lvb'])
        const om = cell(row, ['Serial.OM', 'serial.om', 'serial_om', 'om'])
        const costStr = cell(row, ['ต้นทุน/เครื่อง', 'ต้นทุน', 'unit_cost', 'cost'])
        if (!lvb && !om) return                       // ข้ามแถวว่าง
        const no = `แถว ${i + 2}`
        if (!lvb || !om) return void errors.push(`${no}: ต้องมีทั้ง Serial.LVB และ Serial.OM`)
        if (lvb === om) return void errors.push(`${no}: LVB กับ OM ห้ามเป็นเลขเดียวกัน (${lvb})`)
        if (costStr !== '' && (Number.isNaN(Number(costStr)) || Number(costStr) < 0))
          return void errors.push(`${no}: ต้นทุน/เครื่อง "${costStr}" ต้องเป็นตัวเลขไม่ติดลบ`)
        if (seenInFile.has(lvb) || seenInFile.has(om))
          return void errors.push(`${no}: "${lvb}" / "${om}" ซ้ำกันในไฟล์`)
        // ซ้ำในคลังนี้ (คู่ Serial ตรงกันเป๊ะ) → อัพเดทต้นทุนได้
        const exact = db.lbsUnits.find(u => u.projectStockId === target.id && u.serialLvb === lvb && u.serialOm === om)
        if (exact) {
          seenInFile.add(lvb); seenInFile.add(om)
          dupUnits.push({ row: { lvb, om, cost: costStr }, oldCost: exact.unitCost })
          return
        }
        // ชน Serial กับเครื่องอื่น (คลังอื่น หรือคู่ไม่ตรงในคลังนี้) → กรอกผิด/ซ้ำ (error)
        const collide = db.lbsUnits.find(u => [u.serialLvb, u.serialOm].some(s => s === lvb || s === om))
        if (collide) {
          const where = collide.projectStockId === target.id
            ? 'เครื่องในคลังนี้ (คู่ Serial ไม่ตรง)'
            : `เครื่องในคลังอื่น (${stockNoOf(collide.projectStockId)})`
          return void errors.push(`${no}: "${lvb}" / "${om}" ชนกับ${where} — ตรวจว่ากรอกถูกไหม`)
        }
        // เครื่องใหม่
        seenInFile.add(lvb); seenInFile.add(om)
        newUnits.push({ lvb, om, cost: costStr })
      })
      if (newUnits.length === 0 && dupUnits.length === 0 && errors.length === 0)
        return show('ไม่พบแถวที่กรอก Serial ในไฟล์', true)
      setDupAction('update')
      setImportPreview({ stockId: target.id, stockNo: target.no, newUnits, dupUnits, errors })
    } catch {
      show('อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xlsx)', true)
    }
  }

  const runImport = async () => {
    if (!importPreview) return
    setImporting(true)
    const newUnits = rowsToUnits(importPreview.newUnits)
    const updateUnits = dupAction === 'update' ? rowsToUnits(importPreview.dupUnits.map(d => d.row)) : []
    const msg = [
      newUnits.length ? `รับเข้า ${newUnits.length} เครื่อง` : '',
      updateUnits.length ? `อัพเดทต้นทุน ${updateUnits.length} เครื่อง` : '',
    ].filter(Boolean).join(' · ')
    const ok = await tryAction(
      () => act.importUnitsToStock({ stockId: importPreview.stockId, newUnits, updateUnits }),
      `${msg} เข้า ${importPreview.stockNo} แล้ว`,
    )
    setImporting(false)
    if (ok) setImportPreview(null)
  }

  return (
    <>
      <div className="page-title">Project Stock — คลัง LBS</div>
      <div className="page-sub">
        คลังกลาง 115kV LBS ติดตามรายเครื่องด้วย Serial คู่ (LVB · OM) — Project ดึงเข้างานตามลำดับ
        {!canManage && ' · แผนกของคุณดูได้อย่างเดียว (สร้าง/รับเข้าสต็อกเป็นสิทธิ์ของ Division)'}
      </div>

      {canManage && (
        <div style={{ marginBottom: 16 }}>
          <button className="primary" onClick={() => { setRows([emptyRow()]); setStockNo(`Project Stock No.${db.projectStocks.length + 1}`); setShowCreate(true) }}>+ สร้าง Project Stock ใหม่ (สั่งซื้อ LBS เข้าคลัง)</button>
        </div>
      )}

      {db.projectStocks.map(s => {
        const sum = stockSummary(db, s.id)
        const units = db.lbsUnits.filter(u => u.projectStockId === s.id)
        const expanded = openStock === s.id
        return (
          <div className="panel" key={s.id}>
            <div className="panel-head">
              <h3>
                {s.stockNo}{' '}
                <span className="badge green">คงเหลือ {sum.available}</span>{' '}
                <span className="badge blue">ถูกดึง {sum.allocated}</span>{' '}
                <span className="badge neutral">เบิกแล้ว {sum.issued}</span>{' '}
                {sum.totalCost !== undefined && (
                  <span className="badge amber" title={`รวมต้นทุน ${sum.costedUnits}/${sum.total} เครื่องที่กรอกราคา`}>
                    มูลค่าคลัง {fmtBaht(sum.totalCost)}
                  </span>
                )}
              </h3>
              <div style={{ display: 'flex', gap: 8 }}>
                {s.status === 'closed' && <span className="badge red">ปิดคลัง</span>}
                <button className="small" onClick={() => exportStock(s.id)}>⬇ Export</button>
                {canManage && (
                  <button className="small" onClick={() => { importToRef.current = { id: s.id, no: s.stockNo }; importFileRef.current?.click() }}>⬆ Import</button>
                )}
                {canManage && <button className="small" onClick={() => { setRows([emptyRow()]); setAddTo(s.id) }}>+ รับ LBS เพิ่ม</button>}
                {canManage && <button className="small" onClick={() => { setEditNotes(s.notes ?? ''); setEditStatus(s.status); setEditStock(s.id) }}>แก้ไข</button>}
                {canManage && (
                  <button className="small danger" onClick={() => {
                    if (confirm(`ลบ ${s.stockNo}? (ลบได้เฉพาะคลังที่ไม่เคยมีประวัติดึง/คืน — Serial ในคลังจะถูกลบด้วย)`))
                      tryAction(() => act.deleteProjectStock({ stockId: s.id }), `ลบ ${s.stockNo} แล้ว`)
                  }}>ลบ</button>
                )}
                <button className="small" onClick={() => setOpenStock(expanded ? null : s.id)}>{expanded ? 'ซ่อนรายการ' : `ดูรายเครื่อง (${sum.total})`}</button>
              </div>
            </div>
            <div className="panel-body muted" style={{ paddingBottom: 0 }}>
              <b>Description:</b> {LBS_DESCRIPTION}
            </div>
            {expanded && (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>ต้นทุน/เครื่อง</th><th>สถานะ</th><th>ชื่อลูกค้า</th><th>เบอร์ติดต่อ</th><th>สถานที่ติดตั้ง</th><th>Job No.</th>{canManage && <th></th>}</tr></thead>
                  <tbody>
                    {units.map(u => {
                      // ข้อมูลลูกค้า ref จาก Job ที่เครื่องถูกดึงเข้า — เครื่องยังไม่เข้า Job = '-'
                      const job = u.jobId ? db.jobs.find(j => j.id === u.jobId) : undefined
                      return (
                        <tr key={u.id}>
                          <td className="mono">{u.serialLvb}</td>
                          <td className="mono">{u.serialOm}</td>
                          <td style={{ textAlign: 'right' }}>{fmtBaht(u.unitCost)}</td>
                          <td>
                            {u.status === 'in_stock' && <span className="badge green">อยู่ในสต็อก</span>}
                            {u.status === 'allocated' && <span className="badge blue">ถูกดึงเข้า Job</span>}
                            {u.status === 'issued' && <span className="badge neutral">เบิกติดตั้งแล้ว</span>}
                          </td>
                          <td>{job?.customerName ?? '-'}</td>
                          <td>{job?.contactPhone ?? '-'}</td>
                          <td>{job?.installLocation || '-'}</td>
                          <td>{u.jobId ? <Link to={`/jobs/${u.jobId}`}>{jobNo(u.jobId)}</Link> : '-'}</td>
                          {canManage && (
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {u.status === 'in_stock'
                                ? <button className="small" onClick={() => setEditUnit({ id: u.id, lvb: u.serialLvb, om: u.serialOm })}>แก้ Serial</button>
                                : <span className="muted" title="แก้ Serial ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก">🔒</span>}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="panel-body muted">
              บันทึก: {s.notes || '-'} · สร้างเมื่อ {fmtDate(s.createdAt)} โดย {db.users.find(u => u.id === s.createdBy)?.fullName}
            </div>
          </div>
        )
      })}

      {/* คลังสินค้า (Ref.Job) — แสดงเฉพาะวัสดุที่รับของครบจาก PO อ้างอิง PO No. / Job No. */}
      <div className="panel">
        <div className="panel-head">
          <h3>คลังสินค้า (Ref.Job) <span className="muted" style={{ fontWeight: 400 }}>· วัสดุรับครบจาก PO</span></h3>
          <button className="small" onClick={() => setShowAccessory(!showAccessory)}>
            {showAccessory ? 'ซ่อนรายการ' : `แสดงรายการ (${receivedLineCount})`}
          </button>
        </div>
        {showAccessory && <>
          <div className="table-scroll">
            <table>
              <thead><tr><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>จำนวน</th><th>Ref. PO No.</th><th>Job No.</th><th>รับครบเมื่อ</th></tr></thead>
              <tbody>
                {receivedLines.length === 0 && <tr><td colSpan={6}><div className="empty">ยังไม่มี PO ที่รับของครบ</div></td></tr>}
                {receivedLines.map(({ po, r }) => {
                  const item = db.items.find(i => i.id === r.itemId)!
                  const job = db.jobs.find(j => j.id === po.jobId)
                  return (
                    <tr key={`${po.id}-${r.id}`}>
                      <td className="mono">{item.epicorCode || '-'}</td>
                      <td>{item.name}</td>
                      <td>{r.qtyReceived} {item.uom}</td>
                      <td className="mono"><b>{po.poNo}</b></td>
                      <td>{job ? <Link to={`/jobs/${job.id}`}>{job.jobNo}</Link> : '-'}</td>
                      <td className="muted">{fmtDate(po.receivedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>}
      </div>

      {editStock && (
        <Modal
          title={`แก้ไข ${db.projectStocks.find(s => s.id === editStock)?.stockNo}`}
          onClose={() => setEditStock(null)}
          footer={<>
            <button onClick={() => setEditStock(null)}>ยกเลิก</button>
            <button className="primary" onClick={async () => {
              if (await tryAction(() => act.updateProjectStock({ stockId: editStock, notes: editNotes, status: editStatus }), 'บันทึกแล้ว'))
                setEditStock(null)
            }}>บันทึก</button>
          </>}
        >
          <label className="field"><span>บันทึก</span>
            <input value={editNotes} onChange={e => setEditNotes(e.target.value)} />
          </label>
          <label className="field"><span>สถานะคลัง</span>
            <select value={editStatus} onChange={e => setEditStatus(e.target.value as 'open' | 'closed')}>
              <option value="open">เปิด — ดึงเข้า Job ได้</option>
              <option value="closed">ปิดคลัง — ห้ามดึงเพิ่ม (คืนของเข้าได้)</option>
            </select>
          </label>
        </Modal>
      )}

      {showCreate && (
        <Modal
          title="สร้าง Project Stock ใหม่"
          size="wide"
          onClose={() => setShowCreate(false)}
          footer={<>
            <button onClick={() => setShowCreate(false)}>ยกเลิก</button>
            <button className="primary" onClick={submitCreate}>สร้างสต็อก ({filledRows(rows)} เครื่อง)</button>
          </>}
        >
          <label className="field"><span>Stock No.</span>
            <input value={stockNo} onChange={e => setStockNo(e.target.value)} />
          </label>
          <div className="muted" style={{ marginBottom: 12 }}>
            <b>Description:</b> {LBS_DESCRIPTION}<br />
            ข้อมูลลูกค้า/สถานที่ติดตั้งไม่ต้องกรอกที่คลัง — ระบบอ้างอิงจาก Job ที่เครื่องถูกดึงเข้า
          </div>
          <label className="field"><span>Serial No. ของ LBS แต่ละเครื่อง (Serial.LVB + Serial.OM บังคับทั้งคู่)</span></label>
          <UnitRowsEditor rows={rows} setRows={setRows} />
          <label className="field" style={{ marginTop: 14 }}><span>บันทึก (อ้างอิงรอบสั่งซื้อ ฯลฯ)</span>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="ล็อตสั่งซื้อรอบที่ 3" />
          </label>
        </Modal>
      )}

      {addTo && (
        <Modal
          title={`รับ LBS เพิ่มเข้า ${db.projectStocks.find(s => s.id === addTo)?.stockNo}`}
          size="wide"
          onClose={() => setAddTo(null)}
          footer={<>
            <button onClick={() => setAddTo(null)}>ยกเลิก</button>
            <button className="primary" onClick={submitAdd}>รับเข้า ({filledRows(rows)} เครื่อง)</button>
          </>}
        >
          <label className="field"><span>Serial No. ของ LBS แต่ละเครื่อง (Serial.LVB + Serial.OM บังคับทั้งคู่)</span></label>
          <UnitRowsEditor rows={rows} setRows={setRows} />
        </Modal>
      )}

      {editUnit && (
        <Modal
          title="แก้ Serial No. ของเครื่อง"
          onClose={() => setEditUnit(null)}
          footer={<>
            <button onClick={() => setEditUnit(null)}>ยกเลิก</button>
            <button className="primary" disabled={!editUnit.lvb.trim() || !editUnit.om.trim()}
              onClick={async () => {
                if (await tryAction(
                  () => act.updateUnitInfo({ unitId: editUnit.id, serialLvb: editUnit.lvb, serialOm: editUnit.om }),
                  'แก้ Serial แล้ว',
                )) setEditUnit(null)
              }}>บันทึก</button>
          </>}
        >
          <div className="muted" style={{ marginBottom: 12 }}>แก้ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก · Serial ห้ามซ้ำกับเครื่องอื่น</div>
          <div className="row">
            <label className="field"><span>Serial.LVB *</span>
              <input className="mono" value={editUnit.lvb} onChange={e => setEditUnit({ ...editUnit, lvb: e.target.value })} />
            </label>
            <label className="field"><span>Serial.OM *</span>
              <input className="mono" value={editUnit.om} onChange={e => setEditUnit({ ...editUnit, om: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}

      {/* ไฟล์ import ต่อคลัง (ปุ่ม ⬆ Import บนการ์ดเป็นคนกด) */}
      <input ref={importFileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onPickImportFile(f); e.target.value = '' }} />

      {importPreview && (() => {
        const { newUnits, dupUnits, errors } = importPreview
        const nothingToDo = newUnits.length === 0 && (dupUnits.length === 0 || dupAction === 'skip')
        const confirmLabel = importing ? 'กำลังนำเข้า…'
          : `ยืนยัน — รับใหม่ ${newUnits.length}${dupAction === 'update' && dupUnits.length ? ` · อัพเดท ${dupUnits.length}` : ''} เครื่อง`
        return (
        <Modal title={`Import Serial เข้า ${importPreview.stockNo} — ตรวจสอบก่อนยืนยัน`} size="wide" onClose={() => setImportPreview(null)}
          footer={<>
            <button onClick={() => setImportPreview(null)} disabled={importing}>ยกเลิก</button>
            <button className="primary" disabled={importing || errors.length > 0 || nothingToDo} onClick={runImport}>
              {confirmLabel}
            </button>
          </>}>
          {errors.length > 0 && (
            <div className="muted" style={{ color: 'var(--red)', marginBottom: 12 }}>
              พบปัญหา {errors.length} แถว — ต้องแก้ไฟล์ให้หมดก่อนถึงจะ import ได้:<br />
              {errors.slice(0, 6).map((e, i) => <span key={i}>• {e}<br /></span>)}
              {errors.length > 6 && <span>… และอีก {errors.length - 6} แถว</span>}
            </div>
          )}

          {/* ตัดสินใจ: เจอ Serial ซ้ำ (คู่ตรงกัน) ในคลังนี้ */}
          {dupUnits.length > 0 && (
            <div className="panel" style={{ marginBottom: 12, border: '1px solid var(--amber, #d97706)' }}>
              <div className="panel-body">
                <b>พบ {dupUnits.length} เครื่องที่ Serial ซ้ำกับที่มีอยู่แล้วในคลังนี้</b>
                <div className="muted" style={{ margin: '4px 0 10px' }}>
                  คู่ Serial (LVB + OM) ตรงกับเครื่องเดิม — ต้องการทำอะไร?
                </div>
                <label className="field" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
                  <input type="radio" name="dupAction" checked={dupAction === 'update'} onChange={() => setDupAction('update')} style={{ marginTop: 3 }} />
                  <span><b>อัพเดทข้อมูล (ต้นทุน/เครื่อง) ของเครื่องเดิม</b> — ใช้ค่าจากไฟล์ทับของเดิม (ช่องต้นทุนว่าง = คงค่าเดิม)</span>
                </label>
                <label className="field" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="dupAction" checked={dupAction === 'skip'} onChange={() => setDupAction('skip')} style={{ marginTop: 3 }} />
                  <span><b>ข้าม — ฉันกรอกซ้ำผิด</b> ไม่แตะเครื่องเดิม (รับเข้าเฉพาะเครื่องใหม่ {newUnits.length} เครื่อง)</span>
                </label>
                <div className="table-scroll" style={{ maxHeight: 220, overflowY: 'auto', marginTop: 10 }}>
                  <table>
                    <thead><tr><th>#</th><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>ต้นทุนเดิม</th><th style={{ textAlign: 'right' }}>ต้นทุนใหม่ (จากไฟล์)</th></tr></thead>
                    <tbody>
                      {dupUnits.map((d, i) => {
                        const hasNew = d.row.cost.trim() !== ''
                        return (
                          <tr key={i}>
                            <td className="muted">{i + 1}</td>
                            <td className="mono">{d.row.lvb}</td>
                            <td className="mono">{d.row.om}</td>
                            <td style={{ textAlign: 'right' }}>{fmtBaht(d.oldCost)}</td>
                            <td style={{ textAlign: 'right' }}>
                              {dupAction === 'skip' ? <span className="muted">— (ข้าม)</span>
                                : hasNew ? fmtBaht(Number(d.row.cost))
                                : <span className="muted">คงเดิม</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* เครื่องใหม่ที่จะรับเข้า */}
          {newUnits.length > 0 && (
            <>
              <div className="muted" style={{ marginBottom: 6 }}>เครื่องใหม่ที่จะรับเข้า {newUnits.length} เครื่อง</div>
              <div className="table-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>#</th><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>ต้นทุน/เครื่อง</th></tr></thead>
                  <tbody>
                    {newUnits.map((u, i) => (
                      <tr key={i}>
                        <td className="muted">{i + 1}</td>
                        <td className="mono">{u.lvb}</td>
                        <td className="mono">{u.om}</td>
                        <td style={{ textAlign: 'right' }}>{u.cost ? fmtBaht(Number(u.cost)) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {newUnits.length === 0 && dupUnits.length === 0 && errors.length === 0 && (
            <div className="empty">ไม่พบรายการในไฟล์</div>
          )}
        </Modal>
        )
      })()}
    </>
  )
}
