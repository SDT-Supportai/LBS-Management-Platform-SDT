import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import {
  stockSummary, unitInstallDate, unitCustomerInfo, unitFiles, unitFileCount, isAllowedUnitFile,
  MAX_UNIT_FILE_MB, DEMO_MAX_UNIT_FILE_MB,
  unitEta, unitEtaIsAuto, unitFlowState, unitLeadDays, addDaysIso,
  ETA_LEAD_DAYS, ETA_LEAD_MIN, ETA_LEAD_MAX,
} from '../data/logic'
import { uploadUnitDoc, signedUnitDocUrl, removeUnitDoc } from '../data/remote'
import { supabase } from '../lib/supabase'
import { Modal, useConfirm, useToast, useTryAction, toBudgetNum } from '../ui/components'

// อ่านไฟล์เป็น data URL — ใช้เฉพาะโหมด demo ที่ไม่มี Supabase Storage (เก็บเนื้อไฟล์ใน localStorage)
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error(`อ่านไฟล์ ${file.name} ไม่สำเร็จ`))
    r.readAsDataURL(file)
  })
}
import { fmtBaht, fmtDate, fmtDateTime, DEPT_LABEL, UNIT_FLOW } from '../ui/format'
import {
  type Cell, type NumKind, type ReportCol, type SumTable,
  SHEET_SUMMARY, SHEET_GUIDE, buildWorkbook, dataSheet, dataSheetName,
  guideSheet, orDash, saveReport, stampMeta, summarySheet,
} from '../ui/xlsxReport'

// ---------------- Export: วัสดุตาม Job (Ref.PO) ----------------
// สเปกคอลัมน์รวมศูนย์ — แหล่งความจริงเดียวของทั้งไฟล์ Excel และชีต "คำอธิบาย"
// (แนวเดียวกับ SHEET_COLS ของ Project Stock และ PR_COLS ของหน้า Purchasing)
// ⚠️ export อย่างเดียว ไม่มี import กลับ — ไฟล์นี้เป็น "รายงานตรวจสอบ" ไม่ใช่แบบฟอร์มกรอก
//    จึงใส่แถวรวมท้ายตารางได้ (ต่างจากชีตข้อมูลของคลัง LBS ที่ import กลับได้)
const MAT_COLS: ReportCol[] = [
  { key: 'Job No.', width: 16, note: 'งานที่วัสดุชุดนี้ผูกอยู่' },
  { key: 'Customer', width: 24, note: 'ลูกค้าของงานนั้น' },
  { key: 'PO No.', width: 18, note: 'ใบสั่งซื้อที่รับของครบแล้ว (1 PR ออกได้หลาย PO)' },
  { key: 'ซัพพลายเออร์', width: 24, note: 'ชื่อที่กรอกไว้ตอนออก PO' },
  { key: 'วันที่รับของครบ', width: 16, note: 'วันที่ PO ใบนั้นปิดรับของ' },
  { key: 'รหัส Epicor', width: 18, note: 'รหัสอ้างอิงระบบ ERP' },
  { key: 'ชื่ออุปกรณ์', width: 30, note: 'ชื่อในฐานข้อมูลวัสดุ' },
  { key: 'จำนวนที่รับ', width: 12, note: 'จำนวนที่รับเข้ามาจริง (ไม่ใช่จำนวนที่สั่ง)', num: 'int', total: true },
  { key: 'หน่วย', width: 10, note: 'หน่วยนับ' },
  { key: 'ราคา/หน่วย', width: 14, note: 'ราคาจริงที่บันทึกไว้หลังออก PO · ว่าง = ยังไม่ได้กรอก', num: 'money' },
  { key: 'มูลค่า', width: 16, note: 'ราคา/หน่วย × จำนวนที่รับ', num: 'money', total: true },
  { key: 'เบิกให้ Service', width: 18, note: 'ยังอยู่กับ Job / วันที่เบิกออกไปให้ Service (0059)' },
]

// ชื่อชีตข้อมูลของรายงาน "วัสดุตาม Job" — คงชื่อเดิมไว้เพื่อให้ไฟล์เก่า/ใหม่อ่านเหมือนกัน
const MAT_SHEET = 'วัสดุตาม Job'

/** สัดส่วน % แบบปลอดหารศูนย์ — ใช้ในตารางสรุปทุกตัว */
const pctOf = (part: number, whole: number): Cell => (whole > 0 ? (part / whole) * 100 : '-')
const PCT: NumKind = 'pct'

// ฟอร์มแก้ข้อมูลรายเครื่อง (0043/0049) — รวม "แก้ Serial" เข้ามาในฟอร์มเดียวแล้ว
// serialLvb/serialOm แก้ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (in_stock) — บันทึกผ่าน updateUnitInfo แยก call
interface PlanForm {
  id: string; canEditSerial: boolean; hasJob: boolean
  serialLvb: string; serialOm: string
  origLvb: string; origOm: string
  cost: string
  contractNo: string
  customerName: string; contactPhone: string; installLocation: string; planPoDate: string
  fobDate: string; leadDays: string; planPoReceiptDate: string; planDeliveryDate: string
}

// ฟอร์มกรอกมือใช้แค่ 3 ช่องแรก · ช่องข้อมูลแผน (0048/0049) มาจาก Import Excel เท่านั้น
interface UnitRow {
  lvb: string; om: string; cost: string
  contractNo?: string
  customer?: string; phone?: string; location?: string
  planPo?: string
  fob?: string; leadDays?: number; planPoReceipt?: string; planDelivery?: string
}
const emptyRow = (): UnitRow => ({ lvb: '', om: '', cost: '' })

// เครื่องที่ดึงเข้า Job แล้ว: ช่องที่ Job เป็นเจ้าของถูกตัดทิ้งก่อนส่ง (กฎ 0014)
// — Customer / Contact Number / Location / Site / Plan PO receipt ค่าจริงมาจาก Job
// ⚠️ 0073: **Contract No. ไม่ถูกตัด** — เป็นข้อเท็จจริงฝั่งสัญญาคนละชั้นกับ Job (Job ไม่ได้เป็นเจ้าของ)
//    ผูก Job แล้วยังแก้เลขสัญญาผ่าน Excel ได้ตามปกติ
type DupRow = { row: UnitRow; hasJob?: boolean; locked?: boolean }
const effectiveRow = (d: DupRow): UnitRow =>
  d.hasJob
    ? { ...d.row, customer: undefined, phone: undefined, location: undefined, planPo: undefined }
    : d.row

// แถวนี้จะเปลี่ยนอะไรจริงไหมหลังตัดช่องของ Job ออกแล้ว — ตรงกับกติกา hasAny ฝั่ง logic/RPC
const rowChangesSomething = (d: DupRow): boolean => {
  const r = effectiveRow(d)
  return r.cost.trim() !== '' || !!r.contractNo || !!r.customer || !!r.phone || !!r.location || !!r.planPo
    || !!r.fob || r.leadDays !== undefined || !!r.planPoReceipt || !!r.planDelivery
}

