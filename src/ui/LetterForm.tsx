import { useMemo, useState } from 'react'
import { useStore } from '../data/StoreContext'
import { activeSigners, cleanLetterInput, contractNosOfJob, letterPrefixFor, type LetterCategory, type LetterInput, type ServiceLetter } from '../data/letters'
import { Modal, useTryAction } from './components'
import { SignaturePad } from './SignaturePad'
import { buildLetterHtml, lbsLetterOrg, openPrintWindow, writePrintWindow } from './letterPdf'

// =============================================================================
// ฟอร์มออกจดหมาย (0100) — ใช้ทั้งหน้า /letters และปุ่ม "ออก Warranty Letter" ในหน้า Service (Warranty)
//   Official Letter (GENERAL) · Service Official Letter (SM) · Warranty Letter (WARRANTY)
//   ผู้ลงนาม = dropdown จากรายชื่อที่ Manage ตั้ง · ลายเซ็น = เซ็นอิเล็กทรอนิกส์ หรือเว้นที่ให้เซ็นมือ
//   [Flow 2026-11-25] ① เลือก Job No. ก่อน (บังคับ) · เลขที่ PSP-LBSJXXXX-YYYY-nnn รันตาม Job ระบบออกให้ตอนบันทึก
// =============================================================================
export const LETTER_CATEGORY_LABEL: Record<LetterCategory, string> = {
  GENERAL: 'Official Letter',
  SM: 'Service Official Letter',
  WARRANTY: 'Warranty Letter',
}

type Form = LetterInput & { sigMode: 'hand' | 'esign' }

const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

