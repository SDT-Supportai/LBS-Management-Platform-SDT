import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import {
  ACCEPTANCE_TYPES, CLOSEOUT_FILE_LABEL, MAX_DOC_FILE_MB, DEMO_MAX_DOC_FILE_MB, isAllowedDocFile,
  jobWarranties, closeoutFiles, warrantyStatus, todayIso, type WarrantyState,
} from '../data/logic'
import type { Job, JobWarranty, CloseoutFileKind, AcceptanceType } from '../types'
import { Modal, readAsDataUrl, useConfirm, useToast, useTryAction } from '../ui/components'
import { CloseoutForm, initCloseoutDraft, closeoutMissing, buildCloseoutInput, openCloseoutFile, type CloseoutDraft } from '../ui/CloseoutForm'
import { fmtDate, fmtDateTime } from '../ui/format'
import { supabase } from '../lib/supabase'
import { uploadServiceDoc, removeServiceDocs } from '../data/remote'

// =============================================================================
// Service (Warranty) — เมนูต่อจาก Site Installation (0079 เฟส 1)
//   แท็บ Warranty Period  = รับงานจาก "ปิดงานติดตั้ง" แยก Job · เรียงตามวันเริ่มนับ Warranty
//   แท็บ Repair Requests  = เฟส 2 (S.O. No. อัตโนมัติ → ref Job/เครื่องจาก Warranty Period)
//   แท็บ Service Reports  = เฟส 3 (S.R. No. อัตโนมัติ → ref S.O.)
// =============================================================================

const STATE_BADGE: Record<WarrantyState, { cls: string; label: (d: number) => string }> = {
  not_started: { cls: 'neutral', label: () => 'ยังไม่เริ่ม' },
  active:      { cls: 'green',   label: d => `ในประกัน · เหลือ ${d.toLocaleString('th-TH')} วัน` },
  expiring:    { cls: 'amber',   label: d => `ใกล้หมด · เหลือ ${d} วัน` },
  expired:     { cls: 'red',     label: d => `หมดแล้ว ${(-d).toLocaleString('th-TH')} วัน` },
}
function WarrantyBadge({ w, today }: { w: Pick<JobWarranty, 'startDate' | 'endDate'>; today: string }) {
  const { state, daysLeft } = warrantyStatus(w, today)
  return <span className={`badge ${STATE_BADGE[state].cls}`}>{STATE_BADGE[state].label(daysLeft)}</span>
}
const accLabel = (t?: string) => ACCEPTANCE_TYPES.find(x => x.value === t)?.label ?? '-'

type Filter = 'all' | WarrantyState

