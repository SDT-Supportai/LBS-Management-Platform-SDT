// =============================================================================
// เฟส 2 (2026-11-23) — ชิ้นส่วนหน้าจอกลางของ Flow งาน · logic ทั้งหมดอยู่ที่ src/data/flow.ts
//   GateButton    ปุ่มที่กดไม่ได้ต้องบอกเหตุผล + แผนกที่ทำได้ (ไม่หายเงียบ)
//   NextStepBar   "ขั้นต่อไป · ใครทำ · ภายในวันที่" บนหัวงาน
//   PendingBadge  "⏳ รอ Division พิจารณา: …" ทุกคำขอที่ค้างของงาน
//   ConfirmSummary สรุปผลก่อนกดคำสั่งที่ย้อนไม่ได้ (ใช้ในโหมดยืนยันของ Modal — ไม่ซ้อนกล่อง)
//   MyWorkPanel   กล่อง "งานของฉัน" (เฟส 3) — ต้องทำอะไร · งานไหน · ค้างกี่วัน · ปุ่มไปทำทันที
// =============================================================================
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ApprovalRequest, DB, Job, User } from '../types'
import { deptNames, isMyTurn, type Gate, type NextStep, type WorkItem } from '../data/flow'
import { APPROVAL_TYPE_LABEL, DEPT_LABEL, fmtDate, fmtDateTime } from './format'
import { daysBetweenIso, todayIso } from '../data/logic'

// ---------------- ปุ่มพร้อมเหตุผล ----------------
type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  gate: Gate
  /** ปิดชั่วคราวด้วยเหตุผลฝั่งหน้าจอ (เช่น ยังไม่ได้เลือกรายการ) — ไม่ใช่กติกาธุรกิจ */
  disabled?: boolean
  /** 'below' = เหตุผลเป็นบรรทัดเล็กใต้ปุ่ม (ค่าเริ่มต้น) · 'tooltip' = เฉพาะตอนชี้ (ที่แคบ เช่น ในตาราง) */
  reason?: 'below' | 'tooltip'
  children: ReactNode
}

export function GateButton({ gate, disabled, reason = 'below', children, className, title, ...rest }: BtnProps) {
  const why = gate.ok ? undefined : gate.reason
  const note = gate.ok ? gate.note : undefined
  const btn = (
    <button {...rest} className={[className, !gate.ok ? 'gate-off' : ''].filter(Boolean).join(' ') || undefined}
      disabled={!gate.ok || disabled} aria-disabled={!gate.ok || disabled || undefined}
      title={why ?? note ?? title}>
      {!gate.ok && <span aria-hidden="true">🔒 </span>}{children}
    </button>
  )
  if ((gate.ok && !note) || reason === 'tooltip') return btn
  return (
    <span className="gate-wrap">
      {btn}
      {why ? <span className="gate-why">{why}</span> : <span className="gate-note">{note}</span>}
    </span>
  )
}

// ---------------- แถบขั้นต่อไป ----------------
export function NextStepBar({ step, user, job, today = todayIso() }: { step: NextStep; user: User | null; job?: Job; today?: string }) {
  const mine = isMyTurn(step, user, job)
  const left = step.due ? daysBetweenIso(today, step.due) : undefined
  const dueText = step.due === undefined ? null
    : left! < 0 ? `เลย${step.dueLabel ?? 'กำหนด'} ${-left!} วัน (${fmtDate(step.due)})`
    : left === 0 ? `${step.dueLabel ?? 'กำหนด'}วันนี้`
    : `ภายใน ${fmtDate(step.due)} (อีก ${left} วัน)`
  return (
    <div className={`next-step tone-${step.tone}${mine ? ' is-mine' : ''}`} role="status">
      <div className="next-step-main">
        <span className="next-step-kicker">ขั้นต่อไป</span>
        <b className="next-step-title">{step.title}</b>
        {mine && <span className="badge blue">ถึงคิวคุณ</span>}
      </div>
      <div className="next-step-meta">
        <span>👤 {step.who.length ? deptNames(step.who) : 'ไม่มีผู้ต้องทำ'}</span>
        {dueText && <span className={left! < 0 ? 'next-step-late' : undefined}>📅 {dueText}</span>}
      </div>
      {step.detail && <div className="next-step-detail">{step.detail}</div>}
    </div>
  )
}

