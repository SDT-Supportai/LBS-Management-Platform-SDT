import { useRef } from 'react'
import type { DB, Job, CloseoutFileKind, AcceptanceType, JobCloseoutFile } from '../types'
import {
  ACCEPTANCE_TYPES, CLOSEOUT_FILE_LABEL, WARRANTY_MONTH_PRESETS, MAX_DOC_FILE_MB, DEMO_MAX_DOC_FILE_MB,
  isAllowedDocFile, jobInstalledUnits, jobWarranties, closeoutFiles, warrantyEndFor, todayIso,
  type CloseoutInput, type CloseoutFileInput,
} from '../data/logic'
import { supabase } from '../lib/supabase'
import { uploadServiceDoc, signedServiceDocUrl } from '../data/remote'
import { readAsDataUrl } from './components'
import { fmtDate } from './format'

// =============================================================================
// ฟอร์มเอกสารรับมอบ + Warranty (0079) — ใช้ร่วมกัน 2 ที่:
//   (1) โมดัลปิดงานติดตั้ง (ServicePage)   (2) บันทึกย้อนหลัง/แก้ไข (WarrantyPage)
// กติกาเดียวกับ applyCloseout (logic.ts) / app_save_job_closeout (SQL) — ฟอร์มนี้แค่ช่วยกรอก
// + บอกว่ายังขาดอะไร · ตัวตัดสินจริงคือ RPC
// =============================================================================

export interface PendingDoc { key: string; kind: CloseoutFileKind; file: File; dataUrl?: string }
export interface LbsRow { unitId: string; serial: string; installedDate: string; start: string; end: string }
export interface CloseoutDraft {
  acceptanceType?: AcceptanceType
  acceptanceDocNo: string
  acceptanceDate: string
  instStart: string
  instMonths: number | 'custom'
  instEnd: string
  lbsMonths: number | 'custom'
  lbs: LbsRow[]
  pending: PendingDoc[]
}

const DEFAULT_MONTHS = 12

/** ค่าตั้งต้นของฟอร์ม — ใบที่เคยบันทึกไว้แล้ว (แก้ไข/ปิดใหม่หลัง reopen) ดึงค่าเดิมมาให้ */
export function initCloseoutDraft(db: DB, job: Job): CloseoutDraft {
  const ws = jobWarranties(db, job.id)
  const inst = ws.find(w => w.kind === 'installation')
  const lbs: LbsRow[] = jobInstalledUnits(db, job.id).map(({ unit, installedDate }) => {
    const prev = ws.find(w => w.kind === 'lbs' && w.unitId === unit.id)
    // มติผู้ใช้: Warranty LBS เริ่มนับจาก **วันที่ติดตั้งจริงรายเครื่อง**
    const start = prev?.startDate ?? installedDate
    return {
      unitId: unit.id, serial: `${unit.serialLvb} / ${unit.serialOm}`, installedDate,
      start, end: prev?.endDate ?? warrantyEndFor(start, DEFAULT_MONTHS),
    }
  })
  const instStart = inst?.startDate ?? ''
  return {
    acceptanceType: job.acceptanceType,
    acceptanceDocNo: job.acceptanceDocNo ?? '',
    acceptanceDate: job.acceptanceDate ?? '',
    instStart,
    instMonths: inst ? 'custom' : DEFAULT_MONTHS,
    instEnd: inst?.endDate ?? '',
    lbsMonths: ws.some(w => w.kind === 'lbs') ? 'custom' : DEFAULT_MONTHS,
    lbs,
    pending: [],
  }
}

