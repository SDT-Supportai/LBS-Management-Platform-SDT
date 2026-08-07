import { useRef, useState } from 'react'
import { useStore, can } from '../data/StoreContext'
import { Modal, useConfirm, usePrompt, useToast, useTryAction } from '../ui/components'
import { fmtBaht, fmtDateTime } from '../ui/format'
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

interface ImportRow {
  epicorCode: string; name: string; uom: string
  supply?: boolean           // การจัดหา: true = เก็บคลังคงเหลือ · false = Purchasing เท่านั้น
  stockQty?: number          // คลังคงเหลือที่ต้องการให้เป็น (undefined = ไม่แตะยอด)
  curQty?: number            // ยอดปัจจุบัน (ใช้โชว์ diff ใน preview)
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

function parseImportRows(rows: Record<string, unknown>[], items: Item[], stockOf: (id: string) => number): ImportRow[] {
  const seen = new Set<string>()   // กันรหัส Epicor ซ้ำกันเองในไฟล์
  return rows.map(raw => {
    const epicorCode = cell(raw, ['รหัส Epicor', 'epicor', 'epicor_code', 'epicor code', 'รหัส', 'code'])
    const name = cell(raw, ['ชื่ออุปกรณ์', 'ชื่อ', 'name'])
    const uom = cell(raw, ['หน่วย', 'uom'])
    const supply = parseSupply(cell(raw, ['การจัดหา', 'supply', 'source']))
    const qtyRaw = cell(raw, ['คลังคงเหลือ', 'คงเหลือ', 'qty', 'qty_on_hand', 'stock'])
    const qtyNum = qtyRaw === '' ? undefined : Number(qtyRaw)
    const base: Omit<ImportRow, 'action'> = { epicorCode, name, uom, supply, stockQty: qtyNum }
    if (!epicorCode) return { ...base, action: 'error' as const, error: 'ไม่มีรหัส Epicor' }
    if (!name) return { ...base, action: 'error' as const, error: 'ไม่มีชื่ออุปกรณ์' }
    if (qtyNum !== undefined && (Number.isNaN(qtyNum) || qtyNum < 0))
      return { ...base, action: 'error' as const, error: `คลังคงเหลือ "${qtyRaw}" ไม่ใช่ตัวเลขที่ใช้ได้` }
    if (qtyNum !== undefined && qtyNum > 0 && supply === false)
      return { ...base, action: 'error' as const, error: 'มียอดคงเหลือ แต่การจัดหาเป็น Purchasing — เลือกให้ตรงกัน' }
    const key = epicorCode.toLowerCase()
    if (seen.has(key)) return { ...base, action: 'error' as const, error: `รหัส Epicor "${epicorCode}" ซ้ำในไฟล์` }
    seen.add(key)
    const existing = items.find(i => (i.epicorCode ?? '').toLowerCase() === key)
    if (!existing) return { ...base, action: 'create' as const }
    if (existing.itemType === 'main_equipment')
      return { ...base, action: 'error' as const, error: 'เป็น LBS หลัก แก้จากไฟล์ไม่ได้' }
    const curQty = stockOf(existing.id)
    const changed = existing.name !== name
      || (uom !== '' && existing.uom !== uom)
      || (supply !== undefined && supply !== existing.stockableCentrally)
      || (qtyNum !== undefined && qtyNum !== curQty)
    return { ...base, curQty, action: changed ? 'update' as const : 'unchanged' as const, itemId: existing.id }
  })
}

export default function MasterDataPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { ask: askPrompt, element: promptEl } = usePrompt()
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  const { show } = useToast()
  const canMaster = can(user, 'master.manage')
  const canStock = can(user, 'stock.manage')
  const fileRef = useRef<HTMLInputElement>(null)
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [importReason, setImportReason] = useState('')            // เหตุผลตอนนำเข้าที่กระทบยอดคลัง (S3)
  const [ledgerItem, setLedgerItem] = useState<Item | null>(null)  // ดูประวัติการเคลื่อนไหว (S2)
  const [showCatalog, setShowCatalog] = useState(false)   // เริ่มต้นซ่อนตาราง (กดแสดงเอง)
  const [showStock, setShowStock] = useState(false)       // คลังคงเหลือ — เริ่มต้นซ่อนเช่นกัน

