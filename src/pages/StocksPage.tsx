import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { stockSummary } from '../data/logic'
import { Modal, useTryAction } from '../ui/components'
import { fmtDate } from '../ui/format'

function parseSerials(text: string): string[] {
  return text.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
}

export default function StocksPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const [showCreate, setShowCreate] = useState(false)
  const [addTo, setAddTo] = useState<string | null>(null)
  const [openStock, setOpenStock] = useState<string | null>(null)         // เริ่มต้นซ่อนรายการทุกคลัง
  const [showAccessory, setShowAccessory] = useState(false)               // สต็อกกลาง Accessory เริ่มต้นซ่อน
  const [editStock, setEditStock] = useState<string | null>(null)
  const [editNotes, setEditNotes] = useState('')
  const [editStatus, setEditStatus] = useState<'open' | 'closed'>('open')

  const [stockNo, setStockNo] = useState(`Project Stock No.${db.projectStocks.length + 1}`)
  const [serialText, setSerialText] = useState('')
  const [notes, setNotes] = useState('')

  const lbsItem = db.items.find(i => i.itemType === 'main_equipment')!
  const canManage = can(user, 'stock.manage')
  const jobNo = (id: string | null) => db.jobs.find(j => j.id === id)?.jobNo

  const submitCreate = async () => {
    if (await tryAction(
      () => act.createProjectStock({ stockNo, itemId: lbsItem.id, serialNos: parseSerials(serialText), notes }),
      `สร้าง ${stockNo} เรียบร้อย`,
    )) {
      setShowCreate(false); setSerialText(''); setNotes('')
    }
  }

  const submitAdd = async () => {
    if (!addTo) return
    if (await tryAction(
      () => act.addUnitsToStock({ stockId: addTo, serialNos: parseSerials(serialText) }),
      'รับ LBS เข้าสต็อกเรียบร้อย',
    )) { setAddTo(null); setSerialText('') }
  }

  return (
    <>
      <div className="page-title">Project Stock — 115kV LBS</div>
      <div className="page-sub">
        คลังกลางที่ Sales สั่งซื้อเข้ามา ยังไม่ผูกลูกค้า/Scope — Project Dept ดึงเข้า Job ตามลำดับงาน
        {!canManage && ' (แผนกของคุณดูได้อย่างเดียว การสร้าง/รับเข้าสต็อกเป็นสิทธิ์ของ Sales)'}
      </div>

      {canManage && (
        <div style={{ marginBottom: 16 }}>
          <button className="primary" onClick={() => { setSerialText(''); setStockNo(`Project Stock No.${db.projectStocks.length + 1}`); setShowCreate(true) }}>+ สร้าง Project Stock ใหม่ (สั่งซื้อ LBS เข้าคลัง)</button>
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
                {canManage && <button className="small" onClick={() => { setSerialText(''); setAddTo(s.id) }}>+ รับ LBS เพิ่ม</button>}
                {canManage && <button className="small" onClick={() => { setEditNotes(s.notes ?? ''); setEditStatus(s.status); setEditStock(s.id) }}>แก้ไข</button>}
                <button className="small" onClick={() => setOpenStock(expanded ? null : s.id)}>{expanded ? 'ซ่อนรายการ' : `ดูรายเครื่อง (${sum.total})`}</button>
              </div>
            </div>
            {expanded && (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Serial No.</th><th>สถานะ</th><th>Job No.</th></tr></thead>
                  <tbody>
                    {units.map(u => (
                      <tr key={u.id}>
                        <td className="mono">{u.serialNo}</td>
                        <td>
                          {u.status === 'in_stock' && <span className="badge green">อยู่ในสต็อก</span>}
                          {u.status === 'allocated' && <span className="badge blue">ถูกดึงเข้า Job</span>}
                          {u.status === 'issued' && <span className="badge neutral">เบิกติดตั้งแล้ว</span>}
                        </td>
                        <td>{u.jobId ? <Link to={`/jobs/${u.jobId}`}>{jobNo(u.jobId)}</Link> : '-'}</td>
                      </tr>
                    ))}
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

      <div className="panel">
        <div className="panel-head">
          <h3>สต็อกกลาง Accessory</h3>
          <button className="small" onClick={() => setShowAccessory(!showAccessory)}>
            {showAccessory ? 'ซ่อนรายการ' : `แสดงรายการ (${db.items.filter(i => i.itemType === 'accessory').length})`}
          </button>
        </div>
        {showAccessory && <div className="table-scroll">
          <table>
            <thead><tr><th>รหัส</th><th>รายการ</th><th>คงเหลือ</th><th>ประเภทการจัดหา</th></tr></thead>
            <tbody>
              {db.items.filter(i => i.itemType === 'accessory').map(i => {
                const row = db.accessoryStock.find(r => r.itemId === i.id)
                return (
                  <tr key={i.id}>
                    <td className="mono">{i.code}</td>
                    <td>{i.name}</td>
                    <td>{i.stockableCentrally ? `${row?.qtyOnHand ?? 0} ${i.uom}` : '-'}</td>
                    <td>
                      {i.stockableCentrally
                        ? <span className="badge green">มีสต็อกกลาง เบิกได้เลย</span>
                        : <span className="badge amber">ต้องสั่งซื้อผ่าน Purchasing</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>}
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
            <button className="primary" onClick={submitCreate}>สร้างสต็อก ({parseSerials(serialText).length} เครื่อง)</button>
          </>}
        >
          <label className="field"><span>Stock No.</span>
            <input value={stockNo} onChange={e => setStockNo(e.target.value)} />
          </label>
          <label className="field"><span>Serial No. ของ LBS แต่ละเครื่อง (คั่นด้วยขึ้นบรรทัดใหม่หรือ ,)</span>
            <textarea rows={6} value={serialText} onChange={e => setSerialText(e.target.value)} placeholder={'LBS26-001\nLBS26-002\nLBS26-003'} />
          </label>
          <label className="field"><span>บันทึก (อ้างอิงรอบสั่งซื้อ ฯลฯ)</span>
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
            <button className="primary" onClick={submitAdd}>รับเข้า ({parseSerials(serialText).length} เครื่อง)</button>
          </>}
        >
          <label className="field"><span>Serial No. (คั่นด้วยขึ้นบรรทัดใหม่หรือ ,)</span>
            <textarea rows={6} value={serialText} onChange={e => setSerialText(e.target.value)} />
          </label>
        </Modal>
      )}
    </>
  )
}
