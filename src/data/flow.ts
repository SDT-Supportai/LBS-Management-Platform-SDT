// =============================================================================
// เฟส 2 (2026-11-23) — "ส่วนกลาง" ของ Flow งาน: ใครทำอะไรได้ · ขั้นต่อไปของงาน · คำขอที่รอพิจารณา
//
// หลักการจากแผน Flow งานทีม LBS (ข้อ 1, 4, 7):
//   1) ทุกงานบอก "ขั้นต่อไป · ใครทำ · ภายในวันที่" — ไม่ต้องเดาจากสถานะ
//   4) ปุ่มไม่หายเงียบ — กดไม่ได้ต้องบอกเหตุผล + แผนกที่ทำได้
//   7) ขั้นอนุมัติเห็นชัด — คำขอที่รอ Division พิจารณามีป้าย และปิดปุ่มขอซ้ำ
//
// ไฟล์นี้เป็น logic ล้วน (ไม่มี React) — หน้าจอทุกหน้าใช้ตัวเดียวกัน · เทสต์อยู่ที่ flow.test.ts
// ⚠️ เงื่อนไขที่นี่ "อธิบาย" กติกาให้คนเห็น — ตัวบังคับจริงยังเป็น logic.ts (demo) และ RPC/trigger (LIVE)
//    ถ้าแก้กติกาที่ฝั่งนั้น ต้องแก้ที่นี่ด้วย ไม่งั้นปุ่มจะบอกว่ากดได้แล้วไปเจอ error
// =============================================================================
import type { DB, Job, User, Department, ApprovalRequest, ApprovalType, JobStatus } from '../types'
import { PERMISSIONS, can, ownsJob } from './permissions'
import {
  deriveJobStatus, jobDelivery, jobInstallSummary, jobIssuePlan, jobEtaBlockReason, jobWarrantyStarted,
  jobCancelBlockReason, jobIsFieldActive, daysBetweenIso, pendingPurchasingReqs, todayIso, prSnapshotChanges, correctionLabel,
  lbsReturnBlockReason,
  type JobDelivery,
} from './logic'
import { APPROVAL_TYPE_LABEL, DEPT_LABEL, PR_STATUS_LABEL, fmtDate } from '../ui/format'

// ---------------- Gate: กดได้ / กดไม่ได้เพราะอะไร / ใครทำได้ ----------------
export type Gate =
  | { ok: true; /** กดได้ แต่มีเรื่องที่ควรรู้ก่อนกด (เช่น LBS รอ Division แต่วัสดุเบิกได้) — แสดงใต้ปุ่มแบบไม่เตือน */ note?: string }
  | { ok: false; reason: string; /** แผนกที่ทำได้ — มีเฉพาะกรณีติดสิทธิ์แผนก */ who?: Department[] }

export const OK: Gate = { ok: true }
const no = (reason: string, who?: Department[]): Gate => ({ ok: false, reason, ...(who ? { who } : {}) })
const okNote = (note: string): Gate => ({ ok: true, note })

/** แผนกที่ทำได้ ไม่รวม Manage (Manage ทำได้ทุกอย่างอยู่แล้ว — บอกไปก็ไม่ช่วยคนที่ถาม) */
export function deptsOf(perm: keyof typeof PERMISSIONS): Department[] {
  return PERMISSIONS[perm].filter(d => d !== 'admin')
}

export function deptNames(ds: Department[]): string {
  return ds.map(d => DEPT_LABEL[d]).join(' / ')
}

/** ด่านสิทธิ์แผนก — "สำหรับ Project" */
export function permGate(user: User | null, perm: keyof typeof PERMISSIONS): Gate {
  if (!user) return no('กรุณาเข้าสู่ระบบ')
  if (can(user, perm)) return OK
  const who = deptsOf(perm)
  return no(`สำหรับ ${deptNames(who)}`, who)
}

/** ด่านเจ้าของงาน (0042) — Project ทำได้เฉพาะ Job ที่ตัวเองเปิด */
export function ownerGate(db: DB, user: User | null, job: Job): Gate {
  if (ownsJob(user, job)) return OK
  const owner = db.users.find(u => u.id === job.openedBy)?.fullName ?? 'ผู้ใช้อื่น'
  return no(`เฉพาะเจ้าของงาน (${owner}) หรือ Manage`)
}

/**
 * รวมด่านตามลำดับ — ด่านแรกที่ไม่ผ่านคือเหตุผลที่แสดง (สิทธิ์ → เจ้าของ → สถานะ → คำขอค้าง)
 * ผ่านทุกด่าน = กดได้ พร้อมหมายเหตุตัวแรกที่เจอ (ถ้ามี)
 */
export function firstBlock(...gates: (Gate | (() => Gate))[]): Gate {
  let note: string | undefined
  for (const g of gates) {
    const r = typeof g === 'function' ? g() : g
    if (!r.ok) return r
    note ??= r.note
  }
  return note ? okNote(note) : OK
}

// ---------------- คำขอที่รอ Division พิจารณา ----------------
export function pendingApprovals(db: DB, jobId: string, type?: ApprovalType): ApprovalRequest[] {
  return db.approvalRequests
    .filter(r => r.jobId === jobId && r.status === 'pending' && (!type || r.type === type))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
}

/** ด่านกันขอซ้ำ — มีคำขอประเภทเดียวกันค้างอยู่ = ปุ่มขอซ้ำกดไม่ได้ พร้อมบอกว่ารออะไร */
export function pendingGate(db: DB, jobId: string, type: ApprovalType): Gate {
  const p = pendingApprovals(db, jobId, type)[0]
  return p ? no(`มีคำขอ${APPROVAL_TYPE_LABEL[type]} รอ Division พิจารณาอยู่แล้ว`) : OK
}

// ---------------- เหตุผลที่ยังปิดงานไม่ได้ (เดิมอยู่ใน ServicePage) ----------------
type InstallSummary = ReturnType<typeof jobInstallSummary>

/** '' = ปิดได้ · ใช้ร่วมกันทั้งหน้า Service, Job Detail และแถบขั้นต่อไป */
export function jobCloseReason(s: InstallSummary): string {
  if (s.closeBlockers.length > 0) return s.closeBlockers.join(' · ')
  return s.total === 0 ? 'ไม่มีเครื่องที่เบิกไว้'
    // 0071: "ค้างเพราะยังไม่ได้เบิก" ≠ "ค้างเพราะช่างยังไม่ได้ยืนยัน" — คนละคนต้องไปทำ
    : s.waiting > 0 ? `ยังมี ${s.waiting} เครื่องที่ Project ยังไม่ได้เบิกให้ — ปิดงานได้เมื่อของออกครบ Scope`
    : s.pending > 0 ? `ต้องได้ข้อสรุปทุกเครื่องก่อน (เหลือ ${s.pending} เครื่อง)`
    : s.installed === 0 ? 'ต้องมีเครื่องที่ติดตั้งสำเร็จอย่างน้อย 1 เครื่อง'
    : !s.issueComplete ? 'ติดตั้งครบแล้ว แต่ใบยังเบิกของไม่ครบ'
        + (s.lbsShort > 0 ? ` (LBS ขาดอีก ${s.lbsShort} เครื่องจาก Scope)` : '')
        + (s.pendingAccessories > 0 ? ` (วัสดุค้างเบิก ${s.pendingAccessories} รายการ)` : '')
        + ' — Project ต้องเบิก/โอนคืน/ตัดจำหน่ายให้ครบก่อน จึงปิดงานได้'
    : ''
}