  // ---- item modal state ----
  const [itemModal, setItemModal] = useState<'create' | 'edit' | null>(null)
  const [itemTarget, setItemTarget] = useState<Item | null>(null)
  const [itemForm, setItemForm] = useState({ epicorCode: '', name: '', uom: 'ชิ้น', stockableCentrally: false, initialQty: 0, initialUnitCost: '' })

  const accessories = db.items.filter(i => i.itemType === 'accessory')
  const stockQty = (itemId: string) => db.accessoryStock.find(r => r.itemId === itemId)?.qtyOnHand ?? 0
  const stockCost = (itemId: string) => db.accessoryStock.find(r => r.itemId === itemId)?.avgUnitCost ?? 0
  // คลังคงเหลือ = วัสดุที่ตั้งให้เก็บสต็อก หรือมีของค้างอยู่จริง (S2)
  const stockItems = accessories.filter(i => i.stockableCentrally || stockQty(i.id) > 0)
  const stockTotalValue = stockItems.reduce((s, i) => s + stockQty(i.id) * stockCost(i.id), 0)
  const movementsOf = (itemId: string) => db.stockMovements
    .filter(m => m.itemId === itemId)
    .slice().sort((a, b) => b.performedAt.localeCompare(a.performedAt))
  const jobNoOf = (id: string) => db.jobs.find(j => j.id === id)?.jobNo ?? '-'
  const userNameOf = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  const openCreateItem = () => { setItemForm({ epicorCode: '', name: '', uom: 'ชิ้น', stockableCentrally: false, initialQty: 0, initialUnitCost: '' }); setItemTarget(null); setItemModal('create') }
  const openEditItem = (i: Item) => { setItemForm({ epicorCode: i.epicorCode ?? '', name: i.name, uom: i.uom, stockableCentrally: i.stockableCentrally, initialQty: 0, initialUnitCost: '' }); setItemTarget(i); setItemModal('edit') }
  const submitItem = async () => {
    // ใช้ "รหัส Epicor" เป็นตัวระบุหลัก — code (schema เดิม) set = epicorCode เบื้องหลัง
    const epicorCode = itemForm.epicorCode.trim()
    if (!epicorCode) return show('กรุณาระบุรหัส Epicor', true)
    const ok = itemModal === 'create'
      ? await tryAction(() => act.createItem({ code: epicorCode, epicorCode, name: itemForm.name, uom: itemForm.uom, stockableCentrally: itemForm.stockableCentrally, initialQty: itemForm.initialQty, initialUnitCost: itemForm.initialUnitCost.trim() === '' ? undefined : Number(itemForm.initialUnitCost) }), 'เพิ่ม Accessory แล้ว')
      : await tryAction(() => act.updateItem({ itemId: itemTarget!.id, code: itemTarget!.code, epicorCode, name: itemForm.name, uom: itemForm.uom, stockableCentrally: itemForm.stockableCentrally }), 'บันทึกแล้ว')
    if (ok) setItemModal(null)
  }

  // ---------------- Excel export / import ----------------

