import { useEffect, useRef, useState } from 'react'
import { sanitizeLetterHtml, findMisspellings, autoFormatThai, THAI_MISSPELLINGS } from '../data/letterRich'

// =============================================================================
// ตัวแก้ไขเนื้อความแบบ Word (Letters · 2026-11-26) — ไม่มี dependency ใหม่ (contentEditable + execCommand)
//   แถบเครื่องมือ: Undo/Redo · หนา/เอียง/ขีดเส้นใต้ · ขนาดตัวอักษร · จัดชิด 4 แบบ · รายการจุด/เลข · ย่อหน้า ·
//   ตาราง (แทรก/เพิ่ม-ลบแถว-คอลัมน์) · รูป (+ ความกว้าง) · จัดรูปแบบอัตโนมัติ · ตรวจคำผิด (พจนานุกรมในระบบ)
//   🔴 ทุกครั้งที่ส่งค่าออก / วาง (paste) ผ่าน sanitizeLetterHtml — ไม่มี HTML ดิบจากภายนอกเข้าตัวแก้ไข
//   รูป: ตัวแก้ไขแสดง signed URL + data-path ⇒ sanitizer แปลงกลับเป็น token "lbsimg:…" ตอนส่งค่าออก
// =============================================================================
const SIZES = ['14pt', '16pt', '18pt', '20pt', '24pt']
const HL_NAME = 'lbs-misspell'

type Uploaded = { src: string; path?: string }

