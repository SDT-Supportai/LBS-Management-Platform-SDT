import { useRef, useState } from 'react'
import { useStore, can } from '../data/StoreContext'
import { Modal, useToast, useTryAction } from '../ui/components'
import { DEPT_LABEL } from '../ui/format'
import type { Department, Item, User } from '../types'

const DEPTS: Department[] = ['sales', 'project', 'purchasing', 'service', 'admin']

// ---------------- Excel import/export (Accessory Catalog) ----------------

interface ImportRow {
  code: string; epicorCode: string; name: string; uom: string
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

function parseImportRows(rows: Record<string, unknown>[], items: Item[]): ImportRow[] {
  return rows.map(raw => {
    const code = cell(raw, ['รหัส', 'code'])
    const epicorCode = cell(raw, ['รหัส Epicor', 'epicor', 'epicor_code', 'epicor code'])
    const name = cell(raw, ['ชื่ออุปกรณ์', 'ชื่อ', 'name'])
    const uom = cell(raw, ['หน่วย', 'uom'])
    const base: Omit<ImportRow, 'action'> = { code, epicorCode, name, uom }
    if (!code) return { ...base, action: 'error' as const, error: 'ไม่มีรหัส' }
    if (!name) return { ...base, action: 'error' as const, error: 'ไม่มีชื่ออุปกรณ์' }
    const existing = items.find(i => i.code.toLowerCase() === code.toLowerCase())
    if (!existing) return { ...base, action: 'create' as const }
    if (existing.itemType === 'main_equipment')
      return { ...base, action: 'error' as const, error: 'เป็น LBS หลัก แก้จากไฟล์ไม่ได้' }
    const changed = (existing.epicorCode ?? '') !== epicorCode
      || existing.name !== name
      || (uom !== '' && existing.uom !== uom)
    return { ...base, action: changed ? 'update' as const : 'unchanged' as const, itemId: existing.id }
  })
}

export default function MasterDataPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { show } = useToast()
  const canMaster = can(user, 'master.manage')
  const canStock = can(user, 'stock.manage')
  const fileRef = useRef<HTMLInputElement>(null)
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)   // เริ่มต้นซ่อนตาราง (กดแสดงเอง)

  // ---- item modal state ----
  const [itemModal, setItemModal] = useState<'create' | 'edit' | null>(null)
  const [itemTarget, setItemTarget] = useState<Item | null>(null)
  const [itemForm, setItemForm] = useState({ code: '', epicorCode: '', name: '', uom: 'ชิ้น', stockableCentrally: false, initialQty: 0 })

  // ---- user modal state ----
  const [userModal, setUserModal] = useState<'create' | 'edit' | null>(null)
  const [userTarget, setUserTarget] = useState<User | null>(null)
  const [userForm, setUserForm] = useState({ email: '', fullName: '', department: 'project' as Department, password: '', isActive: true })

  const accessories = db.items.filter(i => i.itemType === 'accessory')
  const stockQty = (itemId: string) => db.accessoryStock.find(r => r.itemId === itemId)?.qtyOnHand ?? 0

  const openCreateItem = () => { setItemForm({ code: '', epicorCode: '', name: '', uom: 'ชิ้น', stockableCentrally: false, initialQty: 0 }); setItemTarget(null); setItemModal('create') }
  const openEditItem = (i: Item) => { setItemForm({ code: i.code, epicorCode: i.epicorCode ?? '', name: i.name, uom: i.uom, stockableCentrally: i.stockableCentrally, initialQty: 0 }); setItemTarget(i); setItemModal('edit') }
  const submitItem = async () => {
    const ok = itemModal === 'create'
      ? await tryAction(() => act.createItem(itemForm), 'เพิ่ม Accessory แล้ว')
      : await tryAction(() => act.updateItem({ itemId: itemTarget!.id, ...itemForm }), 'บันทึกแล้ว')
    if (ok) setItemModal(null)
  }

  const openCreateUser = () => { setUserForm({ email: '', fullName: '', department: 'project', password: '', isActive: true }); setUserTarget(null); setUserModal('create') }
  const openEditUser = (u: User) => { setUserForm({ email: u.email, fullName: u.fullName, department: u.department, password: '', isActive: u.isActive }); setUserTarget(u); setUserModal('edit') }
  const submitUser = async () => {
    const ok = userModal === 'create'
      ? await tryAction(() => act.createUser(userForm), 'เพิ่มผู้ใช้แล้ว')
      : await tryAction(() => act.updateUser({ userId: userTarget!.id, fullName: userForm.fullName, department: userForm.department, password: userForm.password || undefined, isActive: userForm.isActive }), 'บันทึกแล้ว')
    if (ok) setUserModal(null)
  }

  // ---------------- Excel export / import ----------------

  // โหลด xlsx แบบ dynamic — ไม่ให้ bundle หลักบวมจาก SheetJS (~430 kB)
  const exportExcel = async () => {
    const XLSX = await import('xlsx')
    const rows = accessories.map(i => ({
      'รหัส': i.code,
      'รหัส Epicor': i.epicorCode ?? '',
      'ชื่ออุปกรณ์': i.name,
      'หน่วย': i.uom,
      'การจัดหา': i.stockableCentrally ? 'คลังสินค้า' : 'Purchasing',
      'คลังคงเหลือ': i.stockableCentrally ? stockQty(i.id) : '',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 32 }, { wch: 8 }, { wch: 12 }, { wch: 10 }]
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
      if (raw.length === 0) return show('ไฟล์ไม่มีข้อมูล — ต้องมีหัวตาราง: รหัส, รหัส Epicor, ชื่ออุปกรณ์, หน่วย', true)
      setImportRows(parseImportRows(raw, db.items))
    } catch {
      show('อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xlsx)', true)
    }
  }

  const runImport = async () => {
    if (!importRows) return
    setImporting(true)
    let ok = 0
    const fails: string[] = []
    for (const row of importRows) {
      if (row.action !== 'create' && row.action !== 'update') continue
      try {
        if (row.action === 'create') {
          await act.createItem({
            code: row.code, epicorCode: row.epicorCode || undefined, name: row.name,
            uom: row.uom || 'ชิ้น', stockableCentrally: false, initialQty: 0,
          })
        } else {
          const existing = db.items.find(i => i.id === row.itemId)!
          await act.updateItem({
            itemId: existing.id, code: row.code, epicorCode: row.epicorCode || undefined,
            name: row.name, uom: row.uom || existing.uom, stockableCentrally: existing.stockableCentrally,
          })
        }
        ok++
      } catch (e) {
        fails.push(`${row.code}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setImporting(false)
    setImportRows(null)
    if (fails.length) show(`นำเข้าสำเร็จ ${ok} รายการ · ล้มเหลว ${fails.length}: ${fails[0]}${fails.length > 1 ? ' …' : ''}`, true)
    else show(`นำเข้า Accessory Catalog สำเร็จ ${ok} รายการ`)
  }

  const adjustStock = (i: Item) => {
    const v = window.prompt(`ยอดคงเหลือใหม่ของ ${i.name} (ปัจจุบัน ${stockQty(i.id)} ${i.uom})`)
    if (v === null) return
    const note = window.prompt('เหตุผลการปรับยอด (บันทึกลง audit)') ?? ''
    tryAction(() => act.adjustAccessoryStock({ itemId: i.id, newQty: Number(v), note }), 'ปรับยอดแล้ว')
  }

  return (
    <>
      <div className="page-title">Material Database</div>
      <div className="page-sub">
        ฐานข้อมูลวัสดุ (ใช้ตอนออก PR) และผู้ใช้งาน
        {!canMaster && ' — การเพิ่ม/แก้/ลบเป็นสิทธิ์ของ Manager'}
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
              <thead><tr><th>รหัส</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>หน่วย</th><th></th></tr></thead>
              <tbody>
                {accessories.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่มีวัสดุในระบบ</div></td></tr>}
                {accessories.map(i => (
                  <tr key={i.id}>
                    <td className="mono">{i.code}</td>
                    <td className="mono">{i.epicorCode || '-'}</td>
                    <td>{i.name}</td>
                    <td>{i.uom}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {i.stockableCentrally && canStock && <button className="small" onClick={() => adjustStock(i)}>ปรับยอด</button>}{' '}
                      {canMaster && <>
                        <button className="small" onClick={() => openEditItem(i)}>แก้ไข</button>{' '}
                        <button className="small danger" onClick={() => {
                          if (confirm(`ลบ ${i.name}?`)) tryAction(() => act.deleteItem({ itemId: i.id }), 'ลบแล้ว')
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

      <div className="panel">
        <div className="panel-head">
          <h3>ผู้ใช้งาน ({db.users.length})</h3>
          {canMaster && <button className="small primary" onClick={openCreateUser}>+ เพิ่มผู้ใช้</button>}
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>ชื่อ</th><th>อีเมล</th><th>แผนก</th><th>สถานะ</th><th></th></tr></thead>
            <tbody>
              {db.users.map(u => (
                <tr key={u.id}>
                  <td>{u.fullName}</td>
                  <td>{u.email}</td>
                  <td><span className="badge blue">{DEPT_LABEL[u.department]}</span></td>
                  <td>{u.isActive ? <span className="badge green">ใช้งานได้</span> : <span className="badge red">ปิดการใช้งาน</span>}</td>
                  <td>{canMaster && <button className="small" onClick={() => openEditUser(u)}>แก้ไข</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {itemModal && (
        <Modal title={itemModal === 'create' ? 'เพิ่ม Accessory' : `แก้ไข ${itemTarget?.name}`} onClose={() => setItemModal(null)}
          footer={<>
            <button onClick={() => setItemModal(null)}>ยกเลิก</button>
            <button className="primary" onClick={submitItem}>บันทึก</button>
          </>}>
          <div className="row">
            <label className="field"><span>รหัส *</span>
              <input value={itemForm.code} onChange={e => setItemForm({ ...itemForm, code: e.target.value })} placeholder="ACC-XXX-01" />
            </label>
            <label className="field"><span>รหัส Epicor</span>
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
            <span style={{ margin: 0 }}>เก็บในคลังสินค้า (เบิกได้เลยไม่ต้องออก PR)</span>
          </label>
          {itemModal === 'create' && itemForm.stockableCentrally && (
            <label className="field"><span>ยอดเริ่มต้นในคลังสินค้า</span>
              <input type="number" min={0} value={itemForm.initialQty}
                onChange={e => setItemForm({ ...itemForm, initialQty: Number(e.target.value) })} />
            </label>
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
            รหัสที่มีอยู่แล้ว = อัปเดตทับ (ชื่อ/Epicor/หน่วย) · รหัสใหม่ = เพิ่มรายการ (การจัดหาเริ่มต้น: Purchasing)
            · ไม่แตะยอดคลังสินค้า
          </div>
          <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>ผล</th><th>รหัส</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>หน่วย</th></tr></thead>
              <tbody>
                {importRows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.action === 'create' && <span className="badge green">เพิ่มใหม่</span>}
                      {r.action === 'update' && <span className="badge blue">อัปเดต</span>}
                      {r.action === 'unchanged' && <span className="badge neutral">ไม่เปลี่ยน</span>}
                      {r.action === 'error' && <span className="badge red" title={r.error}>ข้าม: {r.error}</span>}
                    </td>
                    <td className="mono">{r.code || '-'}</td>
                    <td className="mono">{r.epicorCode || '-'}</td>
                    <td>{r.name || '-'}</td>
                    <td>{r.uom || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {userModal && (
        <Modal title={userModal === 'create' ? 'เพิ่มผู้ใช้' : `แก้ไข ${userTarget?.fullName}`} onClose={() => setUserModal(null)}
          footer={<>
            <button onClick={() => setUserModal(null)}>ยกเลิก</button>
            <button className="primary" onClick={submitUser}>บันทึก</button>
          </>}>
          <label className="field"><span>ชื่อ-นามสกุล *</span>
            <input value={userForm.fullName} onChange={e => setUserForm({ ...userForm, fullName: e.target.value })} />
          </label>
          <label className="field"><span>อีเมล *{userModal === 'edit' ? ' (แก้ไม่ได้)' : ''}</span>
            <input value={userForm.email} disabled={userModal === 'edit'}
              onChange={e => setUserForm({ ...userForm, email: e.target.value })} />
          </label>
          <div className="row">
            <label className="field"><span>แผนก</span>
              <select value={userForm.department} onChange={e => setUserForm({ ...userForm, department: e.target.value as Department })}>
                {DEPTS.map(d => <option key={d} value={d}>{DEPT_LABEL[d]}</option>)}
              </select>
            </label>
            <label className="field"><span>{userModal === 'create' ? 'รหัสผ่าน *' : 'รหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)'}</span>
              <input type="password" value={userForm.password} onChange={e => setUserForm({ ...userForm, password: e.target.value })} />
            </label>
          </div>
          {userModal === 'edit' && (
            <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={userForm.isActive}
                onChange={e => setUserForm({ ...userForm, isActive: e.target.checked })} />
              <span style={{ margin: 0 }}>เปิดใช้งานบัญชี</span>
            </label>
          )}
        </Modal>
      )}
    </>
  )
}
