import { useRef, useState } from 'react'
import { useStore, can } from '../data/StoreContext'
import { stdBomSummary } from '../data/logic'
import type { StdBomLineInput } from '../data/logic'
import { supabase } from '../lib/supabase'
import { Modal, useConfirm, useToast, useTryAction, toBudgetNum } from '../ui/components'
import { fmtBaht, fmtDateTime } from '../ui/format'

// PDF ที่แนบเก็บใน bucket เดิม install-photos prefix standard-drawings/ (0045)
// demo mode ไม่มี Storage → เก็บเป็น data URL ใน localStorage ซึ่งมีเพดาน ~5MB ทั้งฐาน
const DEMO_MAX_MB = 1

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'))
    r.readAsDataURL(file)
  })
}

interface DrawingForm {
  id: string | null
  title: string; drawingNo: string; description: string; revNote: string
  currentFileName?: string
}
// Standard Price list (0054) — โครงเดียวกับ DrawingForm (priceNo แทน drawingNo)
interface PriceForm {
  id: string | null
  title: string; priceNo: string; description: string; revNote: string
  currentFileName?: string
}
interface BomForm { id: string | null; title: string; bomNo: string; description: string }
interface LineForm {
  id: string | null; bomId: string
  itemId: string; epicorCode: string; name: string; qty: string; uom: string; estUnitCost: string; note: string
}

// preview ก่อนยืนยัน Import (0046) — โชว์ให้เห็นว่าแถวไหนผูกฐานข้อมูลได้/เป็น free text/ผิดพลาด
interface ImportPreview {
  bomId: string; bomTitle: string; existing: number
  rows: (StdBomLineInput & { linkedName?: string })[]
  errors: string[]
}

// อ่านค่าจากหัวตารางหลายรูปแบบ (ไทยตามไฟล์ Export / อังกฤษ)
function cell(row: Record<string, unknown>, keys: string[]): string {
  for (const [k, v] of Object.entries(row)) {
    if (keys.some(key => k.trim().toLowerCase() === key.toLowerCase())) return String(v ?? '').trim()
  }
  return ''
}

