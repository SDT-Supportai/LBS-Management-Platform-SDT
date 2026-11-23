// =============================================================================
// เฟส 2 (2026-11-23) — ชิ้นส่วนหน้าจอกลางของ Flow งาน · logic ทั้งหมดอยู่ที่ src/data/flow.ts
//   GateButton    ปุ่มที่กดไม่ได้ต้องบอกเหตุผล + แผนกที่ทำได้ (ไม่หายเงียบ)
//   NextStepBar   "ขั้นต่อไป · ใครทำ · ภายในวันที่" บนหัวงาน
//   PendingBadge  "⏳ รอ Division พิจารณา: …" ทุกคำขอที่ค้างของงาน
//   ConfirmSummary สรุปผลก่อนกดคำสั่งที่ย้อนไม่ได้ (ใช้ในโหมดยืนยันของ Modal — ไม่ซ้อนกล่อง)
// =============================================================================
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ApprovalRequest, DB, Job, User } from '../types'
import { deptNames, isMyTurn, type Gate, type NextStep } from '../data/flow'
import { APPROVAL_TYPE_LABEL, fmtDate, fmtDateTime } from './format'
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
