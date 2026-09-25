import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useStore, can, ownsJob, canEditJob } from '../data/StoreContext'
import { ACCEPTANCE_TYPES, jobWarranties, deriveJobStatus, jobStatusPhase, jobIsFieldActive, jobBudgetSummary, pendingPurchasingReqs, stockSummary, jobInstallSummary, unitInstallState, jobTeam, memberFullName, effectiveQty, stockCostOf, jobPaymentSummary, unitEta, unitStockState, jobEtaBlockReason, jobIssuePlan, accIssueBlockReason, qtyPendingIssue, qtyIssuedToService, qtyWrittenOff, qtyOutToField, parseLatLng, fmtLatLng, PAYMENT_TYPES, jobDelivery, jobDueExtensions, paymentFiles, paymentFileCount, isAllowedDocFile, MAX_DOC_FILE_MB, DEMO_MAX_DOC_FILE_MB, todayIso, daysBetweenIso } from '../data/logic'
import { BudgetFields, CoordInput, DeliveryBadge, InstallSitesEditor, JobStatusBadge, Modal, toBudgetNum, useConfirm, usePrompt, useToast, useTryAction, emptyCostForm, costFormFromJob, costFormToApi, sitesToApi, sitesFromJob, readAsDataUrl, type CostForm, type InstallSite } from '../ui/components'
import { uploadPaymentDoc, signedPaymentDocUrl, removePaymentDocs } from '../data/remote'
import { supabase } from '../lib/supabase'
import { accStatusLabel, accStatusBadge, accBlockNeedsDetail, EPICOR_TXN, PR_STATUS_LABEL, COST_CATEGORIES, APPROVAL_TYPE_LABEL, PAYMENT_TYPE_LABEL, DEPT_LABEL, JOB_STATUS_LABEL, fmtBaht, fmtDate, fmtDateTime } from '../ui/format'
import {
  type Cell, type NumKind, type ReportCol, type SumTable,
  SHEET_SUMMARY, SHEET_GUIDE, buildWorkbook, dataSheet, guideSheet,
  orDash, saveReport, stampMeta, summarySheet,
} from '../ui/xlsxReport'
import type { LbsUnit, CostCategoryKey, ApprovalType, PaymentType, EpicorTxnType, AccessoryRequest, JobPayment } from '../types'

// ฟอร์มงวดเงิน (0044) — id = null คือเพิ่มงวดใหม่
// 0076: `files` = ไฟล์ที่เลือกไว้แต่ **ยังไม่อัปโหลด** — งวดใหม่ยังไม่มี id จึงผูกไฟล์ไม่ได้
//   จนกว่าจะกดบันทึก · ไฟล์ที่แนบไปแล้วอ่านจาก db ไม่ได้อยู่ในฟอร์ม (การลบมีผลทันที)
interface PayForm {
  id: string | null; payType: PaymentType
  invoiceNo: string; invoiceDate: string; percent: string; amount: string; paidAt: string; note: string
  files: File[]
}

const payFormOf = (r: JobPayment): PayForm => ({
  id: r.id, payType: r.payType,
  invoiceNo: r.invoiceNo ?? '', invoiceDate: r.invoiceDate ?? '',
  percent: r.percent !== undefined ? String(r.percent) : '',
  amount: r.percent !== undefined ? '' : String(r.amount),
  paidAt: r.paidAt ?? '', note: r.note ?? '', files: [],
})

const COST_LABEL: Record<string, string> = Object.fromEntries(COST_CATEGORIES.map(c => [c.key, c.label]))

// ---------------- Export: รายงานผู้บริหาร — Purchase Orders ของ Job ----------------
// สเปกคอลัมน์รวมศูนย์ — แหล่งความจริงเดียวของทั้งชีตข้อมูลและชีต "คำอธิบาย"
// (แนวเดียวกับ SHEET_COLS/MAT_COLS ของหน้า Project Stock และ PR_COLS ของหน้า Purchasing)
// ⚠️ export อย่างเดียว ไม่มี import กลับ — ใส่แถวรวมท้ายตารางได้
const PO_COLS: ReportCol[] = [
  { key: 'รหัส Epicor', width: 14, note: 'รหัสอ้างอิงระบบ ERP' },
  { key: 'ชื่ออุปกรณ์', width: 30, note: 'ชื่อในฐานข้อมูลวัสดุ' },
  // 4 ช่องของบัญชีรายบรรทัด (0067/0068) — ผลรวม 4 ตัวนี้ = จำนวนที่สั่งซื้อ เสมอ
  { key: 'จำนวนที่สั่งซื้อ', width: 14, note: 'จำนวนที่ Project ขอไว้ตอนเพิ่มวัสดุ · แถวที่แหล่งเป็น "คลังคงเหลือ" คือจำนวนที่เบิกมาจากคลัง ไม่ได้ซื้อ', num: 'int', total: true },
  { key: 'เบิกออกหน้างาน', width: 15, note: 'จำนวนที่ส่งถึงมือทีมช่างแล้ว — ไม่ลดต้นทุนของงาน (ของยังเป็นของงานนี้ แค่ย้ายที่)', num: 'int', total: true },
  { key: 'คงเหลือที่ Job', width: 14, note: 'ยังไม่ออกหน้างาน ยังไม่คืนคลัง ยังไม่ตัดจำหน่าย — ต้องเป็น 0 ทุกบรรทัดถึงปิดงานได้', num: 'int', total: true },
  { key: 'โอนคืนคลัง', width: 12, note: 'จำนวนที่ใช้ไม่หมดแล้วกด "📦 โอนเข้าคลัง" คืนไป — **ตัวเดียวที่หักต้นทุนออกจากงาน**', num: 'int', total: true },
  { key: 'ตัดจำหน่าย', width: 12, note: 'ของเหลือที่ไม่คุ้มจะคืนคลัง — **ต้นทุนยังอยู่กับงาน** (ของสูญไปกับงานนี้จริง)', num: 'int', total: true },
  { key: 'จำนวนที่คิดต้นทุน', width: 18, note: 'จำนวนที่สั่งซื้อ − โอนคืนคลัง · รายการที่ยกเลิก/คืนสต็อกทั้งบรรทัดนับเป็น 0', num: 'int', total: true },
  { key: 'หน่วย', width: 9, note: 'หน่วยนับ' },
  { key: 'ราคา/หน่วย', width: 14, note: 'ของจากคลังคงเหลือ = ต้นทุนถัวเฉลี่ยตอนเบิก · ของที่ซื้อ = ราคาจริงหลังออก PO · ว่าง = ยังไม่กรอก', num: 'money' },
  { key: 'ต้นทุนที่ตัดเข้างาน', width: 20, note: 'ราคา/หน่วย × จำนวนที่คิดต้นทุน — ตัวเลขนี้คือที่ไปบวก actual ของหมวดงบ', num: 'money', total: true },
  { key: 'ต้นทุนที่ถึงหน้างานแล้ว', width: 22, note: 'ราคา/หน่วย × เบิกออกหน้างาน — **ตัวเลขดูอย่างเดียว ไม่ได้ใช้คิดงบ** ใช้ตอบว่าเงินที่จ่ายไปถึงมือช่างเท่าไร', num: 'money', total: true },
  { key: 'Phase Budget', width: 16, note: 'หมวดต้นทุนที่บรรทัดนี้ตัดเข้า (Raw Material / Outsourcing)' },
  { key: 'Phase', width: 12, note: 'Phase ที่กรอกไว้ในงบหมวดนั้น' },
  { key: 'แหล่ง', width: 14, note: 'คลังคงเหลือ (เบิกได้เลย) หรือ Purchasing (ต้องออก PR/PO)' },
  { key: 'สถานะ', width: 22, note: 'ของชิ้นนี้อยู่ที่ไหนตอนนี้ — ป้ายเดียวกับที่แสดงบนหน้าจอ' },
  { key: 'PR / PO', width: 20, note: 'เลข PR และ PO ที่บรรทัดนี้ผูกอยู่ (1 PR ออกได้หลาย PO)' },
  { key: 'ซัพพลายเออร์', width: 22, note: 'ชื่อที่กรอกไว้ตอนออก PO · ว่าง = ยังไม่ออก PO หรือมาจากคลังคงเหลือ' },
  { key: 'เบิกให้ Service', width: 16, note: 'วันที่ส่งของออกหน้างาน (0059) · ว่าง = ของยังอยู่กับ Job' },
  // ทำเบิก-Epicor (0064) + ประเภท transaction (0065) — แยก 4 คอลัมน์ ไม่ยุบเป็นช่องเดียว
  // เพราะไฟล์นี้คือตัวที่เอาไปกระทบยอดกับ ERP: ฝ่ายบัญชีกรองด้วย "ประเภท" (รายได้ vs ต้นทุน) ก่อนอื่นเสมอ
  { key: 'ทำเบิก-Epicor', width: 14, note: '"ทำแล้ว" = ตัดใบเบิกใน Epicor แล้ว (0064) — ธงกระทบยอดกับ ERP ไม่ขวางสายงาน · ว่าง = ยังไม่ได้ทำ' },
  { key: 'ประเภท Epicor', width: 16, note: 'Cust-Ship = ส่งลูกค้าแล้วออก Invoice (ฝั่งรายได้) · Issue-Mis = เบิกไปใช้ ไม่ออก Invoice (ฝั่งต้นทุน) · ว่าง = แถวที่กด Done ไว้ก่อนมี dropdown (0065) ไม่ backfill' },
  { key: 'เลขที่เอกสาร Epicor', width: 20, note: 'เลขเอกสารที่กรอกไว้ตอนกด Done · ว่างได้ แต่ถ้ากรอกจะตามกลับไป Epicor ได้' },
  { key: 'วันที่ทำเบิก', width: 14, note: 'วันที่กด Done ในระบบนี้ — ไม่ใช่วันที่บนเอกสาร Epicor' },
  { key: 'ซื้อเพิ่มหลังเบิก', width: 16, note: 'ใช่ = รายการที่เพิ่มหลังเบิกงานไปแล้ว (ต้นทุนบานปลายมักอยู่กลุ่มนี้)' },
  { key: 'วันที่ขอวัสดุ', width: 14, note: 'วันที่ Project กดเพิ่มวัสดุรายการนี้' },
]

/** สัดส่วน % แบบปลอดหารศูนย์ */
const pctOf = (part: number, whole: number): Cell => (whole > 0 ? (part / whole) * 100 : '-')
const PCT: NumKind = 'pct'

/** พิกัดจุดติดตั้งตามแผน (0060) — กดเปิด Google Maps ตรวจได้ว่าหมุดลงถูกที่ */
function PlanCoordCell({ lat, lng }: { lat?: number; lng?: number }) {
  if (lat == null || lng == null) return <span className="muted">ยังไม่ระบุ</span>
  return (
    <a className="mono" href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer">
      📍 {lat}, {lng}
    </a>
  )
}

function SerialPicker({ units, selected, toggle, showEta }: {
  units: LbsUnit[]
  selected: Set<string>
  toggle: (id: string) => void
  /** โชว์ ETA ของเครื่องที่ยังไม่เข้าคลัง (0049) — ใช้ตอนดึงเข้า Job · ไม่ต้องใช้ตอนคืน */
  showEta?: boolean
}) {
  return (
    <div className="serial-grid">
      {units.map(u => {
        const pending = showEta && unitStockState(u) === 'pending'
        return (
          <div key={u.id} className={`serial-pick${selected.has(u.id) ? ' selected' : ''}`} onClick={() => toggle(u.id)}>
            <span className="pick-main">
              <input type="checkbox" readOnly checked={selected.has(u.id)} />
              <span className="mono">{u.serialLvb}</span>
            </span>
            {pending && (
              <span className="pick-eta" title="ของยังไม่เข้าคลัง (Status = Pending) — ดึงจองล่วงหน้าได้">
                ⚠️ ETA {fmtDate(unitEta(u))}
              </span>
            )}
          </div>
        )
      })}
      {units.length === 0 && <div className="muted">ไม่มีเครื่องให้เลือก</div>}
    </div>
  )
}