// ---------------- คำสั่งบนหน้า Job: ใครกดได้ในสถานะไหน ----------------
export type JobActionKey =
  | 'draw_lbs' | 'return_lbs' | 'issue' | 'edit_job' | 'cancel_job' | 'delete_draft'
  | 'request_pr' | 'swap_lbs' | 'extend_due' | 'close_install' | 'return_issued_lbs'
  | 'reopen_job' | 'correct_closeout'

export interface JobAction {
  key: JobActionKey
  label: string
  gate: Gate
  /** true = กดแล้วเป็นการส่งคำขอให้ Division พิจารณา (ไม่มีผลทันที) */
  approval: boolean
}

export const JOB_ACTION_ORDER: JobActionKey[] = [
  'draw_lbs', 'return_lbs', 'issue', 'request_pr', 'swap_lbs', 'edit_job', 'extend_due',
  'cancel_job', 'delete_draft', 'close_install', 'return_issued_lbs', 'reopen_job', 'correct_closeout',
]

function terminalText(job: Job): string {
  return job.terminalStatus === 'cancelled' ? `${job.jobNo} ถูกยกเลิกแล้ว`
    : job.terminalStatus === 'installed' ? `${job.jobNo} ปิดงานแล้ว`
    : `${job.jobNo} เบิกครบทั้งใบแล้ว`
}

/**
 * ทุกคำสั่งหลักของหน้า Job พร้อมด่าน — ลอกกติกามาจาก JobDetailPage/ServicePage ณ 2026-11-23
 * (ตารางแผนก × สถานะ ใน docs/dept-status-matrix.md สร้างจากฟังก์ชันนี้ผ่าน flow.test.ts)
 */
export function jobActions(db: DB, job: Job, user: User | null, today = todayIso()): JobAction[] {
  const isManage = can(user, 'master.manage')
  const locked = job.terminalStatus !== null                              // แตะ LBS / ตัวใบงาน
  const procureLocked = job.terminalStatus === 'installed' || job.terminalStatus === 'cancelled'
  const own = () => ownerGate(db, user, job)
  const jm = permGate(user, 'job.manage')
  const notLocked = (): Gate => locked ? no(terminalText(job)) : OK
  const notProcLocked = (): Gate => procureLocked ? no(terminalText(job)) : OK

  const onJob = db.lbsUnits.filter(u => u.jobId === job.id && (u.status === 'allocated' || u.status === 'issued'))
  const allocated = onJob.filter(u => u.status === 'allocated')
  const plan = jobIssuePlan(db, job.id, today)
  const canIssueAnything = plan.accReady.length > 0 || (plan.lbsShort === 0 && plan.lbsReady.length > 0)
  const inst = jobInstallSummary(db, job.id)
  const warrantyStarted = job.terminalStatus === 'installed' ? jobWarrantyStarted(db, job.id, today) : undefined
  const ask = (label: string) => isManage ? label : `ขออนุมัติ${label}`

  const all: JobAction[] = [
    {
      key: 'draw_lbs', label: 'ดึง LBS เข้า Job', approval: false,
      gate: firstBlock(jm, own, notLocked,
        () => onJob.length >= job.lbsQtyRequired ? no(`ดึงครบ Scope แล้ว (${job.lbsQtyRequired} เครื่อง)`) : OK,
        // รีวิว Flow ข้อ 2: ไม่มีเครื่องให้ดึง = บอกก่อนกด (เดิมกดได้แล้วไม่มีเครื่องให้เลือก/เจอ error 0084)
        () => drawableUnits(db).length === 0 ? no(NO_DRAWABLE) : OK),
    },
    {
      key: 'return_lbs', label: 'คืน LBS กลับสต็อก', approval: false,
      gate: firstBlock(jm, own, notLocked,
        () => allocated.length === 0 ? no('ไม่มีเครื่องที่ดึงไว้และยังไม่เบิก') : OK),
    },
    {
      key: 'issue', label: 'เบิกให้ Service', approval: !isManage && plan.accReady.length === 0,
      gate: firstBlock(jm, own, notProcLocked, () =>
        job.terminalStatus === 'issued' && plan.accReady.length === 0 ? no(terminalText(job))
        : plan.lbsShort > 0 && plan.accReady.length === 0 ? no(`ดึง LBS ยังไม่ครบ Scope — ขาดอีก ${plan.lbsShort} เครื่อง`)
        : !canIssueAnything ? no(jobEtaBlockReason(db, job.id, today) ?? 'ยังไม่มีของที่พร้อมเบิก — LBS รอ ETA to WH / วัสดุรอรับของจาก PO')
        : plan.accReady.length === 0 ? pendingGate(db, job.id, 'issue_job')
        // รีวิวเฟส 2 ข้อ 6: คำขอเบิก LBS ค้าง ไม่กันการเบิกวัสดุ — บอกให้รู้ (เดิมหน้า Job มีข้อความนี้ เฟส 2 ทำหาย)
        : pendingApprovals(db, job.id, 'issue_job').length > 0
          ? okNote(`มีคำขอ${APPROVAL_TYPE_LABEL.issue_job} รอ Division พิจารณาอยู่แล้ว — เบิกวัสดุได้ตามปกติ`)
        : OK),
    },
    {
      key: 'request_pr', label: isManage ? 'ออก PR ส่ง Purchasing' : 'ขออนุมัติออก PR', approval: !isManage,
      gate: firstBlock(jm, own, notProcLocked,
        () => pendingPurchasingReqs(db, job.id).length === 0 ? no('ไม่มีวัสดุที่รอออก PR') : OK,
        () => pendingGate(db, job.id, 'create_pr')),
    },
    {
      key: 'swap_lbs', label: ask('สลับ LBS'), approval: !isManage,
      gate: firstBlock(jm, own, notLocked,
        () => allocated.length === 0 ? no('ไม่มีเครื่องที่ดึงไว้และยังไม่เบิก') : OK,
        () => db.lbsUnits.some(u => u.status === 'in_stock') ? OK : no('ไม่มีเครื่องว่างในคลังให้สลับ'),
        () => pendingGate(db, job.id, 'swap_lbs')),
    },
    { key: 'edit_job', label: 'แก้ไขข้อมูล Job', approval: false, gate: firstBlock(jm, own, notLocked) },
    { key: 'extend_due', label: 'ขยายกำหนดส่ง', approval: false, gate: firstBlock(jm, own, notProcLocked) },
    {
      key: 'cancel_job', label: ask('ยกเลิก Job'), approval: !isManage,
      gate: firstBlock(jm, own, notLocked,
        // รีวิวรอบสุดท้ายข้อ 2: เบิกของออกไปแล้วบางส่วน = cancelJob/คำขอ throw อยู่แล้ว ⇒ ปุ่มต้องบอกก่อนกด
        () => { const b = jobCancelBlockReason(db, job.id); return b ? no(b) : OK },
        () => pendingGate(db, job.id, 'cancel_job')),
    },
    {
      key: 'delete_draft', label: 'ลบ Draft', approval: false,
      gate: firstBlock(jm, own, notLocked, () =>
        onJob.length > 0 || db.allocations.some(a => a.jobId === job.id) || db.accessoryRequests.some(r => r.jobId === job.id)
          ? no('ลบได้เฉพาะ Draft ที่ยังไม่ดึง LBS และไม่มีรายการวัสดุ — ใช้ยกเลิก Job แทน') : OK),
    },
    {
      // 0080 (มติผู้ใช้): Service + Project ทุกคน + Manage — ไม่ติดเจ้าของงาน (closeJobInstall/rpc ไม่เช็ค)
      //   Service เป็นผู้ปิดหลัก (อยู่หน้างาน กรอกเอกสารรับมอบ/ประกัน) · Project ปิดแทนได้เมื่อ Service ไม่สะดวก
      key: 'close_install', label: 'ปิดงานติดตั้ง', approval: false,
      gate: firstBlock(permGate(user, 'job.closeInstall'),
        () => job.terminalStatus === 'installed' || job.terminalStatus === 'cancelled' ? no(terminalText(job)) : OK,
        () => inst.outTotal === 0 ? no('ยังไม่ได้เบิกของออกหน้างาน — ปิดงานได้หลังติดตั้งครบ') : OK,
        () => inst.canClose ? OK : no(jobCloseReason(inst))),
    },
    {
      key: 'return_issued_lbs', label: 'ขอคืนเครื่องที่ติดตั้งไม่ได้เข้าคลัง', approval: true,
      gate: firstBlock(permGate(user, 'install.revertRequest'), own,
        () => job.terminalStatus === 'installed' || job.terminalStatus === 'cancelled' ? no(terminalText(job)) : OK,
        () => inst.blocked === 0 ? no('ไม่มีเครื่องที่ติดตั้งไม่ได้') : OK,
        // รีวิว Flow ข้อ 1 (มติ 2026-11-24): ใบยังเบิกไม่ครบ = ขอคืนไม่ได้ — เดิมกดได้แล้วเจอ error ทางตัน
        () => { const b = lbsReturnBlockReason(job); return b ? no(b) : OK },
        () => pendingGate(db, job.id, 'return_lbs')),
    },
    {
      // Manage เปิดเองได้ (reopenJob = master.manage) · Project ส่งคำขอ
      key: 'reopen_job', label: ask('เปิดงานใหม่'), approval: !isManage,
      gate: firstBlock(jm, own,
        () => job.terminalStatus !== 'installed' ? no('เปิดงานใหม่ได้เฉพาะงานที่ปิดแล้ว') : OK,
        () => warrantyStarted ? no('เริ่มนับประกันแล้ว — ใช้ "ขอแก้ข้อมูลที่บันทึกผิด" แทน') : OK,
        () => pendingGate(db, job.id, 'reopen_job')),
    },
    {
      key: 'correct_closeout', label: 'ขอแก้ข้อมูลที่บันทึกผิด', approval: true,
      gate: firstBlock(permGate(user, 'closeout.manage'), own,
        () => job.terminalStatus !== 'installed' ? no('ใช้ได้เฉพาะงานที่ปิดแล้ว') : OK,
        () => !warrantyStarted ? no('ยังไม่เริ่มนับประกัน — ใช้ "เปิดงานใหม่" แทน') : OK,
        () => pendingGate(db, job.id, 'correct_closeout')),
    },
  ]
  return JOB_ACTION_ORDER.map(k => all.find(a => a.key === k)!)
}