export default function WarrantyPage() {
  const { db, user, act } = useStore()
  const tryAction = useTryAction()
  const { show } = useToast()
  const { ask, element: confirmEl } = useConfirm()
  const canEdit = can(user, 'closeout.manage')
  const today = todayIso()

  const [tab, setTab] = useState<'period' | 'repair' | 'report'>('period')
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sortAsc, setSortAsc] = useState(true)
  const [editJobId, setEditJobId] = useState<string | null>(null)
  const [draft, setDraft] = useState<CloseoutDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [filesJobId, setFilesJobId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // แนบเอกสารรับมอบเพิ่ม (เช่น PAC ที่มาหลังปิดงานด้วย Handover) ต้องบอกว่าไฟล์เป็นเอกสารอะไร
  const [addDocType, setAddDocType] = useState<AcceptanceType>('PAC')

  const closed = db.jobs.filter(j => j.terminalStatus === 'installed')
  const withWarranty = closed.filter(j => jobWarranties(db, j.id).some(w => w.kind === 'installation'))
  const missing = closed.filter(j => !withWarranty.includes(j))

  // 1 แถว = 1 Job · วันเริ่มนับ = Warranty งานติดตั้ง (ทั้ง Job)
  const rows = withWarranty.map(job => {
    const ws = jobWarranties(db, job.id)
    const inst = ws.find(w => w.kind === 'installation')!
    const lbs = ws.filter(w => w.kind === 'lbs')
      .map(w => ({ w, unit: db.lbsUnits.find(u => u.id === w.unitId) }))
      .sort((a, b) => (a.unit?.serialLvb ?? '').localeCompare(b.unit?.serialLvb ?? ''))
    const states = [inst, ...lbs.map(x => x.w)].map(w => warrantyStatus(w, today).state)
    return { job, inst, lbs, states }
  })

  const text = q.trim().toLowerCase()
  const shown = rows
    .filter(r => filter === 'all' || r.states.includes(filter))
    .filter(r => !text || [r.job.jobNo, r.job.customerName, r.job.installLocation, r.job.acceptanceDocNo,
      ...r.lbs.flatMap(x => [x.unit?.serialLvb, x.unit?.serialOm])]
      .some(s => s?.toLowerCase().includes(text)))
    .sort((a, b) => (sortAsc ? 1 : -1) * a.inst.startDate.localeCompare(b.inst.startDate)
      || a.job.jobNo.localeCompare(b.job.jobNo))

  // นับรายเครื่อง (LBS) — ตัวเลขที่ทีม Service ใช้วางแผนรับแจ้งซ่อม
  const unitCount = (s: WarrantyState) => rows.reduce((n, r) =>
    n + r.lbs.filter(x => warrantyStatus(x.w, today).state === s).length, 0)

  const openEdit = (job: Job) => { setDraft(initCloseoutDraft(db, job)); setEditJobId(job.id) }
  const editJob = db.jobs.find(j => j.id === editJobId)
  const filesJob = db.jobs.find(j => j.id === filesJobId)

  const saveEdit = async () => {
    if (!editJob || !draft) return
    setSaving(true)
    try {
      const input = await buildCloseoutInput(draft, editJob.id)
      const ok = await tryAction(() => act.setJobCloseout({ jobId: editJob.id, ...input }),
        editJob.acceptanceType ? 'บันทึกการแก้ไขแล้ว' : 'บันทึกเอกสารรับมอบ/Warranty ย้อนหลังแล้ว')
      if (ok) { setEditJobId(null); setDraft(null) }
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
    setSaving(false)
  }

  const addFiles = async (job: Job, kind: CloseoutFileKind, list: FileList | null, docType?: AcceptanceType) => {
    const maxMb = supabase ? MAX_DOC_FILE_MB : DEMO_MAX_DOC_FILE_MB
    const picked = Array.from(list ?? [])
    if (!picked.length) return
    setUploading(true)
    let ok = 0
    for (const f of picked) {
      if (f.size > maxMb * 1024 * 1024) { show(`${f.name}: ไฟล์ใหญ่เกิน ${maxMb} MB`, true); continue }
      if (!isAllowedDocFile(f.type)) { show(`${f.name}: รับเฉพาะ PDF และรูปภาพ`, true); continue }
      try {
        const filePath = supabase ? await uploadServiceDoc(supabase, job.id, f) : await readAsDataUrl(f)
        await act.addCloseoutFile({ jobId: job.id, kind, docType: kind === 'acceptance' ? docType : undefined, fileName: f.name, filePath, mimeType: f.type, sizeBytes: f.size })
        ok++
      } catch (err) {
        show(err instanceof Error ? err.message : `แนบ ${f.name} ไม่สำเร็จ`, true)
      }
    }
    setUploading(false)
    if (ok) show(`แนบเอกสารแล้ว ${ok} ไฟล์`)
  }

  return (
    <>
      <div className="page-title">Service (Warranty)</div>
      <div className="page-sub">
        รับงานจาก <b>ปิดงานติดตั้ง</b> → ติดตามระยะประกัน (งานติดตั้ง + ตัวเครื่อง LBS) → รับแจ้งซ่อม (S.O.) → รายงานซ่อมเสร็จ (S.R.)
      </div>

      <div className="subtabs">
        <button className={tab === 'period' ? 'on' : ''} onClick={() => setTab('period')}>🛡️ Warranty Period ({rows.length})</button>
        <button disabled title="เฟส 2 — รับแจ้งซ่อม + S.O. No. อัตโนมัติ">🧰 Repair Requests <span className="badge neutral">เฟส 2</span></button>
        <button disabled title="เฟส 3 — รายงานซ่อมเสร็จ + S.R. No. อัตโนมัติ">📝 Service Reports <span className="badge neutral">เฟส 3</span></button>
      </div>

      {tab === 'period' && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <span className="badge green">LBS ในประกัน {unitCount('active')}</span>
            <span className="badge amber">ใกล้หมด ≤ 90 วัน {unitCount('expiring')}</span>
            <span className="badge red">หมดประกัน {unitCount('expired')}</span>
            {missing.length > 0 && <span className="badge amber">ปิดงานแล้วแต่ยังไม่มี Warranty {missing.length} Job</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input placeholder="ค้นหา Job / ลูกค้า / Serial / เลขเอกสาร" value={q} onChange={e => setQ(e.target.value)} style={{ width: 280 }} />
              <select value={filter} style={{ width: 'auto' }} onChange={e => setFilter(e.target.value as Filter)}>
                <option value="all">ทุกสถานะ</option>
                <option value="active">ในประกัน</option>
                <option value="expiring">ใกล้หมด (≤ 90 วัน)</option>
                <option value="expired">หมดประกันแล้ว</option>
                <option value="not_started">ยังไม่เริ่ม</option>
              </select>
              <button style={{ whiteSpace: 'nowrap' }} onClick={() => setSortAsc(v => !v)} title="เรียงตามวันเริ่มนับ Warranty งานติดตั้ง">
                วันเริ่มนับ {sortAsc ? 'เก่า → ใหม่ ↑' : 'ใหม่ → เก่า ↓'}
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th>เริ่มนับ</th><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>เอกสารรับมอบ</th>
                  <th>Warranty งานติดตั้ง</th><th>Warranty ตัวเครื่อง (LBS)</th><th></th>
                </tr></thead>
                <tbody>
                  {shown.length === 0 && (
                    <tr><td colSpan={7}><div className="empty">
                      {rows.length === 0 ? 'ยังไม่มีงานที่ปิดพร้อมข้อมูล Warranty' : 'ไม่พบรายการตามเงื่อนไข'}
                    </div></td></tr>
                  )}
                  {shown.map(({ job, inst, lbs }) => (
                    <tr key={job.id}>
                      <td style={{ whiteSpace: 'nowrap' }}><b>{fmtDate(inst.startDate)}</b></td>
                      <td style={{ whiteSpace: 'nowrap' }}><Link to={`/jobs/${job.id}`}><b>{job.jobNo}</b></Link></td>
                      <td>{job.customerName}<div className="muted" style={{ fontSize: 12 }}>{job.installLocation}</div></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className="badge blue">{accLabel(job.acceptanceType)}</span>
                        {job.acceptanceDocNo && <span className="mono" style={{ marginLeft: 6 }}>{job.acceptanceDocNo}</span>}
                        <div className="muted" style={{ fontSize: 12 }}>{fmtDate(job.acceptanceDate)}</div>
                        {/* เอกสารรับมอบอื่นที่แนบตามมา (เช่น PAC หลังปิดด้วย Handover) */}
                        {(() => {
                          const more = [...new Set(closeoutFiles(db, job.id, 'acceptance').map(f => f.docType)
                            .filter(t => t && t !== job.acceptanceType))]
                          return more.length > 0 && <div style={{ fontSize: 12 }}>+ มี {more.map(accLabel).join(', ')} แล้ว</div>
                        })()}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {fmtDate(inst.startDate)} – {fmtDate(inst.endDate)}
                        <div><WarrantyBadge w={inst} today={today} /></div>
                      </td>
                      <td>
                        {lbs.map(({ w, unit }) => (
                          <div key={w.id} style={{ fontSize: 12, marginBottom: 4 }}>
                            <span className="mono">{unit?.serialLvb ?? '-'}</span>{' '}
                            <span className="muted">{fmtDate(w.startDate)} – {fmtDate(w.endDate)}</span>{' '}
                            <WarrantyBadge w={w} today={today} />
                          </div>
                        ))}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="small" onClick={() => setFilesJobId(job.id)}>
                          📎 เอกสาร ({closeoutFiles(db, job.id).length})
                        </button>
                        {canEdit && <button className="small" style={{ marginLeft: 6 }} onClick={() => openEdit(job)}>✏️ แก้ไข</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* งานที่ปิดก่อน 0079 — ไม่มีข้อมูล ต้องบันทึกย้อนหลัง ไม่งั้นแจ้งซ่อม (เฟส 2) หา ref ไม่เจอ */}
          {missing.length > 0 && (
            <div className="panel">
              <div className="panel-head"><h3>ปิดงานแล้วแต่ยังไม่มีเอกสารรับมอบ / Warranty ({missing.length})</h3></div>
              <div className="panel-body muted" style={{ paddingBottom: 0 }}>
                งานที่ปิดก่อนมีระบบ Warranty — บันทึกย้อนหลังเพื่อให้ขึ้นในตารางด้านบนและใช้อ้างอิงตอนรับแจ้งซ่อม
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Job No.</th><th>ลูกค้า / สถานที่</th><th>ปิดงาน (ติดตั้งล่าสุด)</th><th></th></tr></thead>
                  <tbody>
                    {missing.map(job => (
                      <tr key={job.id}>
                        <td style={{ whiteSpace: 'nowrap' }}><Link to={`/jobs/${job.id}`}><b>{job.jobNo}</b></Link></td>
                        <td>{job.customerName}<div className="muted" style={{ fontSize: 12 }}>{job.installLocation}</div></td>
                        <td>{fmtDate(job.installedAt)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {canEdit
                            ? <button className="small primary" onClick={() => openEdit(job)}>+ บันทึกย้อนหลัง</button>
                            : <span className="muted">Service / Project บันทึกได้</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ---------- บันทึกย้อนหลัง / แก้ไข ---------- */}
      {editJob && draft && (() => {
        const miss = closeoutMissing(draft, closeoutFiles(db, editJob.id))
        return (
          <Modal size="xl" title={`${editJob.acceptanceType ? 'แก้ไข' : 'บันทึกย้อนหลัง'} เอกสารรับมอบ / Warranty — ${editJob.jobNo}`}
            onClose={() => { if (!saving) { setEditJobId(null); setDraft(null) } }}
            footer={<>
              {miss.length > 0 && <div className="closeout-missing">ยังขาด {miss.length} รายการ: {miss.join(' · ')}</div>}
              <button disabled={saving} onClick={() => { setEditJobId(null); setDraft(null) }}>ยกเลิก</button>
              <button className="primary" disabled={saving || miss.length > 0} onClick={saveEdit}>
                {saving ? 'กำลังบันทึก…' : 'บันทึก'}
              </button>
            </>}>
            <p className="muted" style={{ marginTop: 0 }}>
              {editJob.customerName} · ปิดงาน {fmtDate(editJob.installedAt)} — บันทึกทับข้อมูล Warranty เดิมทั้งชุด (ไฟล์เดิมคงไว้) · บันทึกใน Audit Log
            </p>
            <CloseoutForm db={db} job={editJob} draft={draft} onChange={setDraft}
              onError={m => show(m, true)} disabled={saving} />
          </Modal>
        )
      })()}

      {/* ---------- เอกสารของ Job ---------- */}
      {filesJob && (
        <Modal size="wide" title={`เอกสารรับมอบ / Warranty — ${filesJob.jobNo}`} onClose={() => setFilesJobId(null)}
          footer={<button onClick={() => setFilesJobId(null)}>ปิด</button>}>
          {(Object.keys(CLOSEOUT_FILE_LABEL) as CloseoutFileKind[]).map(kind => {
            const files = closeoutFiles(db, filesJob.id, kind)
            return (
              <div key={kind} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <b>{CLOSEOUT_FILE_LABEL[kind]}</b>
                  {kind === 'acceptance' && <span className="muted" style={{ fontSize: 12 }}>ปิดงานด้วย <span className="badge blue">{accLabel(filesJob.acceptanceType)}</span></span>}
                  {canEdit && (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                      {kind === 'acceptance' && (
                        <select value={addDocType} style={{ width: 'auto' }} title="ไฟล์ที่จะแนบเป็นเอกสารประเภทไหน"
                          onChange={e => setAddDocType(e.target.value as AcceptanceType)}>
                          {ACCEPTANCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      )}
                      <label className="small" style={{ cursor: 'pointer' }}>
                        <span className="badge neutral">{uploading ? 'กำลังอัปโหลด…' : '+ แนบเพิ่ม'}</span>
                        <input type="file" multiple accept="application/pdf,image/*" style={{ display: 'none' }} disabled={uploading}
                          onChange={async e => { await addFiles(filesJob, kind, e.target.files, addDocType); e.target.value = '' }} />
                      </label>
                    </div>
                  )}
                </div>
                {files.length === 0 && <div className="muted">ยังไม่มีไฟล์</div>}
                {files.map(f => {
                  // กติกาเดียวกับ rpc_delete_closeout_file: ห้ามลบไฟล์สุดท้ายของประเภท
                  // และไฟล์รับมอบประเภทที่ใช้ปิดงานต้องเหลือ ≥ 1
                  const lastOfKind = files.length <= 1
                  const lastOfClosingType = f.kind === 'acceptance' && f.docType === filesJob.acceptanceType
                    && files.filter(x => x.docType === f.docType).length <= 1
                  const lock = lastOfKind || lastOfClosingType
                  return (
                  <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 4 }}>
                    <button className="link-btn" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
                      onClick={() => openCloseoutFile(f).catch(err => show(String(err?.message ?? err), true))}>
                      {f.mimeType === 'application/pdf' ? '📄' : '🖼️'} {f.fileName}
                    </button>
                    {f.docType && <span className="badge neutral">{accLabel(f.docType)}</span>}
                    <span className="muted">{fmtDateTime(f.uploadedAt)} · {db.users.find(u => u.id === f.uploadedBy)?.fullName ?? '-'}</span>
                    {canEdit && (
                      <button className="small danger" disabled={lock}
                        title={lastOfKind ? 'ไฟล์สุดท้ายของประเภทนี้ — แนบไฟล์ใหม่ก่อนแล้วค่อยลบ'
                          : lastOfClosingType ? `ไฟล์ ${accLabel(f.docType)} ตัวสุดท้ายที่ใช้ปิดงาน — แนบไฟล์ใหม่ หรือเปลี่ยนประเภทที่ "แก้ไข" ก่อน` : ''}
                        onClick={async () => {
                          if (!await ask({ title: `ลบเอกสาร "${f.fileName}"`, description: 'ลบแล้วกู้คืนไม่ได้ · บันทึกใน Audit Log', confirmLabel: 'ลบเอกสาร' })) return
                          const ok = await tryAction(() => act.deleteCloseoutFile({ fileId: f.id }), 'ลบเอกสารแล้ว')
                          if (ok && supabase) await removeServiceDocs(supabase, [f.filePath])
                        }}>ลบ</button>
                    )}
                  </div>
                  )
                })}
              </div>
            )
          })}
        </Modal>
      )}
      {confirmEl}
    </>
  )
}