/** สิ่งที่ยังขาด — ว่าง = ส่งได้ · ใช้ปิดปุ่ม + tooltip (นับไฟล์เดิมของ Job รวมด้วย) */
export function closeoutMissing(d: CloseoutDraft, existing: JobCloseoutFile[]): string[] {
  const miss: string[] = []
  const hasFile = (k: CloseoutFileKind) => existing.some(f => f.kind === k) || d.pending.some(p => p.kind === k)
  if (!d.acceptanceType) miss.push('เลือกประเภทเอกสารรับมอบ')
  if (!d.acceptanceDate) miss.push('วันที่เอกสารรับมอบ')
  // ไฟล์รับมอบต้องตรงประเภทที่เลือก — ไฟล์ใหม่ถูกติดป้ายตามประเภทที่เลือกตอนบันทึก · ไฟล์เดิมต้องเป็นประเภทนั้นอยู่แล้ว
  if (!existing.some(f => f.kind === 'acceptance' && f.docType === d.acceptanceType) && !d.pending.some(p => p.kind === 'acceptance'))
    miss.push(d.acceptanceType ? `ไฟล์เอกสารรับมอบ ${d.acceptanceType}` : 'ไฟล์เอกสารรับมอบ')
  if (!d.instStart || !d.instEnd) miss.push('วันเริ่ม–สิ้นสุด Warranty งานติดตั้ง')
  else if (d.instEnd < d.instStart) miss.push('Warranty งานติดตั้ง: วันสิ้นสุดก่อนวันเริ่ม')
  if (!hasFile('warranty_installation')) miss.push('ไฟล์ Warranty งานติดตั้ง')
  if (d.lbs.some(r => !r.start || !r.end)) miss.push('วันเริ่ม–สิ้นสุด Warranty LBS ให้ครบทุกเครื่อง')
  if (d.lbs.some(r => r.start && r.end && r.end < r.start)) miss.push('Warranty LBS: วันสิ้นสุดก่อนวันเริ่ม')
  if (d.lbs.length > 0 && !hasFile('warranty_lbs')) miss.push('ไฟล์ Warranty ตัวเครื่อง (LBS)')
  return miss
}

/** อัปโหลดไฟล์ที่รอไว้ (LIVE → private bucket service-docs · demo → data URL) แล้วประกอบเป็น input ของ RPC */
export async function buildCloseoutInput(d: CloseoutDraft, jobId: string): Promise<CloseoutInput> {
  const files: CloseoutFileInput[] = []
  for (const p of d.pending) {
    const filePath = supabase ? await uploadServiceDoc(supabase, jobId, p.file) : (p.dataUrl ?? await readAsDataUrl(p.file))
    files.push({
      kind: p.kind, docType: p.kind === 'acceptance' ? d.acceptanceType : undefined,
      fileName: p.file.name, filePath, mimeType: p.file.type, sizeBytes: p.file.size,
    })
  }
  return {
    acceptanceType: d.acceptanceType,
    acceptanceDocNo: d.acceptanceDocNo,
    acceptanceDate: d.acceptanceDate,
    installationWarranty: { start: d.instStart, end: d.instEnd },
    lbsWarranties: d.lbs.map(r => ({ unitId: r.unitId, start: r.start, end: r.end })),
    files,
  }
}

/** เปิดไฟล์: LIVE ขอ signed URL ใหม่ทุกครั้ง · demo = data URL อยู่แล้ว */
export async function openCloseoutFile(f: Pick<JobCloseoutFile, 'filePath'>) {
  const url = supabase ? await signedServiceDocUrl(supabase, f.filePath) : f.filePath
  window.open(url, '_blank', 'noopener')
}