export function jobAction(db: DB, job: Job, user: User | null, key: JobActionKey, today = todayIso()): JobAction {
  return jobActions(db, job, user, today).find(a => a.key === key)!
}

// ---------------- ขั้นต่อไปของงาน ----------------
export interface NextStep {
  title: string
  detail: string
  /** แผนกที่ต้องลงมือ — ว่าง = ไม่มีใครต้องทำ (ปิด/ยกเลิก) หรือรอของจากภายนอก */
  who: Department[]
  /** ทำให้เสร็จภายในวันที่ (ISO) — ฝั่งก่อนเบิกใช้กำหนดส่ง · ฝั่งหน้างานใช้วันนัด */
  due?: string
  dueLabel?: string
  tone: JobDelivery['tone']
  /** คำขอที่ทำให้งานหยุดรอ Division (ถ้ามี) */
  waiting?: ApprovalRequest
  /** คำขอที่รอพิจารณาทั้งหมดของงาน (แสดงเป็นป้ายแยก) */
  pending: ApprovalRequest[]
  /** ขั้นนี้คือคิวจัดซื้อ (pr = PR รอออก PO · po = PO รอรับของ) — งานของฉันใช้รายการคิวแทน ไม่ให้ซ้ำ */
  queue?: 'pr' | 'po'
  /** หน้าที่ไปทำขั้นนี้ (ไม่ระบุ = หน้า Job) — เช่น Division เตรียม LBS ที่หน้า LBS Inventory */
  link?: string
}

/** ประเภทคำขอที่หยุดงานทั้งใบ — รอผลก่อนค่อยทำขั้นอื่น */
const HALTING: ApprovalType[] = ['cancel_job', 'reopen_job']

/**
 * ผลที่จะเกิดจริงถ้า Division อนุมัติ (ลอกจาก decideApproval → cancelJob/reopenJob/… ใน logic.ts)
 * 🔴 รีวิวเฟส 2 ข้อ 4: เดิมเขียน "ถ้าอนุมัติ ขั้นถัดไปคือ <ขั้นงานปกติ>" ทุกประเภท ⇒ คำขอยกเลิก Job ขึ้นว่า
 *    "ถ้าอนุมัติ ขั้นถัดไปคือ เบิกให้ Service" (จริง ๆ ใบถูกยกเลิก) · คำขอที่ตรงกับขั้นวนกลับมาชื่อขั้นตัวเอง
 *    Record = ประเภทคำขอใหม่ต้องมาเขียนผลที่นี่ ไม่งั้น typecheck ไม่ผ่าน
 * @param stepTitle ขั้นงานปกติที่จะทำต่อถ้าคำขอที่หยุดทั้งใบไม่ผ่าน
 */
function approvalOutcome(type: ApprovalType, job: Job, stepTitle: string): string {
  const OUTCOME: Record<ApprovalType, string> = {
    cancel_job: `ถ้าอนุมัติ: ยกเลิก ${job.jobNo} — LBS คืนสต็อก · PR/PO ที่ค้างถูกยกเลิก · คำขออื่นของงานนี้ถูกตีกลับ`
      + ` · ถ้าไม่อนุมัติ: ทำต่อที่ "${stepTitle}"`,
    reopen_job: 'ถ้าอนุมัติ: งานกลับมาเปิด (รอติดตั้ง) ให้แก้ผลติดตั้งแล้วปิดงานใหม่ · ถ้าไม่อนุมัติ: งานยังปิดอยู่ตามเดิม',
    create_pr: 'ถ้าอนุมัติ: ระบบออก PR ให้ Purchasing ออก PO ต่อ',
    issue_job: 'ถ้าอนุมัติ: LBS ออกจากคลังไปหน้างาน แล้ว Service ออกหน้างานตามนัด',
    swap_lbs: 'ถ้าอนุมัติ: สลับเครื่องตามที่ขอ (เครื่องเดิมกลับสต็อก)',
    revert_install: 'ถ้าอนุมัติ: ผลติดตั้งเครื่องที่ขอถูกยกเลิก — Service บันทึกผลเครื่องนั้นใหม่',
    return_lbs: 'ถ้าอนุมัติ: เครื่องที่ติดตั้งไม่ได้กลับเข้า LBS Inventory — ไม่มีเรื่องค้างอื่นแล้วปิดงานได้',
    correct_closeout: 'ถ้าอนุมัติ: แก้ข้อมูลหลังปิดงานตามที่ขอ (งานยังปิดอยู่)',
  }
  return OUTCOME[type]
}