// ---------------- ป้ายรอพิจารณา ----------------
export function PendingBadge({ db, reqs, link = true }: { db: DB; reqs: ApprovalRequest[]; link?: boolean }) {
  if (reqs.length === 0) return null
  const who = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  return (
    <div className="pending-box" role="status">
      <div>⏳ <b>รอ Division พิจารณา {reqs.length} คำขอ</b> — คำสั่งเหล่านี้ยังไม่มีผลจนกว่าจะอนุมัติ</div>
      <ul>
        {reqs.map(r => (
          <li key={r.id}>
            <b>{APPROVAL_TYPE_LABEL[r.type] ?? r.type}</b>
            <span className="muted"> · ส่งโดย {who(r.requestedBy)} · {fmtDateTime(r.requestedAt)}</span>
          </li>
        ))}
      </ul>
      {link && <Link to="/approvals">ดูที่หน้ารออนุมัติ →</Link>}
    </div>
  )
}

// ---------------- สรุปก่อนยืนยันคำสั่งที่ย้อนไม่ได้ ----------------
export function ConfirmSummary({ items, irreversible = true, children }: {
  /** ผลที่จะเกิดขึ้น — เขียนเป็นข้อความสั้น ๆ ทีละข้อ */
  items: ReactNode[]
  irreversible?: boolean
  children?: ReactNode
}) {
  return (
    <div className="confirm-summary">
      {irreversible && <div className="confirm-warn">⚠️ ย้อนกลับไม่ได้ — ตรวจสรุปก่อนกดยืนยัน</div>}
      <div className="confirm-head">สิ่งที่จะเกิดขึ้น</div>
      <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
      {children}
    </div>
  )
}

// ---------------- กล่องงานของฉัน (เฟส 3) ----------------
function workWhen(w: WorkItem, today: string): { text: string; late: boolean } | null {
  if (w.lateDays > 0) return { text: `เลย${w.dueLabel ?? 'กำหนด'} ${w.lateDays} วัน`, late: true }
  if (w.due) {
    const left = daysBetweenIso(today, w.due)
    return { text: left === 0 ? `${w.dueLabel ?? 'กำหนด'}วันนี้` : `ภายใน ${fmtDate(w.due)} (อีก ${left} วัน)`, late: false }
  }
  if (w.waitingDays !== undefined) return { text: w.waitingDays > 0 ? `ค้าง ${w.waitingDays} วัน` : 'เข้ามาวันนี้', late: false }
  return null
}

function WorkRow({ w, today }: { w: WorkItem; today: string }) {
  const when = workWhen(w, today)
  return (
    <li className={`mywork-item tone-${w.tone}`}>
      <div className="mywork-text">
        <div className="mywork-title">
          <b>{w.title}</b>
          {w.jobNo && <span className="mywork-job">{w.jobNo}{w.customer ? ` · ${w.customer}` : ''}</span>}
        </div>
        {w.detail && <div className="mywork-detail">{w.detail}</div>}
      </div>
      {when && <span className={`mywork-when${when.late ? ' is-late' : ''}`}>{when.text}</span>}
      <Link className="mywork-go" to={w.link}>ไปทำ →</Link>
    </li>
  )
}

export function MyWorkPanel({ items, user, limit = 8, today = todayIso() }: {
  items: WorkItem[]; user: User | null; limit?: number; today?: string
}) {
  const head = items.slice(0, limit)
  const rest = items.slice(limit)
  const late = items.filter(w => w.lateDays > 0).length
  return (
    <section className="panel mywork" aria-label="งานของฉัน">
      <div className="panel-head">
        <h3>
          📥 งานของฉัน <span className="mywork-count">{items.length}</span>
          {user && <span className="muted" style={{ fontWeight: 400 }}> · แผนก {DEPT_LABEL[user.department]}</span>}
        </h3>
        {late > 0 && <span className="badge red">เลยกำหนด {late}</span>}
      </div>
      {items.length === 0 ? (
        <div className="panel-body muted">
          {user?.department === 'vip'
            ? '👑 VIP ดูภาพรวมได้ทุกหน้า — ไม่มีงานที่ต้องลงมือ (ให้ความเห็นคำขอได้ที่หน้ารออนุมัติ)'
            : '✅ ไม่มีงานที่รอคุณตอนนี้'}
        </div>
      ) : (
        <>
          <ul className="mywork-list">{head.map(w => <WorkRow key={w.key} w={w} today={today} />)}</ul>
          {rest.length > 0 && (
            <details className="mywork-more">
              <summary>ดูอีก {rest.length} รายการ</summary>
              <ul className="mywork-list">{rest.map(w => <WorkRow key={w.key} w={w} today={today} />)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  )
}
