import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../data/StoreContext'
import { canLetter, isAllowedLetterFile, LETTER_FILE_MAX_BYTES, type LetterCategory, type ServiceLetter } from '../data/letters'
import { Modal, readAsDataUrl, useConfirm, useToast, useTryAction } from '../ui/components'
import { LetterFormModal, LETTER_CATEGORY_LABEL } from '../ui/LetterForm'
import { buildLetterHtml, lbsLetterOrg, openPrintWindow, writePrintWindow } from '../ui/letterPdf'
import { fmtDate, fmtDateTime } from '../ui/format'
import { supabase } from '../lib/supabase'
import { uploadLetterDoc, signedLetterDocUrl, removeLetterDocs, fetchLetterSigImage } from '../data/remote'

// =============================================================================
// Letters (0100 · 2026-11-25) — ทะเบียนจดหมาย PSP-LBS-YYYY-NNN ยกจาก ServiceMS Service Letter
//   ดูได้ทุกแผนก · ออก/แนบไฟล์ = Service + Project + Manage · ลบ = Manage
//   📄 = เปิดเอกสารพร้อมพิมพ์ (สร้าง HTML ฝั่งเบราว์เซอร์) · 📎 = ไฟล์แนบ (private bucket letter-docs)
// =============================================================================
const CAT_TONE: Record<LetterCategory, string> = { GENERAL: 'blue', SM: 'amber', WARRANTY: 'green' }
// demo เก็บไฟล์เป็น data URL ใน localStorage — จำกัดเล็กกว่าเพื่อไม่ให้เต็มโควตาเบราว์เซอร์
const DEMO_MAX_BYTES = 2 * 1024 * 1024

