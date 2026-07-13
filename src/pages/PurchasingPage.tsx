import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { Modal, useTryAction } from '../ui/components'
import { fmtDate, fmtDateTime, PR_STATUS_LABEL } from '../ui/format'

export default function PurchasingPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const canManage = can(user, 'purchasing.manage')
  const [poFor, setPoFor] = useState<string | null>(null)
  const [rejectFor, setRejectFor] = useState<string | null>(null)
  const [receiveFor, setReceiveFor] = useState<string | null>(null)
  const [supplier, setSupplier] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [receiveQty, setReceiveQty] = useState<Record<string, number>>({})

  const jobOf = (id: string) => db.jobs.find(j => j.id === id)
  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const prLines = (prId: string) => db.accessoryRequests.filter(r => r.prId === prId)

  const pendingPrs = db.prs.filter(p => p.status === 'pending')
  const otherPrs = db.prs.filter(p => p.status !== 'pending')
  const receivePo = receiveFor ? db.pos.find(p => p.id === receiveFor) : null
  const receiveLines = receivePo
    ? prLines(receivePo.prId).filter(r => r.status === 'po_ordered' && r.qtyReceived < r.qtyRequested)
    : []

  const submitPo = async () => {
    if (!poFor) return
    if (await tryAction(() => act.createPO({ prId: poFor, supplierName: supplier, expectedDate }),
      'ออก PO และแจ้งกลับ Project Dept แล้ว')) {
      setPoFor(null); setSupplier(''); setExpectedDate('')
    }
  }

  const submitReject = async () => {
    if (!rejectFor) return
    if (await tryAction(() => act.rejectPR({ prId: rejectFor, reason: rejectReason }),
      'ตีกลับ PR และแจ้ง Project Dept แล้ว')) {
      setRejectFor(null); setRejectReason('')
    }
  }

  const openReceive = (poId: string) => {
    setReceiveQty({})
    setReceiveFor(poId)
  }

  const submitReceive = async () => {
    if (!receivePo) return
    const receipts = Object.entries(receiveQty)
      .map(([requestId, qty]) => ({ requestId, qty: Number(qty) || 0 }))
      .filter(r => r.qty > 0)
    if (await tryAction(() => act.receivePOItems({ poId: receivePo.id, receipts }),
      'บันทึกรับของแล้ว — สถานะ Job อัพเดทอัตโนมัติ')) {
      setReceiveFor(null)
    }
  }

  const fillAll = () => {
    const filled: Record<string, number> = {}
    receiveLines.forEach(r => { filled[r.id] = r.qtyRequested - r.qtyReceived })
    setReceiveQty(filled)
  }

  return (
    <>
      <div className="page-title">Purchasing — PR / PO</div>
      <div className="page-sub">
        รับ PR จาก Project Dept → ออก PO (หรือตีกลับพร้อมเหตุผล) → รับของได้ทีละรายการ/ทีละจำนวน
        {!canManage && ' (แผนกของคุณดูได้อย่างเดียว)'}
      </div>

      <div className="panel">
        <div className="panel-head"><h3>PR รอออก PO ({pendingPrs.length})</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>PR No.</th><th>Job No.</th><th>รายการ</th><th>ส่งเมื่อ</th><th></th></tr></thead>
            <tbody>
              {pendingPrs.length === 0 && <tr><td colSpan={5}><div className="empty">ไม่มี PR ค้าง</div></td></tr>}
              {pendingPrs.map(pr => {
                const job = jobOf(pr.jobId)!
                return (
                  <tr key={pr.id}>
                    <td className="mono"><b>{pr.prNo}</b></td>
                    <td><Link to={`/jobs/${job.id}`}>{job.jobNo}</Link><div className="muted">{job.customerName}</div></td>
                    <td>{prLines(pr.id).map(r => {
                      const it = itemOf(r.itemId)!
                      return <div key={r.id}>{it.name} × {r.qtyRequested} {it.uom}</div>
                    })}</td>
                    <td className="muted">{fmtDateTime(pr.createdAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canManage && <>
                        <button className="small primary" onClick={() => setPoFor(pr.id)}>ออก PO</button>{' '}
                        <button className="small danger" onClick={() => { setRejectReason(''); setRejectFor(pr.id) }}>ตีกลับ</button>
                      </>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Purchase Orders</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>PO No.</th><th>PR / Job</th><th>Supplier</th><th>กำหนดส่ง</th><th>รับของ</th><th>สถานะ</th><th></th></tr></thead>
            <tbody>
              {db.pos.length === 0 && <tr><td colSpan={7}><div className="empty">ยังไม่มี PO</div></td></tr>}
              {[...db.pos].reverse().map(po => {
                const pr = db.prs.find(p => p.id === po.prId)
                const job = jobOf(po.jobId)
                const lines = prLines(po.prId)
                const totalOrdered = lines.reduce((s, r) => s + r.qtyRequested, 0)
                const totalReceived = lines.reduce((s, r) => s + r.qtyReceived, 0)
                return (
                  <tr key={po.id}>
                    <td className="mono"><b>{po.poNo}</b></td>
                    <td className="mono">{pr?.prNo} / {job && <Link to={`/jobs/${job.id}`}>{job.jobNo}</Link>}</td>
                    <td>{po.supplierName}</td>
                    <td>{fmtDate(po.expectedDate)}</td>
                    <td>
                      {totalReceived}/{totalOrdered}
                      <div className="progress"><div style={{ width: `${totalOrdered ? (totalReceived / totalOrdered) * 100 : 0}%` }} /></div>
                    </td>
                    <td>
                      {po.status === 'issued' && (totalReceived > 0
                        ? <span className="badge blue">รับบางส่วน</span>
                        : <span className="badge amber">รอรับของ</span>)}
                      {po.status === 'received' && <span className="badge green">รับของครบ {fmtDate(po.receivedAt)}</span>}
                      {po.status === 'cancelled' && <span className="badge red">ยกเลิก</span>}
                    </td>
                    <td>
                      {canManage && po.status === 'issued' && (
                        <button className="small success" onClick={() => openReceive(po.id)}>รับของ</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {otherPrs.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h3>ประวัติ PR</h3></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>PR No.</th><th>Job</th><th>สถานะ</th></tr></thead>
              <tbody>
                {[...otherPrs].reverse().map(pr => (
                  <tr key={pr.id}>
                    <td className="mono">{pr.prNo}</td>
                    <td className="mono">{jobOf(pr.jobId)?.jobNo}</td>
                    <td>
                      <span className={`badge ${pr.status === 'received' ? 'green' : pr.status === 'po_issued' ? 'blue' : 'red'}`}>
                        {PR_STATUS_LABEL[pr.status]}
                      </span>
                      {pr.status === 'rejected' && <div className="muted">เหตุผล: {pr.rejectReason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {poFor && (
        <Modal title={`ออก PO จาก ${db.prs.find(p => p.id === poFor)?.prNo}`} onClose={() => setPoFor(null)}
          footer={<>
            <button onClick={() => setPoFor(null)}>ยกเลิก</button>
            <button className="primary" onClick={submitPo}>ออก PO</button>
          </>}>
          <label className="field"><span>Supplier *</span>
            <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="บจก.สยามอิเล็คทริค" />
          </label>
          <label className="field"><span>กำหนดส่งของ</span>
            <input type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
          </label>
          <div className="muted">PO No. จะออกอัตโนมัติ และแจ้งสถานะกลับ Project Dept ทันที</div>
        </Modal>
      )}

      {rejectFor && (
        <Modal title={`ตีกลับ ${db.prs.find(p => p.id === rejectFor)?.prNo}`} onClose={() => setRejectFor(null)}
          footer={<>
            <button onClick={() => setRejectFor(null)}>กลับ</button>
            <button className="danger" onClick={submitReject}>ยืนยันตีกลับ PR</button>
          </>}>
          <p style={{ marginBottom: 10 }}>
            รายการใน PR จะเด้งกลับเป็น "รอออก PR" ให้ Project Dept แก้ไข/ออก PR ใหม่ พร้อมแจ้งเตือนเหตุผล
          </p>
          <label className="field"><span>เหตุผลที่ตีกลับ *</span>
            <textarea rows={2} value={rejectReason} onChange={e => setRejectReason(e.target.value)}
              placeholder="เช่น Supplier ยกเลิกการผลิต / สเปคไม่ชัดเจน / ราคาเกินงบ" />
          </label>
        </Modal>
      )}

      {receivePo && (
        <Modal title={`รับของตาม ${receivePo.poNo}`} onClose={() => setReceiveFor(null)}
          footer={<>
            <button onClick={() => setReceiveFor(null)}>ยกเลิก</button>
            <button onClick={fillAll}>รับครบทุกรายการ</button>
            <button className="success" onClick={submitReceive}>บันทึกรับของ</button>
          </>}>
          <div className="muted" style={{ marginBottom: 10 }}>
            รับของทีละรายการ/ทีละจำนวนได้ — Job จะขยับเป็น Ready to Issue เมื่อครบทุกรายการ
          </div>
          {receiveLines.map(r => {
            const it = itemOf(r.itemId)!
            const remaining = r.qtyRequested - r.qtyReceived
            return (
              <label className="field" key={r.id}>
                <span>{it.name} — รับแล้ว {r.qtyReceived}/{r.qtyRequested} {it.uom} (ค้างรับ {remaining})</span>
                <input type="number" min={0} max={remaining}
                  value={receiveQty[r.id] ?? ''}
                  placeholder={`จำนวนที่รับรอบนี้ (สูงสุด ${remaining})`}
                  onChange={e => setReceiveQty({ ...receiveQty, [r.id]: Number(e.target.value) })} />
              </label>
            )
          })}
        </Modal>
      )}
    </>
  )
}
