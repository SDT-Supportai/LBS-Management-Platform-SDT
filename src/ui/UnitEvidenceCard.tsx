import type { ReactNode } from 'react'
import { safeHttpUrl } from '../data/field'
import { fmtDate } from './format'

// =============================================================================
// การ์ดหลักฐานติดตั้งรายเครื่อง — ธีม LBS Glass UI (2026-11-24) ตาม canvas หน้า 7 "Popup รายเครื่อง"
//   ซ้าย: รูปหน้างาน (ภาพย่อ กดเปิดรูปเต็ม) · ขวา: Serial + สถานะ + วันที่ / ช่าง / GPS / บันทึก + ปุ่ม
//   ชิ้นแสดงผลล้วน — สถานะ ปุ่ม และสิทธิ์ ส่งมาทาง slot จาก ServicePage (การ์ดไม่ตัดสิน Flow เอง)
//   เทสต์: UnitEvidenceCard.test.tsx
// =============================================================================

export interface UnitEvidence {
  date?: string
  by?: string
  lat?: number
  lng?: number
  photoUrl?: string
  note?: string
}

export function UnitEvidenceCard({ serialLvb, serialOm, site, status, actions, evidence, photoLabel }: {
  serialLvb: string
  serialOm?: string
  site: ReactNode
  status: ReactNode
  actions?: ReactNode
  /** มีเฉพาะเครื่องที่ติดตั้งแล้ว */
  evidence?: UnitEvidence
  /** ข้อความในกล่องรูปเมื่อไม่มีหลักฐาน (เช่น "รอติดตั้ง") */
  photoLabel?: string
}) {
  const photo = safeHttpUrl(evidence?.photoUrl)
  const hasGps = evidence?.lat != null && evidence?.lng != null
  return (
    <div className="unit-ev">
      <div className="unit-ev-photo">
        {photo ? (
          <a href={photo} target="_blank" rel="noreferrer" title="เปิดรูปเต็ม">
            <img src={photo} alt={`รูปถ่ายหน้างาน ${serialLvb}`} loading="lazy" />
          </a>
        ) : (
          <span>{evidence ? 'ไม่มีรูป' : (photoLabel ?? 'ยังไม่มีหลักฐาน')}</span>
        )}
      </div>
      <div className="unit-ev-body">
        <div className="unit-ev-head">
          <div>
            <span className="mono unit-ev-serial">{serialLvb}</span>
            {serialOm && <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>{serialOm}</span>}
          </div>
          <div className="unit-ev-status">{status}</div>
        </div>
        <dl className="unit-ev-kv">
          <dt>จุดติดตั้ง</dt><dd>{site}</dd>
          {evidence && <><dt>วันที่ติดตั้ง</dt><dd>{fmtDate(evidence.date)}</dd></>}
          {evidence?.by && <><dt>ช่าง</dt><dd>{evidence.by}</dd></>}
          {hasGps && (
            <><dt>GPS</dt><dd>
              <a href={`https://www.google.com/maps?q=${evidence!.lat},${evidence!.lng}`} target="_blank" rel="noreferrer">
                {`${evidence!.lat!.toFixed(5)}, ${evidence!.lng!.toFixed(5)}`}
              </a>
            </dd></>
          )}
          {evidence?.note && <><dt>บันทึก</dt><dd>{evidence.note}</dd></>}
        </dl>
        {actions && <div className="unit-ev-actions">{actions}</div>}
      </div>
    </div>
  )
}
