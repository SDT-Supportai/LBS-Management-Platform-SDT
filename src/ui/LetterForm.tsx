import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../data/StoreContext'
import {
  activeSigners, cleanLetterInput, contractNosOfJob, letterPrefixFor, parseTechList, safeSigImage, thaiDateFull,
  type LetterCategory, type LetterInput, type ServiceLetter,
} from '../data/letters'
import { bodyToHtml, letterImagePaths, resolveLetterImages, imgStoragePath } from '../data/letterRich'
import { suggestLetterNo } from '../data/logic'
import { supabase } from '../lib/supabase'
import {
  fetchLetterSigImage, fetchNextLetterNo, removeLetterDocs, signedLetterImageUrls, uploadLetterImage,
} from '../data/remote'
import { Modal, useToast, useTryAction } from './components'
import { SignaturePad } from './SignaturePad'
import { RichLetterEditor } from './RichLetterEditor'
import { compressImage } from './photo'
import { buildLetterHtml, lbsLetterOrg, openPrintWindow, writePrintWindow, LETTER_ORG_DEFAULT, LETTER_RICH_CSS } from './letterPdf'

// =============================================================================
// Popup ออก/แก้จดหมายแบบ Word (2026-11-26) — ใช้ทั้งหน้า /letters และปุ่ม "ออก Warranty Letter"
//   ส่วนบน: ① Job No. (บังคับ) · เลขที่ (nnn แก้ได้ตอนออก · ค่าเริ่ม = เลขถัดไปอัตโนมัติ) · ประเภท · ช่องหัวจดหมาย · ผู้ลงนาม
//   ส่วนล่าง: หน้ากระดาษ A4 จริง (หัว/ท้าย PRECISE · TH SarabunPSK 16) — พิมพ์เนื้อความลงบนกระดาษได้ตรง ๆ
//   แก้ไขจดหมายที่ออกแล้ว (editLetter): Job / เลขที่ล็อก · บันทึกผู้แก้ใน Audit
//   รูป: LIVE อัปโหลดเข้า bucket letter-docs (letter-img/) · เดโมฝังเป็น data URL
// =============================================================================
export const LETTER_CATEGORY_LABEL: Record<LetterCategory, string> = {
  GENERAL: 'Official Letter',
  SM: 'Service Official Letter',
  WARRANTY: 'Warranty Letter',
}

type Form = LetterInput & { sigMode: 'hand' | 'esign' }

const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
const seqOf = (letterNo: string) => /-(\d+)$/.exec(letterNo)?.[1] ?? ''

function fromLetter(l: ServiceLetter): LetterInput {
  const { id: _i, letterNo: _n, createdBy: _c, createdAt: _a, signerName: _s, signerPosition: _p, updatedBy: _ub, updatedAt: _ua, ...rest } = l
  return rest
}

