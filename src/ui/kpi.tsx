import { Link } from 'react-router-dom'

// =============================================================================
// ชิ้นส่วนการ์ด KPI หน้า Dashboard — ธีม LBS Glass UI (2026-11-24) ตาม canvas หน้า 2
//   แถบสัดส่วน (StackBar) · คำอธิบายสี + ตัวเลข (KpiLegend) · วงแหวนคืบหน้าติดตั้ง (ProgressRing)
//   แสดงผลอย่างเดียว — ตัวเลขทั้งหมดคำนวณใน DashboardPage จากที่มาเดิม · เทสต์: kpi.test.tsx
// =============================================================================

export type KpiTone = 'green' | 'amber' | 'violet' | 'blue' | 'red' | 'gray'

export interface KpiPart { label: string; value: number; tone: KpiTone }

/** แถบสัดส่วน — กว้างตามสัดส่วนของ total (ส่วนที่ไม่ได้แสดง = ราง) · ส่วนที่เป็น 0 ไม่วาด */
export function StackBar({ total, parts }: { total: number; parts: KpiPart[] }) {
  const shown = parts.filter(p => p.value > 0)
  let used = 0
  const segs = shown.map(p => {
    const pct = total > 0 ? Math.min(100 - used, (p.value / total) * 100) : 0
    used += pct
    return { ...p, pct: Math.round(pct * 100) / 100 }
  })
  const label = `${shown.map(p => `${p.label} ${p.value}`).join(' · ') || 'ไม่มีข้อมูล'} จาก ${total}`
  return (
    <div className="kpi-bar" role="img" aria-label={label}>
      {segs.map(s => <span key={s.label} className={`kpi-seg ${s.tone}`} style={{ width: `${s.pct}%` }} title={`${s.label} ${s.value}`} />)}
    </div>
  )
}

export interface KpiLegendItem extends KpiPart {
  /** สีตัวเลขเมื่อ > 0 (เช่น รอเข้าคลัง = amber · ต้องเร่ง = red) */
  emphasis?: KpiTone
  to?: string
  title?: string
}

export function KpiLegend({ items }: { items: KpiLegendItem[] }) {
  return (
    <div className="kpi-legend">
      {items.map(i => {
        const num = <b className={`kpi-num${i.emphasis && i.value > 0 ? ` ${i.emphasis}` : ''}`}>{i.value}</b>
        const body = <><span className={`kpi-dot ${i.tone}`} aria-hidden="true" />{i.label}{num}</>
        return i.to
          ? <Link key={i.label} className="kpi-li" to={i.to} title={i.title}>{body}</Link>
          : <div key={i.label} className="kpi-li" title={i.title}>{body}</div>
      })}
    </div>
  )
}

const R = 38
const C = 2 * Math.PI * R

/** วงแหวนคืบหน้าติดตั้ง — ครบทุกเครื่อง = เขียว + เครื่องหมายถูก */
export function ProgressRing({ done, total }: { done: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0
  const complete = total > 0 && done >= total
  return (
    <svg className="kpi-ring" width="92" height="92" viewBox="0 0 92 92" role="img" aria-label={`ติดตั้งแล้ว ${done} จาก ${total} เครื่อง`}>
      <circle cx="46" cy="46" r={R} fill="none" className="kpi-ring-track" strokeWidth="9" />
      {ratio > 0 && (
        <circle cx="46" cy="46" r={R} fill="none" className={`kpi-ring-bar${complete ? ' done' : ''}`} strokeWidth="9"
          strokeLinecap="round" strokeDasharray={`${(ratio * C).toFixed(2)} ${C.toFixed(2)}`} transform="rotate(-90 46 46)" />
      )}
      {complete && <path className="kpi-ring-check" d="M33 47l9 9 17-19" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  )
}

/** สีตัวเลข LBS ใน Job List — ดึงครบตาม Scope = ok · ยังไม่ครบ = short */
export const lbsCountTone = (allocated: number, required: number): 'ok' | 'short' =>
  required > 0 && allocated >= required ? 'ok' : 'short'
