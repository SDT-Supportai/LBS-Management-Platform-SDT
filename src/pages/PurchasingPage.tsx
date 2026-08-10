import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { Modal, usePrompt, useTryAction } from '../ui/components'
import { poCostSummary } from '../data/logic'
import { fmtBaht, fmtDate, fmtDateTime, COST_CATEGORIES } from '../ui/format'
import type { CostCategoryKey } from '../types'

const COST_LABEL: Record<string, string> = Object.fromEntries(COST_CATEGORIES.map(c => [c.key, c.label]))

export default function PurchasingPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { ask: askPrompt, element: promptEl } = usePrompt()
  const canManage = can(user, 'purchasing.manage')
  const [poFor, setPoFor] = useState<string | null>(null)
  const [rejectFor, setRejectFor] = useState<string | null>(null)
  const [prNoFor, setPrNoFor] = useState<{ id: string; prNo: string } | null>(null)   // แก้เลข PR (0047)
  const [receiveFor, setReceiveFor] = useState<string | null>(null)
  const [poNo, setPoNo] = useState('')
  const [supplier, setSupplier] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [receiveQty, setReceiveQty] = useState<Record<string, number>>({})
  const [poLineIds, setPoLineIds] = useState<Record<string, boolean>>({})   // เลือก line เข้า PO (0022)

  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const prLines = (prId: string) => db.accessoryRequests.filter(r => r.prId === prId)
  const poLines = (poId: string) => db.accessoryRequests.filter(r => r.poId === poId)
  const unorderedLines = (prId: string) => db.accessoryRequests.filter(r => r.prId === prId && r.status === 'pr_sent')

  // สรุปประวัติ PR/PO ต่อ Job (collapsible, เริ่มซ่อน)
  const [openHist, setOpenHist] = useState<Record<string, boolean>>({})
  const toggleHist = (id: string) => setOpenHist(p => ({ ...p, [id]: !p[id] }))
  const jobHistory = (jobId: string): { time: string; text: string }[] => {
    const evts: { time: string; text: string }[] = []
    db.prs.filter(p => p.jobId === jobId).forEach(pr => {
      evts.push({ time: pr.createdAt, text: `📄 ออก ${pr.prNo} (${prLines(pr.id).length} รายการ) ส่ง Purchasing` })
      if (pr.status === 'rejected' && pr.rejectedAt)
        evts.push({ time: pr.rejectedAt, text: `⛔ ตีกลับ ${pr.prNo}: ${pr.rejectReason ?? '-'}` })
    })
    db.pos.filter(p => p.jobId === jobId).forEach(po => {
      const pr = db.prs.find(x => x.id === po.prId)
      evts.push({ time: po.createdAt, text: `🛒 ออก ${po.poNo} จาก ${pr?.prNo ?? '-'} · ${po.supplierName}` })
      if (po.status === 'received' && po.receivedAt) evts.push({ time: po.receivedAt, text: `📬 ${po.poNo} รับของครบ` })
      if (po.status === 'cancelled') evts.push({ time: po.createdAt, text: `🗑️ ${po.poNo} ถูกยกเลิก` })
    })
    return evts.sort((a, b) => a.time.localeCompare(b.time))
  }

  // บันทึกแยกตาม Job No. — แสดงเฉพาะ Job ที่มี PR/PO แล้ว (ใหม่สุดขึ้นก่อน)
  const jobsWithDocs = [...db.jobs]
    .filter(j => db.prs.some(p => p.jobId === j.id) || db.pos.some(p => p.jobId === j.id))
    .reverse()
  const totalPendingPr = db.prs.filter(p => p.status === 'pending').length
  const totalOpenPo = db.pos.filter(p => p.status === 'issued').length

  const receivePo = receiveFor ? db.pos.find(p => p.id === receiveFor) : null
  const receiveLines = receivePo
    ? poLines(receivePo.id).filter(r => r.status === 'po_ordered' && r.qtyReceived < r.qtyRequested)
    : []

  // เปิด modal ออก PO — default เลือกทุก line ที่ยังไม่ได้สั่งของ PR นั้น
  const openPo = (prId: string) => {
    setPoNo(''); setSupplier(''); setExpectedDate('')
    setPoLineIds(Object.fromEntries(unorderedLines(prId).map(r => [r.id, true])))
    setPoFor(prId)
  }
  const submitPo = async () => {
    if (!poFor) return
    const requestIds = Object.entries(poLineIds).filter(([, v]) => v).map(([k]) => k)
    if (requestIds.length === 0) { return }
    if (await tryAction(() => act.createPO({ prId: poFor, poNo, supplierName: supplier, expectedDate, requestIds }),
      'ออก PO และแจ้งกลับ Project Dept แล้ว')) {
      setPoFor(null); setPoNo(''); setSupplier(''); setExpectedDate('')
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
        จัดกลุ่มตามงานโครงการ — รับ PR จาก Project → ออก PO (หรือตีกลับพร้อมเหตุผล) → รับของทีละรายการ/ทีละจำนวน
        {!canManage && ' · แผนกของคุณดูได้อย่างเดียว'}
        {' · '}<span className="badge amber">PR รอออก PO {totalPendingPr}</span>{' '}
        <span className="badge blue">PO รอรับของ {totalOpenPo}</span><br />
        <b>มูลค่าสั่งซื้อ</b> = ราคา × จำนวนที่สั่ง (ยอดที่จ่ายซัพ) ·
        <b> ตัดเข้างาน</b> = ยอดที่หักงบ Job จริง = ราคา × (จำนวนที่สั่ง − จำนวนที่โอนคืนคลัง) —
        ปกติเท่ากัน จะต่างเมื่อ Project โอนวัสดุเหลือคืนคลัง ระบบจะโชว์ทั้งสองยอดในคอลัมน์ต้นทุนรวม
      </div>

      {jobsWithDocs.length === 0 && (
        <div className="panel"><div className="empty">ยังไม่มี PR/PO — Project Dept ออก PR จากหน้า Job ก่อน</div></div>
      )}

      {jobsWithDocs.map(job => {
        const jobPrs = db.prs.filter(p => p.jobId === job.id)
        // PR ที่ยังมีรายการรอออก PO (pending หรือ po_issued ที่ยังสั่งไม่ครบ) — ออก PO เพิ่มได้เรื่อยๆ
        const prsToOrder = jobPrs.filter(p => (p.status === 'pending' || p.status === 'po_issued') && unorderedLines(p.id).length > 0)
        const jobPos = db.pos.filter(p => p.jobId === job.id)
        return (
          <div className="panel" key={job.id}>
            <div className="panel-head">
              <h3>
                <Link to={`/jobs/${job.id}`}>{job.jobNo}</Link>{' '}
                <span className="muted" style={{ fontWeight: 400 }}>{job.customerName}</span>{' '}
                {prsToOrder.length > 0 && <span className="badge amber">มีรายการรอออก PO</span>}{' '}
                {jobPos.filter(p => p.status === 'issued').length > 0 && <span className="badge blue">PO รอรับของ {jobPos.filter(p => p.status === 'issued').length}</span>}
              </h3>
            </div>

            {prsToOrder.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead><tr>
                    <th>PR No.</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th>
                    <th style={{ textAlign: 'right' }}>จำนวน</th>
                    <th style={{ textAlign: 'right' }}>ราคา/หน่วย</th>
                    <th style={{ textAlign: 'right' }} title="ราคา/หน่วย × จำนวนที่สั่ง — ยอดที่จ่ายซัพ · ยอดที่ตัดงบ Job อาจน้อยกว่านี้ถ้าโอนของเหลือคืนคลัง">มูลค่าสั่งซื้อ</th>
                    <th>Phase Budget</th><th>ส่งเมื่อ</th><th></th>
                  </tr></thead>
                  <tbody>
                    {prsToOrder.map(pr => {
                      const lines = unorderedLines(pr.id)
                      return lines.map((r, idx) => {
                        const it = itemOf(r.itemId)!
                        const value = r.unitPrice !== undefined ? r.unitPrice * r.qtyRequested : undefined
                        const cat = r.phaseBudget ? (COST_LABEL[r.phaseBudget] ?? r.phaseBudget) : undefined
                        const phase = r.phaseBudget ? job.budgetCosts?.[r.phaseBudget as CostCategoryKey]?.phase : undefined
                        return (
                          <tr key={r.id}>
                            {idx === 0 && (
                              <td className="mono" rowSpan={lines.length}>
                                <b>{pr.prNo}</b>{pr.status === 'po_issued' && <div className="muted" style={{ fontSize: 11 }}>ออก PO บางส่วนแล้ว</div>}
                                {/* แก้เลข PR ให้ตรงเอกสารจริงจาก Epicor (0047) — เฉพาะใบที่ยังไม่ออก PO */}
                                {canManage && pr.status === 'pending' && (
                                  <div style={{ marginTop: 4 }}>
                                    <button className="small" onClick={() => setPrNoFor({ id: pr.id, prNo: pr.prNo })}>✏️ แก้เลข PR</button>
                                  </div>
                                )}
                              </td>
                            )}
                            <td className="mono">{it.epicorCode || '-'}</td>
                            <td>{it.name}</td>
                            <td style={{ textAlign: 'right' }}>{r.qtyRequested} {it.uom}</td>
                            <td style={{ textAlign: 'right' }}>{fmtBaht(r.unitPrice)}</td>
                            <td style={{ textAlign: 'right' }}>{fmtBaht(value)}</td>
                            <td>
                              {cat ?? '-'}
                              {phase && <div className="muted mono" style={{ fontSize: 11 }}>Phase: {phase}</div>}
                            </td>
                            {idx === 0 && <td className="muted" rowSpan={lines.length}>{fmtDateTime(pr.createdAt)}</td>}
                            {idx === 0 && (
                              <td style={{ whiteSpace: 'nowrap' }} rowSpan={lines.length}>
                                {canManage && <>
                                  <button className="small primary" onClick={() => openPo(pr.id)}>ออก PO</button>{' '}
                                  {pr.status === 'pending' && <button className="small danger" onClick={() => { setRejectReason(''); setRejectFor(pr.id) }}>ตีกลับ</button>}
                                </>}
                              </td>
                            )}
                          </tr>
                        )
                      })
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {jobPos.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>PO No.</th><th>รายการใน PO · ราคาจริง</th><th style={{ textAlign: 'right' }}>ต้นทุนรวม</th><th>Supplier</th><th>กำหนดส่ง</th><th>รับของ</th><th>สถานะ</th><th></th></tr></thead>
                  <tbody>
                    {[...jobPos].reverse().map(po => {
                      const lines = poLines(po.id)
                      const totalOrdered = lines.reduce((s, r) => s + r.qtyRequested, 0)
                      const totalReceived = lines.reduce((s, r) => s + r.qtyReceived, 0)
                      const cost = poCostSummary(db, po.id)   // 0054 — ต้นทุนรวมต่อ PO No.
                      return (
                        <tr key={po.id}>
                          <td className="mono"><b>{po.poNo}</b></td>
                          <td>{lines.map(r => {
                            const it = itemOf(r.itemId)!
                            const value = r.unitPrice !== undefined ? r.unitPrice * r.qtyRequested : undefined
                            // Purchasing บันทึกราคาจริงหลังออก PO (Job ยังไม่ล็อก) — ราคาทับค่าประมาณการ กระทบงบ actual
                            const canEditPrice = canManage && po.status !== 'cancelled' && !job.terminalStatus && (r.status === 'po_ordered' || r.status === 'received')
                            return (
                              <div key={r.id} style={{ marginBottom: 3 }}>
                                {it.name} × {r.qtyRequested} {it.uom} · <span className="mono">{fmtBaht(r.unitPrice)}</span>{value !== undefined ? ` = ${fmtBaht(value)}` : ''}
                                {canEditPrice && (
                                  <button className="small" style={{ marginLeft: 6 }} title="บันทึก/แก้ราคาจริงจาก Supplier"
                                    onClick={async () => {
                                      const v = await askPrompt({
                                        title: `ราคาจริงจาก Supplier — ${it.name}`,
                                        description: <>สั่ง {r.qtyRequested} {it.uom} · ราคาที่บันทึกไว้ {fmtBaht(r.unitPrice)} · <b>เว้นว่าง = ล้างราคา</b> (กลับไปใช้ราคาประมาณการ)</>,
                                        fields: [{
                                          key: 'price', label: 'ราคาจริงต่อหน่วย', type: 'number', min: 0,
                                          suffix: `บาท/${it.uom}`, value: r.unitPrice !== undefined ? String(r.unitPrice) : '',
                                          hint: 'กรอกเป็นตัวเลขล้วน ไม่ต้องใส่เครื่องหมาย ,',
                                        }],
                                      })
                                      if (!v) return
                                      tryAction(() => act.updatePoLinePrice({ requestId: r.id, unitPrice: v.price === '' ? undefined : Number(v.price) }), 'บันทึกราคาจริงแล้ว — งบต้นทุนใช้จริงอัปเดต')
                                    }}>💰 ราคาจริง</button>
                                )}
                              </div>
                            )
                          })}</td>
                          {/* ต้นทุนรวมต่อ PO (0054) — "สั่งซื้อ" คือยอดที่จ่ายซัพ · "ตัดเข้างาน" คือยอดที่หักงบ Job
                              สองตัวนี้ต่างกันได้เมื่อโอนวัสดุเหลือคืนคลัง จึงต้องโชว์แยกไม่ยุบรวม */}
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <b>{fmtBaht(cost.ordered)}</b>
                            <div className="muted" style={{ fontSize: 11 }}>สั่งซื้อ · {cost.lineCount} รายการ</div>
                            {cost.charged !== cost.ordered && (
                              <div style={{ fontSize: 11, color: 'var(--amber, #d97706)' }}
                                title={`โอนวัสดุเหลือคืนคลังแล้ว ${cost.transferredQty} หน่วย — ส่วนนั้นไม่ถูกตัดเป็นต้นทุนของ Job`}>
                                ตัดเข้างาน {fmtBaht(cost.charged)}
                              </div>
                            )}
                            {cost.missingPrice > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--danger)' }}
                                title="ยอดรวมยังไม่ครบ — กด 💰 ราคาจริง ให้ครบทุกรายการ">
                                ⚠️ ยังไม่กรอกราคา {cost.missingPrice} รายการ
                              </div>
                            )}
                          </td>
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
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {canManage && po.status === 'issued' && (
                              <button className="small success" onClick={() => openReceive(po.id)}>รับของ</button>
                            )}{' '}
                            {canManage && po.status === 'issued' && totalReceived === 0 && (
                              <button className="small danger" onClick={async () => {
                                const v = await askPrompt({
                                  title: `ยกเลิก ${po.poNo}`,
                                  description: <>รายการวัสดุใน PO นี้จะกลับไปสถานะ <b>รอออก PO</b> ให้ออก PO ใหม่ได้ · ทำได้เฉพาะ PO ที่ยังไม่รับของ</>,
                                  fields: [{ key: 'reason', label: 'เหตุผลที่ยกเลิก', type: 'textarea', required: true,
                                    placeholder: 'เช่น Supplier ส่งของไม่ได้ / เปลี่ยนสเปค / สั่งผิดรุ่น' }],
                                  confirmLabel: 'ยืนยันยกเลิก PO', danger: true,
                                })
                                if (!v) return
                                tryAction(() => act.cancelPO({ poId: po.id, reason: v.reason }), `ยกเลิก ${po.poNo} แล้ว — รายการรอออก PO ใหม่`)
                              }}>ยกเลิก PO</button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {prsToOrder.length === 0 && jobPos.length === 0 && (
              <div className="empty">ไม่มีรายการค้างของ Job นี้</div>
            )}

            {(() => {
              const hist = jobHistory(job.id)
              if (hist.length === 0) return null
              return (
                <div className="panel-body" style={{ borderTop: '1px solid var(--border)' }}>
                  <button className="small" onClick={() => toggleHist(job.id)}>
                    {openHist[job.id] ? '▾' : '▸'} สรุปประวัติ PR/PO ({hist.length} ขั้นตอน)
                  </button>
                  {openHist[job.id] && (
                    <ul className="hist-list">
                      {hist.map((e, i) => (
                        <li key={i}><span className="muted mono">{fmtDateTime(e.time)}</span> — {e.text}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })()}
          </div>
        )
      })}

      {poFor && (() => {
        const lines = unorderedLines(poFor)
        const selectedCount = lines.filter(r => poLineIds[r.id]).length
        const poForJob = db.jobs.find(j => j.id === db.prs.find(p => p.id === poFor)?.jobId)
        return (
        <Modal title={`ออก PO จาก ${db.prs.find(p => p.id === poFor)?.prNo}`} size="wide" onClose={() => setPoFor(null)}
          footer={<>
            <button onClick={() => setPoFor(null)}>ยกเลิก</button>
            <button className="primary" onClick={submitPo} disabled={selectedCount === 0}>ออก PO ({selectedCount} รายการ)</button>
          </>}>
          <label className="field"><span>เลือกรายการเข้า PO นี้ * (1 PR แตกได้หลาย PO — ที่ไม่เลือกจะออก PO ใบถัดไปได้)</span></label>
          <div className="table-scroll" style={{ marginBottom: 12 }}>
            <table>
              <thead><tr>
                <th></th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th>
                <th style={{ textAlign: 'right' }}>จำนวน</th>
                <th style={{ textAlign: 'right' }}>ราคา/หน่วย</th>
                <th style={{ textAlign: 'right' }}>มูลค่าสั่งซื้อ</th>
                <th>Phase Budget</th>
              </tr></thead>
              <tbody>
                {lines.map(r => {
                  const it = itemOf(r.itemId)!
                  const value = r.unitPrice !== undefined ? r.unitPrice * r.qtyRequested : undefined
                  const cat = r.phaseBudget ? (COST_LABEL[r.phaseBudget] ?? r.phaseBudget) : undefined
                  const phase = r.phaseBudget ? poForJob?.budgetCosts?.[r.phaseBudget as CostCategoryKey]?.phase : undefined
                  return (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setPoLineIds(s => ({ ...s, [r.id]: !s[r.id] }))}>
                      <td><input type="checkbox" readOnly checked={!!poLineIds[r.id]} /></td>
                      <td className="mono">{it.epicorCode || '-'}</td>
                      <td>{it.name}</td>
                      <td style={{ textAlign: 'right' }}>{r.qtyRequested} {it.uom}</td>
                      <td style={{ textAlign: 'right' }}>{fmtBaht(r.unitPrice)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtBaht(value)}</td>
                      <td>{cat ?? '-'}{phase && <div className="muted mono" style={{ fontSize: 11 }}>Phase: {phase}</div>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <label className="field"><span>PO No. * (กรอกเลขเอง — ห้ามซ้ำ)</span>
            <input className="mono" value={poNo} onChange={e => setPoNo(e.target.value)} placeholder="เช่น PO-2026-0002" />
          </label>
          <label className="field"><span>Supplier *</span>
            <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="บจก.สยามอิเล็คทริค" />
          </label>
          <label className="field"><span>กำหนดส่งของ</span>
            <input type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
          </label>
          <div className="muted">ระบบจะแจ้งสถานะกลับ Project Dept ทันทีหลังออก PO</div>
        </Modal>
        )
      })()}

      {/* แก้เลข PR ให้ตรงเอกสารจริง (0047) — หน้า Project อ่านจากแถวเดียวกัน จึงเห็นเลขใหม่เอง */}
      {prNoFor && (
        <Modal title="แก้เลข PR" onClose={() => setPrNoFor(null)}
          footer={<>
            <button onClick={() => setPrNoFor(null)}>ยกเลิก</button>
            <button className="primary" disabled={!prNoFor.prNo.trim()} onClick={async () => {
              if (await tryAction(
                () => act.updatePrNo({ prId: prNoFor.id, prNo: prNoFor.prNo }),
                `แก้เลข PR เป็น ${prNoFor.prNo.trim()} แล้ว`,
              )) setPrNoFor(null)
            }}>บันทึก</button>
          </>}>
          <div className="muted" style={{ marginBottom: 10 }}>
            ใช้เมื่อเลข PR จริงจาก Epicor ไม่ตรงกับเลขที่ระบบรันให้ · แก้ได้เฉพาะใบที่ยังไม่ออก PO ·
            ห้ามซ้ำกับ PR ใบอื่น · <b>หน้า Project จะเห็นเลขใหม่ทันที</b> (อ่านจากข้อมูลชุดเดียวกัน)
            <div style={{ marginTop: 4 }}>
              หมายเหตุ: ข้อความแจ้งเตือน/ประวัติที่ส่งไปก่อนหน้ายังเป็นเลขเดิม — เป็นบันทึก ณ เวลานั้น ไม่แก้ย้อนหลัง
            </div>
          </div>
          <label className="field"><span>เลข PR *</span>
            <input className="mono" value={prNoFor.prNo}
              onChange={e => setPrNoFor({ ...prNoFor, prNo: e.target.value })} placeholder="PR-2026-0001" />
          </label>
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
      {promptEl}
    </>
  )
}