export default function StandardsPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  const { show } = useToast()
  const canManage = can(user, 'standards.manage')

  const [tab, setTab] = useState<'price' | 'drawing' | 'bom'>('price')
  const [drawingForm, setDrawingForm] = useState<DrawingForm | null>(null)
  const [priceForm, setPriceForm] = useState<PriceForm | null>(null)
  const [pdf, setPdf] = useState<{ file: File; dataUrl: string } | null>(null)
  const [bomForm, setBomForm] = useState<BomForm | null>(null)
  const [lineForm, setLineForm] = useState<LineForm | null>(null)
  const [openBoms, setOpenBoms] = useState<Set<string>>(new Set())
  const pdfInput = useRef<HTMLInputElement>(null)
  // Import Excel เข้า BOM (0046)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importMode, setImportMode] = useState<'append' | 'replace'>('append')
  const [importing, setImporting] = useState(false)
  const bomFileInput = useRef<HTMLInputElement>(null)
  const importToBom = useRef<{ id: string; title: string } | null>(null)

  const userOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  const drawings = [...db.stdDrawings].sort((a, b) => (a.drawingNo ?? a.title).localeCompare(b.drawingNo ?? b.title))
  const prices = [...db.stdPrices].sort((a, b) => (a.priceNo ?? a.title).localeCompare(b.priceNo ?? b.title))
  const boms = [...db.stdBoms].sort((a, b) => (a.bomNo ?? a.title).localeCompare(b.bomNo ?? b.title))

  const pickPdf = async (file?: File) => {
    if (!file) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      show('กรุณาเลือกไฟล์ PDF', true); return
    }
    if (!supabase && file.size > DEMO_MAX_MB * 1024 * 1024) {
      show(`โหมด demo รับไฟล์ไม่เกิน ${DEMO_MAX_MB} MB (เก็บใน localStorage) — บน LIVE ไม่จำกัด`, true); return
    }
    setPdf({ file, dataUrl: await readAsDataUrl(file) })
  }

  // LIVE: อัปโหลดเข้า Storage คืน public URL (path ใหม่ทุกครั้ง ไม่ทับ object เดิม)
  // demo: คืน data URL · ไม่ได้เลือกไฟล์ = undefined → ฝั่ง RPC/logic คงไฟล์เดิม
  const resolvePdfUrl = async (prefix = 'standard-drawings'): Promise<string | undefined> => {
    if (!pdf) return undefined
    if (!supabase) return pdf.dataUrl
    const safe = pdf.file.name.replace(/[^\w.\-]/g, '_')
    const path = `${prefix}/${Date.now()}-${safe}`
    const { error } = await supabase.storage.from('install-photos').upload(path, pdf.file, { upsert: false })
    if (error) throw new Error(`อัปโหลด PDF ไม่สำเร็จ: ${error.message} (ตรวจว่ามี bucket install-photos)`)
    return supabase.storage.from('install-photos').getPublicUrl(path).data.publicUrl
  }

  const saveDrawing = async () => {
    if (!drawingForm) return
    const ok = await tryAction(async () => {
      const fileUrl = await resolvePdfUrl()
      const base = {
        title: drawingForm.title, drawingNo: drawingForm.drawingNo,
        description: drawingForm.description,
        fileUrl, fileName: fileUrl ? pdf?.file.name : undefined,
      }
      await (drawingForm.id
        ? act.updateStdDrawing({ id: drawingForm.id, ...base, revNote: drawingForm.revNote })
        : act.createStdDrawing(base))
    }, drawingForm.id ? 'บันทึกการแก้ไข Drawing แล้ว' : 'เพิ่ม Drawing แล้ว')
    if (ok) { setDrawingForm(null); setPdf(null) }
  }

  // Standard Price list (0054) — ใช้ machinery เดียวกับ saveDrawing (pdf state + resolvePdfUrl)
  const savePrice = async () => {
    if (!priceForm) return
    const ok = await tryAction(async () => {
      const fileUrl = await resolvePdfUrl('standard-prices')
      const base = {
        title: priceForm.title, priceNo: priceForm.priceNo,
        description: priceForm.description,
        fileUrl, fileName: fileUrl ? pdf?.file.name : undefined,
      }
      await (priceForm.id
        ? act.updateStdPrice({ id: priceForm.id, ...base, revNote: priceForm.revNote })
        : act.createStdPrice(base))
    }, priceForm.id ? 'บันทึกการแก้ไขรายการราคาแล้ว' : 'เพิ่มรายการราคาแล้ว')
    if (ok) { setPriceForm(null); setPdf(null) }
  }

  const saveBom = async () => {
    if (!bomForm) return
    const p = { title: bomForm.title, bomNo: bomForm.bomNo, description: bomForm.description }
    if (await tryAction(
      () => bomForm.id ? act.updateStdBom({ id: bomForm.id, ...p }) : act.createStdBom(p),
      bomForm.id ? 'แก้ BOM แล้ว' : 'เพิ่ม BOM แล้ว',
    )) setBomForm(null)
  }

  const saveLine = async () => {
    if (!lineForm) return
    const p = {
      itemId: lineForm.itemId || undefined,
      epicorCode: lineForm.epicorCode, name: lineForm.name,
      qty: toBudgetNum(lineForm.qty), uom: lineForm.uom,
      estUnitCost: toBudgetNum(lineForm.estUnitCost), note: lineForm.note,
    }
    if (await tryAction(
      () => lineForm.id
        ? act.updateStdBomLine({ lineId: lineForm.id, ...p })
        : act.addStdBomLine({ bomId: lineForm.bomId, ...p }),
      lineForm.id ? 'แก้รายการแล้ว' : 'เพิ่มรายการแล้ว',
    )) setLineForm(null)
  }

  // อ่านไฟล์ Excel → preview (ยังไม่เขียน DB) · หัวตารางตรงกับไฟล์ที่ Export ออกไป
  const onPickBomFile = async (file: File) => {
    const target = importToBom.current
    if (!target) return
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer())
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      if (raw.length === 0) return show('ไฟล์ไม่มีข้อมูล — ต้องมีหัวตาราง ชื่ออุปกรณ์ และ จำนวน', true)

      const rows: ImportPreview['rows'] = []
      const errors: string[] = []
      raw.forEach((row, i) => {
        const ep = cell(row, ['รหัส Epicor', 'epicor', 'epicor_code', 'code'])
        const name = cell(row, ['ชื่ออุปกรณ์', 'ชื่อ', 'name', 'item'])
        const qtyStr = cell(row, ['จำนวน', 'qty', 'quantity'])
        const uom = cell(row, ['หน่วย', 'uom', 'unit'])
        const costStr = cell(row, ['ต้นทุนประมาณการ/หน่วย', 'ต้นทุนประมาณการ', 'ต้นทุน', 'est_unit_cost', 'unit_cost', 'cost'])
        const note = cell(row, ['หมายเหตุ', 'note', 'remark'])
        if (!ep && !name && !qtyStr) return                     // ข้ามแถวว่าง
        const no = `แถว ${i + 2}`
        // ผูกฐานข้อมูลวัสดุจากรหัส Epicor (แล้วค่อย code) — เหมือน logic ฝั่ง server
        const item = ep
          ? db.items.find(x => x.epicorCode === ep) ?? db.items.find(x => x.code === ep)
          : undefined
        if (!name && !item) return void errors.push(`${no}: ต้องมีชื่ออุปกรณ์ หรือรหัส Epicor ที่มีในฐานข้อมูลวัสดุ`)
        if (qtyStr === '' || Number.isNaN(Number(qtyStr)) || Number(qtyStr) <= 0)
          return void errors.push(`${no}: จำนวน "${qtyStr || '(ว่าง)'}" ต้องเป็นตัวเลขมากกว่า 0`)
        if (costStr !== '' && (Number.isNaN(Number(costStr)) || Number(costStr) < 0))
          return void errors.push(`${no}: ต้นทุนประมาณการ "${costStr}" ต้องเป็นตัวเลขไม่ติดลบ`)
        rows.push({
          itemId: item?.id, epicorCode: ep || undefined, name: name || undefined,
          qty: Number(qtyStr), uom: uom || undefined,
          estUnitCost: costStr === '' ? undefined : Number(costStr),
          note: note || undefined,
          linkedName: item?.name,
        })
      })
      if (rows.length === 0 && errors.length === 0) return show('ไม่พบแถวที่กรอกข้อมูลในไฟล์', true)
      setImportMode('append')
      setImportPreview({
        bomId: target.id, bomTitle: target.title,
        existing: db.stdBomLines.filter(l => l.bomId === target.id).length,
        rows, errors,
      })
    } catch {
      show('อ่านไฟล์ไม่ได้ — ต้องเป็นไฟล์ Excel (.xlsx)', true)
    }
  }

  const runBomImport = async () => {
    if (!importPreview) return
    setImporting(true)
    const lines = importPreview.rows.map(({ linkedName: _drop, ...l }) => l)
    const ok = await tryAction(
      () => act.importStdBomLines({ bomId: importPreview.bomId, replace: importMode === 'replace', lines }),
      `${importMode === 'replace' ? 'แทนที่ด้วย' : 'เพิ่ม'} ${lines.length} รายการ เข้า ${importPreview.bomTitle} แล้ว`,
    )
    setImporting(false)
    if (ok) {
      setImportPreview(null)
      setOpenBoms(prev => new Set(prev).add(importPreview.bomId))   // กางให้เห็นผลทันที
    }
  }

  const exportBom = async (bomId: string) => {
    const XLSX = await import('xlsx')
    const bom = db.stdBoms.find(b => b.id === bomId)!
    const { lines } = stdBomSummary(db, bomId)
    // BOM ว่าง → ออกไฟล์ที่มีแต่หัวตาราง ใช้เป็นแบบฟอร์มกรอกแล้ว Import กลับได้
    if (lines.length === 0) {
      const ws = XLSX.utils.aoa_to_sheet([[
        '#', 'รหัส Epicor', 'ชื่ออุปกรณ์', 'จำนวน', 'หน่วย',
        'ต้นทุนประมาณการ/หน่วย', 'มูลค่าประมาณการ', 'หมายเหตุ', 'ผูกฐานข้อมูลวัสดุ',
      ]])
      ws['!cols'] = [{ wch: 5 }, { wch: 16 }, { wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 28 }, { wch: 16 }]
      const wb0 = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb0, ws, (bom.bomNo ?? bom.title).slice(0, 31))
      XLSX.writeFile(wb0, `${(bom.bomNo ?? bom.title).replace(/[\\/:*?"<>|]/g, '-')}-template.xlsx`)
      return
    }
    const rows = lines.map((l, i) => ({
      '#': i + 1,
      'รหัส Epicor': l.epicorCode ?? '',
      'ชื่ออุปกรณ์': l.name,
      'จำนวน': l.qty,
      'หน่วย': l.uom ?? '',
      'ต้นทุนประมาณการ/หน่วย': l.estUnitCost ?? '',
      'มูลค่าประมาณการ': l.estUnitCost !== undefined ? l.estUnitCost * l.qty : '',
      'หมายเหตุ': l.note ?? '',
      'ผูกฐานข้อมูลวัสดุ': l.itemId ? 'ผูกแล้ว' : 'ยังไม่ผูก',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 5 }, { wch: 16 }, { wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 28 }, { wch: 16 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, (bom.bomNo ?? bom.title).slice(0, 31))
    XLSX.writeFile(wb, `${(bom.bomNo ?? bom.title).replace(/[\\/:*?"<>|]/g, '-')}.xlsx`)
  }

  const toggleBom = (id: string) => setOpenBoms(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  return (
    <>
      <div className="page-title">Standard Price list, Drawing and BOM List</div>
      <div className="page-sub">
        ราคามาตรฐาน · แบบมาตรฐาน · รายการวัสดุมาตรฐานของ LBS — ทุกแผนกเปิดดู/ดาวน์โหลดได้
        {canManage ? ' · คุณมีสิทธิ์เพิ่ม/แก้ไข' : ' · เพิ่ม/แก้ไขได้เฉพาะ Project / Division / Manage'}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className={tab === 'price' ? 'primary' : ''} onClick={() => setTab('price')}>
          💰 Standard Price list ({prices.length})
        </button>
        <button className={tab === 'drawing' ? 'primary' : ''} onClick={() => setTab('drawing')}>
          📐 Standard Drawing ({drawings.length})
        </button>
        <button className={tab === 'bom' ? 'primary' : ''} onClick={() => setTab('bom')}>
          📋 Standard BOM List ({boms.length})
        </button>
      </div>

      {/* ---------------- Standard Price list (0054) ---------------- */}
      {/* หลักการเดียวกับ Standard Drawing เป๊ะ: 1 รายการ = 1 แถว + PDF ล่าสุด · แก้ = ทับข้อมูลเดิม
          + stamp ผู้แก้/เวลา · ลบ = ลบทะเบียน ไฟล์ยังอยู่ใน Storage */}
      {tab === 'price' && (
        <>
          {canManage && (
            <div style={{ marginBottom: 12 }}>
              <button className="primary" onClick={() => {
                setPdf(null)
                setPriceForm({ id: null, title: '', priceNo: '', description: '', revNote: '' })
              }}>+ เพิ่มรายการราคา</button>
            </div>
          )}
          <div className="panel">
            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th>เลขเอกสารราคา</th><th>หัวข้อ / ชื่อรายการราคา</th><th>ไฟล์ PDF</th>
                  <th>แก้ไขล่าสุด</th><th>โดย</th><th>หมายเหตุการแก้ไข</th>{canManage && <th></th>}
                </tr></thead>
                <tbody>
                  {prices.length === 0 && (
                    <tr><td colSpan={canManage ? 7 : 6}><div className="empty">ยังไม่มี Standard Price list</div></td></tr>
                  )}
                  {prices.map(d => (
                    <tr key={d.id}>
                      <td className="mono">{d.priceNo || '-'}</td>
                      <td>{d.title}<div className="muted">{d.description || ''}</div></td>
                      <td>
                        {d.fileUrl
                          ? <a href={d.fileUrl} target="_blank" rel="noreferrer" download={d.fileName}>
                              📄 {d.fileName || 'ดาวน์โหลด PDF'}
                            </a>
                          : <span className="badge amber">ยังไม่แนบไฟล์</span>}
                      </td>
                      <td>{fmtDateTime(d.updatedAt ?? d.createdAt)}</td>
                      <td>{userOf(d.updatedBy ?? d.createdBy)}</td>
                      <td className="muted">{d.revNote || '-'}</td>
                      {canManage && (
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="small" onClick={() => {
                            setPdf(null)
                            setPriceForm({
                              id: d.id, title: d.title, priceNo: d.priceNo ?? '',
                              description: d.description ?? '', revNote: '',
                              currentFileName: d.fileName,
                            })
                          }}>แก้ไข</button>
                          <button className="small danger" style={{ marginLeft: 6 }} onClick={async () => {
                            if (await askConfirm({
                              title: `ลบรายการราคา "${d.title}"`,
                              description: <>
                                {d.priceNo && <>เลขเอกสาร <b className="mono">{d.priceNo}</b> · </>}
                                ทุกแผนกจะโหลดรายการราคานี้จากระบบไม่ได้อีก · <b>ไฟล์ PDF ยังอยู่ใน Storage</b> และ URL เดิมยังเปิดได้ (ลบรายการออกจากทะเบียนเท่านั้น)
                              </>,
                              confirmLabel: 'ลบรายการราคา',
                            })) tryAction(() => act.deleteStdPrice({ id: d.id }), 'ลบรายการราคาแล้ว')
                          }}>ลบ</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ---------------- Standard Drawing ---------------- */}
      {tab === 'drawing' && (
        <>
          {canManage && (
            <div style={{ marginBottom: 12 }}>
              <button className="primary" onClick={() => {
                setPdf(null)
                setDrawingForm({ id: null, title: '', drawingNo: '', description: '', revNote: '' })
              }}>+ เพิ่ม Drawing</button>
            </div>
          )}
          <div className="panel">
            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th>เลขแบบ</th><th>หัวข้อ / ชื่อ Drawing</th><th>ไฟล์ PDF</th>
                  <th>แก้ไขล่าสุด</th><th>โดย</th><th>หมายเหตุการแก้ไข</th>{canManage && <th></th>}
                </tr></thead>
                <tbody>
                  {drawings.length === 0 && (
                    <tr><td colSpan={canManage ? 7 : 6}><div className="empty">ยังไม่มี Standard Drawing</div></td></tr>
                  )}
                  {drawings.map(d => (
                    <tr key={d.id}>
                      <td className="mono">{d.drawingNo || '-'}</td>
                      <td>{d.title}<div className="muted">{d.description || ''}</div></td>
                      <td>
                        {d.fileUrl
                          ? <a href={d.fileUrl} target="_blank" rel="noreferrer" download={d.fileName}>
                              📄 {d.fileName || 'ดาวน์โหลด PDF'}
                            </a>
                          : <span className="badge amber">ยังไม่แนบไฟล์</span>}
                      </td>
                      <td>{fmtDateTime(d.updatedAt ?? d.createdAt)}</td>
                      <td>{userOf(d.updatedBy ?? d.createdBy)}</td>
                      <td className="muted">{d.revNote || '-'}</td>
                      {canManage && (
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="small" onClick={() => {
                            setPdf(null)
                            setDrawingForm({
                              id: d.id, title: d.title, drawingNo: d.drawingNo ?? '',
                              description: d.description ?? '', revNote: '',
                              currentFileName: d.fileName,
                            })
                          }}>แก้ไข</button>
                          <button className="small danger" style={{ marginLeft: 6 }} onClick={async () => {
                            if (await askConfirm({
                              title: `ลบ Drawing "${d.title}"`,
                              description: <>
                                {d.drawingNo && <>เลขแบบ <b className="mono">{d.drawingNo}</b> · </>}
                                ทุกแผนกจะโหลดแบบนี้จากระบบไม่ได้อีก · <b>ไฟล์ PDF ยังอยู่ใน Storage</b> และ URL เดิมยังเปิดได้ (ลบรายการออกจากทะเบียนเท่านั้น)
                              </>,
                              confirmLabel: 'ลบ Drawing',
                            })) tryAction(() => act.deleteStdDrawing({ id: d.id }), 'ลบ Drawing แล้ว')
                          }}>ลบ</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ---------------- Standard BOM List ---------------- */}
      {tab === 'bom' && (
        <>
          {canManage && (
            <div style={{ marginBottom: 12 }}>
              <button className="primary" onClick={() => setBomForm({ id: null, title: '', bomNo: '', description: '' })}>
                + เพิ่ม BOM
              </button>
            </div>
          )}
          {boms.length === 0 && <div className="panel"><div className="panel-body"><div className="empty">ยังไม่มี Standard BOM</div></div></div>}
          {boms.map(b => {
            const { lines, total, unlinked } = stdBomSummary(db, b.id)
            const open = openBoms.has(b.id)
            return (
              <div className="panel" key={b.id}>
                <div className="panel-head">
                  <h3>
                    {b.bomNo && <span className="mono">{b.bomNo} · </span>}{b.title}
                    <span className="badge blue" style={{ marginLeft: 8 }}>{lines.length} รายการ</span>
                    {total !== undefined && <span className="badge neutral" style={{ marginLeft: 6 }}>ประมาณการ {fmtBaht(total)}</span>}
                    {unlinked > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>ยังไม่ผูกฐานข้อมูล {unlinked}</span>}
                  </h3>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="small" onClick={() => toggleBom(b.id)}>{open ? 'ซ่อนรายการ' : 'ดูรายการ'}</button>
                    <button className="small" onClick={() => exportBom(b.id)}>
                      ⬇ Export Excel{lines.length === 0 ? ' (แบบฟอร์ม)' : ''}
                    </button>
                    {canManage && <>
                      <button className="small" onClick={() => {
                        importToBom.current = { id: b.id, title: b.title }
                        if (bomFileInput.current) bomFileInput.current.value = ''
                        bomFileInput.current?.click()
                      }}>⬆ Import Excel</button>
                      <button className="small" onClick={() => setBomForm({
                        id: b.id, title: b.title, bomNo: b.bomNo ?? '', description: b.description ?? '',
                      })}>แก้ไขหัวข้อ</button>
                      <button className="small danger" onClick={async () => {
                        if (await askConfirm({
                          title: `ลบ BOM "${b.title}"`,
                          description: <><b>รายการวัสดุ {lines.length} รายการในชุดนี้จะถูกลบไปด้วย</b> · กู้คืนไม่ได้ — ถ้าต้องการเก็บไว้ ให้กด ⬇ Export Excel ก่อนลบ</>,
                          confirmLabel: 'ลบ BOM ทั้งชุด',
                        })) tryAction(() => act.deleteStdBom({ id: b.id }), 'ลบ BOM แล้ว')
                      }}>ลบ</button>
                    </>}
                  </div>
                </div>
                <div className="panel-body muted" style={{ paddingBottom: 0 }}>
                  {b.description || 'ไม่มีคำอธิบาย'} · แก้ไขล่าสุด {fmtDateTime(b.updatedAt ?? b.createdAt)} โดย {userOf(b.updatedBy ?? b.createdBy)}
                </div>
                {open && (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead><tr>
                          <th>#</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th>
                          <th style={{ textAlign: 'right' }}>จำนวน</th><th>หน่วย</th>
                          <th style={{ textAlign: 'right' }}>ต้นทุนประมาณการ</th>
                          <th style={{ textAlign: 'right' }}>มูลค่า</th><th>หมายเหตุ</th>{canManage && <th></th>}
                        </tr></thead>
                        <tbody>
                          {lines.length === 0 && (
                            <tr><td colSpan={canManage ? 9 : 8}><div className="empty">ยังไม่มีรายการวัสดุใน BOM นี้</div></td></tr>
                          )}
                          {lines.map((l, i) => (
                            <tr key={l.id}>
                              <td>{i + 1}</td>
                              <td className="mono">
                                {l.epicorCode || '-'}
                                {!l.itemId && <span className="badge amber" style={{ marginLeft: 6 }}>free text</span>}
                              </td>
                              <td>{l.name}</td>
                              <td style={{ textAlign: 'right' }}>{l.qty.toLocaleString('th-TH')}</td>
                              <td>{l.uom || '-'}</td>
                              <td style={{ textAlign: 'right' }}>{fmtBaht(l.estUnitCost)}</td>
                              <td style={{ textAlign: 'right' }}>{l.estUnitCost !== undefined ? fmtBaht(l.estUnitCost * l.qty) : '-'}</td>
                              <td className="muted">{l.note || '-'}</td>
                              {canManage && (
                                <td style={{ whiteSpace: 'nowrap' }}>
                                  <button className="small" onClick={() => setLineForm({
                                    id: l.id, bomId: b.id, itemId: l.itemId ?? '',
                                    epicorCode: l.epicorCode ?? '', name: l.name, qty: String(l.qty),
                                    uom: l.uom ?? '', estUnitCost: l.estUnitCost !== undefined ? String(l.estUnitCost) : '',
                                    note: l.note ?? '',
                                  })}>แก้</button>
                                  <button className="small danger" style={{ marginLeft: 6 }} onClick={async () => {
                                    if (await askConfirm({
                                      title: `ลบรายการ "${l.name}"`,
                                      description: <>{l.epicorCode && <><b className="mono">{l.epicorCode}</b> · </>}จำนวน {l.qty} {l.uom ?? ''} — ลบออกจาก BOM "{b.title}"</>,
                                      confirmLabel: 'ลบรายการ',
                                    })) tryAction(() => act.deleteStdBomLine({ lineId: l.id }), 'ลบรายการแล้ว')
                                  }}>ลบ</button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {canManage && (
                      <div className="panel-body">
                        <button className="small" onClick={() => setLineForm({
                          id: null, bomId: b.id, itemId: '', epicorCode: '', name: '',
                          qty: '1', uom: '', estUnitCost: '', note: '',
                        })}>+ เพิ่มรายการวัสดุ</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </>
      )}

      {/* ไฟล์ Excel ต่อ BOM (ปุ่ม ⬆ Import Excel บนการ์ดเป็นคนกด) */}
      <input ref={bomFileInput} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onPickBomFile(f) }} />

      {/* ---------------- Modal: preview ก่อน Import ---------------- */}
      {importPreview && (
        <Modal
          title={`Import Excel → ${importPreview.bomTitle}`}
          size="wide"
          onClose={() => setImportPreview(null)}
          footer={<>
            <button onClick={() => setImportPreview(null)}>ยกเลิก</button>
            <button className="primary"
              disabled={importing || importPreview.errors.length > 0 || importPreview.rows.length === 0}
              onClick={runBomImport}>
              {importing ? 'กำลังนำเข้า…' : `นำเข้า ${importPreview.rows.length} รายการ`}
            </button>
          </>}
        >
          {importPreview.errors.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <b style={{ color: 'var(--danger)' }}>พบข้อผิดพลาด {importPreview.errors.length} จุด — แก้ในไฟล์แล้วนำเข้าใหม่</b>
              <ul className="muted" style={{ margin: '6px 0 0 18px' }}>
                {importPreview.errors.slice(0, 15).map((e, i) => <li key={i}>{e}</li>)}
                {importPreview.errors.length > 15 && <li>… และอีก {importPreview.errors.length - 15} จุด</li>}
              </ul>
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <div className="budget-legend">วิธีนำเข้า</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" checked={importMode === 'append'} onChange={() => setImportMode('append')} />
              <span><b>เพิ่มต่อท้าย</b> — คงรายการเดิม {importPreview.existing} รายการ แล้วเพิ่มจากไฟล์ {importPreview.rows.length} รายการ</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 4 }}>
              <input type="radio" checked={importMode === 'replace'} onChange={() => setImportMode('replace')} />
              <span>
                <b>แทนที่ทั้งหมด</b> — ใช้ไฟล์เป็นตัวจริง
                {importPreview.existing > 0 && (
                  <span style={{ color: 'var(--danger)' }}> · จะลบรายการเดิม {importPreview.existing} รายการ</span>
                )}
              </span>
            </label>
          </div>

          <div className="muted" style={{ marginBottom: 8 }}>
            หัวตารางที่อ่าน: <b>รหัส Epicor · ชื่ออุปกรณ์ · จำนวน · หน่วย · ต้นทุนประมาณการ/หน่วย · หมายเหตุ</b>
            (คอลัมน์ # / มูลค่า / ผูกฐานข้อมูลวัสดุ ในไฟล์ Export ถูกข้าม — ระบบคำนวณเอง) ·
            รหัส Epicor ที่ตรงกับ Material Database จะถูกผูกให้อัตโนมัติ ที่ไม่ตรงเก็บเป็น free text
          </div>

          <div className="table-scroll">
            <table>
              <thead><tr>
                <th>#</th><th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th>
                <th style={{ textAlign: 'right' }}>จำนวน</th><th>หน่วย</th>
                <th style={{ textAlign: 'right' }}>ต้นทุนประมาณการ</th><th>หมายเหตุ</th><th>ผูกฐานข้อมูล</th>
              </tr></thead>
              <tbody>
                {importPreview.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td className="mono">{r.epicorCode || '-'}</td>
                    <td>{r.name || r.linkedName}</td>
                    <td style={{ textAlign: 'right' }}>{r.qty?.toLocaleString('th-TH')}</td>
                    <td>{r.uom || '-'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBaht(r.estUnitCost)}</td>
                    <td className="muted">{r.note || '-'}</td>
                    <td>{r.itemId
                      ? <span className="badge green">{r.linkedName}</span>
                      : <span className="badge amber">free text</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {/* ---------------- Modal: Drawing ---------------- */}
      {drawingForm && (
        <Modal
          title={drawingForm.id ? 'แก้ไข Standard Drawing' : 'เพิ่ม Standard Drawing'}
          size="wide"
          onClose={() => { setDrawingForm(null); setPdf(null) }}
          footer={<>
            <button onClick={() => { setDrawingForm(null); setPdf(null) }}>ยกเลิก</button>
            <button className="primary" disabled={!drawingForm.title.trim()} onClick={saveDrawing}>บันทึก</button>
          </>}
        >
          <div className="row">
            <label className="field"><span>หัวข้อ / ชื่อ Drawing *</span>
              <input value={drawingForm.title}
                onChange={e => setDrawingForm({ ...drawingForm, title: e.target.value })}
                placeholder="Single Line Diagram — 115kV LBS Standard" />
            </label>
            <label className="field"><span>เลขแบบ (ห้ามซ้ำ · ว่างได้)</span>
              <input className="mono" value={drawingForm.drawingNo}
                onChange={e => setDrawingForm({ ...drawingForm, drawingNo: e.target.value })}
                placeholder="STD-SLD-001" />
            </label>
          </div>
          <label className="field"><span>คำอธิบาย</span>
            <textarea rows={2} value={drawingForm.description}
              onChange={e => setDrawingForm({ ...drawingForm, description: e.target.value })} />
          </label>
          <label className="field">
            <span>ไฟล์ PDF {drawingForm.id ? '(เลือกใหม่ = แทนไฟล์เดิม · ไม่เลือก = คงไฟล์เดิม)' : ''}</span>
            <input ref={pdfInput} type="file" accept="application/pdf,.pdf"
              onChange={e => pickPdf(e.target.files?.[0])} />
          </label>
          <div className="muted" style={{ marginBottom: 8 }}>
            {pdf
              ? <>ไฟล์ใหม่: <b>{pdf.file.name}</b> ({(pdf.file.size / 1024 / 1024).toFixed(2)} MB)</>
              : drawingForm.currentFileName
                ? <>ไฟล์ปัจจุบัน: <b>{drawingForm.currentFileName}</b></>
                : 'ยังไม่ได้เลือกไฟล์'}
            {!supabase && <> · โหมด demo รับไม่เกิน {DEMO_MAX_MB} MB</>}
          </div>
          {drawingForm.id && (
            <label className="field"><span>หมายเหตุการแก้ไขครั้งนี้ (จะแสดงในตารางพร้อมวันที่/ผู้แก้ไข)</span>
              <input value={drawingForm.revNote}
                onChange={e => setDrawingForm({ ...drawingForm, revNote: e.target.value })}
                placeholder="เช่น แก้ระยะ clearance ตามมาตรฐานใหม่" />
            </label>
          )}
        </Modal>
      )}

      {/* ---------------- Modal: Standard Price list (0054) ---------------- */}
      {priceForm && (
        <Modal
          title={priceForm.id ? 'แก้ไข Standard Price list' : 'เพิ่ม Standard Price list'}
          size="wide"
          onClose={() => { setPriceForm(null); setPdf(null) }}
          footer={<>
            <button onClick={() => { setPriceForm(null); setPdf(null) }}>ยกเลิก</button>
            <button className="primary" disabled={!priceForm.title.trim()} onClick={savePrice}>บันทึก</button>
          </>}
        >
          <div className="row">
            <label className="field"><span>หัวข้อ / ชื่อรายการราคา *</span>
              <input value={priceForm.title}
                onChange={e => setPriceForm({ ...priceForm, title: e.target.value })}
                placeholder="ราคามาตรฐาน 115kV LBS + อุปกรณ์ประกอบ ปี 2026" />
            </label>
            <label className="field"><span>เลขเอกสารราคา (ห้ามซ้ำ · ว่างได้)</span>
              <input className="mono" value={priceForm.priceNo}
                onChange={e => setPriceForm({ ...priceForm, priceNo: e.target.value })}
                placeholder="STD-PRICE-2026-01" />
            </label>
          </div>
          <label className="field"><span>คำอธิบาย</span>
            <textarea rows={2} value={priceForm.description}
              onChange={e => setPriceForm({ ...priceForm, description: e.target.value })}
              placeholder="เช่น ราคาอ้างอิงสำหรับตั้งงบ Job / ใช้ยื่นลูกค้า · มีผลถึงสิ้นปี" />
          </label>
          <label className="field">
            <span>ไฟล์ PDF {priceForm.id ? '(เลือกใหม่ = แทนไฟล์เดิม · ไม่เลือก = คงไฟล์เดิม)' : ''}</span>
            <input type="file" accept="application/pdf,.pdf"
              onChange={e => pickPdf(e.target.files?.[0])} />
          </label>
          <div className="muted" style={{ marginBottom: 8 }}>
            {pdf
              ? <>ไฟล์ใหม่: <b>{pdf.file.name}</b> ({(pdf.file.size / 1024 / 1024).toFixed(2)} MB)</>
              : priceForm.currentFileName
                ? <>ไฟล์ปัจจุบัน: <b>{priceForm.currentFileName}</b></>
                : 'ยังไม่ได้เลือกไฟล์'}
            {!supabase && <> · โหมด demo รับไม่เกิน {DEMO_MAX_MB} MB</>}
          </div>
          {priceForm.id && (
            <label className="field"><span>หมายเหตุการแก้ไขครั้งนี้ (จะแสดงในตารางพร้อมวันที่/ผู้แก้ไข)</span>
              <input value={priceForm.revNote}
                onChange={e => setPriceForm({ ...priceForm, revNote: e.target.value })}
                placeholder="เช่น ปรับราคาตามต้นทุนนำเข้าใหม่ Q3" />
            </label>
          )}
        </Modal>
      )}

      {/* ---------------- Modal: BOM header ---------------- */}
      {bomForm && (
        <Modal
          title={bomForm.id ? 'แก้ไขหัวข้อ BOM' : 'เพิ่ม Standard BOM'}
          size="wide"
          onClose={() => setBomForm(null)}
          footer={<>
            <button onClick={() => setBomForm(null)}>ยกเลิก</button>
            <button className="primary" disabled={!bomForm.title.trim()} onClick={saveBom}>บันทึก</button>
          </>}
        >
          <div className="row">
            <label className="field"><span>หัวข้อ / ชื่อ BOM *</span>
              <input value={bomForm.title} onChange={e => setBomForm({ ...bomForm, title: e.target.value })}
                placeholder="BOM มาตรฐาน — ติดตั้ง LBS 1 ชุด (Outdoor)" />
            </label>
            <label className="field"><span>เลข BOM (ห้ามซ้ำ · ว่างได้)</span>
              <input className="mono" value={bomForm.bomNo}
                onChange={e => setBomForm({ ...bomForm, bomNo: e.target.value })} placeholder="STD-BOM-001" />
            </label>
          </div>
          <label className="field"><span>คำอธิบาย</span>
            <textarea rows={2} value={bomForm.description}
              onChange={e => setBomForm({ ...bomForm, description: e.target.value })} />
          </label>
        </Modal>
      )}

      {/* ---------------- Modal: BOM line ---------------- */}
      {lineForm && (
        <Modal
          title={lineForm.id ? 'แก้รายการวัสดุ' : 'เพิ่มรายการวัสดุใน BOM'}
          size="wide"
          onClose={() => setLineForm(null)}
          footer={<>
            <button onClick={() => setLineForm(null)}>ยกเลิก</button>
            <button className="primary" onClick={saveLine}>บันทึก</button>
          </>}
        >
          <div className="muted" style={{ marginBottom: 12 }}>
            เลือกวัสดุจากฐานข้อมูล → รหัส Epicor / ชื่อ / หน่วย เติมให้เอง ·
            ถ้าเป็นของที่ยังไม่มีใน Material Database ให้เว้น "เลือกจากฐานข้อมูล" แล้วกรอกเอง (จะติดป้าย free text)
          </div>
          <label className="field"><span>เลือกจากฐานข้อมูลวัสดุ</span>
            <select value={lineForm.itemId} onChange={e => {
              const it = db.items.find(i => i.id === e.target.value)
              setLineForm({
                ...lineForm, itemId: e.target.value,
                epicorCode: it ? (it.epicorCode ?? it.code) : lineForm.epicorCode,
                name: it ? it.name : lineForm.name,
                uom: it ? it.uom : lineForm.uom,
              })
            }}>
              <option value="">— ไม่ผูก (กรอกเอง) —</option>
              {db.items.map(i => (
                <option key={i.id} value={i.id}>{(i.epicorCode ?? i.code)} · {i.name}</option>
              ))}
            </select>
          </label>
          <div className="row">
            <label className="field"><span>รหัส Epicor</span>
              <input className="mono" value={lineForm.epicorCode} disabled={!!lineForm.itemId}
                onChange={e => setLineForm({ ...lineForm, epicorCode: e.target.value })} />
            </label>
            <label className="field"><span>ชื่ออุปกรณ์ *</span>
              <input value={lineForm.name} disabled={!!lineForm.itemId}
                onChange={e => setLineForm({ ...lineForm, name: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <label className="field"><span>จำนวน *</span>
              <input type="number" min={0} step="any" value={lineForm.qty}
                onChange={e => setLineForm({ ...lineForm, qty: e.target.value })} />
            </label>
            <label className="field"><span>หน่วย</span>
              <input value={lineForm.uom} disabled={!!lineForm.itemId}
                onChange={e => setLineForm({ ...lineForm, uom: e.target.value })} placeholder="ชุด / ตัว / ม้วน" />
            </label>
          </div>
          <div className="row">
            <label className="field"><span>ต้นทุนประมาณการ/หน่วย (฿)</span>
              <input type="number" min={0} value={lineForm.estUnitCost}
                onChange={e => setLineForm({ ...lineForm, estUnitCost: e.target.value })} />
            </label>
            <label className="field"><span>หมายเหตุ</span>
              <input value={lineForm.note} onChange={e => setLineForm({ ...lineForm, note: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
      {confirmEl}
    </>
  )
}
