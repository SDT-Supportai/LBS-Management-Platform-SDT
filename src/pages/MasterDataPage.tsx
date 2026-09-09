import { useRef, useState } from 'react'
import { useStore, can } from '../data/StoreContext'
import { Modal, useConfirm, usePrompt, useToast, useTryAction } from '../ui/components'
import { fmtBaht, fmtDateTime, DEPT_LABEL } from '../ui/format'
import {
  type Cell, type NumKind, type ReportCol, type SumTable,
  SHEET_SUMMARY, SHEET_GUIDE, buildWorkbook, dataSheet, dataSheetName,
  guideSheet, saveReport, stampMeta, summarySheet,
} from '../ui/xlsxReport'
import type { Item, StockMovementType } from '../types'

const MOVEMENT_LABEL: Record<StockMovementType, string> = {
  initial: 'ยอดตั้งต้น',
  adjust: 'ปรับยอด',
  import_adjust: 'ปรับยอดจาก Excel',
  issue_to_job: 'เบิกเข้า Job',
  return_from_job: 'คืนจาก Job',
  transfer_from_job: 'โอนจาก Job',
  job_cancelled: 'Job ถูกยกเลิก',
}

// ---------------- Excel import/export (Accessory Catalog) ----------------

// สเปกคอลัมน์รวมศูนย์ — แหล่งความจริงเดียวของทั้งไฟล์ Excel และชีต "คำอธิบาย"
// (แนวเดียวกับ SHEET_COLS/MAT_COLS ของ Project Stock และ PO_COLS ของหน้า Job)

/** ชีต "ฐานข้อมูลวัสดุ" — **Import กลับได้** ⇒ หัวตารางต้องอยู่แถว 1 และห้ามมีแถวรวม */
const CATALOG_COLS: ReportCol[] = [
  { key: 'รหัส Epicor', width: 14, note: 'ตัวระบุหลักของวัสดุ (อ้างอิงระบบ ERP) — ห้ามซ้ำ · แถวที่รหัสตรงกับของเดิม = อัพเดทรายการนั้น' },
  { key: 'ชื่ออุปกรณ์', width: 32, note: 'ชื่อที่จะไปโผล่ในการขอวัสดุ / PR / PO / BOM' },
  { key: 'หน่วย', width: 9, note: 'หน่วยนับ · เว้นว่าง = คงค่าเดิม (สร้างใหม่ใช้ "ชิ้น")' },
  { key: 'การจัดหา', width: 14, note: '"คลังสินค้า" = เก็บคลังคงเหลือ เบิกเข้า Job ได้เลย · "Purchasing" = ต้องออก PR/PO ทุกครั้ง' },
  { key: 'คลังคงเหลือ', width: 12, note: 'ยอดที่ต้องการให้เป็น (ไม่ใช่ยอดที่จะบวกเพิ่ม) · เว้นว่าง = ไม่แตะยอด · แก้ยอดต้องใส่เหตุผลตอนนำเข้า', num: 'int' },
  { key: 'Lot No.', width: 18, note: 'ล็อตของของที่อยู่ในคลังตอนนี้ · เว้นว่าง = คงค่าเดิม (ล้างล็อตต้องใช้ปุ่ม 🏷 Lot บนหน้าเว็บ)' },
]
/** ชื่อชีตข้อมูล — 'Accessory Catalog' คือชื่อเดิมก่อน 2026-09-09 ต้องยังอ่านได้ */
const CATALOG_SHEET = 'ฐานข้อมูลวัสดุ'
const CATALOG_SHEET_ALIASES = [CATALOG_SHEET, 'Accessory Catalog']

/** ชีต "คลังคงเหลือ" — อ่านอย่างเดียว (ยอด/ต้นทุน/มูลค่า) ⇒ ใส่แถวรวมได้ */
const STOCK_COLS: ReportCol[] = [
  { key: 'รหัส Epicor', width: 14, note: 'รหัสอ้างอิงระบบ ERP' },
  { key: 'ชื่ออุปกรณ์', width: 32, note: 'ชื่อในฐานข้อมูลวัสดุ' },
  { key: 'หน่วย', width: 9, note: 'หน่วยนับ' },
  { key: 'Lot No.', width: 18, note: 'ล็อตของของที่อยู่ในคลังตอนนี้ = ล็อตล่าสุดที่รับเข้า' },
  { key: 'คงเหลือ', width: 12, note: 'ยอดที่เบิกเข้า Job ได้ทันที — ตัดยอดตอน Job "ดึงของจากคลัง" ไม่ใช่ตอนเบิกให้ Service', num: 'int', total: true },
  { key: 'ต้นทุนถัวเฉลี่ย', width: 16, note: 'moving average ต่อหน่วย — ใช้ตีราคาตอนเบิกเข้า Job', num: 'money' },
  { key: 'มูลค่า', width: 16, note: 'คงเหลือ × ต้นทุนถัวเฉลี่ย', num: 'money', total: true },
  { key: 'การจัดหา', width: 14, note: '"เก็บคลังคงเหลือ" หรือ "สั่งซื้อเท่านั้น" (ของที่ยังมียอดค้างจะโชว์ที่นี่ด้วยแม้ตั้งเป็นสั่งซื้อ)' },
  { key: 'เคลื่อนไหวล่าสุด', width: 16, note: 'วันที่มีรายการเข้า/ออกล่าสุดในบัญชีเดินสะพัด' },
  { key: 'จำนวนรายการเคลื่อนไหว', width: 20, note: 'จำนวนแถวในประวัติการเคลื่อนไหวทั้งหมดของวัสดุนี้', num: 'int', total: true },
]

/** สัดส่วน % แบบปลอดหารศูนย์ */
const pctOf = (part: number, whole: number): Cell => (whole > 0 ? (part / whole) * 100 : '-')
const PCT: NumKind = 'pct'

interface ImportRow {
  epicorCode: string; name: string; uom: string
  supply?: boolean           // การจัดหา: true = เก็บคลังคงเหลือ · false = Purchasing เท่านั้น
  stockQty?: number          // คลังคงเหลือที่ต้องการให้เป็น (undefined = ไม่แตะยอด)
  curQty?: number            // ยอดปัจจุบัน (ใช้โชว์ diff ใน preview)
  lotNo?: string             // Lot No. ที่จะตั้ง (0055 · undefined/ว่าง = คงค่าเดิม ไม่ล้าง)
  curLot?: string            // Lot No. ปัจจุบัน (ใช้โชว์ diff ใน preview)
  action: 'create' | 'update' | 'unchanged' | 'error'
  error?: string
  itemId?: string
}

// อ่านค่าจากหัวตารางหลายรูปแบบ (ไทยตามไฟล์ export / อังกฤษ)
function cell(row: Record<string, unknown>, keys: string[]): string {
  for (const [k, v] of Object.entries(row)) {
    if (keys.some(key => k.trim().toLowerCase() === key.toLowerCase()))
      return String(v ?? '').trim()
  }
  return ''
}

// การจัดหา: รับได้ทั้งไทย/อังกฤษ — คลังสินค้า|คลังคงเหลือ|stock|central = เก็บสต็อก · purchasing|สั่งซื้อ = ซื้อเท่านั้น
function parseSupply(v: string): boolean | undefined {
  const t = v.trim().toLowerCase()
  if (!t) return undefined
  if (/คลัง|stock|central/.test(t)) return true
  if (/purchas|สั่งซื้อ|จัดซื้อ/.test(t)) return false
  return undefined
}

