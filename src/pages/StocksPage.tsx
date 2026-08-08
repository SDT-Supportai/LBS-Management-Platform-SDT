import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import {
  stockSummary, unitInstallState, unitInstallDate, stockComments,
  unitEta, unitEtaIsAuto, unitStockState, unitLeadDays, addDaysIso,
  ETA_LEAD_DAYS, ETA_LEAD_MIN, ETA_LEAD_MAX,
} from '../data/logic'
import { Modal, useConfirm, useToast, useTryAction, toBudgetNum } from '../ui/components'
import { fmtBaht, fmtDate, fmtDateTime, DEPT_LABEL } from '../ui/format'

// ฟอร์มแก้ข้อมูลรายเครื่อง (0043/0049) — รวม "แก้ Serial" เข้ามาในฟอร์มเดียวแล้ว
// serialLvb/serialOm แก้ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (in_stock) — บันทึกผ่าน updateUnitInfo แยก call
interface PlanForm {
  id: string; canEditSerial: boolean
  serialLvb: string; serialOm: string
  origLvb: string; origOm: string
  cost: string
  customerName: string; contactPhone: string; installLocation: string
  fobDate: string; leadDays: string; planPoReceiptDate: string; planDeliveryDate: string
}

// ฟอร์มกรอกมือใช้แค่ 3 ช่องแรก · ช่องข้อมูลแผน (0048/0049) มาจาก Import Excel เท่านั้น
interface UnitRow {
  lvb: string; om: string; cost: string
  customer?: string; phone?: string; location?: string
  fob?: string; leadDays?: number; planPoReceipt?: string; planDelivery?: string
}
const emptyRow = (): UnitRow => ({ lvb: '', om: '', cost: '' })

// UnitRow (ฟอร์ม string) → payload logic/RPC · ช่องว่าง = ไม่ส่งไป (คงค่าเดิมฝั่ง server)
const rowsToUnits = (rows: UnitRow[]) =>
  rows.map(r => ({
    lvb: r.lvb, om: r.om, cost: toBudgetNum(r.cost),
    customer: r.customer, phone: r.phone, location: r.location,
    fob: r.fob, leadDays: r.leadDays, planPoReceipt: r.planPoReceipt, planDelivery: r.planDelivery,
  }))