export function LetterFormModal({ initial, onClose, onSaved }: {
  initial: LetterInput
  onClose: () => void
  onSaved?: (r: { id: string; letterNo: string }) => void
}) {
  const { db, act } = useStore()
  const tryAction = useTryAction()
  const start: Form = useMemo(() => ({
    category: 'GENERAL', letterType: 'EXTERNAL', letterDate: todayBkk(), ...initial,
    signerId: initial.signerId ?? '', sigMode: initial.sigImage ? 'esign' : 'hand',
  }), [initial])
  const [f, setF] = useState<Form>(start)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Form>) => setF(prev => ({ ...prev, ...patch }))
  const txt = (k: keyof LetterInput) => ({
    value: String(f[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set({ [k]: e.target.value } as Partial<Form>),
    disabled: saving,
  })

  const signers = activeSigners(db.letterSigners)
  const jobs = [...db.jobs].sort((a, b) => b.jobNo.localeCompare(a.jobNo))
  const cat = (f.category ?? 'GENERAL') as LetterCategory
  // Contract No. ที่มีในระบบ (รายเครื่อง 0087) — ตัวเลือกใน datalist · พิมพ์เองได้
  const contractOptions = [...new Set(db.lbsUnits.map(u => u.contractNo?.trim()).filter((c): c is string => !!c))].sort()
  const selectedJob = db.jobs.find(j => j.id === f.jobId)
  /** เลือก Job → เติม Contract No. ของเครื่องในงานนั้น (เปลี่ยน Job = เติมใหม่ · ภายในไม่ใช้ Contract No.) */
  const pickJob = (jobId: string | undefined) =>
    setF(prev => ({ ...prev, jobId,
      contractNo: cat === 'GENERAL' && prev.letterType === 'INTERNAL' ? undefined : contractNosOfJob(db.lbsUnits, jobId) || undefined }))
  const input = (): LetterInput => {
    const { sigMode, ...rest } = f
    return { ...rest, sigImage: sigMode === 'esign' ? f.sigImage : undefined }
  }
  const check = cleanLetterInput(input())
  const missing = !check.ok ? check.error : f.sigMode === 'esign' && !f.sigImage ? 'กรุณาเซ็นชื่อในกรอบ หรือเลือก "เว้นที่ให้เซ็นมือ"' : null
  const dirty = JSON.stringify(f) !== JSON.stringify(start)

  const preview = () => {
    if (!check.ok) return
    const w = openPrintWindow()              // เปิดแท็บตอนคลิก (ก่อน await) กัน popup blocker
    const signer = db.letterSigners.find(s => s.id === check.value.signerId)
    const lt: ServiceLetter = {
      ...check.value, id: 'preview',
      letterNo: `${letterPrefixFor(selectedJob?.jobNo ?? '', check.value.letterDate || todayBkk())}-… (ตัวอย่าง — ยังไม่ออกเลข)`,
      letterDate: check.value.letterDate || todayBkk(),
      signerName: signer?.fullName, signerPosition: signer?.position,
      createdBy: '', createdAt: new Date().toISOString(),
    }
    writePrintWindow(w, buildLetterHtml(lt, lbsLetterOrg(window.location.origin), db.jobs.find(j => j.id === lt.jobId)?.jobNo))
  }

  const save = async () => {
    setSaving(true)
    let res: { id: string; letterNo: string } | undefined
    const ok = await tryAction(async () => { res = await act.createServiceLetter(input()) })
    setSaving(false)
    if (ok && res) { onSaved?.(res); onClose() }
  }

  return (
    <Modal size="wide" title={`ออกจดหมาย — ${LETTER_CATEGORY_LABEL[cat]}`} locked={saving} dirty={dirty} onClose={onClose}
      footer={<>
        {missing && <div className="closeout-missing">{missing}</div>}
        <button disabled={saving} onClick={onClose}>ยกเลิก</button>
        <button disabled={saving || !check.ok} onClick={preview} title="เปิดตัวอย่างเอกสารในแท็บใหม่ (ยังไม่บันทึก)">👁️ ดูตัวอย่าง</button>
        <button className="primary" disabled={saving || !!missing} onClick={save}>{saving ? 'กำลังออกเลข…' : '✉️ ออกจดหมาย'}</button>
      </>}>
      {/* [Flow 2026-11-25] ① เลือก Job No. ก่อนเป็นอันดับแรก — เลขจดหมายรันตาม Job (PSP-LBSJXXXX-YYYY-nnn) */}
      <div className="panel" style={{ marginBottom: 12 }}><div className="panel-body">
        <label className="field" style={{ marginBottom: 6 }}><span>① Job No. * (เลือกก่อน — เลขจดหมายรันตาม Job)</span>
          <JobSelect jobs={jobs} value={f.jobId} disabled={saving} onChange={pickJob} placeholder="— เลือก Job No. —" />
        </label>
        <div className="muted" style={{ fontSize: 12 }}>
          {selectedJob
            ? <>เลขที่จะออก: <span className="mono"><b>{letterPrefixFor(selectedJob.jobNo, f.letterDate || todayBkk())}-nnn</b></span> (ระบบรันต่อจากฉบับล่าสุดของ Job นี้ตอนบันทึก)</>
            : <>รูปแบบเลขที่: <span className="mono">PSP-LBSJXXXX-ปี-nnn</span> · XXXX = ตัวเลขหลัง J ของ Job No.</>}
        </div>
      </div></div>

      <div className="subtabs seg" role="tablist">
        {(Object.keys(LETTER_CATEGORY_LABEL) as LetterCategory[]).map(c => (
          <button key={c} type="button" className={cat === c ? 'on' : ''} disabled={saving} onClick={() => set({ category: c })}>
            {LETTER_CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      <div className="row">
        <label className="field"><span>วันที่</span><input type="date" {...txt('letterDate')} /></label>
        {cat === 'GENERAL' && (
          <label className="field"><span>ชนิดหนังสือ</span>
            {/* ภายนอกอ้างอิง Contract No. · ภายในอ้างอิง Job No. (Job เลือกไว้ด้านบนแล้ว) · สลับเป็นภายในแล้วล้าง Contract No. */}
            <select value={f.letterType ?? 'EXTERNAL'} disabled={saving}
              onChange={e => set(e.target.value === 'INTERNAL'
                ? { letterType: 'INTERNAL', contractNo: undefined }
                : { letterType: 'EXTERNAL', contractNo: f.contractNo || contractNosOfJob(db.lbsUnits, f.jobId) || undefined })}>
              <option value="EXTERNAL">หนังสือภายนอก / Official Letter</option>
              <option value="INTERNAL">หนังสือภายใน / Internal Memo</option>
            </select>
          </label>
        )}
      </div>

      {/* การอ้างอิง (ผู้ใช้กำหนด 2026-11-25): ภายนอก = Contract No. · ภายใน = Job No. (จาก ①) · SM/Warranty = Contract No. + Job No. (จาก ①) */}
      {(cat !== 'GENERAL' || f.letterType !== 'INTERNAL') && (
        <label className="field"><span>อ้างอิง Contract No. (เติมจากเครื่องใน Job ให้ · แก้ได้)</span>
          <input list="letter-contract-nos" {...txt('contractNo')} placeholder="CT-2026-…" />
          <datalist id="letter-contract-nos">{contractOptions.map(c => <option key={c} value={c} />)}</datalist>
        </label>
      )}

      {cat === 'GENERAL' ? (<>
        <div className="row">
          <label className="field"><span>เรียน *</span><input {...txt('recipient')} placeholder="ผู้จัดการแผนก…" /></label>
          <label className="field"><span>หน่วยงาน</span><input {...txt('recipientOrg')} placeholder="กฟภ. / กฟผ. / บริษัท…" /></label>
        </div>
        <label className="field"><span>เรื่อง *</span><input {...txt('subject')} /></label>
        <div className="row">
          <label className="field"><span>อ้างถึง</span><input {...txt('reference')} /></label>
          <label className="field"><span>สิ่งที่ส่งมาด้วย</span><input {...txt('enclosure')} /></label>
        </div>
        <label className="field"><span>เนื้อความ *</span><textarea rows={7} {...txt('body')} /></label>
        <label className="field"><span>สำเนาเรียน</span><input {...txt('cc')} /></label>
      </>) : (<>
        <label className="field"><span>ผู้รับ + ที่อยู่ * (หลายบรรทัดได้)</span><textarea rows={3} {...txt('recipient')} /></label>
        <div className="row">
          <label className="field"><span>เรียน</span><input {...txt('attention')} placeholder="ผู้จัดการ…" /></label>
          <label className="field"><span>อ้างถึง</span><input {...txt('reference')} /></label>
        </div>
        <div className="row">
          <label className="field"><span>เรื่อง *</span><input {...txt('subject')} /></label>
          <label className="field"><span>สถานที่</span><input {...txt('site')} /></label>
        </div>
        <label className="field"><span>เนื้อความ ย่อหน้า 1 *</span><textarea rows={4} {...txt('body')} /></label>
        <label className="field"><span>เนื้อความ ย่อหน้า 2</span><textarea rows={3} {...txt('body2')} /></label>
        {cat === 'SM' && (
          <label className="field"><span>รายชื่อเจ้าหน้าที่ — บรรทัดละคน "ชื่อ | เบอร์"</span>
            <textarea rows={4} {...txt('techList')} placeholder={'ชื่อ นามสกุล | 08x-xxx-xxxx'} />
          </label>
        )}
        {cat === 'WARRANTY' && (<>
          <div className="row">
            <label className="field"><span>ประเภทการรับประกัน</span><input {...txt('warrantyType')} placeholder="งานติดตั้ง + ตัวเครื่อง LBS" /></label>
            <label className="field"><span>เริ่ม</span><input type="date" {...txt('warrantyStart')} /></label>
            <label className="field"><span>สิ้นสุด</span><input type="date" {...txt('warrantyEnd')} /></label>
          </div>
          <label className="field"><span>รายละเอียดการรับประกัน</span><textarea rows={4} {...txt('warrantyDetail')} /></label>
        </>)}
      </>)}

      <div className="panel" style={{ marginBottom: 0 }}><div className="panel-body">
        <label className="field"><span>ผู้ลงนาม * (รายชื่อที่ Manage ตั้ง)</span>
          <select value={f.signerId ?? ''} disabled={saving} onChange={e => set({ signerId: e.target.value })}>
            <option value="">— เลือกผู้ลงนาม —</option>
            {signers.map(s => <option key={s.id} value={s.id}>{s.fullName}{s.position ? ` — ${s.position}` : ''}</option>)}
          </select>
        </label>
        {signers.length === 0 && <div className="closeout-missing" style={{ marginBottom: 10 }}>ยังไม่มีรายชื่อผู้ลงนาม — ให้ Manage เพิ่มที่ Users &amp; System Settings</div>}
        <div className="seg" role="radiogroup" aria-label="รูปแบบลายเซ็น" style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button type="button" className={f.sigMode === 'hand' ? 'on primary' : ''} disabled={saving} onClick={() => set({ sigMode: 'hand' })}>✍️ เว้นที่ให้เซ็นมือ</button>
          <button type="button" className={f.sigMode === 'esign' ? 'on primary' : ''} disabled={saving} onClick={() => set({ sigMode: 'esign' })}>🖊️ เซ็นอิเล็กทรอนิกส์</button>
        </div>
        {f.sigMode === 'esign'
          ? <SignaturePad value={f.sigImage ?? ''} disabled={saving} onChange={sigImage => set({ sigImage })} />
          : <div className="muted" style={{ fontSize: 12 }}>เอกสารพิมพ์จะเว้นช่องเหนือชื่อผู้ลงนามไว้ให้เซ็นด้วยปากกา</div>}
      </div></div>
    </Modal>
  )
}

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
