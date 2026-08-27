import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import {
  stockSummary, unitInstallDate,
  unitEta, unitEtaIsAuto, unitFlowState, unitLeadDays, addDaysIso,
  ETA_LEAD_DAYS, ETA_LEAD_MIN, ETA_LEAD_MAX,
} from '../data/logic'
import { Modal, useConfirm, useToast, useTryAction, toBudgetNum } from '../ui/components'
import { fmtBaht, fmtDate, fmtDateTime, UNIT_FLOW } from '../ui/format'

// ---------------- Export: วัสดุตาม Job (Ref.PO) ----------------
// สเปกคอลัมน์รวมศูนย์ — แหล่งความจริงเดียวของทั้งไฟล์ Excel และชีต "คำอธิบาย"
// (แนวเดียวกับ SHEET_COLS ของ Project Stock และ PR_COLS ของหน้า Purchasing)
// ⚠️ export อย่างเดียว ไม่มี import กลับ — ไฟล์นี้เป็น "รายงานตรวจสอบ" ไม่ใช่แบบฟอร์มกรอก
const MAT_COLS: { key: string; width: number; note: string }[] = [
  { key: 'Job No.', width: 16, note: 'งานที่วัสดุชุดนี้ผูกอยู่' },
  { key: 'Customer', width: 24, note: 'ลูกค้าของงานนั้น' },
  { key: 'PO No.', width: 18, note: 'ใบสั่งซื้อที่รับของครบแล้ว (1 PR ออกได้หลาย PO)' },
  { key: 'ซัพพลายเออร์', width: 24, note: 'ชื่อที่กรอกไว้ตอนออก PO' },
  { key: 'วันที่รับของครบ', width: 16, note: 'วันที่ PO ใบนั้นปิดรับของ' },
  { key: 'รหัส Epicor', width: 18, note: 'รหัสอ้างอิงระบบ ERP' },
  { key: 'ชื่ออุปกรณ์', width: 30, note: 'ชื่อในฐานข้อมูลวัสดุ' },
  { key: 'จำนวนที่รับ', width: 12, note: 'จำนวนที่รับเข้ามาจริง (ไม่ใช่จำนวนที่สั่ง)' },
  { key: 'หน่วย', width: 10, note: 'หน่วยนับ' },
  { key: 'ราคา/หน่วย', width: 14, note: 'ราคาจริงที่บันทึกไว้หลังออก PO · ว่าง = ยังไม่ได้กรอก' },
  { key: 'มูลค่า', width: 16, note: 'ราคา/หน่วย × จำนวนที่รับ' },
  { key: 'เบิกให้ Service', width: 18, note: 'ยังอยู่กับ Job / วันที่เบิกออกไปให้ Service (0059)' },
]
const MAT_HEADERS = MAT_COLS.map(c => c.key)

// ฟอร์มแก้ข้อมูลรายเครื่อง (0043/0049) — รวม "แก้ Serial" เข้ามาในฟอร์มเดียวแล้ว
// serialLvb/serialOm แก้ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (in_stock) — บันทึกผ่าน updateUnitInfo แยก call
interface PlanForm {
  id: string; canEditSerial: boolean
  serialLvb: string; serialOm: string
  origLvb: string; origOm: string
  cost: string
  customerName: string; contactPhone: string; installLocation: string; planPoDate: string
  fobDate: string; leadDays: string; planPoReceiptDate: string; planDeliveryDate: string
}

// ฟอร์มกรอกมือใช้แค่ 3 ช่องแรก · ช่องข้อมูลแผน (0048/0049) มาจาก Import Excel เท่านั้น
interface UnitRow {
  lvb: string; om: string; cost: string
  customer?: string; phone?: string; location?: string
  planPo?: string
  fob?: string; leadDays?: number; planPoReceipt?: string; planDelivery?: string
}
const emptyRow = (): UnitRow => ({ lvb: '', om: '', cost: '' })

// เครื่องที่ดึงเข้า Job แล้ว: ช่องที่ Job เป็นเจ้าของถูกตัดทิ้งก่อนส่ง (กฎ 0014)
// — Customer / Contact Number / Location / Site / Plan PO receipt ค่าจริงมาจาก Job
type DupRow = { row: UnitRow; hasJob?: boolean; locked?: boolean }
const effectiveRow = (d: DupRow): UnitRow =>
  d.hasJob
    ? { ...d.row, customer: undefined, phone: undefined, location: undefined, planPo: undefined }
    : d.row

// แถวนี้จะเปลี่ยนอะไรจริงไหมหลังตัดช่องของ Job ออกแล้ว — ตรงกับกติกา hasAny ฝั่ง logic/RPC
const rowChangesSomething = (d: DupRow): boolean => {
  const r = effectiveRow(d)
  return r.cost.trim() !== '' || !!r.customer || !!r.phone || !!r.location || !!r.planPo
    || !!r.fob || r.leadDays !== undefined || !!r.planPoReceipt || !!r.planDelivery
}

