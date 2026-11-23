// =============================================================================
// ตัวอ่านไฟล์ Import ของ Material Master — ย้ายออกจาก MasterDataPage (เฟส 4 · 2026-11-23) ให้เทสต์ได้
//   parseImportRows = ไฟล์ฐานข้อมูลวัสดุ (สร้าง/แก้วัสดุ + ตั้งยอดคลัง)
//   parseCountRows  = ไฟล์ตรวจนับคลัง (ยอดนับจริง / ต้นทุนใหม่)
// ผลลัพธ์ใช้ทำหน้า preview — แถวที่ผ่านต้องนำเข้าได้จริง (ไม่ใช่ผ่าน preview แล้วไปพังตอนบันทึก)
// =============================================================================
import type { Item } from '../types'

export interface ImportRow {
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
export function cell(row: Record<string, unknown>, keys: string[]): string {
  for (const [k, v] of Object.entries(row)) {
    if (keys.some(key => k.trim().toLowerCase() === key.toLowerCase()))
      return String(v ?? '').trim()
  }
  return ''
}

// การจัดหา: รับได้ทั้งไทย/อังกฤษ — คลังสินค้า|คลังคงเหลือ|stock|central = เก็บสต็อก · purchasing|สั่งซื้อ = ซื้อเท่านั้น
export function parseSupply(v: string): boolean | undefined {
  const t = v.trim().toLowerCase()
  if (!t) return undefined
  if (/คลัง|stock|central/.test(t)) return true
  if (/purchas|สั่งซื้อ|จัดซื้อ/.test(t)) return false
  return undefined
}

export function parseImportRows(
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
    // 🔴 เฟส 4: ช่องการจัดหาว่าง = ใช้ค่าเดิมของวัสดุ — วัสดุ "สั่งซื้อเท่านั้น" ตั้งยอด/ล็อตไม่ได้
    //   เดิมเช็คแค่ supply === false ⇒ แถวผ่าน preview แล้วไปพังตอนตั้งยอด ("รายการนี้ไม่มีสต็อกกลาง")
    //   หลังแก้ชื่อวัสดุไปแล้วครึ่งทาง
    const effSupply = supply ?? existing.stockableCentrally
    if (!effSupply && qtyNum !== undefined && qtyNum > 0)
      return { ...base, action: 'error' as const, error: 'มียอดคงเหลือ แต่วัสดุนี้เป็น "สั่งซื้อเท่านั้น" — ระบุการจัดหาเป็น "เก็บคลังคงเหลือ" ในไฟล์' }
    if (!effSupply && lotNo !== undefined)
      return { ...base, action: 'error' as const, error: 'กรอก Lot No. แต่วัสดุนี้เป็น "สั่งซื้อเท่านั้น" — ระบุการจัดหาเป็น "เก็บคลังคงเหลือ" ในไฟล์' }
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

export interface CountRow { item: Item; curQty: number; curCost: number; qty?: number; cost?: number }

/**
 * ไฟล์ตรวจนับคลัง — คืนรายการที่ต่างจากระบบ + ข้อผิดพลาดรายแถว
 * 🔴 เฟส 4: วัสดุซ้ำในไฟล์ต้องจับได้แม้แถวแรกจะเท่ากับยอดในระบบ (เดิมแถวแรกถูกข้าม แถวที่สองผ่าน)
 *          LBS หลักไม่ใช่วัสดุคลังคงเหลือ (เดิมจับคู่ได้ทุก item → สร้างแถวคลัง + ตั้ง LBS เป็นเก็บคลัง)
 */
export function parseCountRows(
  raw: Record<string, unknown>[], items: Item[],
  stockQty: (itemId: string) => number, stockCost: (itemId: string) => number,
  cols: { code: string; epicor: string; newQty: string; newCost: string },
): { rows: CountRow[]; errors: string[] } {
  const rows: CountRow[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  raw.forEach((row, idx) => {
    const no = `แถว ${idx + 2}`
    const code = cell(row, [cols.code, 'code'])
    const ep = cell(row, [cols.epicor, 'epicor'])
    const qStr = cell(row, [cols.newQty, 'counted_qty', 'qty'])
    const cStr = cell(row, [cols.newCost, 'unit_cost', 'cost'])
    if (!qStr && !cStr) return                                   // ไม่ได้กรอกอะไร = ไม่แตะ
    const item = (code && items.find(i => i.code === code)) || (ep && items.find(i => i.epicorCode === ep)) || undefined
    if (!item) return void errors.push(`${no}: ไม่พบวัสดุ "${code || ep || '-'}" ในระบบ`)
    if (item.itemType === 'main_equipment')
      return void errors.push(`${no} ${item.name}: เป็น LBS หลัก — นับที่ LBS Inventory ไม่ใช่คลังคงเหลือ`)
    if (seen.has(item.id)) return void errors.push(`${no} ${item.name}: มีซ้ำในไฟล์`)
    seen.add(item.id)
    const qty = qStr === '' ? undefined : Number(qStr)
    const cost = cStr === '' ? undefined : Number(cStr)
    if (qty !== undefined && (!Number.isFinite(qty) || qty < 0)) return void errors.push(`${no} ${item.name}: ยอดนับ "${qStr}" ต้องเป็นตัวเลขไม่ติดลบ`)
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) return void errors.push(`${no} ${item.name}: ต้นทุน "${cStr}" ต้องเป็นตัวเลขไม่ติดลบ`)
    const curQty = stockQty(item.id), curCost = stockCost(item.id)
    const qtyChanged = qty !== undefined && qty !== curQty
    const costChanged = cost !== undefined && Math.abs(cost - curCost) > 0.004 && (qty ?? curQty) > 0
    if (!qtyChanged && !costChanged) return
    rows.push({ item, curQty, curCost, qty: qtyChanged ? qty : undefined, cost: costChanged ? cost : undefined })
  })
  return { rows, errors }
}