export default function JobDetailPage() {
  const { jobId } = useParams()
  const { db, user, act } = useStore()
  const navigate = useNavigate()
  const tryAction = useTryAction()
  const { show } = useToast()
  const isDemo = !supabase                 // 0076 — เพดานขนาดไฟล์คนละค่า (demo เก็บใน localStorage)

  const job = db.jobs.find(j => j.id === jobId)
  const [modal, setModal] = useState<'draw' | 'return' | 'accessory' | 'issue' | 'cancel' | 'edit' | 'budget' | 'swap' | null>(null)
  const [swapForm, setSwapForm] = useState({ allocatedUnitId: '', stockUnitId: '', reason: '' })
  const [budgetOpen, setBudgetOpen] = useState(false)   // ตาราง 7 หมวด (Item 4: เริ่มซ่อน)
  const { ask: askPrompt, element: promptEl } = usePrompt()      // แทน window.prompt (ชุด B)
  const { ask: askConfirm, element: confirmEl } = useConfirm()   // แทน window.confirm (ชุด B)
  const [payOpen, setPayOpen] = useState(false)         // ตารางงวดเงิน (0044 · เริ่มซ่อน เหมือน 7 หมวด)
  const [poOpen, setPoOpen] = useState(false)           // ตารางวัสดุใน Purchase Orders — เริ่มซ่อน (หน้ายาวเกินไปเมื่อวัสดุเยอะ)
  const [payForm, setPayForm] = useState<PayForm | null>(null)
  const [dueForm, setDueForm] = useState<{ newDueDate: string; reason: string } | null>(null)   // ขยายกำหนดส่ง (0075)
  const [uploading, setUploading] = useState(false)      // กำลังอัปโหลดเอกสารแนบงวดเงิน (0076)
  const [drawStock, setDrawStock] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [returnTarget, setReturnTarget] = useState('')
  // phaseBudget = หมวดต้นทุนที่ตัด (raw_mat/outsourcing) สำหรับ source purchasing
  const [accForm, setAccForm] = useState({ itemId: '', qty: 1, source: 'central_stock' as 'central_stock' | 'purchasing', unitPrice: '', phaseBudget: 'raw_mat' as CostCategoryKey })
  const [accSearch, setAccSearch] = useState('')   // ค้นหาวัสดุในโมดัลเพิ่มวัสดุ
  const [issueForm, setIssueForm] = useState({ startDate: '', endDate: '', location: '', note: '' })
  // 0059: popup "จะเบิกอะไร" — เลือก LBS รายเครื่อง + วัสดุรายบรรทัด (จัดกลุ่มตาม PO)
  const [pickedUnits, setPickedUnits] = useState<Set<string>>(new Set())
  const [pickedReqs, setPickedReqs] = useState<Set<string>>(new Set())
  /**
   * จำนวนที่จะเบิกรอบนี้ต่อบรรทัด (0067) — เก็บเป็น string เพราะเป็นค่าที่กำลังพิมพ์
   * (ลบทิ้งหมดต้องได้ช่องว่าง ไม่ใช่เด้งเป็น 0 ทันที) · แปลงเป็นตัวเลขตอนตรวจ/ตอนส่ง
   * ⚠️ ต้องประกาศรวมกับ useState ตัวอื่นเหนือ `if (!job) return` — วางใต้ early return = hooks พัง
   */
  const [issueQty, setIssueQty] = useState<Record<string, string>>({})
  const [cancelReason, setCancelReason] = useState('')
  const [receivedToCentral, setReceivedToCentral] = useState(true)
  // planCoord = พิกัดจุดติดตั้งที่ 1 (0060) — ข้อความ "lat, lng" แปลงตอน submit
  const [editForm, setEditForm] = useState({ jobNo: '', customerName: '', contactPhone: '', scope: '', installLocation: '', requiredDate: '', lbsQtyRequired: 1, salePrice: '', planCoord: '' })
  const [editCosts, setEditCosts] = useState<CostForm>(emptyCostForm())
  const [editSites, setEditSites] = useState<InstallSite[]>([])   // จุดติดตั้งเพิ่มเติม (modal แก้ไขข้อมูล Job)

  const status = job ? deriveJobStatus(db, job) : 'draft'
  // 0042: Project ทำรายการได้เฉพาะ Job ที่ตัวเองเปิด — ใบอื่นปุ่มหายทั้งหน้า (ข้อมูลยังดูได้ครบ)
  const canManage = canEditJob(user, job)
  const readOnlyJob = can(user, 'job.manage') && !!job && !ownsJob(user, job)
  // Payment แก้ได้แม้ปิดงานแล้ว (PAC/Retention มาหลังติดตั้ง) — ปิดเฉพาะ Job ที่ยกเลิก ตรงกับ guard ฝั่ง DB
  const canPay = canManage && !!job && job.terminalStatus !== 'cancelled'
  // Manage (admin) ข้ามขั้นอนุมัติได้ — project ต้องส่งคำขอให้ Division ก่อน (0016)
  const isManage = can(user, 'master.manage')
  const canCleanup = can(user, 'accessory.cleanup')   // Project/Division/Manage ลบรายการวัสดุที่ยกเลิก
  // สิทธิ์ดาวน์โหลดรายงานผู้บริหาร (ไฟล์พาราคา/ต้นทุน/กำไรออกนอกระบบ) — ไม่มีสิทธิ์ = ไม่เห็นปุ่ม
  const canReport = can(user, 'report.exec')
  const canEpicor = can(user, 'epicor.issue')         // Purchasing/Manage ติ๊กทำเบิก-Epicor (0064)
  const locked = !job || job.terminalStatus !== null
  // ฝั่งจัดซื้อปลดล็อกตอน issued ได้ (จัดซื้อเพิ่มเติมหลังเบิก 0037) — ปิดเมื่อปิดงาน/ยกเลิก
  const procureLocked = !job || job.terminalStatus === 'installed' || job.terminalStatus === 'cancelled'
  // รายการที่เพิ่มหลังเบิก (createdAt > issuedAt) — ใช้ติดป้ายให้เห็นว่าเป็นการซื้อเพิ่ม
  const isExtra = (createdAt: string) => !!job?.issuedAt && createdAt > job.issuedAt
  const pendingApprovalOf = (type: ApprovalType) =>
    db.approvalRequests.some(r => r.jobId === jobId && r.type === type && r.status === 'pending')

  const allocatedUnits = useMemo(
    () => db.lbsUnits.filter(u => u.jobId === jobId && (u.status === 'allocated' || u.status === 'issued')),
    [db.lbsUnits, jobId],
  )
  // เครื่องว่างในคลัง (ทุก Stock) ที่ใช้เป็นคู่สลับเลข Serial ได้
  const inStockUnits = useMemo(() => db.lbsUnits.filter(u => u.status === 'in_stock'), [db.lbsUnits])
  const accReqs = db.accessoryRequests.filter(r => r.jobId === jobId)
  const pendingReqs = job ? pendingPurchasingReqs(db, job.id) : []
  const receivedFromPo = accReqs.filter(r => r.source === 'purchasing' && r.status === 'received')
  const jobPrs = db.prs.filter(p => p.jobId === jobId)

  if (!job) return <div className="empty">ไม่พบ Job นี้ <Link to="/jobs">กลับหน้า Jobs</Link></div>

  const budget = jobBudgetSummary(db, job)
  const pay = jobPaymentSummary(db, job)
  const userOf = (id: string) => db.users.find(u => u.id === id)?.fullName ?? '-'
  // ---- สิทธิ์แก้ Project Budget (0023 · ขยายสิทธิ์ที่ 0077) ----
  // Project เจ้าของงาน + Manage แก้ได้ **ทุกสถานะ ยกเว้นใบที่ยกเลิก** — ตรงกับ guard ฝั่ง DB
  //   (app_assert_job_cost_editable) เพราะต้นทุนจริง 5 หมวดที่กรอกมือเกิดหลังเบิกเป็นส่วนใหญ่
  // canBudgetRole = คนที่ "ตำแหน่งเกี่ยวกับงบ" (Project/Manage) → เห็นปุ่มเสมอ แม้กดไม่ได้
  const canBudgetRole = can(user, 'job.manage')
  const blockedBudgetReason =
    !canManage && !isManage
      ? `ใบนี้เปิดโดย${job.openedBy ? ` ${userOf(job.openedBy)}` : 'ผู้ใช้อื่น'} — แก้งบประมาณได้เฉพาะเจ้าของงาน หรือ Manage`
    : job.terminalStatus === 'cancelled'
      ? `${job.jobNo} ถูกยกเลิกไปแล้ว — ตัวเลขเงินของใบที่ยกเลิกต้องไม่ขยับอีก`
      : ''
  // 0075 — สถานะกำหนดส่ง · ขยายได้จนถึง issued (ปิดเมื่อ installed/cancelled ตรงกับ guard ฝั่ง DB)
  const delivery = jobDelivery(db, job)
  const dueHistory = jobDueExtensions(db, job.id)
  const canExtendDue = canManage && !procureLocked
  const itemOf = (id: string) => db.items.find(i => i.id === id)
  const stockOf = (id: string) => db.projectStocks.find(s => s.id === id)
  const togglePick = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const openModal = (m: typeof modal) => { setPicked(new Set()); setModal(m) }
  const close = () => setModal(null)

  const drawableUnits = db.lbsUnits.filter(u => u.projectStockId === drawStock && u.status === 'in_stock')
  const returnableUnits = db.lbsUnits.filter(u => u.jobId === jobId && u.status === 'allocated')
  // cap ตาม Scope: ดึงรวมได้ไม่เกินจำนวนตอนเปิด Job
  // 0059: นับเครื่องที่เบิกออกไปแล้วด้วย (allocatedUnits = allocated + issued)
  //   ไม่งั้นหลังเบิก LBS บางส่วน ช่องว่างจะเปิดให้ดึงเกิน Scope
  const drawCap = Math.max(0, job.lbsQtyRequired - allocatedUnits.length)
  // เครื่องที่เลือกอยู่แต่ ETA ยังไม่ถึง (0049) — ดึงจองล่วงหน้าได้ แต่กันตอนเบิก (0052)
  const pickedPending = drawableUnits.filter(u => picked.has(u.id) && unitStockState(u) === 'pending').length
  // Job ถือของที่ยังไม่ถึงคลัง → เบิกเครื่องนั้นไม่ได้ (0059 บล็อกรายเครื่อง ไม่เหมาทั้งใบแล้ว)
  const etaBlock = jobEtaBlockReason(db, job.id)
  // 0059: แหล่งความจริงเดียวว่า "อะไรเบิกได้ / อะไรยังไม่ได้" — ใช้ทั้ง popup, ปุ่ม และแผงสรุป
  const plan = jobIssuePlan(db, job.id)
  const canIssueAnything = plan.accReady.length > 0 || (plan.lbsShort === 0 && plan.lbsReady.length > 0)
  /**
   * Job ปิดเป็น Issued แล้ว แต่ยังมีวัสดุ "ซื้อเพิ่มหลังเบิก" (0037) ที่รับของครบและรอส่งออกหน้างาน
   * — ใช้เป็นเงื่อนไขให้แถบปุ่ม + ปุ่มเบิก ยังโผล่อยู่หลังใบปิด (บั๊กที่ผู้ใช้แจ้ง 2026-09-11)
   * ⚠️ ต้องเป็น `procureLocked` ไม่ใช่ `locked` — ให้ตรงกับ guard ฝั่ง RPC ที่ปิดเฉพาะ installed/cancelled
   */
  const canIssueExtra = !procureLocked && plan.accReady.length > 0
  const toggleUnit = (id: string) => setPickedUnits(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  const toggleReq = (id: string) => setPickedReqs(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  const toggleGroup = (ids: string[], on: boolean) => setPickedReqs(prev => {
    const n = new Set(prev); ids.forEach(id => on ? n.add(id) : n.delete(id)); return n
  })
  const setQty = (id: string, v: string) => setIssueQty(prev => ({ ...prev, [id]: v }))
  /** ค่าที่กรอกอยู่ + ผลตรวจของบรรทัดนั้น — ใช้ทั้งตอน render และตอนกดยืนยัน */
  const qtyState = (r: AccessoryRequest) => {
    const max = qtyPendingIssue(r)
    const raw = issueQty[r.id] ?? String(max)
    const n = Number(raw)
    const err = raw.trim() === '' ? 'กรอกจำนวน'
      : !Number.isFinite(n) || n <= 0 ? 'ต้องมากกว่า 0'
      : n > max ? `เบิกได้ไม่เกิน ${max}`
      : undefined
    return { raw, n, max, err, partial: !err && n < max }
  }
  // เปิด popup พร้อมติ๊กทุกอย่างที่พร้อมไว้ให้ + จำนวนเต็มที่ค้าง (เคสปกติ = เบิกทุกอย่างที่ได้ทั้งจำนวน)
  const openIssueModal = () => {
    setPickedUnits(new Set(plan.lbsShort === 0 ? plan.lbsReady.map(u => u.id) : []))
    setPickedReqs(new Set(plan.accReady.map(r => r.id)))
    setIssueQty(Object.fromEntries(plan.accReady.map(r => [r.id, String(qtyPendingIssue(r))])))
    setIssueForm({
      startDate: job.installStartDate || job.requiredDate || '',
      endDate: job.installEndDate || job.requiredDate || '',
      location: job.issueLocation || job.installLocation || '',
      note: '',
    })
    setModal('issue')
  }
  /**
   * เบิกวัสดุก่อน แล้วค่อย LBS — เรียงแบบนี้เพราะ LBS เป็นชิ้นสุดท้ายที่ทำให้ใบครบ
   * (finalizeIssue จะปิดใบในก้าวเดียว ไม่ใช่ปิดแล้วยังมีวัสดุค้าง)
   * ⚠️ 2 คำสั่งแยก transaction กันบนโหมด Supabase — ถ้าตัวหลังพลาด ตัวแรกยังอยู่
   *    ซึ่งถูกต้องตามโมเดลใหม่: "เบิกบางส่วน" เป็นสถานะที่ถูกกฎหมาย ไม่ใช่ข้อมูลพัง
   */
  const submitIssue = async () => {
    const reqIds = [...pickedReqs]
    const unitIds = [...pickedUnits]
    if (reqIds.length > 0) {
      const picked = accReqs.filter(r => pickedReqs.has(r.id))
      const qtys = Object.fromEntries(picked.map(r => [r.id, qtyState(r).n]))
      const nPartial = picked.filter(r => qtyState(r).partial).length
      const ok = await tryAction(
        () => act.issueJobAccessory({ jobId: job.id, requestIds: reqIds, qtys, ...issueForm }),
        `เบิกวัสดุ ${reqIds.length} รายการของ ${job.jobNo} ให้ Service แล้ว` +
        (nPartial > 0 ? ` (เบิกบางส่วน ${nPartial} รายการ — ของที่เหลือยังค้างอยู่ที่ Job)` : ''))
      if (!ok) return
    }
    if (unitIds.length > 0) {
      const ok = isManage
        ? await tryAction(() => act.issueJobLbs({ jobId: job.id, unitIds, ...issueForm }),
            `เบิก LBS ${unitIds.length} เครื่องของ ${job.jobNo} ให้ Service แล้ว`)
        : await tryAction(() => act.requestApproval({ type: 'issue_job', jobId: job.id, payload: { unitIds, ...issueForm } }),
            `ส่งคำขอเบิก LBS ${unitIds.length} เครื่องของ ${job.jobNo} ให้ Division พิจารณาแล้ว`)
      if (!ok) return
    }
    close()
  }
  const toggleDraw = (id: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else if (next.size < drawCap) next.add(id)
    return next
  })

  const accessoryItems = db.items.filter(i => i.itemType === 'accessory')
  const filterAcc = (term: string) => {
    const t = term.trim().toLowerCase()
    if (!t) return accessoryItems
    return accessoryItems.filter(i =>
      i.name.toLowerCase().includes(t) || (i.epicorCode ?? '').toLowerCase().includes(t) || i.code.toLowerCase().includes(t))
  }
  const filteredAcc = filterAcc(accSearch)
  const selAccItem = itemOf(accForm.itemId)
  const selAccStockQty = db.accessoryStock.find(r => r.itemId === accForm.itemId)?.qtyOnHand ?? 0

  // Export รายงานผู้บริหาร — Purchase Orders ของ Job → Excel · xlsx โหลด dynamic กัน bundle บวม
  //   ชีต 1 "สรุปผู้บริหาร" = งบ vs ต้นทุนจริง + งวดเงิน (ตัวเลขที่ผู้บริหารถามในห้องประชุม)
  //   ชีต 2 "Purchase Orders" = ทุกบรรทัด + แถวรวม · ชีต 3 "คำอธิบาย" = คอลัมน์นี้คืออะไร
  const exportPurchaseOrders = async () => {
    if (!job) return
    const XLSX = await import('xlsx')
    // ⚠️ ต้องใช้ effectiveQty ให้ตรงกับที่แสดงบนจอและที่ตัดงบจริง (§12) — เดิมใช้ qtyRequested
    //    ทำให้ไฟล์ Excel ไม่ตรงกับหน้าจอเมื่อมีการโอนวัสดุเหลือคืนคลัง
    const isActive = (r: typeof accReqs[number]) => r.status !== 'cancelled' && r.status !== 'returned'
    const chargedQty = (r: typeof accReqs[number]) => (isActive(r) ? effectiveQty(r) : 0)
    const chargedValue = (r: typeof accReqs[number]) =>
      isActive(r) && r.unitPrice !== undefined ? r.unitPrice * effectiveQty(r) : 0

    const rows: Record<string, Cell>[] = accReqs.map(r => {
      const item = itemOf(r.itemId)!
      const pr = db.prs.find(p => p.id === r.prId)
      const po = r.poId ? db.pos.find(p => p.id === r.poId) : undefined
      const lineValue = isActive(r) && r.unitPrice !== undefined ? r.unitPrice * effectiveQty(r) : undefined
      const cat = r.phaseBudget ? (COST_LABEL[r.phaseBudget] ?? r.phaseBudget) : ''
      const phase = r.phaseBudget ? (job.budgetCosts?.[r.phaseBudget as CostCategoryKey]?.phase ?? '') : ''
      return {
        'รหัส Epicor': item.epicorCode || '',
        'ชื่ออุปกรณ์': item.name,
        'จำนวนที่สั่งซื้อ': r.qtyRequested,
        'เบิกออกหน้างาน': isActive(r) ? qtyIssuedToService(r) : 0,
        'คงเหลือที่ Job': isActive(r) ? qtyPendingIssue(r) : 0,
        'โอนคืนคลัง': r.qtyTransferred ?? 0,
        'ตัดจำหน่าย': isActive(r) ? qtyWrittenOff(r) : 0,
        'จำนวนที่คิดต้นทุน': chargedQty(r),
        'หน่วย': item.uom,
        'ราคา/หน่วย': r.unitPrice ?? '',
        'ต้นทุนที่ตัดเข้างาน': lineValue ?? '',
        'ต้นทุนที่ถึงหน้างานแล้ว': isActive(r) && r.unitPrice !== undefined ? r.unitPrice * qtyOutToField(r) : '',
        'Phase Budget': cat,
        'Phase': phase,
        'แหล่ง': r.source === 'central_stock' ? 'คลังคงเหลือ' : 'Purchasing',
        'สถานะ': accStatusLabel(r),
        // 0064 — ไฟล์นี้คือตัวที่เอาไปกระทบยอดกับ Epicor จึงต้องมี 3 ช่องนี้ติดไปด้วย
        'ทำเบิก-Epicor': r.epicorIssuedAt ? 'ทำแล้ว' : '',
        'ประเภท Epicor': r.epicorTxnType ? EPICOR_TXN[r.epicorTxnType].label : '',
        'เลขที่เอกสาร Epicor': r.epicorDocNo ?? '',
        'วันที่ทำเบิก': r.epicorIssuedAt ? r.epicorIssuedAt.slice(0, 10) : '',
        'PR / PO': [pr?.prNo, po?.poNo].filter(Boolean).join(' / '),
        'ซัพพลายเออร์': po?.supplierName ?? '',
        'เบิกให้ Service': r.issuedToServiceAt?.slice(0, 10) ?? '',
        'ซื้อเพิ่มหลังเบิก': isExtra(r.createdAt) ? 'ใช่' : '',
        'วันที่ขอวัสดุ': r.createdAt.slice(0, 10),
      }
    })
    const ws = dataSheet(XLSX, rows, PO_COLS, { totalRow: true, totalLabel: `รวม ${rows.length} รายการ` })

    // ---------------- ชีต "สรุปผู้บริหาร" ----------------
    // ตัวเลขงบมาจาก jobBudgetSummary / jobPaymentSummary ชุดเดียวกับที่การ์ดบนหน้าจอใช้
    const activeReqs = accReqs.filter(isActive)
    const noPrice = activeReqs.filter(r => r.unitPrice === undefined)
    const extraReqs = activeReqs.filter(r => isExtra(r.createdAt))
    const materialTotal = accReqs.reduce((n, r) => n + chargedValue(r), 0)
    const overBudget = budget.remainingCost !== undefined && budget.remainingCost < 0

    // งบ 7 หมวด — เรียงตาม COST_CATEGORIES เพื่อให้ลำดับตรงกับตารางบนหน้าจอเป๊ะ
    const catRows = budget.categories.map(c => [
      COST_LABEL[c.key] ?? c.key,
      c.phase ?? '',
      c.fromPR ? 'จาก PR/PO' : 'กรอกเอง',
      c.budget,
      c.actual,
      c.remaining,
      pctOf(c.actual, c.budget),
    ] as Cell[])

    // วัสดุแบ่งตามสถานะ — ตอบว่า "เงินก้อนนี้ค้างอยู่ขั้นไหน"
    const statusMap = new Map<string, { lines: number; qty: number; value: number }>()
    accReqs.forEach(r => {
      const key = accStatusLabel(r)
      const g = statusMap.get(key) ?? { lines: 0, qty: 0, value: 0 }
      g.lines += 1
      g.qty += chargedQty(r)
      g.value += chargedValue(r)
      statusMap.set(key, g)
    })
    const statusRows = [...statusMap.entries()].sort((a, b) => b[1].value - a[1].value)

    // PR / PO ของงานนี้ — ใบไหนยังค้างรับของ ใบไหนปิดแล้ว
    const poRows = db.pos
      .filter(p => p.jobId === job.id)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(p => {
        const lines = accReqs.filter(r => (r.poId ? r.poId === p.id : false))
        const pr = db.prs.find(x => x.id === p.prId)
        return [
          p.poNo,
          pr?.prNo ?? '-',
          p.supplierName || '-',
          fmtDate(p.expectedDate),
          p.status === 'received' ? `รับของครบ ${p.receivedAt?.slice(0, 10) ?? ''}`
            : p.status === 'cancelled' ? 'ยกเลิก' : 'ออก PO แล้ว รอรับของ',
          lines.length,
          lines.reduce((n, r) => n + chargedValue(r), 0),
        ] as Cell[]
      })

    const payRows = pay.rows.map(p => [
      PAYMENT_TYPE_LABEL[p.payType] ?? p.payType,
      p.invoiceNo || '-',
      p.invoiceDate ? fmtDate(p.invoiceDate) : '-',
      p.percent ?? '-',
      p.amount,
      p.paidAt ? fmtDate(p.paidAt) : 'ยังไม่รับเงิน',
    ] as Cell[])

    const tables: SumTable[] = [
      {
        title: 'งบต้นทุน 7 หมวด (Project Budget) — งบ vs เกิดขึ้นจริง',
        head: ['หมวดต้นทุน', 'Phase', 'ที่มาของ actual', 'งบประมาณ (บาท)', 'เกิดขึ้นจริง (บาท)', 'คงเหลือ (บาท)', 'ใช้ไป'],
        rows: catRows,
        num: { 3: 'money0', 4: 'money0', 5: 'money0', 6: PCT },
        total: [
          'รวมทุกหมวด', '', '',
          orDash(budget.cost), budget.totalActual, orDash(budget.remainingCost),
          budget.cost !== undefined ? pctOf(budget.totalActual, budget.cost) : '-',
        ],
      },
      {
        title: 'วัสดุแบ่งตามสถานะ — เงินค้างอยู่ขั้นไหน',
        head: ['สถานะ', 'รายการ', 'จำนวนที่คิดต้นทุน', 'ต้นทุนที่ตัดเข้างาน (บาท)', 'สัดส่วนของค่าวัสดุ'],
        rows: statusRows.map(([k, g]) => [k, g.lines, g.qty, g.value, pctOf(g.value, materialTotal)]),
        num: { 1: 'int', 2: 'int', 3: 'money0', 4: PCT },
        total: [
          `รวม ${accReqs.length} รายการ`, accReqs.length,
          accReqs.reduce((n, r) => n + chargedQty(r), 0), materialTotal, materialTotal > 0 ? 100 : '-',
        ],
        empty: '(ยังไม่มีรายการวัสดุในงานนี้)',
      },
      {
        title: 'PO ของงานนี้',
        head: ['PO No.', 'PR No.', 'ซัพพลายเออร์', 'กำหนดส่ง', 'สถานะ', 'รายการ', 'ต้นทุนที่ตัดเข้างาน (บาท)'],
        rows: poRows,
        num: { 5: 'int', 6: 'money0' },
        empty: '(ยังไม่มี PO — วัสดุทั้งหมดมาจากคลังคงเหลือ หรือยังไม่ได้ออก PR)',
      },
      {
        title: 'งวดเงิน (Payment)',
        head: ['งวด', 'Invoice No.', 'วันที่ Invoice', '%', 'ยอดเงิน (บาท)', 'รับเงินเมื่อ'],
        rows: payRows,
        num: { 3: PCT, 4: 'money0' },
        total: [`รวม ${pay.rows.length} งวด`, '', '', '', pay.billed, `รับแล้ว ${pay.paid.toLocaleString('th-TH')} บาท`],
        empty: '(ยังไม่ได้ตั้งงวดเงินสำหรับงานนี้)',
      },
    ]

    const wsSum = summarySheet(XLSX, {
      title: 'รายงานผู้บริหาร — Purchase Orders รายโครงการ',
      scope: `${job.jobNo} · ${job.customerName}`,
      meta: [
        ['Job No.', job.jobNo],
        ['ลูกค้า', job.customerName],
        ['เบอร์ติดต่อ', job.contactPhone || '-'],
        ['Scope งาน', job.scope || '-'],
        ['สถานที่ติดตั้ง', job.installLocation || '-'],
        // 0075 — แยก "ตามสัญญา" กับ "ที่มีผล" ให้ชัด · ไฟล์นี้ถูกส่งต่อออกนอกระบบ
        //   ถ้าเขียนแค่ค่าเดียวหลังมีการเลื่อน คนอ่านจะไม่รู้ว่าเทียบกับวันไหน
        ['กำหนดส่ง (ตามสัญญา)', fmtDate(delivery.contractDue)],
        ...(delivery.extension
          ? [
            ['กำหนดส่ง (ที่มีผล)', `${fmtDate(delivery.due)} · เลื่อน ${delivery.extensionCount} ครั้ง`] as [string, string],
            ['เหตุผลการเลื่อนล่าสุด', delivery.extension.reason] as [string, string],
          ]
          : []),
        ['สถานะกำหนดส่ง', delivery.label],
        ['สถานะงาน', JOB_STATUS_LABEL[status] + (jobStatusPhase(db, job) ? ` · ${jobStatusPhase(db, job)}` : '')],
        ['ผู้รับผิดชอบงาน', job.openedBy ? userOf(job.openedBy) : 'ไม่ระบุ (งานเก่า)'],
        ['LBS ตาม Scope / ดึงเข้างานแล้ว', `${job.lbsQtyRequired} / ${allocatedUnits.length} เครื่อง`],
        ...stampMeta(user, user ? DEPT_LABEL[user.department] : undefined),
      ],
      warnings: [
        ...(budget.cost === undefined ? ['งานนี้ยังไม่ได้ตั้งงบต้นทุน 7 หมวด — ตัวเลข "คงเหลือ" และ "กำไร" จึงคำนวณไม่ได้'] : []),
        ...(overBudget ? [`ต้นทุนเกิดขึ้นจริงเกินงบแล้ว ${Math.abs(budget.remainingCost ?? 0).toLocaleString('th-TH')} บาท`] : []),
        ...(noPrice.length > 0 ? [`มี ${noPrice.length} รายการที่ยังไม่ได้กรอกราคา — ค่าวัสดุในไฟล์นี้ต่ำกว่าความจริง`] : []),
        ...(pay.stale ? ['ราคาขายถูกแก้หลังออกใบวางบิล — ยอดงวดที่ freeze ไว้ไม่ตรงกับ % แล้ว'] : []),
      ],
      kpis: [
        { label: 'ราคาขาย (Sale Price)', value: orDash(budget.salePrice), unit: 'บาท', num: 'money0' },
        { label: 'งบต้นทุนรวม (7 หมวด)', value: orDash(budget.cost), unit: 'บาท', num: 'money0' },
        { label: 'ต้นทุนเกิดขึ้นจริงรวม', value: budget.totalActual, unit: 'บาท', num: 'money0',
          note: budget.cost ? `ใช้ไป ${((budget.totalActual / budget.cost) * 100).toFixed(1)}% ของงบ` : '' },
        { label: 'ต้นทุนคงเหลือตามงบ', value: orDash(budget.remainingCost), unit: 'บาท', num: 'money0',
          note: overBudget ? '⚠️ ติดลบ = ใช้เกินงบแล้ว' : '' },
        { label: 'กำไรตามแผน (ราคาขาย − งบต้นทุน)', value: orDash(budget.profit), unit: 'บาท', num: 'money0' },
        { label: 'Margin ตามแผน', value: budget.margin !== undefined ? budget.margin : '-', unit: '%', num: PCT },
        { label: 'มูลค่าวัสดุ PR/PO', value: budget.materialValue, unit: 'บาท', num: 'money0',
          note: 'ค่าวัสดุล้วน ไม่รวมต้นทุนตัว LBS' },
        { label: 'ต้นทุนตัว LBS ที่ดึงเข้างาน', value: budget.lbsCost, unit: 'บาท', num: 'money0',
          note: 'บวกเป็น actual หมวด Raw Material ด้วย' },
        { label: 'รายการวัสดุทั้งหมด', value: accReqs.length, unit: 'รายการ', num: 'int',
          note: `นับต้นทุนจริง ${activeReqs.length} รายการ · ยกเลิก/คืนสต็อก ${accReqs.length - activeReqs.length} รายการ` },
        { label: 'รายการที่ยังไม่กรอกราคา', value: noPrice.length, unit: 'รายการ', num: 'int',
          note: noPrice.length > 0 ? 'ทำให้ต้นทุนวัสดุยังไม่ครบ' : 'ราคาครบทุกรายการ' },
        { label: 'รายการซื้อเพิ่มหลังเบิกงาน', value: extraReqs.length, unit: 'รายการ', num: 'int',
          note: extraReqs.length > 0
            ? `มูลค่า ${extraReqs.reduce((n, r) => n + chargedValue(r), 0).toLocaleString('th-TH')} บาท — จุดที่ต้นทุนมักบานปลาย`
            : 'ไม่มี' },
        { label: 'วางบิลแล้ว', value: pay.billed, unit: 'บาท', num: 'money0',
          note: pay.billedPct !== undefined ? `${pay.billedPct.toFixed(1)}% ของราคาขาย` : '' },
        { label: 'รับเงินแล้ว', value: pay.paid, unit: 'บาท', num: 'money0' },
        { label: 'วางบิลแล้วแต่ยังไม่ได้รับเงิน', value: pay.unpaid, unit: 'บาท', num: 'money0' },
        { label: 'ยังไม่ได้วางบิล', value: orDash(pay.unbilled), unit: 'บาท', num: 'money0',
          note: 'ราคาขาย − ยอดที่วางบิลไปแล้ว' },
      ],
      tables,
      notes: [
        'จำนวนที่สั่งซื้อ = เบิกออกหน้างาน + คงเหลือที่ Job + โอนคืนคลัง + ตัดจำหน่าย (ครบทุกบรรทัด)',
        '"ต้นทุนที่ตัดเข้างาน" = ราคา/หน่วย × (จำนวนที่สั่งซื้อ − โอนคืนคลัง) — รายการที่ยกเลิก/คืนสต็อกทั้งบรรทัดนับเป็น 0',
        '"ต้นทุนที่ถึงหน้างานแล้ว" เป็นตัวเลขดูอย่างเดียว ไม่ได้ใช้คิดงบ — ของที่ตัดจำหน่ายยังนับเป็นต้นทุนของงาน',
        'actual ของหมวด Raw Material / Outsourcing มาจากรายการวัสดุในไฟล์นี้ · อีก 5 หมวดกรอกมือที่หน้า Job',
        'ต้นทุนตัว LBS ที่ดึงเข้างานถูกบวกเข้า actual หมวด Raw Material ด้วย — "มูลค่าวัสดุ PR/PO" จึงน้อยกว่า actual หมวดนั้น',
        '"กำไรตามแผน" เทียบราคาขายกับ **งบ** ไม่ใช่ต้นทุนจริง — กำไรจริงต้องรออีก 5 หมวดที่กรอกมือครบก่อน',
        'สถานะวัสดุตอบว่า "ของอยู่ที่ไหนตอนนี้" ไม่ใช่ "มาจากไหน" — ของที่เบิกออกหน้างานแล้วขึ้น "เบิกให้ Service แล้ว"',
        'ไฟล์นี้ Import กลับเข้าระบบไม่ได้ — เป็นรายงานสำหรับตรวจสอบ/ประชุมเท่านั้น',
      ],
    })

    const wsGuide = guideSheet(
      XLSX,
      [
        [`Purchase Orders — ${job.jobNo} · ${job.customerName}`],
        [`ออกจากระบบเมื่อ ${fmtDateTime(new Date().toISOString())}`],
        [`${accReqs.length} รายการ · ค่าวัสดุที่ตัดเข้างาน ${materialTotal.toLocaleString('th-TH')} บาท`],
      ],
      PO_COLS,
      [
        'แถวสุดท้ายของชีตข้อมูลเป็นแถวรวม — autofilter ไม่คลุมแถวนั้น กรองแล้วยอดรวมไม่หาย',
        'ยอดรวมคอลัมน์ "ต้นทุนที่ตัดเข้างาน" ต้องเท่ากับ actual หมวด Raw Material + Outsourcing หัก ต้นทุนตัว LBS',
        'ของจากคลังคงเหลือใช้ต้นทุนถัวเฉลี่ยตอนเบิก — เบิกวันละกันคนละราคาได้ ถือเป็นเรื่องปกติ',
        'ไฟล์นี้ Import กลับเข้าระบบไม่ได้ — เป็นรายงานสำหรับตรวจสอบเท่านั้น',
      ],
    )

    const wb = buildWorkbook(XLSX, [
      { name: SHEET_SUMMARY, ws: wsSum },
      { name: 'Purchase Orders', ws },
      { name: SHEET_GUIDE, ws: wsGuide },
    ])
    saveReport(XLSX, wb, `รายงานผู้บริหาร-${job.jobNo}-PO`)
  }

  return (
    <>
      <div style={{ marginBottom: 6 }}><Link to="/jobs">← กลับหน้า Jobs</Link></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="page-title">{job.jobNo}</div>
        <JobStatusBadge status={status} phase={jobStatusPhase(db, job)} />
        <DeliveryBadge d={delivery} />
      </div>
      <div className="page-sub">
        {job.customerName}{job.contactPhone && <> · 📞 {job.contactPhone}</>} · {job.scope || 'ไม่ระบุ scope'} · ติดตั้งที่ {job.installLocation || '-'} ·{' '}
        {/* 0075: กำหนดที่มีผล + กำหนดตามสัญญาเดิมเสมอ — ตัวเลขในระบบต้องตรงกับในสัญญา */}
        กำหนดส่ง {delivery.due ? fmtDate(delivery.due) : '-'}
        {delivery.extension && delivery.contractDue && (
          <> <span className="badge amber">เลื่อนจาก {fmtDate(delivery.contractDue)} · {delivery.extensionCount} ครั้ง</span></>
        )}
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>
        👤 ผู้รับผิดชอบงาน: <b>{job.openedBy ? userOf(job.openedBy) : 'ไม่ระบุ (งานเก่า)'}</b>
      </div>
      <div style={{ marginBottom: 16 }}>
        <button className="small" onClick={() => window.print()}>🖨️ ปริ้นสรุปโครงการ (PDF)</button>
      </div>

      {/* 0042: Project เปิดใบอื่นได้แต่ทำรายการไม่ได้ — บอกให้ชัดว่าทำไมปุ่มหาย */}
      {readOnlyJob && (
        <div className="panel"><div className="panel-body">
          🔒 <b>โหมดดูอย่างเดียว</b> — Job นี้เปิดโดย {job.openedBy ? userOf(job.openedBy) : 'ผู้ใช้อื่น'}{' '}
          คุณดูข้อมูลได้ครบทุกส่วน แต่ดึง/คืน LBS · ขอวัสดุ · ขออนุมัติ ทำได้เฉพาะเจ้าของงาน
          <div className="muted">ถ้าต้องแก้งานใบนี้จริง ให้แจ้ง Manage เข้าไปทำแทน</div>
        </div></div>
      )}

      {/* ---------- สถานะกำหนดส่ง + ขยายกำหนดส่ง (0075) ----------
          วางไว้บนสุดของใบ เพราะเป็นคำถามแรกที่ทุกคนถามถึงงานหนึ่งใบ ("ทันไหม ใครค้าง")
          🔴 การขยายกำหนดไม่ได้แก้ requiredDate — เก็บเป็นประวัติแยก กำหนดตามสัญญาเดิมจึงไม่หาย */}
      <div className="panel" style={{ borderLeft: `4px solid var(--${delivery.tone === 'red' ? 'red' : delivery.tone === 'amber' ? 'amber' : delivery.tone === 'blue' ? 'primary' : 'green'})` }}>
        <div className="panel-head">
          <h3>📅 สถานะกำหนดส่ง <DeliveryBadge d={delivery} /></h3>
          {canExtendDue && (
            <button className="small" onClick={() => setDueForm({
              newDueDate: delivery.due ?? todayIso(), reason: '',
            })}>ขยาย/แก้กำหนดส่ง</button>
          )}
        </div>
        <div className="panel-body">
          <div className="budget-grid" style={{ marginBottom: dueHistory.length > 0 ? 12 : 0 }}>
            <div className="budget-cell">
              <div className="b-label">กำหนดตามสัญญา</div>
              <div className="b-value">{delivery.contractDue ? fmtDate(delivery.contractDue) : '-'}</div>
            </div>
            <div className="budget-cell">
              <div className="b-label">กำหนดที่มีผลตอนนี้</div>
              <div className="b-value">{delivery.due ? fmtDate(delivery.due) : '-'}</div>
            </div>
            {/* 🔴 ส่งมอบเสร็จแล้ว = หยุดนับ · โชว์คำตัดสินย้อนหลังแทนนาฬิกาที่ยังเดิน
                (เดิมนับจากวันนี้เสมอ ⇒ ใบที่ติดตั้งเสร็จทันกำหนดแต่ค้างกดปิดงาน
                 จะขึ้นว่า "เลยกำหนดส่ง N วัน" เพิ่มขึ้นทุกวัน ซึ่งผิดข้อเท็จจริง) */}
            <div className="budget-cell">
              <div className="b-label">
                {delivery.deliveredDate
                  ? (delivery.isLate ? 'ส่งช้ากว่ากำหนด' : 'ส่งมอบทันกำหนด')
                  : delivery.isLate ? 'เลยกำหนดส่งมาแล้ว' : 'เหลือเวลาถึงกำหนดส่ง'}
              </div>
              <div className={`b-value ${delivery.isLate ? 'neg' : 'pos'}`}>
                {delivery.deliveredDate
                  ? (delivery.isLate ? `${delivery.daysLate} วัน` : '✓')
                  : delivery.daysLeft === undefined ? '-' : `${Math.abs(delivery.daysLeft)} วัน`}
              </div>
              {delivery.deliveredDate && (
                <div className="muted" style={{ fontSize: 11 }}>ติดตั้งเสร็จจริง {fmtDate(delivery.deliveredDate)}</div>
              )}
            </div>
            {/* 🔴 นาฬิกาเรือนที่ 2 — "นัดติดตั้ง" คือช่วงที่ทีมช่างออกไซต์ Service เลื่อนเองได้
                คนละตัวกับกำหนดส่งที่ผูกกับลูกค้า · วางคู่กันตรงนี้เพื่อไม่ให้อ่านป้ายสถานะผิด */}
            <div className="budget-cell">
              <div className="b-label">นัดติดตั้ง (ทีมช่างออกไซต์)</div>
              <div className="b-value" style={{ fontSize: 15 }}>
                {delivery.visitStart
                  ? <>{fmtDate(delivery.visitStart)}{delivery.visitEnd && delivery.visitEnd !== delivery.visitStart && <> – {fmtDate(delivery.visitEnd)}</>}</>
                  : <span className="muted">ยังไม่ได้นัด</span>}
              </div>
            </div>
            <div className="budget-cell">
              <div className="b-label">เลื่อนกำหนดส่งมาแล้ว</div>
              <div className="b-value">{delivery.extensionCount} ครั้ง</div>
            </div>
          </div>
          <div><b>สิ่งที่ต้องทำต่อ:</b> {delivery.nextStep}</div>
          {dueHistory.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>เลื่อนเมื่อ</th><th>โดย</th><th>จาก</th><th>เป็น</th><th>เหตุผล</th>{canExtendDue && <th></th>}</tr></thead>
                <tbody>
                  {dueHistory.map((e, i) => (
                    <tr key={e.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(e.createdAt)}</td>
                      <td>{userOf(e.createdBy)}</td>
                      <td>{e.prevDueDate ? fmtDate(e.prevDueDate) : <span className="muted">ไม่เคยระบุ</span>}</td>
                      <td><b>{fmtDate(e.newDueDate)}</b></td>
                      <td>{e.reason}</td>
                      {canExtendDue && (
                        <td style={{ textAlign: 'right' }}>
                          {/* ยกเลิกได้เฉพาะแถวล่าสุด — ประวัติก่อนหน้าเป็นหลักฐาน (กติกาเดียวกับ RPC) */}
                          {i === 0 && (
                            <button className="small danger" onClick={async () => {
                              if (await askConfirm({
                                title: 'ยกเลิกการเลื่อนกำหนดส่งครั้งล่าสุด',
                                description: <>กำหนดส่งจะกลับไปเป็น <b>{e.prevDueDate ? fmtDate(e.prevDueDate) : 'กำหนดตามสัญญา'}</b> · การยกเลิกถูกบันทึกใน Audit Log</>,
                                confirmLabel: 'ยกเลิกการเลื่อน',
                              })) tryAction(() => act.deleteJobDueExtension({ extensionId: e.id }), 'ยกเลิกการเลื่อนกำหนดส่งแล้ว')
                            }}>ยกเลิก</button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* จุดติดตั้ง — แสดงเมื่อมีหลายจุด (จุดที่ 1 = install_location หลัก + จุดที่ 2+ = installSites) */}
      {job.installSites && job.installSites.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h3>จุดติดตั้ง <span className="muted" style={{ fontWeight: 400 }}>· {job.installSites.length + 1} จุด</span></h3></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>จุดที่</th><th>สถานที่ติดตั้ง</th><th>วันที่ต้องการติดตั้ง</th><th>พิกัดตามแผน</th></tr></thead>
              <tbody>
                <tr><td>1</td><td>{job.installLocation || '-'}</td><td>{fmtDate(job.requiredDate)}</td><td><PlanCoordCell lat={job.planLat} lng={job.planLng} /></td></tr>
                {job.installSites.map((s, i) => (
                  <tr key={i}><td>{i + 2}</td><td>{s.location || '-'}</td><td>{fmtDate(s.requiredDate)}</td><td><PlanCoordCell lat={s.lat} lng={s.lng} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 0059: เบิกออกไปแล้วบางส่วน — ต้องเห็นจากหน้าแรกว่าอะไรออกไปแล้ว อะไรค้าง */}
      {!job.terminalStatus && (plan.lbsIssued.length > 0 || accReqs.some(r => !!r.issuedToServiceAt)) && (
        <div className="panel" style={{ borderLeft: '4px solid #d97706' }}><div className="panel-body">
          <b>เบิกให้ Service แล้วบางส่วน</b>{job.lbsIssuedAt && <> · เริ่มเบิกเมื่อ {fmtDateTime(job.lbsIssuedAt)}</>}
          <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`badge ${plan.lbsReady.length + plan.lbsBlocked.length === 0 ? 'green' : 'amber'}`}>
              LBS เบิกแล้ว {plan.lbsIssued.length}/{allocatedUnits.length} เครื่อง
            </span>
            <span className={`badge ${plan.accPending.length === 0 ? 'green' : 'amber'}`}>
              วัสดุค้างรอเบิก {plan.accPending.length} รายการ
            </span>
            {plan.lbsBlocked.length > 0 && <span className="badge red">LBS รอ ETA {plan.lbsBlocked.length} เครื่อง</span>}
          </div>
          {job.installStartDate && (
            <div style={{ marginTop: 4 }}>📅 นัดติดตั้ง <b>{fmtDate(job.installStartDate)} – {fmtDate(job.installEndDate)}</b> ที่ <b>{job.issueLocation || '-'}</b></div>
          )}
          <div className="muted" style={{ marginTop: 4 }}>
            เครื่องที่เบิกออกไปแล้ว<b>ล็อก คืน/สลับไม่ได้</b> · ที่เหลือยังจัดการได้ตามปกติ ·
            ยกเลิก Job ไม่ได้แล้วเพราะของอยู่ในมือ Service · ครบทั้งใบเมื่อไหร่ระบบปิดเป็น Issued ให้เอง
            {/* 0071 เปลี่ยนกติกาข้อนี้ — เดิมเขียนว่า "ยืนยันติดตั้งได้เมื่อเบิกครบทั้งใบ" ซึ่งกลายเป็นคำอธิบาย
                ที่โกหกทันทีที่ด่านย้ายไปเป็นรายเครื่อง · ต้องแก้คู่กันเสมอ ไม่งั้นหน้าเว็บสอนผิด */}
            <br /><b>Service ยืนยันติดตั้งเครื่องที่เบิกออกไปแล้วได้เลย</b> — ไม่ต้องรอใบครบ ·
            ส่วน<b>การปิดงาน</b>ยังต้องเบิกครบทั้งใบและได้ข้อสรุปครบทุกเครื่องก่อน
          </div>
        </div></div>
      )}

      {/* 0071: แผงนี้เคยขึ้นเฉพาะ terminalStatus === 'issued' ⇒ ระหว่าง "เบิกบางส่วน" หน้า Job
          ไม่บอกอะไรเลยว่าของล็อตแรกอยู่กับช่างแล้ว ติดตั้งไปกี่เครื่อง ทีมใครรับผิดชอบ
          — Project ตามงานต่อไม่ได้ทั้งที่เป็นคนส่งของออกไปเอง */}
      {jobIsFieldActive(db, job) && (() => {
        const s = jobInstallSummary(db, job.id)
        const team = jobTeam(db, job.id)
        const partial = job.terminalStatus !== 'issued'
        return (
          <div className="panel"><div className="panel-body">
            {/* เคส partial: แผง "เบิกให้ Service แล้วบางส่วน" (0059) ด้านบนเล่าเรื่องเบิก/นัดหมายไปแล้ว
                แผงนี้จึงเหลือเฉพาะส่วนที่แผงนั้นไม่มี = ความคืบหน้าติดตั้ง + ทีมช่าง (ไม่พูดซ้ำ) */}
            <b>{partial ? 'งานหน้าไซต์รอบนี้' : 'เบิกให้ Service แล้ว — รอติดตั้ง'}</b>
            {!partial && <>
              {' '}เบิกเมื่อ {fmtDateTime(job.issuedAt)} — {job.issuedNote || 'ไม่มีบันทึกเพิ่มเติม'}
              {job.installStartDate && (
                <div>📅 นัดติดตั้ง <b>{fmtDate(job.installStartDate)} – {fmtDate(job.installEndDate)}</b> ที่ <b>{job.issueLocation || job.installLocation || '-'}</b></div>
              )}
            </>}
            <div style={{ marginTop: 6 }}>
              🔧 ติดตั้งแล้ว{' '}
              <span className={`badge ${s.unitsDone ? 'green' : s.outInstalled > 0 ? 'blue' : 'neutral'}`}>{s.outInstalled}/{s.outTotal} เครื่อง</span>
              {partial && <span className="muted"> (ทั้งใบ {s.installed}/{s.total})</span>}
              {s.blocked > 0 && <> <span className="badge red">ติดตั้งไม่ได้ {s.blocked}</span></>}
            </div>
            <div style={{ marginTop: 4 }}>
              👷 {team.length === 0
                ? <span style={{ color: 'var(--danger)' }}>ยังไม่มอบหมายทีม</span>
                : team.map(t => `${t.member.firstName} ${t.member.lastName}${t.assignment.isLead ? ' (หัวหน้า)' : ''} · ${t.member.phone}`).join(' | ')}
            </div>
            <div className="muted">
              {/* ล็อก allocation เกิดตอนใบปิดเท่านั้น (assertJobEditable) — ระหว่างเบิกบางส่วนยังแก้ได้
                  เขียนตามจริง ไม่งั้นบอกผู้ใช้ผิดว่าแตะอะไรไม่ได้แล้ว */}
              {partial
                ? 'ช่างยืนยันติดตั้งเครื่องที่ออกไปแล้วได้เลย · ปิดงานได้เมื่อของออกครบทั้งใบ'
                : 'Job ถูกล็อก แก้ไข allocation หรือคืนของไม่ได้อีก · Service ยืนยันรายเครื่องแล้วกดปิดงาน'}
              {' — '}<Link to="/service">ไปหน้า Service →</Link>
            </div>
          </div></div>
        )
      })()}
      {job.terminalStatus === 'installed' && (() => {
        const s = jobInstallSummary(db, job.id)
        return (
          <div className="panel"><div className="panel-body">
            <b style={{ color: 'var(--green)' }}>ติดตั้งเสร็จแล้ว</b> วันที่จริง {fmtDate(job.installedAt)} ยืนยันโดย {userOf(job.installConfirmedBy ?? '')}
            {job.installNote && <> — {job.installNote}</>}
            <div style={{ marginTop: 6 }}>
              🔧 ติดตั้ง <span className="badge green">{s.installed}/{s.total} เครื่อง</span>
              {s.blocked > 0 && <> <span className="badge red">ติดตั้งไม่ได้ {s.blocked}</span></>}
            </div>
            {/* สรุปปัญหาของงานที่ Service ตอบตอนปิดงาน (0040) */}
            {job.closeHasIssues === true && (
              <div style={{ marginTop: 6, color: 'var(--danger)' }}>
                ⚠️ <b>มีปัญหาหน้างาน:</b> {job.closeIssueDetail}
                {job.closeIssueFileUrl && <> · <a href={job.closeIssueFileUrl} target="_blank" rel="noreferrer">📎 ไฟล์แนบ</a></>}
              </div>
            )}
            {job.closeHasIssues === false && (
              <div style={{ marginTop: 6, color: 'var(--green)' }}>✅ Service ยืนยันว่าไม่มีปัญหาหน้างาน</div>
            )}
            {/* เอกสารรับมอบ + Warranty (0079) — ตัวเต็ม/แก้ไข/แนบเพิ่มอยู่ที่ Service (Warranty) */}
            {(() => {
              const ws = jobWarranties(db, job.id)
              const inst = ws.find(w => w.kind === 'installation')
              const lbs = ws.filter(w => w.kind === 'lbs')
              if (!job.acceptanceType || !inst) {
                return (
                  <div style={{ marginTop: 6 }}>
                    <span className="badge amber">ยังไม่มีเอกสารรับมอบ / Warranty</span>{' '}
                    <Link to="/warranty">บันทึกย้อนหลังที่ Service (Warranty) →</Link>
                  </div>
                )
              }
              const lastEnd = lbs.map(w => w.endDate).sort().pop()
              return (
                <div style={{ marginTop: 6 }}>
                  📄 รับมอบ <span className="badge blue">{ACCEPTANCE_TYPES.find(t => t.value === job.acceptanceType)?.label}</span>
                  {job.acceptanceDocNo && <span className="mono"> {job.acceptanceDocNo}</span>} ({fmtDate(job.acceptanceDate)})
                  {' · '}🛡️ Warranty ติดตั้ง {fmtDate(inst.startDate)} – {fmtDate(inst.endDate)}
                  {lbs.length > 0 && <> · LBS {lbs.length} เครื่อง ถึง {fmtDate(lastEnd)}</>}
                  {' · '}<Link to="/warranty">ดู/แก้ไข →</Link>
                </div>
              )
            })()}
            <div className="muted">
              เบิกเมื่อ {fmtDateTime(job.issuedAt)}
              {job.installStartDate && <> · นัดติดตั้ง {fmtDate(job.installStartDate)} – {fmtDate(job.installEndDate)} ที่ {job.issueLocation || '-'}</>}
              {job.issuedNote && <> · {job.issuedNote}</>}
              {(job.reopenCount ?? 0) > 0 && <> · <b>เคยเปิดงานใหม่ {job.reopenCount} ครั้ง</b></>}
            </div>
            {/* เปิดงานใหม่ (0041) — ปิดงานผิด/ต้องกลับไปแก้หน้างาน · Project ขออนุมัติ · Manage ทำตรง */}
            {canManage && (
              <div style={{ marginTop: 10 }}>
                <button className="small"
                  disabled={pendingApprovalOf('reopen_job')}
                  title={pendingApprovalOf('reopen_job') ? 'มีคำขอเปิดงานใหม่รอ Division พิจารณาอยู่แล้ว' : ''}
                  onClick={async () => {
                    const v = await askPrompt({
                      title: isManage ? `เปิดงาน ${job.jobNo} ใหม่` : `ขออนุมัติเปิดงาน ${job.jobNo} ใหม่`,
                      description: <>
                        งานจะกลับเป็น <b>รอติดตั้ง (Issued)</b> · หลักฐานการยืนยันรายเครื่องยังอยู่ครบ ไม่ต้องถ่ายรูป/เช็คอินซ้ำ ·
                        วันปิดงานเดิมจะถูกล้าง (สำเนาเก็บใน Audit Log)
                        {!isManage && <> · คำขอจะส่งให้ <b>Division</b> พิจารณาก่อน</>}
                      </>,
                      fields: [{ key: 'reason', label: 'เหตุผลที่ต้องเปิดงานใหม่', type: 'textarea', required: true,
                        placeholder: 'เช่น กดปิดงานผิดใบ / ต้องกลับไปแก้จุดติดตั้งที่ 2' }],
                      confirmLabel: isManage ? 'เปิดงานใหม่' : 'ส่งคำขอ',
                    })
                    if (!v) return
                    isManage
                      ? tryAction(() => act.reopenJob({ jobId: job.id, reason: v.reason }), `เปิดงาน ${job.jobNo} ใหม่แล้ว — กลับเป็นรอติดตั้ง`)
                      : tryAction(() => act.requestApproval({ type: 'reopen_job', jobId: job.id, payload: { reason: v.reason } }),
                          `ส่งคำขอเปิดงาน ${job.jobNo} ใหม่ ให้ Division พิจารณาแล้ว`)
                  }}>
                  🔄 {isManage ? 'เปิดงานใหม่' : 'ขออนุมัติเปิดงานใหม่'}
                </button>
                <span className="muted" style={{ marginLeft: 8 }}>
                  ใช้เมื่อปิดงานผิด หรือต้องกลับไปแก้หน้างาน — ประวัติการยืนยันรายเครื่องจะยังอยู่ครบ
                </span>
              </div>
            )}
          </div></div>
        )
      })()}

      {/* ติดตั้งรายเครื่อง (เฟส B/C) — เห็นได้จากหน้า Job ไม่ต้องข้ามไปหน้า Service
          0071: รวมช่วง "เบิกบางส่วน" ด้วย — เครื่องที่ออกไปแล้วมีผลติดตั้งได้ตั้งแต่ตอนนั้น
          เครื่องที่ยังอยู่คลังจะขึ้นสถานะ "รอติดตั้ง" ตามเดิม (unitInstallState = pending) */}
      {(jobIsFieldActive(db, job) || job.terminalStatus === 'installed') && allocatedUnits.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h3>การติดตั้งรายเครื่อง</h3></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Serial (LVB / OM)</th><th>สถานะ</th><th>ช่างที่ติดตั้ง</th><th>หลักฐาน</th></tr></thead>
              <tbody>
                {allocatedUnits.map(u => {
                  const st = unitInstallState(db, u.id)
                  const r = db.unitInstallations.filter(x => x.unitId === u.id)
                    .sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0]
                  return (
                    <tr key={u.id}>
                      <td className="mono">{u.serialLvb}<div className="muted mono">{u.serialOm}</div></td>
                      <td>
                        {st === 'installed' && <span className="badge green">✅ ติดตั้งแล้ว {fmtDate(r?.installedDate)}</span>}
                        {st === 'blocked' && <><span className="badge red">⚠️ ติดตั้งไม่ได้</span><div className="muted">{r?.reason}</div></>}
                        {/* 0071: แยก "ยังอยู่คลัง" ออกจาก "อยู่กับช่างแล้วรอติดตั้ง" — สองอันนี้คนละคนต้องไปทำ
                            ป้าย "รอติดตั้ง" เฉย ๆ จะโยนงานไปที่ Service ทั้งที่ของยังไม่ได้ออกจากคลัง */}
                        {st === 'pending' && (u.status === 'issued'
                          ? <span className="badge neutral">รอติดตั้ง</span>
                          : <span className="badge amber">ยังไม่เบิก — อยู่คลัง</span>)}
                      </td>
                      <td className="muted">{r?.installedByMemberId ? memberFullName(db, r.installedByMemberId) : '-'}</td>
                      <td className="muted">
                        {st === 'installed' && r ? (
                          <>
                            {r.photoUrl && <a href={r.photoUrl} target="_blank" rel="noreferrer">🖼️ รูป</a>}{' '}
                            {r.checkinLat != null && r.checkinLng != null && (
                              <a href={`https://www.google.com/maps?q=${r.checkinLat},${r.checkinLng}`} target="_blank" rel="noreferrer">
                                📍 {r.checkinLat.toFixed(5)}, {r.checkinLng.toFixed(5)}
                              </a>
                            )}
                            {r.note && <div>📝 {r.note}</div>}
                          </>
                        ) : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ประวัติออกหน้างาน — เลื่อนนัด / ติดปัญหา (เฟส A) */}
      {db.siteVisits.some(v => v.jobId === jobId) && (
        <div className="panel">
          <div className="panel-head"><h3>ประวัติออกหน้างาน (เลื่อนนัด / ติดปัญหา)</h3></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>เมื่อ</th><th>ผล</th><th>รายละเอียด</th><th>โดย</th></tr></thead>
              <tbody>
                {db.siteVisits.filter(v => v.jobId === jobId)
                  .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
                  .map(v => (
                    <tr key={v.id}>
                      <td className="muted">{fmtDateTime(v.performedAt)}</td>
                      <td>{v.outcome === 'rescheduled'
                        ? <span className="badge amber">⏰ เลื่อนนัด</span>
                        : <span className="badge red">⚠️ ติดปัญหา</span>}</td>
                      <td>{v.reason}
                        {v.outcome === 'rescheduled' && v.newStartDate && (
                          <div className="muted">นัดใหม่ {fmtDate(v.newStartDate)}
                            {v.newEndDate && v.newEndDate !== v.newStartDate && <> – {fmtDate(v.newEndDate)}</>}</div>
                        )}
                      </td>
                      <td className="muted">{userOf(v.performedBy)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {job.terminalStatus === 'cancelled' && (
        <div className="panel"><div className="panel-body">
          <b style={{ color: 'var(--red)' }}>Job ถูกยกเลิก</b> เมื่อ {fmtDateTime(job.cancelledAt)} โดย {userOf(job.cancelledBy!)}
          — เหตุผล: {job.cancelReason} (LBS และ Accessory จากสต็อกกลางถูกคืนกลับสต็อกอัตโนมัติแล้ว)
        </div></div>
      )}

      {/* คำขอที่รอ Division พิจารณาของ Job นี้ */}
      {db.approvalRequests.some(r => r.jobId === jobId && r.status === 'pending') && (
        <div className="panel"><div className="panel-body">
          ⏳ <b>รอ Division พิจารณา:</b>{' '}
          {db.approvalRequests.filter(r => r.jobId === jobId && r.status === 'pending')
            .map(r => APPROVAL_TYPE_LABEL[r.type])
            .join(' · ')}
          {' '}— <Link to="/approvals">ดูสถานะที่หน้ารออนุมัติ →</Link>
        </div></div>
      )}

      {/* ของที่ดึงเข้า Job แล้วแต่ยังไม่ถึงคลัง (0052) — บอกเหตุผลตรงนี้ ไม่ให้ผู้ใช้งงว่าทำไมปุ่มเบิกกดไม่ได้ */}
      {!locked && etaBlock && (
        <div className="panel" style={{ borderLeft: '4px solid var(--amber, #d97706)', marginBottom: 18 }}>
          <div className="panel-body">
            🚢 <b>{etaBlock}</b>
            <div className="muted" style={{ marginTop: 4 }}>
              เฉพาะ<b>เครื่องเหล่านั้น</b>ที่เบิกไม่ได้ — เครื่องอื่นและวัสดุที่รับของแล้วยังเบิกได้ตามปกติ (0059) ·
              ถ้าของถึงคลังก่อนกำหนดให้แก้ ETA ที่หน้า LBS Inventory → ปุ่ม "แก้ข้อมูล" รายเครื่อง ·
              หรือคืนเครื่องที่ยังไม่มาแล้วดึงเครื่องที่ On Hand แทน
            </div>
          </div>
        </div>
      )}

      {/* 🔴 แก้บั๊ก 2026-09-11: เดิมแถบปุ่มทั้งก้อนครอบด้วย `!locked` ⇒ พอ Job เป็น issued
          ปุ่ม "เบิกให้ Service" หายไปด้วย · แต่ตั้งแต่ 0037 **จัดซื้อเพิ่มหลังเบิกได้ถึง issued**
          (assertJobProcurable / app_assert_job_procurable ปิดเฉพาะ installed/cancelled)
          ⇒ ผู้ใช้เพิ่มวัสดุ · ออก PR · รับของได้ครบ แล้วไม่มีทางเบิกออกไปหน้างาน ของค้างที่ Job ถาวร
          ⇒ แยกกติกา: ปุ่มที่แตะ **LBS / ตัวใบงาน** ใช้ `locked` · ปุ่ม **เบิกให้ Service** ใช้
             `procureLocked` ให้ตรงกับ guard ฝั่งหลังบ้านเป๊ะ (หลังบ้านอนุญาตอยู่แล้ว ไม่ต้องแก้ RPC) */}
      {canManage && (!locked || canIssueExtra) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          {!locked && <>
            <button className="primary" onClick={() => { setDrawStock(db.projectStocks.find(s => s.status === 'open')?.id ?? ''); openModal('draw') }}>+ ดึง LBS เข้า Job</button>
            <button onClick={() => { setReturnTarget(''); openModal('return') }} disabled={returnableUnits.length === 0}>คืน LBS กลับสต็อก</button>
          </>}
          {/* 0059: ปุ่มเดียวเปิด popup ให้เลือกว่ารอบนี้เบิกอะไร — ไม่ใช่เบิกทั้งใบทีเดียวอีกแล้ว
              เงื่อนไขเปิดใช้ = "มีของอะไรเบิกได้บ้าง" (ไม่ผูกกับสถานะ ready_to_issue ทั้งใบ)
              เพราะทั้งหมดของฟีเจอร์นี้คือเบิก LBS ได้ระหว่างที่ Accessory ยังรอ PO */}
          {!procureLocked && <button className="success" onClick={openIssueModal}
            disabled={!canIssueAnything || (plan.accReady.length === 0 && pendingApprovalOf('issue_job'))}
            title={plan.lbsShort > 0 && plan.accReady.length === 0
              ? `ดึง LBS ยังไม่ครบ Scope — ขาดอีก ${plan.lbsShort} เครื่อง`
              : !canIssueAnything ? 'ยังไม่มีของที่พร้อมเบิก — LBS รอ ETA to WH / วัสดุรอรับของจาก PO'
              : pendingApprovalOf('issue_job') ? 'มีคำขอเบิก LBS รอ Division พิจารณาอยู่แล้ว — เบิกวัสดุได้ตามปกติ'
              : ''}>
            เบิกให้ Service{canIssueAnything && <> ({[
              plan.lbsShort === 0 && plan.lbsReady.length > 0 ? `LBS ${plan.lbsReady.length}` : null,
              plan.accReady.length > 0 ? `วัสดุ ${plan.accReady.length}` : null,
            ].filter(Boolean).join(' + ')})</>}
          </button>}
          {!locked && <><button onClick={() => {
            setEditForm({
              jobNo: job.jobNo,
              customerName: job.customerName, contactPhone: job.contactPhone ?? '',
              scope: job.scope, installLocation: job.installLocation,
              requiredDate: job.requiredDate, lbsQtyRequired: job.lbsQtyRequired,
              salePrice: job.budgetSalePrice !== undefined ? String(job.budgetSalePrice) : '',
              planCoord: fmtLatLng(job.planLat, job.planLng),
            })
            setEditCosts(costFormFromJob(job.budgetCosts))
            setEditSites(sitesFromJob(job.installSites))
            openModal('edit')
          }}>แก้ไขข้อมูล Job</button>
          <button className="danger" disabled={pendingApprovalOf('cancel_job')}
            title={pendingApprovalOf('cancel_job') ? 'มีคำขอยกเลิกรอ Division พิจารณาอยู่แล้ว' : ''}
            onClick={() => { setCancelReason(''); setReceivedToCentral(true); openModal('cancel') }}>
            {isManage ? 'ยกเลิก Job' : 'ขออนุมัติยกเลิก Job'}
          </button>
          {db.allocations.every(a => a.jobId !== job.id) && accReqs.length === 0 && (
            <button className="danger" onClick={async () => {
              if (await askConfirm({
                title: `ลบ ${job.jobNo}`,
                description: <>ลบได้เพราะยังเป็น Draft ที่ไม่มี transaction (ยังไม่ดึง LBS · ไม่มีรายการวัสดุ) · <b>ลบแล้วกู้คืนไม่ได้</b> — เลข Job No. นี้จะกลับมาใช้ซ้ำได้</>,
                confirmLabel: 'ลบ Job',
              })) tryAction(async () => { await act.deleteDraftJob({ jobId: job.id }); navigate('/jobs') }, `ลบ ${job.jobNo} แล้ว`)
            }}>ลบ Draft</button>
          )}
          </>}
        </div>
      )}

      {/* Job ปิดเป็น Issued ไปแล้วแต่มีของซื้อเพิ่มรอเบิก — ไม่มีอะไรบนหน้าจอบอก คนจะไม่รู้ว่าต้องกลับมากด
          (เคสนี้เกิดหลัง 0037 เปิดให้จัดซื้อเพิ่มหลังเบิกได้) */}
      {canManage && locked && canIssueExtra && (
        <div className="panel" style={{ borderLeft: '4px solid var(--green, #16a34a)', marginBottom: 18 }}>
          <div className="panel-body">
            📦 <b>มีวัสดุที่ซื้อเพิ่มหลังเบิก พร้อมส่งให้ Service แล้ว {plan.accReady.length} รายการ</b>
            <div className="muted" style={{ marginTop: 4 }}>
              งานนี้ปิดเป็น <b>Issued</b> ไปแล้ว แต่ของที่ซื้อเพิ่มรอบหลังยังค้างอยู่ที่ Job ·
              กด <b>เบิกให้ Service</b> ด้านบนเพื่อส่งออกหน้างาน · ของที่ไม่ได้ใช้กด <b>📦 โอนเข้าคลัง</b>
              หรือ <b>✂️ ตัดจำหน่าย</b> ที่แผง Purchase Orders ·
              สถานะใบงาน<b>ไม่เปลี่ยน</b> (ปิดไปแล้ว) — การเบิกรอบนี้บันทึกลง Audit Log ตามปกติ
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Project Budget (ต้นทุน 7 หมวด) ---------------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>Project Budget</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted">กำไร = ราคาขาย − ต้นทุนรวม(งบ) · คงเหลือ = งบ − ใช้จริง</span>
            {/* Manage แก้งบได้แม้ Job ล็อกแล้ว (แก้ตัวเลขบัญชีย้อนหลัง · 0023) — role อื่นแก้ได้เฉพาะก่อนล็อก
                🔴 คนที่แก้ไม่ได้ต้องเห็นปุ่ม **แบบปิด + เหตุผล** ไม่ใช่ปุ่มหายเงียบ ๆ
                   (ผู้ใช้รายงาน 2026-09-18: เปิดใบที่เบิกแล้วด้วยบัญชี Project แล้วปุ่มหายไปทั้งปุ่ม
                    ไม่มีอะไรบอกว่าใครแก้ได้ ⇒ อ่านว่า "ระบบเสีย" ไม่ใช่ "ถูกล็อกตามกติกา")
                   แสดงเฉพาะคนที่ตำแหน่งเกี่ยวกับงบ (Project/Manage) — แผนกอื่นไม่ต้องเห็นปุ่มที่กดไม่ได้ */}
            {canBudgetRole && (blockedBudgetReason ? (
              <button className="small" disabled title={blockedBudgetReason}>
                🔒 แก้ไขงบประมาณไม่ได้
              </button>
            ) : (
              <button className="small" onClick={() => {
                setEditForm({
                  jobNo: job.jobNo, customerName: job.customerName, contactPhone: job.contactPhone ?? '',
                  scope: job.scope, installLocation: job.installLocation,
                  requiredDate: job.requiredDate, lbsQtyRequired: job.lbsQtyRequired,
                  salePrice: job.budgetSalePrice !== undefined ? String(job.budgetSalePrice) : '',
                  planCoord: fmtLatLng(job.planLat, job.planLng),
                })
                setEditCosts(costFormFromJob(job.budgetCosts))
                setModal('budget')
              }}>✏️ แก้ไขงบประมาณ{locked ? ' (ย้อนหลัง)' : ''}</button>
            ))}
          </div>
        </div>
        {/* บอกเหตุผลเป็นข้อความด้วย ไม่ใช่มีแต่ tooltip — บนมือถือไม่มี hover ให้เห็น */}
        {canBudgetRole && blockedBudgetReason && (
          <div className="panel-body muted" style={{ paddingBottom: 0 }}>🔒 {blockedBudgetReason}</div>
        )}
        <div className="panel-body">
          <div className="budget-grid" style={{ marginBottom: 16 }}>
            <div className="budget-cell"><div className="b-label">ราคาขาย</div><div className="b-value">{fmtBaht(budget.salePrice)}</div></div>
            <div className="budget-cell"><div className="b-label">ต้นทุนรวม (งบ)</div><div className="b-value">{fmtBaht(budget.cost)}</div></div>
            <div className="budget-cell"><div className="b-label">กำไร{budget.margin !== undefined ? ` (${budget.margin.toFixed(1)}%)` : ''}</div>
              <div className={`b-value ${budget.profit !== undefined && budget.profit < 0 ? 'neg' : 'pos'}`}>{fmtBaht(budget.profit)}</div></div>
            <div className="budget-cell"><div className="b-label">ใช้จริงรวม</div><div className="b-value">{fmtBaht(budget.totalActual)}</div></div>
            <div className="budget-cell"><div className="b-label">ต้นทุนคงเหลือ</div>
              <div className={`b-value ${budget.remainingCost !== undefined && budget.remainingCost < 0 ? 'neg' : 'pos'}`}>{fmtBaht(budget.remainingCost)}</div></div>
          </div>
          {/* ---------- Payment (0044) — วางก่อนรายละเอียดต้นทุน 7 หมวด สไตล์เดียวกัน ---------- */}
          <button className="small" onClick={() => setPayOpen(o => !o)}>
            {payOpen ? '▾' : '▸'} Payment (Advance → Progress/Delivery → PAC/Retention)
            {pay.rows.length > 0 && <> · ออกใบแล้ว {fmtBaht(pay.billed)}{pay.billedPct !== undefined ? ` (${pay.billedPct.toFixed(1)}%)` : ''}</>}
          </button>
          {payOpen && (
            <div style={{ marginTop: 10, marginBottom: 10 }}>
              <div className="budget-grid" style={{ marginBottom: 12 }}>
                <div className="budget-cell"><div className="b-label">ออกใบแจ้งหนี้แล้ว</div><div className="b-value">{fmtBaht(pay.billed)}</div></div>
                <div className="budget-cell"><div className="b-label">รับเงินแล้ว</div><div className="b-value pos">{fmtBaht(pay.paid)}</div></div>
                <div className="budget-cell"><div className="b-label">ออกใบแล้วรอรับเงิน</div>
                  <div className={`b-value ${pay.unpaid > 0 ? 'neg' : ''}`}>{fmtBaht(pay.unpaid)}</div></div>
                <div className="budget-cell"><div className="b-label">ยังไม่ออกใบ</div>
                  <div className={`b-value ${pay.unbilled !== undefined && pay.unbilled < 0 ? 'neg' : ''}`}>{fmtBaht(pay.unbilled)}</div></div>
              </div>
              {pay.unbilled !== undefined && pay.unbilled < 0 && (
                <div style={{ color: 'var(--danger)', marginBottom: 8 }}>
                  ⚠️ ยอดออกใบรวมเกินราคาขาย {fmtBaht(-pay.unbilled)} — ตรวจว่ามีงานเพิ่ม (variation order) หรือกรอกผิด
                </div>
              )}
              {pay.stale && (
                <div className="muted" style={{ marginBottom: 8 }}>
                  ⚠️ ราคาขายถูกแก้หลังออกใบบางงวด — ยอดในตารางคือยอดที่คิดไว้ ณ วันออกใบ (ตรงกับเอกสารจริง)
                  กด "แก้" แล้วบันทึกใหม่ถ้าต้องการคิดตามราคาขายปัจจุบัน
                </div>
              )}
              <div className="table-scroll">
                <table>
                  <thead><tr>
                    <th>งวด</th><th>Invoice No.</th><th>Date</th><th style={{ textAlign: 'right' }}>%</th>
                    <th style={{ textAlign: 'right' }}>ยอดเงิน</th><th>รับเงิน</th><th>เอกสาร</th><th>หมายเหตุ</th>{canPay && <th></th>}
                  </tr></thead>
                  <tbody>
                    {pay.rows.length === 0 && (
                      <tr><td colSpan={canPay ? 9 : 8}><div className="empty">ยังไม่มีงวดเงิน</div></td></tr>
                    )}
                    {pay.rows.map(r => (
                      <tr key={r.id}>
                        <td>{PAYMENT_TYPE_LABEL[r.payType]} #{r.seq}</td>
                        <td className="mono">{r.invoiceNo || '-'}</td>
                        <td>{fmtDate(r.invoiceDate)}</td>
                        <td style={{ textAlign: 'right' }}>{r.percent !== undefined ? `${r.percent}%` : '-'}</td>
                        <td style={{ textAlign: 'right' }}>{fmtBaht(r.amount)}</td>
                        <td>{r.paidAt
                          ? <span className="badge green">รับแล้ว {fmtDate(r.paidAt)}</span>
                          : <span className="badge neutral">รอรับเงิน</span>}</td>
                        {/* 0076 — เอกสารแนบรายงวด · กดแล้วเปิดโมดัลเดียวกับ "แก้" (ส่วนเอกสารอยู่ในนั้น) */}
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {paymentFileCount(db, r.id) > 0
                            ? <button className="small" title="ดู/แนบเอกสารของงวดนี้"
                              onClick={() => setPayForm(payFormOf(r))}>📎 {paymentFileCount(db, r.id)}</button>
                            : canPay
                              ? <button className="small muted" title="แนบเอกสารของงวดนี้"
                                onClick={() => setPayForm(payFormOf(r))}>📎 แนบ</button>
                              : <span className="muted">-</span>}
                        </td>
                        <td className="muted">{r.note || '-'}</td>
                        {canPay && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="small" onClick={() => setPayForm(payFormOf(r))}>แก้</button>
                            <button className="small danger" style={{ marginLeft: 6 }} onClick={async () => {
                              // เก็บ path ไว้ก่อนลบ — หลังลบแถวแล้วอ่านจาก db ไม่ได้อีก (0076 CASCADE)
                              const paths = paymentFiles(db, r.id).map(f => f.filePath)
                              if (await askConfirm({
                                title: `ลบงวด ${PAYMENT_TYPE_LABEL[r.payType]} #${r.seq}`,
                                description: <>
                                  {r.invoiceNo ? <>Invoice <b className="mono">{r.invoiceNo}</b> · </> : null}
                                  ยอด <b>{fmtBaht(r.amount)}</b> · ยอดรวมที่ออกใบแล้วจะลดลงตามนี้
                                  {paths.length > 0 && <> · <b>เอกสารแนบ {paths.length} ไฟล์จะถูกลบไปด้วย</b></>}
                                  {r.paidAt && <> · <span style={{ color: 'var(--red)' }}>งวดนี้บันทึกว่ารับเงินแล้ว ระบบจะไม่ให้ลบ</span></>}
                                </>,
                                confirmLabel: 'ลบงวดเงิน',
                              })) {
                                if (await tryAction(() => act.deleteJobPayment({ paymentId: r.id }), 'ลบงวดเงินแล้ว')) {
                                  if (supabase) await removePaymentDocs(supabase, paths)
                                }
                              }
                            }}>ลบ</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canPay && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {PAYMENT_TYPES.map(t => (
                    <button key={t} className="small" onClick={() => setPayForm({
                      id: null, payType: t, invoiceNo: '', invoiceDate: '', percent: '', amount: '', paidAt: '', note: '', files: [],
                    })}>+ {PAYMENT_TYPE_LABEL[t]}</button>
                  ))}
                  <span className="muted">ใส่ % ของราคาขาย ({fmtBaht(job.budgetSalePrice)}) แล้วระบบคำนวณยอดให้ · หรือกรอกยอดเงินตรงๆ</span>
                </div>
              )}
            </div>
          )}

          <button className="small" onClick={() => setBudgetOpen(o => !o)}>
            {budgetOpen ? '▾' : '▸'} รายละเอียดต้นทุน 7 หมวด (Raw Material → Finance)
          </button>
          {budgetOpen && (
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>หมวดต้นทุน</th><th>Phase Budget</th><th>ที่มา</th><th style={{ textAlign: 'right' }}>งบประมาณ</th><th style={{ textAlign: 'right' }}>ใช้จริง</th><th style={{ textAlign: 'right' }}>คงเหลือ</th></tr></thead>
                <tbody>
                  {budget.categories.map(c => (
                    <tr key={c.key}>
                      <td>{COST_LABEL[c.key]}</td>
                      <td className="mono">{c.phase || '-'}</td>
                      <td>{c.fromPR ? <span className="badge blue">PR/PO</span> : <span className="badge neutral">กรอกเอง</span>}</td>
                      <td style={{ textAlign: 'right' }}>{fmtBaht(c.budget)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtBaht(c.actual)}</td>
                      <td style={{ textAlign: 'right' }} className={c.remaining < 0 ? 'b-value neg' : ''}>{fmtBaht(c.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {budget.lbsCost > 0 && (
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  * ใช้จริงหมวด Raw Material รวมต้นทุนตัว LBS ที่ดึงเข้า Job {fmtBaht(budget.lbsCost)} ({allocatedUnits.length} เครื่อง)
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- LBS allocation ---------------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>LBS ที่ดึงเข้า Job — {allocatedUnits.length}/{job.lbsQtyRequired} เครื่อง</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {allocatedUnits.length >= job.lbsQtyRequired
              ? <span className="badge green">ครบตาม Scope</span>
              : <span className="badge amber">ขาดอีก {job.lbsQtyRequired - allocatedUnits.length} เครื่อง</span>}
            {/* สลับเลข Serial ของเครื่องบน Job กับเครื่องในคลัง (ก่อนเบิกให้ Service) — project ขออนุมัติ Division ก่อน */}
            {canManage && !locked && allocatedUnits.some(u => u.status === 'allocated') && inStockUnits.length > 0 && (
              <button className="small" disabled={pendingApprovalOf('swap_lbs')}
                title={pendingApprovalOf('swap_lbs') ? 'มีคำขอสลับ LBS รอ Division พิจารณาอยู่แล้ว' : ''}
                onClick={() => {
                  const firstAlloc = allocatedUnits.find(u => u.status === 'allocated')
                  setSwapForm({ allocatedUnitId: firstAlloc?.id ?? '', stockUnitId: inStockUnits[0]?.id ?? '', reason: '' })
                  setModal('swap')
                }}>
                {isManage ? '🔁 สลับ LBS' : '🔁 ขออนุมัติสลับ LBS'}
              </button>
            )}
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Serial.LVB</th><th>Serial.OM</th><th>มาจาก Stock</th><th>สถานะ</th><th>เบิกให้ Service</th></tr></thead>
            <tbody>
              {allocatedUnits.length === 0 && <tr><td colSpan={5}><div className="empty">ยังไม่ได้ดึง LBS — Job อยู่สถานะ Draft</div></td></tr>}
              {allocatedUnits.map(u => {
                // 0059: บอกรายเครื่องว่าเบิกได้หรือยัง — เดิมเห็นแค่ Allocated/Issued แล้วต้องเดาเอง
                const blocked = plan.lbsBlocked.find(x => x.unit.id === u.id)
                return (
                  <tr key={u.id}>
                    <td className="mono">{u.serialLvb}</td>
                    <td className="mono">{u.serialOm}</td>
                    <td>{stockOf(u.projectStockId)?.stockNo}</td>
                    <td>{u.status === 'allocated' ? <span className="badge blue">Allocated</span> : <span className="badge neutral">Issued</span>}</td>
                    <td>
                      {u.status === 'issued' ? <span className="badge green">✅ เบิกแล้ว</span>
                        : blocked ? <><span className="badge red">Not Ready</span><div className="muted">{blocked.block}</div></>
                        : <span className="badge green">Ready</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Purchase Orders (วัสดุของ Job) ---------------- */}
      <div className="panel">
        <div className="panel-head">
          <h3>Purchase Orders <span className="muted" style={{ fontWeight: 400 }}>· มูลค่าวัสดุ {fmtBaht(budget.materialValue)} · ต้นทุนคงเหลือ {fmtBaht(budget.remainingCost)}</span></h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {/* เริ่มต้นซ่อนตาราง — Job ที่มีวัสดุหลายสิบรายการทำให้ต้องเลื่อนยาวกว่าจะถึงแผงถัดไป
                ปุ่มทำรายการ (Export / เพิ่มวัสดุ / ออก PR) ยังอยู่ครบตอนซ่อน ไม่ต้องกางก่อนถึงจะกดได้ */}
            <button className="small" onClick={() => setPoOpen(v => !v)}>
              {poOpen ? 'ซ่อนรายการ' : `แสดงรายการ (${accReqs.length})`}
            </button>
            {/* ไฟล์พาราคา/ต้นทุน/กำไรของงานออกไปนอกระบบ → ปุ่มหายทั้งปุ่มถ้าไม่มีสิทธิ์ (report.exec) */}
            {canReport && (
              <button className="small" onClick={exportPurchaseOrders} disabled={accReqs.length === 0}
                title="รายงานผู้บริหาร (Excel) — ชีตสรุปงบ vs ต้นทุนจริง + งวดเงิน + รายละเอียดทุกบรรทัด">
                ⬇ Export Excel
              </button>
            )}
            {canManage && !procureLocked && (
              <button className="small" onClick={() => { setAccSearch(''); setAccForm({ itemId: accessoryItems[0]?.id ?? '', qty: 1, source: 'central_stock', unitPrice: '', phaseBudget: 'raw_mat' }); openModal('accessory') }}>
                + เพิ่มวัสดุ{job.terminalStatus === 'issued' ? ' (ซื้อเพิ่มหลังเบิก)' : ''}
              </button>
            )}
            {canManage && !procureLocked && pendingReqs.length > 0 && (
              <button className="small primary" disabled={pendingApprovalOf('create_pr')}
                title={pendingApprovalOf('create_pr') ? 'มีคำขอออก PR รอ Division พิจารณาอยู่แล้ว' : ''}
                onClick={() => isManage
                  ? tryAction(() => act.createPR({ jobId: job.id, requestIds: pendingReqs.map(r => r.id) }),
                      'ออก PR ส่งให้ Purchasing แล้ว')
                  : tryAction(() => act.requestApproval({
                      type: 'create_pr', jobId: job.id,
                      payload: { requestIds: pendingReqs.map(r => r.id) },
                    }), 'ส่งคำขอออก PR ให้ Division พิจารณาแล้ว')
                }>
                {isManage ? `ออก PR ส่ง Purchasing (${pendingReqs.length} รายการ)` : `ขออนุมัติออก PR (${pendingReqs.length} รายการ)`}
              </button>
            )}
          </div>
        </div>
        {poOpen && <div className="table-scroll">
          <table>
            {/* 0073: แยกบัญชี 4 ช่องของบรรทัด (0067/0068) ขึ้นมาเป็นคอลัมน์จริง
                เดิมซ่อนอยู่ในบรรทัดรองใต้จำนวน ซึ่งอ่านเทียบข้ามบรรทัดไม่ได้
                ⚠️ "เบิก + เหลือ" **ไม่เท่ากับ**จำนวนที่สั่งเสมอไป — ยังมีโอนคืนคลังกับตัดจำหน่ายอีก 2 ช่อง
                   จึงต้องโชว์ครบทั้ง 4 (ซ่อนตัวที่เป็น 0) + เขียนสมการกำกับท้ายตาราง */}
            <thead><tr>
              <th>รหัส Epicor</th><th>ชื่ออุปกรณ์</th>
              <th style={{ textAlign: 'right' }}>จำนวนที่สั่งซื้อ</th>
              <th style={{ textAlign: 'right' }}>เบิกออกหน้างาน</th>
              <th style={{ textAlign: 'right' }}>คงเหลือที่ Job</th>
              <th style={{ textAlign: 'right' }}>ราคา/หน่วย</th>
              <th style={{ textAlign: 'right' }}>ตัดเข้างาน</th>
              <th style={{ textAlign: 'right' }}>ถึงหน้างานแล้ว</th>
              <th>Phase Budget</th><th>แหล่ง</th><th>สถานะ</th><th>ทำเบิก-Epicor</th><th>PR / PO</th><th></th>
            </tr></thead>
            <tbody>
              {accReqs.length === 0 && <tr><td colSpan={14}><div className="empty">ยังไม่มีรายการวัสดุ</div></td></tr>}
              {accReqs.map(r => {
                const item = itemOf(r.itemId)!
                const pr = db.prs.find(p => p.id === r.prId)
                const po = r.poId ? db.pos.find(p => p.id === r.poId) : undefined   // line ผูก PO ใบไหน (0022)
                const active = r.status !== 'cancelled' && r.status !== 'returned'
                // มูลค่าคิดจากจำนวนที่ Job ถืออยู่จริง (หักส่วนที่โอนคืนคลังแล้ว — S1)
                const lineValue = active && r.unitPrice !== undefined ? r.unitPrice * effectiveQty(r) : undefined
                return (
                  <tr key={r.id}>
                    <td className="mono">{item.epicorCode || '-'}</td>
                    <td>{item.name}
                      {isExtra(r.createdAt) && <div><span className="badge amber">ซื้อเพิ่มหลังเบิก</span></div>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.qtyRequested} {item.uom}
                      {/* ตารางนี้รวมของที่ซื้อกับของที่เบิกจากคลังกลาง — หัวคอลัมน์เขียนว่า "สั่งซื้อ"
                          จึงต้องกำกับแถวคลังกลางไว้ ไม่งั้นอ่านว่าไปซื้อของที่จริงเบิกมาจากคลัง */}
                      {r.source === 'central_stock' && <div className="muted" style={{ fontSize: 11 }}>เบิกจากคลัง</div>}
                      {r.source === 'purchasing' && (r.status === 'po_ordered' || r.status === 'received') && (
                        <div className="muted">รับแล้ว {r.qtyReceived}/{r.qtyRequested}</div>
                      )}
                      {(r.qtyTransferred ?? 0) > 0 && (
                        <div className="muted" style={{ color: 'var(--primary)' }}>📦 คืนคลัง {r.qtyTransferred}</div>
                      )}
                      {active && qtyWrittenOff(r) > 0 && (
                        <div className="muted" title={r.writeOffReason || undefined}>✂️ ตัดจำหน่าย {qtyWrittenOff(r)}</div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{active ? qtyIssuedToService(r) : '-'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {active
                        ? <b style={{ color: qtyPendingIssue(r) > 0 ? 'var(--amber, #d97706)' : undefined }}>{qtyPendingIssue(r)}</b>
                        : '-'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmtBaht(r.unitPrice)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtBaht(lineValue)}</td>
                    {/* คอลัมน์แสดงผลล้วน (มติ 2026-09-16) — **ไม่ใช่ฐานการตัดต้นทุน**
                        ตอบคำถาม "ของที่จ่ายเงินไปแล้วถึงมือช่างเท่าไร" โดยไม่แตะสูตรที่ไปบวก actual
                        (ฐานยังเป็น qtyRequested − โอนคืนคลัง ตามมติ 0067/0068 — เปลี่ยนแล้วของที่
                         ตัดจำหน่ายจะกลายเป็นต้นทุน 0 และยอดรวมทุกงานจะไม่เท่ากับยอดที่ซื้อจริง) */}
                    <td style={{ textAlign: 'right' }} className="muted">
                      {active && r.unitPrice !== undefined ? fmtBaht(r.unitPrice * qtyOutToField(r)) : '-'}
                    </td>
                    <td>
                      {r.phaseBudget ? (COST_LABEL[r.phaseBudget] ?? r.phaseBudget) : '-'}
                      {r.phaseBudget && job.budgetCosts?.[r.phaseBudget as CostCategoryKey]?.phase && (
                        <div className="muted mono" style={{ fontSize: 11 }}>Phase: {job.budgetCosts[r.phaseBudget as CostCategoryKey]!.phase}</div>
                      )}
                    </td>
                    <td>{r.source === 'central_stock' ? <span className="badge green">คลังคงเหลือ</span> : <span className="badge amber">Purchasing</span>}</td>
                    {/* คอลัมน์เดียวเล่าทั้งสาย (มติ 2026-08-27) — เดิมแยกเป็น "สถานะ" + "เบิกให้ Service"
                        แล้วอ่านเหมือนบอกเรื่องเดียวกันซ้ำ 2 ที่
                        บรรทัดรองใต้ป้าย = ข้อมูลที่ป้ายบอกไม่ได้เท่านั้น (วันที่เบิก · เหตุผลที่ยังเบิกไม่ได้
                        ซึ่งไม่ตรงกับขั้นของตัวเอง เช่น รับของครบแล้วแต่ PO ทั้งใบยังไม่ครบ) */}
                    <td>
                      <span className={`badge ${accStatusBadge(r)}`}>{accStatusLabel(r)}</span>
                      {r.issuedToServiceAt && <div className="muted">{fmtDate(r.issuedToServiceAt)}</div>}
                      {!r.issuedToServiceAt && active && accBlockNeedsDetail(r) && (() => {
                        const blk = accIssueBlockReason(db, r)
                        return blk ? <div className="muted">⏳ {blk}</div> : null
                      })()}
                    </td>
                    {/* ทำเบิก-Epicor (0064) — ธงกระทบยอดกับ ERP ไม่ใช่สถานะของ
                        ขึ้นปุ่มเฉพาะตอนของอยู่กับ Job แล้ว (เบิกคลัง รอนำใช้ / รับของแล้ว รอนำใช้)
                        และยังกดได้แม้เบิกให้ Service ไปแล้ว เพราะเอกสารมักตามหลังของจริง */}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.epicorIssuedAt ? (
                        <>
                          <span className="badge green">✅ ทำเบิกแล้ว</span>
                          {r.epicorTxnType
                            ? <div><span className={`badge ${EPICOR_TXN[r.epicorTxnType].cls}`}>{EPICOR_TXN[r.epicorTxnType].label}</span></div>
                            : <div className="muted">ไม่ระบุประเภท</div>}
                          {r.epicorDocNo && <div className="mono" style={{ fontSize: 12 }}>{r.epicorDocNo}</div>}
                          <div className="muted">{fmtDate(r.epicorIssuedAt)} · {r.epicorIssuedBy ? userOf(r.epicorIssuedBy) : "-"}</div>
                          {canEpicor && (
                            <button className="small danger" style={{ marginTop: 4 }} onClick={async () => {
                              const v = await askPrompt({
                                title: `ยกเลิกธงทำเบิก-Epicor — ${item.name}`,
                                description: <>ใช้เมื่อกดผิดบรรทัดหรือเลขเอกสารผิด · <b>ธงนี้ไม่กระทบสถานะของ</b> — ยกเลิกแล้วปุ่ม Done จะกลับมา</>,
                                fields: [{ key: 'reason', label: 'เหตุผล', type: 'textarea', required: true,
                                  placeholder: 'เช่น กดผิดบรรทัด / เลขเอกสารผิด' }],
                                confirmLabel: 'ยกเลิกธง',
                              })
                              if (!v) return
                              tryAction(() => act.undoEpicorIssued({ requestId: r.id, reason: v.reason }), 'ยกเลิกธงทำเบิก-Epicor แล้ว')
                            }}>ยกเลิก</button>
                          )}
                        </>
                      ) : canEpicor && (r.status === 'issued' || r.status === 'received') ? (
                        <button className="small primary" onClick={async () => {
                          const v = await askPrompt({
                            title: `ทำเบิก-Epicor — ${item.name}`,
                            description: <>ยืนยันว่าตัดใบเบิกใน Epicor สำหรับ <b>{item.name} {r.qtyRequested} {item.uom}</b> ของ {job.jobNo} เรียบร้อยแล้ว · <b>ธงนี้ไม่กระทบสถานะของและไม่บล็อกการเบิกให้ Service</b></>,
                            fields: [
                              // บังคับเลือก — 2 ทางนี้กระทบยอดคนละฝั่ง (รายได้ / ต้นทุน)
                              { key: 'txnType', label: 'ประเภทการตัดใน Epicor', type: 'select', required: true,
                                options: (Object.keys(EPICOR_TXN) as (keyof typeof EPICOR_TXN)[])
                                  .map(k => ({ value: k, label: `${EPICOR_TXN[k].label} — ${EPICOR_TXN[k].desc}` })),
                                hint: 'Cust-Ship = ของที่ส่งลูกค้าแล้วออก Invoice · Issue-Mis = ของที่เบิกออกไปใช้ ไม่ได้ออก Invoice' },
                              { key: 'docNo', label: 'เลขที่เอกสาร Epicor', value: '',
                                placeholder: 'เช่น ISS-2026-00123',
                                hint: 'เว้นว่างได้ — แต่ถ้ากรอกไว้จะตามกลับไปหาใบเบิกใน Epicor ได้ทันทีตอนกระทบยอด' },
                            ],
                            confirmLabel: 'Done',
                          })
                          if (!v) return
                          tryAction(() => act.markEpicorIssued({ requestId: r.id, txnType: v.txnType as EpicorTxnType, docNo: v.docNo || undefined }), 'บันทึกทำเบิก-Epicor แล้ว')
                        }}>Done</button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td className="mono">{[pr?.prNo, po?.poNo].filter(Boolean).join(' / ') || '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canManage && !procureLocked && active && (
                        <button className="small" onClick={async () => {
                          const v = await askPrompt({
                            title: `ราคาประมาณการ — ${item.name}`,
                            description: <>ขอไว้ {r.qtyRequested} {item.uom} · ใช้คิดงบ <b>ประมาณการ</b> ของหมวดต้นทุน · <b>เว้นว่าง = ล้างราคา</b></>,
                            fields: [{ key: 'price', label: 'ราคาต่อหน่วย', type: 'number', min: 0, suffix: `บาท/${item.uom}`,
                              value: r.unitPrice !== undefined ? String(r.unitPrice) : '',
                              hint: 'กรอกเป็นตัวเลขล้วน ไม่ต้องใส่เครื่องหมาย ,' }],
                          })
                          if (!v) return
                          tryAction(() => act.updateAccessoryRequestPrice({ requestId: r.id, unitPrice: v.price === '' ? undefined : Number(v.price) }), 'แก้ราคาแล้ว')
                        }}>แก้ราคา</button>
                      )}{' '}
                      {canManage && !procureLocked && r.source === 'central_stock' && r.status === 'issued' && (
                        <button className="small" onClick={() => tryAction(() => act.returnAccessory({ requestId: r.id }), 'คืน Accessory กลับคลังคงเหลือแล้ว')}>คืนคลัง</button>
                      )}{' '}
                      {/* โอนวัสดุเหลือเข้าคลังคงเหลือ ให้ Job อื่นเบิกต่อ — ต้นทุนตัดออกจาก Job นี้ตามของ (S1)
                          ⚠️ 0067: **ไม่ใช้ procureLocked แล้ว** — ของเหลือมักรู้ตอนช่างกลับจากหน้างาน
                          ซึ่งเป็นตอนที่ Job เป็น installed ไปแล้ว (มติผู้ใช้ 2026-09-11)
                          ปิดเฉพาะ cancelled ซึ่งคืนของเข้าคลังตอนยกเลิกอยู่แล้ว — ตรงกับ guard ฝั่ง RPC เป๊ะ */}
                      {canManage && job.terminalStatus !== 'cancelled'
                        && (r.status === 'issued' || r.status === 'received') && effectiveQty(r) > 0 && (
                        <button className="small" title="โอนของที่เหลือเข้าคลังคงเหลือ — ต้นทุนจะถูกตัดออกจาก Job นี้ตามจำนวนที่โอน"
                          onClick={async () => {
                            const remain = effectiveQty(r)     // เพดาน = ของที่ Job ถือตามบัญชี
                            const atJob = qtyPendingIssue(r)   // ส่วนที่ยังไม่ออกหน้างาน
                            const out = qtyIssuedToService(r)
                            const v = await askPrompt({
                              title: `โอนเข้าคลังคงเหลือ — ${item.name}`,
                              description: <>
                                Job นี้ถืออยู่ <b>{remain} {item.uom}</b>
                                {out > 0 && <> — ค้างที่ Job <b>{atJob}</b> · เบิกออกหน้างานแล้ว <b>{out}</b></>} ·
                                ของที่โอนจะให้ Job อื่นเบิกต่อได้ และ<b>ต้นทุนถูกตัดออกจาก Job นี้ตามจำนวนที่โอน</b>
                                {out > 0 && <><br />โอนเกิน {atJob} {item.uom} = นับว่า<b>ช่างส่งของที่เบิกไปแล้วคืนกลับคลัง</b> (บันทึกไว้ใน Audit)</>}
                              </>,
                              fields: [
                                { key: 'qty', label: 'จำนวนที่จะโอน', type: 'number', min: 0, required: true,
                                  suffix: item.uom, value: String(atJob > 0 ? atJob : remain),
                                  hint: out > 0 ? `ค้างที่ Job ${atJob} · รวมของที่ออกหน้างานแล้วโอนได้ถึง ${remain}` : undefined,
                                  validate: v => Number(v) > remain ? `โอนได้ไม่เกิน ${remain} ${item.uom}` : Number(v) <= 0 ? 'ต้องมากกว่า 0' : undefined },
                                { key: 'note', label: 'เหตุผล/หมายเหตุ', value: 'วัสดุเหลือจากหน้างาน' },
                              ],
                              confirmLabel: 'โอนเข้าคลัง',
                            })
                            if (!v) return
                            tryAction(() => act.transferJobMaterialToStock({ requestId: r.id, qty: Number(v.qty), note: v.note || undefined }),
                              `โอน ${item.name} ${Number(v.qty)} ${item.uom} เข้าคลังคงเหลือแล้ว`)
                          }}>📦 โอนเข้าคลัง</button>
                      )}{' '}
                      {/* ✂️ ตัดจำหน่ายของเหลือ (0068) — ปิดบรรทัดโดยไม่เอาของเข้าคลัง
                          ขึ้นเฉพาะตอนยังมีของค้างอยู่ที่ Job จริง (ของที่ออกหน้างานแล้วถือว่าใช้ไปกับงานแล้ว)
                          ⚠️ ต้นทุนยังอยู่กับ Job — ต่างจากโอนคืนคลังที่ตัดต้นทุนออก จึงเขียนกำกับในโมดัลให้ชัด */}
                      {canManage && job.terminalStatus !== 'cancelled'
                        && (r.status === 'issued' || r.status === 'received') && qtyPendingIssue(r) > 0 && (
                        <button className="small" title="ตัดของเหลือออกจาก Job โดยไม่เอาเข้าคลัง — ใช้กับเศษที่ไม่คุ้มจะโอนคืน"
                          onClick={async () => {
                            const atJob = qtyPendingIssue(r)
                            const v = await askPrompt({
                              title: `ตัดจำหน่ายของเหลือ — ${item.name}`,
                              description: <>
                                ค้างอยู่ที่ Job <b>{atJob} {item.uom}</b> · ใช้กับ<b>เศษที่ไม่คุ้มจะโอนคืนคลัง</b>
                                (น็อตไม่กี่ตัว · สายเหลือไม่กี่เมตร) เพื่อให้บรรทัดนี้จบและปิดงานได้
                                <br />⚠️ <b>ต้นทุนยังอยู่กับ Job นี้</b> — ของถือว่าสูญไปกับงานแล้ว
                                ไม่ใช่การคืนของ (ต่างจาก <b>📦 โอนเข้าคลัง</b> ที่ตัดต้นทุนออก) ·
                                ของ<b>ไม่เข้าคลังคงเหลือ</b> และ<b>ไม่ลงบัญชีเดินสะพัด</b> แต่บันทึกใน Audit Log ครบ
                              </>,
                              fields: [
                                { key: 'qty', label: 'จำนวนที่ตัดจำหน่าย', type: 'number', min: 0, required: true,
                                  suffix: item.uom, value: String(atJob),
                                  validate: v => Number(v) > atJob ? `ตัดได้ไม่เกิน ${atJob} ${item.uom}` : Number(v) <= 0 ? 'ต้องมากกว่า 0' : undefined },
                                { key: 'reason', label: 'เหตุผลการตัดจำหน่าย', type: 'textarea', required: true,
                                  placeholder: 'เช่น เศษไม่คุ้มค่าขนส่งกลับ / ของเสียหายหน้างาน / ใช้ไปกับงานแต่นับไม่ตรง',
                                  hint: 'บังคับกรอก — ข้อความนี้ลง Audit Log เป็นหลักฐานว่าของหายไปไหน' },
                              ],
                              confirmLabel: 'ตัดจำหน่าย',
                            })
                            if (!v) return
                            tryAction(() => act.writeOffJobMaterial({ requestId: r.id, qty: Number(v.qty), reason: v.reason }),
                              `ตัดจำหน่าย ${item.name} ${Number(v.qty)} ${item.uom} ออกจาก ${job.jobNo} แล้ว`)
                          }}>✂️ ตัดจำหน่าย</button>
                      )}
                      {canManage && !procureLocked && r.status === 'pending' && (
                        <>
                          <button className="small" onClick={async () => {
                            const v = await askPrompt({
                              title: `แก้จำนวน — ${item.name}`,
                              description: <>แก้ได้เฉพาะรายการที่ยังไม่ออก PR · จำนวนเดิม {r.qtyRequested} {item.uom}</>,
                              fields: [{ key: 'qty', label: 'จำนวนใหม่', type: 'number', min: 0, required: true,
                                suffix: item.uom, value: String(r.qtyRequested),
                                validate: v => Number(v) <= 0 ? 'ต้องมากกว่า 0' : undefined }],
                            })
                            if (!v) return
                            tryAction(() => act.updateAccessoryRequestQty({ requestId: r.id, qty: Number(v.qty) }), 'แก้จำนวนแล้ว')
                          }}>แก้จำนวน</button>{' '}
                          <button className="small danger" onClick={() => tryAction(() => act.cancelAccessoryRequest({ requestId: r.id }), 'ยกเลิกคำขอแล้ว')}>ยกเลิก</button>
                        </>
                      )}
                      {/* ลบรายการที่ยกเลิก (ยังไม่เคยผูก PR/PO) ออกจากการ์ด — Project/Division/Manage */}
                      {canCleanup && r.status === 'cancelled' && !r.prId && !r.poId && (
                        <button className="small danger" title="ลบรายการที่ยกเลิกออกจากการ์ด"
                          onClick={async () => {
                            if (await askConfirm({
                              title: `ลบ "${item.name}" ออกจากการ์ด`,
                              description: <>รายการนี้ถูกยกเลิกไปแล้วและยังไม่เคยผูก PR/PO · ลบเพื่อให้การ์ดสะอาด — <b>ประวัติการยกเลิกยังอยู่ใน Audit Log</b></>,
                              confirmLabel: 'ลบออกจากการ์ด',
                            })) tryAction(() => act.deleteAccessoryRequest({ requestId: r.id }), 'ลบรายการออกจากการ์ดแล้ว')
                          }}>
                          🗑️ ลบออกจากการ์ด
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {/* สมการกำกับ — ไม่งั้นคนอ่านจะคาดว่า "เบิก + คงเหลือ" ต้องเท่ากับจำนวนที่สั่ง
              แล้วคิดว่าตัวเลขเพี้ยนทุกครั้งที่มีการคืนคลัง/ตัดจำหน่าย */}
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            <b>จำนวนที่สั่งซื้อ = เบิกออกหน้างาน + คงเหลือที่ Job + คืนคลัง + ตัดจำหน่าย</b>
            {' '}(2 ตัวหลังโชว์ใต้จำนวนเมื่อไม่เป็นศูนย์) ·
            <b> ตัดเข้างาน</b> = ราคา/หน่วย × (จำนวนที่สั่งซื้อ − คืนคลัง) = ยอดที่ไปบวก actual ของหมวดงบ ·
            <b> ถึงหน้างานแล้ว</b> = ราคา/หน่วย × เบิกออกหน้างาน — <b>ตัวเลขดูอย่างเดียว ไม่ได้ใช้คิดงบ</b>
            <br />ของที่ตัดจำหน่ายยังนับเป็นต้นทุนของงาน (ของสูญไปกับงานนี้จริง) · มีแต่การคืนคลังที่หักต้นทุนออก
          </div>
        </div>}
        {jobPrs.length > 0 && (
          <div className="panel-body muted">
            PR ของ Job นี้: {jobPrs.map(p =>
              `${p.prNo} (${PR_STATUS_LABEL[p.status]}${p.status === 'rejected' ? `: ${p.rejectReason}` : ''})`).join(' · ')}
          </div>
        )}
      </div>

      {/* ---------------- ประวัติ ---------------- */}
      <div className="panel">
        <div className="panel-head"><h3>ประวัติดึง/คืน LBS</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>เวลา</th><th>รายการ</th><th>Stock</th><th>Serial No.</th><th>โดย</th></tr></thead>
            <tbody>
              {db.allocations.filter(a => a.jobId === jobId).length === 0 &&
                <tr><td colSpan={5}><div className="empty">ยังไม่มีการดึง/คืน</div></td></tr>}
              {db.allocations.filter(a => a.jobId === jobId).map(a => (
                <tr key={a.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.performedAt)}</td>
                  <td>{a.txnType === 'draw' ? <span className="badge blue">ดึงเข้า Job</span> : <span className="badge green">คืนเข้าสต็อก</span>}{a.note && <div className="muted">{a.note}</div>}</td>
                  <td>{stockOf(a.projectStockId)?.stockNo}</td>
                  <td className="mono">{a.serialNos.join(', ')}</td>
                  <td>{userOf(a.performedBy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Modals ---------------- */}
      {modal === 'draw' && (
        <Modal title="ดึง LBS เข้า Job (เลือกรายเครื่อง)" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary" disabled={picked.size === 0}
              onClick={async () => { if (await tryAction(() => act.drawLbs({ jobId: job.id, stockId: drawStock, unitIds: [...picked] }), `ดึง LBS ${picked.size} เครื่องเข้า ${job.jobNo} แล้ว`)) close() }}>
              ดึง {picked.size} เครื่อง
            </button>
          </>}>
          <label className="field"><span>เลือก Project Stock (ดึงผสมหลาย Stock ได้ — ทำทีละ Stock, คลังที่ปิดแล้วไม่แสดง)</span>
            <select value={drawStock} onChange={e => { setDrawStock(e.target.value); setPicked(new Set()) }}>
              {db.projectStocks.filter(s => s.status === 'open').map(s => {
                const sum = stockSummary(db, s.id)
                return (
                  <option key={s.id} value={s.id}>
                    {s.stockNo} — เลือกได้ {sum.available} เครื่อง (On Hand {sum.onHand}
                    {sum.pending > 0 ? ` · Pending ${sum.pending}` : ''}
                    {sum.unknown > 0 ? ` · ไม่ระบุ ETA ${sum.unknown}` : ''})
                  </option>
                )
              })}
            </select>
          </label>
          <div className="muted" style={{ marginBottom: 8 }}>
            เลือก Serial No. ที่จะดึง — ตาม Scope ดึงได้อีก <b>{drawCap - picked.size}</b> เครื่อง
            (Scope {job.lbsQtyRequired} · ถืออยู่ {returnableUnits.length}{picked.size > 0 ? ` · เลือกแล้ว ${picked.size}` : ''})
          </div>
          {drawCap === 0 && <div className="muted" style={{ color: 'var(--red)', marginBottom: 8 }}>ดึงครบตาม Scope แล้ว — เพิ่มจำนวนใน "แก้ไขข้อมูล Job" ก่อนถ้า Scope เปลี่ยน</div>}
          {/* 0049: เครื่องที่ ETA ยังไม่ถึงยังดึงได้ (จองล่วงหน้า) แต่ต้องเตือนว่าของยังไม่อยู่ที่คลังจริง */}
          {pickedPending > 0 && (
            <div style={{ color: 'var(--amber, #d97706)', marginBottom: 8 }}>
              ⚠️ ในนี้มี <b>{pickedPending} เครื่องที่ยังไม่เข้าคลัง</b> (Status = Pending) —
              ดึงจองล่วงหน้าได้ แต่ <b>ระบบจะไม่ให้เบิกให้ Service จนกว่าของจะถึงคลัง</b> (ETA ผ่านไปแล้ว)
              ตรวจ ETA ให้ตรงกับกำหนดติดตั้งก่อน
            </div>
          )}
          <SerialPicker units={drawableUnits} selected={picked} toggle={toggleDraw} showEta />
        </Modal>
      )}

      {modal === 'return' && (
        <Modal title="คืน LBS กลับสต็อก" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary" disabled={picked.size === 0 || !returnTarget}
              onClick={async () => { if (await tryAction(() => act.returnLbs({ jobId: job.id, unitIds: [...picked], targetStockId: returnTarget }), `คืน LBS ${picked.size} เครื่องแล้ว`)) close() }}>
              คืน {picked.size} เครื่อง
            </button>
          </>}>
          <div className="muted" style={{ marginBottom: 8 }}>เลือกเครื่องที่จะคืน:</div>
          <SerialPicker units={returnableUnits} selected={picked} toggle={togglePick} />
          <label className="field" style={{ marginTop: 12 }}><span>คืนเข้า Stock No. (ผู้ใช้เลือกเอง ไม่ auto)</span>
            <select value={returnTarget} onChange={e => setReturnTarget(e.target.value)}>
              <option value="">— เลือกสต็อกปลายทาง —</option>
              {db.projectStocks.map(s => <option key={s.id} value={s.id}>{s.stockNo}</option>)}
            </select>
          </label>
        </Modal>
      )}

      {modal === 'swap' && (() => {
        const a = db.lbsUnits.find(u => u.id === swapForm.allocatedUnitId)
        const b = db.lbsUnits.find(u => u.id === swapForm.stockUnitId)
        const allocatable = allocatedUnits.filter(u => u.status === 'allocated')
        return (
        <Modal title={`สลับ LBS — ${job.jobNo}`} size="wide" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary" disabled={!swapForm.allocatedUnitId || !swapForm.stockUnitId || !swapForm.reason.trim()}
              onClick={async () => {
                const ok = isManage
                  ? await tryAction(() => act.swapLbs({ jobId: job.id, allocatedUnitId: swapForm.allocatedUnitId, stockUnitId: swapForm.stockUnitId, reason: swapForm.reason }), 'สลับ LBS เรียบร้อย')
                  : await tryAction(() => act.requestApproval({ type: 'swap_lbs', jobId: job.id, payload: { swapAllocatedUnitId: swapForm.allocatedUnitId, swapStockUnitId: swapForm.stockUnitId, reason: swapForm.reason } }), 'ส่งคำขอสลับ LBS ให้ Division พิจารณาแล้ว')
                if (ok) close()
              }}>
              {isManage ? 'สลับเลย' : 'ขออนุมัติสลับ'}
            </button>
          </>}>
          <div className="muted" style={{ marginBottom: 12 }}>
            สลับ <b>เลข Serial (LVB + OM)</b> ระหว่างเครื่องบน Job กับเครื่องว่างในคลัง — เครื่องไม่ย้าย/ไม่เปลี่ยนสถานะ-สังกัดคลัง
            {' '}· <b>ต้นทุน/เครื่อง และ FOB/ETA to WH ย้ายตามเลข Serial ไปด้วย</b> (0056) เพราะเป็นข้อมูลของตัวเครื่องนั้น
            {!isManage && <> · ต้องให้ <b>Division</b> อนุมัติก่อน</>}
          </div>
          <div className="row">
            <label className="field"><span>เครื่องบน Job (จะรับเลขใหม่)</span>
              <select value={swapForm.allocatedUnitId} onChange={e => setSwapForm({ ...swapForm, allocatedUnitId: e.target.value })}>
                {allocatable.map(u => <option key={u.id} value={u.id}>{u.serialLvb} / {u.serialOm} · {stockOf(u.projectStockId)?.stockNo}</option>)}
              </select>
            </label>
            <label className="field"><span>เครื่องในคลัง (เอาเลขมาสลับ · คงค่าจาก Project Stock)</span>
              <select value={swapForm.stockUnitId} onChange={e => setSwapForm({ ...swapForm, stockUnitId: e.target.value })}>
                {inStockUnits.map(u => <option key={u.id} value={u.id}>{u.serialLvb} / {u.serialOm} · {stockOf(u.projectStockId)?.stockNo}</option>)}
              </select>
            </label>
          </div>
          {a && b && (
            <div className="budget-profit" style={{ marginBottom: 12 }}>
              <span>ผลหลังสลับ</span>
              <b className="mono" style={{ fontSize: 12 }}>บน Job: {b.serialLvb}/{b.serialOm} · คลัง: {a.serialLvb}/{a.serialOm}</b>
            </div>
          )}
          {/* ต้นทุนย้ายตาม Serial (0056) → ผู้อนุมัติต้องเห็นตัวเลขที่จะเปลี่ยนก่อนกดยืนยัน */}
          {a && b && a.unitCost !== b.unitCost && (
            <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
              ต้นทุนตัว LBS ของงานนี้จะเปลี่ยน: {fmtBaht(a.unitCost)} → <b>{fmtBaht(b.unitCost)}</b>
              {' '}(กระทบ actual หมวด Raw Material)
            </div>
          )}
          <label className="field"><span>เหตุผลการสลับ * (แจ้ง Division)</span>
            <textarea rows={2} value={swapForm.reason} onChange={e => setSwapForm({ ...swapForm, reason: e.target.value })}
              placeholder="เช่น เครื่องเดิมชำรุด / สลับตามหน้างานจริง" />
          </label>
        </Modal>
        )
      })()}

      {modal === 'accessory' && (
        <Modal title="Purchase Requisition — เพิ่มวัสดุให้ Job" size="wide" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary" disabled={!accForm.itemId}
              onClick={async () => { if (await tryAction(() => act.addAccessoryRequest({ jobId: job.id, itemId: accForm.itemId, qty: accForm.qty, source: accForm.source, unitPrice: toBudgetNum(accForm.unitPrice), phaseBudget: accForm.phaseBudget }), accForm.source === 'central_stock' ? 'เบิกจากคลังคงเหลือเรียบร้อย' : 'เพิ่มรายการรอออก PR แล้ว')) close() }}>
              {accForm.source === 'central_stock' ? 'เบิกจากคลังคงเหลือ' : 'เพิ่มรายการ (รอออก PR)'}
            </button>
          </>}>
          <label className="field"><span>ค้นหาวัสดุ (ชื่อ / รหัส Epicor)</span>
            <input value={accSearch} placeholder="พิมพ์เพื่อค้นหา…" autoFocus
              onChange={e => {
                const term = e.target.value
                setAccSearch(term)
                // ถ้ารายการที่เลือกอยู่ไม่อยู่ในผลค้นหา → เลือกตัวแรกของผลลัพธ์ให้อัตโนมัติ
                const f = filterAcc(term)
                if (!f.some(i => i.id === accForm.itemId)) {
                  const first = f[0]
                  setAccForm(a => ({ ...a, itemId: first?.id ?? '', source: first?.stockableCentrally ? 'central_stock' : 'purchasing' }))
                }
              }} />
          </label>
          <label className="field"><span>รายการวัสดุ (Accessory){accSearch.trim() ? ` · พบ ${filteredAcc.length} รายการ` : ''}</span>
            <select value={accForm.itemId} size={Math.min(8, Math.max(3, filteredAcc.length))} onChange={e => {
              const item = itemOf(e.target.value)
              setAccForm({ ...accForm, itemId: e.target.value, source: item?.stockableCentrally ? 'central_stock' : 'purchasing' })
            }}>
              {filteredAcc.length === 0 && <option value="">— ไม่พบวัสดุที่ค้นหา —</option>}
              {/* โชว์ยอดคลังคงเหลือในลิสต์เลย — ผู้ใช้เห็นก่อนเลือกว่าจะเบิกหรือซื้อ (S2 ข้อ 4) */}
              {filteredAcc.map(i => {
                const onHand = db.accessoryStock.find(r => r.itemId === i.id)?.qtyOnHand ?? 0
                return (
                  <option key={i.id} value={i.id}>
                    {i.name}{(i.epicorCode || i.code) ? ` (${i.epicorCode || i.code})` : ''}
                    {onHand > 0 ? `  ✔ มีในคลัง ${onHand} ${i.uom}` : ''}
                  </option>
                )
              })}
            </select>
          </label>
          {selAccItem && (
            <div className="muted" style={{ marginBottom: 12 }}>
              รหัส Epicor: <b className="mono">{selAccItem.epicorCode || '-'}</b> · ชื่ออุปกรณ์: <b>{selAccItem.name}</b> · หน่วย: <b>{selAccItem.uom}</b> <span className="mono">(อิงจาก Master Data)</span>
            </div>
          )}
          <div className="row">
            <label className="field"><span>จำนวน{selAccItem ? ` (${selAccItem.uom})` : ''}</span>
              <input type="number" min={1} value={accForm.qty} onChange={e => setAccForm({ ...accForm, qty: Number(e.target.value) })} />
            </label>
            <label className="field"><span>ราคาต่อหน่วย (บาท)</span>
              <input type="number" min={0} value={accForm.unitPrice} placeholder="0" onChange={e => setAccForm({ ...accForm, unitPrice: e.target.value })} />
            </label>
            <label className="field"><span>ตัดต้นทุนหมวด (Phase Budget)</span>
              <select value={accForm.phaseBudget} onChange={e => setAccForm({ ...accForm, phaseBudget: e.target.value as CostCategoryKey })}>
                <option value="raw_mat">Raw Material{job.budgetCosts?.raw_mat?.phase ? ` (${job.budgetCosts.raw_mat.phase})` : ''}</option>
                <option value="outsourcing">Outsourcing{job.budgetCosts?.outsourcing?.phase ? ` (${job.budgetCosts.outsourcing.phase})` : ''}</option>
              </select>
            </label>
          </div>
          <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>มูลค่าวัสดุนี้จะตัดต้นทุนเข้าหมวดที่เลือก (Raw Material / Outsourcing) ใน Project Budget</div>
          {toBudgetNum(accForm.unitPrice) !== undefined && (
            <div className="budget-profit" style={{ marginBottom: 12 }}>
              <span>มูลค่ารายการนี้</span><b className="pos">{fmtBaht((toBudgetNum(accForm.unitPrice) ?? 0) * accForm.qty)}</b>
            </div>
          )}
          <label className="field"><span>จะเบิกจากคลัง หรือ สั่งซื้อ?</span>
            <select value={accForm.source} onChange={e => setAccForm({ ...accForm, source: e.target.value as typeof accForm.source })}>
              <option value="central_stock" disabled={selAccStockQty <= 0}>
                เบิกจากคลังคงเหลือ {selAccStockQty > 0 ? `(มี ${selAccStockQty} ${selAccItem?.uom ?? ''})` : '(ไม่มีของในคลัง)'}
                <div className="muted" style={{ fontWeight: 400 }}>
                  ⏱️ ยอดคลัง<b>ลดทันทีที่กดปุ่มนี้</b> (ไม่ใช่ตอนเบิกให้ Service) — ของมาอยู่ในมือ Job แล้ว
                </div>
              </option>
              <option value="purchasing">สั่งซื้อผ่าน Purchasing (ออก PR → PO)</option>
            </select>
          </label>

          {/* ถ้ามีของในคลังแต่เลือกสั่งซื้อ → เตือนและให้สลับได้ทันที (ข้อ 4) */}
          {accForm.source === 'purchasing' && selAccStockQty > 0 && (
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-body" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--amber, #b45309)' }}>
                  ⚠️ วัสดุนี้<b>มีอยู่ในคลังคงเหลือ {selAccStockQty} {selAccItem?.uom}</b> แล้ว —
                  {selAccStockQty >= accForm.qty ? ' เบิกได้เลยไม่ต้องซื้อใหม่' : ` เบิกได้ ${selAccStockQty} ที่เหลือค่อยสั่งซื้อ`}
                </span>
                <button className="small primary" onClick={() => setAccForm({ ...accForm, source: 'central_stock', qty: Math.min(accForm.qty, selAccStockQty) })}>
                  เปลี่ยนเป็นเบิกจากคลัง
                </button>
              </div>
            </div>
          )}
          {accForm.source === 'central_stock' && selAccStockQty > 0 && (
            <div className="muted" style={{ marginBottom: 8 }}>
              ราคาที่ใช้ตัดต้นทุนจะดึงจาก<b>ต้นทุนถัวเฉลี่ยของคลัง</b> ({fmtBaht(stockCostOf(db, accForm.itemId))}) โดยอัตโนมัติ
            </div>
          )}
          {accForm.source === 'central_stock' && selAccStockQty < accForm.qty && (
            <div className="muted" style={{ color: 'var(--red)' }}>
              คลังคงเหลือ {selAccStockQty} ไม่พอ (ขอ {accForm.qty}) — ลดจำนวน หรือเปลี่ยนเป็นสั่งซื้อผ่าน Purchasing
            </div>
          )}
        </Modal>
      )}

      {/* ---------------- popup "จะเบิกอะไร" (0059) ----------------
          เดิมโมดัลนี้แค่ถามวันนัด แล้วเบิกทั้งใบ · ตอนนี้เป็นที่ที่ผู้ใช้เลือกของทีละชิ้น
          กติกาที่ต้องเห็นจากจอตรง ๆ: Ready ติ๊กได้ · Not Ready ติ๊กไม่ได้ + บอกเหตุผลข้างรายการ */}
      {modal === 'issue' && (() => {
        const nUnits = pickedUnits.size
        const nReqs = pickedReqs.size
        const needPlan = !job.installStartDate || !job.installEndDate || !job.issueLocation
        const planFilled = !!issueForm.startDate && !!issueForm.endDate && !!issueForm.location.trim()
        const nothingPicked = nUnits === 0 && nReqs === 0
        // ตรวจจำนวนที่กรอกของทุกบรรทัดที่ติ๊กไว้ — มีช่องไหนผิด กดยืนยันไม่ได้ (0067)
        const pickedRows = accReqs.filter(r => pickedReqs.has(r.id))
        const badQty = pickedRows.filter(r => !!qtyState(r).err)
        const partialRows = pickedRows.filter(r => qtyState(r).partial)
        // Manage เบิก LBS ตรงได้ · Project ต้องส่งคำขอ → ปุ่มเดียวแต่ผลต่างกัน จึงต้องบอกให้ชัด
        const label = nUnits > 0 && !isManage
          ? (nReqs > 0 ? `เบิกวัสดุ ${nReqs} + ส่งคำขอ LBS` : 'ส่งคำขออนุมัติเบิก LBS')
          : 'ยืนยันการเบิก'
        return (
          <Modal title={`เบิกให้ Service — ${job.jobNo}`} onClose={close} size="wide"
            footer={<>
              {/* สรุปซ้ายล่าง = ทวนก่อนกด ไม่ต้องเลื่อนขึ้นไปนับเอง */}
              <span className="muted" style={{ marginRight: 'auto', fontSize: 12.5 }}>
                {nothingPicked ? 'ยังไม่ได้เลือกอะไร' : <>
                  เลือกไว้: {nUnits > 0 && <>LBS <b>{nUnits}</b> เครื่อง</>}
                  {nUnits > 0 && nReqs > 0 && ' · '}
                  {nReqs > 0 && <>วัสดุ <b>{nReqs}</b> รายการ</>}
                  {partialRows.length > 0 && <> · <b style={{ color: 'var(--amber, #d97706)' }}>เบิกบางส่วน {partialRows.length}</b></>}
                </>}
              </span>
              <button onClick={close}>ยกเลิก</button>
              <button className="success"
                disabled={nothingPicked || badQty.length > 0 || (needPlan && !planFilled)}
                title={nothingPicked ? 'เลือกของที่จะเบิกอย่างน้อย 1 รายการ'
                  : badQty.length > 0 ? `แก้จำนวนที่เบิกให้ถูกต้องก่อน (${badQty.length} รายการ)`
                  : needPlan && !planFilled ? 'กรอกวันติดตั้ง Start–End และ Location ให้ครบก่อน' : ''}
                onClick={submitIssue}>
                {label}
              </button>
            </>}>
            <p className="muted" style={{ marginBottom: 12 }}>
              {locked
                ? <>งานนี้ปิดเป็น <b>Issued</b> ไปแล้ว — รอบนี้เบิกได้เฉพาะ<b>วัสดุที่ซื้อเพิ่มหลังเบิก</b> ·
                    เบิกไม่เต็มจำนวนก็ได้ ของที่เหลือค้างอยู่ที่ Job · <b>สถานะใบงานไม่เปลี่ยน</b> (ปิดไปแล้ว)</>
                : <>เลือกได้ว่ารอบนี้จะส่งอะไรให้ Service — <b>ไม่ต้องรอให้ครบทั้งใบ</b> และ<b>เบิกไม่เต็มจำนวนก็ได้</b> ·
                    ของที่เหลือค้างอยู่ที่ Job เบิกตามมาได้ภายหลัง · ระบบปิดงานเป็น <b>Issued</b> เมื่อ
                    ทุกชิ้นมีที่ไปครบ (ออกหน้างาน · โอนคืนคลังคงเหลือ · หรือตัดจำหน่าย)</>}
            </p>

            {/* ---- LBS ---- (ซ่อนเมื่อใบปิดแล้ว — LBS ออกครบไปตั้งแต่ตอนปิดใบ และดึงเข้าใหม่ไม่ได้) */}
            {!locked && <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-head">
                <h3>LBS <span className="muted" style={{ fontWeight: 400 }}>
                  · เบิกได้ {plan.lbsReady.length} · เบิกไม่ได้ {plan.lbsBlocked.length} · เบิกไปแล้ว {plan.lbsIssued.length}
                </span></h3>
                {plan.lbsReady.length > 0 && (
                  <button className="small" onClick={() => setPickedUnits(
                    nUnits === plan.lbsReady.length ? new Set() : new Set(plan.lbsReady.map(u => u.id)))}>
                    {nUnits === plan.lbsReady.length ? 'ไม่เลือกเลย' : 'เลือกทั้งหมดที่พร้อม'}
                  </button>
                )}
              </div>
              <div className="panel-body">
                {plan.lbsShort > 0 && (
                  <div style={{ color: 'var(--danger)', marginBottom: 8 }}>
                    ⚠️ ดึง LBS ยังไม่ครบ Scope — ขาดอีก <b>{plan.lbsShort} เครื่อง</b> เบิก LBS ไม่ได้จนกว่าจะดึงครบ
                  </div>
                )}
                {plan.lbsReady.length === 0 && plan.lbsBlocked.length === 0 && (
                  <div className="muted">เบิก LBS ครบทุกเครื่องแล้ว</div>
                )}
                <div className="serial-grid">
                  {plan.lbsReady.map(u => (
                    <div key={u.id} className={`serial-pick${pickedUnits.has(u.id) ? ' selected' : ''}`}
                      onClick={() => plan.lbsShort === 0 && toggleUnit(u.id)}
                      style={plan.lbsShort > 0 ? { opacity: .5, cursor: 'not-allowed' } : undefined}>
                      <span className="pick-main">
                        <input type="checkbox" readOnly checked={pickedUnits.has(u.id)} disabled={plan.lbsShort > 0} />
                        <span className="mono">{u.serialLvb}</span>
                      </span>
                      <span className="badge green">Ready</span>
                    </div>
                  ))}
                  {plan.lbsBlocked.map(({ unit, block }) => (
                    <div key={unit.id} className="serial-pick" style={{ opacity: .55, cursor: 'not-allowed' }} title={block}>
                      <span className="pick-main">
                        <input type="checkbox" readOnly checked={false} disabled />
                        <span className="mono">{unit.serialLvb}</span>
                      </span>
                      <span className="pick-eta">⚠️ {block}</span>
                    </div>
                  ))}
                </div>
                {nUnits > 0 && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    {isManage
                      ? <>เบิก LBS ตรงได้ (Manage) — เครื่องที่เบิกออกไปจะ<b>ล็อก คืนหรือสลับไม่ได้อีก</b></>
                      : <>LBS ต้องผ่าน <b>Division</b> — ระบบจะส่งคำขอไป ไม่ได้เบิกทันที</>}
                  </div>
                )}
              </div>
            </div>}

            {/* ---- Accessory จัดกลุ่มตาม PO ---- */}
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-head">
                <h3>Accessory <span className="muted" style={{ fontWeight: 400 }}>
                  · เบิกได้ {plan.accReady.length} / ค้างทั้งหมด {plan.accPending.length} รายการ
                </span></h3>
                {plan.accReady.length > 0 && (
                  <button className="small" onClick={() => setPickedReqs(
                    nReqs === plan.accReady.length ? new Set() : new Set(plan.accReady.map(r => r.id)))}>
                    {nReqs === plan.accReady.length ? 'ไม่เลือกเลย' : 'เลือกทั้งหมดที่พร้อม'}
                  </button>
                )}
              </div>
              <div className="panel-body">
                {plan.groups.length === 0 && <div className="muted">ไม่มีวัสดุค้างรอเบิก</div>}
                {plan.groups.map(g => {
                  const allPicked = g.ready.length > 0 && g.ready.every(r => pickedReqs.has(r.id))
                  return (
                    <div key={g.key} className="issue-group">
                      {/* หัวกลุ่ม = 1 PO (หรือของจากคลังคงเหลือ) — ติ๊กหัวกลุ่มเลือกทั้งใบ */}
                      <div className="issue-group-head">
                        {g.ready.length > 0 ? (
                          <label className="issue-group-title">
                            <input type="checkbox" checked={allPicked} onChange={() => toggleGroup(g.ready.map(r => r.id), !allPicked)} />
                            <b className="mono">{g.label}</b>
                          </label>
                        ) : <b className="mono" style={{ opacity: .6 }}>{g.label}</b>}
                        {g.po
                          ? (g.po.status === 'received'
                              ? <span className="badge green">รับของแล้ว</span>
                              : g.po.status === 'cancelled'
                                ? <span className="badge neutral">ยกเลิก</span>
                                : <span className="badge amber">รอรับของ</span>)
                          : <span className="badge green">คลังคงเหลือ</span>}
                        <span className="muted">{g.rows.length} รายการ</span>
                        {g.block && <span style={{ color: 'var(--danger)' }}>⚠️ {g.block} — เบิกไม่ได้</span>}
                      </div>
                      {/* ตารางจริง คอลัมน์ตรงกันทุกแถว — เดิมเป็น flex row ทำให้ชื่อยาว/สั้นดันของข้างๆ ไม่ตรงแนว */}
                      <div className="issue-rows">
                        <div className="issue-row issue-row-head">
                          <span />
                          <span>วัสดุ</span>
                          <span className="num">ค้างที่ Job</span>
                          <span className="num">เบิกรอบนี้</span>
                          <span>สถานะ</span>
                        </div>
                        {g.rows.map(({ req: r, block }) => {
                          const it = itemOf(r.itemId)
                          const on = pickedReqs.has(r.id)
                          const q = qtyState(r)
                          const already = qtyIssuedToService(r)
                          return (
                            <div key={r.id} className={`issue-row${block ? ' blocked' : ''}${on ? ' picked' : ''}`}>
                              <input type="checkbox" disabled={!!block} checked={on} onChange={() => toggleReq(r.id)} />
                              <label className="issue-name" onClick={() => !block && toggleReq(r.id)}>
                                {it?.name ?? '-'}
                                <span className="issue-sub mono">{it?.epicorCode || it?.code || '-'}</span>
                              </label>
                              <span className="num">
                                <b>{q.max}</b> <span className="muted">{it?.uom ?? ''}</span>
                                {already > 0 && <span className="issue-sub">เบิกแล้ว {already} · ขอ {effectiveQty(r)}</span>}
                              </span>
                              <span className="num">
                                {block ? <span className="muted">-</span> : (
                                  <input type="number" min={1} max={q.max} value={q.raw} disabled={!on}
                                    className={q.err && on ? 'bad' : undefined}
                                    onChange={e => setQty(r.id, e.target.value)} />
                                )}
                              </span>
                              <span className="issue-state">
                                {block ? <span className="muted">{block}</span>
                                  : q.err && on ? <span style={{ color: 'var(--danger)' }}>{q.err}</span>
                                  : q.partial && on ? <span className="badge amber">เบิกบางส่วน · ค้าง {q.max - q.n}</span>
                                  : <span className="badge green">Ready</span>}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                {plan.accReady.length > 0 && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    วัสดุที่รับของแล้ว <b>เบิกได้เลยไม่ต้องรอ Division</b> — บันทึกลง Audit Log ทุกครั้ง ·
                    ลดจำนวนใน "เบิกรอบนี้" ได้ ของที่เหลือ<b>ค้างอยู่ที่ Job</b> เบิกตามมาทีหลัง
                    หรือกด <b>📦 โอนเข้าคลัง</b> ที่แผง Purchase Orders เพื่อคืนเข้าคลังคงเหลือ
                  </div>
                )}
              </div>
            </div>

            {/* ---- นัดติดตั้ง ---- */}
            {needPlan ? (
              <>
                <p style={{ marginBottom: 6 }}>
                  กำหนดนัดหมายติดตั้งจริง <span className="muted">(แผนเดิม: {job.installLocation || '-'} · {fmtDate(job.requiredDate)})</span>
                </p>
                <div className="row">
                  <label className="field"><span>วันเริ่มติดตั้ง (Start) *</span>
                    <input type="date" value={issueForm.startDate}
                      onChange={e => setIssueForm({ ...issueForm, startDate: e.target.value, endDate: issueForm.endDate && issueForm.endDate >= e.target.value ? issueForm.endDate : e.target.value })} />
                  </label>
                  <label className="field"><span>วันสิ้นสุด (End) *</span>
                    <input type="date" min={issueForm.startDate || undefined} value={issueForm.endDate}
                      onChange={e => setIssueForm({ ...issueForm, endDate: e.target.value })} />
                  </label>
                </div>
                <label className="field"><span>Location (สถานที่ติดตั้งจริง) *</span>
                  <input value={issueForm.location} onChange={e => setIssueForm({ ...issueForm, location: e.target.value })} placeholder="สถานีไฟฟ้า..." />
                </label>
              </>
            ) : (
              <p className="muted" style={{ marginBottom: 10 }}>
                📅 นัดติดตั้งของงานนี้ตั้งไว้แล้ว <b>{fmtDate(job.installStartDate)} – {fmtDate(job.installEndDate)}</b>{' '}
                ที่ <b>{job.issueLocation}</b> — แก้ได้ด้านล่างถ้าต้องเลื่อน (เว้นว่าง = คงเดิม)
              </p>
            )}
            {!needPlan && (
              <>
                <div className="row">
                  <label className="field"><span>เลื่อนวันเริ่ม (ไม่บังคับ)</span>
                    <input type="date" value={issueForm.startDate}
                      onChange={e => setIssueForm({ ...issueForm, startDate: e.target.value, endDate: issueForm.endDate && issueForm.endDate >= e.target.value ? issueForm.endDate : e.target.value })} />
                  </label>
                  <label className="field"><span>เลื่อนวันสิ้นสุด (ไม่บังคับ)</span>
                    <input type="date" min={issueForm.startDate || undefined} value={issueForm.endDate}
                      onChange={e => setIssueForm({ ...issueForm, endDate: e.target.value })} />
                  </label>
                </div>
                <label className="field"><span>เปลี่ยน Location (ไม่บังคับ)</span>
                  <input value={issueForm.location} onChange={e => setIssueForm({ ...issueForm, location: e.target.value })} placeholder={job.issueLocation} />
                </label>
              </>
            )}
            <label className="field"><span>บันทึกถึงทีม Service (ทีม/นัดหมาย)</span>
              <textarea rows={2} value={issueForm.note} onChange={e => setIssueForm({ ...issueForm, note: e.target.value })} placeholder="ทีม Service A นัดเข้าไซต์ ..." />
            </label>
          </Modal>
        )
      })()}

      {modal === 'cancel' && (
        <Modal title={isManage ? `ยกเลิก ${job.jobNo}` : `ขออนุมัติยกเลิก ${job.jobNo} (Division)`} onClose={close}
          footer={<>
            <button onClick={close}>กลับ</button>
            <button className="danger"
              onClick={async () => {
                if (isManage) {
                  if (await tryAction(() => act.cancelJob({ jobId: job.id, reason: cancelReason, receivedAccessoryToCentral: receivedToCentral }), `ยกเลิก ${job.jobNo} และคืนของกลับสต็อกแล้ว`)) { close(); navigate('/jobs') }
                } else {
                  if (await tryAction(() => act.requestApproval({
                    type: 'cancel_job', jobId: job.id,
                    payload: { reason: cancelReason, receivedToCentral },
                  }), `ส่งคำขอยกเลิก ${job.jobNo} ให้ Division พิจารณาแล้ว`)) close()
                }
              }}>
              {isManage ? 'ยืนยันยกเลิก Job' : 'ส่งคำขออนุมัติ'}
            </button>
          </>}>
          <p style={{ marginBottom: 10 }}>
            ระบบจะ <b>คืน LBS {returnableUnits.length} เครื่องกลับ Stock No. เดิม</b>ตาม allocation record
            และคืน Accessory ที่เบิกจากสต็อกกลางโดยอัตโนมัติ พร้อมยกเลิก PR/PO ที่ค้างอยู่
          </p>
          <label className="field"><span>เหตุผลการยกเลิก *</span>
            <textarea rows={2} value={cancelReason} onChange={e => setCancelReason(e.target.value)} />
          </label>
          {receivedFromPo.length > 0 && (
            <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={receivedToCentral} onChange={e => setReceivedToCentral(e.target.checked)} />
              <span style={{ margin: 0 }}>
                นำ Accessory ที่สั่งซื้อและรับของแล้ว ({receivedFromPo.length} รายการ) เข้าสต็อกกลางไว้ใช้ Job อื่นต่อ
                <div className="muted">ถ้าไม่เลือก ระบบจะคงสถานะ "รับของแล้ว" ไว้ให้พิจารณาเป็นเคสไป</div>
              </span>
            </label>
          )}
        </Modal>
      )}

      {modal === 'edit' && (
        <Modal title={`แก้ไขข้อมูล ${job.jobNo}`} size="wide" onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary"
              onClick={async () => {
                const { salePrice, planCoord, ...rest } = editForm
                const sites = rest.lbsQtyRequired > 1 ? editSites : []
                // parseLatLng/sitesToApi โยน error ถ้าพิกัดใช้ไม่ได้ → ต้องอยู่ใน tryAction ให้จับได้
                if (await tryAction(() => {
                  const c = parseLatLng(planCoord)
                  return act.updateJob({
                    jobId: job.id, ...rest,
                    budgetSalePrice: toBudgetNum(salePrice), budgetCosts: costFormToApi(editCosts),
                    installSites: sitesToApi(sites), planLat: c?.lat, planLng: c?.lng,
                  })
                }, 'บันทึกแล้ว')) close()
              }}>บันทึก</button>
          </>}>
          <label className="field"><span>Job No. * (แก้ได้ก่อนเบิก — ห้ามซ้ำ)</span>
            <input className="mono" value={editForm.jobNo} onChange={e => setEditForm({ ...editForm, jobNo: e.target.value })} />
          </label>
          <div className="row">
            <label className="field"><span>ชื่อลูกค้า</span>
              <input value={editForm.customerName} onChange={e => setEditForm({ ...editForm, customerName: e.target.value })} />
            </label>
            <label className="field"><span>เบอร์ติดต่อ</span>
              <input value={editForm.contactPhone} onChange={e => setEditForm({ ...editForm, contactPhone: e.target.value })} placeholder="08x-xxx-xxxx" />
            </label>
          </div>
          <label className="field"><span>Scope</span>
            <textarea rows={2} value={editForm.scope} onChange={e => setEditForm({ ...editForm, scope: e.target.value })} />
          </label>
          <div className="row">
            <label className="field"><span>สถานที่ติดตั้ง{editForm.lbsQtyRequired > 1 ? ' (จุดที่ 1)' : ''}</span>
              <input value={editForm.installLocation} onChange={e => setEditForm({ ...editForm, installLocation: e.target.value })} />
            </label>
            <label className="field"><span>พิกัดจุดที่ 1 (ว่างได้ — ใส่แล้วขึ้นหมุดบนหน้า Map Tracking)</span>
              <CoordInput value={editForm.planCoord} onChange={v => setEditForm({ ...editForm, planCoord: v })} />
            </label>
            <label className="field"><span>วันที่ต้องการติดตั้ง</span>
              <input type="date" value={editForm.requiredDate} onChange={e => setEditForm({ ...editForm, requiredDate: e.target.value })} />
            </label>
          </div>
          <label className="field"><span>จำนวน LBS ตาม Scope (เครื่อง)</span>
            <input type="number" min={1} value={editForm.lbsQtyRequired} onChange={e => setEditForm({ ...editForm, lbsQtyRequired: Number(e.target.value) })} />
          </label>
          {editForm.lbsQtyRequired > 1 && (
            <div style={{ marginBottom: 4 }}>
              <div className="muted" style={{ marginBottom: 6 }}>จุดติดตั้งเพิ่มเติม (ติดตั้งหลายจุดได้เมื่อมี LBS มากกว่า 1 เครื่อง)</div>
              <InstallSitesEditor sites={editSites} onChange={setEditSites} max={editForm.lbsQtyRequired - 1} />
            </div>
          )}
          <div className="budget-legend">Project Budget</div>
          <BudgetFields
            sale={editForm.salePrice} costs={editCosts}
            onSale={v => setEditForm({ ...editForm, salePrice: v })}
            onCosts={setEditCosts}
          />
        </Modal>
      )}

      {modal === 'budget' && (
        <Modal title={`แก้ไขงบประมาณ — ${job.jobNo}${locked ? ' (แก้ย้อนหลัง)' : ''}`} onClose={close}
          footer={<>
            <button onClick={close}>ยกเลิก</button>
            <button className="primary"
              onClick={async () => {
                const { salePrice, ...rest } = editForm
                // Job ล็อกแล้ว → ใช้ updateJobBudget (แก้เฉพาะงบ, ไม่ผ่าน assertJobEditable); ยังเปิดอยู่ → updateJob ตามเดิม
                const budgetPayload = { budgetSalePrice: toBudgetNum(salePrice), budgetCosts: costFormToApi(editCosts) }
                const save = locked
                  ? () => act.updateJobBudget({ jobId: job.id, ...budgetPayload })
                  : () => act.updateJob({ jobId: job.id, ...rest, ...budgetPayload, installSites: job.installSites })  // คงจุดติดตั้งเดิม (modal นี้ไม่แก้จุด)
                if (await tryAction(save, 'บันทึกงบประมาณแล้ว')) close()
              }}>บันทึก</button>
          </>}>
          {locked && (
            <div className="muted" style={{ marginBottom: 10 }}>
              ใบนี้เบิกให้ Service ไปแล้ว — โมดัลนี้แก้ได้เฉพาะ <b>ราคาขายและต้นทุน 7 หมวด</b>{' '}
              (Scope · จำนวน LBS · จุดติดตั้ง ยังล็อกอยู่) · ทุกการแก้ถูกบันทึกใน Audit Log ว่าแก้ย้อนหลัง
            </div>
          )}
          {/* 🔴 ราคาขายเป็นฐานของงวดที่คิดเป็น % — งวดที่ออกใบไปแล้ว freeze ยอดไว้ (0044) ไม่ขยับตาม
              ต้องเตือนตรงจุดที่กำลังจะพิมพ์ ไม่ใช่ไปเห็นป้าย stale ทีหลังตอนเปิดตาราง Payment */}
          {pay.rows.some(r => r.percent !== undefined) && (
            <div style={{ color: 'var(--danger)', marginBottom: 10 }}>
              ⚠️ งานนี้ออกใบวางบิลแบบคิด % ไปแล้ว {pay.rows.filter(r => r.percent !== undefined).length} งวด —
              แก้ราคาขายแล้ว <b>ยอดในงวดที่ออกไปแล้วจะไม่เปลี่ยนตาม</b> (ตรึงไว้ให้ตรงกับเอกสารจริง)
              ถ้าต้องการให้คิดตามราคาใหม่ ต้องเข้าไปกด "แก้" งวดนั้นแล้วบันทึกซ้ำเอง
            </div>
          )}
          <BudgetFields
            sale={editForm.salePrice} costs={editCosts}
            onSale={v => setEditForm({ ...editForm, salePrice: v })}
            onCosts={setEditCosts}
          />
        </Modal>
      )}

      {/* งวดเงิน (0044) — เพิ่ม/แก้ · ใส่ % ให้ระบบคำนวณ หรือกรอกยอดเงินตรงๆ
          0076: แนบเอกสารได้ในโมดัลเดียวกัน — ไฟล์ที่เลือกจะถูกอัปโหลด "หลัง" บันทึกงวดสำเร็จ
          เพราะงวดใหม่ยังไม่มี id ให้ผูกไฟล์จนกว่าจะบันทึก */}
      {payForm && (() => {
        const pct = toBudgetNum(payForm.percent)
        const preview = pct !== undefined && job.budgetSalePrice !== undefined
          ? Math.round(job.budgetSalePrice * pct) / 100
          : toBudgetNum(payForm.amount)
        const attached = payForm.id ? paymentFiles(db, payForm.id) : []
        const maxMb = isDemo ? DEMO_MAX_DOC_FILE_MB : MAX_DOC_FILE_MB

        // อัปโหลดไฟล์ที่ staged ไว้ทีละไฟล์ · คืนไฟล์ที่ยังไม่สำเร็จ (ค้างไว้ให้ลองใหม่ ไม่หายเงียบ)
        const uploadStaged = async (paymentId: string): Promise<File[]> => {
          const failed: File[] = []
          for (const f of payForm.files) {
            try {
              const filePath = supabase
                ? await uploadPaymentDoc(supabase, paymentId, f)
                : await readAsDataUrl(f)               // demo — เก็บเนื้อไฟล์ตรง ๆ
              await act.addPaymentFile({
                paymentId, fileName: f.name, filePath, mimeType: f.type, sizeBytes: f.size,
              })
            } catch (err) {
              failed.push(f)
              show(err instanceof Error ? err.message : `แนบ ${f.name} ไม่สำเร็จ`, true)
            }
          }
          return failed
        }

        return (
          <Modal
            title={`${payForm.id ? 'แก้' : 'เพิ่ม'}งวด ${PAYMENT_TYPE_LABEL[payForm.payType]} — ${job.jobNo}`}
            size="wide"
            onClose={() => setPayForm(null)}
            footer={<>
              <button onClick={() => setPayForm(null)}>ยกเลิก</button>
              <button className="primary" disabled={uploading} onClick={async () => {
                const payload = {
                  invoiceNo: payForm.invoiceNo, invoiceDate: payForm.invoiceDate,
                  percent: pct, amount: pct !== undefined ? undefined : toBudgetNum(payForm.amount),
                  paidAt: payForm.paidAt, note: payForm.note,
                }
                // บันทึกงวดก่อนเสมอ — ได้ id มาแล้วค่อยผูกไฟล์
                let paymentId = payForm.id
                const saved = await tryAction(
                  async () => {
                    if (payForm.id) await act.updateJobPayment({ paymentId: payForm.id, ...payload })
                    else paymentId = await act.addJobPayment({ jobId: job.id, payType: payForm.payType, ...payload })
                  },
                  payForm.files.length > 0
                    ? (payForm.id ? 'แก้งวดเงินแล้ว — กำลังแนบเอกสาร' : 'บันทึกงวดเงินแล้ว — กำลังแนบเอกสาร')
                    : (payForm.id ? 'แก้งวดเงินแล้ว' : 'บันทึกงวดเงินแล้ว'),
                )
                if (!saved) return
                if (payForm.files.length === 0 || !paymentId) { setPayForm(null); return }

                setUploading(true)
                const failed = await uploadStaged(paymentId)
                setUploading(false)
                if (failed.length === 0) {
                  show(`แนบเอกสารแล้ว ${payForm.files.length} ไฟล์`)
                  setPayForm(null)
                } else {
                  // งวดถูกบันทึกไปแล้ว — คงโมดัลไว้ในโหมด "แก้" ของงวดนั้น ไม่งั้นกดบันทึกซ้ำจะได้งวดซ้ำ
                  setPayForm({ ...payForm, id: paymentId, files: failed })
                  show(`แนบไม่สำเร็จ ${failed.length} ไฟล์ — งวดเงินถูกบันทึกแล้ว ลองแนบใหม่ได้`, true)
                }
              }}>{uploading ? 'กำลังแนบเอกสาร…' : 'บันทึก'}</button>
            </>}
          >
            <div className="muted" style={{ marginBottom: 12 }}>
              ราคาขายตามสัญญา <b>{fmtBaht(job.budgetSalePrice)}</b> · ใส่ % แล้วระบบคำนวณยอดให้
              (ถ้าไม่ใส่ % ให้กรอกยอดเงินตรงๆ) · ยอดที่บันทึกจะถูก <b>ตรึงไว้</b> ตามราคาขาย ณ วันนี้ ให้ตรงกับใบแจ้งหนี้จริง
            </div>
            <div className="row">
              <label className="field"><span>Invoice No.</span>
                <input className="mono" value={payForm.invoiceNo}
                  onChange={e => setPayForm({ ...payForm, invoiceNo: e.target.value })} placeholder="INV-2026-0001" />
              </label>
              <label className="field"><span>Invoice Date</span>
                <input type="date" value={payForm.invoiceDate}
                  onChange={e => setPayForm({ ...payForm, invoiceDate: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label className="field"><span>% ของราคาขาย</span>
                <input type="number" min={0} max={100} step="0.01" value={payForm.percent}
                  onChange={e => setPayForm({ ...payForm, percent: e.target.value })} placeholder="15" />
              </label>
              <label className="field"><span>หรือกรอกยอดเงิน (฿)</span>
                <input type="number" min={0} value={payForm.amount} disabled={pct !== undefined}
                  onChange={e => setPayForm({ ...payForm, amount: e.target.value })}
                  placeholder={pct !== undefined ? 'คำนวณจาก % ให้แล้ว' : '720000'} />
              </label>
            </div>
            <div className="budget-legend">ยอดที่จะบันทึก: {fmtBaht(preview)}</div>
            <div className="row">
              <label className="field"><span>รับเงินแล้วเมื่อ (เว้นว่าง = รอรับเงิน)</span>
                <input type="date" value={payForm.paidAt}
                  onChange={e => setPayForm({ ...payForm, paidAt: e.target.value })} />
              </label>
              <label className="field"><span>หมายเหตุ</span>
                <input value={payForm.note} onChange={e => setPayForm({ ...payForm, note: e.target.value })} />
              </label>
            </div>

            {/* ---------- เอกสารแนบของงวดนี้ (0076) ---------- */}
            <div className="budget-legend">เอกสารแนบของงวดนี้</div>
            <div className="muted" style={{ marginBottom: 8 }}>
              ใบแจ้งหนี้ · ใบเสร็จ/ใบกำกับภาษี · หนังสือรับรองผลงาน (PAC) · สำเนาโอนเงิน —
              รับ <b>PDF และรูปภาพ</b> ไม่เกิน <b>{maxMb} MB</b>/ไฟล์
              {isDemo
                ? <><br />⚠️ โหมด Demo เก็บไฟล์ไว้ในเบราว์เซอร์ (localStorage) จึงจำกัดที่ {DEMO_MAX_DOC_FILE_MB} MB — ระบบจริงได้ถึง {MAX_DOC_FILE_MB} MB</>
                : <><br />ไฟล์เก็บใน storage แบบปิด — เปิดได้เฉพาะคนที่ล็อกอิน และลิงก์หมดอายุใน 5 นาที</>}
            </div>

            {attached.length > 0 && (
              <div className="table-scroll" style={{ marginBottom: 10 }}>
                <table>
                  <thead><tr><th>ไฟล์ที่แนบแล้ว</th><th style={{ textAlign: 'right' }}>ขนาด</th><th>แนบเมื่อ</th><th>โดย</th><th></th></tr></thead>
                  <tbody>
                    {attached.map(f => (
                      <tr key={f.id}>
                        <td>
                          <button className="small" title="เปิดไฟล์" onClick={async () => {
                            try {
                              // LIVE: ขอ signed URL ใหม่ทุกครั้ง (ลิงก์หมดอายุ) · demo: filePath คือ data URL อยู่แล้ว
                              const url = supabase ? await signedPaymentDocUrl(supabase, f.filePath) : f.filePath
                              window.open(url, '_blank', 'noopener')
                            } catch (err) {
                              show(err instanceof Error ? err.message : 'เปิดไฟล์ไม่ได้', true)
                            }
                          }}>{f.mimeType === 'application/pdf' ? '📄' : '🖼️'} {f.fileName}</button>
                        </td>
                        <td style={{ textAlign: 'right' }}>{Math.max(1, Math.round(f.sizeBytes / 1024)).toLocaleString('th-TH')} KB</td>
                        <td className="muted">{fmtDateTime(f.uploadedAt)}</td>
                        <td className="muted">{userOf(f.uploadedBy)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {canPay && (
                            <button className="small danger" onClick={async () => {
                              if (!await askConfirm({
                                title: `ลบเอกสาร "${f.fileName}"`,
                                description: <>ลบแล้วกู้คืนไม่ได้ · <b>มีผลทันที</b> ไม่ต้องกดบันทึก · การลบถูกบันทึกใน Audit Log</>,
                                confirmLabel: 'ลบเอกสาร',
                              })) return
                              if (await tryAction(() => act.deletePaymentFile({ fileId: f.id }), 'ลบเอกสารแล้ว')) {
                                // ลบแถวสำเร็จก่อน แล้วค่อยเก็บกวาดไฟล์จริง — ล้มเหลวก็แค่เหลือไฟล์กำพร้า
                                if (supabase) await removePaymentDocs(supabase, [f.filePath])
                              }
                            }}>ลบ</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {canPay && (
              <label className="field">
                <span>เพิ่มเอกสาร (เลือกได้หลายไฟล์ — แนบจริงเมื่อกด "บันทึก")</span>
                <input type="file" multiple accept="application/pdf,image/*" disabled={uploading}
                  onChange={e => {
                    const picked = [...(e.target.files ?? [])]
                    e.target.value = ''                    // ให้เลือกไฟล์ชื่อเดิมซ้ำได้
                    const ok: File[] = []
                    for (const f of picked) {
                      // เช็คตั้งแต่ตอนเลือก ไม่รอตอนกดบันทึก — ผู้ใช้จะได้แก้ทันทีขณะยังอยู่หน้าเดิม
                      if (f.size > maxMb * 1024 * 1024) { show(`${f.name}: ไฟล์ใหญ่เกิน ${maxMb} MB`, true); continue }
                      if (!isAllowedDocFile(f.type)) { show(`${f.name}: รับเฉพาะ PDF และรูปภาพ`, true); continue }
                      ok.push(f)
                    }
                    if (ok.length > 0) setPayForm({ ...payForm, files: [...payForm.files, ...ok] })
                  }} />
              </label>
            )}
            {payForm.files.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div className="muted" style={{ marginBottom: 4 }}>รอแนบเมื่อกดบันทึก ({payForm.files.length} ไฟล์):</div>
                {payForm.files.map((f, i) => (
                  <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span>{f.type === 'application/pdf' ? '📄' : '🖼️'} {f.name}</span>
                    <span className="muted">{Math.max(1, Math.round(f.size / 1024)).toLocaleString('th-TH')} KB</span>
                    <button className="small" disabled={uploading}
                      onClick={() => setPayForm({ ...payForm, files: payForm.files.filter((_, j) => j !== i) })}>เอาออก</button>
                  </div>
                ))}
              </div>
            )}
          </Modal>
        )
      })()}
      {/* ขยาย/แก้กำหนดส่ง (0075) — requiredDate เดิมไม่ถูกแตะ เก็บเป็นประวัติแยก */}
      {dueForm && (() => {
        const newDue = dueForm.newDueDate
        const diff = delivery.contractDue && newDue ? daysBetweenIso(delivery.contractDue, newDue) : undefined
        return (
          <Modal
            title={`ขยาย/แก้กำหนดส่ง — ${job.jobNo}`}
            onClose={() => setDueForm(null)}
            footer={<>
              <button onClick={() => setDueForm(null)}>ยกเลิก</button>
              <button className="primary" disabled={!newDue || !dueForm.reason.trim()}
                onClick={async () => {
                  if (await tryAction(
                    () => act.extendJobDue({ jobId: job.id, newDueDate: newDue, reason: dueForm.reason }),
                    'บันทึกกำหนดส่งใหม่แล้ว',
                  )) setDueForm(null)
                }}>บันทึกกำหนดใหม่</button>
            </>}
          >
            <div className="muted" style={{ marginBottom: 12 }}>
              ใช้เมื่อ <b>ตกลงเลื่อนวันส่งมอบกับลูกค้าแล้ว</b> — ระบบจะนับ "เลยกำหนด" จากวันใหม่
              แต่ยัง<b>เก็บกำหนดตามสัญญาเดิมไว้</b> ({delivery.contractDue ? fmtDate(delivery.contractDue) : 'ไม่ได้ระบุ'})
              และบันทึกทุกครั้งที่เลื่อนไว้เป็นประวัติ — จำนวนครั้งและเหตุผลคือหลักฐานตอนเคลมค่าปรับ/ต่อสัญญา
            </div>
            <div className="row">
              <label className="field"><span>กำหนดส่งใหม่ *</span>
                <input type="date" value={dueForm.newDueDate}
                  onChange={e => setDueForm({ ...dueForm, newDueDate: e.target.value })} />
              </label>
              <label className="field"><span>กำหนดที่มีผลตอนนี้</span>
                <input value={delivery.due ? fmtDate(delivery.due) : 'ยังไม่ระบุ'} disabled />
              </label>
            </div>
            {diff !== undefined && (
              <div className="budget-legend">
                {diff >= 0
                  ? `ช้ากว่าสัญญาเดิมรวม ${diff} วัน`
                  : `เร็วกว่าสัญญาเดิม ${-diff} วัน`}
              </div>
            )}
            <label className="field"><span>เหตุผล * (ใครขอเลื่อน เพราะอะไร)</span>
              <textarea rows={3} value={dueForm.reason}
                onChange={e => setDueForm({ ...dueForm, reason: e.target.value })}
                placeholder="เช่น ลูกค้าขอเลื่อนดับไฟเป็นสัปดาห์ถัดไป (หนังสือ PEA ที่ ... ลว. ...)" />
            </label>
          </Modal>
        )
      })()}
      {promptEl}
      {confirmEl}
    </>
  )
}