function parseImportRows(
  rows: Record<string, unknown>[], items: Item[],
  stockOf: (id: string) => number, lotOf: (id: string) => string | undefined,
): ImportRow[] {
  const seen = new Set<string>()   // กันรหัส Epicor ซ้ำกันเองในไฟล์
  return rows.map(raw => {
    const epicorCode = cell(raw, ['รหัส Epicor', 'epicor', 'epicor_code', 'epicor code', 'รหัส', 'code'])
    const name = cell(raw, ['ชื่ออุปกรณ์', 'ชื่อ', 'name'])
    const uom = cell(raw, ['หน่วย', 'uom'])
    const supply = parseSupply(cell(raw, ['การจัดหา', 'supply', 'source']))
    const qtyRaw = cell(raw, ['คลังคงเหลือ', 'คงเหลือ', 'qty', 'qty_on_hand', 'stock'])
    const qtyNum = qtyRaw === '' ? undefined : Number(qtyRaw)
    // ช่องว่าง = คงค่าเดิม (กติกาเดียวกับไฟล์ Import ของ Project Stock) — ล้าง Lot ต้องทำบนหน้าเว็บ
    const lotNo = cell(raw, ['Lot No.', 'lot no.', 'lot no', 'lot', 'ล็อต', 'lot_no']) || undefined
    const base: Omit<ImportRow, 'action'> = { epicorCode, name, uom, supply, stockQty: qtyNum, lotNo }
    if (!epicorCode) return { ...base, action: 'error' as const, error: 'ไม่มีรหัส Epicor' }
    if (!name) return { ...base, action: 'error' as const, error: 'ไม่มีชื่ออุปกรณ์' }
    if (qtyNum !== undefined && (Number.isNaN(qtyNum) || qtyNum < 0))
      return { ...base, action: 'error' as const, error: `คลังคงเหลือ "${qtyRaw}" ไม่ใช่ตัวเลขที่ใช้ได้` }
    if (qtyNum !== undefined && qtyNum > 0 && supply === false)
      return { ...base, action: 'error' as const, error: 'มียอดคงเหลือ แต่การจัดหาเป็น Purchasing — เลือกให้ตรงกัน' }
    if (lotNo !== undefined && supply === false)
      return { ...base, action: 'error' as const, error: 'กรอก Lot No. แต่การจัดหาเป็น Purchasing — วัสดุที่ไม่เก็บคลังไม่มีล็อต' }
    const key = epicorCode.toLowerCase()
    if (seen.has(key)) return { ...base, action: 'error' as const, error: `รหัส Epicor "${epicorCode}" ซ้ำในไฟล์` }
    seen.add(key)
    const existing = items.find(i => (i.epicorCode ?? '').toLowerCase() === key)
    if (!existing) {
      // Lot No. ผูกกับ "ของที่เข้าคลัง" — สร้างวัสดุใหม่แบบยอด 0 แล้วใส่ล็อตไว้เฉยๆ ไม่มีความหมาย
      // เตือนที่นี่แทนที่จะรับแล้วเงียบ (แบบเดียวกับ error "กรอกระยะขนส่งแต่ไม่กรอก FOB" ของ Project Stock)
      if (lotNo !== undefined && (qtyNum ?? 0) <= 0)
        return { ...base, action: 'error' as const, error: 'กรอก Lot No. แต่ไม่มียอดคงเหลือ — ล็อตตั้งได้เมื่อมีของเข้าคลัง' }
      return { ...base, action: 'create' as const }
    }
    if (existing.itemType === 'main_equipment')
      return { ...base, action: 'error' as const, error: 'เป็น LBS หลัก แก้จากไฟล์ไม่ได้' }
    const curQty = stockOf(existing.id)
    const curLot = lotOf(existing.id)
    const changed = existing.name !== name
      || (uom !== '' && existing.uom !== uom)
      || (supply !== undefined && supply !== existing.stockableCentrally)
      || (qtyNum !== undefined && qtyNum !== curQty)
      || (lotNo !== undefined && lotNo !== curLot)
    return { ...base, curQty, curLot, action: changed ? 'update' as const : 'unchanged' as const, itemId: existing.id }
  })
}