export function RichLetterEditor({ initialHtml, onChange, disabled, uploadImage, onError }: {
  /** HTML สำหรับแสดง (รูป resolve เป็น URL แล้ว) — ใช้ครั้งเดียวตอนเปิด */
  initialHtml: string
  /** HTML ที่ sanitize แล้ว (รูปเป็น token) — เก็บลงฟอร์ม */
  onChange: (cleanHtml: string) => void
  disabled?: boolean
  uploadImage: (file: File) => Promise<Uploaded>
  onError: (msg: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const savedRange = useRef<Range | null>(null)
  const timer = useRef<number>()
  const [autoFmt, setAutoFmt] = useState(true)
  const [spell, setSpell] = useState<{ wrong: string; right: string; count: number }[]>([])
  const [showSpell, setShowSpell] = useState(false)
  const [selImg, setSelImg] = useState<HTMLImageElement | null>(null)
  const [tbl, setTbl] = useState({ open: false, rows: 3, cols: 3 })
  const [uploading, setUploading] = useState(false)

  // ---------- เริ่มต้น ----------
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.innerHTML = sanitizeForDisplay(initialHtml) || '<p><br></p>'
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); document.execCommand('styleWithCSS', false, 'false') } catch { /* ignore */ }
    checkSpelling()
    return () => { window.clearTimeout(timer.current); clearHighlights() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** แสดงผล: sanitize แล้วคงรูปที่ resolve เป็น URL ไว้ (initialHtml มาจาก resolveLetterImages ซึ่งผ่าน sanitizer แล้ว) */
  function sanitizeForDisplay(html: string): string { return html }

  function emit() {
    const el = ref.current
    if (!el) return
    onChange(sanitizeLetterHtml(el.innerHTML))
  }
  function emitSoon() {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { emit(); checkSpelling() }, 250)
  }

  // ---------- คำสั่งพื้นฐาน ----------
  function exec(cmd: string, val?: string) {
    if (disabled) return
    ref.current?.focus()
    document.execCommand(cmd, false, val)
    emitSoon()
  }
  function fontSize(pt: string) {
    exec('fontSize', '7')
    ref.current?.querySelectorAll('font[size="7"]').forEach(f => {
      const span = document.createElement('span')
      span.style.fontSize = pt
      span.innerHTML = f.innerHTML
      f.replaceWith(span)
    })
    emitSoon()
  }

  // ---------- ตาราง ----------
  function insertTable() {
    const r = Math.min(Math.max(tbl.rows, 1), 30), c = Math.min(Math.max(tbl.cols, 1), 10)
    const row = `<tr>${'<td><br></td>'.repeat(c)}</tr>`
    exec('insertHTML', `<table><tbody>${row.repeat(r)}</tbody></table><p><br></p>`)
    setTbl(t => ({ ...t, open: false }))
  }
  function currentCell(): HTMLTableCellElement | null {
    const n = window.getSelection()?.anchorNode
    const e = n instanceof Element ? n : n?.parentElement
    const td = e?.closest('td,th') as HTMLTableCellElement | null
    return td && ref.current?.contains(td) ? td : null
  }
  function tableOp(op: 'addRow' | 'addCol' | 'delRow' | 'delCol') {
    const td = currentCell()
    if (!td) { onError('วางเคอร์เซอร์ในช่องของตารางก่อน'); return }
    const tr = td.parentElement as HTMLTableRowElement
    const table = td.closest('table')!
    const idx = td.cellIndex
    if (op === 'addRow') {
      const nr = document.createElement('tr')
      for (let i = 0; i < tr.cells.length; i++) { const c = document.createElement('td'); c.innerHTML = '<br>'; nr.appendChild(c) }
      tr.after(nr)
    } else if (op === 'addCol') {
      for (const row of Array.from(table.rows)) { const c = document.createElement('td'); c.innerHTML = '<br>'; row.cells[idx] ? row.cells[idx].after(c) : row.appendChild(c) }
    } else if (op === 'delRow') {
      tr.remove()
    } else {
      for (const row of Array.from(table.rows)) row.cells[idx]?.remove()
    }
    if (table.rows.length === 0 || table.rows[0].cells.length === 0) table.remove()
    emitSoon()
  }

  // ---------- รูป ----------
  function rememberRange() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange()
  }
  async function addImage(file: File | undefined) {
    if (!file) return
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { onError('แปะได้เฉพาะรูป PNG / JPEG / WebP'); return }
    setUploading(true)
    try {
      const up = await uploadImage(file)
      ref.current?.focus()
      const sel = window.getSelection()
      if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      document.execCommand('insertHTML', false,
        `<img src="${esc(up.src)}"${up.path ? ` data-path="${esc(up.path)}"` : ''} style="width:60%">`)
      emitSoon()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
    setUploading(false)
  }
  function setImgWidth(w: string) {
    if (!selImg) return
    selImg.style.width = w
    emitSoon()
  }

  // ---------- วาง (paste): sanitize ก่อนเข้า · รูปในคลิปบอร์ด = อัปโหลด ----------
  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault()
    const img = Array.from(e.clipboardData.files).find(f => f.type.startsWith('image/'))
    if (img) { rememberRange(); void addImage(img); return }
    const html = e.clipboardData.getData('text/html')
    const text = e.clipboardData.getData('text/plain')
    const clean = html
      ? sanitizeLetterHtml(html).replace(/<img [^>]*>/g, '')   // รูปจากที่อื่นต้องอัปโหลดผ่านปุ่มรูป (ไม่ลิงก์ออกนอกระบบ)
      : text.split(/\r?\n/).map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>')
    document.execCommand('insertHTML', false, clean)
    emitSoon()
  }

  // ---------- จัดรูปแบบอัตโนมัติ / ตรวจคำผิด ----------
  function textNodes(): Text[] {
    const el = ref.current
    if (!el) return []
    const out: Text[] = []
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text)
    return out
  }
  function autoFormat() {
    for (const t of textNodes()) {
      const v = autoFormatThai(t.data, { trim: false })
      if (v !== t.data) t.data = v
    }
    emit()
    checkSpelling()
  }
  function clearHighlights() {
    const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    hl?.delete(HL_NAME)
  }
  function checkSpelling() {
    const nodes = textNodes()
    const counts = new Map<string, number>()
    const ranges: Range[] = []
    for (const t of nodes) {
      for (const m of findMisspellings(t.data)) {
        counts.set(m.wrong, (counts.get(m.wrong) ?? 0) + 1)
        const r = document.createRange()
        r.setStart(t, m.index)
        r.setEnd(t, m.index + m.wrong.length)
        ranges.push(r)
      }
    }
    setSpell([...counts].map(([wrong, count]) => ({ wrong, right: THAI_MISSPELLINGS[wrong], count })))
    // ขีดเส้นใต้คำผิด (CSS Custom Highlight API) — ไม่แก้ DOM ⇒ ไม่ปนลงเนื้อความที่บันทึก · เบราว์เซอร์ที่ไม่รองรับ = ดูจากรายการ
    const g = window as unknown as { Highlight?: new (...r: Range[]) => unknown }
    const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    if (hl && g.Highlight) { if (ranges.length) hl.set(HL_NAME, new g.Highlight(...ranges)); else hl.delete(HL_NAME) }
  }
  function fixWord(wrong: string) {
    const right = THAI_MISSPELLINGS[wrong]
    for (const t of textNodes()) if (t.data.includes(wrong)) t.data = t.data.split(wrong).join(right)
    emit()
    checkSpelling()
  }
  function fixAll() { for (const s of spell) fixWord(s.wrong) }

  const total = spell.reduce((n, s) => n + s.count, 0)
  const B = ({ title, onClick, children, on }: { title: string; onClick: () => void; children: React.ReactNode; on?: boolean }) => (
    <button type="button" className={`rte-btn${on ? ' on' : ''}`} title={title} aria-label={title} disabled={disabled}
      onMouseDown={e => e.preventDefault()} onClick={onClick}>{children}</button>
  )

  return (
    <div className="rte">
      <div className="rte-bar" role="toolbar" aria-label="เครื่องมือจัดรูปแบบ">
        <B title="เลิกทำ (Ctrl+Z)" onClick={() => exec('undo')}>↶</B>
        <B title="ทำซ้ำ (Ctrl+Y)" onClick={() => exec('redo')}>↷</B>
        <span className="rte-sep" />
        <B title="ตัวหนา (Ctrl+B)" onClick={() => exec('bold')}><b>B</b></B>
        <B title="ตัวเอียง (Ctrl+I)" onClick={() => exec('italic')}><i>I</i></B>
        <B title="ขีดเส้นใต้ (Ctrl+U)" onClick={() => exec('underline')}><u>U</u></B>
        <select className="rte-size" title="ขนาดตัวอักษร" disabled={disabled} defaultValue=""
          onMouseDown={rememberRange}
          onChange={e => { const v = e.target.value; e.target.value = ''; if (!v) return
            const sel = window.getSelection(); if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
            fontSize(v) }}>
          <option value="">ขนาด</option>
          {SIZES.map(s => <option key={s} value={s}>{s.replace('pt', '')}</option>)}
        </select>
        <span className="rte-sep" />
        <B title="ชิดซ้าย" onClick={() => exec('justifyLeft')}>⯇</B>
        <B title="กึ่งกลาง" onClick={() => exec('justifyCenter')}>☰</B>
        <B title="ชิดขวา" onClick={() => exec('justifyRight')}>⯈</B>
        <B title="กระจายเต็มบรรทัด" onClick={() => exec('justifyFull')}>≣</B>
        <span className="rte-sep" />
        <B title="รายการจุด" onClick={() => exec('insertUnorderedList')}>•≡</B>
        <B title="รายการตัวเลข" onClick={() => exec('insertOrderedList')}>1≡</B>
        <B title="เพิ่มย่อหน้า" onClick={() => exec('indent')}>⇥</B>
        <B title="ลดย่อหน้า" onClick={() => exec('outdent')}>⇤</B>
        <span className="rte-sep" />
        <span className="rte-pop">
          <B title="แทรกตาราง" onClick={() => setTbl(t => ({ ...t, open: !t.open }))} on={tbl.open}>▦ ตาราง</B>
          {tbl.open && (
            <span className="rte-pop-body">
              <label>แถว <input type="number" min={1} max={30} value={tbl.rows} onChange={e => setTbl(t => ({ ...t, rows: Number(e.target.value) }))} /></label>
              <label>คอลัมน์ <input type="number" min={1} max={10} value={tbl.cols} onChange={e => setTbl(t => ({ ...t, cols: Number(e.target.value) }))} /></label>
              <button type="button" className="small primary" onMouseDown={e => e.preventDefault()} onClick={insertTable}>แทรก</button>
            </span>
          )}
        </span>
        <B title="เพิ่มแถวใต้ช่องที่เลือก" onClick={() => tableOp('addRow')}>+แถว</B>
        <B title="เพิ่มคอลัมน์ขวาช่องที่เลือก" onClick={() => tableOp('addCol')}>+คอลัมน์</B>
        <B title="ลบแถวที่เลือก" onClick={() => tableOp('delRow')}>−แถว</B>
        <B title="ลบคอลัมน์ที่เลือก" onClick={() => tableOp('delCol')}>−คอลัมน์</B>
        <span className="rte-sep" />
        <B title="แปะรูป (PNG / JPEG)" onClick={() => { rememberRange(); fileRef.current?.click() }}>{uploading ? '⏳ รูป' : '🖼️ รูป'}</B>
        {selImg && ref.current?.contains(selImg) && (
          <select className="rte-size" title="ความกว้างรูปที่เลือก" value="" disabled={disabled} onChange={e => setImgWidth(e.target.value)}>
            <option value="">กว้างรูป</option>
            {['25%', '40%', '60%', '80%', '100%'].map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
          onChange={e => { void addImage(e.target.files?.[0]); e.target.value = '' }} />
        <span className="rte-sep" />
        <B title="จัดวรรค/ช่องว่างตามแบบหนังสือราชการ (ทั้งเอกสาร)" onClick={autoFormat}>✨ จัดรูปแบบ</B>
        <B title="ตรวจคำที่มักเขียนผิด" onClick={() => { checkSpelling(); setShowSpell(v => !v) }} on={showSpell}>
          {total > 0 ? <span className="rte-warn">🔤 คำผิด {total}</span> : '🔤 ตรวจคำ ✓'}
        </B>
        <label className="rte-auto" title="จัดวรรคอัตโนมัติเมื่อพิมพ์เสร็จ (ออกจากช่องเนื้อความ)">
          <input type="checkbox" checked={autoFmt} onChange={e => setAutoFmt(e.target.checked)} /> อัตโนมัติ
        </label>
      </div>

      {showSpell && (
        <div className="rte-spell">
          {spell.length === 0
            ? <span className="muted">ไม่พบคำที่มักเขียนผิดในพจนานุกรมของระบบ</span>
            : <>
              {spell.map(s => (
                <span key={s.wrong} className="rte-spell-item">
                  <s>{s.wrong}</s> → <b>{s.right}</b>{s.count > 1 && ` (${s.count})`}
                  <button type="button" className="small" disabled={disabled} onClick={() => fixWord(s.wrong)}>แก้</button>
                </span>
              ))}
              <button type="button" className="small primary" disabled={disabled} onClick={fixAll}>แก้ทั้งหมด</button>
            </>}
        </div>
      )}

      <div ref={ref} className="rich rte-area" contentEditable={!disabled} suppressContentEditableWarning
        spellCheck lang="th" role="textbox" aria-multiline="true" aria-label="เนื้อความจดหมาย"
        onInput={emitSoon} onPaste={onPaste} onKeyUp={rememberRange} onMouseUp={rememberRange}
        onClick={e => setSelImg(e.target instanceof HTMLImageElement ? e.target : null)}
        onBlur={() => { if (autoFmt) autoFormat(); else emit() }} />
    </div>
  )
}