export default function LettersPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { show } = useToast()
  const { ask, element: confirmEl } = useConfirm()
  const canManage = canLetter(user, 'manage')
  const canDelete = canLetter(user, 'delete')

  const [q, setQ] = useState('')
  const [cat, setCat] = useState<LetterCategory | ''>('')
  const [creating, setCreating] = useState(false)
  const [filesId, setFilesId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const jobNo = (id?: string) => (id ? db.jobs.find(j => j.id === id)?.jobNo : undefined)
  const userName = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  const text = q.trim().toLowerCase()
  const shown = db.serviceLetters
    .filter(l => !cat || l.category === cat)
    .filter(l => !text || [l.letterNo, l.subject, l.recipient, l.recipientOrg, l.signerName, jobNo(l.jobId)]
      .some(s => s?.toLowerCase().includes(text)))
  const filesOf = (letterId: string) => db.serviceLetterFiles.filter(f => f.letterId === letterId)
  const filesLetter = db.serviceLetters.find(l => l.id === filesId)

  const printLetter = async (l: ServiceLetter) => {
    const w = openPrintWindow()                     // ต้องเปิดตอนคลิก (ก่อน await) ไม่งั้น popup blocker
    if (!w) return
    try {
      // LIVE: ลายเซ็นไม่ได้โหลดมากับรายการ (remote.ts fetchLetterSigImage)
      const sigImage = supabase ? await fetchLetterSigImage(supabase, l.id) : l.sigImage
      writePrintWindow(w, buildLetterHtml({ ...l, sigImage }, lbsLetterOrg(window.location.origin), jobNo(l.jobId)))
    } catch (e) {
      w.close()
      show(e instanceof Error ? e.message : String(e), true)
    }
  }

  const addFiles = async (l: ServiceLetter, list: FileList | null) => {
    const maxBytes = supabase ? LETTER_FILE_MAX_BYTES : DEMO_MAX_BYTES
    const picked = Array.from(list ?? [])
    if (!picked.length) return
    setUploading(true)
    let ok = 0
    for (const f of picked) {
      if (f.size > maxBytes) { show(`${f.name}: ไฟล์ใหญ่เกิน ${maxBytes / 1024 / 1024} MB`, true); continue }
      if (!isAllowedLetterFile(f.type)) { show(`${f.name}: แนบได้เฉพาะ PDF / Word / Excel / รูปภาพ`, true); continue }
      let uploaded: string | undefined
      try {
        const filePath = supabase ? await uploadLetterDoc(supabase, l.id, f) : await readAsDataUrl(f)
        if (supabase) uploaded = filePath
        await act.addLetterFile({ letterId: l.id, fileName: f.name, filePath, mimeType: f.type, sizeBytes: f.size })
        ok++
      } catch (err) {
        // อัปโหลดแล้วแต่บันทึกไม่ผ่าน = ลบไฟล์ใน Storage ทิ้ง ไม่ให้ค้างเป็นไฟล์กำพร้า
        if (uploaded && supabase) await removeLetterDocs(supabase, [uploaded]).catch(() => undefined)
        show(err instanceof Error ? err.message : `แนบ ${f.name} ไม่สำเร็จ`, true)
      }
    }
    setUploading(false)
    if (ok) show(`แนบไฟล์แล้ว ${ok} ไฟล์`)
  }

  const openFile = async (filePath: string) => {
    try {
      const url = supabase ? await signedLetterDocUrl(supabase, filePath) : filePath
      window.open(url, '_blank', 'noopener')
    } catch (e) { show(e instanceof Error ? e.message : String(e), true) }
  }

  return (
    <>
      <div className="page-title">Letters</div>
      <div className="page-sub">
        ทะเบียนจดหมายออก <span className="mono">PSP-LBS-YYYY-NNN</span> — Official Letter · Service Official Letter · Warranty Letter
        {!canManage && <> · <span className="muted">ออกจดหมายได้เฉพาะ Service / Project / Manage</span></>}
      </div>

      <div className="panel"><div className="panel-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {(Object.keys(LETTER_CATEGORY_LABEL) as LetterCategory[]).map(c => (
          <span key={c} className={`badge ${CAT_TONE[c]}`}>{LETTER_CATEGORY_LABEL[c]} {db.serviceLetters.filter(l => l.category === c).length}</span>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="search-input" placeholder="ค้นหา เลขที่ / เรื่อง / ผู้รับ / Job" value={q} onChange={e => setQ(e.target.value)} style={{ width: 260 }} />
          <select value={cat} style={{ width: 'auto' }} onChange={e => setCat(e.target.value as LetterCategory | '')}>
            <option value="">ทุกประเภท</option>
            {(Object.keys(LETTER_CATEGORY_LABEL) as LetterCategory[]).map(c => <option key={c} value={c}>{LETTER_CATEGORY_LABEL[c]}</option>)}
          </select>
          {canManage && <button className="primary" onClick={() => setCreating(true)}>+ ออกจดหมาย</button>}
        </div>
      </div></div>

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>เลขที่</th><th>วันที่</th><th>ประเภท</th><th>เรื่อง / ผู้รับ</th><th>Job</th><th>ผู้ลงนาม</th><th>ออกโดย</th><th></th>
            </tr></thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={8}><div className="empty">
                  {db.serviceLetters.length === 0 ? 'ยังไม่มีจดหมาย' : 'ไม่พบรายการตามเงื่อนไข'}
                </div></td></tr>
              )}
              {shown.map(l => (
                <tr key={l.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}><b>{l.letterNo}</b></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.letterDate)}</td>
                  <td><span className={`badge ${CAT_TONE[l.category]}`}>{LETTER_CATEGORY_LABEL[l.category]}</span>
                    {l.category === 'GENERAL' && <div className="muted" style={{ fontSize: 11 }}>{l.letterType === 'INTERNAL' ? 'ภายใน' : 'ภายนอก'}</div>}
                  </td>
                  <td style={{ minWidth: 220 }}>{l.subject}
                    <div className="muted" style={{ fontSize: 12 }}>{l.recipient.split('\n')[0]}{l.recipientOrg ? ` · ${l.recipientOrg}` : ''}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{l.jobId ? <Link to={`/jobs/${l.jobId}`}>{jobNo(l.jobId) ?? '-'}</Link> : <span className="muted">-</span>}</td>
                  <td style={{ minWidth: 140 }}>{l.signerName}<div className="muted" style={{ fontSize: 12 }}>{l.signerPosition}</div></td>
                  <td style={{ minWidth: 120 }}>{userName(l.createdBy)}<div className="muted" style={{ fontSize: 12 }}>{fmtDateTime(l.createdAt)}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="small" title="ไฟล์แนบ" onClick={() => setFilesId(l.id)}>📎 {filesOf(l.id).length}</button>
                    <button className="small" style={{ marginLeft: 6 }} title="เปิดเอกสารพร้อมพิมพ์ / บันทึก PDF" onClick={() => printLetter(l)}>📄 PDF</button>
                    {canDelete && (
                      <button className="small danger" style={{ marginLeft: 6 }} title="ลบจดหมาย (Manage)"
                        onClick={async () => {
                          const n = filesOf(l.id).length
                          if (!await ask({ title: `ลบจดหมาย ${l.letterNo}`, description: `ลบแล้วกู้คืนไม่ได้${n ? ` · ไฟล์แนบ ${n} ไฟล์ถูกลบด้วย` : ''} · เลขที่นี้จะไม่ถูกนำกลับมาใช้ · บันทึกใน Audit Log`, confirmLabel: 'ลบจดหมาย' })) return
                          await tryAction(() => act.deleteServiceLetter({ letterId: l.id }), `ลบจดหมาย ${l.letterNo} แล้ว`)
                        }}>🗑</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {creating && (
        <LetterFormModal initial={{}} onClose={() => setCreating(false)}
          onSaved={r => show(`ออกจดหมาย ${r.letterNo} แล้ว — กด 📄 เพื่อพิมพ์ / 📎 เพื่อแนบไฟล์`)} />
      )}

      {filesLetter && (
        <Modal size="wide" title={`ไฟล์แนบ — ${filesLetter.letterNo}`} locked={uploading} onClose={() => setFilesId(null)}
          footer={<button onClick={() => setFilesId(null)}>ปิด</button>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span className="muted">{filesLetter.subject}</span>
            {canManage && (
              <label className="small" style={{ marginLeft: 'auto', cursor: 'pointer' }}>
                <span className="badge neutral">{uploading ? 'กำลังอัปโหลด…' : '+ แนบไฟล์'}</span>
                <input type="file" multiple style={{ display: 'none' }} disabled={uploading}
                  accept="application/pdf,image/png,image/jpeg,image/webp,.doc,.docx,.xls,.xlsx"
                  onChange={async e => { await addFiles(filesLetter, e.target.files); e.target.value = '' }} />
              </label>
            )}
          </div>
          {filesOf(filesLetter.id).length === 0 && <div className="muted">ยังไม่มีไฟล์แนบ</div>}
          {filesOf(filesLetter.id).map(f => (
            <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 4 }}>
              <button className="link-btn" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} onClick={() => openFile(f.filePath)}>
                {f.mimeType.startsWith('image/') ? '🖼️' : '📄'} {f.fileName}
              </button>
              <span className="muted">{fmtDateTime(f.uploadedAt)} · {userName(f.uploadedBy)}</span>
              {canManage && (
                <button className="small danger" onClick={async () => {
                  if (!await ask({ title: `ลบไฟล์ "${f.fileName}"`, description: 'ลบแล้วกู้คืนไม่ได้ · บันทึกใน Audit Log', confirmLabel: 'ลบไฟล์' })) return
                  await tryAction(() => act.deleteLetterFile({ fileId: f.id }), 'ลบไฟล์แล้ว')
                }}>ลบ</button>
              )}
            </div>
          ))}
        </Modal>
      )}
      {confirmEl}
    </>
  )
}