// UnitRow (ฟอร์ม string) → payload logic/RPC · ช่องว่าง = ไม่ส่งไป (คงค่าเดิมฝั่ง server)
const rowsToUnits = (rows: UnitRow[]) =>
  rows.map(r => ({
    lvb: r.lvb, om: r.om, cost: toBudgetNum(r.cost),
    customer: r.customer, phone: r.phone, location: r.location, planPo: r.planPo,
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

// ---------------------------------------------------------------
// สเปกคอลัมน์ไฟล์ Excel (0052) — แหล่งความจริงเดียวของทั้ง Export / Import / ชีตวิธีกรอก
//   io 'in'   = กรอกได้ (import อ่านค่านี้)
//   io 'auto' = ระบบคำนวณให้ (import ไม่อ่าน แก้ในไฟล์ไม่มีผล) — ใส่ไว้ให้อ่าน/ทำรายงานต่อ
//   alias     = หัวตารางรูปแบบอื่นที่ import ยอมรับ (รวมชื่อเก่าก่อน 0052 เพื่อไม่ให้ไฟล์เดิมพัง)
// ---------------------------------------------------------------
interface ColSpec {
  key: string; io: 'in' | 'auto'; required?: boolean
  width: number; format: string; note: string
  alias?: string[]
}
const SHEET_COLS: ColSpec[] = [
  { key: 'Serial.LVB', io: 'in', required: true, width: 16, format: 'ข้อความ',
    note: 'เลข Serial ของตัว LBS — ห้ามซ้ำกับเครื่องอื่นทั้งระบบ', alias: ['serial.lvb', 'serial_lvb', 'lvb'] },
  { key: 'Serial.OM', io: 'in', required: true, width: 16, format: 'ข้อความ',
    note: 'เลข Serial ของ OM — ห้ามซ้ำ และห้ามเท่ากับ Serial.LVB ของเครื่องเดียวกัน', alias: ['serial.om', 'serial_om', 'om'] },
  { key: 'Cost/Set', io: 'in', width: 14, format: 'ตัวเลข (บาท)',
    note: 'ต้นทุนต่อเครื่อง — ตัวเลขไม่ติดลบ · ปล่อยว่าง = คงค่าเดิม',
    alias: ['ต้นทุน/เครื่อง', 'ต้นทุน', 'cost', 'unit_cost', 'cost/set'] },
  { key: 'Customer', io: 'in', width: 24, format: 'ข้อความ',
    note: 'ข้อมูลแผน — เขียนได้เฉพาะเครื่องที่ยังไม่ถูกดึงเข้า Job (เครื่องที่มี Job แล้วใช้ค่าจาก Job)',
    alias: ['ชื่อลูกค้า', 'ลูกค้า', 'customer', 'customer_name'] },
  { key: 'Contact Number', io: 'in', width: 16, format: 'ข้อความ',
    note: 'ข้อมูลแผน — เงื่อนไขเดียวกับ Customer',
    alias: ['เบอร์ติดต่อ', 'เบอร์', 'phone', 'contact_phone', 'contact number'] },
  { key: 'Location / Site', io: 'in', width: 28, format: 'ข้อความ',
    note: 'ข้อมูลแผน — เงื่อนไขเดียวกับ Customer',
    alias: ['สถานที่ติดตั้ง', 'สถานที่', 'location', 'install_location', 'location / site', 'location/site'] },
  { key: 'Plan PO receipt', io: 'in', width: 15, format: 'YYYY-MM-DD',
    note: 'วันที่คาดว่าจะได้รับ PO จากลูกค้า (แผนฝั่งขาย) — คนละตัวกับ ETA to WH ที่เป็นวันของเข้าคลัง · เงื่อนไขเดียวกับ Customer',
    alias: ['plan po receipt', 'plan_po', 'plan po'] },
  { key: 'FOB date', io: 'in', width: 13, format: 'YYYY-MM-DD',
    note: 'วันที่ของลงเรือ — กรอกช่องนี้แล้วระบบคำนวณ ETA to WH ให้เอง', alias: ['fob', 'fob_date', 'fob date'] },
  { key: 'ระยะขนส่ง (วัน)', io: 'in', width: 15, format: `จำนวนเต็ม ${ETA_LEAD_MIN}–${ETA_LEAD_MAX}`,
    note: `ระยะเวลา FOB → คลัง · ปล่อยว่าง = ใช้ค่ามาตรฐาน ${ETA_LEAD_DAYS} วัน · ใช้ได้เมื่อกรอก FOB date เท่านั้น`,
    alias: ['ระยะขนส่ง', 'lead', 'lead_days', 'lead days'] },
  // ⚠️ ห้ามใส่ 'Plan PO receipt' เป็น alias ของ ETA อีก — 0053 ใช้ชื่อนั้นเป็นคอลัมน์ใหม่ (วันรับ PO จากลูกค้า)
  //    ถ้าเหลือไว้ ไฟล์รูปแบบใหม่จะถูกอ่านวันรับ PO ไปลง ETA to WH ผิดช่อง
  //    (ไฟล์ที่ export ก่อน 0049 ซึ่งใช้หัว "Plan PO receipt" ในความหมายวันของเข้าคลัง จึงต้องแก้หัวเป็น "ETA to WH" ก่อน import)
  { key: 'ETA to WH', io: 'in', width: 13, format: 'YYYY-MM-DD',
    note: 'วันที่ของถึงคลัง — กรอกเองได้เฉพาะเมื่อ "ไม่มี" FOB date · ถ้ามี FOB ระบบคำนวณทับให้เสมอ',
    alias: ['eta', 'eta to wh', 'plan_po_receipt'] },
  { key: 'Plan Delivery', io: 'in', width: 14, format: 'YYYY-MM-DD',
    note: 'กำหนดส่งมอบ/ติดตั้งตามแผน', alias: ['plan delivery', 'plan_delivery'] },
  { key: 'Status', io: 'auto', width: 18, format: 'ข้อความ',
    note: 'ระบบคำนวณจาก ETA to WH + สถานะการดึง/เบิก: ? → Pending → On Hand → ถูกดึงเข้า Job → เบิกแล้ว รอติดตั้ง → ติดตั้งแล้ว' },
  { key: 'Job No.', io: 'auto', width: 16, format: 'ข้อความ',
    note: 'Job ที่เครื่องถูกดึงเข้า — ผูกจากหน้า Job เท่านั้น' },
  { key: 'Actual Delivery', io: 'auto', width: 14, format: 'YYYY-MM-DD',
    note: 'วันที่ติดตั้งจริง — Service เป็นผู้ยืนยันหน้างาน' },
]
const COL_HEADERS = SHEET_COLS.map(c => c.key)
// รายชื่อหัวตารางที่ import ยอมรับต่อคอลัมน์ (ชื่อหลัก + alias)
const colKeys = (key: string): string[] => {
  const c = SHEET_COLS.find(x => x.key === key)!
  return [c.key, ...(c.alias ?? [])]
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
  // แท็บย่อยของหน้านี้ (2026-08-23) — แยก "คลัง LBS" ออกจาก "วัสดุตาม Job (Ref.PO)"
  //   เดิมเป็นแผงต่อท้ายกัน: ต้องเลื่อนผ่านทุกคลัง (แต่ละคลังมี 30–40 เครื่อง) กว่าจะถึงตารางวัสดุ
  //   ⚠️ ไม่ทำเป็น route แยก — ยังเป็นข้อมูล "คลัง" ชุดเดียวกัน และจะเสีย bookmark /stocks เดิม
  const [tab, setTab] = useState<'stock' | 'material'>('stock')
  const [openMatJobs, setOpenMatJobs] = useState<Set<string>>(new Set())  // กลุ่ม Job ที่กางอยู่ — เริ่มต้นพับหมด
  const [matSearch, setMatSearch] = useState('')
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
  // ---- วัสดุตาม Job (Ref.PO): วัสดุที่รับของครบจาก PO ที่ปิดรับของแล้ว ----
  // ⚠️ แก้บั๊กจับคู่ (2026-08-23): เดิมกรอง `r.prId === po.prId` — ตั้งแต่ 0022 ที่ 1 PR ออกได้หลาย PO
  //    บรรทัดของ PO ใบหนึ่งจะไปโผล่ใต้ PO ใบอื่นที่มาจาก PR เดียวกันด้วย ⇒ รายการซ้ำ/มูลค่าเกินจริง
  //    ต้องจับด้วย poId · fallback prId ไว้เฉพาะข้อมูลเก่าก่อน 0022 ที่ยังไม่มี poId
  const receivedLines = db.pos
    .filter(p => p.status === 'received')
    .flatMap(po => db.accessoryRequests
      .filter(r => r.status === 'received' && (r.poId ? r.poId === po.id : r.prId === po.prId))
      .map(r => ({ po, r, item: db.items.find(i => i.id === r.itemId) })))

  const matTerm = matSearch.trim().toLowerCase()
  const matFiltered = receivedLines.filter(({ po, r, item }) => {
    if (!matTerm) return true
    const job = db.jobs.find(j => j.id === po.jobId)
    return [po.poNo, job?.jobNo, job?.customerName, item?.epicorCode, item?.name, po.supplierName]
      .some(v => v?.toLowerCase().includes(matTerm))
  })
  // กลุ่ม 2 ชั้น: Job No. (ชั้นนอก) → PO (ชั้นใน) · เรียง Job ใหม่→เก่าตามวันรับของล่าสุด
  const lineValue = (r: typeof receivedLines[number]['r']) =>
    r.unitPrice !== undefined ? r.unitPrice * r.qtyReceived : 0
  const matJobs = (() => {
    const byJob = new Map<string, {
      key: string; jobId?: string; jobNo: string; customer: string
      lines: number; value: number; latest: string
      pos: { po: typeof receivedLines[number]['po']; rows: typeof receivedLines; value: number }[]
    }>()
    matFiltered.forEach(row => {
      const job = db.jobs.find(j => j.id === row.po.jobId)
      const key = row.po.jobId ?? 'no-job'
      let g = byJob.get(key)
      if (!g) {
        g = {
          key, jobId: job?.id, jobNo: job?.jobNo ?? '(ไม่พบ Job)',
          customer: job?.customerName ?? '-', lines: 0, value: 0, latest: '', pos: [],
        }
        byJob.set(key, g)
      }
      let p = g.pos.find(x => x.po.id === row.po.id)
      if (!p) { p = { po: row.po, rows: [], value: 0 }; g.pos.push(p) }
      p.rows.push(row)
      p.value += lineValue(row.r)
      g.lines += 1
      g.value += lineValue(row.r)
      if ((row.po.receivedAt ?? '') > g.latest) g.latest = row.po.receivedAt ?? ''
    })
    const out = [...byJob.values()]
    out.forEach(g => g.pos.sort((a, b) => (b.po.receivedAt ?? '').localeCompare(a.po.receivedAt ?? '')))
    return out.sort((a, b) => b.latest.localeCompare(a.latest))
  })()
  const matTotal = {
    lines: matFiltered.length,
    pos: new Set(matFiltered.map(x => x.po.id)).size,
  }
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
        'Cost/Set': u.unitCost ?? '',
        'Customer': job?.customerName ?? u.planCustomerName ?? '',
        'Contact Number': job?.contactPhone ?? u.planContactPhone ?? '',
        'Location / Site': job?.installLocation || u.planInstallLocation || '',
        'Plan PO receipt': u.planPoDate ?? '',
        'FOB date': u.fobDate ?? '',
        'ระยะขนส่ง (วัน)': u.fobDate ? unitLeadDays(u) : '',
        // ETA to WH / Status = ค่าคำนวณ · import จะไม่เขียน ETA ทับถ้าแถวนั้นมี FOB
        'ETA to WH': unitEta(u) ?? '',
        'Status': UNIT_FLOW[unitFlowState(db, u)].label,
        'Plan Delivery': u.planDeliveryDate ?? '',
        'Job No.': job?.jobNo ?? '',
        'Actual Delivery': unitInstallDate(db, u.id) ?? '',
      }
    })
    // header: บังคับลำดับคอลัมน์ + **คลังเปล่าก็ยังได้หัวตารางครบ** (เดิม json_to_sheet([]) ออกไฟล์ว่างเปล่า
    // ใช้เป็นแบบฟอร์มกรอกไม่ได้เลย — เจอจริงตอน export Project Stock No.21)
    const ws = XLSX.utils.json_to_sheet(rows, { header: COL_HEADERS })
    ws['!cols'] = SHEET_COLS.map(c => ({ wch: c.width }))
    // autofilter บนหัวตาราง — เปิดไฟล์แล้วกรอง Status / ค้น Serial ได้ทันทีโดยไม่ต้องตั้งเอง
    // (freeze panes ไม่ได้ตั้งไว้ — SheetJS รุ่น community ไม่เขียน `!freeze` ลงไฟล์ ใส่ไปก็ไม่มีผล)
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: SHEET_COLS.length - 1 } }) }

    // ชีต "วิธีกรอก" — บอกว่าคอลัมน์ไหนกรอกได้ / ไหนระบบเติมให้ / รูปแบบ / กติกา
    const guide = [
      ['วิธีกรอกไฟล์ Import — ' + s.stockNo],
      [],
      ['คอลัมน์', 'กรอกได้?', 'บังคับ', 'รูปแบบ', 'คำอธิบาย'],
      ...SHEET_COLS.map(c => [
        c.key,
        c.io === 'in' ? 'กรอกได้' : 'อัตโนมัติ (แก้ในไฟล์ไม่มีผล)',
        c.required ? 'บังคับ' : '',
        c.format,
        c.note,
      ]),
      [],
      ['กติกาสำคัญ'],
      ['1', 'ช่องที่เว้นว่าง = คงค่าเดิมในระบบ (ไม่ล้างค่า) — ถ้าต้องการล้างค่าจริง ใช้ปุ่ม "แก้ข้อมูล" รายเครื่องบนหน้าเว็บ'],
      ['2', 'แถวที่ Serial ตรงกับเครื่องเดิมในคลังนี้ = อัพเดทเครื่องนั้น · Serial ใหม่ = รับเข้าเป็นเครื่องใหม่'],
      ['3', 'Serial ที่ชนกับเครื่องในคลังอื่น = ระบบขึ้น error ไม่ให้นำเข้า (กันกรอกผิด)'],
      ['4', 'เครื่องที่เบิกให้ Service แล้วจะถูกข้ามทั้งแถว — ระบบล็อกการแก้ไขไว้'],
      ['5', 'วันที่กรอกเป็น YYYY-MM-DD (เช่น 2026-09-01) หรือใช้เซลล์ชนิดวันที่ของ Excel ก็ได้'],
      ['6', `ETA to WH = FOB date + ระยะขนส่ง · ถ้าไม่กรอก FOB และไม่กรอก ETA เลย Status จะขึ้น "?" (ระบบไม่เดาว่าของถึงคลังแล้ว)`],
      [],
      ['ลำดับ Status (ระบบคำนวณให้ ไม่ต้องกรอก)'],
      ['?', 'ยังไม่ระบุ ETA to WH'],
      ['Pending', 'ยังไม่ถึง ETA — ของอยู่ระหว่างขนส่ง'],
      ['On Hand', 'ถึง/เกิน ETA แล้ว — ของอยู่ที่คลัง พร้อมดึงเข้า Job'],
      ['ถูกดึงเข้า Job', 'Project ดึงเข้างานแล้ว'],
      ['เบิกแล้ว รอติดตั้ง', 'เบิกให้ Service แล้ว'],
      ['ติดตั้งแล้ว / ติดตั้งไม่ได้', 'Service ยืนยันผลหน้างานแล้ว'],
    ]
    const wsGuide = XLSX.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 26 }, { wch: 28 }, { wch: 10 }, { wch: 22 }, { wch: 86 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, s.stockNo.slice(0, 31))
    XLSX.utils.book_append_sheet(wb, wsGuide, 'วิธีกรอก')
    XLSX.writeFile(wb, `${s.stockNo.replace(/[\\/:*?"<>|]/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const onPickImportFile = async (file: File) => {
    const target = importToRef.current
    if (!target) return
    try {
      const XLSX = await import('xlsx')
      // cellDates: เซลล์วันที่ (Plan PO receipt / Plan Delivery) จะได้เป็น Date ไม่ใช่ serial number
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
      // ข้ามชีต "วิธีกรอก" ที่แนบไปกับไฟล์ Export — อ่านชีตข้อมูลชีตแรกที่ไม่ใช่คู่มือ
      const dataSheet = wb.SheetNames.find(n => n !== 'วิธีกรอก') ?? wb.SheetNames[0]
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[dataSheet], { defval: '' })
      if (raw.length === 0) return show('ไฟล์ไม่มีข้อมูล — ต้องมีหัวตาราง Serial.LVB และ Serial.OM อย่างน้อย', true)

      const newUnits: UnitRow[] = []
      const dupUnits: { row: UnitRow; oldCost?: number; hasJob?: boolean; locked?: boolean }[] = []
      const errors: string[] = []
      const stockNoOf = (id: string) => db.projectStocks.find(s => s.id === id)?.stockNo ?? '?'
      const seenInFile = new Set<string>()          // กันซ้ำภายในไฟล์ (ข้าม field ด้วย)
      raw.forEach((row, i) => {
        // อ่านทุกคอลัมน์ตามสเปก SHEET_COLS (รับหัวตารางชื่อเก่าด้วยผ่าน alias)
        const lvb = cell(row, colKeys('Serial.LVB'))
        const om = cell(row, colKeys('Serial.OM'))
        const costStr = cell(row, colKeys('Cost/Set'))
        const no = `แถว ${i + 2}`
        // ข้อมูลแผนรายเครื่อง (0048/0049) — ช่องว่าง = คงค่าเดิม
        const fob = toIsoDate(rawCell(row, colKeys('FOB date'))) || undefined
        // "ETA to WH" ในไฟล์ = ค่าคำนวณจาก FOB → ถ้าแถวนี้มี FOB ให้ข้าม (กันเขียนค่า auto ทับเป็นค่ากรอกมือ)
        // แถวที่ไม่มี FOB จึงจะรับ ETA เป็นค่ากรอกเอง (ลงคอลัมน์เดิม plan_po_receipt_date)
        const etaCell = toIsoDate(rawCell(row, colKeys('ETA to WH'))) || undefined
        const leadStr = cell(row, colKeys('ระยะขนส่ง (วัน)'))
        if (leadStr !== '' && (!Number.isInteger(Number(leadStr)) || Number(leadStr) < ETA_LEAD_MIN || Number(leadStr) > ETA_LEAD_MAX))
          return void errors.push(`${no}: ระยะขนส่ง (วัน) "${leadStr}" ต้องเป็นจำนวนเต็ม ${ETA_LEAD_MIN}–${ETA_LEAD_MAX}`)
        if (leadStr !== '' && !fob)
          return void errors.push(`${no}: กรอก "ระยะขนส่ง (วัน)" แต่ไม่ได้กรอก "FOB date" — ระยะขนส่งใช้คำนวณต่อจาก FOB เท่านั้น`)
        const plan = {
          customer: cell(row, colKeys('Customer')) || undefined,
          phone: cell(row, colKeys('Contact Number')) || undefined,
          location: cell(row, colKeys('Location / Site')) || undefined,
          planPo: toIsoDate(rawCell(row, colKeys('Plan PO receipt'))) || undefined,
          fob,
          // ระยะขนส่งมีความหมายเฉพาะเมื่อมี FOB (ไม่มี FOB = ETA กรอกตรงๆ ไม่ต้องคำนวณ)
          leadDays: fob && leadStr !== '' ? Number(leadStr) : undefined,
          planPoReceipt: fob ? undefined : etaCell,
          planDelivery: toIsoDate(rawCell(row, colKeys('Plan Delivery'))) || undefined,
        }
        if (!lvb && !om) return                       // ข้ามแถวว่าง
        if (!lvb || !om) return void errors.push(`${no}: ต้องมีทั้ง Serial.LVB และ Serial.OM`)
        if (lvb === om) return void errors.push(`${no}: LVB กับ OM ห้ามเป็นเลขเดียวกัน (${lvb})`)
        if (costStr !== '' && (Number.isNaN(Number(costStr)) || Number(costStr) < 0))
          return void errors.push(`${no}: Cost/Set "${costStr}" ต้องเป็นตัวเลขไม่ติดลบ`)
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
    // (กติกาอยู่ที่เดียว ไม่ต้อง maintain 2 ที่)
    const updateUnits = dupAction === 'update'
      ? rowsToUnits(importPreview.dupUnits.map(d => effectiveRow(d)))
      : []
    const lockedCount = dupAction === 'update' ? importPreview.dupUnits.filter(d => d.locked).length : 0
    // นับเฉพาะแถวที่ "เปลี่ยนอะไรจริง" ให้ตรงกับกติกา hasAny ฝั่ง logic/RPC
    // ไม่งั้นแถวที่ทุกช่องถูกตัดทิ้ง (เช่นเครื่องมี Job แล้วกรอกมาแต่ช่องของ Job) จะถูกนับว่าอัพเดท
    const changedCount = dupAction === 'update'
      ? importPreview.dupUnits.filter(d => !d.locked && rowChangesSomething(d)).length
      : 0
    const msg = [
      newUnits.length ? `รับเข้า ${newUnits.length} เครื่อง` : '',
      changedCount > 0 ? `อัพเดทข้อมูล ${changedCount} เครื่อง` : '',
      lockedCount ? `ข้ามเครื่องที่เบิกแล้ว ${lockedCount} เครื่อง` : '',
    ].filter(Boolean).join(' · ') || 'ไม่มีข้อมูลที่เปลี่ยน'
    const ok = await tryAction(
      () => act.importUnitsToStock({ stockId: importPreview.stockId, newUnits, updateUnits }),
      `${msg} เข้า ${importPreview.stockNo} แล้ว`,
    )
    setImporting(false)
    if (ok) setImportPreview(null)
  }

  // Export ตามที่กรองอยู่บนจอ — คนตรวจมักกรองเฉพาะงานที่สนใจแล้วค่อยส่งไฟล์ต่อ
  // ถ้า export ทั้งหมดเสมอ เขาต้องไปลบแถวเองใน Excel ซึ่งเป็นจุดที่ตัวเลขเริ่มเพี้ยน
  const exportMaterial = async () => {
    const rows = matFiltered.map(({ po, r, item }) => {
      const job = db.jobs.find(j => j.id === po.jobId)
      return {
        'Job No.': job?.jobNo ?? '',
        'Customer': job?.customerName ?? '',
        'PO No.': po.poNo,
        'ซัพพลายเออร์': po.supplierName ?? '',
        'วันที่รับของครบ': po.receivedAt?.slice(0, 10) ?? '',
        'รหัส Epicor': item?.epicorCode || '',
        'ชื่ออุปกรณ์': item?.name ?? '',
        'จำนวนที่รับ': r.qtyReceived,
        'หน่วย': item?.uom ?? '',
        'ราคา/หน่วย': r.unitPrice ?? '',
        'มูลค่า': r.unitPrice !== undefined ? r.unitPrice * r.qtyReceived : '',
        'เบิกให้ Service': r.issuedToServiceAt ? `เบิกแล้ว ${r.issuedToServiceAt.slice(0, 10)}` : 'ยังอยู่กับ Job',
      }
    })
    const XLSX = await import('xlsx')
    // header: บังคับลำดับคอลัมน์ + ไม่มีรายการก็ยังได้หัวตารางครบ (บั๊กคลังเปล่าที่เจอตอน 0049)
    const ws = XLSX.utils.json_to_sheet(rows, { header: MAT_HEADERS })
    ws['!cols'] = MAT_COLS.map(c => ({ wch: c.width }))
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: MAT_COLS.length - 1 } }) }

    const total = rows.reduce((n, x) => n + (typeof x['มูลค่า'] === 'number' ? x['มูลค่า'] : 0), 0)
    const guide = [
      ['วัสดุตาม Job (Ref.PO) — รายการที่รับของครบจาก PO แล้ว'],
      [`ออกจากระบบเมื่อ ${fmtDateTime(new Date().toISOString())}`],
      [`${rows.length} รายการ · ${new Set(rows.map(r => r['PO No.'])).size} PO · ${new Set(rows.map(r => r['Job No.'])).size} Job · มูลค่ารวม ${total.toLocaleString('th-TH')} บาท`],
      matSearch.trim() ? [`⚠️ ไฟล์นี้กรองด้วยคำค้น "${matSearch.trim()}" — ไม่ใช่รายการทั้งหมดในระบบ`] : [],
      [],
      ['คอลัมน์', 'คำอธิบาย'],
      ...MAT_COLS.map(c => [c.key, c.note]),
      [],
      ['ข้อควรรู้'],
      ['1', 'นี่ไม่ใช่ยอดคลังคงเหลือ — ของทุกชิ้นในไฟล์นี้ผูกกับ Job ไปแล้ว (คลังคงเหลือดูที่หน้า Material Database)'],
      ['2', 'นับเฉพาะ PO ที่ปิดรับของครบทั้งใบ · ของที่ยังค้างรับดูที่หน้า Purchasing'],
      ['3', '"เบิกให้ Service" คือขั้นส่งของออกหน้างาน (0059) — รับของแล้วไม่ได้แปลว่าออกไปหน้างานแล้ว'],
      ['4', 'ไฟล์นี้ Import กลับเข้าระบบไม่ได้ — เป็นรายงานสำหรับตรวจสอบเท่านั้น'],
    ]
    const wsGuide = XLSX.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 22 }, { wch: 95 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'วัสดุตาม Job')
    XLSX.utils.book_append_sheet(wb, wsGuide, 'คำอธิบาย')
    XLSX.writeFile(wb, `วัสดุตาม-Job-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  return (
    <>
      <div className="page-title">Project Stock — คลัง LBS</div>
      <div className="page-sub">
        คลังกลาง 115kV LBS ติดตามรายเครื่องด้วย Serial คู่ (LVB · OM) — Project ดึงเข้างานตามลำดับ<br />
        <b>Status</b> ไหลอัตโนมัติทั้งเส้น:{' '}
        <span className="badge neutral">?</span> → <span className="badge amber">Pending</span> →{' '}
        <span className="badge green">On Hand</span> → <span className="badge blue">ถูกดึงเข้า Job</span> →{' '}
        <span className="badge neutral">เบิกแล้ว รอติดตั้ง</span> → <span className="badge green">ติดตั้งแล้ว</span>
        {' '}· ETA to WH = FOB + ระยะขนส่ง ({ETA_LEAD_MIN}–{ETA_LEAD_MAX} วัน · ค่ามาตรฐาน {ETA_LEAD_DAYS}) ·
        <b> ยังไม่กรอก ETA จะขึ้น "?"</b> (ระบบไม่เดาว่าของถึงคลังแล้ว)
        {!canManage && ' · แผนกของคุณดูได้อย่างเดียว (สร้าง/รับเข้าสต็อกเป็นสิทธิ์ของ Division)'}
      </div>

      {/* แท็บย่อย — ป้ายพร้อมตัวเลขให้เห็นปริมาณงานก่อนกดเข้า */}
      <div className="subtabs">
        <button className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>
          📦 คลัง LBS <span className="badge neutral">{db.projectStocks.length}</span>
        </button>
        <button className={tab === 'material' ? 'active' : ''} onClick={() => setTab('material')}>
          🧰 วัสดุตาม Job (Ref.PO) <span className="badge neutral">{receivedLines.length}</span>
        </button>
      </div>

      {tab === 'stock' && <>
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
                {sum.unknown > 0 && (
                  <span className="badge neutral" title={`ยังไม่ระบุ ETA to WH ${sum.unknown} เครื่อง — กรอก FOB date (หรือใช้ปุ่ม 🚢 ตั้ง FOB ทั้งคลัง) เพื่อให้ระบบคำนวณ Status ได้`}>
                    ? {sum.unknown}
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
                {/* grid = ตีเส้นตารางบางๆ ทุกช่อง (อ่านตารางกว้างง่ายขึ้น)
                    Status = flow เดียวจบทั้งชีวิตเครื่อง (0052) — ไม่มีคอลัมน์ "สถานะเครื่อง" แยกแล้ว */}
                <table className="grid">
                  <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>Cost/Set</th><th>Customer</th><th>Contact Number</th><th>Location / Site</th><th>Plan PO receipt</th><th>Job No.</th><th>FOB date</th><th>ETA to WH</th><th>Status</th><th>Plan Delivery</th><th>Actual Delivery</th>{canManage && <th></th>}</tr></thead>
                  <tbody>
                    {units.map(u => {
                      // ข้อมูลลูกค้า "จริง" ref จาก Job ที่เครื่องถูกดึงเข้า (0014) — ยังไม่เข้า Job ใช้ค่าแผน (0043)
                      const job = u.jobId ? db.jobs.find(j => j.id === u.jobId) : undefined
                      // ค่าจาก Job ชนะ · ถ้าไม่มี Job ใช้ค่าแผนแล้วติดป้าย "แผน" ให้เห็นว่ายังไม่ผูกงาน
                      const planned = !job
                      const cust = job?.customerName ?? u.planCustomerName
                      const phone = job?.contactPhone ?? u.planContactPhone
                      const loc = job?.installLocation || u.planInstallLocation
                      // Actual Delivery = auto ตาม flow Service (0035) ไม่มีคอลัมน์เก็บซ้ำ
                      const actualDelivery = unitInstallDate(db, u.id)
                      // ETA to WH = FOB + ระยะขนส่ง (auto) หรือค่าที่กรอกเอง
                      const eta = unitEta(u)
                      const etaAuto = unitEtaIsAuto(u)
                      // Status = flow เดียวจบ: ? → Pending → On Hand → ถูกดึงเข้า Job → เบิก → ติดตั้ง
                      const flow = UNIT_FLOW[unitFlowState(db, u)]
                      return (
                        <tr key={u.id}>
                          <td className="mono">{u.serialLvb}</td>
                          <td className="mono">{u.serialOm}</td>
                          <td style={{ textAlign: 'right' }}>{fmtBaht(u.unitCost)}</td>
                          <td>{cust ?? '-'}{planned && cust && <span className="badge neutral" style={{ marginLeft: 6 }}>แผน</span>}</td>
                          <td>{phone ?? '-'}</td>
                          <td>{loc || '-'}</td>
                          <td>{fmtDate(u.planPoDate)}</td>
                          <td>{u.jobId ? <Link to={`/jobs/${u.jobId}`}>{jobNo(u.jobId)}</Link> : '-'}</td>
                          <td>{fmtDate(u.fobDate)}</td>
                          <td>
                            {eta ? fmtDate(eta) : '-'}
                            {eta && etaAuto && (
                              <span className="badge neutral" style={{ marginLeft: 6 }}
                                title={`คำนวณอัตโนมัติ = FOB + ${unitLeadDays(u)} วัน`}>+{unitLeadDays(u)} วัน</span>
                            )}
                          </td>
                          <td><span className={`badge ${flow.cls}`} title={flow.hint}>{flow.label}</span></td>
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
                                    installLocation: u.planInstallLocation ?? '', planPoDate: u.planPoDate ?? '',
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

      {/* ความเห็นผู้บริหาร (VIP) ย้ายไป Dashboard แล้ว (2026-08-23) — บอกทางไว้ให้คนที่เคยหาที่นี่ */}
      <div className="panel"><div className="panel-body muted">
        💬 <b>ความเห็นผู้บริหาร (VIP)</b> ย้ายไปอยู่หน้า <Link to="/dashboard">Dashboard</Link> ใต้ Job List แล้ว —
        เป็นความเห็นภาพรวมทั้งระบบ ไม่ใช่เรื่องคลังอย่างเดียว จึงควรอยู่หน้าแรกที่ทุกแผนกเปิดเจอ
      </div></div>
      </>}

      {/* ---------------- แท็บ 2: วัสดุตาม Job (Ref.PO) ----------------
          เป็น "รายงานตรวจสอบ" ของ line ที่รับของครบจาก PO ไม่ใช่คลังที่มียอดคงเหลือ
          (ชื่อเดิม "คลังสินค้า (Ref.Job)" เปลี่ยนเพราะสับสนกับ "คลังคงเหลือ" ที่เป็นคลังจริง — S2)

          จัดกลุ่ม 2 ชั้น Job No. → PO (มติ 2026-08-23): ของชิ้นเดียวกันถูกสั่งหลาย PO ได้
          และคนตรวจถามเป็นราย Job ("งานนี้ได้ของครบยัง") ไม่ใช่ราย PO ⇒ Job เป็นชั้นนอก
          เริ่มต้นพับทุกกลุ่ม — หน้านี้เคยยาวเป็นร้อยแถวโดยไม่มีทางกวาดตาดูภาพรวมก่อน */}
      {tab === 'material' && (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>สรุปวัสดุที่รับครบจาก PO
                <span className="muted" style={{ fontWeight: 400 }}> · {matJobs.length} Job · {matTotal.pos} PO · {matTotal.lines} รายการ</span>
              </h3>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input style={{ width: 240 }} value={matSearch} onChange={e => setMatSearch(e.target.value)}
                  placeholder="ค้น Job No. / PO No. / รหัส Epicor / ชื่ออุปกรณ์" />
                <button className="small" onClick={exportMaterial} disabled={matFiltered.length === 0}
                  title={matFiltered.length === 0 ? 'ไม่มีรายการให้ export'
                    : matSearch.trim() ? `export เฉพาะ ${matFiltered.length} รายการที่กรองอยู่` : ''}>
                  ⬇ Export Excel{matSearch.trim() ? ` (${matFiltered.length})` : ''}
                </button>
                {matJobs.length > 0 && (
                  <button className="small" onClick={() => setOpenMatJobs(
                    openMatJobs.size === matJobs.length ? new Set() : new Set(matJobs.map(g => g.key)))}>
                    {openMatJobs.size === matJobs.length ? 'พับทั้งหมด' : 'กางทั้งหมด'}
                  </button>
                )}
              </div>
            </div>
            <div className="panel-body muted">
              รายการที่ <b>รับของครบทั้งบรรทัด</b> จาก PO ที่ปิดรับของแล้ว — ตัวเลข "จำนวน" คือของที่รับเข้ามาจริง
              ({'ยอดที่ยังค้างรับดูที่หน้า Purchasing'}) · มูลค่าคิดจากราคาต่อหน่วยที่บันทึกไว้ ×
              จำนวนที่รับ · <b>ไม่ใช่ยอดคลังคงเหลือ</b> — ของพวกนี้ผูกกับ Job แล้ว
            </div>
          </div>

          {matJobs.length === 0 && (
            <div className="panel"><div className="panel-body">
              <div className="empty">
                {matSearch.trim()
                  ? `ไม่พบรายการที่ตรงกับ "${matSearch.trim()}"`
                  : 'ยังไม่มี PO ที่รับของครบ'}
              </div>
            </div></div>
          )}

          {matJobs.map(g => {
            const open = openMatJobs.has(g.key)
            return (
              <div className="panel" key={g.key}>
                <div className="panel-head">
                  <h3>
                    {g.jobId
                      ? <Link to={`/jobs/${g.jobId}`}>{g.jobNo}</Link>
                      : <span className="muted">ไม่พบ Job</span>}
                    <span className="muted" style={{ fontWeight: 400 }}> · {g.customer}</span>
                  </h3>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="badge blue" title="จำนวนใบ PO ที่รับของครบแล้วของงานนี้">{g.pos.length} PO</span>
                    <span className="badge neutral" title="จำนวนบรรทัดวัสดุ">{g.lines} รายการ</span>
                    <span className="muted">มูลค่า {fmtBaht(g.value)}</span>
                    <button className="small" onClick={() => setOpenMatJobs(prev => {
                      const n = new Set(prev)
                      n.has(g.key) ? n.delete(g.key) : n.add(g.key)
                      return n
                    })}>
                      {open ? 'ซ่อนรายการ' : `แสดงรายการ (${g.lines})`}
                    </button>
                  </div>
                </div>
                {open && g.pos.map(p => (
                  <div key={p.po.id}>
                    <div className="panel-body" style={{ paddingBottom: 0, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <b className="mono">{p.po.poNo}</b>
                      <span className="badge green">รับครบ {fmtDate(p.po.receivedAt)}</span>
                      <span className="muted">{p.po.supplierName || 'ไม่ระบุซัพพลายเออร์'}</span>
                      <span className="muted">· {p.rows.length} รายการ · มูลค่า {fmtBaht(p.value)}</span>
                    </div>
                    <div className="table-scroll">
                      <table className="grid">
                        <thead><tr>
                          <th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>จำนวนที่รับ</th>
                          <th style={{ textAlign: 'right' }}>ราคา/หน่วย</th>
                          <th style={{ textAlign: 'right' }}>มูลค่า</th>
                          <th>เบิกให้ Service</th>
                        </tr></thead>
                        <tbody>
                          {p.rows.map(({ r, item }) => (
                            <tr key={r.id}>
                              <td className="mono">{item?.epicorCode || '-'}</td>
                              <td>{item?.name ?? '-'}</td>
                              <td>{r.qtyReceived} {item?.uom ?? ''}</td>
                              <td style={{ textAlign: 'right' }}>{fmtBaht(r.unitPrice)}</td>
                              <td style={{ textAlign: 'right' }}>
                                {fmtBaht(r.unitPrice !== undefined ? r.unitPrice * r.qtyReceived : undefined)}
                              </td>
                              {/* 0059: ของที่รับแล้วยังต้องส่งต่อให้ Service อีกขั้น — ตรวจได้จากที่นี่เลย */}
                              <td>{r.issuedToServiceAt
                                ? <><span className="badge green">✅ เบิกแล้ว</span><div className="muted">{fmtDate(r.issuedToServiceAt)}</div></>
                                : <span className="badge amber">ยังอยู่กับ Job</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </>
      )}

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
                    planPoDate: editPlan.planPoDate,
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
            <label className="field"><span>Customer (แผน)</span>
              <input value={editPlan.customerName}
                onChange={e => setEditPlan({ ...editPlan, customerName: e.target.value })} placeholder="PEA เชียงใหม่" />
            </label>
          </div>
          <div className="row">
            <label className="field"><span>Contact Number (แผน)</span>
              <input value={editPlan.contactPhone}
                onChange={e => setEditPlan({ ...editPlan, contactPhone: e.target.value })} placeholder="08x-xxx-xxxx" />
            </label>
            <label className="field"><span>Location / Site (แผน)</span>
              <input value={editPlan.installLocation}
                onChange={e => setEditPlan({ ...editPlan, installLocation: e.target.value })} />
            </label>
            <label className="field"><span>Plan PO receipt</span>
              <input type="date" value={editPlan.planPoDate}
                onChange={e => setEditPlan({ ...editPlan, planPoDate: e.target.value })} />
            </label>
          </div>
          <div className="muted" style={{ marginTop: -6, marginBottom: 10 }}>
            <b>Plan PO receipt</b> = วันที่คาดว่าจะได้รับ PO จากลูกค้า (แผนฝั่งขาย) —
            คนละตัวกับ <b>ETA to WH</b> ที่เป็นวันของเข้าคลังและใช้คำนวณ Status
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
              <thead><tr><th>#</th><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>Cost/Set</th><th>Status</th><th>Job No.</th></tr></thead>
              <tbody>
                {list.map((u, i) => (
                  <tr key={u.id}>
                    <td className="muted">{i + 1}</td>
                    <td className="mono">{u.serialLvb}</td>
                    <td className="mono">{u.serialOm}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBaht(u.unitCost)}</td>
                    <td>{(f => <span className={`badge ${f.cls}`} title={f.hint}>{f.label}</span>)(UNIT_FLOW[unitFlowState(db, u)])}</td>
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
        // นับเฉพาะแถวที่เปลี่ยนอะไรจริง — แถวที่กรอกมาแต่ช่องของ Job จะไม่มีผล ต้องไม่โฆษณาว่า "อัพเดท"
        const changeable = updatable.filter(rowChangesSomething)
        const nothingToDo = newUnits.length === 0 && (changeable.length === 0 || dupAction === 'skip')
        const confirmLabel = importing ? 'กำลังนำเข้า…'
          : `ยืนยัน — รับใหม่ ${newUnits.length}${dupAction === 'update' && changeable.length ? ` · อัพเดท ${changeable.length}` : ''} เครื่อง`
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
                  <span><b>อัพเดทข้อมูลเครื่องเดิม</b> — Cost/Set · Customer / Contact Number / Location / Site (แผน) · Plan PO receipt · FOB date · ระยะขนส่ง · ETA to WH · Plan Delivery
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
                    ℹ️ เครื่องที่ดึงเข้า Job แล้ว ระบบจะ<b>ข้ามช่อง Customer / Contact Number / Location / Site / Plan PO receipt</b> — ข้อมูลจริงมาจาก Job
                    (แก้ที่หน้า Job) · ส่วนต้นทุนกับวันแผนยังอัพเดทให้ตามไฟล์
                  </div>
                )}
                <div className="table-scroll" style={{ maxHeight: 260, overflowY: 'auto', marginTop: 10 }}>
                  <table>
                    <thead><tr>
                      <th>#</th><th>Serial.LVB</th><th>Serial.OM</th>
                      <th style={{ textAlign: 'right' }}>Cost/Set เดิม</th><th style={{ textAlign: 'right' }}>Cost/Set ใหม่</th>
                      <th>Customer / Contact / Location (แผน)</th><th>Plan PO receipt</th><th>FOB date</th><th>ETA to WH</th><th>Plan Delivery</th><th>ผล</th>
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
                            <td>
                              {skip ? <span className="muted">—</span>
                                : !d.row.planPo ? <span className="muted">คงเดิม</span>
                                : d.hasJob ? <span className="muted">ข้าม (ใช้ค่าจาก Job)</span>
                                : d.row.planPo}
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
                                : rowChangesSomething(d) ? <span className="badge green">อัพเดท</span>
                                : <span className="badge neutral" title="ทุกช่องที่กรอกมาเป็นช่องที่ Job เป็นเจ้าของ หรือเว้นว่างทั้งแถว">ไม่มีอะไรเปลี่ยน</span>}
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
                  <thead><tr><th>#</th><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>Cost/Set</th><th>FOB date</th><th>ETA to WH</th></tr></thead>
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