export default function MasterDataPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { ask: askPrompt, element: promptEl } = usePrompt()
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  const { show } = useToast()
  // 0061 — ฐานข้อมูลวัสดุเป็นของ Purchasing + Manage · ยอดคลังคงเหลือเป็นของ Division + Purchasing + Manage
  const canMaster = can(user, 'material.manage')
  const canStock = can(user, 'accessoryStock.manage')
  // สิทธิ์ดาวน์โหลดรายงานผู้บริหาร (ไฟล์พาต้นทุน/มูลค่าคลังออกนอกระบบ) — ไม่มีสิทธิ์ = ไม่เห็นปุ่ม
  const canReport = can(user, 'report.exec')
  const fileRef = useRef<HTMLInputElement>(null)
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [importReason, setImportReason] = useState('')            // เหตุผลตอนนำเข้าที่กระทบยอดคลัง (S3)
  const [ledgerItem, setLedgerItem] = useState<Item | null>(null)  // ดูประวัติการเคลื่อนไหว (S2)
  const [showCatalog, setShowCatalog] = useState(false)   // เริ่มต้นซ่อนตาราง (กดแสดงเอง)
  const [showStock, setShowStock] = useState(false)       // คลังคงเหลือ — เริ่มต้นซ่อนเช่นกัน
  const [search, setSearch] = useState('')                // ค้นหาวัสดุทั้งหน้า (ชื่อ / รหัส Epicor / Lot)

  // ---- item modal state ----
  const [itemModal, setItemModal] = useState<'create' | 'edit' | null>(null)
  const [itemTarget, setItemTarget] = useState<Item | null>(null)
  const [itemForm, setItemForm] = useState({ epicorCode: '', name: '', uom: 'ชิ้น', stockableCentrally: false, initialQty: 0, initialUnitCost: '', initialLot: '' })

  const accessoriesAll = db.items.filter(i => i.itemType === 'accessory')
  const stockQty = (itemId: string) => db.accessoryStock.find(r => r.itemId === itemId)?.qtyOnHand ?? 0
  const stockCost = (itemId: string) => db.accessoryStock.find(r => r.itemId === itemId)?.avgUnitCost ?? 0
  // Lot No. ของของที่อยู่ในคลังตอนนี้ (0055) — ล็อตล่าสุดที่รับเข้า
  const stockLot = (itemId: string) => db.accessoryStock.find(r => r.itemId === itemId)?.lotNo
  // คลังคงเหลือ = วัสดุที่ตั้งให้เก็บสต็อก หรือมีของค้างอยู่จริง (S2)
  const stockItemsAll = accessoriesAll.filter(i => i.stockableCentrally || stockQty(i.id) > 0)
  const stockTotalValue = stockItemsAll.reduce((s, i) => s + stockQty(i.id) * stockCost(i.id), 0)

  /**
   * ค้นหาวัสดุ (2026-09-09) — ชื่ออุปกรณ์ / รหัส Epicor / Lot No.
   *   คลังโตขึ้นเรื่อย ๆ จนกวาดตาหาไม่ทัน · เดิมต้องกด Ctrl+F ของเบราว์เซอร์ซึ่งหาได้เฉพาะแถวที่กางอยู่
   *
   * ⚠️ คำค้นเป็น **ระดับหน้า** ไม่ใช่ของพาเนลคลังคงเหลืออย่างเดียว (แก้ 2026-09-09 รอบที่ 2)
   *   เดิมช่องค้นหาอยู่ในหัวพาเนลคลังคงเหลือและกรองแค่พาเนลนั้น ส่วนไฟล์ Export ครอบทั้งระบบเสมอ
   *   ⇒ ค้นแล้วกด Export ได้ไฟล์ที่ไม่เกี่ยวกับสิ่งที่ค้น และไฟล์ยัง "ครึ่งกรอง" ไม่ได้ (ชีตหนึ่งกรอง
   *     อีกชีตไม่กรอง) · ตอนนี้กติกาเดียวทั้งหน้า: **ไฟล์ = สิ่งที่เห็นบนจอ** เหมือนแท็บ "วัสดุตาม Job"
   */
  const term = search.trim().toLowerCase()
  const matchesTerm = (i: Item) =>
    [i.name, i.epicorCode, i.code, stockLot(i.id)].some(v => v?.toLowerCase().includes(term))
  const accessories = term ? accessoriesAll.filter(matchesTerm) : accessoriesAll
  const stockItems = term ? stockItemsAll.filter(matchesTerm) : stockItemsAll
  const stockFoundValue = stockItems.reduce((s, i) => s + stockQty(i.id) * stockCost(i.id), 0)
  /** มูลค่าคลังในขอบเขตของไฟล์/ตารางตอนนี้ — ใช้เป็นตัวหารของ % ให้ผลรวมในไฟล์เป็น 100 */
  const stockScopeValue = term ? stockFoundValue : stockTotalValue
  // พิมพ์คำค้นแล้วตารางกางเอง — ไม่ต้องกด "แสดงรายการ" อีกทีถึงจะเห็นผลค้นหา
  const stockOpen = showStock || term !== ''
  const catalogOpen = showCatalog || term !== ''
  /** ไม่มีอะไรอยู่ในขอบเขตเลย = ไม่มีอะไรให้ export (ปุ่มเป็น disabled แบบเดียวกับแท็บวัสดุตาม Job) */
  const nothingInScope = accessories.length === 0 && stockItems.length === 0
  const movementsOf = (itemId: string) => db.stockMovements
    .filter(m => m.itemId === itemId)
    .slice().sort((a, b) => b.performedAt.localeCompare(a.performedAt))
  const jobNoOf = (id: string) => db.jobs.find(j => j.id === id)?.jobNo ?? '-'
  const userNameOf = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  const openCreateItem = () => { setItemForm({ epicorCode: '', name: '', uom: 'ชิ้น', stockableCentrally: false, initialQty: 0, initialUnitCost: '', initialLot: '' }); setItemTarget(null); setItemModal('create') }
  const openEditItem = (i: Item) => { setItemForm({ epicorCode: i.epicorCode ?? '', name: i.name, uom: i.uom, stockableCentrally: i.stockableCentrally, initialQty: 0, initialUnitCost: '', initialLot: '' }); setItemTarget(i); setItemModal('edit') }
  const submitItem = async () => {
    // ใช้ "รหัส Epicor" เป็นตัวระบุหลัก — code (schema เดิม) set = epicorCode เบื้องหลัง
    const epicorCode = itemForm.epicorCode.trim()
    if (!epicorCode) return show('กรุณาระบุรหัส Epicor', true)
    const ok = itemModal === 'create'
      ? await tryAction(() => act.createItem({ code: epicorCode, epicorCode, name: itemForm.name, uom: itemForm.uom, stockableCentrally: itemForm.stockableCentrally, initialQty: itemForm.initialQty, initialUnitCost: itemForm.initialUnitCost.trim() === '' ? undefined : Number(itemForm.initialUnitCost), initialLot: itemForm.initialLot.trim() || undefined }), 'เพิ่ม Accessory แล้ว')
      : await tryAction(() => act.updateItem({ itemId: itemTarget!.id, code: itemTarget!.code, epicorCode, name: itemForm.name, uom: itemForm.uom, stockableCentrally: itemForm.stockableCentrally }), 'บันทึกแล้ว')
    if (ok) setItemModal(null)
  }

  // ---------------- Excel export / import ----------------

  // โหลด xlsx แบบ dynamic — ไม่ให้ bundle หลักบวมจาก SheetJS (~430 kB)
  //   ชีต 1 "สรุปผู้บริหาร" · ชีต 2 "ฐานข้อมูลวัสดุ" (Import กลับได้) · ชีต 3 "คลังคงเหลือ" · ชีต 4 "คำอธิบาย"
  //
  //   **ไฟล์ตามคำค้นบนหน้าจอ** (เปลี่ยนกติกา 2026-09-09 รอบที่ 2 ตามที่ผู้ใช้ยืนยัน)
  //   เดิมครอบทั้งระบบเสมอด้วยเหตุผลว่าชีต "ฐานข้อมูลวัสดุ" import กลับได้ แล้วไฟล์ที่ถูกกรอง
  //   จะดูเหมือน "ของหาย" — ข้อกังวลนั้นเป็นเรื่อง**การอ่านไฟล์** ไม่ใช่ข้อมูลหายจริง เพราะ
  //   ⚠️ **Import เป็น upsert ล้วน ไม่มีทางลบ** (runImport มีแต่ createItem/updateItem ไม่มี deleteItem)
  //      อัปไฟล์ที่กรองแล้วกลับเข้าระบบ = อัปเดตเฉพาะแถวในไฟล์ · รายการที่ไม่อยู่ในไฟล์ไม่ถูกแตะ
  //   ⇒ แก้ที่ "การอ่านไฟล์" แทน: ชีตสรุปเขียนขอบเขต + คำเตือนคำค้นไว้บนสุด และชีตคำอธิบาย
  //      ย้ำว่า import ไม่ลบอะไร · กันคนเอาไฟล์ที่กรองแล้วไปอ้างเป็นยอดรวมองค์กร
  const exportExcel = async () => {
    const XLSX = await import('xlsx')
    const catalogRows: Record<string, Cell>[] = accessories.map(i => ({
      'รหัส Epicor': i.epicorCode ?? '',
      'ชื่ออุปกรณ์': i.name,
      'หน่วย': i.uom,
      'การจัดหา': i.stockableCentrally ? 'คลังสินค้า' : 'Purchasing',
      'คลังคงเหลือ': i.stockableCentrally ? stockQty(i.id) : '',
      'Lot No.': i.stockableCentrally ? (stockLot(i.id) ?? '') : '',
    }))
    // ชีตนี้ Import กลับได้ → **ห้ามใส่แถวรวม** (sheet_to_json จะอ่านแถวรวมเป็นวัสดุอีกรายการ)
    const wsCatalog = dataSheet(XLSX, catalogRows, CATALOG_COLS)

    // ---- ชีตคลังคงเหลือ (อ่านอย่างเดียว) ----
    const lastMoveOf = (itemId: string) => movementsOf(itemId)[0]?.performedAt
    const moveCountOf = (itemId: string) => db.stockMovements.filter(m => m.itemId === itemId).length
    const stockRows: Record<string, Cell>[] = stockItems.map(i => {
      const qty = stockQty(i.id)
      const avg = stockCost(i.id)
      const last = lastMoveOf(i.id)
      return {
        'รหัส Epicor': i.epicorCode || '',
        'ชื่ออุปกรณ์': i.name,
        'หน่วย': i.uom,
        'Lot No.': stockLot(i.id) ?? '',
        'คงเหลือ': qty,
        'ต้นทุนถัวเฉลี่ย': avg > 0 ? avg : '',
        'มูลค่า': avg > 0 ? qty * avg : '',
        'การจัดหา': i.stockableCentrally ? 'เก็บคลังคงเหลือ' : 'สั่งซื้อเท่านั้น (มียอดค้าง)',
        'เคลื่อนไหวล่าสุด': last ? last.slice(0, 10) : '',
        'จำนวนรายการเคลื่อนไหว': moveCountOf(i.id),
      }
    })
    const wsStock = dataSheet(XLSX, stockRows, STOCK_COLS, {
      totalRow: true, totalLabel: `รวม ${stockRows.length} รายการ`,
    })

    // ---------------- ชีต "สรุปผู้บริหาร" ----------------
    const stockable = accessories.filter(i => i.stockableCentrally)
    const purchaseOnly = accessories.filter(i => !i.stockableCentrally)
    const inStock = stockItems.filter(i => stockQty(i.id) > 0)
    const outOfStock = stockItems.filter(i => stockQty(i.id) === 0)
    const noCost = inStock.filter(i => stockCost(i.id) <= 0)
    const noLot = inStock.filter(i => !stockLot(i.id))
    const noEpicor = accessories.filter(i => !i.epicorCode)

    // การเคลื่อนไหว 30 วันล่าสุด — ตอบว่าคลังนี้ "ยังมีชีวิต" แค่ไหน
    // กรองตามขอบเขตของไฟล์ด้วย ไม่งั้นตารางนี้จะขัดกับ scope ที่เขียนไว้หัวชีต
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString()
    const scopeIds = new Set([...accessories, ...stockItems].map(i => i.id))
    const recent = db.stockMovements
      .filter(m => m.performedAt >= cutoff && (!term || scopeIds.has(m.itemId)))
    const byType = new Map<string, { lines: number; inQty: number; outQty: number }>()
    recent.forEach(m => {
      const key = MOVEMENT_LABEL[m.type] ?? m.type
      const g = byType.get(key) ?? { lines: 0, inQty: 0, outQty: 0 }
      g.lines += 1
      if (m.qty > 0) g.inQty += m.qty
      else g.outQty += -m.qty
      byType.set(key, g)
    })

    const topValue = inStock
      .map(i => ({ i, qty: stockQty(i.id), avg: stockCost(i.id), value: stockQty(i.id) * stockCost(i.id) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)

    const tables: SumTable[] = [
      {
        title: `Top 10 มูลค่าคลังคงเหลือ — เงินจมอยู่ที่ของอะไร${term ? ' (ในขอบเขตคำค้น)' : ''}`,
        head: ['รหัส Epicor', 'ชื่ออุปกรณ์', 'คงเหลือ', 'หน่วย', 'ต้นทุนถัวเฉลี่ย (บาท)', 'มูลค่า (บาท)',
          term ? 'สัดส่วนของมูลค่าในขอบเขตนี้' : 'สัดส่วนของมูลค่าคลัง'],
        rows: topValue.map(t => [
          t.i.epicorCode || '-', t.i.name, t.qty, t.i.uom, t.avg, t.value, pctOf(t.value, stockScopeValue),
        ]),
        num: { 2: 'int', 4: 'money', 5: 'money0', 6: PCT },
        empty: '(ยังไม่มีวัสดุที่มีของอยู่ในคลัง)',
      },
      {
        title: 'ของหมดคลัง — ตั้งให้เก็บคลังคงเหลือ แต่ยอดเป็น 0',
        head: ['รหัส Epicor', 'ชื่ออุปกรณ์', 'หน่วย', 'เคลื่อนไหวล่าสุด'],
        rows: outOfStock.map(i => [i.epicorCode || '-', i.name, i.uom, lastMoveOf(i.id)?.slice(0, 10) ?? 'ยังไม่เคยมีของ']),
        empty: '(มีของครบทุกรายการที่ตั้งให้เก็บคลัง)',
      },
      {
        title: 'การเคลื่อนไหว 30 วันล่าสุด แบ่งตามประเภท',
        head: ['ประเภทรายการ', 'จำนวนรายการ', 'ปริมาณเข้าคลัง', 'ปริมาณออกจากคลัง'],
        rows: [...byType.entries()]
          .sort((a, b) => b[1].lines - a[1].lines)
          .map(([k, g]) => [k, g.lines, g.inQty, g.outQty]),
        num: { 1: 'int', 2: 'int', 3: 'int' },
        total: [
          `รวม ${recent.length} รายการ`, recent.length,
          recent.filter(m => m.qty > 0).reduce((n, m) => n + m.qty, 0),
          recent.filter(m => m.qty < 0).reduce((n, m) => n - m.qty, 0),
        ],
        empty: '(ไม่มีการเคลื่อนไหวใน 30 วันที่ผ่านมา)',
      },
    ]

    const wsSum = summarySheet(XLSX, {
      title: 'รายงานผู้บริหาร — Material Database (ฐานข้อมูลวัสดุ + คลังคงเหลือ)',
      scope: term
        ? `เฉพาะวัสดุที่ตรงคำค้น "${search.trim()}" — ฐานข้อมูลวัสดุ ${accessories.length}/${accessoriesAll.length} รายการ · คลังคงเหลือ ${stockItems.length}/${stockItemsAll.length} รายการ`
        : 'วัสดุทั้งระบบ',
      meta: [
        ['ขอบเขต', `ฐานข้อมูลวัสดุ ${accessories.length} รายการ · คลังคงเหลือ ${stockItems.length} รายการ`],
        ...stampMeta(user, user ? DEPT_LABEL[user.department] : undefined),
      ],
      warnings: [
        // คำเตือนคำค้นต้องเป็นข้อแรกเสมอ — คนที่รับไฟล์ต่อไม่ได้เห็นหน้าจอตอนกด Export
        ...(term
          ? [
            `ไฟล์นี้ถูกกรองด้วยคำค้น "${search.trim()}" — ไม่ใช่วัสดุทั้งหมดในระบบ ห้ามใช้เป็นยอดรวมองค์กร (ทั้งระบบ: ฐานข้อมูลวัสดุ ${accessoriesAll.length} รายการ · คลังคงเหลือ ${stockItemsAll.length} รายการ · มูลค่า ${stockTotalValue.toLocaleString('th-TH')} บาท)`,
            `ชีต "${CATALOG_SHEET}" มีเฉพาะรายการที่ตรงคำค้น — อัปกลับเข้าระบบได้ตามปกติ จะอัปเดตเฉพาะรายการในไฟล์ **ไม่ลบ**รายการอื่นที่ไม่อยู่ในไฟล์`,
          ]
          : []),
        ...(noCost.length > 0
          ? [`มี ${noCost.length} รายการที่มีของแต่ไม่มีต้นทุนถัวเฉลี่ย — มูลค่าคลังรวมต่ำกว่าความจริง`]
          : []),
        ...(noEpicor.length > 0
          ? [`มี ${noEpicor.length} รายการที่ยังไม่มีรหัส Epicor — จะกระทบยอดกับ ERP ไม่ได้`]
          : []),
      ],
      kpis: [
        { label: term ? 'วัสดุที่ตรงคำค้น (ฐานข้อมูลวัสดุ)' : 'วัสดุในฐานข้อมูลทั้งหมด',
          value: accessories.length, unit: 'รายการ', num: 'int',
          note: term ? `จากทั้งระบบ ${accessoriesAll.length} รายการ` : undefined },
        { label: 'ตั้งให้เก็บคลังคงเหลือ', value: stockable.length, unit: 'รายการ', num: 'int',
          note: 'เบิกเข้า Job ได้ทันทีไม่ต้องออก PR' },
        { label: 'สั่งซื้อเท่านั้น (Purchasing)', value: purchaseOnly.length, unit: 'รายการ', num: 'int',
          note: 'ต้องออก PR/PO ทุกครั้งที่ใช้' },
        { label: 'รายการในคลังคงเหลือ', value: stockItems.length, unit: 'รายการ', num: 'int',
          note: term ? `จากทั้งคลัง ${stockItemsAll.length} รายการ` : 'ตั้งให้เก็บคลัง หรือมีของค้างอยู่จริง' },
        { label: 'มีของอยู่จริง (ยอด > 0)', value: inStock.length, unit: 'รายการ', num: 'int' },
        { label: 'ของหมดคลัง (ยอด = 0)', value: outOfStock.length, unit: 'รายการ', num: 'int',
          note: outOfStock.length > 0 ? 'ดูรายชื่อในตาราง "ของหมดคลัง" ด้านล่าง' : 'มีของครบทุกรายการ' },
        { label: term ? 'มูลค่าคลังคงเหลือ (ในขอบเขตคำค้น)' : 'มูลค่าคลังคงเหลือรวม',
          value: stockScopeValue, unit: 'บาท', num: 'money0',
          note: term
            ? `Σ (คงเหลือ × ต้นทุนถัวเฉลี่ย) · ทั้งคลัง ${stockTotalValue.toLocaleString('th-TH')} บาท`
            : 'Σ (คงเหลือ × ต้นทุนถัวเฉลี่ย)' },
        { label: 'รายการที่ยังไม่มีต้นทุนถัวเฉลี่ย', value: noCost.length, unit: 'รายการ', num: 'int',
          note: noCost.length > 0 ? 'กรอกต้นทุนตอนปรับยอดขาเข้า (ช่อง "ต้นทุนต่อหน่วย")' : 'ครบทุกรายการ' },
        { label: 'รายการที่ยังไม่ระบุ Lot No.', value: noLot.length, unit: 'รายการ', num: 'int',
          note: 'ตามล็อตย้อนหลังไม่ได้ถ้าไม่กรอก — ใช้ปุ่ม 🏷 Lot' },
        { label: 'การเคลื่อนไหว 30 วันล่าสุด', value: recent.length, unit: 'รายการ', num: 'int',
          note: term ? 'นับเฉพาะวัสดุในขอบเขตคำค้น' : undefined },
      ],
      tables,
      notes: [
        ...(term
          ? [`ไฟล์นี้เป็นมุมมองที่กรองแล้ว (คำค้น "${search.trim()}") — ทุกตัวเลขในไฟล์นับเฉพาะวัสดุที่ตรงคำค้น · ต้องการยอดทั้งระบบให้ล้างคำค้นแล้ว Export ใหม่`]
          : []),
        '⏱️ ยอดคงเหลือตัดตอน Job "ดึงของออกจากคลัง" (เพิ่มวัสดุ → เบิกจากคลังคงเหลือ) — ยอดลดทันทีพร้อมลงบัญชีเดินสะพัด',
        'ขั้น "เบิกให้ Service" เป็นการส่งของที่ Job ถืออยู่แล้วออกไปหน้างาน — **ไม่แตะยอดคลังอีก**',
        'ของที่ใช้ไม่หมดต้องกด "📦 โอนเข้าคลัง" ที่หน้า Job ยอดจึงจะกลับเข้ามา — ไม่กลับเองอัตโนมัติ',
        'ทุกการเปลี่ยนยอดมีแถวในบัญชีเดินสะพัด (ledger) + Audit Log — ยอดกระโดดโดยไม่มีรายการเป็นไปไม่ได้',
        'ต้นทุนถัวเฉลี่ยเป็น moving average — ของล็อตใหม่ราคาต่างจะเฉลี่ยเข้าไป ไม่ใช่ FIFO',
        `ชีต "${CATALOG_SHEET}" นำกลับเข้าระบบได้ด้วยปุ่ม ⬆ Import Excel · ชีต "คลังคงเหลือ" อ่านอย่างเดียว (มีแถวรวม)`,
      ],
    })

    const wsGuide = guideSheet(
      XLSX,
      [
        ['Material Database — ฐานข้อมูลวัสดุ + คลังคงเหลือ'],
        [`ออกจากระบบเมื่อ ${fmtDateTime(new Date().toISOString())}`],
        [`ฐานข้อมูลวัสดุ ${accessories.length} รายการ · คลังคงเหลือ ${stockItems.length} รายการ · มูลค่ารวม ${stockScopeValue.toLocaleString('th-TH')} บาท`],
        ...(term
          ? [
            [`⚠️ ไฟล์นี้กรองด้วยคำค้น "${search.trim()}" — ไม่ใช่วัสดุทั้งหมดในระบบ`],
            [`⚠️ อัปชีต "${CATALOG_SHEET}" กลับเข้าระบบได้ตามปกติ: อัปเดตเฉพาะรายการในไฟล์ ไม่ลบรายการอื่น`],
          ]
          : []),
        [],
        [`ชีต "${CATALOG_SHEET}" — Import กลับได้`],
      ],
      CATALOG_COLS,
      [
        `แก้ไขแล้วอัปกลับได้เฉพาะชีต "${CATALOG_SHEET}" · ห้ามย้าย/ลบแถวหัวตาราง และห้ามเพิ่มแถวรวมในชีตนั้น`,
        'Import เป็น upsert เท่านั้น — รายการที่ไม่อยู่ในไฟล์จะไม่ถูกแตะและไม่ถูกลบ (ลบวัสดุทำได้บนหน้าเว็บทางเดียว)',
        'ช่องที่เว้นว่าง = คงค่าเดิมในระบบ (ไม่ล้างค่า) — ล้าง Lot No. ต้องใช้ปุ่ม 🏷 Lot บนหน้าเว็บ',
        'แถวที่รหัส Epicor ตรงกับของเดิม = อัพเดทรายการนั้น · รหัสใหม่ = สร้างวัสดุใหม่',
        'แถวที่เปลี่ยน "คลังคงเหลือ" ต้องระบุเหตุผลก่อนนำเข้า — ทุกการปรับยอดลงบัญชีเดินสะพัด + Audit Log',
        'มียอดคงเหลือ แต่ตั้งการจัดหาเป็น Purchasing = ระบบขึ้น error ไม่ให้นำเข้า (เลือกให้ตรงกัน)',
        `ชีต "${SHEET_SUMMARY}" · "คลังคงเหลือ" · ชีตนี้ เป็นชีตอ่านอย่างเดียว — ระบบข้ามให้เองตอน Import ไม่ต้องลบก่อนอัปไฟล์`,
      ],
    )

    // ชีตคลังคงเหลือมีคำอธิบายคอลัมน์ชุดของตัวเอง — ต่อท้ายชีตคำอธิบายเดียวกันจะปนกัน
    // จึงใส่เป็นชีตคำอธิบายแยกของคลังคงเหลือ (คนอ่านสองชีตนั้นเป็นคนละกลุ่มกัน)
    const wsGuideStock = guideSheet(
      XLSX,
      [['คลังคงเหลือ — ของที่มีอยู่จริง เบิกเข้า Job ได้ทันที'], ['ชีตนี้อ่านอย่างเดียว · Import กลับไม่ได้']],
      STOCK_COLS,
      [
        'แถวสุดท้ายเป็นแถวรวม — autofilter ไม่คลุมแถวนั้น กรองแล้วยอดรวมไม่หาย',
        'รายการที่ "การจัดหา = สั่งซื้อเท่านั้น" แต่ยังโผล่ในชีตนี้ = มีของค้างจากการโอนคืนจาก Job',
        'มูลค่าเว้นว่าง = ยังไม่มีต้นทุนถัวเฉลี่ย ไม่ใช่มูลค่าเป็นศูนย์',
      ],
    )

    const wb = buildWorkbook(XLSX, [
      { name: SHEET_SUMMARY, ws: wsSum },
      { name: CATALOG_SHEET, ws: wsCatalog },
      { name: 'คลังคงเหลือ', ws: wsStock },
      { name: SHEET_GUIDE, ws: wsGuide },
      { name: 'คำอธิบาย-คลังคงเหลือ', ws: wsGuideStock },
    ])
    // ชื่อไฟล์บอกด้วยว่าเป็นมุมมองที่กรองแล้ว — คนรับไฟล์ต่อมักอ่านแต่ชื่อไฟล์ก่อนเปิด
    saveReport(XLSX, wb,
      term ? `รายงานผู้บริหาร-Material-Database-กรอง-${search.trim()}` : 'รายงานผู้บริหาร-Material-Database')
  }

  const onPickFile = async (file: File) => {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer())
      // ⚠️ ตั้งแต่ 2026-09-09 ไฟล์ Export มี 5 ชีต (สรุปผู้บริหาร / ฐานข้อมูลวัสดุ / คลังคงเหลือ / คำอธิบาย ×2)
      //    อ่าน SheetNames[0] ตรง ๆ จะได้ชีตสรุปแล้วขึ้น "ไฟล์ไม่มีข้อมูล" ทั้งที่ไฟล์ถูกต้อง
      //    ชื่อ 'Accessory Catalog' คือชีตข้อมูลของไฟล์รุ่นก่อนหน้า — ต้องยังอ่านได้
      const ws = wb.Sheets[dataSheetName(wb, CATALOG_SHEET_ALIASES)]
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
      if (raw.length === 0) return show('ไฟล์ไม่มีข้อมูล — ต้องมีหัวตาราง: รหัส Epicor, ชื่ออุปกรณ์, หน่วย', true)
      setImportReason('')
      setImportRows(parseImportRows(raw, db.items, stockQty, stockLot))
    } catch {
      show('อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xlsx)', true)
    }
  }

  // จำนวนแถวที่จะกระทบยอดคลัง — ถ้ามี ต้องบังคับใส่เหตุผล (ยอดคลังเปลี่ยนต้องตรวจย้อนหลังได้)
  const qtyChangeRows = (importRows ?? []).filter(r =>
    (r.action === 'create' || r.action === 'update') && r.stockQty !== undefined && r.stockQty !== (r.curQty ?? 0))

  const runImport = async () => {
    if (!importRows) return
    if (qtyChangeRows.length > 0 && !importReason.trim())
      return show('มีแถวที่เปลี่ยนยอดคลังคงเหลือ — ต้องระบุเหตุผลก่อนนำเข้า', true)
    setImporting(true)
    let ok = 0
    let qtyOk = 0
    let lotOk = 0
    const fails: string[] = []
    for (const row of importRows) {
      if (row.action !== 'create' && row.action !== 'update') continue
      try {
        // การจัดหา: ถ้าไฟล์ไม่ระบุ → คงค่าเดิม (สร้างใหม่ = อนุมานจากยอดที่ให้มา)
        const wantStock = row.supply ?? (row.action === 'create' ? (row.stockQty ?? 0) > 0 : undefined)
        let itemId = row.itemId
        if (row.action === 'create') {
          await act.createItem({
            code: row.epicorCode, epicorCode: row.epicorCode, name: row.name,
            uom: row.uom || 'ชิ้น', stockableCentrally: !!wantStock,
            // ยอดเริ่มต้นลง ledger เป็น 'initial' ให้เลย
            initialQty: wantStock ? (row.stockQty ?? 0) : 0,
            initialLot: wantStock ? row.lotNo : undefined,
          })
          ok++
          if (wantStock && (row.stockQty ?? 0) > 0) qtyOk++
          continue
        }
        const existing = db.items.find(i => i.id === row.itemId)!
        itemId = existing.id
        await act.updateItem({
          itemId: existing.id, code: existing.code, epicorCode: row.epicorCode,
          name: row.name, uom: row.uom || existing.uom,
          stockableCentrally: wantStock ?? existing.stockableCentrally,
        })
        ok++
        // ปรับยอดผ่าน action เดิม → ผ่าน ledger + audit เสมอ (ไม่แก้ยอดตรง)
        const qtyChanged = row.stockQty !== undefined && row.stockQty !== (row.curQty ?? 0)
        const lotChanged = row.lotNo !== undefined && row.lotNo !== row.curLot
        if (qtyChanged) {
          await act.adjustAccessoryStock({
            itemId: itemId!, newQty: row.stockQty!,
            note: `นำเข้า Excel: ${importReason.trim()}`,
            // ล็อตติดไปกับ movement ได้เฉพาะขาเข้า — ขาออก/ยอดลดจะตกไปที่ setStockLot ด้านล่าง
            lotNo: lotChanged && row.stockQty! > (row.curQty ?? 0) ? row.lotNo : undefined,
          })
          qtyOk++
        }
        // ล็อตเปลี่ยนแต่ยอดไม่ได้เพิ่ม (ยอดเท่าเดิม/ลดลง) → ตั้งล็อตตรงๆ ไม่ผ่าน ledger
        if (lotChanged && !(qtyChanged && row.stockQty! > (row.curQty ?? 0))) {
          await act.setStockLot({ itemId: itemId!, lotNo: row.lotNo })
          lotOk++
        }
      } catch (e) {
        fails.push(`${row.epicorCode}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setImporting(false)
    setImportRows(null)
    setImportReason('')
    const qtyTxt = (qtyOk > 0 ? ` · ปรับยอดคลัง ${qtyOk} รายการ` : '') + (lotOk > 0 ? ` · ตั้ง Lot No. ${lotOk} รายการ` : '')
    if (fails.length) show(`นำเข้าสำเร็จ ${ok} รายการ${qtyTxt} · ล้มเหลว ${fails.length}: ${fails[0]}${fails.length > 1 ? ' …' : ''}`, true)
    else show(`นำเข้าฐานข้อมูลวัสดุสำเร็จ ${ok} รายการ${qtyTxt}`)
  }

  // เดิมถามด้วย window.prompt ซ้อน 3 ชั้น (ยอด → ต้นทุน → เหตุผล) กด Cancel กลางทางแล้วหลุดทั้งชุด
  // ตอนนี้รวมเป็นฟอร์มเดียว เห็นยอดเดิม/ผลต่างก่อนยืนยัน · ต้นทุนใช้เฉพาะตอนยอดเพิ่ม (ของเข้าคลัง)
  const adjustStock = async (i: Item) => {
    const cur = stockQty(i.id)
    const avg = stockCost(i.id)
    const lot = stockLot(i.id)
    const v = await askPrompt({
      title: `ปรับยอดคงเหลือ — ${i.name}`,
      description: <>ยอดปัจจุบัน <b>{cur} {i.uom}</b>{avg > 0 && <> · ต้นทุนถัวเฉลี่ย {fmtBaht(avg)}</>}{lot && <> · Lot ปัจจุบัน <b className="mono">{lot}</b></>} · ทุกการปรับยอดถูกบันทึกลง ledger และ audit</>,
      fields: [
        { key: 'qty', label: 'ยอดคงเหลือใหม่', type: 'number', min: 0, required: true,
          suffix: i.uom, value: String(cur), hint: 'กรอกยอดที่นับได้จริง ระบบจะคิดผลต่างให้เอง' },
        { key: 'cost', label: 'ต้นทุนต่อหน่วยของของที่เพิ่มเข้ามา', type: 'number', min: 0, suffix: 'บาท',
          value: avg > 0 ? String(avg) : '',
          hint: 'ใช้เฉพาะกรณียอดเพิ่มขึ้น (ของเข้าคลัง) · เว้นว่าง = ต้นทุนถัวเฉลี่ยเดิมไม่เปลี่ยน' },
        // Lot No. (0055) — ผูกกับ "ของที่เข้ามา" เท่านั้น เหมือนต้นทุน
        { key: 'lot', label: 'Lot No. ของของที่เพิ่มเข้ามา', value: '',
          placeholder: 'เช่น LOT-2026-08-A',
          hint: 'ใช้เฉพาะกรณียอดเพิ่มขึ้น (ของเข้าคลัง) · เว้นว่าง = คง Lot No. เดิม · แก้ล็อตอย่างเดียวใช้ปุ่ม 🏷 Lot' },
        { key: 'note', label: 'เหตุผลการปรับยอด', type: 'textarea', required: true,
          placeholder: 'เช่น นับสต็อกประจำเดือน / ของชำรุด / รับเข้าจากหน้างาน' },
      ],
      confirmLabel: 'ปรับยอด',
    })
    if (!v) return
    const qty = Number(v.qty)
    // ยอดเพิ่ม = ของเข้าคลัง → ส่งต้นทุน/ล็อตไปด้วย · ยอดลดไม่ต้องใช้
    const unitCost = qty > cur && v.cost !== '' ? Number(v.cost) : undefined
    const lotNo = qty > cur && v.lot.trim() !== '' ? v.lot.trim() : undefined
    tryAction(() => act.adjustAccessoryStock({ itemId: i.id, newQty: qty, note: v.note, unitCost, lotNo }), 'ปรับยอดแล้ว')
  }

  // แก้ Lot No. อย่างเดียว ไม่แตะยอด (0055) — พิมพ์ผิดแล้วแก้ได้โดยไม่ต้องปรับยอดหลอกๆ
  const editLot = async (i: Item) => {
    const lot = stockLot(i.id)
    const v = await askPrompt({
      title: `Lot No. — ${i.name}`,
      description: <>ล็อตของของที่อยู่ในคลังตอนนี้ · <b>ยอดคงเหลือไม่เปลี่ยน</b> และไม่ลงบัญชีเดินสะพัด (บันทึกใน Audit Log แทน)</>,
      fields: [{ key: 'lot', label: 'Lot No.', value: lot ?? '', placeholder: 'เช่น LOT-2026-08-A',
        hint: 'เว้นว่าง = ล้าง Lot No. ของวัสดุนี้' }],
      confirmLabel: 'บันทึก Lot No.',
    })
    if (!v) return
    tryAction(() => act.setStockLot({ itemId: i.id, lotNo: v.lot.trim() || undefined }), 'บันทึก Lot No. แล้ว')
  }

  return (
    <>
      <div className="page-title">Material Database</div>
      <div className="page-sub">
        แยก 2 ส่วนชัดเจน — <b>ฐานข้อมูลวัสดุ</b> (รายการที่ใช้ตอนออก PR/PO) และ <b>คลังคงเหลือ</b> (ของที่มีอยู่จริง เบิกได้เลย)
        {!canMaster && ' · การเพิ่ม/แก้/ลบ + นำเข้า Excel เป็นสิทธิ์ของ Purchasing และ Manage'}
      </div>

      {/* ค้นหาระดับหน้า — กรองทั้ง 2 พาเนล และไฟล์ Export ตามนี้ (ไฟล์ = สิ่งที่เห็นบนจอ)
          อยู่เหนือทั้ง 2 พาเนลโดยตั้งใจ: ถ้าวางในหัวพาเนลใดพาเนลหนึ่ง คนจะอ่านว่ากรองแค่พาเนลนั้น */}
      <div className="panel">
        <div className="panel-head">
          <h3>ค้นหาวัสดุ</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input style={{ width: 300 }} value={search} onChange={e => setSearch(e.target.value)}
              placeholder="ชื่ออุปกรณ์ / รหัส Epicor / Lot No." />
            {term && <button className="small" onClick={() => setSearch('')} title="ล้างคำค้น">✕ ล้าง</button>}
            <span className="muted">
              {term
                ? <>ฐานข้อมูลวัสดุ <b>{accessories.length}</b>/{accessoriesAll.length} · คลังคงเหลือ <b>{stockItems.length}</b>/{stockItemsAll.length} · มูลค่าที่ตรงคำค้น {fmtBaht(stockFoundValue)} <span className="muted">(ทั้งคลัง {fmtBaht(stockTotalValue)})</span></>
                : <>กรองทั้ง 2 ตารางด้านล่าง · ไฟล์ ⬇ Export จะตามคำค้นนี้ด้วย</>}
            </span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>ฐานข้อมูลวัสดุ ({term ? `${accessories.length}/${accessoriesAll.length}` : accessoriesAll.length})</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="small" onClick={() => setShowCatalog(v => !v)}>
              {catalogOpen ? 'ซ่อนรายการ' : `แสดงรายการ (${accessoriesAll.length})`}
            </button>
            {/* ไฟล์พาต้นทุนถัวเฉลี่ย/มูลค่าคลังออกไปนอกระบบ → ปุ่มหายทั้งปุ่มถ้าไม่มีสิทธิ์ (report.exec) */}
            {canReport && (
              <button className="small" onClick={exportExcel} disabled={nothingInScope}
                title={nothingInScope ? 'ไม่มีรายการให้ export'
                  : term ? `รายงานผู้บริหาร — เฉพาะวัสดุที่ตรงคำค้น "${search.trim()}" (ไฟล์เตือนไว้ในชีตสรุป)`
                  : 'รายงานผู้บริหาร (Excel) — ชีตสรุป + ฐานข้อมูลวัสดุ (Import กลับได้) + คลังคงเหลือ + คำอธิบาย'}>
                ⬇ Export Excel{term ? ` (${accessories.length}+${stockItems.length})` : ''}
              </button>
            )}
            {canMaster && <>
              <button className="small" onClick={() => fileRef.current?.click()}>⬆ Import Excel</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onPickFile(f); e.target.value = '' }} />
              <button className="small primary" onClick={openCreateItem}>+ เพิ่ม Accessory</button>
            </>}
          </div>
        </div>
        {catalogOpen && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>หน่วย</th><th>การจัดหา</th><th></th></tr></thead>
              <tbody>
                {accessories.length === 0 && <tr><td colSpan={5}><div className="empty">
                  {term
                    ? <>ไม่พบวัสดุที่ตรงกับ "<b>{search.trim()}</b>" ในฐานข้อมูลวัสดุ — ลองค้นด้วยรหัส Epicor หรือคำสั้นลง</>
                    : 'ยังไม่มีวัสดุในระบบ'}
                </div></td></tr>}
                {accessories.map(i => (
                  <tr key={i.id}>
                    <td className="mono">{i.epicorCode || '-'}</td>
                    <td>{i.name}</td>
                    <td>{i.uom}</td>
                    <td>{i.stockableCentrally
                      ? <span className="badge green">เก็บคลังคงเหลือ</span>
                      : <span className="badge amber">สั่งซื้อเท่านั้น</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canMaster && <>
                        <button className="small" onClick={() => openEditItem(i)}>แก้ไข</button>{' '}
                        <button className="small danger" onClick={async () => {
                          if (await askConfirm({
                            title: `ลบวัสดุ "${i.name}"`,
                            description: <>
                              รหัส Epicor <b className="mono">{i.epicorCode || i.code}</b> · ลบออกจากฐานข้อมูลวัสดุ
                              จะทำให้เลือกใช้ในการขอวัสดุ/BOM ไม่ได้อีก · <b>ระบบจะไม่ให้ลบถ้าเคยถูกใช้ใน Job หรือมียอดคงเหลือ</b>
                            </>,
                            confirmLabel: 'ลบวัสดุ',
                          })) tryAction(() => act.deleteItem({ itemId: i.id }), 'ลบแล้ว')
                        }}>ลบ</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------------- คลังคงเหลือ (แยกจากฐานข้อมูลวัสดุ — S2) ---------------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>คลังคงเหลือ ({term ? `${stockItems.length}/${stockItemsAll.length}` : stockItemsAll.length})
            <span className="muted" style={{ fontWeight: 400 }}> · ของที่มีอยู่จริง เบิกเข้า Job ได้ทันทีไม่ต้องออก PR</span>
          </h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* ช่องค้นหาย้ายขึ้นไปเป็นระดับหน้าแล้ว (กรองทั้ง 2 พาเนล + ไฟล์ Export) */}
            <span className="muted">
              {term
                ? <>พบ <b>{stockItems.length}</b> รายการ · มูลค่า {fmtBaht(stockFoundValue)} <span className="muted">(ทั้งคลัง {fmtBaht(stockTotalValue)})</span></>
                : <>มูลค่ารวม {fmtBaht(stockTotalValue)}</>}
            </span>
            <button className="small" onClick={() => setShowStock(v => !v)}>
              {stockOpen ? 'ซ่อนรายการ' : `แสดงรายการ (${stockItemsAll.length})`}
            </button>
          </div>
        </div>
        {/* จังหวะตัดยอด — คำถามที่ถูกถามซ้ำ ๆ จึงเขียนไว้ตรงนี้เลย ไม่ให้ต้องเดาหรือไปไล่ ledger
            ตัดตอน Job "ดึงของจากคลัง" ทันที ไม่ใช่ตอน "เบิกให้ Service" (การเบิกไม่แตะยอดคลังเลย) */}
        <div className="panel-body" style={{ paddingTop: 0 }}>
          <div className="muted">
            ⏱️ <b>ยอดคงเหลือตัดตอน Job ดึงของออกจากคลัง</b> — กด “เพิ่มวัสดุ → เบิกจากคลังคงเหลือ”
            ที่หน้า Job แล้วยอดลด<b>ทันที</b> พร้อมลงรายการในประวัติการเคลื่อนไหว ·
            ขั้น <b>“เบิกให้ Service”</b> เป็นการส่งของที่ Job ถืออยู่แล้วออกไปหน้างาน <b>ไม่แตะยอดคลังอีก</b> ·
            ของที่ใช้ไม่หมดต้องกด <b>“📦 โอนเข้าคลัง”</b> ที่หน้า Job ยอดจึงจะกลับเข้ามา
          </div>
        </div>
        {stockOpen && <div className="table-scroll">
          <table>
            <thead>
              <tr><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>Lot No.</th><th>คงเหลือ</th><th>ต้นทุนถัวเฉลี่ย</th><th>มูลค่า</th><th></th></tr>
            </thead>
            <tbody>
              {stockItems.length === 0 && (
                <tr><td colSpan={7}><div className="empty">
                  {term
                    ? <>ไม่พบวัสดุที่ตรงกับ "<b>{search.trim()}</b>" ในคลังคงเหลือ — ลองค้นด้วยรหัส Epicor
                        หรือคำสั้นลง · วัสดุที่ตั้งเป็น "สั่งซื้อเท่านั้น" และไม่มีของค้าง จะไม่อยู่ในคลังคงเหลือ
                        (ดูที่พาเนลฐานข้อมูลวัสดุด้านบน)</>
                    : <>ยังไม่มีวัสดุในคลังคงเหลือ — ตั้งค่า "การจัดหา = เก็บคลังคงเหลือ" ที่ฐานข้อมูลวัสดุ
                        หรือโอนวัสดุเหลือจาก Job เข้าคลัง</>}
                </div></td></tr>
              )}
              {stockItems.map(i => {
                const qty = stockQty(i.id)
                const avg = stockCost(i.id)
                const lot = stockLot(i.id)
                return (
                  <tr key={i.id}>
                    <td className="mono">{i.epicorCode || '-'}</td>
                    <td>{i.name}</td>
                    <td className="mono">{lot || <span className="muted">-</span>}</td>
                    <td><b>{qty}</b> <span className="muted">{i.uom}</span></td>
                    <td>{avg > 0 ? fmtBaht(avg) : <span className="muted">-</span>}</td>
                    <td>{avg > 0 ? fmtBaht(qty * avg) : <span className="muted">-</span>}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button className="small" style={{ marginRight: 6 }} onClick={() => setLedgerItem(i)}>📜 ประวัติ</button>
                      {canStock && <button className="small" style={{ marginRight: 6 }} title="แก้ Lot No. โดยไม่แตะยอดคงเหลือ" onClick={() => editLot(i)}>🏷 Lot</button>}
                      {canStock && <button className="small" onClick={() => adjustStock(i)}>ปรับยอด</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>}
      </div>

      {/* ประวัติการเคลื่อนไหวของวัสดุ (ledger จาก S1) */}
      {ledgerItem && (
        <Modal title={`ประวัติการเคลื่อนไหว — ${ledgerItem.name}`} onClose={() => setLedgerItem(null)}
          footer={<button onClick={() => setLedgerItem(null)}>ปิด</button>}>
          <p className="muted" style={{ marginBottom: 10 }}>
            คงเหลือปัจจุบัน <b>{stockQty(ledgerItem.id)} {ledgerItem.uom}</b>
            {stockCost(ledgerItem.id) > 0 && <> · ต้นทุนถัวเฉลี่ย {fmtBaht(stockCost(ledgerItem.id))}</>}
            {stockLot(ledgerItem.id) && <> · Lot ปัจจุบัน <b className="mono">{stockLot(ledgerItem.id)}</b></>}
          </p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>เมื่อ</th><th>ประเภท</th><th>เข้า/ออก</th><th>Lot No.</th><th>คงเหลือ</th><th>อ้างอิง</th></tr></thead>
              <tbody>
                {movementsOf(ledgerItem.id).length === 0 && (
                  <tr><td colSpan={6}><div className="empty">ยังไม่มีการเคลื่อนไหว</div></td></tr>
                )}
                {movementsOf(ledgerItem.id).map(m => (
                  <tr key={m.id}>
                    <td className="muted">{fmtDateTime(m.performedAt)}</td>
                    <td><span className="badge neutral">{MOVEMENT_LABEL[m.type] ?? m.type}</span></td>
                    <td style={{ color: m.qty > 0 ? 'var(--green)' : 'var(--danger)', fontWeight: 600 }}>
                      {m.qty > 0 ? '+' : ''}{m.qty} {ledgerItem.uom}
                      {m.unitCost !== undefined && m.unitCost > 0 && (
                        <div className="muted" style={{ fontWeight: 400 }}>@ {fmtBaht(m.unitCost)}</div>
                      )}
                    </td>
                    {/* ขาเข้า = ล็อตที่รับเข้ามา · ขาออก = ล็อตที่อยู่ในคลังตอนนั้น (0055) */}
                    <td className="mono">{m.lotNo || <span className="muted">-</span>}</td>
                    <td>{m.balanceAfter}</td>
                    <td className="muted">
                      {m.refJobId && <div>{jobNoOf(m.refJobId)}</div>}
                      {m.note && <div>{m.note}</div>}
                      <div>{userNameOf(m.performedBy)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {itemModal && (
        <Modal title={itemModal === 'create' ? 'เพิ่ม Accessory' : `แก้ไข ${itemTarget?.name}`} onClose={() => setItemModal(null)}
          footer={<>
            <button onClick={() => setItemModal(null)}>ยกเลิก</button>
            <button className="primary" onClick={submitItem}>บันทึก</button>
          </>}>
          <div className="row">
            <label className="field"><span>รหัส Epicor *</span>
              <input value={itemForm.epicorCode} onChange={e => setItemForm({ ...itemForm, epicorCode: e.target.value })} placeholder="EPC-XXX-01" />
            </label>
            <label className="field"><span>หน่วยนับ</span>
              <input value={itemForm.uom} onChange={e => setItemForm({ ...itemForm, uom: e.target.value })} />
            </label>
          </div>
          <label className="field"><span>ชื่ออุปกรณ์ *</span>
            <input value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} />
          </label>
          <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={itemForm.stockableCentrally}
              onChange={e => setItemForm({ ...itemForm, stockableCentrally: e.target.checked })} />
            <span style={{ margin: 0 }}>เก็บใน<b>คลังคงเหลือ</b> (เบิกเข้า Job ได้เลยไม่ต้องออก PR)</span>
          </label>
          {itemModal === 'create' && itemForm.stockableCentrally && (
            <>
              <div className="row">
                <label className="field"><span>ยอดเริ่มต้นในคลังคงเหลือ</span>
                  <input type="number" min={0} value={itemForm.initialQty}
                    onChange={e => setItemForm({ ...itemForm, initialQty: Number(e.target.value) })} />
                </label>
                <label className="field"><span>ต้นทุนต่อหน่วย (บาท)</span>
                  <input type="number" min={0} value={itemForm.initialUnitCost} placeholder="0"
                    onChange={e => setItemForm({ ...itemForm, initialUnitCost: e.target.value })} />
                </label>
                <label className="field"><span>Lot No.</span>
                  <input className="mono" value={itemForm.initialLot} placeholder="LOT-2026-08-A"
                    onChange={e => setItemForm({ ...itemForm, initialLot: e.target.value })} />
                </label>
              </div>
              <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
                ต้นทุนต่อหน่วยใช้ตั้ง <b>ต้นทุนถัวเฉลี่ย</b> ของคลัง — เวลาเบิกเข้า Job ระบบจะดึงค่านี้ไปตัดต้นทุนงานอัตโนมัติ
                (เว้นว่างได้ แต่มูลค่าคลังจะเป็น 0) · <b>Lot No.</b> ผูกกับของที่รับเข้าล็อตนี้
                (เว้นว่างได้ · แก้ภายหลังที่ปุ่ม 🏷 Lot ในคลังคงเหลือ)
                {itemForm.initialQty <= 0 && itemForm.initialLot.trim() !== '' && (
                  <div style={{ color: 'var(--danger)', marginTop: 4 }}>
                    ⚠️ กรอก Lot No. แต่ยอดเริ่มต้นเป็น 0 — ล็อตจะยังไม่ถูกบันทึก (ล็อตผูกกับของที่เข้าคลังจริง)
                  </div>
                )}
              </div>
            </>
          )}
        </Modal>
      )}

      {importRows && (
        <Modal title="Import Accessory Catalog — ตรวจสอบก่อนยืนยัน" onClose={() => setImportRows(null)}
          footer={<>
            <button onClick={() => setImportRows(null)} disabled={importing}>ยกเลิก</button>
            <button className="primary" disabled={importing || importRows.every(r => r.action === 'unchanged' || r.action === 'error')}
              onClick={runImport}>
              {importing ? 'กำลังนำเข้า…' : `ยืนยันนำเข้า (ใหม่ ${importRows.filter(r => r.action === 'create').length} · อัปเดต ${importRows.filter(r => r.action === 'update').length})`}
            </button>
          </>}>
          <div className="muted" style={{ marginBottom: 10 }}>
            รับคอลัมน์: <b>รหัส Epicor · ชื่ออุปกรณ์ · หน่วย · การจัดหา · คลังคงเหลือ · Lot No.</b> (ครบตามไฟล์ที่ Export ออกไป)
            · รหัสที่มีอยู่แล้ว = อัปเดตทับ · รหัสใหม่ = เพิ่มรายการ
            · การเปลี่ยนยอดคลังจะบันทึกเป็นรายการ "ปรับยอด" ในประวัติการเคลื่อนไหว
            · ช่อง <b>Lot No.</b> เว้นว่าง = คงค่าเดิม (ล้างล็อตต้องใช้ปุ่ม 🏷 Lot บนหน้าเว็บ)
            <br />
            ไฟล์รายงานผู้บริหารมีหลายชีต — ระบบอ่านเฉพาะชีต <b>{CATALOG_SHEET}</b> (ชีตสรุป/คลังคงเหลือ/คำอธิบาย
            ถูกข้ามให้เอง <b>ไม่ต้องลบก่อนอัปไฟล์</b>) · ไฟล์รุ่นก่อนที่ใช้ชีต <b>Accessory Catalog</b> ยังอ่านได้ตามเดิม
          </div>
          {qtyChangeRows.length > 0 && (
            <label className="field">
              <span style={{ color: 'var(--danger)' }}>
                เหตุผลการปรับยอดคลัง * ({qtyChangeRows.length} รายการจะเปลี่ยนยอด)
              </span>
              <input value={importReason} onChange={e => setImportReason(e.target.value)}
                placeholder="เช่น ตรวจนับสต็อกประจำปี 2569 / ยกยอดจากระบบเดิม" />
            </label>
          )}
          <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>ผล</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>หน่วย</th><th>การจัดหา</th><th>คลังคงเหลือ</th><th>Lot No.</th></tr></thead>
              <tbody>
                {importRows.map((r, i) => {
                  const qtyChanged = (r.action === 'create' || r.action === 'update')
                    && r.stockQty !== undefined && r.stockQty !== (r.curQty ?? 0)
                  const lotChanged = (r.action === 'create' || r.action === 'update')
                    && r.lotNo !== undefined && r.lotNo !== r.curLot
                  return (
                    <tr key={i}>
                      <td>
                        {r.action === 'create' && <span className="badge green">เพิ่มใหม่</span>}
                        {r.action === 'update' && <span className="badge blue">อัปเดต</span>}
                        {r.action === 'unchanged' && <span className="badge neutral">ไม่เปลี่ยน</span>}
                        {r.action === 'error' && <span className="badge red" title={r.error}>ข้าม: {r.error}</span>}
                      </td>
                      <td className="mono">{r.epicorCode || '-'}</td>
                      <td>{r.name || '-'}</td>
                      <td>{r.uom || '-'}</td>
                      <td className="muted">
                        {r.supply === undefined ? '(คงเดิม)' : r.supply ? 'เก็บคลังคงเหลือ' : 'สั่งซื้อเท่านั้น'}
                      </td>
                      <td>
                        {r.stockQty === undefined
                          ? <span className="muted">(ไม่แตะ)</span>
                          : qtyChanged
                            ? <b style={{ color: 'var(--primary)' }}>{r.curQty ?? 0} → {r.stockQty}</b>
                            : <span className="muted">{r.stockQty}</span>}
                      </td>
                      <td className="mono">
                        {r.lotNo === undefined
                          ? <span className="muted">(คงเดิม)</span>
                          : lotChanged
                            ? <b style={{ color: 'var(--primary)' }}>{r.curLot || '-'} → {r.lotNo}</b>
                            : <span className="muted">{r.lotNo}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {promptEl}
      {confirmEl}
    </>
  )
}