// Excel: เซลล์วันที่อ่านมาเป็น Date (อ่านด้วย cellDates) หรือเป็นข้อความ YYYY-MM-DD จากไฟล์ Export
// คืน '' ถ้าอ่านไม่ได้ → ถือว่าไม่ได้กรอก (คงค่าเดิม) ไม่ใช่ error
function toIsoDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`   // local time กัน timezone เลื่อนวัน
  }
  const s = String(v ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return ''
}

// สเปกคงที่ของ LBS ที่รับเข้าคลัง (แสดงเป็น Description ทุกคลัง)
const LBS_DESCRIPTION = '115 kV Load Break Switch with SF6 Gas Interrupters, 2000A'

const UNIT_STATUS_LABEL: Record<string, string> = {
  in_stock: 'อยู่ในสต็อก', allocated: 'ถูกดึงเข้า Job', issued: 'เบิกติดตั้งแล้ว',
}

// อ่านค่าจากหัวตารางหลายรูปแบบ (ไทยตามไฟล์ export / อังกฤษ)
function rawCell(row: Record<string, unknown>, keys: string[]): unknown {
  for (const [k, v] of Object.entries(row)) {
    if (keys.some(key => k.trim().toLowerCase() === key.toLowerCase())) return v
  }
  return undefined
}
function cell(row: Record<string, unknown>, keys: string[]): string {
  const v = rawCell(row, keys)
  return v === undefined ? '' : String(v ?? '').trim()
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
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  const { show } = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [addTo, setAddTo] = useState<string | null>(null)
  const [openStock, setOpenStock] = useState<string | null>(null)         // เริ่มต้นซ่อนรายการทุกคลัง
  const [showAccessory, setShowAccessory] = useState(false)               // คลังสินค้า (Ref.Job) เริ่มต้นซ่อน
  const [editStock, setEditStock] = useState<string | null>(null)
  const [editNotes, setEditNotes] = useState('')
  const [editPoNo, setEditPoNo] = useState('')
  const [editStatus, setEditStatus] = useState<'open' | 'closed'>('open')
  const [editPlan, setEditPlan] = useState<PlanForm | null>(null)
  const [costStock, setCostStock] = useState<string | null>(null)          // ดูต้นทุนรายเครื่อง (กดจากป้ายมูลค่าคลัง)
  const [fobStock, setFobStock] = useState<string | null>(null)            // ตั้ง FOB date ทั้งคลัง
  const [fobDate, setFobDate] = useState('')
  const [fobLead, setFobLead] = useState(String(ETA_LEAD_DAYS))
  const [fobOverwrite, setFobOverwrite] = useState(false)
  const [stockComment, setStockComment] = useState('')                     // ความเห็นผู้บริหารเรื่องคลัง (0051)
  const [importPreview, setImportPreview] = useState<{
    stockId: string; stockNo: string
    newUnits: UnitRow[]
    // ซ้ำในคลังนี้ (คู่ Serial ตรง) — เลือกอัพเดท/ข้าม · hasJob = ข้ามช่องลูกค้า (ค่าจริงจาก Job)
    // locked = เบิกแล้ว trigger ล็อกทั้งแถว
    dupUnits: { row: UnitRow; oldCost?: number; hasJob?: boolean; locked?: boolean }[]
    errors: string[]
  } | null>(null)
  const [dupAction, setDupAction] = useState<'update' | 'skip'>('update')
  const [importing, setImporting] = useState(false)
  const importFileRef = useRef<HTMLInputElement>(null)
  const importToRef = useRef<{ id: string; no: string } | null>(null)

  const [stockNo, setStockNo] = useState(`Project Stock No.${db.projectStocks.length + 1}`)
  const [rows, setRows] = useState<UnitRow[]>([emptyRow()])
  const [notes, setNotes] = useState('')
  const [poNo, setPoNo] = useState('')

  const lbsItem = db.items.find(i => i.itemType === 'main_equipment')!
  const canManage = can(user, 'stock.manage')
  // ความเห็นผู้บริหารเรื่องคลัง (0051) — VIP เขียน · Division ตอบกลับ · ทุกแผนกอ่านได้
  const canComment = can(user, 'approval.comment')
  const isVip = user?.department === 'vip'
  const vipComments = stockComments(db)
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
      () => act.createProjectStock({ stockNo, itemId: lbsItem.id, units: rowsToUnits(rows), notes, poNo }),
      `สร้าง ${stockNo} เรียบร้อย`,
    )) {
      setShowCreate(false); setRows([emptyRow()]); setNotes(''); setPoNo('')
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
        'สถานะเครื่อง': u.status === 'issued'
          ? { pending: 'เบิกแล้ว รอติดตั้ง', installed: 'ติดตั้งแล้ว', blocked: 'ติดตั้งไม่ได้' }[unitInstallState(db, u.id)]
          : UNIT_STATUS_LABEL[u.status] ?? u.status,
        'Job No.': job?.jobNo ?? '',
        'ชื่อลูกค้า': job?.customerName ?? u.planCustomerName ?? '',
        'เบอร์ติดต่อ': job?.contactPhone ?? u.planContactPhone ?? '',
        'สถานที่ติดตั้ง': job?.installLocation || u.planInstallLocation || '',
        'FOB date': u.fobDate ?? '',
        'ระยะขนส่ง (วัน)': u.fobDate ? unitLeadDays(u) : '',
        // ETA to WH / Status = ค่าคำนวณ (FOB + ระยะขนส่ง) — Export ไว้อ่าน · Import จะไม่เขียนทับถ้ามี FOB
        'ETA to WH': unitEta(u) ?? '',
        'Status': unitStockState(u) === 'pending' ? 'Pending' : 'On Hand',
        'Plan Delivery': u.planDeliveryDate ?? '',
        'Actual Delivery': unitInstallDate(db, u.id) ?? '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 24 }, { wch: 14 }, { wch: 28 }, { wch: 13 }, { wch: 15 }, { wch: 13 }, { wch: 11 }, { wch: 14 }, { wch: 14 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, s.stockNo.slice(0, 31))
    XLSX.writeFile(wb, `${s.stockNo.replace(/[\\/:*?"<>|]/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const onPickImportFile = async (file: File) => {
    const target = importToRef.current
    if (!target) return
    try {
      const XLSX = await import('xlsx')
      // cellDates: เซลล์วันที่ (Plan PO receipt / Plan Delivery) จะได้เป็น Date ไม่ใช่ serial number
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      if (raw.length === 0) return show('ไฟล์ไม่มีข้อมูล — ต้องมีหัวตาราง Serial.LVB, Serial.OM', true)

      const newUnits: UnitRow[] = []
      const dupUnits: { row: UnitRow; oldCost?: number; hasJob?: boolean; locked?: boolean }[] = []
      const errors: string[] = []
      const stockNoOf = (id: string) => db.projectStocks.find(s => s.id === id)?.stockNo ?? '?'
      const seenInFile = new Set<string>()          // กันซ้ำภายในไฟล์ (ข้าม field ด้วย)
      raw.forEach((row, i) => {
        const lvb = cell(row, ['Serial.LVB', 'serial.lvb', 'serial_lvb', 'lvb'])
        const om = cell(row, ['Serial.OM', 'serial.om', 'serial_om', 'om'])
        const costStr = cell(row, ['ต้นทุน/เครื่อง', 'ต้นทุน', 'unit_cost', 'cost'])
        // ข้อมูลแผนรายเครื่อง (0048/0049) — ช่องว่าง = คงค่าเดิม
        const fob = toIsoDate(rawCell(row, ['FOB date', 'fob date', 'fob', 'fob_date'])) || undefined
        // "ETA to WH" ในไฟล์ = ค่าคำนวณจาก FOB → ถ้าแถวนี้มี FOB ให้ข้าม (กันเขียนค่า auto ทับเป็นค่ากรอกมือ)
        // แถวที่ไม่มี FOB จึงจะรับ ETA เป็นค่ากรอกเอง (ลงคอลัมน์เดิม plan_po_receipt_date)
        const etaCell = toIsoDate(rawCell(row, ['ETA to WH', 'eta to wh', 'eta', 'Plan PO receipt', 'plan po receipt', 'plan_po_receipt'])) || undefined
        const leadStr = cell(row, ['ระยะขนส่ง (วัน)', 'ระยะขนส่ง', 'lead', 'lead_days', 'lead days'])
        if (fob && leadStr !== '' && (!Number.isInteger(Number(leadStr)) || Number(leadStr) < 1 || Number(leadStr) > 365))
          return void errors.push(`แถว ${i + 2}: ระยะขนส่ง "${leadStr}" ต้องเป็นจำนวนเต็ม 1–365 วัน`)
        const plan = {
          customer: cell(row, ['ชื่อลูกค้า', 'ลูกค้า', 'customer', 'customer_name']) || undefined,
          phone: cell(row, ['เบอร์ติดต่อ', 'เบอร์', 'phone', 'contact_phone']) || undefined,
          location: cell(row, ['สถานที่ติดตั้ง', 'สถานที่', 'location', 'install_location']) || undefined,
          fob,
          // ระยะขนส่งมีความหมายเฉพาะเมื่อมี FOB (ไม่มี FOB = ETA กรอกตรงๆ ไม่ต้องคำนวณ)
          leadDays: fob && leadStr !== '' ? Number(leadStr) : undefined,
          planPoReceipt: fob ? undefined : etaCell,
          planDelivery: toIsoDate(rawCell(row, ['Plan Delivery', 'plan delivery', 'plan_delivery'])) || undefined,
        }
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
          dupUnits.push({
            row: { lvb, om, cost: costStr, ...plan },
            oldCost: exact.unitCost,
            hasJob: !!exact.jobId,               // มี Job แล้ว → ข้อมูลลูกค้าใช้ค่าจาก Job (กฎ 0014)
            locked: exact.status === 'issued',   // เบิกแล้ว → trigger ล็อก แก้ไม่ได้
          })
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
        // เครื่องใหม่ — ยังไม่มี Job ใส่ข้อมูลแผนได้ทุกช่อง
        seenInFile.add(lvb); seenInFile.add(om)
        newUnits.push({ lvb, om, cost: costStr, ...plan })
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
    // ส่งเครื่องที่เบิกแล้วไปด้วย ให้ฝั่ง server/logic เป็นคนข้าม+นับ → audit บันทึกครบว่าข้ามกี่เครื่อง
    // (กติกาอยู่ที่เดียว ไม่ต้อง maintain 2 ที่) · เครื่องที่มี Job ตัดเฉพาะช่องลูกค้าออกก่อนส่ง
    const updateUnits = dupAction === 'update'
      ? rowsToUnits(importPreview.dupUnits.map(d => d.hasJob
          ? { ...d.row, customer: undefined, phone: undefined, location: undefined }
          : d.row))
      : []
    const lockedCount = dupAction === 'update' ? importPreview.dupUnits.filter(d => d.locked).length : 0
    const msg = [
      newUnits.length ? `รับเข้า ${newUnits.length} เครื่อง` : '',
      updateUnits.length - lockedCount > 0 ? `อัพเดทข้อมูล ${updateUnits.length - lockedCount} เครื่อง` : '',
      lockedCount ? `ข้ามเครื่องที่เบิกแล้ว ${lockedCount} เครื่อง` : '',
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
        คลังกลาง 115kV LBS ติดตามรายเครื่องด้วย Serial คู่ (LVB · OM) — Project ดึงเข้างานตามลำดับ ·
        <b> ETA to WH = FOB + {ETA_LEAD_DAYS} วัน</b> (คำนวณอัตโนมัติ) → Status <b>Pending</b> เมื่อยังไม่ถึงกำหนด · <b>On Hand</b> เมื่อถึง/เกินกำหนด
        {!canManage && ' · แผนกของคุณดูได้อย่างเดียว (สร้าง/รับเข้าสต็อกเป็นสิทธิ์ของ Division)'}
      </div>

      {canManage && (
        <div style={{ marginBottom: 16 }}>
          <button className="primary" onClick={() => { setRows([emptyRow()]); setStockNo(`Project Stock No.${db.projectStocks.length + 1}`); setPoNo(''); setNotes(''); setShowCreate(true) }}>+ สร้าง Project Stock ใหม่ (สั่งซื้อ LBS เข้าคลัง)</button>
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
                <span className="badge green" title="อยู่ในคลังจริง (ETA ถึงแล้ว) — ดึงเข้า Job ได้">On Hand {sum.onHand}</span>{' '}
                {sum.pending > 0 && (
                  <span className="badge amber" title={`รับเข้าระบบแล้วแต่ ETA to WH ยังไม่ถึง — อยู่ระหว่างขนส่ง (${sum.pending} เครื่อง)`}>
                    Pending {sum.pending}
                  </span>
                )}{' '}
                <span className="badge blue">ถูกดึง {sum.allocated}</span>{' '}
                <span className="badge neutral">เบิกแล้ว {sum.issued}</span>{' '}
                {sum.totalCost !== undefined && (
                  <button className="badge amber" type="button" style={{ cursor: 'pointer', border: 0 }}
                    title={`รวมต้นทุน ${sum.costedUnits}/${sum.total} เครื่องที่กรอกราคา — กดดูรายเครื่อง`}
                    onClick={() => setCostStock(s.id)}>
                    มูลค่าคลัง {fmtBaht(sum.totalCost)} ▸
                  </button>
                )}
              </h3>
              <div style={{ display: 'flex', gap: 8 }}>
                {s.status === 'closed' && <span className="badge red">ปิดคลัง</span>}
                <button className="small" onClick={() => exportStock(s.id)}>⬇ Export</button>
                {canManage && (
                  <button className="small" onClick={() => { importToRef.current = { id: s.id, no: s.stockNo }; importFileRef.current?.click() }}>⬆ Import</button>
                )}
                {canManage && (
                  <button className="small" title={`ตั้ง FOB date + ระยะขนส่ง ให้ทุกเครื่องในคลังนี้ — ETA to WH = FOB + ${ETA_LEAD_MIN}–${ETA_LEAD_MAX} วัน`}
                    onClick={() => { setFobDate(''); setFobLead(String(ETA_LEAD_DAYS)); setFobOverwrite(false); setFobStock(s.id) }}>🚢 ตั้ง FOB ทั้งคลัง</button>
                )}
                {canManage && <button className="small" onClick={() => { setRows([emptyRow()]); setAddTo(s.id) }}>+ รับ LBS เพิ่ม</button>}
                {canManage && <button className="small" onClick={() => { setEditNotes(s.notes ?? ''); setEditPoNo(s.poNo ?? ''); setEditStatus(s.status); setEditStock(s.id) }}>แก้ไข</button>}
                {canManage && (
                  <button className="small danger" onClick={async () => {
                    if (await askConfirm({
                      title: `ลบ ${s.stockNo}`,
                      description: <>
                        <b>Serial ทั้ง {sum.total} เครื่องในคลังนี้จะถูกลบไปด้วย</b> · กู้คืนไม่ได้ —
                        ระบบจะไม่ให้ลบถ้าคลังนี้เคยมีประวัติดึง/คืน LBS (ถ้าเลิกใช้แล้วให้ "ปิดคลัง" แทน)
                      </>,
                      confirmLabel: 'ลบคลังนี้',
                    })) tryAction(() => act.deleteProjectStock({ stockId: s.id }), `ลบ ${s.stockNo} แล้ว`)
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
                {/* grid = ตีเส้นตารางบางๆ ทุกช่อง (อ่านตารางกว้างง่ายขึ้น) · ต้นทุน/เครื่องไม่แสดงที่นี่ — กดป้าย "มูลค่าคลัง" ดูแทน */}
                <table className="grid">
                  <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th>สถานะเครื่อง</th><th>ชื่อลูกค้า</th><th>เบอร์ติดต่อ</th><th>สถานที่ติดตั้ง</th><th>Job No.</th><th>FOB date</th><th>ETA to WH</th><th>Status</th><th>Plan Delivery</th><th>Actual Delivery</th>{canManage && <th></th>}</tr></thead>
                  <tbody>
                    {units.map(u => {
                      // ข้อมูลลูกค้า "จริง" ref จาก Job ที่เครื่องถูกดึงเข้า (0014) — ยังไม่เข้า Job ใช้ค่าแผน (0043)
                      const job = u.jobId ? db.jobs.find(j => j.id === u.jobId) : undefined
                      // ค่าจาก Job ชนะ · ถ้าไม่มี Job ใช้ค่าแผนแล้วติดป้าย "แผน" ให้เห็นว่ายังไม่ผูกงาน
                      const planned = !job
                      const cust = job?.customerName ?? u.planCustomerName
                      const phone = job?.contactPhone ?? u.planContactPhone
                      const loc = job?.installLocation || u.planInstallLocation
                      // สถานะ + Actual Delivery = auto ตาม flow Service (0035) ไม่มีคอลัมน์เก็บซ้ำ
                      const installState = u.status === 'issued' ? unitInstallState(db, u.id) : 'pending'
                      const actualDelivery = unitInstallDate(db, u.id)
                      // ETA to WH = FOB + 60 วัน (auto) หรือค่าที่กรอกเอง · Status = Pending/On Hand ตาม ETA
                      const eta = unitEta(u)
                      const etaAuto = unitEtaIsAuto(u)
                      const onHand = unitStockState(u) === 'on_hand'
                      return (
                        <tr key={u.id}>
                          <td className="mono">{u.serialLvb}</td>
                          <td className="mono">{u.serialOm}</td>
                          <td>
                            {u.status === 'in_stock' && <span className="badge green">อยู่ในสต็อก</span>}
                            {u.status === 'allocated' && <span className="badge blue">ถูกดึงเข้า Job</span>}
                            {u.status === 'issued' && installState === 'pending' && <span className="badge neutral">เบิกแล้ว รอติดตั้ง</span>}
                            {u.status === 'issued' && installState === 'installed' && <span className="badge green">ติดตั้งแล้ว</span>}
                            {u.status === 'issued' && installState === 'blocked' && <span className="badge red">ติดตั้งไม่ได้</span>}
                          </td>
                          <td>{cust ?? '-'}{planned && cust && <span className="badge neutral" style={{ marginLeft: 6 }}>แผน</span>}</td>
                          <td>{phone ?? '-'}</td>
                          <td>{loc || '-'}</td>
                          <td>{u.jobId ? <Link to={`/jobs/${u.jobId}`}>{jobNo(u.jobId)}</Link> : '-'}</td>
                          <td>{fmtDate(u.fobDate)}</td>
                          <td>
                            {eta ? fmtDate(eta) : '-'}
                            {eta && etaAuto && (
                              <span className="badge neutral" style={{ marginLeft: 6 }}
                                title={`คำนวณอัตโนมัติ = FOB + ${unitLeadDays(u)} วัน`}>+{unitLeadDays(u)} วัน</span>
                            )}
                          </td>
                          <td>
                            {onHand
                              ? <span className="badge green" title="ETA ถึง/เกินแล้ว — ของอยู่ที่คลัง">On Hand</span>
                              : <span className="badge amber" title={`ยังไม่ถึง ETA to WH (${fmtDate(eta)}) — อยู่ระหว่างขนส่ง`}>Pending</span>}
                          </td>
                          <td>{fmtDate(u.planDeliveryDate)}</td>
                          <td>{actualDelivery ? fmtDate(actualDelivery) : '-'}</td>
                          {canManage && (
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {u.status === 'issued'
                                ? <span className="muted" title="เบิกให้ Service แล้ว — allocation ถูกล็อก แก้ข้อมูลรายเครื่องไม่ได้">🔒</span>
                                : <button className="small" onClick={() => setEditPlan({
                                    id: u.id, canEditSerial: u.status === 'in_stock',
                                    serialLvb: u.serialLvb, serialOm: u.serialOm,
                                    origLvb: u.serialLvb, origOm: u.serialOm,
                                    cost: u.unitCost !== undefined ? String(u.unitCost) : '',
                                    customerName: u.planCustomerName ?? '', contactPhone: u.planContactPhone ?? '',
                                    installLocation: u.planInstallLocation ?? '',
                                    fobDate: u.fobDate ?? '', leadDays: String(unitLeadDays(u)),
                                    planPoReceiptDate: u.planPoReceiptDate ?? '', planDeliveryDate: u.planDeliveryDate ?? '',
                                  })}>แก้ข้อมูล</button>}
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
              PO No.: {s.poNo || '-'} · Remark: {s.notes || '-'} · สร้างเมื่อ {fmtDate(s.createdAt)} โดย {db.users.find(u => u.id === s.createdBy)?.fullName}
            </div>
          </div>
        )
      })}

      {/* วัสดุตาม Job (Ref.PO) — เป็น "รายงาน" ของ line ที่รับของครบจาก PO ไม่ใช่คลังที่มียอดคงเหลือ
          เปลี่ยนชื่อจาก "คลังสินค้า (Ref.Job)" เพื่อไม่ให้สับสนกับ "คลังคงเหลือ" ที่เป็นคลังจริง (S2) */}
      <div className="panel">
        <div className="panel-head">
          <h3>วัสดุตาม Job (Ref.PO)
            <span className="muted" style={{ fontWeight: 400 }}> · วัสดุที่รับครบจาก PO แล้วผูกกับ Job — ไม่ใช่ยอดคลังคงเหลือ</span>
          </h3>
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

      {/* ความเห็นผู้บริหาร (VIP) เรื่องคลัง LBS โดยรวม (0051) — วางท้ายหน้าใต้ "วัสดุตาม Job (Ref.PO)"
          อ่านได้ทุกแผนก · เขียนได้ VIP / Division / Manage (perm approval.comment) */}
      <div className="panel">
        <div className="panel-head">
          <h3>💬 ความเห็นผู้บริหาร (VIP) — คลัง LBS
            <span className="muted" style={{ fontWeight: 400 }}> · ข้อสังเกต/ข้อสั่งการเรื่องสต็อกภาพรวม</span>
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
              <textarea rows={2} style={{ flex: 1 }} value={stockComment}
                onChange={e => setStockComment(e.target.value)}
                placeholder={isVip
                  ? 'เช่น "ล็อต Stock No.3 ETA ต.ค. ช้าไป ให้ตามซัพเรื่องวันลงเรืออีกครั้ง"'
                  : 'ตอบกลับความเห็นของผู้บริหาร'} />
              <button className="primary small" disabled={!stockComment.trim()}
                onClick={async () => {
                  if (await tryAction(
                    () => act.addStockComment({ body: stockComment }),
                    isVip ? 'ส่งความเห็นถึง Division แล้ว' : 'บันทึกความเห็นแล้ว — แจ้ง VIP ให้ทราบ',
                  )) setStockComment('')
                }}>ส่งความเห็น</button>
            </div>
          )}
        </div>
      </div>

      {editStock && (
        <Modal
          title={`แก้ไข ${db.projectStocks.find(s => s.id === editStock)?.stockNo}`}
          onClose={() => setEditStock(null)}
          footer={<>
            <button onClick={() => setEditStock(null)}>ยกเลิก</button>
            <button className="primary" onClick={async () => {
              if (await tryAction(() => act.updateProjectStock({ stockId: editStock, notes: editNotes, status: editStatus, poNo: editPoNo }), 'บันทึกแล้ว'))
                setEditStock(null)
            }}>บันทึก</button>
          </>}
        >
          <label className="field"><span>PO No.</span>
            <input className="mono" value={editPoNo} onChange={e => setEditPoNo(e.target.value)} placeholder="เช่น PO-2026-0007 (ว่างได้)" />
          </label>
          <label className="field"><span>Remark</span>
            <input value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="หมายเหตุ (ว่างได้)" />
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
          <div className="row">
            <label className="field"><span>Stock No.</span>
              <input value={stockNo} onChange={e => setStockNo(e.target.value)} />
            </label>
            <label className="field"><span>PO No. (ว่างได้ · แก้ภายหลังได้)</span>
              <input className="mono" value={poNo} onChange={e => setPoNo(e.target.value)} placeholder="เช่น PO-2026-0007" />
            </label>
          </div>
          <div className="muted" style={{ marginBottom: 12 }}>
            <b>Description:</b> {LBS_DESCRIPTION}<br />
            ข้อมูลลูกค้า/สถานที่ติดตั้งไม่ต้องกรอกที่คลัง — ระบบอ้างอิงจาก Job ที่เครื่องถูกดึงเข้า
          </div>
          <label className="field"><span>Serial No. ของ LBS แต่ละเครื่อง (Serial.LVB + Serial.OM บังคับทั้งคู่)</span></label>
          <UnitRowsEditor rows={rows} setRows={setRows} />
          <label className="field" style={{ marginTop: 14 }}><span>Remark (ว่างได้ · แก้ภายหลังได้)</span>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="เช่น ล็อตสั่งซื้อรอบที่ 3" />
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

      {/* แก้ข้อมูลรายเครื่อง (0043/0049) — Division/Manage · ทำได้ก่อนเบิกให้ Service
          รวม "แก้ Serial" เข้ามาที่นี่แล้ว (เดิมเป็นปุ่มแยก) — Serial แก้ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก */}
      {editPlan && (() => {
        const serialChanged = editPlan.serialLvb.trim() !== editPlan.origLvb || editPlan.serialOm.trim() !== editPlan.origOm
        const serialEmpty = !editPlan.serialLvb.trim() || !editPlan.serialOm.trim()
        // ETA to WH: มี FOB → คำนวณอัตโนมัติ (ช่องกรอกเองถูกปิด) · ไม่มี FOB → กรอกเองได้
        const lead = Number(editPlan.leadDays) || ETA_LEAD_DAYS
        const autoEta = editPlan.fobDate ? addDaysIso(editPlan.fobDate, lead) : ''
        return (
        <Modal
          title="แก้ข้อมูลรายเครื่อง"
          size="wide"
          onClose={() => setEditPlan(null)}
          footer={<>
            <button onClick={() => setEditPlan(null)}>ยกเลิก</button>
            <button className="primary" disabled={editPlan.canEditSerial && serialEmpty} onClick={async () => {
              if (await tryAction(
                async () => {
                  // แก้ Serial ก่อน (มี guard unique ฝั่ง server) แล้วค่อยบันทึกข้อมูลแผน
                  if (editPlan.canEditSerial && serialChanged) {
                    await act.updateUnitInfo({
                      unitId: editPlan.id,
                      serialLvb: editPlan.serialLvb.trim(), serialOm: editPlan.serialOm.trim(),
                    })
                  }
                  await act.updateUnitPlan({
                    unitId: editPlan.id,
                    unitCost: toBudgetNum(editPlan.cost),
                    planCustomerName: editPlan.customerName,
                    planContactPhone: editPlan.contactPhone,
                    planInstallLocation: editPlan.installLocation,
                    fobDate: editPlan.fobDate,
                    etaLeadDays: editPlan.fobDate ? lead : undefined,
                    // มี FOB → ETA เป็นค่าคำนวณ ไม่เก็บซ้ำ (ล้างค่ากรอกมือทิ้ง)
                    planPoReceiptDate: editPlan.fobDate ? '' : editPlan.planPoReceiptDate,
                    planDeliveryDate: editPlan.planDeliveryDate,
                  })
                },
                serialChanged ? 'บันทึกข้อมูล + แก้ Serial แล้ว' : 'บันทึกข้อมูลรายเครื่องแล้ว',
              )) setEditPlan(null)
            }}>บันทึก</button>
          </>}
        >
          <div className="muted" style={{ marginBottom: 12 }}>
            ช่องที่เว้นว่าง = ล้างค่าเดิม ·
            ลูกค้า/เบอร์/สถานที่ ที่กรอกที่นี่คือ <b>ข้อมูลแผน</b> — เมื่อเครื่องถูกดึงเข้า Job ตารางจะแสดงค่าจาก Job แทน
            (Job เป็นแหล่งข้อมูลจริงตามกติกาเดิมของระบบ) · <b>Status / Actual Delivery ไม่ต้องกรอก</b> ระบบคำนวณเองจาก ETA และ flow ติดตั้ง
          </div>

          <div className="row">
            <label className="field"><span>Serial.LVB *</span>
              <input className="mono" value={editPlan.serialLvb} disabled={!editPlan.canEditSerial}
                onChange={e => setEditPlan({ ...editPlan, serialLvb: e.target.value })} />
            </label>
            <label className="field"><span>Serial.OM *</span>
              <input className="mono" value={editPlan.serialOm} disabled={!editPlan.canEditSerial}
                onChange={e => setEditPlan({ ...editPlan, serialOm: e.target.value })} />
            </label>
          </div>
          {!editPlan.canEditSerial && (
            <div className="muted" style={{ marginTop: -6, marginBottom: 10 }}>
              🔒 เครื่องนี้ถูกดึงเข้า Job แล้ว — แก้ Serial ไม่ได้ (เลข Serial ถูก snapshot ไว้ในประวัติการดึง)
              · ถ้าต้องเปลี่ยนเครื่อง ใช้ฟังก์ชัน <b>สลับ LBS</b> ที่หน้า Job
            </div>
          )}

          <div className="row">
            <label className="field"><span>ต้นทุน/เครื่อง (฿)</span>
              <input type="number" min={0} value={editPlan.cost}
                onChange={e => setEditPlan({ ...editPlan, cost: e.target.value })} />
            </label>
            <label className="field"><span>ชื่อลูกค้า (แผน)</span>
              <input value={editPlan.customerName}
                onChange={e => setEditPlan({ ...editPlan, customerName: e.target.value })} placeholder="PEA เชียงใหม่" />
            </label>
          </div>
          <div className="row">
            <label className="field"><span>เบอร์ติดต่อ (แผน)</span>
              <input value={editPlan.contactPhone}
                onChange={e => setEditPlan({ ...editPlan, contactPhone: e.target.value })} placeholder="08x-xxx-xxxx" />
            </label>
            <label className="field"><span>สถานที่ติดตั้ง (แผน)</span>
              <input value={editPlan.installLocation}
                onChange={e => setEditPlan({ ...editPlan, installLocation: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <label className="field"><span>FOB date (วันลงเรือ)</span>
              <input type="date" value={editPlan.fobDate}
                onChange={e => setEditPlan({ ...editPlan, fobDate: e.target.value })} />
            </label>
            <label className="field">
              <span>ระยะขนส่ง (วัน) — เลือก {ETA_LEAD_MIN}–{ETA_LEAD_MAX}</span>
              <input type="number" min={ETA_LEAD_MIN} max={ETA_LEAD_MAX} step={1}
                value={editPlan.leadDays} disabled={!editPlan.fobDate}
                onChange={e => setEditPlan({ ...editPlan, leadDays: e.target.value })} />
            </label>
            <label className="field">
              <span>ETA to WH {editPlan.fobDate ? `(auto = FOB + ${lead} วัน)` : '(กรอกเองเมื่อไม่มี FOB)'}</span>
              <input type="date" value={editPlan.fobDate ? autoEta : editPlan.planPoReceiptDate}
                disabled={!!editPlan.fobDate}
                onChange={e => setEditPlan({ ...editPlan, planPoReceiptDate: e.target.value })} />
            </label>
          </div>
          <div className="muted" style={{ marginTop: -6, marginBottom: 10 }}>
            ระยะขนส่งต่างกันได้ตามเส้นทางเรือ/ซัพพลายเออร์ (ค่ามาตรฐาน {ETA_LEAD_DAYS} วัน) ·
            Status คำนวณจาก ETA to WH: ยังไม่ถึงกำหนด = <b>Pending</b> · ถึง/เกินกำหนด (หรือไม่ระบุ ETA) = <b>On Hand</b>
          </div>
          <div className="row">
            <label className="field"><span>Plan Delivery (กำหนดส่งมอบ/ติดตั้ง)</span>
              <input type="date" value={editPlan.planDeliveryDate}
                onChange={e => setEditPlan({ ...editPlan, planDeliveryDate: e.target.value })} />
            </label>
            <div className="field" />
          </div>
        </Modal>
        )
      })()}

      {/* ตั้ง FOB date ทั้งคลัง (0049) — ล็อตหนึ่ง PO มักลงเรือพร้อมกัน */}
      {fobStock && (() => {
        const s = db.projectStocks.find(x => x.id === fobStock)!
        const stockUnits = db.lbsUnits.filter(u => u.projectStockId === fobStock && u.status !== 'issued')
        const target = fobOverwrite ? stockUnits : stockUnits.filter(u => !u.fobDate)
        return (
        <Modal title={`ตั้ง FOB date ทั้งคลัง — ${s.stockNo}`} onClose={() => setFobStock(null)}
          footer={<>
            <button onClick={() => setFobStock(null)}>ยกเลิก</button>
            <button className="primary" disabled={!fobDate} onClick={async () => {
              if (await tryAction(
                () => act.setStockFob({ stockId: fobStock, fobDate, leadDays: Number(fobLead) || ETA_LEAD_DAYS, overwrite: fobOverwrite }),
                `ตั้ง FOB date ให้ ${s.stockNo} แล้ว`,
              )) setFobStock(null)
            }}>ตั้ง FOB ({target.length} เครื่อง)</button>
          </>}>
          <div className="row">
            <label className="field"><span>FOB date *</span>
              <input type="date" value={fobDate} onChange={e => setFobDate(e.target.value)} />
            </label>
            <label className="field"><span>ระยะขนส่ง (วัน) — เลือก {ETA_LEAD_MIN}–{ETA_LEAD_MAX}</span>
              <input type="number" min={ETA_LEAD_MIN} max={ETA_LEAD_MAX} step={1}
                value={fobLead} onChange={e => setFobLead(e.target.value)} />
            </label>
          </div>
          {fobDate && (
            <div className="muted" style={{ marginBottom: 10 }}>
              → ETA to WH = <b>{fmtDate(addDaysIso(fobDate, Number(fobLead) || ETA_LEAD_DAYS))}</b> (FOB + {Number(fobLead) || ETA_LEAD_DAYS} วัน)
            </div>
          )}
          <label className="field" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={fobOverwrite}
              onChange={e => setFobOverwrite(e.target.checked)} />
            <span style={{ margin: 0 }}>ทับ FOB เดิมที่เคยตั้งไว้
              <div className="muted">ไม่ติ๊ก = เติมเฉพาะเครื่องที่ยังไม่มี FOB (ปลอดภัยกว่า)</div>
            </span>
          </label>
          <div className="muted">
            จะมีผลกับ <b>{target.length}</b> เครื่องจาก {stockUnits.length} เครื่องที่ยังไม่ถูกเบิก
            {db.lbsUnits.filter(u => u.projectStockId === fobStock && u.status === 'issued').length > 0 &&
              ' · เครื่องที่เบิกให้ Service แล้วจะถูกข้าม (ถูกล็อก)'}
          </div>
        </Modal>
        )
      })()}

      {/* ต้นทุนรายเครื่อง — ย้ายออกจากตารางหลัก กดจากป้าย "มูลค่าคลัง" แทน */}
      {costStock && (() => {
        const s = db.projectStocks.find(x => x.id === costStock)!
        const sum = stockSummary(db, costStock)
        const list = db.lbsUnits.filter(u => u.projectStockId === costStock)
        return (
        <Modal title={`ต้นทุนรายเครื่อง — ${s.stockNo}`} size="wide" onClose={() => setCostStock(null)}
          footer={<button onClick={() => setCostStock(null)}>ปิด</button>}>
          <div className="muted" style={{ marginBottom: 10 }}>
            มูลค่าคลังรวม <b>{fmtBaht(sum.totalCost)}</b> · กรอกราคาแล้ว {sum.costedUnits}/{sum.total} เครื่อง
            {sum.costedUnits < sum.total && ' — เครื่องที่ยังไม่กรอกราคาไม่ถูกนับในมูลค่ารวม'}
          </div>
          <div className="table-scroll" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="grid">
              <thead><tr><th>#</th><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>ต้นทุน/เครื่อง</th><th>สถานะเครื่อง</th><th>Job No.</th></tr></thead>
              <tbody>
                {list.map((u, i) => (
                  <tr key={u.id}>
                    <td className="muted">{i + 1}</td>
                    <td className="mono">{u.serialLvb}</td>
                    <td className="mono">{u.serialOm}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBaht(u.unitCost)}</td>
                    <td className="muted">{UNIT_STATUS_LABEL[u.status] ?? u.status}</td>
                    <td>{u.jobId ? jobNo(u.jobId) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
        )
      })()}

      {/* ไฟล์ import ต่อคลัง (ปุ่ม ⬆ Import บนการ์ดเป็นคนกด) */}
      <input ref={importFileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onPickImportFile(f); e.target.value = '' }} />

      {importPreview && (() => {
        const { newUnits, dupUnits, errors } = importPreview
        const updatable = dupUnits.filter(d => !d.locked)
        const lockedCount = dupUnits.length - updatable.length
        const nothingToDo = newUnits.length === 0 && (updatable.length === 0 || dupAction === 'skip')
        const confirmLabel = importing ? 'กำลังนำเข้า…'
          : `ยืนยัน — รับใหม่ ${newUnits.length}${dupAction === 'update' && updatable.length ? ` · อัพเดท ${updatable.length}` : ''} เครื่อง`
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
                  <span><b>อัพเดทข้อมูลเครื่องเดิม</b> — ต้นทุน · ลูกค้า/เบอร์/สถานที่ (แผน) · FOB date · ETA to WH · Plan Delivery
                    <div className="muted">ช่องที่เว้นว่างในไฟล์ = คงค่าเดิม (ไม่ล้างค่า) · ถ้าต้องการล้างค่าให้ใช้ปุ่ม "แก้ข้อมูล" รายเครื่อง</div>
                  </span>
                </label>
                <label className="field" style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                  <input type="radio" name="dupAction" checked={dupAction === 'skip'} onChange={() => setDupAction('skip')} style={{ marginTop: 3 }} />
                  <span><b>ข้าม — ฉันกรอกซ้ำผิด</b> ไม่แตะเครื่องเดิม (รับเข้าเฉพาะเครื่องใหม่ {newUnits.length} เครื่อง)</span>
                </label>
                {lockedCount > 0 && (
                  <div style={{ color: 'var(--danger)', marginTop: 8 }}>
                    🔒 มี {lockedCount} เครื่องที่ <b>เบิกให้ Service แล้ว</b> — ระบบล็อกการแก้ไข จะถูกข้ามทั้งแถว
                  </div>
                )}
                {dupUnits.some(d => d.hasJob && !d.locked && (d.row.customer || d.row.phone || d.row.location)) && (
                  <div className="muted" style={{ marginTop: 6 }}>
                    ℹ️ เครื่องที่ดึงเข้า Job แล้ว ระบบจะ<b>ข้ามช่องลูกค้า/เบอร์/สถานที่</b> — ข้อมูลจริงมาจาก Job
                    (แก้ที่หน้า Job) · ส่วนต้นทุนกับวันแผนยังอัพเดทให้ตามไฟล์
                  </div>
                )}
                <div className="table-scroll" style={{ maxHeight: 260, overflowY: 'auto', marginTop: 10 }}>
                  <table>
                    <thead><tr>
                      <th>#</th><th>Serial.LVB</th><th>Serial.OM</th>
                      <th style={{ textAlign: 'right' }}>ต้นทุนเดิม</th><th style={{ textAlign: 'right' }}>ต้นทุนใหม่</th>
                      <th>ลูกค้า/เบอร์/สถานที่ (แผน)</th><th>FOB date</th><th>ETA to WH</th><th>Plan Delivery</th><th>ผล</th>
                    </tr></thead>
                    <tbody>
                      {dupUnits.map((d, i) => {
                        const hasNewCost = d.row.cost.trim() !== ''
                        const skip = dupAction === 'skip' || d.locked
                        const custParts = [d.row.customer, d.row.phone, d.row.location].filter(Boolean)
                        return (
                          <tr key={i}>
                            <td className="muted">{i + 1}</td>
                            <td className="mono">{d.row.lvb}</td>
                            <td className="mono">{d.row.om}</td>
                            <td style={{ textAlign: 'right' }}>{fmtBaht(d.oldCost)}</td>
                            <td style={{ textAlign: 'right' }}>
                              {skip ? <span className="muted">—</span>
                                : hasNewCost ? fmtBaht(Number(d.row.cost))
                                : <span className="muted">คงเดิม</span>}
                            </td>
                            <td>
                              {custParts.length === 0 ? <span className="muted">คงเดิม</span>
                                : skip ? <span className="muted">—</span>
                                : d.hasJob ? <span className="muted">ข้าม (ใช้ค่าจาก Job)</span>
                                : custParts.join(' · ')}
                            </td>
                            <td>{skip ? <span className="muted">—</span> : (d.row.fob ?? <span className="muted">คงเดิม</span>)}</td>
                            <td>
                              {skip ? <span className="muted">—</span>
                                : d.row.fob ? <>{addDaysIso(d.row.fob, d.row.leadDays ?? ETA_LEAD_DAYS)} <span className="badge neutral">+{d.row.leadDays ?? ETA_LEAD_DAYS} วัน</span></>
                                : (d.row.planPoReceipt ?? <span className="muted">คงเดิม</span>)}
                            </td>
                            <td>{skip ? <span className="muted">—</span> : (d.row.planDelivery ?? <span className="muted">คงเดิม</span>)}</td>
                            <td>
                              {d.locked ? <span className="badge red">🔒 เบิกแล้ว ข้าม</span>
                                : dupAction === 'skip' ? <span className="badge neutral">ข้าม</span>
                                : <span className="badge green">อัพเดท</span>}
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
                <table className="grid">
                  <thead><tr><th>#</th><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>ต้นทุน/เครื่อง</th><th>FOB date</th><th>ETA to WH</th></tr></thead>
                  <tbody>
                    {newUnits.map((u, i) => (
                      <tr key={i}>
                        <td className="muted">{i + 1}</td>
                        <td className="mono">{u.lvb}</td>
                        <td className="mono">{u.om}</td>
                        <td style={{ textAlign: 'right' }}>{u.cost ? fmtBaht(Number(u.cost)) : '-'}</td>
                        <td>{u.fob ?? '-'}</td>
                        <td>{u.fob ? <>{addDaysIso(u.fob, u.leadDays ?? ETA_LEAD_DAYS)} <span className="badge neutral">+{u.leadDays ?? ETA_LEAD_DAYS} วัน</span></> : (u.planPoReceipt ?? '-')}</td>
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
      {confirmEl}
    </>
  )
}