export function jobNextStep(db: DB, job: Job, today = todayIso()): NextStep {
  const d = jobDelivery(db, job, today)
  const pending = pendingApprovals(db, job.id)
  const base = { pending, tone: d.tone }
  const step = rawNextStep(db, job, d, today)

  // คำขอที่ตรงกับขั้นนี้ (หรือคำขอที่หยุดงานทั้งใบ) ⇒ ขั้นต่อไปคือ "รอ Division พิจารณา"
  const waiting = pending.find(r => HALTING.includes(r.type)) ?? pending.find(r => step.action?.includes(r.type))
  if (waiting) {
    const by = db.users.find(u => u.id === waiting.requestedBy)?.fullName ?? '-'
    return {
      ...base, waiting, who: ['sales'], tone: 'amber',
      title: `รอ Division พิจารณา: ${APPROVAL_TYPE_LABEL[waiting.type]}`,
      detail: `ส่งคำขอโดย ${by} · ${approvalOutcome(waiting.type, job, step.title)}`,
    }
  }
  const { action: _action, ...rest } = step
  return { ...base, ...rest }
}

interface RawStep { title: string; detail: string; who: Department[]; due?: string; dueLabel?: string; action?: ApprovalType[]; queue?: 'pr' | 'po'; link?: string }

// ---------------- เครื่องที่ดึงเข้า Job ได้ (รีวิว Flow ข้อ 2 · 2026-11-24) ----------------
/** เครื่องว่างในคลังที่มี Contract No. แล้ว และคลังยังไม่ปิด — mirror ด่าน drawLbs (0084 + คลังปิด) */
export function drawableUnits(db: DB) {
  return db.lbsUnits.filter(u => u.status === 'in_stock' && !!u.contractNo?.trim()
    && db.projectStocks.find(s => s.id === u.projectStockId)?.status !== 'closed')
}
const NO_DRAWABLE = 'ในคลังไม่มีเครื่องว่างที่มี Contract No. — รอ Division รับเข้าคลัง/กรอก Contract No. ที่ LBS Inventory'
/** ขั้นต่อไปเมื่อ Project ต้องดึงแต่ไม่มีเครื่องให้ดึง = งานของ Division (ขั้นที่ 1 ของเส้นทางงาน) */
const divisionPrepStep = (need: number, due: Pick<RawStep, 'due' | 'dueLabel'>): RawStep => ({
  title: 'รอ Division เตรียม LBS ที่มี Contract No.', who: ['sales'], link: '/stocks?f=no_contract',
  detail: `ต้องการอีก ${need} เครื่อง · ${NO_DRAWABLE}`, ...due,
})

function rawNextStep(db: DB, job: Job, d: JobDelivery, today: string): RawStep {
  if (job.terminalStatus === 'cancelled') return { title: 'ยกเลิกแล้ว', detail: 'ไม่มีงานค้างในใบนี้', who: [] }
  if (job.terminalStatus === 'installed') {
    return { title: 'ปิดงานแล้ว', detail: 'งานหลังการขาย/ประกันอยู่ที่หน้า Service (Warranty)', who: [] }
  }
  const inst = jobInstallSummary(db, job.id)
  const visitDue = { due: d.visitEnd, dueLabel: 'วันนัดสุดท้าย' }

  // 🔴 รีวิวรอบสุดท้ายข้อ 3: ทุก DeliveryState ต้องมี case ของตัวเอง (default = never) — state ใหม่ที่ลืมเขียน
  //    จะ typecheck ไม่ผ่าน แทนที่จะตกไปขั้นก่อนเบิก (preFieldStep) เงียบ ๆ
  switch (d.state) {
    case 'awaiting_clearance':
      return clearanceStep(db, job, inst)
    case 'blocked':
      // ของออกครบใบแล้ว เหลือเคลียร์เครื่องที่ติดตั้งไม่ได้ (+เรื่องอื่น) ก่อนปิด — ขั้นเดียวกับรอเคลียร์
      if (inst.unitsDone && inst.issueComplete && inst.pendingAccessories === 0) return clearanceStep(db, job, inst)
      return {
        title: 'แก้ปัญหาหน้างาน', who: ['project', 'service'], action: ['return_lbs', 'revert_install'],
        // รีวิว Flow ข้อ 1: ใบยังเบิกไม่ครบ = ยังขอคืนไม่ได้ (มติ 2026-11-24) — ไม่สั่งให้ทำสิ่งที่ทำไม่ได้
        detail: `${d.nextStep} · ${lbsReturnBlockReason(job)
          ? 'เครื่องที่ติดตั้งไม่ได้ขอคืนเข้า LBS Inventory ได้หลังเบิกของที่เหลือครบใบ'
          : 'เครื่องที่ติดตั้งไม่ได้จริงต้องขอคืนเข้า LBS Inventory (Division ตรวจรับ)'}`,
      }
    case 'awaiting_close':
      return { title: 'ปิดงานติดตั้ง', detail: d.nextStep, who: ['service', 'project'], action: ['revert_install'] }
    case 'awaiting_issue_rest': {
      // ของที่เหลือยังเบิกไม่ได้เพราะยังซื้อไม่เสร็จ ⇒ ขั้นต่อไปคือขั้นจัดซื้อ (มีคนรับผิดชอบเสมอ)
      //   🔴 รีวิวรอบสุดท้ายข้อ 1/4: ขั้นของ Purchasing ขึ้นเฉพาะเมื่อ Project ไม่มีอะไรให้ทำ (LBS ครบ Scope)
      //      ไม่งั้น "ออก PO · Purchasing" บังงานดึง/เบิก LBS ของ Project · และบอกว่า LBS ยังขาดเสมอ
      const proc = procurementStep(db, job)
      if (proc && jobIssuePlan(db, job.id, today).accReady.length === 0 && (projectsTurn(proc) || inst.lbsShort === 0))
        return { ...proc, detail: withLbsShort(proc.detail, inst.lbsShort) }
      return { title: 'เบิกของที่เหลือให้ครบใบ', detail: andProc(d.nextStep, proc), who: ['project'], action: ['issue_job'] }
    }
    case 'visit_overdue':
      return { title: 'ยืนยันผลติดตั้ง หรือเลื่อนนัด', detail: d.nextStep, who: ['service'], ...visitDue }
    case 'installing':
      return { title: 'ยืนยันติดตั้งรายเครื่อง', detail: d.nextStep, who: ['service'], ...visitDue }
    case 'awaiting_visit':
      return d.visitStart
        ? { title: 'ออกหน้างานตามนัด', detail: d.nextStep, who: ['service'], due: d.visitStart, dueLabel: 'วันนัด' }
        : { title: 'นัดวันติดตั้ง', detail: d.nextStep, who: ['service'] }
    case 'overdue': case 'due_soon': case 'on_track': case 'no_due':
    case 'closed':   // ไม่ถึงตรงนี้ (terminalStatus ด้านบน) — เขียนไว้ให้ switch ครบ
      return preFieldStep(db, job, deriveJobStatus(db, job), d, today)
    default: {
      const unhandled: never = d.state
      throw new Error(`ขั้นต่อไป: ไม่รู้จักสถานะ ${String(unhandled)}`)
    }
  }
}

/**
 * หน้างานจบแล้ว ของออกครบ แต่ยังมีเรื่องค้างก่อนปิด (คำขอ/ของคืน/เครื่องติดตั้งไม่ได้) — แยกให้เห็นว่าค้างที่ใคร
 * (วัสดุเพิ่มที่ยังไม่เบิก = awaiting_issue_rest → Project เบิก/จัดซื้อ — ไม่ใช่ที่นี่ · รีวิวเฟส 2 ข้อ 3)
 */