const MonthSelect = ({ value, onChange }: { value: number | 'custom'; onChange: (v: number | 'custom') => void }) => (
  <select value={String(value)} onChange={e => onChange(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}>
    {WARRANTY_MONTH_PRESETS.map(m => <option key={m} value={m}>{m} เดือน{m % 12 === 0 ? ` (${m / 12} ปี)` : ''}</option>)}
    <option value="custom">กำหนดวันสิ้นสุดเอง</option>
  </select>
)

export function CloseoutForm({ db, job, draft, onChange, onError, disabled }: {
  db: DB; job: Job; draft: CloseoutDraft
  onChange: (d: CloseoutDraft) => void
  onError: (msg: string) => void
  disabled?: boolean
}) {
  const existing = closeoutFiles(db, job.id)
  const maxMb = supabase ? MAX_DOC_FILE_MB : DEMO_MAX_DOC_FILE_MB
  // อ่านไฟล์เป็น data URL (demo) เป็น async — ตอนเสร็จ draft ใน closure อาจเก่าแล้ว ⇒ อ่านจาก ref ตัวล่าสุดเสมอ
  const latest = useRef(draft)
  latest.current = draft
  const set = (patch: Partial<CloseoutDraft>) => onChange({ ...latest.current, ...patch })

  // Installation: เลือกระยะเวลา → วันสิ้นสุดคำนวณให้ · "กำหนดเอง" = แก้วันสิ้นสุดได้อิสระ
  const setInst = (start: string, months: number | 'custom', end?: string) =>
    set({ instStart: start, instMonths: months, instEnd: months === 'custom' ? (end ?? draft.instEnd) : warrantyEndFor(start, months) })
  const setLbsMonths = (months: number | 'custom') => set({
    lbsMonths: months,
    lbs: months === 'custom' ? draft.lbs : draft.lbs.map(r => ({ ...r, end: warrantyEndFor(r.start, months) })),
  })
  const setLbsRow = (unitId: string, patch: Partial<LbsRow>) => set({
    lbs: draft.lbs.map(r => {
      if (r.unitId !== unitId) return r
      const next = { ...r, ...patch }
      if (patch.start !== undefined && draft.lbsMonths !== 'custom') next.end = warrantyEndFor(next.start, draft.lbsMonths)
      return next
    }),
  })

  const pick = async (kind: CloseoutFileKind, list: FileList | null) => {
    const added: PendingDoc[] = []
    for (const f of Array.from(list ?? [])) {
      if (f.size > maxMb * 1024 * 1024) { onError(`${f.name}: ไฟล์ใหญ่เกิน ${maxMb} MB`); continue }
      if (!isAllowedDocFile(f.type)) { onError(`${f.name}: รับเฉพาะ PDF และรูปภาพ`); continue }
      added.push({
        key: `${kind}-${f.name}-${f.size}-${f.lastModified}`, kind, file: f,
        dataUrl: supabase ? undefined : await readAsDataUrl(f),
      })
    }
    if (added.length) set({ pending: [...latest.current.pending.filter(p => !added.some(a => a.key === p.key)), ...added] })
  }

  // ฟังก์ชันคืน JSX (ไม่ใช่ component) — ถ้าประกาศเป็น component ในนี้ React จะ remount ทุกครั้งที่ render
  const fileBox = (kind: CloseoutFileKind) => {
    const old = existing.filter(f => f.kind === kind)
    const pend = draft.pending.filter(p => p.kind === kind)
    return (
      <div className="closeout-files">
        <label className="field" style={{ marginBottom: 6 }}>
          <span>ไฟล์{CLOSEOUT_FILE_LABEL[kind]}{kind === 'acceptance' && latest.current.acceptanceType ? ` (${latest.current.acceptanceType})` : ''} * <span className="muted">(PDF/รูป ≤ {maxMb} MB · เลือกได้หลายไฟล์{kind === 'acceptance' ? ' · ไฟล์ใหม่ติดป้ายตามประเภทที่เลือก' : ''})</span></span>
          <input type="file" accept="application/pdf,image/*" multiple disabled={disabled}
            onChange={async e => { await pick(kind, e.target.files); e.target.value = '' }} />
        </label>
        {old.map(f => (
          <div key={f.id} className="muted" style={{ fontSize: 12 }}>
            <button type="button" className="link-btn" onClick={() => openCloseoutFile(f).catch(err => onError(String(err?.message ?? err)))}>
              {f.mimeType === 'application/pdf' ? '📄' : '🖼️'} {f.fileName}
            </button>{f.docType && <span className="badge neutral" style={{ marginLeft: 4 }}>{f.docType}</span>} <span>(แนบไว้แล้ว)</span>
          </div>
        ))}
        {pend.map(p => (
          <div key={p.key} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="badge blue">ใหม่</span>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{p.file.name}</span>
            <span className="muted">{Math.max(1, Math.round(p.file.size / 1024))} KB</span>
            <button type="button" className="small" disabled={disabled}
              onClick={() => set({ pending: draft.pending.filter(x => x.key !== p.key) })}>เอาออก</button>
          </div>
        ))}
        {old.length === 0 && pend.length === 0 && <div style={{ fontSize: 12, color: 'var(--danger)' }}>ยังไม่ได้แนบไฟล์</div>}
      </div>
    )
  }

  return (
    <div className="closeout-form">
      {/* ① เอกสารรับมอบ */}
      <section className="closeout-section">
        <h4>① เอกสารรับมอบงาน <span className="req">* เลือก 1 ประเภท</span></h4>
        <div className="closeout-choices">
          {ACCEPTANCE_TYPES.map(t => (
            <label key={t.value} className={`closeout-choice${draft.acceptanceType === t.value ? ' on' : ''}`}>
              <input type="radio" name={`acc-${job.id}`} checked={draft.acceptanceType === t.value} disabled={disabled}
                onChange={() => set({ acceptanceType: t.value })} />
              <b>{t.label}</b>
              <span className="muted">{t.hint}</span>
            </label>
          ))}
        </div>
        <div className="row">
          <label className="field"><span>เลขที่เอกสาร</span>
            <input value={draft.acceptanceDocNo} disabled={disabled} placeholder="เช่น PAC-2026-015"
              onChange={e => set({ acceptanceDocNo: e.target.value })} />
          </label>
          <label className="field"><span>วันที่ลงนาม / วันที่มีผล *</span>
            <input type="date" value={draft.acceptanceDate} disabled={disabled} max={todayIso()}
              onChange={e => {
                const v = e.target.value
                // Warranty งานติดตั้งตั้งต้นที่วันรับมอบ — ถ้ายังไม่ได้แตะเอง ให้ขยับตาม
                const follow = !draft.instStart || draft.instStart === draft.acceptanceDate
                onChange({
                  ...draft, acceptanceDate: v,
                  ...(follow ? {
                    instStart: v,
                    instEnd: draft.instMonths === 'custom' ? draft.instEnd : warrantyEndFor(v, draft.instMonths),
                  } : {}),
                })
              }} />
          </label>
        </div>
        {fileBox('acceptance')}
      </section>

      {/* ② Warranty — บันทึกทั้ง 2 แบบคู่กัน */}
      <section className="closeout-section">
        <h4>② Warranty Period <span className="req">* บันทึกทั้ง 2 แบบ</span></h4>
        <div className="closeout-grid">
          <div className="closeout-card">
            <div className="closeout-card-head">🔧 Installation — ประกันงานติดตั้ง <span className="muted">(ทั้ง Job)</span></div>
            <div className="row">
              <label className="field"><span>วันเริ่ม *</span>
                <input type="date" value={draft.instStart} disabled={disabled}
                  onChange={e => setInst(e.target.value, draft.instMonths)} />
              </label>
              <label className="field"><span>ระยะเวลา</span>
                <MonthSelect value={draft.instMonths} onChange={m => setInst(draft.instStart, m)} />
              </label>
              <label className="field"><span>วันสิ้นสุด *</span>
                <input type="date" value={draft.instEnd} disabled={disabled || draft.instMonths !== 'custom'}
                  min={draft.instStart || undefined}
                  onChange={e => setInst(draft.instStart, 'custom', e.target.value)} />
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>ตั้งต้นที่วันรับมอบ · แก้ได้</div>
            {fileBox('warranty_installation')}
          </div>

          <div className="closeout-card">
            <div className="closeout-card-head">⚡ LBS — ประกันตัวเครื่อง <span className="muted">({draft.lbs.length} เครื่องที่ติดตั้งสำเร็จ)</span></div>
            {draft.lbs.length === 0 ? (
              // ใบที่ปิดด้วย flow เก่า (ก่อน 0035) ไม่มีผลติดตั้งรายเครื่อง — ระบบไม่รู้วันติดตั้งจริงของแต่ละเครื่อง
              <div className="muted" style={{ fontSize: 12 }}>
                ใบนี้ไม่มีผลยืนยันติดตั้งรายเครื่อง (ปิดด้วยระบบเดิม) — บันทึกได้เฉพาะ Warranty งานติดตั้ง
              </div>
            ) : <>
            <label className="field" style={{ maxWidth: 260 }}><span>ระยะเวลา (ใช้กับทุกเครื่อง)</span>
              <MonthSelect value={draft.lbsMonths} onChange={setLbsMonths} />
            </label>
            <div className="table-scroll" style={{ maxHeight: 220 }}>
              <table>
                <thead><tr><th>Serial LVB / OM</th><th>ติดตั้งจริง</th><th>วันเริ่ม *</th><th>วันสิ้นสุด *</th></tr></thead>
                <tbody>
                  {draft.lbs.map(r => (
                    <tr key={r.unitId}>
                      <td className="mono" style={{ fontSize: 12 }}>{r.serial}</td>
                      <td className="muted">{r.installedDate ? fmtDate(r.installedDate) : '-'}</td>
                      <td><input type="date" value={r.start} disabled={disabled}
                        onChange={e => setLbsRow(r.unitId, { start: e.target.value })} /></td>
                      <td><input type="date" value={r.end} disabled={disabled || draft.lbsMonths !== 'custom'}
                        min={r.start || undefined}
                        onChange={e => setLbsRow(r.unitId, { end: e.target.value })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ fontSize: 12, margin: '6px 0 8px' }}>
              วันเริ่มตั้งต้นที่<b>วันติดตั้งจริงของแต่ละเครื่อง</b> · เลือก "กำหนดวันสิ้นสุดเอง" เพื่อแก้รายเครื่อง
            </div>
            {fileBox('warranty_lbs')}
            </>}
          </div>
        </div>
      </section>
    </div>
  )
}