export function LetterFormModal({ initial = {}, editLetter, onClose, onSaved }: {
  initial?: LetterInput
  /** แก้ไขจดหมายที่ออกแล้ว (Job / เลขที่ล็อก) */
  editLetter?: ServiceLetter
  onClose: () => void
  onSaved?: (r: { id: string; letterNo: string }) => void
}) {
  const { db, act } = useStore()
  const tryAction = useTryAction()
  const { show } = useToast()
  const editing = !!editLetter
  const start: Form = useMemo(() => {
    const base = editLetter ? fromLetter(editLetter) : initial
    return {
      category: 'GENERAL', letterType: 'EXTERNAL', letterDate: todayBkk(), ...base,
      signerId: base.signerId ?? '', sigMode: base.sigImage ? 'esign' : 'hand',
    }
  }, [initial, editLetter])
  const [f, setF] = useState<Form>(start)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Form>) => setF(prev => ({ ...prev, ...patch }))
  const txt = (k: keyof LetterInput) => ({
    value: String(f[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set({ [k]: e.target.value } as Partial<Form>),
    disabled: saving,
  })

  // ---------- รูป + เนื้อความเริ่มต้นของตัวแก้ไข (LIVE ต้องขอ signed URL ก่อน) ----------
  const [imgUrls, setImgUrls] = useState<Record<string, string>>({})
  const [editorInit, setEditorInit] = useState<string | null>(null)
  const [sigReady, setSigReady] = useState(!editing || !supabase)
  const uploaded = useRef<string[]>([])      // token รูปที่อัปโหลดในหน้าต่างนี้ (ยกเลิก = ลบทิ้ง)
  const originalTokens = useMemo(() => letterImagePaths(bodyToHtml(start.body)), [start.body])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const html = bodyToHtml(start.body)
      let urls: Record<string, string> = {}
      if (supabase && originalTokens.length) {
        try { urls = await signedLetterImageUrls(supabase, originalTokens) } catch (e) { show(e instanceof Error ? e.message : String(e), true) }
      }
      if (cancelled) return
      setImgUrls(urls)
      setEditorInit(resolveLetterImages(html, urls))
      // LIVE: ลายเซ็นไม่ได้โหลดมากับรายการ ⇒ ดึงมาก่อน ไม่งั้นบันทึกแล้วลายเซ็นเดิมหาย
      if (editing && supabase && editLetter) {
        try {
          const sig = await fetchLetterSigImage(supabase, editLetter.id)
          if (!cancelled && sig) setF(prev => ({ ...prev, sigImage: sig, sigMode: 'esign' }))
        } catch (e) { show(e instanceof Error ? e.message : String(e), true) }
        if (!cancelled) setSigReady(true)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const uploadImage = async (file: File): Promise<{ src: string; path?: string }> => {
    const c = await compressImage(file, 1600, 0.85)
    if (!supabase) {
      if (c.dataUrl.length > 1_400_000) throw new Error('รูปใหญ่เกินไปสำหรับโหมดเดโม — ลองรูปที่เล็กกว่านี้')
      return { src: c.dataUrl }
    }
    const token = await uploadLetterImage(supabase, c.file, 'jpg')
    uploaded.current.push(token)
    const urls = await signedLetterImageUrls(supabase, [token])
    setImgUrls(prev => ({ ...prev, ...urls }))
    if (!urls[token]) throw new Error('อัปโหลดรูปแล้วแต่เปิดรูปไม่ได้')
    return { src: urls[token], path: token }
  }
  /** ลบรูปใน bucket ที่ไม่มีจดหมายไหนอ้างถึงแล้ว (best-effort — ไฟล์ค้างไม่กระทบผู้ใช้) */
  const removeImages = async (tokens: string[]) => {
    if (!supabase || tokens.length === 0) return
    await removeLetterDocs(supabase, tokens.map(imgStoragePath)).catch(() => undefined)
  }
  const close = () => { if (!saving) { void removeImages(uploaded.current); onClose() } }

  // ---------- Job / เลขที่ ----------
  const signers = activeSigners(db.letterSigners)
  const signerOptions = editing && editLetter?.signerId && !signers.some(s => s.id === editLetter.signerId)
    ? [...signers, ...db.letterSigners.filter(s => s.id === editLetter.signerId)] : signers
  const jobs = [...db.jobs].sort((a, b) => b.jobNo.localeCompare(a.jobNo))
  const cat = (f.category ?? 'GENERAL') as LetterCategory
  const contractOptions = [...new Set(db.lbsUnits.map(u => u.contractNo?.trim()).filter((c): c is string => !!c))].sort()
  const selectedJob = db.jobs.find(j => j.id === f.jobId)
  const pickJob = (jobId: string | undefined) =>
    setF(prev => ({ ...prev, jobId,
      contractNo: cat === 'GENERAL' && prev.letterType === 'INTERNAL' ? undefined : contractNosOfJob(db.lbsUnits, jobId) || undefined }))

  // nnn: ค่าเริ่ม = เลขถัดไปจากระบบ (LIVE ขอจาก server เพราะนับฉบับที่ลบแล้ว) · ผู้ใช้แก้ได้ตอนออกเท่านั้น
  const [seqSuggest, setSeqSuggest] = useState('')
  const [seqText, setSeqText] = useState('')
  const [seqTouched, setSeqTouched] = useState(false)
  useEffect(() => {
    if (editing || !f.jobId) { setSeqSuggest(''); return }
    let cancelled = false
    const done = (no: string) => { if (cancelled) return; const s = seqOf(no); setSeqSuggest(s); if (!seqTouched) setSeqText(s) }
    if (supabase) fetchNextLetterNo(supabase, f.jobId).then(done).catch(() => done(''))
    else done(suggestLetterNo(db, f.jobId))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.jobId, editing])
  const seqNo = !editing && seqTouched && seqText.trim() && seqText.trim() !== seqSuggest ? Number(seqText.trim()) : undefined
  const prefix = selectedJob ? letterPrefixFor(selectedJob.jobNo, todayBkk()) : 'PSP-LBSJXXXX-ปี'
  const letterNoShown = editing ? editLetter!.letterNo
    : `${prefix}-${seqText.trim() ? seqText.trim().padStart(3, '0') : 'nnn'}`

  // ---------- ตรวจ + บันทึก ----------
  const input = (): LetterInput => {
    const { sigMode, ...rest } = f
    return { ...rest, sigImage: sigMode === 'esign' ? f.sigImage : undefined, seqNo }
  }
  const check = cleanLetterInput(input())
  const missing = !check.ok ? check.error
    : f.sigMode === 'esign' && !f.sigImage ? 'กรุณาเซ็นชื่อในกรอบ หรือเลือก "เว้นที่ให้เซ็นมือ"'
    : !sigReady ? 'กำลังโหลดลายเซ็นเดิม…' : null
  const dirty = JSON.stringify(f) !== JSON.stringify(start) || seqTouched

  const letterFor = (): ServiceLetter | null => {
    if (!check.ok) return null
    const signer = db.letterSigners.find(s => s.id === check.value.signerId)
    return {
      ...check.value, id: editLetter?.id ?? 'preview',
      letterNo: editing ? editLetter!.letterNo : `${letterNoShown} (ตัวอย่าง — ยังไม่ออกเลข)`,
      letterDate: check.value.letterDate || todayBkk(),
      signerName: signer?.fullName ?? editLetter?.signerName, signerPosition: signer?.position ?? editLetter?.signerPosition,
      createdBy: '', createdAt: new Date().toISOString(),
    }
  }
  const preview = () => {
    const lt = letterFor()
    if (!lt) return
    const w = openPrintWindow()              // เปิดแท็บตอนคลิก (ก่อน await) กัน popup blocker
    writePrintWindow(w, buildLetterHtml(lt, lbsLetterOrg(window.location.origin), selectedJob?.jobNo, imgUrls))
  }

  const save = async () => {
    setSaving(true)
    let res: { id: string; letterNo: string } | undefined
    const ok = await tryAction(async () => {
      if (editing) {
        await act.updateServiceLetter({ letterId: editLetter!.id, ...input(), seqNo: undefined })
        res = { id: editLetter!.id, letterNo: editLetter!.letterNo }
      } else {
        res = await act.createServiceLetter(input())
      }
    })
    setSaving(false)
    if (ok && res) {
      // รูปที่ไม่อยู่ในเนื้อความสุดท้ายแล้ว (ลบออกระหว่างพิมพ์ / รูปเดิมที่เอาออกตอนแก้) = ลบไฟล์ทิ้ง
      const kept = new Set(letterImagePaths(f.body))
      void removeImages([...uploaded.current, ...originalTokens].filter(t => !kept.has(t)))
      uploaded.current = []
      onSaved?.(res)
      onClose()
    }
  }

  // ---------- หน้ากระดาษ A4 (แสดงเหมือนเอกสารพิมพ์) ----------
  const signer = signerOptions.find(s => s.id === f.signerId)
  const sig = f.sigMode === 'esign' ? safeSigImage(f.sigImage) : ''
  const org = LETTER_ORG_DEFAULT
  const lines = (s?: string) => String(s ?? '').split('\n').map((l, i) => <div key={i}>{l || ' '}</div>)
  const refRows = cat === 'GENERAL'
    ? (f.letterType === 'INTERNAL'
      ? (selectedJob ? [['อ้างอิง', `โครงการ Job No. ${selectedJob.jobNo}`]] : [])
      : (f.contractNo ? [['อ้างอิง', `Contract No. ${f.contractNo}`]] : []))
    : (f.contractNo || selectedJob ? [['อ้างอิง', `1. Contract No. ${f.contractNo || '-'}\n2. โครงการ Job No. ${selectedJob?.jobNo ?? '-'}`]] : [])
  const paperCss = useMemo(() => LETTER_RICH_CSS.replace(/\.rich/g, '.letter-paper .rich'), [])

  return (
    <Modal size="xl" title={`${editing ? 'แก้ไขจดหมาย' : 'ออกจดหมาย'} — ${LETTER_CATEGORY_LABEL[cat]}`} locked={saving} dirty={dirty} onClose={close}
      footer={<>
        {missing && <div className="closeout-missing">{missing}</div>}
        <button disabled={saving} onClick={close}>ยกเลิก</button>
        <button disabled={saving || !check.ok} onClick={preview} title="เปิดเอกสารพร้อมพิมพ์ในแท็บใหม่ (ยังไม่บันทึก)">👁️ ดูตัวอย่างพิมพ์</button>
        <button className="primary" disabled={saving || !!missing} onClick={save}>
          {saving ? 'กำลังบันทึก…' : editing ? '💾 บันทึกการแก้ไข' : '✉️ ออกจดหมาย'}
        </button>
      </>}>
      <style>{paperCss}</style>
      <div className="letter-compose">
        {/* ---------------- ส่วนหัวจดหมาย ---------------- */}
        <div className="panel letter-meta"><div className="panel-body">
          <div className="letter-meta-grid">
            <label className="field"><span>① Job No. * {editing ? '(ล็อก — เลขที่ผูกกับ Job)' : '(เลือกก่อน)'}</span>
              <JobSelect jobs={jobs} value={f.jobId} disabled={saving || editing} onChange={pickJob} />
            </label>
            <label className="field"><span>เลขที่ {editing ? '(แก้ไม่ได้หลังออก)' : '(nnn แก้ได้ · ค่าเริ่ม = อัตโนมัติ)'}</span>
              {editing
                ? <input className="mono" value={editLetter!.letterNo} disabled />
                : <div className="letter-no-input">
                    <span className="mono">{prefix}-</span>
                    <input className="mono" inputMode="numeric" value={seqText} disabled={saving || !selectedJob} placeholder="nnn"
                      onChange={e => { setSeqTouched(true); setSeqText(e.target.value.replace(/\D/g, '').slice(0, 5)) }} />
                    {seqTouched && seqText !== seqSuggest && seqSuggest && (
                      <button type="button" className="small" title="กลับไปใช้เลขอัตโนมัติ" onClick={() => { setSeqTouched(false); setSeqText(seqSuggest) }}>↺ อัตโนมัติ</button>
                    )}
                  </div>}
            </label>
            <label className="field"><span>วันที่</span><input type="date" {...txt('letterDate')} /></label>
          </div>

          <div className="subtabs seg" role="tablist">
            {(Object.keys(LETTER_CATEGORY_LABEL) as LetterCategory[]).map(c => (
              <button key={c} type="button" className={cat === c ? 'on' : ''} disabled={saving} onClick={() => set({ category: c })}>
                {LETTER_CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>

          <div className="letter-meta-grid">
            {cat === 'GENERAL' && (
              <label className="field"><span>ชนิดหนังสือ</span>
                <select value={f.letterType ?? 'EXTERNAL'} disabled={saving}
                  onChange={e => set(e.target.value === 'INTERNAL'
                    ? { letterType: 'INTERNAL', contractNo: undefined }
                    : { letterType: 'EXTERNAL', contractNo: f.contractNo || contractNosOfJob(db.lbsUnits, f.jobId) || undefined })}>
                  <option value="EXTERNAL">หนังสือภายนอก / Official Letter</option>
                  <option value="INTERNAL">หนังสือภายใน / Internal Memo</option>
                </select>
              </label>
            )}
            {(cat !== 'GENERAL' || f.letterType !== 'INTERNAL') && (
              <label className="field"><span>อ้างอิง Contract No.</span>
                <input list="letter-contract-nos" {...txt('contractNo')} placeholder="CT-2026-…" />
                <datalist id="letter-contract-nos">{contractOptions.map(c => <option key={c} value={c} />)}</datalist>
              </label>
            )}
            {cat === 'GENERAL' ? (<>
              <label className="field"><span>เรียน *</span><input {...txt('recipient')} placeholder="ผู้จัดการแผนก…" /></label>
              <label className="field"><span>หน่วยงาน</span><input {...txt('recipientOrg')} placeholder="กฟภ. / กฟผ. / บริษัท…" /></label>
              <label className="field span-2"><span>เรื่อง *</span><input {...txt('subject')} /></label>
              <label className="field"><span>อ้างถึง</span><input {...txt('reference')} /></label>
              <label className="field"><span>สิ่งที่ส่งมาด้วย</span><input {...txt('enclosure')} /></label>
              <label className="field span-2"><span>สำเนาเรียน</span><input {...txt('cc')} /></label>
            </>) : (<>
              <label className="field span-2"><span>ผู้รับ + ที่อยู่ * (หลายบรรทัดได้)</span><textarea rows={2} {...txt('recipient')} /></label>
              <label className="field"><span>เรียน</span><input {...txt('attention')} placeholder="ผู้จัดการ…" /></label>
              <label className="field"><span>อ้างถึง</span><input {...txt('reference')} /></label>
              <label className="field span-2"><span>เรื่อง *</span><input {...txt('subject')} /></label>
              <label className="field"><span>สถานที่</span><input {...txt('site')} /></label>
              <label className="field span-2"><span>ย่อหน้าท้าย (ถ้ามี — ต่อจากเนื้อความ)</span><textarea rows={2} {...txt('body2')} /></label>
              {cat === 'SM' && (
                <label className="field span-2"><span>รายชื่อเจ้าหน้าที่ — บรรทัดละคน "ชื่อ | เบอร์"</span>
                  <textarea rows={3} {...txt('techList')} placeholder={'ชื่อ นามสกุล | 08x-xxx-xxxx'} />
                </label>
              )}
              {cat === 'WARRANTY' && (<>
                <label className="field"><span>ประเภทการรับประกัน</span><input {...txt('warrantyType')} placeholder="งานติดตั้ง + ตัวเครื่อง LBS" /></label>
                <label className="field"><span>เริ่ม</span><input type="date" {...txt('warrantyStart')} /></label>
                <label className="field"><span>สิ้นสุด</span><input type="date" {...txt('warrantyEnd')} /></label>
                <label className="field span-2"><span>รายละเอียดการรับประกัน</span><textarea rows={3} {...txt('warrantyDetail')} /></label>
              </>)}
            </>)}
          </div>

          <div className="letter-meta-grid">
            <label className="field"><span>ผู้ลงนาม * (รายชื่อที่ Manage ตั้ง)</span>
              <select value={f.signerId ?? ''} disabled={saving} onChange={e => set({ signerId: e.target.value })}>
                <option value="">— เลือกผู้ลงนาม —</option>
                {signerOptions.map(s => <option key={s.id} value={s.id}>{s.fullName}{s.position ? ` — ${s.position}` : ''}{s.isActive ? '' : ' (ปิดใช้งาน)'}</option>)}
              </select>
            </label>
            <div className="field">
              <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>ลายเซ็น</span>
              <div className="seg" role="radiogroup" aria-label="รูปแบบลายเซ็น" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" className={f.sigMode === 'hand' ? 'on primary' : ''} disabled={saving} onClick={() => set({ sigMode: 'hand' })}>✍️ เว้นที่ให้เซ็นมือ</button>
                <button type="button" className={f.sigMode === 'esign' ? 'on primary' : ''} disabled={saving || !sigReady} onClick={() => set({ sigMode: 'esign' })}>🖊️ เซ็นอิเล็กทรอนิกส์</button>
              </div>
            </div>
          </div>
          {signers.length === 0 && <div className="closeout-missing" style={{ marginBottom: 10 }}>ยังไม่มีรายชื่อผู้ลงนาม — ให้ Manage เพิ่มที่ Users &amp; System Settings</div>}
          {f.sigMode === 'esign' && sigReady && <SignaturePad value={f.sigImage ?? ''} disabled={saving} onChange={sigImage => set({ sigImage })} />}
        </div></div>

        {/* ---------------- หน้ากระดาษ A4 ---------------- */}
        <div className="letter-paper-wrap">
          <div className={`letter-paper cat-${cat}`}>
            <div className="lp-head">
              <img className="lp-logo" src="/letter-logo.png" alt="PRECISE" />
              <div className="lp-addr"><b>{org.name}</b>{org.addressLines.map(l => <div key={l}>{l}</div>)}</div>
            </div>
            <div className="lp-body">
              <div className="lp-norow"><span>No. {letterNoShown}</span><span>{thaiDateFull(f.letterDate || todayBkk())}</span></div>
              {cat === 'GENERAL' ? (<>
                <div className="lp-ltype">{f.letterType === 'INTERNAL' ? 'หนังสือภายใน / Internal Memo' : 'หนังสือภายนอก / Official Letter'}</div>
                <Row k="เรื่อง">{f.subject || <Ph>เรื่อง…</Ph>}</Row>
                <Row k="เรียน">{f.recipient || <Ph>เรียน…</Ph>}{f.recipientOrg ? ` (${f.recipientOrg})` : ''}</Row>
                {refRows.map(([k, v]) => <Row key={k} k={k}>{lines(v)}</Row>)}
                {f.reference && <Row k="อ้างถึง">{f.reference}</Row>}
                {f.enclosure && <Row k="สิ่งที่ส่งมาด้วย">{f.enclosure}</Row>}
              </>) : (<>
                <div className="lp-recip">{f.recipient ? lines(f.recipient) : <Ph>ผู้รับ + ที่อยู่…</Ph>}</div>
                <Row k="เรื่อง">{f.subject || <Ph>เรื่อง…</Ph>}{f.site && <div>{f.site}</div>}</Row>
                <Row k="เรียน">{f.attention || '—'}</Row>
                {refRows.map(([k, v]) => <Row key={k} k={k}>{lines(v)}</Row>)}
                {f.reference && <Row k="อ้างถึง">{f.reference}</Row>}
              </>)}

              {editorInit == null
                ? <div className="muted" style={{ padding: '6mm 0' }}>กำลังโหลดเนื้อความ…</div>
                : <RichLetterEditor initialHtml={editorInit} disabled={saving} onChange={body => set({ body })}
                    uploadImage={uploadImage} onError={m => show(m, true)} />}

              {cat !== 'GENERAL' && f.body2 && <p className="lp-para">{f.body2}</p>}
              {cat === 'SM' && parseTechList(f.techList).length > 0 && (
                <div className="lp-techs">{parseTechList(f.techList).map((t, i) => (
                  <div key={i}><span>{i + 1}. {t.name}</span><span>{t.phone ? `เบอร์ ${t.phone}` : ''}</span></div>
                ))}</div>
              )}
              {cat === 'WARRANTY' && (
                <div className="lp-wbox">
                  <div><b>ประเภทการรับประกัน</b> {f.warrantyType || '-'}</div>
                  <div><b>ระยะเวลารับประกัน</b> {f.warrantyStart || f.warrantyEnd ? `${thaiDateFull(f.warrantyStart)} ถึง ${thaiDateFull(f.warrantyEnd)}` : '-'}</div>
                  {f.warrantyDetail && <div className="lp-wdetail">{lines(f.warrantyDetail)}</div>}
                </div>
              )}
              <p className="lp-para">จึงเรียนมาเพื่อโปรดทราบ</p>
              <div className="lp-close">
                <div>ขอแสดงความนับถือ</div>
                {sig ? <img className="lp-sig" src={sig} alt="ลายเซ็น" /> : <div className="lp-sig-space" />}
                <div><b>( {signer?.fullName ?? editLetter?.signerName ?? '—'} )</b></div>
                <div>{signer?.position ?? editLetter?.signerPosition ?? ''}</div>
              </div>
              {cat === 'GENERAL' && f.cc && <div className="lp-cc"><b>สำเนาเรียน</b> {f.cc}</div>}
            </div>
            <div className="lp-foot">
              <div className="lp-contact"><b>{org.section}</b>, {org.name}, Email: {org.email}</div>
              <img className="lp-banner" src="/letter-banner.png" alt="" />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="lp-row"><div className="lp-k">{k}</div><div className="lp-v">{children}</div></div>
)
const Ph = ({ children }: { children: React.ReactNode }) => <span className="lp-ph">{children}</span>

export function JobSelect({ jobs, value, onChange, disabled, placeholder = '— เลือก Job No. —' }: {
  jobs: { id: string; jobNo: string; customerName: string }[]
  value?: string
  onChange: (id: string | undefined) => void
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <select value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value || undefined)}>
      <option value="">{placeholder}</option>
      {jobs.map(j => <option key={j.id} value={j.id}>{j.jobNo} · {j.customerName}</option>)}
    </select>
  )
}
