import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore, can } from '../data/StoreContext'
import { fmtDateTime, DEPT_LABEL } from '../ui/format'
import { Modal } from '../ui/components'
import { auditEntityTone } from '../ui/tone'
import { supabase } from '../lib/supabase'
import { fetchAuditLogs } from '../data/remote'
import {
  filterAuditLogs, auditLink, auditTypeOptions, createAuditSearch, AUDIT_ENTITY_LABEL,
  type AuditFilter, type AuditSearchState,
} from '../data/audit'
import type { AuditLog } from '../types'

// =============================================================================
// Audit Log — เฟส 6 (2026-11-24)
//   เดิมกรองแค่ 500 รายการล่าสุดที่โหลดตอนเปิดแอป ⇒ ค้นย้อนหลังไม่เจอ
//   ตอนนี้: เลือกช่วงวันที่ (เวลาไทย) · ประเภทข้อมูล · ผู้ทำ · คำค้น แล้วกด "ค้นหา"
//     LIVE = ค้นที่ฐานข้อมูล (fetchAuditLogs) หน้าละ 200 แถว + "โหลดเพิ่ม" · demo = กรองข้อมูลในเครื่อง
//   คลิกแถว = กล่องรายละเอียดอ่านอย่างเดียว + ลิงก์ไปหน้าที่ตรงกับข้อมูล (auditLink)
//   รีวิวเฟส 6: การค้น/โหลดเพิ่มผ่าน createAuditSearch — ผลของการค้นเก่าไม่ทับผลใหม่ (#1) · หน้าถัดไปอ้างเวลา
//   แถวสุดท้าย + ตัดแถวซ้ำ (#2) · ประเภทชื่อเดียวกันเป็นตัวเลือกเดียว (#5)
// =============================================================================
const PAGE = 200

