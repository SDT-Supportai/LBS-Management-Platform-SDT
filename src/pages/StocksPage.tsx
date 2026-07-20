import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { stockSummary } from '../data/logic'
import { Modal, useToast, useTryAction } from '../ui/components'
import { fmtDate } from '../ui/format'

interface UnitRow { lvb: string; om: string }
const emptyRow = (): UnitRow => ({ lvb: '', om: '' })

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
          <span />
        </div>
        {rows.map((r, i) => (
          <div className="unit-row" key={i}>
            <span className="muted">{i + 1}</span>
            <input className="mono" value={r.lvb} placeholder="LBS26-001" onChange={e => update(i, 'lvb', e.target.value)} />
            <input className="mono" value={r.om} placeholder="OM26-001" onChange={e => update(i, 'om', e.target.value)} />
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
  const [importPreview, setImportPreview] = useState<{ stockId: string; stockNo: string; units: UnitRow[]; errors: string[] } | null>(null)
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
      () => act.createProjectStock({ stockNo, itemId: lbsItem.id, units: rows, notes }),
      `สร้าง ${stockNo} เรียบร้อย`,
    )) {
      setShowCreate(false); setRows([emptyRow()]); setNotes('')
    }
  }

  const submitAdd = async () => {
    if (!addTo) return
    if (await tryAction(
      () => act.addUnitsToStock({ stockId: addTo, units: rows }),
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
        'สถานะ': UNIT_STATUS_LABEL[u.status] ?? u.status,
        'Job No.': job?.jobNo ?? '',
        'ชื่อลูกค้า': job?.customerName ?? '',
        'เบอร์ติดต่อ': job?.contactPhone ?? '',
        'สถานที่ติดตั้ง': job?.installLocation ?? '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 24 }, { wch: 14 }, { wch: 28 }]
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

      const units: UnitRow[] = []
      const errors: string[] = []
      const seen = new Set(db.lbsUnits.flatMap(u => [u.serialLvb, u.serialOm]))
      raw.forEach((row, i) => {
        const lvb = cell(row, ['Serial.LVB', 'serial.lvb', 'serial_lvb', 'lvb'])
        const om = cell(row, ['Serial.OM', 'serial.om', 'serial_om', 'om'])
        if (!lvb && !om) return                       // ข้ามแถวว่าง
        const no = `แถว ${i + 2}`
        if (!lvb || !om) return void errors.push(`${no}: ต้องมีทั้ง Serial.LVB และ Serial.OM`)
        if (lvb === om) return void errors.push(`${no}: LVB กับ OM ห้ามเป็นเลขเดียวกัน (${lvb})`)
        if (seen.has(lvb) || seen.has(om)) return void errors.push(`${no}: "${lvb}" / "${om}" ซ้ำกับที่มีในระบบ/ในไฟล์`)
        seen.add(lvb); seen.add(om)
        units.push({ lvb, om })
      })
      if (units.length === 0 && errors.length === 0) return show('ไม่พบแถวที่กรอก Serial ในไฟล์', true)
      setImportPreview({ stockId: target.id, stockNo: target.no, units, errors })
    } catch {
      show('อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xlsx)', true)
    }
  }

  const runImport = async () => {
    if (!importPreview) return
    setImporting(true)
    const ok = await tryAction(
      () => act.addUnitsToStock({ stockId: importPreview.stockId, units: importPreview.units }),
      `รับเข้า ${importPreview.units.length} เครื่อง เข้า ${importPreview.stockNo} แล้ว`,
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
                <span className="badge neutral">เบิกแล้ว {sum.issued}</span>
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
                  <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th>สถานะ</th><th>ชื่อลูกค้า</th><th>เบอร์ติดต่อ</th><th>สถานที่ติดตั้ง</th><th>Job No.</th>{canManage && <th></th>}</tr></thead>
                  <tbody>
                    {units.map(u => {
                      // ข้อมูลลูกค้า ref จาก Job ที่เครื่องถูกดึงเข้า — เครื่องยังไม่เข้า Job = '-'
                      const job = u.jobId ? db.jobs.find(j => j.id === u.jobId) : undefined
                      return (
                        <tr key={u.id}>
                          <td className="mono">{u.serialLvb}</td>
                          <td className="mono">{u.serialOm}</td>
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
                      <td>{item.name} <span className="muted mono">{item.code}</span></td>
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

      {importPreview && (
        <Modal title={`Import Serial เข้า ${importPreview.stockNo} — ตรวจสอบก่อนยืนยัน`} onClose={() => setImportPreview(null)}
          footer={<>
            <button onClick={() => setImportPreview(null)} disabled={importing}>ยกเลิก</button>
            <button className="primary" disabled={importing || importPreview.units.length === 0 || importPreview.errors.length > 0}
              onClick={runImport}>
              {importing ? 'กำลังนำเข้า…' : `ยืนยันรับเข้า ${importPreview.units.length} เครื่อง`}
            </button>
          </>}>
          {importPreview.errors.length > 0 && (
            <div className="muted" style={{ color: 'var(--red)', marginBottom: 10 }}>
              พบปัญหา {importPreview.errors.length} แถว — แก้ไฟล์แล้ว import ใหม่:<br />
              {importPreview.errors.slice(0, 5).map((e, i) => <span key={i}>• {e}<br /></span>)}
              {importPreview.errors.length > 5 && <span>… และอีก {importPreview.errors.length - 5} แถว</span>}
            </div>
          )}
          <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>#</th><th>Serial.LVB</th><th>Serial.OM</th></tr></thead>
              <tbody>
                {importPreview.units.map((u, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td className="mono">{u.lvb}</td>
                    <td className="mono">{u.om}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  )
}