function clearanceStep(db: DB, job: Job, inst: ReturnType<typeof jobInstallSummary>): RawStep {
  const who = new Set<Department>()
  if (inst.blocked > 0) { who.add('service'); who.add('project') }
  if (pendingApprovals(db, job.id).length > 0) who.add('sales')
  if (db.stockReturns.some(s => s.jobId === job.id && s.status === 'pending')) who.add('purchasing')
  if (who.size === 0) who.add('project')
  return {
    title: inst.blocked > 0 ? 'คืนเครื่องที่ติดตั้งไม่ได้เข้า LBS Inventory ก่อนปิดงาน' : 'เคลียร์เรื่องค้างก่อนปิดงาน',
    detail: inst.closeBlockers.join(' · '), who: [...who], action: ['return_lbs', 'revert_install'],
  }
}

/** ขั้นจัดซื้อที่ Project ต้องทำเอง (ขอ PR) — ขั้นของ Purchasing ห้ามบังงานที่ Project ทำได้ตอนนี้ (รีวิวรอบสุดท้ายข้อ 1) */
const projectsTurn = (s: RawStep) => s.who.includes('project')
const withLbsShort = (detail: string, short: number) => short > 0 ? `${detail} · LBS ยังขาดอีก ${short} เครื่อง` : detail
/** งานของ Project เป็นขั้นหลัก — ต่อท้ายสถานะจัดซื้อที่แผนกอื่นถืออยู่ให้เห็นภาพรวม */
const andProc = (detail: string, proc: RawStep | null) => proc ? `${detail} · ${proc.detail}` : detail

/** ขั้นจัดซื้อวัสดุของงาน (ยังไม่ออก PR → Project · PR ส่งแล้ว → Purchasing ออก PO · ออก PO แล้ว → Purchasing รับของ) */
function procurementStep(db: DB, job: Job): RawStep | null {
  const reqs = db.accessoryRequests.filter(r => r.jobId === job.id)
  const noPr = reqs.filter(r => r.status === 'pending').length
  const prSent = reqs.filter(r => r.status === 'pr_sent').length
  const poOrdered = reqs.filter(r => r.status === 'po_ordered').length
  if (noPr > 0) return { title: 'ขออนุมัติออก PR', detail: `วัสดุ ${noPr} รายการยังไม่ได้ออก PR`, who: ['project'], action: ['create_pr'] }
  if (prSent > 0) return { title: 'ออก PO', detail: `PR ส่งแล้ว ${prSent} รายการ รอ Purchasing ออก PO`, who: ['purchasing'], queue: 'pr' }
  if (poOrdered > 0) return { title: 'รับของตาม PO', detail: `รอรับของ ${poOrdered} รายการ`, who: ['purchasing'], queue: 'po' }
  return null
}

function preFieldStep(db: DB, job: Job, status: JobStatus, d: JobDelivery, today: string): RawStep {
  const due = { due: d.due, dueLabel: 'กำหนดส่ง' }
  const onJob = db.lbsUnits.filter(u => u.jobId === job.id && (u.status === 'allocated' || u.status === 'issued')).length
  const short = Math.max(0, job.lbsQtyRequired - onJob)
  const noneToDraw = drawableUnits(db).length === 0
  if (status === 'draft' && noneToDraw) return divisionPrepStep(job.lbsQtyRequired, due)
  if (status === 'draft') return { title: 'ดึง LBS เข้างาน', detail: `ดึงเครื่องที่มี Contract No. จาก LBS Inventory ${job.lbsQtyRequired} เครื่อง`, who: ['project'], ...due }
  // 🔴 รีวิวเฟส 2 ข้อ 5: เบิกวัสดุไปบางส่วนแล้ว (partially_issued · ยังไม่มี LBS ออก) ก็มีจัดซื้อค้างได้
  //    เดิมเช็คเฉพาะ procuring_accessory ⇒ ใบแบบนี้ตกไป "รอของถึงคลัง · ไม่มีผู้ต้องทำ" ทั้งที่ Project ต้องขอ PR
  //    🔴 รีวิวรอบสุดท้ายข้อ 1: ขึ้นขั้นจัดซื้อก่อนเฉพาะ "ขอ PR" (งานของ Project เอง · ของซื้อใช้เวลานานกว่า)
  //       PR ส่งแล้ว/ออก PO แล้ว = งานของ Purchasing ⇒ ถ้า Project ดึง/เบิก LBS ได้ ต้องขึ้นงานของ Project
  //       (เดิม "ออก PO · Purchasing" บังปุ่มเบิกของ Project ทั้งที่ LBS พร้อมเบิก) — สถานะจัดซื้อต่อท้ายแทน
  const proc = procurementStep(db, job)
  const procuring = status === 'procuring_accessory' || status === 'partially_issued'
  if (proc && procuring && projectsTurn(proc)) return { ...proc, detail: withLbsShort(proc.detail, short), ...due }
  if (short > 0 && (status === 'allocated' || procuring)) {
    if (noneToDraw) { const s = divisionPrepStep(short, due); return { ...s, detail: andProc(s.detail, proc) } }
    return { title: 'ดึง LBS ให้ครบ Scope', detail: andProc(`ขาดอีก ${short} เครื่อง`, proc), who: ['project'], ...due }
  }
  const plan = jobIssuePlan(db, job.id, today)
  const issuable = plan.accReady.length > 0 || (plan.lbsShort === 0 && plan.lbsReady.length > 0)
  if (!issuable) {
    if (proc) return { ...proc, ...due }
    // ไม่มีงานในมือใครจริง ๆ — LBS รอ ETA to WH จากผู้ผลิต (who ว่าง = ไม่ใช่คิวใคร)
    const eta = jobEtaBlockReason(db, job.id, today)
    return { title: 'รอของถึงคลัง', detail: eta ?? 'ยังไม่มีของที่พร้อมเบิก', who: [], ...due }
  }
  return {
    title: status === 'partially_issued' ? 'เบิกส่วนที่เหลือให้ Service' : 'เบิกให้ Service',
    detail: andProc(d.nextStep, proc), who: ['project'], action: ['issue_job'], ...due,
  }
}

// ---------------- ยังไม่มอบหมายทีม (กติกาเดียวทุกหน้า) ----------------
/**
 * งานนี้ "ต้องมอบหมายทีม" ไหม — ของออกหน้างานแล้ว · ยังไม่มีทีม · ยังมีเครื่องที่ต้องติดตั้ง (รวมที่ค้างคลังรอล็อตถัดไป)
 * 🔴 ค้างจากเฟส 3: Dashboard / ตารางทีม / ป้ายเมนู นับงานที่ติดตั้งครบแล้ว (รอปิดงาน) ด้วย
 *    ทั้งที่มอบหมายไม่ได้แล้ว (assignJobTeam กันไว้ที่ assertInstallOpen) ⇒ ตัวเลขค้างตลอดไป
 * รีวิว Flow ข้อ 3 (2026-11-24): ย้ายจาก field.ts มาที่นี่ ให้งานของฉันใช้ตัวเดียวกับป้ายเมนู (field.ts re-export)
 */
export function jobNeedsTeam(db: DB, job: Job): boolean {
  if (job.terminalStatus === 'installed' || job.terminalStatus === 'cancelled') return false
  if (!jobIsFieldActive(db, job)) return false
  if (db.jobAssignments.some(a => a.jobId === job.id)) return false
  return jobInstallSummary(db, job.id).pending > 0
}

/**
 * ถึงคิวผู้ใช้คนนี้ไหม — Manage ถือว่าถึงคิวเมื่อมีคนต้องทำ (ทำแทนได้ทุกขั้น)
 * ส่ง job มาด้วยเสมอเมื่อมี: Project ที่ไม่ใช่เจ้าของงาน (0042) ไม่ถึงคิว แม้แผนกจะตรง
 */