export default function AuditPage() {
  const { db, user } = useStore()
  const isManage = can(user, 'master.manage')
  const [form, setForm] = useState<AuditFilter>({})
  const [applied, setApplied] = useState<AuditFilter | null>(null)   // null = ยังไม่ค้น → แสดงรายการล่าสุด
  const [live, setLive] = useState<AuditSearchState>({ rows: [], hasMore: false, loading: false, error: null })
  const searcher = useRef<ReturnType<typeof createAuditSearch> | null>(null)
  if (!searcher.current && supabase) {
    const sb = supabase
    searcher.current = createAuditSearch((f, page) => fetchAuditLogs(sb, f, page), setLive, PAGE)
  }
  useEffect(() => () => searcher.current?.reset(), [])     // ออกจากหน้า = ทิ้งคำตอบที่ยังค้าง
  const { rows, hasMore, loading, error } = live
  const [detail, setDetail] = useState<AuditLog | null>(null)

  const userOf = (id: string) => db.users.find(u => u.id === id)
  const typeOptions = auditTypeOptions(db.auditLogs.map(a => a.entityType))

  const rangeBad = !!(form.from && form.to && form.from > form.to)
  const search = () => {
    if (rangeBad) return
    const f = { ...form, q: form.q?.trim() || undefined }
    setApplied(f)
    void searcher.current?.search(f)
  }
  const clear = () => { setForm({}); setApplied(null); searcher.current?.reset() }

  // demo = กรองในเครื่องเสมอ · LIVE ยังไม่ค้น = รายการล่าสุดที่โหลดมากับแอป
  const shown: AuditLog[] = applied
    ? (supabase ? rows : filterAuditLogs(db.auditLogs, applied))
    : db.auditLogs
  const link = detail ? auditLink(detail, db) : null
  const linkOk = link && (link !== '/dev' || isManage)

  return (
    <>
      <div className="page-title">Audit Log</div>
      <div className="page-sub">ทุก transaction ถูกบันทึก: ใคร ทำอะไร เมื่อไหร่ — เลือกช่วงวันที่เพื่อค้นย้อนหลังได้ทั้งหมด · คลิกแถวเพื่อดูรายละเอียด</div>

      <form className="panel" onSubmit={e => { e.preventDefault(); search() }}>
        <div className="panel-body" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0 }}><span>ตั้งแต่วันที่</span>
            <input type="date" value={form.from ?? ''} onChange={e => setForm({ ...form, from: e.target.value || undefined })} />
          </label>
          <label className="field" style={{ margin: 0 }}><span>ถึงวันที่</span>
            <input type="date" value={form.to ?? ''} onChange={e => setForm({ ...form, to: e.target.value || undefined })} />
          </label>
          <label className="field" style={{ margin: 0 }}><span>ประเภทข้อมูล</span>
            <select value={form.entityType ?? ''} onChange={e => setForm({ ...form, entityType: e.target.value || undefined })}>
              <option value="">ทุกประเภท</option>
              {typeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}><span>ผู้ทำรายการ</span>
            <select value={form.actorId ?? ''} onChange={e => setForm({ ...form, actorId: e.target.value || undefined })}>
              <option value="">ทุกคน</option>
              {db.users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </label>
          <label className="field" style={{ margin: 0, flex: '1 1 220px' }}><span>คำค้น</span>
            <input className="search-input" placeholder="Job No., Serial, PO, ชื่อรายการ..." value={form.q ?? ''} onChange={e => setForm({ ...form, q: e.target.value })} />
          </label>
          <button type="submit" className="primary" disabled={rangeBad || loading}>{loading ? 'กำลังค้น…' : '🔍 ค้นหา'}</button>
          {applied && <button type="button" onClick={clear}>ล้างตัวกรอง</button>}
        </div>
        {rangeBad && <div className="panel-body" style={{ color: 'var(--danger)', paddingTop: 0 }}>วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด</div>}
      </form>

      <div className="muted" style={{ margin: '0 0 8px' }}>
        {applied
          ? <>ผลการค้น {shown.length.toLocaleString()} รายการ{supabase && hasMore ? ' (ยังมีต่อ)' : ''}{supabase ? ' · ค้นจากฐานข้อมูลทั้งหมด' : ''}</>
          : <>แสดง {shown.length.toLocaleString()} รายการล่าสุด{supabase ? ' (โหลดมากับแอป)' : ''} — กด "ค้นหา" พร้อมช่วงวันที่เพื่อค้นย้อนหลัง</>}
      </div>
      {error && <div className="panel"><div className="panel-body" style={{ color: 'var(--danger)' }}>⚠️ {error}</div></div>}

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead><tr><th>เวลา</th><th>ผู้ทำรายการ</th><th>ประเภท</th><th>Action</th><th>รายละเอียด</th></tr></thead>
            <tbody>
              {shown.length === 0 && !loading && <tr><td colSpan={5}><div className="empty">ไม่พบรายการ</div></td></tr>}
              {shown.map(a => (
                <tr key={a.id} className="clickable" onClick={() => setDetail(a)}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.createdAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{userOf(a.actorId)?.fullName ?? '-'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><span className={`badge ${auditEntityTone(a.entityType)}`}>{AUDIT_ENTITY_LABEL[a.entityType] ?? a.entityType}</span></td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{a.action}</td>
                  <td>{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {applied && supabase && hasMore && (
          <div className="panel-body" style={{ textAlign: 'center' }}>
            <button disabled={loading} onClick={() => void searcher.current?.more()}>{loading ? 'กำลังโหลด…' : `โหลดเพิ่มอีก ${PAGE} รายการ`}</button>
          </div>
        )}
      </div>

      {detail && (
        <Modal title="รายละเอียด Audit Log" onClose={() => setDetail(null)}
          footer={<>
            {linkOk && <Link className="btn-like" to={link!} onClick={() => setDetail(null)}>ไปที่หน้าข้อมูล →</Link>}
            <button onClick={() => setDetail(null)}>ปิด</button>
          </>}>
          <table className="dense">
            <tbody>
              <tr><th>เวลา</th><td>{fmtDateTime(detail.createdAt)}</td></tr>
              <tr><th>ผู้ทำรายการ</th><td>{userOf(detail.actorId)?.fullName ?? '-'}
                {userOf(detail.actorId) && <span className="muted"> · {DEPT_LABEL[userOf(detail.actorId)!.department]}</span>}</td></tr>
              <tr><th>ประเภทข้อมูล</th><td><span className={`badge ${auditEntityTone(detail.entityType)}`}>{AUDIT_ENTITY_LABEL[detail.entityType] ?? detail.entityType}</span> <span className="muted mono">({detail.entityType})</span></td></tr>
              <tr><th>รหัสข้อมูล</th><td className="mono" style={{ overflowWrap: 'anywhere' }}>{detail.entityId}</td></tr>
              <tr><th>Action</th><td><span className="badge neutral mono">{detail.action}</span></td></tr>
              <tr><th>รายละเอียด</th><td style={{ whiteSpace: 'pre-wrap' }}>{detail.detail || '-'}</td></tr>
            </tbody>
          </table>
          {!linkOk && <div className="muted" style={{ marginTop: 8 }}>ไม่มีหน้าที่เปิดดูข้อมูลนี้ได้โดยตรง{link === '/dev' ? ' (หน้าผู้ใช้/ตั้งค่า เฉพาะ Manage)' : ''}</div>}
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>บันทึก Audit แก้ไขหรือลบไม่ได้ (อ่านอย่างเดียว)</div>
        </Modal>
      )}
    </>
  )
}
