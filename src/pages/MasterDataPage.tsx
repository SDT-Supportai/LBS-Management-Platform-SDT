import { useState } from 'react'
import { useStore, can } from '../data/StoreContext'
import { Modal, useTryAction } from '../ui/components'
import { DEPT_LABEL } from '../ui/format'
import type { Department, Item, User } from '../types'

const DEPTS: Department[] = ['sales', 'project', 'purchasing', 'service', 'admin']

export default function MasterDataPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const canMaster = can(user, 'master.manage')
  const canStock = can(user, 'stock.manage')

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

  const adjustStock = (i: Item) => {
    const v = window.prompt(`ยอดคงเหลือใหม่ของ ${i.name} (ปัจจุบัน ${stockQty(i.id)} ${i.uom})`)
    if (v === null) return
    const note = window.prompt('เหตุผลการปรับยอด (บันทึกลง audit)') ?? ''
    tryAction(() => act.adjustAccessoryStock({ itemId: i.id, newQty: Number(v), note }), 'ปรับยอดแล้ว')
  }

  return (
    <>
      <div className="page-title">ข้อมูลหลัก (Master Data)</div>
      <div className="page-sub">
        จัดการ Accessory catalog, สต็อกกลาง และผู้ใช้งาน
        {!canMaster && ' — การเพิ่ม/แก้/ลบเป็นสิทธิ์ของ Admin (ปรับยอดสต็อกกลาง: Sales/Admin)'}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Accessory Catalog ({accessories.length})</h3>
          {canMaster && <button className="small primary" onClick={openCreateItem}>+ เพิ่ม Accessory</button>}
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>รหัส</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th><th>หน่วย</th><th>การจัดหา</th><th>สต็อกกลางคงเหลือ</th><th></th></tr></thead>
            <tbody>
              {accessories.map(i => (
                <tr key={i.id}>
                  <td className="mono">{i.code}</td>
                  <td className="mono">{i.epicorCode || '-'}</td>
                  <td>{i.name}</td>
                  <td>{i.uom}</td>
                  <td>{i.stockableCentrally
                    ? <span className="badge green">มีสต็อกกลาง</span>
                    : <span className="badge amber">ผ่าน Purchasing เท่านั้น</span>}</td>
                  <td>{i.stockableCentrally ? `${stockQty(i.id)} ${i.uom}` : '-'}</td>
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
            <span style={{ margin: 0 }}>เก็บในสต็อกกลาง (เบิกได้เลยไม่ต้องออก PR)</span>
          </label>
          {itemModal === 'create' && itemForm.stockableCentrally && (
            <label className="field"><span>ยอดเริ่มต้นในสต็อกกลาง</span>
              <input type="number" min={0} value={itemForm.initialQty}
                onChange={e => setItemForm({ ...itemForm, initialQty: Number(e.target.value) })} />
            </label>
          )}
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