export function isMyTurn(step: Pick<NextStep, 'who'>, user: User | null, job?: Job): boolean {
  if (!user || step.who.length === 0) return false
  if (user.department === 'admin') return true
  if (!step.who.includes(user.department)) return false
  return !job || ownsJob(user, job)
}

// ---------------- งานของฉัน (เฟส 3 · 2026-11-23) ----------------
/** 1 สิ่งที่รอผู้ใช้คนนี้ — ต้องทำอะไร · งานไหน · ค้างกี่วัน · ไปทำที่ไหน */
export interface WorkItem {
  /** job:<jobId> · appr:<requestId> · pr:<prId> · po:<poId> · ret:<stockReturnId> */
  key: string
  title: string
  detail: string
  jobId?: string
  jobNo?: string
  customer?: string
  /** หน้าที่กดไปทำได้ทันที */
  link: string
  /** วันที่ต้องทำให้เสร็จ (ถ้ามี) */
  due?: string
  dueLabel?: string
  /** เลยวันที่ต้องทำมาแล้วกี่วัน (0 = ยังไม่เลย) */
  lateDays: number
  /** คิวคำขอ/PR/ของคืน: ค้างมาแล้วกี่วันนับจากวันที่ส่งเข้ามา */
  waitingDays?: number
  tone: 'red' | 'amber' | 'blue'
}

/** วันที่ (เวลาไทย) ของ timestamp ISO — คิวนับวันตามปฏิทินที่ผู้ใช้เห็น (ใช้ร่วมงานของฉัน + หน้ารออนุมัติ) */
//   ค่าว่าง/ผิดรูป = '' (daysBetweenIso นับเป็น 0) — เดิม new Date(NaN).toISOString() throw RangeError ⇒ Dashboard ล่มทั้งหน้า (รีวิวเฟส 3 ข้อ 3)
export const bkkDate = (iso: string): string => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? '' : new Date(t + 7 * 3600_000).toISOString().slice(0, 10)
}

/**
 * กล่อง "งานของฉัน" — รวมทุกอย่างที่รอผู้ใช้คนนี้จากทุกหน้า แยกตามแผนก (หลักการข้อ 2 ของแผน)
 *   ใช้ข้อมูลที่ระบบคำนวณอยู่แล้วเท่านั้น: ขั้นต่อไปของงาน (jobNextStep) + คิวคำขอ/PR/PO/ของคืน
 *   • Project      = ขั้นต่อไปของงานที่ตัวเองเปิด (0042)
 *   • Division     = คำขอรอพิจารณา รายใบ (ไม่ใช่คำขอของตัวเอง — มติ D1)
 *   • Purchasing   = PR รอออก PO · PO รอรับของ · ของคืนรอตรวจรับ (รายใบ)
 *   • Service      = ขั้นหน้างาน · ของออกแล้วแต่ยังไม่มอบหมายทีม = "มอบหมายทีมช่าง" ก่อน
 *   • Manage       = ทุกอย่างข้างบน (ทำแทนได้ทุกขั้น) · VIP = ไม่มี (ดูภาพรวม/ให้ความเห็นเท่านั้น)
 * ขั้นต่อไปของงานที่มีรายการคิวครอบอยู่แล้ว (รอ Division / ออก PO / รับของ) ไม่ขึ้นซ้ำ
 */
export function myWork(db: DB, user: User | null, today = todayIso()): WorkItem[] {
  if (!user || user.department === 'vip') return []
  const isManage = user.department === 'admin'
  const items: WorkItem[] = []
  const late = (due?: string) => due && due < today ? daysBetweenIso(due, today) : 0
  const tone = (lateDays: number, waitingDays = 0): WorkItem['tone'] => lateDays > 0 ? 'red' : waitingDays >= 7 ? 'amber' : 'blue'
  const jobOf = (id: string) => db.jobs.find(j => j.id === id)
  const jobInfo = (id: string) => { const j = jobOf(id); return { jobId: id, jobNo: j?.jobNo, customer: j?.customerName } }
  const nameOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  // ---- คิวจัดซื้อ (Purchasing/Manage) ----
  const doesPurchasing = can(user, 'purchasing.manage')
  const queuedJobs = { pr: new Set<string>(), po: new Set<string>() }
  if (doesPurchasing) {
    // เฟส 4: คิวเดียวกับหน้า Purchasing — รวม PR ที่ออก PO ไปบางส่วนแล้ว (เดิมนับแค่ pending)
    for (const { pr, openLines, waitingDays } of prsAwaitingPo(db, today)) {
      queuedJobs.pr.add(pr.jobId)
      items.push({
        key: `pr:${pr.id}`, title: 'ออก PO', ...jobInfo(pr.jobId), link: '/purchasing',
        detail: `${pr.prNo} · ${openLines} รายการ${pr.status === 'po_issued' ? ' (ออก PO บางส่วนแล้ว)' : ''} · ส่งโดย ${nameOf(pr.createdBy)}`,
        lateDays: 0, waitingDays, tone: tone(0, waitingDays),
      })
    }
    for (const { po, lateDays } of posAwaitingGoods(db, today)) {
      queuedJobs.po.add(po.jobId)
      items.push({
        key: `po:${po.id}`, title: 'รับของตาม PO', ...jobInfo(po.jobId), link: '/purchasing',
        detail: `${po.poNo} · ${po.supplierName}`, due: po.expectedDate, dueLabel: 'กำหนดส่งของ',
        lateDays, tone: tone(lateDays),
      })
    }
  }
  const receivesReturns = can(user, 'stockReturn.receive')
  const queuedReturnJobs = new Set<string>()
  if (receivesReturns) {
    for (const r of db.stockReturns.filter(x => x.status === 'pending')) {
      queuedReturnJobs.add(r.jobId)
      const waitingDays = daysBetweenIso(bkkDate(r.requestedAt), today)
      const item = db.items.find(i => i.id === r.itemId)
      items.push({
        key: `ret:${r.id}`, title: 'ตรวจรับของคืน', ...jobInfo(r.jobId), link: '/master',
        detail: `${item?.name ?? 'วัสดุ'} ${r.qty} ${item?.uom ?? ''}`.trim() + ` · ส่งโดย ${nameOf(r.requestedBy)}`,
        lateDays: 0, waitingDays, tone: tone(0, waitingDays),
      })
    }
  }

  // ---- คำขอรอพิจารณา (Division/Manage) — คนขอกับคนอนุมัติต้องเป็นคนละคน (D1) ----
  const decides = can(user, 'approval.decide')
  const queuedApprovalJobs = new Set<string>()
  if (decides) {
    for (const r of db.approvalRequests.filter(x => x.status === 'pending' && x.requestedBy !== user.id)) {
      queuedApprovalJobs.add(r.jobId)
      const waitingDays = daysBetweenIso(bkkDate(r.requestedAt), today)
      items.push({
        key: `appr:${r.id}`, title: `พิจารณาคำขอ: ${APPROVAL_TYPE_LABEL[r.type]}`, ...jobInfo(r.jobId),
        link: `/approvals?id=${r.id}`, detail: `ส่งโดย ${nameOf(r.requestedBy)}`,
        lateDays: 0, waitingDays, tone: tone(0, waitingDays),
      })
    }
  }

  // ---- ขั้นต่อไปของงานที่ถึงคิวผู้ใช้คนนี้ ----
  for (const job of db.jobs) {
    if (job.terminalStatus === 'installed' || job.terminalStatus === 'cancelled') continue
    const step = jobNextStep(db, job, today)
    // 🔴 รีวิว Flow ข้อ 3 (2026-11-24): "มอบหมายทีมช่าง" ใช้ jobNeedsTeam ตัวเดียวกับป้ายเมนู/ตารางทีม
    //    เดิมคิดเองจากสถานะ (รอออกไซต์/กำลังติดตั้ง/เลยนัด) ⇒ ใบที่มีเครื่องติดตั้งไม่ได้ + อีกเครื่องรอติดตั้ง
    //    เมนูขึ้น Unassigned แต่งานของฉันว่าง · ติดตั้งครบแล้ว (รอปิด) jobNeedsTeam = false อยู่แล้ว
    const unassigned = (user.department === 'service' || isManage) && jobNeedsTeam(db, job)
    if (!unassigned) {
      if (!isMyTurn(step, user, job)) continue
      if (step.waiting && decides) continue                                  // อยู่ในคิวคำขอแล้ว
      if (step.queue && queuedJobs[step.queue].has(job.id)) continue         // อยู่ในคิว PR/PO แล้ว
      // 🔴 รีวิวเฟส 3 ข้อ 2: ขั้น "เคลียร์เรื่องค้างก่อนปิดงาน" ใส่ Division/Purchasing ไว้เพราะคำขอ/ของคืนที่ค้าง
      //    ถ้าส่วนของผู้ใช้คนนี้อยู่ในคิวรายใบครบแล้ว ไม่ต้องขึ้นรายการงานซ้ำ (ส่วนที่ไม่มีคิว เช่น เครื่องติดตั้งไม่ได้ ยังขึ้น)
      const mine = isManage ? step.who : step.who.filter(dep => dep === user.department)
      const covered = (dep: Department) =>
        (dep === 'sales' && queuedApprovalJobs.has(job.id)) || (dep === 'purchasing' && queuedReturnJobs.has(job.id))
      if (mine.length > 0 && mine.every(covered)) continue
    }
    const fieldStep = step.who.includes('service') && (user.department === 'service' || isManage)
    const lateDays = late(step.due)
    items.push({
      key: `job:${job.id}`, ...jobInfo(job.id),
      title: unassigned ? 'มอบหมายทีมช่าง' : step.title,
      detail: unassigned ? `ของออกหน้างานแล้ว แต่ยังไม่มีทีม · ขั้นถัดไป: ${step.title}` : step.detail,
      link: unassigned || fieldStep ? '/service' : step.link ?? `/jobs/${job.id}`,
      due: step.due, dueLabel: step.dueLabel, lateDays, tone: tone(lateDays),
    })
  }

  // เลยกำหนดก่อน (เลยมากก่อน) → มีวันกำหนด (ใกล้ก่อน) → ค้างนานก่อน
  return items.sort((a, b) =>
    (b.lateDays - a.lateDays)
    || (a.due ? 0 : 1) - (b.due ? 0 : 1)
    || (a.due && b.due ? a.due.localeCompare(b.due) : 0)
    || (b.waitingDays ?? 0) - (a.waitingDays ?? 0))
}

