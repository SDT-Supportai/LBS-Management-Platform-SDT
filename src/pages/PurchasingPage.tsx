import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { Modal, usePrompt, useTryAction } from '../ui/components'
import { poCostSummary } from '../data/logic'
import { fmtBaht, fmtDate, fmtDateTime, COST_CATEGORIES } from '../ui/format'
import type { CostCategoryKey } from '../types'

const COST_LABEL: Record<string, string> = Object.fromEntries(COST_CATEGORIES.map(c => [c.key, c.label]))

// ---------------------------------------------------------------
// สเปกคอลัมน์ไฟล์ Excel ของ "PR ที่ยังไม่ได้ออก PO" — แหล่งความจริงเดียวของทั้งชีตข้อมูลและชีตวิธีใช้
// (แนวเดียวกับ SHEET_COLS ของ Project Stock — ห้ามพิมพ์หัวตารางซ้ำในสองที่)
//   io 'auto'     = ระบบเติมให้จากข้อมูลใน PR
//   io 'supplier' = **เว้นว่างไว้ให้ซัพพลายเออร์กรอก** — นี่คือส่วนที่ทำให้ไฟล์เป็น "template" ขอราคา
// ไฟล์นี้เป็น export อย่างเดียว ไม่มี import กลับ (ราคาจริงบันทึกผ่านปุ่ม 💰 ราคาจริง หลังออก PO)
// ---------------------------------------------------------------
interface PrColSpec { key: string; io: 'auto' | 'supplier'; width: number; note: string }
const PR_COLS: PrColSpec[] = [
  { key: 'PR No.', io: 'auto', width: 16, note: 'เลขใบขอซื้อในระบบ (แก้ให้ตรงเอกสาร Epicor ได้ที่ปุ่ม ✏️ แก้เลข PR)' },
  { key: 'Job No.', io: 'auto', width: 16, note: 'งานโครงการที่ขอวัสดุชุดนี้' },
  { key: 'Customer', io: 'auto', width: 24, note: 'ลูกค้าเจ้าของงาน' },
  { key: 'รหัส Epicor', io: 'auto', width: 14, note: 'รหัสวัสดุใน Epicor — ใช้อ้างอิงตอนสั่งซื้อ' },
  { key: 'ชื่ออุปกรณ์', io: 'auto', width: 32, note: 'ชื่อวัสดุตามฐานข้อมูลวัสดุ' },
  { key: 'จำนวน', io: 'auto', width: 10, note: 'จำนวนที่ขอซื้อ (เฉพาะส่วนที่ยังไม่ได้ออก PO)' },
  { key: 'หน่วย', io: 'auto', width: 8, note: 'หน่วยนับตามฐานข้อมูลวัสดุ' },
  { key: 'ราคาประมาณการ/หน่วย', io: 'auto', width: 20, note: 'ราคาที่ Project ตั้งไว้ใช้คิดงบ — ยังไม่ใช่ราคาจริง' },
  { key: 'มูลค่าประมาณการ', io: 'auto', width: 18, note: 'ราคาประมาณการ × จำนวน' },
  { key: 'Phase Budget', io: 'auto', width: 16, note: 'หมวดต้นทุนที่รายการนี้จะถูกตัดเข้า' },
  { key: 'Phase', io: 'auto', width: 12, note: 'รหัส Phase ของหมวดต้นทุนนั้นใน Job' },
  { key: 'วันที่ออก PR', io: 'auto', width: 14, note: 'วันที่ Project ส่ง PR เข้ามาที่ Purchasing' },
  { key: 'ราคาที่เสนอ/หน่วย', io: 'supplier', width: 20, note: 'ให้ซัพพลายเออร์กรอกราคาต่อหน่วยที่เสนอ' },
  { key: 'มูลค่าที่เสนอ', io: 'supplier', width: 18, note: 'ราคาที่เสนอ × จำนวน' },
  { key: 'ยี่ห้อ/รุ่นที่เสนอ', io: 'supplier', width: 22, note: 'ระบุยี่ห้อ/รุ่นที่จะส่ง — ใช้เทียบสเปกก่อนออก PO' },
  { key: 'กำหนดส่งได้', io: 'supplier', width: 14, note: 'วันที่ส่งของได้ (YYYY-MM-DD)' },
  { key: 'หมายเหตุ', io: 'supplier', width: 30, note: 'เงื่อนไขอื่น เช่น MOQ / ค่าขนส่ง / ระยะเวลายืนราคา' },
]
const PR_HEADERS = PR_COLS.map(c => c.key)

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

  // ตาราง PR / PO ต่อ Job — เริ่มต้นซ่อนทั้งคู่ (หน้านี้ยาวมากเมื่อมีงานหลายใบ)
  // แยก state คนละตัวเพื่อให้กาง PR อย่างเดียวได้โดยไม่ต้องกาง PO ตามไปด้วย
  // ⚠️ ชื่อ `openPo` ถูกใช้เป็นฟังก์ชันเปิดโมดัลออก PO อยู่แล้ว — state ใช้ชื่อ prOpen/poOpen แทน
  const [prOpen, setPrOpen] = useState<Record<string, boolean>>({})
  const [poOpen, setPoOpen] = useState<Record<string, boolean>>({})
  const togglePr = (id: string) => setPrOpen(p => ({ ...p, [id]: !p[id] }))
  const togglePo = (id: string) => setPoOpen(p => ({ ...p, [id]: !p[id] }))

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

  // ---------------- Export PR ที่ยังไม่ได้ออก PO → Excel template ขอราคา ----------------
  // นับเฉพาะ line ที่ยัง `pr_sent` (ยังไม่ผูก PO) — ใบที่ออก PO บางส่วนแล้วจะได้เฉพาะส่วนที่เหลือ
  // jobId = undefined → ทั้งระบบ (Purchasing ใช้รวบยอดสั่งของประจำวัน) · ระบุ → เฉพาะงานนั้น
  const prTemplateRows = (jobId?: string) =>
    db.prs
      .filter(pr => (pr.status === 'pending' || pr.status === 'po_issued') && (!jobId || pr.jobId === jobId))
      .flatMap(pr => {
        const job = db.jobs.find(j => j.id === pr.jobId)
        return unorderedLines(pr.id).map(r => {
          const it = itemOf(r.itemId)
          const est = r.unitPrice !== undefined ? r.unitPrice * r.qtyRequested : undefined
          const phaseKey = r.phaseBudget as CostCategoryKey | undefined
          return {
            'PR No.': pr.prNo,
            'Job No.': job?.jobNo ?? '',
            'Customer': job?.customerName ?? '',
            'รหัส Epicor': it?.epicorCode || '',
            'ชื่ออุปกรณ์': it?.name ?? '',
            'จำนวน': r.qtyRequested,
            'หน่วย': it?.uom ?? '',
            'ราคาประมาณการ/หน่วย': r.unitPrice ?? '',
            'มูลค่าประมาณการ': est ?? '',
            'Phase Budget': phaseKey ? (COST_LABEL[phaseKey] ?? phaseKey) : '',
            'Phase': phaseKey ? (job?.budgetCosts?.[phaseKey]?.phase ?? '') : '',
            'วันที่ออก PR': pr.createdAt.slice(0, 10),
            // ช่องให้ซัพพลายเออร์กรอก — ต้องออกเป็นสตริงว่าง ไม่ใช่ undefined
            // ไม่งั้น SheetJS ข้ามคีย์นั้นแล้วเซลล์หายไปทั้งช่อง (หัวตารางมี แต่ไม่มีที่ให้พิมพ์)
            'ราคาที่เสนอ/หน่วย': '', 'มูลค่าที่เสนอ': '',
            'ยี่ห้อ/รุ่นที่เสนอ': '', 'กำหนดส่งได้': '', 'หมายเหตุ': '',
          }
        })
      })

  const exportPrTemplate = async (jobId?: string) => {
    const rows = prTemplateRows(jobId)
    const scope = jobId ? (db.jobs.find(j => j.id === jobId)?.jobNo ?? 'job') : 'ทุกงาน'
    if (rows.length === 0) return
    const XLSX = await import('xlsx')
    // header: บังคับลำดับคอลัมน์ + ไม่มีรายการก็ยังได้หัวตารางครบ (ใช้เป็นแบบฟอร์มเปล่าได้)
    const ws = XLSX.utils.json_to_sheet(rows, { header: PR_HEADERS })
    ws['!cols'] = PR_COLS.map(c => ({ wch: c.width }))
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: PR_COLS.length - 1 } }) }

    const guide = [
      [`ใบขอราคา (PR ที่ยังไม่ได้ออก PO) — ${scope}`],
      [`ออกจากระบบเมื่อ ${fmtDateTime(new Date().toISOString())} · ${rows.length} รายการ`],
      [],
      ['คอลัมน์', 'ใครกรอก', 'คำอธิบาย'],
      ...PR_COLS.map(c => [c.key, c.io === 'auto' ? 'ระบบเติมให้' : '⬅ ซัพพลายเออร์กรอก', c.note]),
      [],
      ['วิธีใช้'],
      ['1', 'ส่งไฟล์นี้ให้ซัพพลายเออร์กรอก 5 คอลัมน์ท้าย (ราคาที่เสนอ / มูลค่า / ยี่ห้อ-รุ่น / กำหนดส่ง / หมายเหตุ)'],
      ['2', 'ได้ราคากลับมาแล้ว เทียบเจ้าที่ถูกที่สุด แล้วกด "ออก PO" บนหน้าเว็บ — 1 PR แตกได้หลาย PO'],
      ['3', 'ไฟล์นี้ Import กลับเข้าระบบไม่ได้ · ราคาจริงบันทึกที่ปุ่ม 💰 ราคาจริง ในตาราง PO หลังออก PO แล้ว'],
      ['4', 'ราคาประมาณการเป็นตัวเลขที่ Project ใช้ตั้งงบ ไม่ใช่ราคาที่ตกลงกับซัพ — ใช้เป็นกรอบเทียบเท่านั้น'],
      ['5', 'จำนวนที่แสดงคือส่วนที่ยังไม่ได้ออก PO เท่านั้น ส่วนที่ออก PO ไปแล้วไม่อยู่ในไฟล์นี้'],
    ]
    const wsGuide = XLSX.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 24 }, { wch: 22 }, { wch: 90 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'PR รอออก PO')
    XLSX.utils.book_append_sheet(wb, wsGuide, 'วิธีใช้')
    XLSX.writeFile(wb, `PR-${scope.replace(/[\\/:*?"<>|]/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }
  const totalPrLines = prTemplateRows().length

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

      {/* Export รวมทุกงาน — ใช้รวบยอดสั่งของประจำวัน · ต่อ Job มีปุ่มแยกในแต่ละการ์ด */}
      {totalPrLines > 0 && (
        <div style={{ marginBottom: 14 }}>
          <button className="small" onClick={() => exportPrTemplate()}>
            ⬇ Export PR รอออก PO ทุกงาน ({totalPrLines} รายการ)
          </button>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            ไฟล์ Excel มีช่องว่างให้ซัพพลายเออร์กรอกราคา/กำหนดส่ง — ใช้ส่งขอราคาได้เลย
          </span>
        </div>
      )}

      {jobsWithDocs.length === 0 && (
        <div className="panel"><div className="empty">ยังไม่มี PR/PO — Project Dept ออก PR จากหน้า Job ก่อน</div></div>
      )}

      {jobsWithDocs.map(job => {
        const jobPrs = db.prs.filter(p => p.jobId === job.id)
        // PR ที่ยังมีรายการรอออก PO (pending หรือ po_issued ที่ยังสั่งไม่ครบ) — ออก PO เพิ่มได้เรื่อยๆ
        const prsToOrder = jobPrs.filter(p => (p.status === 'pending' || p.status === 'po_issued') && unorderedLines(p.id).length > 0)
        const jobPos = db.pos.filter(p => p.jobId === job.id)
        // จำนวน line ที่ยังไม่ได้ออก PO ของงานนี้ — ใช้ทั้งป้ายปุ่มซ่อน/แสดง และปุ่ม Export
        const prLineCount = prsToOrder.reduce((s, pr) => s + unorderedLines(pr.id).length, 0)
        return (
          <div className="panel" key={job.id}>
            <div className="panel-head">
              <h3>
                <Link to={`/jobs/${job.id}`}>{job.jobNo}</Link>{' '}
                <span className="muted" style={{ fontWeight: 400 }}>{job.customerName}</span>{' '}
                {prsToOrder.length > 0 && <span className="badge amber">มีรายการรอออก PO</span>}{' '}
                {jobPos.filter(p => p.status === 'issued').length > 0 && <span className="badge blue">PO รอรับของ {jobPos.filter(p => p.status === 'issued').length}</span>}
              </h3>
              {/* ตารางเริ่มต้นซ่อน — ป้ายบนหัวการ์ดบอกอยู่แล้วว่างานไหนต้องทำอะไร
                  กางเฉพาะใบที่จะลงมือ ไม่ต้องเลื่อนผ่านทุกงานที่ไม่เกี่ยว */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {prsToOrder.length > 0 && (
                  <button className="small" onClick={() => togglePr(job.id)}>
                    {prOpen[job.id] ? 'ซ่อน PR' : `แสดง PR รอออก PO (${prLineCount})`}
                  </button>
                )}
                {prLineCount > 0 && (
                  <button className="small" title="ไฟล์ Excel มีช่องว่างให้ซัพพลายเออร์กรอกราคา/กำหนดส่ง"
                    onClick={() => exportPrTemplate(job.id)}>⬇ Export PR</button>
                )}
                {jobPos.length > 0 && (
                  <button className="small" onClick={() => togglePo(job.id)}>
                    {poOpen[job.id] ? 'ซ่อน PO' : `แสดง PO (${jobPos.length})`}
                  </button>
                )}
              </div>
            </div>

            {prsToOrder.length > 0 && prOpen[job.id] && (
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

            {jobPos.length > 0 && poOpen[job.id] && (
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
                            // Purchasing บันทึกราคาจริงหลังออก PO — ราคาทับค่าประมาณการ กระทบงบ actual
                            // ⚠️ ใบแจ้งหนี้มาช้ากว่าของเสมอ → 0037 ปลดล็อกฝั่ง RPC ให้แก้ได้แม้ปิดงานแล้ว
                            //    (rpc_update_po_line_price ใช้ app_assert_job_cost_editable = ปิดเฉพาะ cancelled)
                            //    gate เดิม `!job.terminalStatus` ซ่อนปุ่มตั้งแต่ Issued → actual หมวด raw_mat/outsourcing
                            //    ค้างที่ค่าประมาณการถาวรทุกงาน ต้องตรงกับ guard ฝั่ง server
                            const canEditPrice = canManage && po.status !== 'cancelled'
                              && job.terminalStatus !== 'cancelled'
                              && (r.status === 'po_ordered' || r.status === 'received')
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