// UnitRow (ฟอร์ม string) → payload logic/RPC · ช่องว่าง = ไม่ส่งไป (คงค่าเดิมฝั่ง server)
const rowsToUnits = (rows: UnitRow[]) =>
  rows.map(r => ({
    lvb: r.lvb, om: r.om, cost: toBudgetNum(r.cost), contractNo: r.contractNo,
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
  /** รูปแบบตัวเลขในไฟล์ (ReportCol) — ใส่เฉพาะคอลัมน์ตัวเลข/เงิน */
  num?: NumKind
}
const SHEET_COLS: ColSpec[] = [
  { key: 'Serial.LVB', io: 'in', required: true, width: 16, format: 'ข้อความ',
    note: 'เลข Serial ของตัว LBS — ห้ามซ้ำกับเครื่องอื่นทั้งระบบ', alias: ['serial.lvb', 'serial_lvb', 'lvb'] },
  { key: 'Serial.OM', io: 'in', required: true, width: 16, format: 'ข้อความ',
    note: 'เลข Serial ของ OM — ห้ามซ้ำ และห้ามเท่ากับ Serial.LVB ของเครื่องเดียวกัน', alias: ['serial.om', 'serial_om', 'om'] },
  { key: 'Cost/Set', io: 'in', width: 14, format: 'ตัวเลข (บาท)', num: 'money',
    note: 'ต้นทุนต่อเครื่อง — ตัวเลขไม่ติดลบ · ปล่อยว่าง = คงค่าเดิม',
    alias: ['ต้นทุน/เครื่อง', 'ต้นทุน', 'cost', 'unit_cost', 'cost/set'] },
  // 0073 — เลขสัญญาเป็นข้อเท็จจริงฝั่งขาย ไม่ถูก Job ทับ จึงเขียนได้เสมอ (ต่างจาก 3 ช่องล่าง)
  { key: 'Contract No.', io: 'in', width: 18, format: 'ข้อความ',
    note: 'เลขที่สัญญาขาย — กรอกแล้ว Customer / Contact / Location เลิกเป็น "ข้อมูลแผน" · เขียนได้ทุกเครื่อง (รวมที่ดึงเข้า Job แล้ว) เพราะเป็นข้อมูลอ้างอิงคนละชั้นกับ Job',
    alias: ['contract', 'contract no', 'contract_no', 'เลขที่สัญญา', 'สัญญา'] },
  { key: 'Customer', io: 'in', width: 24, format: 'ข้อความ',
    note: 'เขียนได้เฉพาะเครื่องที่ยังไม่ถูกดึงเข้า Job (เครื่องที่มี Job แล้วใช้ค่าจาก Job) · เป็น "ข้อมูลแผน" จนกว่าจะมี Contract No.',
    alias: ['ชื่อลูกค้า', 'ลูกค้า', 'customer', 'customer_name'] },
  { key: 'Contact Number', io: 'in', width: 16, format: 'ข้อความ',
    note: 'เงื่อนไขเดียวกับ Customer',
    alias: ['เบอร์ติดต่อ', 'เบอร์', 'phone', 'contact_phone', 'contact number'] },
  { key: 'Location / Site', io: 'in', width: 28, format: 'ข้อความ',
    note: 'เงื่อนไขเดียวกับ Customer',
    alias: ['สถานที่ติดตั้ง', 'สถานที่', 'location', 'install_location', 'location / site', 'location/site'] },
  { key: 'Plan PO receipt', io: 'in', width: 15, format: 'YYYY-MM-DD',
    note: 'วันที่คาดว่าจะได้รับ PO จากลูกค้า (แผนฝั่งขาย) — คนละตัวกับ ETA to WH ที่เป็นวันของเข้าคลัง · เงื่อนไขเดียวกับ Customer',
    alias: ['plan po receipt', 'plan_po', 'plan po'] },
  { key: 'FOB date', io: 'in', width: 13, format: 'YYYY-MM-DD',
    note: 'วันที่ของลงเรือ — กรอกช่องนี้แล้วระบบคำนวณ ETA to WH ให้เอง', alias: ['fob', 'fob_date', 'fob date'] },
  { key: 'ระยะขนส่ง (วัน)', io: 'in', width: 15, format: `จำนวนเต็ม ${ETA_LEAD_MIN}–${ETA_LEAD_MAX}`, num: 'int',
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
  const isDemo = !supabase                 // 0074 — เพดานขนาดไฟล์คนละค่า (demo เก็บใน localStorage)
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
  const [filesFor, setFilesFor] = useState<string | null>(null)   // 0074 — โมดัลเอกสารแนบรายเครื่อง
  const [uploading, setUploading] = useState(false)
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
  // สิทธิ์ดาวน์โหลดรายงานผู้บริหาร (ไฟล์พาต้นทุน/มูลค่าคลังออกนอกระบบ) — ไม่มีสิทธิ์ = ไม่เห็นปุ่ม
  const canReport = can(user, 'report.exec')

  // ---- ลิงก์สาธารณะให้ผู้บริหารดูคลัง LBS โดยไม่ต้อง login (0069) ----
  const [showShare, setShowShare] = useState(false)
  const [shareStock, setShareStock] = useState('')     // '' = ทุกคลัง
  const [shareLabel, setShareLabel] = useState('')
  const [newLink, setNewLink] = useState<string | null>(null)   // URL เต็ม โชว์ครั้งเดียวตอนสร้าง
  const activeLinks = db.publicShareLinks.filter(l => !l.revokedAt)
  const stockNoOfAny = (id: string) => db.projectStocks.find(s => s.id === id)?.stockNo ?? '(คลังถูกลบ)'
  const createLink = async () => {
    try {
      const token = await act.createShareLink({
        projectStockId: shareStock || undefined,
        label: shareLabel.trim() || undefined,
      })
      // ใช้ origin ของหน้าที่กำลังเปิดอยู่ — ไม่ hardcode โดเมน (custom domain ภายหลังก็ยังถูก)
      setNewLink(`${location.origin}${location.pathname}#/share/${token}`)
      setShareLabel('')
      show('สร้างลิงก์แล้ว — คัดลอกเก็บไว้ก่อนปิดหน้าต่าง')
    } catch (e) {
      show(e instanceof Error ? e.message : 'สร้างลิงก์ไม่สำเร็จ', true)
    }
  }
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
    const sum = stockSummary(db, stockId)
    // ข้อมูลลูกค้า ref จาก Job ที่เครื่องถูกดึงเข้า (single source of truth)
    const rows: Record<string, Cell>[] = units.map(u => {
      const job = u.jobId ? db.jobs.find(j => j.id === u.jobId) : undefined
      return {
        'Serial.LVB': u.serialLvb,
        'Serial.OM': u.serialOm,
        'Cost/Set': u.unitCost ?? '',
        'Contract No.': u.contractNo ?? '',
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
    // ชีตข้อมูล — หัวตารางแถว 1 + autofilter + ความกว้าง + รูปแบบตัวเลข (คลังเปล่าก็ได้หัวตารางครบ
    // ตามบั๊กที่เจอตอน export Project Stock No.21) · **ไม่ใส่แถวรวม** เพราะชีตนี้ Import กลับได้
    // (freeze panes ไม่ได้ตั้งไว้ — SheetJS รุ่น community ไม่เขียน `!freeze` ลงไฟล์ ใส่ไปก็ไม่มีผล)
    const ws = dataSheet(XLSX, rows, SHEET_COLS)

    // ---------------- ชีต "สรุปผู้บริหาร" ----------------
    // ตัวเลขทุกตัวมาจาก stockSummary / unitFlowState ชุดเดียวกับที่การ์ดคลังบนหน้าจอใช้
    // (ไม่คำนวณซ้ำในนี้ — ไฟล์กับหน้าจอต้องตอบเลขเดียวกันเสมอ)
    const installedCount = units.filter(u => !!unitInstallDate(db, u.id)).length
    const uncosted = units.length - sum.costedUnits
    const totalCost = sum.totalCost ?? 0

    const FLOW_ORDER = ['unknown', 'pending', 'on_hand', 'allocated', 'issued', 'installed', 'blocked']
    const flowRows = FLOW_ORDER
      .map(k => {
        const us = units.filter(u => unitFlowState(db, u) === k)
        return { k, count: us.length, cost: us.reduce((n, u) => n + (u.unitCost ?? 0), 0) }
      })
      .filter(x => x.count > 0)

    // Job ที่ดึงเครื่องจากคลังนี้ — เรียงเครื่องมาก→น้อย (งานที่กินของจากคลังนี้มากสุดอยู่บน)
    const jobIds = [...new Set(units.map(u => u.jobId).filter((v): v is string => !!v))]
    const jobRows = jobIds
      .map(jid => {
        const job = db.jobs.find(j => j.id === jid)
        const us = units.filter(u => u.jobId === jid)
        return {
          jobNo: job?.jobNo ?? '(ไม่พบ Job)',
          customer: job?.customerName ?? '-',
          count: us.length,
          issued: us.filter(u => u.status === 'issued').length,
          installed: us.filter(u => !!unitInstallDate(db, u.id)).length,
          cost: us.reduce((n, u) => n + (u.unitCost ?? 0), 0),
        }
      })
      .sort((a, b) => b.count - a.count || a.jobNo.localeCompare(b.jobNo))

    // แผนของเข้าคลังรายเดือน — เฉพาะเครื่องที่ยังไม่ถูกดึงเข้า Job (ของที่ยัง "จะมา")
    const etaBuckets = new Map<string, { count: number; cost: number }>()
    units.filter(u => u.status === 'in_stock').forEach(u => {
      const eta = unitEta(u)
      const key = eta ? eta.slice(0, 7) : 'ยังไม่ระบุ ETA'
      const g = etaBuckets.get(key) ?? { count: 0, cost: 0 }
      g.count += 1
      g.cost += u.unitCost ?? 0
      etaBuckets.set(key, g)
    })

    const tables: SumTable[] = [
      {
        title: `สถานะรายเครื่อง (Status) — ${units.length} เครื่อง`,
        head: ['สถานะ', 'จำนวน (เครื่อง)', 'สัดส่วน', 'ต้นทุนรวม (บาท)'],
        rows: flowRows.map(f => [UNIT_FLOW[f.k].label, f.count, pctOf(f.count, units.length), f.cost]),
        num: { 1: 'int', 2: PCT, 3: 'money0' },
        total: ['รวมทั้งคลัง', units.length, units.length > 0 ? 100 : '-', totalCost],
        empty: '(คลังนี้ยังไม่มีเครื่องในระบบ)',
      },
      {
        title: 'Job ที่ดึงเครื่องจากคลังนี้',
        head: ['Job No.', 'ลูกค้า', 'ดึงไป (เครื่อง)', 'เบิกให้ Service', 'ติดตั้งแล้ว', 'ต้นทุน LBS (บาท)'],
        rows: jobRows.map(j => [j.jobNo, j.customer, j.count, j.issued, j.installed, j.cost]),
        num: { 2: 'int', 3: 'int', 4: 'int', 5: 'money0' },
        total: [
          `รวม ${jobRows.length} Job`, '',
          jobRows.reduce((n, j) => n + j.count, 0),
          jobRows.reduce((n, j) => n + j.issued, 0),
          jobRows.reduce((n, j) => n + j.installed, 0),
          jobRows.reduce((n, j) => n + j.cost, 0),
        ],
        empty: '(ยังไม่มีเครื่องจากคลังนี้ถูกดึงเข้า Job)',
      },
      {
        title: 'แผนของเข้าคลังรายเดือน (เฉพาะเครื่องที่ยังคงเหลือในคลัง)',
        head: ['เดือนที่ของถึงคลัง (ETA to WH)', 'จำนวนเครื่อง', 'ต้นทุนรวม (บาท)'],
        rows: [...etaBuckets.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([k, v]) => [k, v.count, v.cost]),
        num: { 1: 'int', 2: 'money0' },
        empty: '(ไม่มีเครื่องคงเหลือในคลังนี้)',
      },
    ]

    const wsSum = summarySheet(XLSX, {
      title: `รายงานผู้บริหาร — Project Stock (คลัง LBS)`,
      scope: `${s.stockNo} · ${LBS_DESCRIPTION}`,
      meta: [
        ['คลัง', s.stockNo],
        ['สถานะคลัง', s.status === 'open' ? 'เปิดรับเข้า (open)' : 'ปิดแล้ว (closed)'],
        ['PO No. ที่สั่งเข้าคลัง', s.poNo || '-'],
        ['Remark', s.notes || '-'],
        ['สร้างคลังเมื่อ', fmtDate(s.createdAt)],
        ...stampMeta(user, user ? DEPT_LABEL[user.department] : undefined),
      ],
      warnings: [
        ...(sum.unknown > 0
          ? [`มี ${sum.unknown} เครื่องที่ยังไม่ระบุ ETA to WH — ตัวเลข On Hand / Pending ยังไม่ใช่ภาพจริงทั้งคลัง`]
          : []),
        ...(uncosted > 0
          ? [`มูลค่าคลังนับจากเครื่องที่กรอกต้นทุนแล้วเท่านั้น (${sum.costedUnits}/${units.length} เครื่อง) — ยอดจริงสูงกว่าที่เห็น`]
          : []),
        ...(s.status === 'closed' ? ['คลังนี้ปิดแล้ว — ไม่รับเครื่องเข้าเพิ่ม ตัวเลขในไฟล์เป็นยอดปิดคลัง'] : []),
      ],
      kpis: [
        { label: 'LBS ทั้งหมดในคลังนี้', value: units.length, unit: 'เครื่อง', num: 'int' },
        { label: 'คงเหลือในคลัง (ยังไม่ถูกดึงเข้า Job)', value: sum.available, unit: 'เครื่อง', num: 'int',
          note: `On Hand ${sum.onHand} · Pending ${sum.pending} · ยังไม่ระบุ ETA ${sum.unknown}` },
        { label: 'พร้อมดึงเข้า Job (On Hand)', value: sum.onHand, unit: 'เครื่อง', num: 'int',
          note: 'ยืนยันได้ว่าของถึงคลังแล้ว — ตัวเลขนี้คือกำลังผลิตที่ขายได้จริง' },
        { label: 'ระหว่างขนส่ง (Pending)', value: sum.pending, unit: 'เครื่อง', num: 'int',
          note: 'ยังไม่ถึง ETA to WH — จองล่วงหน้าเข้า Job ได้ แต่เบิกให้ Service ไม่ได้' },
        { label: 'ยังไม่ระบุ ETA to WH (?)', value: sum.unknown, unit: 'เครื่อง', num: 'int',
          note: 'ต้องกรอก FOB date หรือ ETA ก่อน ระบบจึงบอกได้ว่าของถึงคลังหรือยัง' },
        { label: 'ถูกดึงเข้า Job แล้ว', value: sum.allocated, unit: 'เครื่อง', num: 'int' },
        { label: 'เบิกให้ Service แล้ว', value: sum.issued, unit: 'เครื่อง', num: 'int' },
        { label: 'ติดตั้งเสร็จแล้ว (ยืนยันหน้างาน)', value: installedCount, unit: 'เครื่อง', num: 'int' },
        { label: 'มูลค่าคลัง (ต้นทุนรวม)', value: orDash(sum.totalCost), unit: 'บาท', num: 'money0',
          note: `นับจาก ${sum.costedUnits}/${units.length} เครื่องที่กรอกต้นทุนแล้ว` },
        { label: 'ต้นทุนเฉลี่ยต่อเครื่อง', value: sum.costedUnits > 0 ? totalCost / sum.costedUnits : '-',
          unit: 'บาท', num: 'money' },
        { label: 'เครื่องที่ยังไม่กรอกต้นทุน', value: uncosted, unit: 'เครื่อง', num: 'int',
          note: uncosted > 0 ? 'กรอกที่ปุ่ม "แก้ข้อมูล" รายเครื่อง หรือผ่าน Import Excel' : 'ครบทุกเครื่อง' },
      ],
      tables,
      notes: [
        'Status ทุกค่าเป็นค่าที่ระบบคำนวณให้จาก ETA to WH + สถานะการดึง/เบิก/ติดตั้ง — ไม่มีใครกรอกมือ (ลำดับทั้งเส้นอยู่ในชีต "วิธีกรอก")',
        `ETA to WH = FOB date + ระยะขนส่ง (${ETA_LEAD_MIN}–${ETA_LEAD_MAX} วัน · ค่ามาตรฐาน ${ETA_LEAD_DAYS}) · ไม่มีทั้ง FOB และ ETA จะขึ้น "?" ระบบไม่เดาว่าของถึงคลังแล้ว`,
        'มูลค่าคลัง = ผลรวม "ต้นทุน/เครื่อง" ของเครื่องที่กรอกราคาไว้ — เป็นต้นทุนที่บันทึกในระบบนี้ ไม่ใช่มูลค่าตามบัญชี',
        'ต้นทุนของเครื่องที่ถูกดึงเข้า Job จะไปบวกเป็น actual หมวด Raw Material ของงานนั้นด้วย — อย่านับซ้ำกับรายงานงบ Job',
        `ชีต "${s.stockNo}" นำกลับเข้าระบบได้ด้วยปุ่ม ⬆ Import Excel — ห้ามย้าย/ลบแถวหัวตาราง และห้ามเพิ่มแถวรวมในชีตนั้น`,
      ],
    })

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
      ['7', `ชีต "${SHEET_SUMMARY}" กับชีตนี้เป็นชีตอ่านอย่างเดียว — ระบบข้ามให้เองตอน Import ไม่ต้องลบก่อนอัปไฟล์`],
      ['8', `แก้ไขได้เฉพาะชีต "${s.stockNo}" · ห้ามเปลี่ยนชื่อชีตนั้น ห้ามย้าย/ลบแถวหัวตาราง และห้ามเพิ่มแถวรวมท้ายตาราง`],
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

    // ลำดับชีต: สรุปผู้บริหารมาก่อน (คนเปิดไฟล์เห็นภาพรวมทันที) แล้วชีตข้อมูล แล้วคู่มือ
    // ⚠️ ชีตข้อมูลไม่ใช่ชีตแรกแล้ว — ตัวอ่าน Import ต้องใช้ dataSheetName() ห้ามอ่าน SheetNames[0]
    const wb = buildWorkbook(XLSX, [
      { name: SHEET_SUMMARY, ws: wsSum },
      { name: s.stockNo, ws },
      { name: 'วิธีกรอก', ws: wsGuide },
    ])
    saveReport(XLSX, wb, `รายงานผู้บริหาร-${s.stockNo}`)
  }

  const onPickImportFile = async (file: File) => {
    const target = importToRef.current
    if (!target) return
    try {
      const XLSX = await import('xlsx')
      // cellDates: เซลล์วันที่ (Plan PO receipt / Plan Delivery) จะได้เป็น Date ไม่ใช่ serial number
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
      // หาชีตข้อมูล: ลองชื่อคลังที่กำลัง import เข้าก่อน แล้วค่อย fallback ชีตแรกที่ไม่ใช่คู่มือ/สรุป
      // ⚠️ ตั้งแต่ 2026-09-09 ไฟล์ Export มีชีต "สรุปผู้บริหาร" เป็นชีตแรก — อ่าน SheetNames[0]
      //    ตรง ๆ จะได้ชีตสรุปแล้วขึ้น "ไฟล์ไม่มีข้อมูล" ทั้งที่ไฟล์ถูกต้อง
      const sheetName = dataSheetName(wb, [target.no])
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: '' })
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
          contractNo: cell(row, colKeys('Contract No.')) || undefined,
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
    const rows: Record<string, Cell>[] = matFiltered.map(({ po, r, item }) => {
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
    // ไฟล์นี้อ่านอย่างเดียว → ใส่แถวรวมท้ายตารางได้ (ต่างจากชีตข้อมูลของคลัง LBS ที่ import กลับได้)
    const ws = dataSheet(XLSX, rows, MAT_COLS, { totalRow: true, totalLabel: `รวม ${rows.length} รายการ` })

    // ---------------- ชีต "สรุปผู้บริหาร" ----------------
    const total = matFiltered.reduce((n, x) => n + lineValue(x.r), 0)
    const noPrice = matFiltered.filter(x => x.r.unitPrice === undefined)
    const atJob = matFiltered.filter(x => !x.r.issuedToServiceAt)
    const atSite = matFiltered.filter(x => !!x.r.issuedToServiceAt)
    const atJobValue = atJob.reduce((n, x) => n + lineValue(x.r), 0)
    const atSiteValue = atSite.reduce((n, x) => n + lineValue(x.r), 0)
    const suppliers = new Set(matFiltered.map(x => x.po.supplierName || '(ไม่ระบุ)'))

    // Top วัสดุตามมูลค่า — ผู้บริหารถามเสมอว่า "เงินก้อนนี้ไปลงที่ของอะไร"
    const byItem = new Map<string, { name: string; code: string; uom: string; qty: number; value: number }>()
    matFiltered.forEach(({ r, item }) => {
      const key = item?.id ?? 'unknown'
      const g = byItem.get(key) ?? {
        name: item?.name ?? '(ไม่พบวัสดุ)', code: item?.epicorCode || '-', uom: item?.uom ?? '', qty: 0, value: 0,
      }
      g.qty += r.qtyReceived
      g.value += lineValue(r)
      byItem.set(key, g)
    })
    const topItems = [...byItem.values()].sort((a, b) => b.value - a.value || b.qty - a.qty).slice(0, 10)

    const bySupplier = new Map<string, { pos: Set<string>; lines: number; value: number }>()
    matFiltered.forEach(({ po, r }) => {
      const key = po.supplierName || '(ไม่ระบุ)'
      const g = bySupplier.get(key) ?? { pos: new Set<string>(), lines: 0, value: 0 }
      g.pos.add(po.id)
      g.lines += 1
      g.value += lineValue(r)
      bySupplier.set(key, g)
    })
    const supplierRows = [...bySupplier.entries()].sort((a, b) => b[1].value - a[1].value)

    const tables: SumTable[] = [
      {
        title: 'สรุปตาม Job — เงินที่ลงไปกับวัสดุของแต่ละงาน',
        head: ['Job No.', 'ลูกค้า', 'PO (ใบ)', 'รายการ', 'มูลค่า (บาท)', 'รับของล่าสุด'],
        rows: matJobs.map(g => [g.jobNo, g.customer, g.pos.length, g.lines, g.value, g.latest.slice(0, 10) || '-']),
        num: { 2: 'int', 3: 'int', 4: 'money0' },
        total: [`รวม ${matJobs.length} Job`, '', matTotal.pos, matTotal.lines, total, ''],
        empty: '(ไม่มีรายการในขอบเขตนี้)',
      },
      {
        title: 'Top 10 วัสดุตามมูลค่า',
        head: ['รหัส Epicor', 'ชื่ออุปกรณ์', 'จำนวนรวม', 'หน่วย', 'มูลค่า (บาท)', 'สัดส่วนของมูลค่ารวม'],
        rows: topItems.map(i => [i.code, i.name, i.qty, i.uom, i.value, pctOf(i.value, total)]),
        num: { 2: 'int', 4: 'money0', 5: PCT },
        empty: '(ไม่มีรายการในขอบเขตนี้)',
      },
      {
        title: 'สรุปตามซัพพลายเออร์',
        head: ['ซัพพลายเออร์', 'PO (ใบ)', 'รายการ', 'มูลค่า (บาท)', 'สัดส่วนของมูลค่ารวม'],
        rows: supplierRows.map(([name, g]) => [name, g.pos.size, g.lines, g.value, pctOf(g.value, total)]),
        num: { 1: 'int', 2: 'int', 3: 'money0', 4: PCT },
        total: [`รวม ${supplierRows.length} ราย`, matTotal.pos, matTotal.lines, total, total > 0 ? 100 : '-'],
        empty: '(ไม่มีรายการในขอบเขตนี้)',
      },
    ]

    const wsSum = summarySheet(XLSX, {
      title: 'รายงานผู้บริหาร — วัสดุตาม Job (Ref.PO)',
      scope: matSearch.trim()
        ? `เฉพาะรายการที่ตรงคำค้น "${matSearch.trim()}"`
        : 'ทุกรายการที่รับของครบจาก PO แล้ว (ทั้งระบบ)',
      meta: [
        ['ที่มาของข้อมูล', 'PO ที่ปิดรับของครบทั้งใบ — หน้า Project Stock แท็บ "วัสดุตาม Job (Ref.PO)"'],
        ...stampMeta(user, user ? DEPT_LABEL[user.department] : undefined),
      ],
      warnings: [
        ...(matSearch.trim()
          ? [`ไฟล์นี้ถูกกรองด้วยคำค้น "${matSearch.trim()}" — ไม่ใช่รายการทั้งหมดในระบบ ห้ามใช้เป็นยอดรวมองค์กร`]
          : []),
        ...(noPrice.length > 0
          ? [`มี ${noPrice.length} รายการที่ยังไม่ได้กรอกราคาจริง — มูลค่ารวมในไฟล์นี้ต่ำกว่าความจริง (กรอกที่ปุ่ม 💰 ราคาจริง หน้า Purchasing)`]
          : []),
      ],
      kpis: [
        { label: 'รายการวัสดุที่รับของครบแล้ว', value: matTotal.lines, unit: 'รายการ', num: 'int' },
        { label: 'จำนวน PO ที่ปิดรับของ', value: matTotal.pos, unit: 'ใบ', num: 'int' },
        { label: 'จำนวน Job ที่เกี่ยวข้อง', value: matJobs.length, unit: 'Job', num: 'int' },
        { label: 'จำนวนซัพพลายเออร์', value: suppliers.size, unit: 'ราย', num: 'int' },
        { label: 'มูลค่าวัสดุรวม', value: total, unit: 'บาท', num: 'money0',
          note: 'ราคาจริง × จำนวนที่รับ — เฉพาะรายการที่กรอกราคาแล้ว' },
        { label: 'มูลค่าที่ยังอยู่กับ Job', value: atJobValue, unit: 'บาท', num: 'money0',
          note: `${atJob.length} รายการ — รับของแล้วแต่ยังไม่ส่งออกหน้างาน` },
        { label: 'มูลค่าที่เบิกออกหน้างานแล้ว', value: atSiteValue, unit: 'บาท', num: 'money0',
          note: `${atSite.length} รายการ — เบิกให้ Service แล้ว` },
        { label: 'รายการที่ยังไม่กรอกราคาจริง', value: noPrice.length, unit: 'รายการ', num: 'int',
          note: noPrice.length > 0 ? 'ทำให้มูลค่ารวมยังไม่ครบ' : 'ราคาครบทุกรายการ' },
        { label: 'มูลค่าเฉลี่ยต่อ Job', value: matJobs.length > 0 ? total / matJobs.length : '-',
          unit: 'บาท', num: 'money0' },
      ],
      tables,
      notes: [
        'นี่ไม่ใช่ยอดคลังคงเหลือ — ของทุกชิ้นในไฟล์นี้ผูกกับ Job ไปแล้ว (คลังคงเหลือดูที่หน้า Material Database)',
        'นับเฉพาะ PO ที่ปิดรับของครบทั้งใบ · ของที่ยังค้างรับดูที่หน้า Purchasing (ยังไม่เป็นต้นทุนในไฟล์นี้)',
        '"เบิกให้ Service" คือขั้นส่งของออกหน้างาน (0059) — รับของแล้วไม่ได้แปลว่าออกไปหน้างานแล้ว',
        'มูลค่ารวมนับจากราคาจริงที่บันทึกหลังออก PO เท่านั้น — รายการที่ยังไม่กรอกราคาถูกนับเป็น 0',
        'ไฟล์นี้ Import กลับเข้าระบบไม่ได้ — เป็นรายงานสำหรับตรวจสอบ/ประชุมเท่านั้น',
      ],
    })

    const wsGuide = guideSheet(
      XLSX,
      [
        ['วัสดุตาม Job (Ref.PO) — รายการที่รับของครบจาก PO แล้ว'],
        [`ออกจากระบบเมื่อ ${fmtDateTime(new Date().toISOString())}`],
        [`${matTotal.lines} รายการ · ${matTotal.pos} PO · ${matJobs.length} Job · มูลค่ารวม ${total.toLocaleString('th-TH')} บาท`],
        ...(matSearch.trim() ? [[`⚠️ ไฟล์นี้กรองด้วยคำค้น "${matSearch.trim()}" — ไม่ใช่รายการทั้งหมดในระบบ`]] : []),
      ],
      MAT_COLS,
      [
        'นี่ไม่ใช่ยอดคลังคงเหลือ — ของทุกชิ้นในไฟล์นี้ผูกกับ Job ไปแล้ว (คลังคงเหลือดูที่หน้า Material Database)',
        'นับเฉพาะ PO ที่ปิดรับของครบทั้งใบ · ของที่ยังค้างรับดูที่หน้า Purchasing',
        '"เบิกให้ Service" คือขั้นส่งของออกหน้างาน (0059) — รับของแล้วไม่ได้แปลว่าออกไปหน้างานแล้ว',
        'แถวสุดท้ายของชีตข้อมูลเป็นแถวรวม — autofilter ไม่คลุมแถวนั้น กรองแล้วยอดรวมไม่หาย',
        'ไฟล์นี้ Import กลับเข้าระบบไม่ได้ — เป็นรายงานสำหรับตรวจสอบเท่านั้น',
      ],
    )

    const wb = buildWorkbook(XLSX, [
      { name: SHEET_SUMMARY, ws: wsSum },
      { name: MAT_SHEET, ws },
      { name: SHEET_GUIDE, ws: wsGuide },
    ])
    saveReport(XLSX, wb, 'รายงานผู้บริหาร-วัสดุตาม-Job')
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
        <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => { setRows([emptyRow()]); setStockNo(`Project Stock No.${db.projectStocks.length + 1}`); setPoNo(''); setNotes(''); setShowCreate(true) }}>+ สร้าง Project Stock ใหม่ (สั่งซื้อ LBS เข้าคลัง)</button>
          <button onClick={() => setShowShare(v => !v)}>
            🔗 ลิงก์ให้ผู้บริหารดู{activeLinks.length > 0 ? ` (${activeLinks.length})` : ''}
          </button>
        </div>
      )}

      {/* ลิงก์สาธารณะ (0069) — Division/Manage สร้าง/เพิกถอน · หน้าปลายทางไม่ต้อง login */}
      {canManage && showShare && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>🔗 ลิงก์ให้ผู้บริหารดูคลัง LBS <span className="muted" style={{ fontWeight: 400 }}>· ไม่ต้องเข้าสู่ระบบ</span></h3>
            <button className="small" onClick={() => setShowShare(false)}>ปิด</button>
          </div>
          <div className="panel-body">
            <div className="muted" style={{ marginBottom: 10 }}>
              ⚠️ <b>ใครถือลิงก์ก็เปิดได้</b> — ส่งต่อทาง LINE/เมลแล้วคุมไม่ได้ · หน้าปลายทางแสดง
              <b>รายเครื่อง สถานะ ETA ลูกค้า สถานที่ติดตั้ง</b> เท่านั้น
              <b> ไม่มีต้นทุน ไม่มีมูลค่าคลัง ไม่มีเบอร์โทร</b> (ตัดตั้งแต่ชั้นข้อมูล ไม่ใช่ซ่อนที่หน้าจอ) ·
              ลิงก์<b>ไม่มีวันหมดอายุ</b> ใช้ได้จนกว่าจะกดเพิกถอน
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>ขอบเขตข้อมูล</span>
                <select value={shareStock} onChange={e => setShareStock(e.target.value)} style={{ minWidth: 220 }}>
                  <option value="">ทุกคลัง</option>
                  {db.projectStocks.map(s => <option key={s.id} value={s.id}>{s.stockNo}</option>)}
                </select>
              </label>
              <label className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
                <span>ชื่อกำกับ (ไว้จำว่าส่งให้ใคร)</span>
                <input value={shareLabel} onChange={e => setShareLabel(e.target.value)} placeholder="เช่น คุณสมชาย (กรรมการ)" />
              </label>
              <button className="primary" onClick={createLink}>+ สร้างลิงก์</button>
            </div>
            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th>ขอบเขต</th><th>ชื่อกำกับ</th><th>รหัสลิงก์</th><th>สร้างเมื่อ</th>
                  <th>เปิดดู</th><th>สถานะ</th><th></th>
                </tr></thead>
                <tbody>
                  {db.publicShareLinks.length === 0 && (
                    <tr><td colSpan={7}><div className="empty">ยังไม่มีลิงก์ — กด "+ สร้างลิงก์" เพื่อออกลิงก์ใบแรก</div></td></tr>
                  )}
                  {db.publicShareLinks.map(l => (
                    <tr key={l.id}>
                      <td className="mono">{l.projectStockId ? stockNoOfAny(l.projectStockId) : "ทุกคลัง"}</td>
                      <td>{l.label || <span className="muted">-</span>}</td>
                      <td className="mono">…{l.tokenHint}</td>
                      <td className="muted">{fmtDate(l.createdAt)}</td>
                      <td>
                        {l.viewCount > 0
                          ? <>{l.viewCount} ครั้ง<div className="muted">{l.lastViewedAt ? fmtDateTime(l.lastViewedAt) : ''}</div></>
                          : <span className="muted">ยังไม่เคยเปิด</span>}
                      </td>
                      <td>{l.revokedAt
                        ? <><span className="badge neutral">เพิกถอนแล้ว</span><div className="muted">{fmtDate(l.revokedAt)}</div></>
                        : <span className="badge green">ใช้งานได้</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {!l.revokedAt && (
                          <button className="small danger" onClick={async () => {
                            if (await askConfirm({
                              title: 'เพิกถอนลิงก์',
                              description: <>ลิงก์ …{l.tokenHint} จะ<b>เปิดไม่ได้ทันที</b> ทุกคนที่ถืออยู่ ·
                                ถ้ายังต้องให้ดูอยู่ ให้สร้างลิงก์ใหม่แล้วส่งให้ใหม่</>,
                              confirmLabel: 'เพิกถอน',
                            })) tryAction(() => act.revokeShareLink({ linkId: l.id }), 'เพิกถอนลิงก์แล้ว')
                          }}>เพิกถอน</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* โชว์ลิงก์เต็มครั้งเดียวตอนสร้าง — ฝั่ง LIVE เก็บแต่ hash เปิดดูซ้ำไม่ได้ */}
      {newLink && (
        <Modal title="ลิงก์พร้อมส่งแล้ว" onClose={() => setNewLink(null)}
          footer={<button className="primary" onClick={() => setNewLink(null)}>เสร็จสิ้น</button>}>
          <p className="muted" style={{ marginBottom: 10 }}>
            🔴 <b>คัดลอกเก็บไว้ตอนนี้เลย</b> — ระบบเก็บเฉพาะลายนิ้วมือของลิงก์ไว้ตรวจสอบ
            <b>เปิดดูลิงก์เต็มซ้ำไม่ได้อีก</b> · ลืมแล้วให้เพิกถอนใบเก่าแล้วสร้างใหม่
          </p>
          <textarea readOnly rows={3} value={newLink} onFocus={e => e.currentTarget.select()}
            style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12.5 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="primary" onClick={() => {
              navigator.clipboard?.writeText(newLink).then(
                () => show('คัดลอกลิงก์แล้ว'),
                () => show('คัดลอกอัตโนมัติไม่ได้ — กดเลือกข้อความแล้ว Ctrl+C', true))
            }}>📋 คัดลอกลิงก์</button>
            <a className="button" href={newLink} target="_blank" rel="noreferrer">เปิดดูตัวอย่าง ↗</a>
          </div>
        </Modal>
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
                {/* ไฟล์พาต้นทุน/มูลค่าคลังออกไปนอกระบบ → ปุ่มหายทั้งปุ่มถ้าไม่มีสิทธิ์ (report.exec) */}
                {canReport && (
                  <button className="small" onClick={() => exportStock(s.id)}
                    title="รายงานผู้บริหาร (Excel) — ชีตสรุป + รายเครื่อง (Import กลับได้) + วิธีกรอก">
                    ⬇ Export
                  </button>
                )}
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
                  <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th style={{ textAlign: 'right' }}>Cost/Set</th><th>Contract No.</th><th>Customer</th><th>Contact Number</th><th>Location / Site</th><th>Plan PO receipt</th><th>Job No.</th><th>FOB date</th><th>ETA to WH</th><th>Status</th><th>Plan Delivery</th><th>Actual Delivery</th>{canManage && <th></th>}</tr></thead>
                  <tbody>
                    {units.map(u => {
                      // 0073: ลำดับความจริง 3 ชั้น — Job ชนะ (0014) → สัญญา → แผน · helper เดียวใช้ทุกที่
                      const info = unitCustomerInfo(db, u)
                      const job = info.job
                      // ติดป้าย "แผน" เฉพาะตอนที่ยังไม่มีทั้งสัญญาและ Job เท่านั้น
                      const planned = info.source === 'plan'
                      const cust = info.customer
                      const phone = info.phone
                      const loc = info.location
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
                          <td className="mono">
                            {u.contractNo || '-'}
                            {/* ผูก Job แล้ว เลขสัญญาเป็นข้อมูลอ้างอิง — Job ยังเป็นแหล่งความจริงของลูกค้า/สถานที่ */}
                            {u.contractNo && job && <div className="muted" style={{ fontSize: 11 }}>Ref.</div>}
                          </td>
                          <td>
                            {cust ?? '-'}
                            {planned && cust && <span className="badge neutral" style={{ marginLeft: 6 }}>แผน</span>}
                            {/* ธงให้คนไปตรวจ ไม่บล็อกอะไร — มักแปลว่าดึงเครื่องผิดใบ หรือกรอกสัญญาผิด */}
                            {info.mismatch.length > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--danger)' }}
                                title={`ข้อมูลฝั่งสัญญา ${u.contractNo} ไม่ตรงกับ Job — ระบบใช้ค่าจาก Job`}>
                                ⚠️ ต่างจากสัญญา: {info.mismatch.join(', ')}
                              </div>
                            )}
                          </td>
                          <td>{phone ?? '-'}{planned && phone && <span className="badge neutral" style={{ marginLeft: 6 }}>แผน</span>}</td>
                          <td>{loc || '-'}{planned && loc && <span className="badge neutral" style={{ marginLeft: 6 }}>แผน</span>}</td>
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
                              {/* 0074: ปุ่มเอกสารขึ้นทุกสถานะรวมเครื่องที่เบิกไปแล้ว — ใบส่งของ/รูปสภาพเครื่อง
                                  ตอนส่งมอบมักมาถึงหลังของออกจากคลัง ล็อกไว้ = แนบหลักฐานไม่ได้ */}
                              <button className="small" style={{ marginRight: 6 }} title="เอกสารแนบของเครื่องนี้ (สัญญา · ใบส่งของ · รูป)"
                                onClick={() => setFilesFor(u.id)}>
                                📎{unitFileCount(db, u.id) > 0 ? ` ${unitFileCount(db, u.id)}` : ''}
                              </button>
                              {u.status === 'issued'
                                ? <span className="muted" title="เบิกให้ Service แล้ว — allocation ถูกล็อก แก้ข้อมูลรายเครื่องไม่ได้">🔒</span>
                                : <button className="small" onClick={() => setEditPlan({
                                    id: u.id, canEditSerial: u.status === 'in_stock', hasJob: !!u.jobId,
                                    serialLvb: u.serialLvb, serialOm: u.serialOm,
                                    origLvb: u.serialLvb, origOm: u.serialOm,
                                    cost: u.unitCost !== undefined ? String(u.unitCost) : '',
                                    contractNo: u.contractNo ?? '',
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
                {canReport && (
                  <button className="small" onClick={exportMaterial} disabled={matFiltered.length === 0}
                    title={matFiltered.length === 0 ? 'ไม่มีรายการให้ export'
                      : matSearch.trim() ? `รายงานผู้บริหาร — เฉพาะ ${matFiltered.length} รายการที่กรองอยู่ (ไฟล์เตือนไว้ในชีตสรุป)`
                      : 'รายงานผู้บริหาร (Excel) — ชีตสรุป + รายละเอียดทุกบรรทัด + คำอธิบาย'}>
                    ⬇ Export Excel{matSearch.trim() ? ` (${matFiltered.length})` : ''}
                  </button>
                )}
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

      {/* ---------------- เอกสารแนบรายเครื่อง (0074) ----------------
          แยกโมดัลจาก "แก้ข้อมูล" เพราะการอัปโหลดเกิดผลทันทีทีละไฟล์ ส่วนฟอร์มแก้ข้อมูลบันทึกทีเดียว
          ปนกันแล้วผู้ใช้จะไม่รู้ว่ากด "ยกเลิก" แล้วไฟล์ที่เพิ่งอัปโหลดหายด้วยหรือไม่ */}
      {filesFor && (() => {
        const u = db.lbsUnits.find(x => x.id === filesFor)
        if (!u) return null
        const files = unitFiles(db, filesFor)
        const maxMb = isDemo ? DEMO_MAX_UNIT_FILE_MB : MAX_UNIT_FILE_MB
        return (
          <Modal title={`เอกสารแนบ — ${u.serialLvb}`} size="wide" onClose={() => setFilesFor(null)}
            footer={<button onClick={() => setFilesFor(null)}>ปิด</button>}>
            <div className="muted" style={{ marginBottom: 12 }}>
              สัญญา · ใบส่งของ · รูปสภาพเครื่อง — แนบได้หลายไฟล์ · รับ <b>PDF และรูปภาพ</b> ขนาดไม่เกิน <b>{maxMb} MB</b>/ไฟล์
              {/* บอกเหตุผลของเพดานที่ต่างกัน ไม่งั้นคนเทสต์บนเดโมจะคิดว่าระบบจริงก็จำกัดแค่นี้ */}
              {isDemo
                ? <><br />⚠️ โหมด Demo เก็บไฟล์ไว้ในเบราว์เซอร์ (localStorage) จึงจำกัดที่ {DEMO_MAX_UNIT_FILE_MB} MB — ระบบจริงได้ถึง {MAX_UNIT_FILE_MB} MB</>
                : <><br />ไฟล์เก็บใน storage แบบปิด — เปิดได้เฉพาะคนที่ล็อกอิน และลิงก์หมดอายุใน 5 นาที</>}
            </div>

            <label className="field">
              <span>เพิ่มเอกสาร (เลือกได้หลายไฟล์)</span>
              <input type="file" multiple accept="application/pdf,image/*" disabled={uploading}
                onChange={async e => {
                  const picked = [...(e.target.files ?? [])]
                  e.target.value = ''                      // ให้เลือกไฟล์ชื่อเดิมซ้ำได้
                  if (picked.length === 0) return
                  setUploading(true)
                  let ok = 0
                  for (const f of picked) {
                    // เช็คขนาดก่อนอ่านไฟล์ — โหมด demo อ่านเป็น data URL ซึ่งกิน memory ตามขนาดไฟล์
                    if (f.size > maxMb * 1024 * 1024) { show(`${f.name}: ไฟล์ใหญ่เกิน ${maxMb} MB`, true); continue }
                    if (!isAllowedUnitFile(f.type)) { show(`${f.name}: รับเฉพาะ PDF และรูปภาพ`, true); continue }
                    try {
                      const filePath = supabase
                        ? await uploadUnitDoc(supabase, u.id, f)
                        : await readAsDataUrl(f)           // demo — เก็บเนื้อไฟล์ตรง ๆ
                      await act.addUnitFile({
                        unitId: u.id, fileName: f.name, filePath,
                        mimeType: f.type, sizeBytes: f.size,
                      })
                      ok++
                    } catch (err) {
                      show(err instanceof Error ? err.message : `แนบ ${f.name} ไม่สำเร็จ`, true)
                    }
                  }
                  setUploading(false)
                  if (ok > 0) show(`แนบเอกสารแล้ว ${ok} ไฟล์`)
                }} />
            </label>
            {uploading && <div className="muted">กำลังอัปโหลด…</div>}

            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>ชื่อไฟล์</th><th>ชนิด</th><th style={{ textAlign: 'right' }}>ขนาด</th><th>แนบเมื่อ</th><th>โดย</th><th></th></tr></thead>
                <tbody>
                  {files.length === 0 && <tr><td colSpan={6}><div className="empty">ยังไม่มีเอกสารแนบ</div></td></tr>}
                  {files.map(f => (
                    <tr key={f.id}>
                      <td>
                        <button className="small" title="เปิดไฟล์"
                          onClick={async () => {
                            try {
                              // LIVE: ขอ signed URL ใหม่ทุกครั้ง (ลิงก์หมดอายุ) · demo: filePath คือ data URL อยู่แล้ว
                              const url = supabase ? await signedUnitDocUrl(supabase, f.filePath) : f.filePath
                              window.open(url, '_blank', 'noopener')
                            } catch (err) {
                              show(err instanceof Error ? err.message : 'เปิดไฟล์ไม่ได้', true)
                            }
                          }}>{f.mimeType === 'application/pdf' ? '📄' : '🖼️'} {f.fileName}</button>
                      </td>
                      <td className="muted">{f.mimeType || '-'}</td>
                      <td style={{ textAlign: 'right' }}>{Math.max(1, Math.round(f.sizeBytes / 1024)).toLocaleString('th-TH')} KB</td>
                      <td className="muted">{fmtDateTime(f.uploadedAt)}</td>
                      <td className="muted">{db.users.find(x => x.id === f.uploadedBy)?.fullName ?? '-'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="small danger" onClick={async () => {
                          if (!await askConfirm({
                            title: `ลบเอกสาร "${f.fileName}"`,
                            description: <>ลบแล้วกู้คืนไม่ได้ · การลบถูกบันทึกใน Audit Log</>,
                            confirmLabel: 'ลบเอกสาร',
                          })) return
                          if (await tryAction(() => act.deleteUnitFile({ fileId: f.id }), 'ลบเอกสารแล้ว')) {
                            // ลบแถวสำเร็จก่อน แล้วค่อยเก็บกวาดไฟล์จริง — ล้มเหลวก็แค่เหลือไฟล์กำพร้า
                            if (supabase) await removeUnitDoc(supabase, f.filePath)
                          }
                        }}>ลบ</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Modal>
        )
      })()}

      {/* แก้ข้อมูลรายเครื่อง (0043/0049) — Division/Manage · ทำได้ก่อนเบิกให้ Service
          รวม "แก้ Serial" เข้ามาที่นี่แล้ว (เดิมเป็นปุ่มแยก) — Serial แก้ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก */}
      {editPlan && (() => {
        const serialChanged = editPlan.serialLvb.trim() !== editPlan.origLvb || editPlan.serialOm.trim() !== editPlan.origOm
        const serialEmpty = !editPlan.serialLvb.trim() || !editPlan.serialOm.trim()
        // ETA to WH: มี FOB → คำนวณอัตโนมัติ (ช่องกรอกเองถูกปิด) · ไม่มี FOB → กรอกเองได้
        const lead = Number(editPlan.leadDays) || ETA_LEAD_DAYS
        // 0073: มีเลขสัญญาแล้ว 3 ช่องนี้ไม่ใช่ "แผน" อีกต่อไป — ป้ายเปลี่ยนตามที่พิมพ์ทันที
        // ผูก Job แล้ว ข้อมูลลูกค้ามาจาก Job ไม่ใช่ทั้งแผนและทั้งสัญญา จึงไม่ติดป้ายและไม่บังคับกรอก
        const planLabel = (editPlan.hasJob || editPlan.contractNo.trim()) ? '' : ' (แผน)'
        const contractNeedsInfo = !editPlan.hasJob && !!editPlan.contractNo.trim()
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
                    contractNo: editPlan.contractNo,
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
            ช่องที่เว้นว่าง = ล้างค่าเดิม · <b>Status / Actual Delivery ไม่ต้องกรอก</b> ระบบคำนวณเองจาก ETA และ flow ติดตั้ง
            {/* 0073: อธิบายลำดับความจริง 3 ชั้นให้เห็นในที่ที่คนกำลังกรอกจริง ๆ
                ไม่งั้นคนกรอกไม่รู้ว่าทำไมบางทีติดป้าย "แผน" บางทีไม่ติด */}
            <div style={{ marginTop: 6 }}>
              ลูกค้า/เบอร์/สถานที่ เป็น <b>ข้อมูลแผน</b> จนกว่าจะกรอก <b>Contract No.</b> —
              กรอกแล้วถือว่าตกลงกับลูกค้าแล้ว ป้าย "แผน" จะหายไป
              <br />เมื่อเครื่องถูกดึงเข้า Job ตารางจะแสดงค่าจาก <b>Job</b> แทนเสมอ
              (Job เป็นแหล่งข้อมูลจริงตามกติกาเดิม) · <b>Contract No. กลายเป็นข้อมูลอ้างอิง (Ref.)</b>
              และถ้า 2 ฝั่งไม่ตรงกันตารางจะขึ้นเตือนให้ไปตรวจ
            </div>
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
            <label className="field"><span>Contract No.</span>
              <input className="mono" value={editPlan.contractNo}
                onChange={e => setEditPlan({ ...editPlan, contractNo: e.target.value })} placeholder="เช่น CT-2026-001" />
            </label>
          </div>
          <div className="row">
            {/* ป้าย "(แผน)" หายทันทีที่พิมพ์เลขสัญญา — สื่อกติกาในขณะที่คนกำลังกรอก ไม่ต้องรอบันทึก */}
            <label className="field"><span>Customer{planLabel}{contractNeedsInfo ? ' *' : ''}</span>
              <input value={editPlan.customerName}
                onChange={e => setEditPlan({ ...editPlan, customerName: e.target.value })} placeholder="PEA เชียงใหม่" />
            </label>
            <label className="field"><span>Contact Number{planLabel}</span>
              <input value={editPlan.contactPhone}
                onChange={e => setEditPlan({ ...editPlan, contactPhone: e.target.value })} placeholder="08x-xxx-xxxx" />
            </label>
            <label className="field"><span>Location / Site{planLabel}{contractNeedsInfo ? ' *' : ''}</span>
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
                  <span><b>อัพเดทข้อมูลเครื่องเดิม</b> — Cost/Set · Contract No. · Customer / Contact Number / Location / Site · Plan PO receipt · FOB date · ระยะขนส่ง · ETA to WH · Plan Delivery
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
                    ℹ️ เครื่องที่ดึงเข้า Job แล้ว ระบบจะ<b>ข้ามช่อง Customer / Contact Number / Location / Site / Plan PO receipt</b> — ข้อมูลจริงมาจาก Job · <b>Contract No. ยังเขียนได้</b> (เป็นข้อมูลอ้างอิงคนละชั้นกับ Job)
                    (แก้ที่หน้า Job) · ส่วนต้นทุนกับวันแผนยังอัพเดทให้ตามไฟล์
                  </div>
                )}
                <div className="table-scroll" style={{ maxHeight: 260, overflowY: 'auto', marginTop: 10 }}>
                  <table>
                    <thead><tr>
                      <th>#</th><th>Serial.LVB</th><th>Serial.OM</th>
                      <th style={{ textAlign: 'right' }}>Cost/Set เดิม</th><th style={{ textAlign: 'right' }}>Cost/Set ใหม่</th>
                      <th>Contract No.</th><th>Customer / Contact / Location</th><th>Plan PO receipt</th><th>FOB date</th><th>ETA to WH</th><th>Plan Delivery</th><th>ผล</th>
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
                            {/* 0073: Contract No. ไม่ถูกข้ามแม้เครื่องจะมี Job แล้ว (คนละชั้นกับ Job) */}
                            <td className="mono">
                              {skip ? <span className="muted">—</span>
                                : d.row.contractNo || <span className="muted">คงเดิม</span>}
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