  // โหลด xlsx แบบ dynamic — ไม่ให้ bundle หลักบวมจาก SheetJS (~430 kB)
  const exportExcel = async () => {
    const XLSX = await import('xlsx')
    const rows = accessories.map(i => ({
      'รหัส Epicor': i.epicorCode ?? '',
      'ชื่ออุปกรณ์': i.name,
      'หน่วย': i.uom,
      'การจัดหา': i.stockableCentrally ? 'คลังสินค้า' : 'Purchasing',
      'คลังคงเหลือ': i.stockableCentrally ? stockQty(i.id) : '',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 14 }, { wch: 32 }, { wch: 8 }, { wch: 12 }, { wch: 10 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Accessory Catalog')
    XLSX.writeFile(wb, `accessory-catalog-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const onPickFile = async (file: File) => {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer())
      const ws = wb.Sheets[wb.SheetNames[0]]
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
      if (raw.length === 0) return show('ไฟล์ไม่มีข้อมูล — ต้องมีหัวตาราง: รหัส Epicor, ชื่ออุปกรณ์, หน่วย', true)
      setImportReason('')
      setImportRows(parseImportRows(raw, db.items, stockQty))
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
        if (row.stockQty !== undefined && row.stockQty !== (row.curQty ?? 0)) {
          await act.adjustAccessoryStock({
            itemId: itemId!, newQty: row.stockQty,
            note: `นำเข้า Excel: ${importReason.trim()}`,
          })
          qtyOk++
        }
      } catch (e) {
        fails.push(`${row.epicorCode}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setImporting(false)
    setImportRows(null)
    setImportReason('')
    const qtyTxt = qtyOk > 0 ? ` · ปรับยอดคลัง ${qtyOk} รายการ` : ''
    if (fails.length) show(`นำเข้าสำเร็จ ${ok} รายการ${qtyTxt} · ล้มเหลว ${fails.length}: ${fails[0]}${fails.length > 1 ? ' …' : ''}`, true)
    else show(`นำเข้าฐานข้อมูลวัสดุสำเร็จ ${ok} รายการ${qtyTxt}`)
  }

  // เดิมถามด้วย window.prompt ซ้อน 3 ชั้น (ยอด → ต้นทุน → เหตุผล) กด Cancel กลางทางแล้วหลุดทั้งชุด
  // ตอนนี้รวมเป็นฟอร์มเดียว เห็นยอดเดิม/ผลต่างก่อนยืนยัน · ต้นทุนใช้เฉพาะตอนยอดเพิ่ม (ของเข้าคลัง)
  const adjustStock = async (i: Item) => {
    const cur = stockQty(i.id)
    const avg = stockCost(i.id)
    const v = await askPrompt({
      title: `ปรับยอดคงเหลือ — ${i.name}`,
      description: <>ยอดปัจจุบัน <b>{cur} {i.uom}</b>{avg > 0 && <> · ต้นทุนถัวเฉลี่ย {fmtBaht(avg)}</>} · ทุกการปรับยอดถูกบันทึกลง ledger และ audit</>,
      fields: [
        { key: 'qty', label: 'ยอดคงเหลือใหม่', type: 'number', min: 0, required: true,
          suffix: i.uom, value: String(cur), hint: 'กรอกยอดที่นับได้จริง ระบบจะคิดผลต่างให้เอง' },
        { key: 'cost', label: 'ต้นทุนต่อหน่วยของของที่เพิ่มเข้ามา', type: 'number', min: 0, suffix: 'บาท',
          value: avg > 0 ? String(avg) : '',
          hint: 'ใช้เฉพาะกรณียอดเพิ่มขึ้น (ของเข้าคลัง) · เว้นว่าง = ต้นทุนถัวเฉลี่ยเดิมไม่เปลี่ยน' },
        { key: 'note', label: 'เหตุผลการปรับยอด', type: 'textarea', required: true,
          placeholder: 'เช่น นับสต็อกประจำเดือน / ของชำรุด / รับเข้าจากหน้างาน' },
      ],
      confirmLabel: 'ปรับยอด',
    })
    if (!v) return
    const qty = Number(v.qty)
    // ยอดเพิ่ม = ของเข้าคลัง → ส่งต้นทุนไปคิดถัวเฉลี่ย · ยอดลดไม่ต้องใช้
    const unitCost = qty > cur && v.cost !== '' ? Number(v.cost) : undefined
    tryAction(() => act.adjustAccessoryStock({ itemId: i.id, newQty: qty, note: v.note, unitCost }), 'ปรับยอดแล้ว')
  }

  return (
    <>
      <div className="page-title">Material Database</div>
      <div className="page-sub">
        แยก 2 ส่วนชัดเจน — <b>ฐานข้อมูลวัสดุ</b> (รายการที่ใช้ตอนออก PR/PO) และ <b>คลังคงเหลือ</b> (ของที่มีอยู่จริง เบิกได้เลย)
        {!canMaster && ' · การเพิ่ม/แก้/ลบเป็นสิทธิ์ของ Manage'}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>ฐานข้อมูลวัสดุ ({accessories.length})</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="small" onClick={() => setShowCatalog(v => !v)}>
              {showCatalog ? 'ซ่อนรายการ' : `แสดงรายการ (${accessories.length})`}
            </button>
            <button className="small" onClick={exportExcel}>⬇ Export Excel</button>
            {canMaster && <>
              <button className="small" onClick={() => fileRef.current?.click()}>⬆ Import Excel</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onPickFile(f); e.target.value = '' }} />
              <button className="small primary" onClick={openCreateItem}>+ เพิ่ม Accessory</button>
            </>}
          </div>
        </div>
        {showCatalog && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>หน่วย</th><th>การจัดหา</th><th></th></tr></thead>
              <tbody>
                {accessories.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่มีวัสดุในระบบ</div></td></tr>}
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
          <h3>คลังคงเหลือ ({stockItems.length})
            <span className="muted" style={{ fontWeight: 400 }}> · ของที่มีอยู่จริง เบิกเข้า Job ได้ทันทีไม่ต้องออก PR</span>
          </h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted">มูลค่ารวม {fmtBaht(stockTotalValue)}</span>
            <button className="small" onClick={() => setShowStock(v => !v)}>
              {showStock ? 'ซ่อนรายการ' : `แสดงรายการ (${stockItems.length})`}
            </button>
          </div>
        </div>
        {showStock && <div className="table-scroll">
          <table>
            <thead>
              <tr><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>คงเหลือ</th><th>ต้นทุนถัวเฉลี่ย</th><th>มูลค่า</th><th></th></tr>
            </thead>
            <tbody>
              {stockItems.length === 0 && (
                <tr><td colSpan={6}><div className="empty">
                  ยังไม่มีวัสดุในคลังคงเหลือ — ตั้งค่า "การจัดหา = เก็บคลังคงเหลือ" ที่ฐานข้อมูลวัสดุ
                  หรือโอนวัสดุเหลือจาก Job เข้าคลัง
                </div></td></tr>
              )}
              {stockItems.map(i => {
                const qty = stockQty(i.id)
                const avg = stockCost(i.id)
                return (
                  <tr key={i.id}>
                    <td className="mono">{i.epicorCode || '-'}</td>
                    <td>{i.name}</td>
                    <td><b>{qty}</b> <span className="muted">{i.uom}</span></td>
                    <td>{avg > 0 ? fmtBaht(avg) : <span className="muted">-</span>}</td>
                    <td>{avg > 0 ? fmtBaht(qty * avg) : <span className="muted">-</span>}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button className="small" style={{ marginRight: 6 }} onClick={() => setLedgerItem(i)}>📜 ประวัติ</button>
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
          </p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>เมื่อ</th><th>ประเภท</th><th>เข้า/ออก</th><th>คงเหลือ</th><th>อ้างอิง</th></tr></thead>
              <tbody>
                {movementsOf(ledgerItem.id).length === 0 && (
                  <tr><td colSpan={5}><div className="empty">ยังไม่มีการเคลื่อนไหว</div></td></tr>
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
              </div>
              <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
                ต้นทุนต่อหน่วยใช้ตั้ง <b>ต้นทุนถัวเฉลี่ย</b> ของคลัง — เวลาเบิกเข้า Job ระบบจะดึงค่านี้ไปตัดต้นทุนงานอัตโนมัติ
                (เว้นว่างได้ แต่มูลค่าคลังจะเป็น 0)
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
            รับคอลัมน์: <b>รหัส Epicor · ชื่ออุปกรณ์ · หน่วย · การจัดหา · คลังคงเหลือ</b> (ครบตามไฟล์ที่ Export ออกไป)
            · รหัสที่มีอยู่แล้ว = อัปเดตทับ · รหัสใหม่ = เพิ่มรายการ
            · การเปลี่ยนยอดคลังจะบันทึกเป็นรายการ "ปรับยอด" ในประวัติการเคลื่อนไหว
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
              <thead><tr><th>ผล</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>หน่วย</th><th>การจัดหา</th><th>คลังคงเหลือ</th></tr></thead>
              <tbody>
                {importRows.map((r, i) => {
                  const qtyChanged = (r.action === 'create' || r.action === 'update')
                    && r.stockQty !== undefined && r.stockQty !== (r.curQty ?? 0)
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