// ---------------- ตัวกรองหน้า Jobs (เฟส 3) ----------------
export type JobListFilter = 'all' | 'active' | 'at_risk' | JobStatus

/**
 * แถวนี้อยู่ในรายการตามตัวกรองไหม — "เฉพาะงานของฉัน" ใช้ ownsJob ตัวเดียวกับป้าย "ของฉัน / 🔒 ของคนอื่น"
 * 🔴 รีวิวเฟส 3 ข้อ 4: เดิมเทียบ openedBy === user.id ⇒ ใบเก่าที่ไม่มีผู้เปิด (ทำได้ทุกคน · ป้าย "ของฉัน") หายจากรายการ
 */
export function jobListMatches(
  row: { job: Job; status: JobStatus; d: Pick<JobDelivery, 'atRisk'> },
  filter: JobListFilter, mineOnly: boolean, user: User | null,
): boolean {
  const byStatus = filter === 'all' ? true
    : filter === 'active' ? row.status !== 'installed' && row.status !== 'cancelled'
    : filter === 'at_risk' ? row.d.atRisk          // ไม่ใช่สถานะงาน แต่เป็น "ใบที่ต้องลงมือวันนี้"
    : row.status === filter
  return byStatus && (!mineOnly || ownsJob(user, row.job))
}

// ---------------- ข้อมูลตัดสินใจของคำขอ (เฟส 3 · Approval Queue) ----------------
export interface ApprovalFacts {
  /** ข้อเท็จจริงที่ Division ต้องเห็นก่อนตัดสิน เรียงตามลำดับที่ควรอ่าน */
  facts: { label: string; value: string }[]
  /** ออก PR: มูลค่ารวมจากสำเนา ณ ตอนขอ (เฉพาะรายการที่มีราคา) · unpriced = จำนวนรายการที่ยังไม่มีราคา */
  money?: { total: number; unpriced: number }
  /** ออก PR: วัสดุที่ถูกแก้หลังส่งคำขอ — อนุมัติไม่ได้ (คำขอล้าสมัย 0093) · ว่าง = สดอยู่ */
  stale: string[]
  /** ผลที่จะเกิดถ้าอนุมัติ (และถ้าไม่อนุมัติ สำหรับคำขอที่หยุดงานทั้งใบ) */
  outcome: string
}

const num = (n: number) => n.toLocaleString('th-TH')

/**
 * ข้อมูลตัดสินใจตามประเภทคำขอ — แผน: "Serial ที่จะเบิกจริง · คู่ที่สลับ · ยอดเงินหรือ 'ยังไม่มีราคา'"
 * อ่านจาก payload ที่เก็บ ณ ตอนขอ (0093) — ไม่ใช่สภาพปัจจุบันของงาน (Division ตัดสินสิ่งที่ถูกขอ)
 */
export function approvalFacts(db: DB, r: ApprovalRequest, today = todayIso()): ApprovalFacts {
  const job = db.jobs.find(j => j.id === r.jobId)
  const p = r.payload
  const unitOf = (id?: string) => db.lbsUnits.find(u => u.id === id)
  const sn = (id?: string) => unitOf(id)?.serialLvb ?? '?'
  const facts: ApprovalFacts['facts'] = []
  let money: ApprovalFacts['money']
  const reason = () => { if (p.reason?.trim()) facts.push({ label: 'เหตุผล', value: p.reason.trim() }) }

  switch (r.type) {
    case 'create_pr': {
      const ids = p.requestIds ?? []
      const lines = ids.map(id => {
        const a = db.accessoryRequests.find(x => x.id === id)
        const snap = p.snapshot?.find(s => s.id === id)
        const qty = snap?.qty ?? a?.qtyRequested ?? 0
        const price = snap ? snap.unitPrice : a?.unitPrice ?? null
        const item = db.items.find(i => i.id === a?.itemId)
        return { qty, price, text: `${item?.name ?? 'รายการที่ถูกลบ'} ×${num(qty)} ${item?.uom ?? ''}`.trimEnd() }
      })
      facts.push({ label: 'รายการ', value: lines.map(l => l.price === null ? `${l.text} (ยังไม่มีราคา)` : `${l.text} @ ${num(l.price)}`).join(' · ') || '-' })
      money = {
        total: lines.reduce((s, l) => s + (l.price === null ? 0 : l.price * l.qty), 0),
        unpriced: lines.filter(l => l.price === null).length,
      }
      break
    }
    case 'issue_job': {
      const ids = p.unitIds ?? []
      facts.push(ids.length
        ? { label: `LBS ที่จะเบิก (${ids.length} เครื่อง)`, value: ids.map(sn).join(', ') }
        : { label: 'LBS ที่จะเบิก', value: 'ทุกเครื่องที่พร้อม ณ ตอนอนุมัติ (คำขอก่อน 0059)' })
      if (p.startDate) {
        const range = !p.endDate || p.endDate === p.startDate ? fmtDate(p.startDate) : `${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}`
        facts.push({ label: 'นัดติดตั้ง', value: [range, p.location].filter(Boolean).join(' · ') })
      }
      if (p.note?.trim()) facts.push({ label: 'หมายเหตุ', value: p.note.trim() })
      break
    }
    case 'swap_lbs': {
      const a = unitOf(p.swapAllocatedUnitId), b = unitOf(p.swapStockUnitId)
      const pair = (u?: typeof a) => u ? `${u.serialLvb}/${u.serialOm}` : '?'
      facts.push({ label: 'สลับ', value: `${pair(a)} (บน Job) ↔ ${pair(b)} (คลัง)` })
      // 0056: ต้นทุนย้ายตามเลข Serial — ผู้อนุมัติต้องเห็นตัวเลขที่จะเปลี่ยน
      if (a && b && a.unitCost !== b.unitCost)
        facts.push({ label: 'ต้นทุน LBS ของงาน', value: `${a.unitCost === undefined ? 'ไม่มีราคา' : num(a.unitCost)} → ${b.unitCost === undefined ? 'ไม่มีราคา' : num(b.unitCost)} บาท` })
      reason()
      break
    }
    case 'cancel_job': {
      reason()
      const back = db.lbsUnits.filter(u => u.jobId === r.jobId && u.status === 'allocated').length
      facts.push({ label: 'LBS คืนสต็อก', value: `${back} เครื่อง` })
      facts.push({ label: 'วัสดุที่รับแล้ว', value: p.receivedToCentral ? 'คืนเข้าสต็อกกลาง' : 'ไม่คืนเข้าสต็อกกลาง' })
      break
    }
    case 'revert_install':
    case 'return_lbs': {
      const ids = p.unitIds ?? []
      facts.push({ label: `เครื่อง (${ids.length})`, value: ids.map(id => {
        if (r.type === 'return_lbs') return sn(id)
        const row = db.unitInstallations.filter(x => x.unitId === id && x.outcome === 'installed')
          .sort((x, y) => y.performedAt.localeCompare(x.performedAt))[0]
        return `${sn(id)}${row?.installedDate ? ` (ติดตั้ง ${fmtDate(row.installedDate)})` : ''}`
      }).join(', ') || '-' })
      reason()
      break
    }
    case 'correct_closeout':
      if (p.correction) facts.push({ label: 'ขอแก้', value: `${correctionLabel(db, p.correction)} (งานยังปิดอยู่)` })
      reason()
      break
    case 'reopen_job':
      reason()
      break
  }

  // ผลถ้าอนุมัติ — คำขอที่หยุดงานทั้งใบบอก "ถ้าไม่อนุมัติ" ด้วย (ขั้นงานปกติที่จะทำต่อ)
  const stepTitle = job ? rawNextStep(db, job, jobDelivery(db, job, today), today).title : '-'
  return {
    facts, money,
    stale: r.type === 'create_pr' && r.status === 'pending' ? prSnapshotChanges(db, r) : [],
    outcome: job ? approvalOutcome(r.type, job, stepTitle) : '-',
  }
}

// ---------------- คิว Purchasing (เฟส 4) ----------------
/**
 * PR ที่ยังมีบรรทัดรอออก PO — รวมใบที่ออก PO ไปบางส่วนแล้ว (po_issued + ยังมี pr_sent) · ค้างนานก่อน
 * ใช้ร่วม: ป้ายจำนวนหน้า Purchasing · คิวรอออก PO · งานของฉัน (เดิมแต่ละที่นับเองและนับแค่ pending)
 */
export function prsAwaitingPo(db: DB, today = todayIso()) {
  return db.prs
    .filter(pr => pr.status === 'pending' || pr.status === 'po_issued')
    .map(pr => ({
      pr,
      openLines: db.accessoryRequests.filter(r => r.prId === pr.id && r.status === 'pr_sent').length,
      waitingDays: daysBetweenIso(bkkDate(pr.createdAt), today),
    }))
    .filter(x => x.openLines > 0)
    .sort((a, b) => a.pr.createdAt.localeCompare(b.pr.createdAt))
}

/** PO ที่ยังรอรับของ (issued) · ค้างนานก่อน · lateDays = เลยกำหนดส่งของกี่วัน */
export function posAwaitingGoods(db: DB, today = todayIso()) {
  return db.pos
    .filter(po => po.status === 'issued')
    .map(po => ({
      po,
      waitingDays: daysBetweenIso(bkkDate(po.createdAt), today),
      lateDays: po.expectedDate && po.expectedDate < today ? daysBetweenIso(po.expectedDate, today) : 0,
    }))
    .sort((a, b) => a.po.createdAt.localeCompare(b.po.createdAt))
}

/** ป้ายสถานะ PR ที่แยก "ออก PO บางส่วน" ออกจาก "ออก PO แล้ว" (ค่าในระบบเป็น po_issued ทั้งคู่) */
export function prStatusLabel(db: DB, pr: DB['prs'][number]): string {
  if (pr.status === 'po_issued') {
    const open = db.accessoryRequests.filter(r => r.prId === pr.id && r.status === 'pr_sent').length
    if (open > 0) return `ออก PO บางส่วน · รอออก PO อีก ${open} รายการ`
  }
  return PR_STATUS_LABEL[pr.status] ?? pr.status
}

/**
 * จำนวนที่จะส่งบันทึกรับของ — เฉพาะบรรทัดที่ยังค้างรับอยู่ในตาราง (lines)
 * 🔴 เฟส 4: เดิมส่งทุกค่าที่เคยกรอก รวมบรรทัดที่หลุดจากตารางแล้ว (✏️ แก้จำนวนจนบรรทัดจบ) ⇒ server ปฏิเสธทั้งชุด
 * over = บรรทัดที่กรอกเกินจำนวนค้างรับ (ปิดปุ่มบันทึกก่อนส่ง)
 */
export function pendingReceipts(qty: Record<string, string | number>, lines: { id: string; remaining: number }[]) {
  const receipts: { requestId: string; qty: number }[] = []
  const over: string[] = []
  for (const l of lines) {
    const n = Number(qty[l.id] ?? '')
    if (!Number.isFinite(n) || n <= 0) continue
    receipts.push({ requestId: l.id, qty: n })
    if (n > l.remaining) over.push(l.id)
  }
  return { receipts, over }
}

/** รีวิวเฟส 4 ข้อ 1: ตัวนับ Purchasing ชุดเดียว — Dashboard · ป้ายเมนู · หน้า Purchasing (เดิม Dashboard/เมนูนับแค่ PR pending) */
export function purchasingCounts(db: DB) {
  return { prAwaitingPo: prsAwaitingPo(db).length, poAwaitingGoods: posAwaitingGoods(db).length }
}

/**
 * รีวิวเฟส 4 ข้อ 3: การ์ดคลังกางอยู่ไหม (หน้า LBS Inventory)
 *   ตัวกรอง "ไม่มี Contract No." เปิด = คลังที่มีเครื่องเข้าเงื่อนไขกางเอง แต่ผู้ใช้พับได้ (collapsed)
 *   เดิมบังคับกางจนพับไม่ได้ ต้องล้างตัวกรองก่อน
 */
export function stockPanelOpen(id: string, s: { openStock: string | null; collapsed: Set<string>; filterOn: boolean; hasMatches: boolean }): boolean {
  if (s.openStock === id) return true
  return s.filterOn && s.hasMatches && !s.collapsed.has(id)
}
