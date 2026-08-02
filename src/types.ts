export type Department = 'sales' | 'project' | 'purchasing' | 'service' | 'admin'

export interface User {
  id: string
  email: string
  password: string
  fullName: string
  department: Department
  isActive: boolean
}

export interface Item {
  id: string
  code: string
  epicorCode?: string          // รหัส Epicor (อ้างอิงระบบ ERP) — accessory catalog
  name: string
  itemType: 'main_equipment' | 'accessory'
  uom: string
  stockableCentrally: boolean
}

export interface ProjectStock {
  id: string
  stockNo: string
  itemId: string
  status: 'open' | 'closed'
  poNo?: string                // PO No. อ้างอิงการสั่งซื้อ LBS เข้าคลัง (ว่างได้ · แก้ภายหลังได้)
  notes?: string               // Remark (ว่างได้ · แก้ภายหลังได้)
  createdBy: string
  createdAt: string
}

export type LbsUnitStatus = 'in_stock' | 'allocated' | 'issued'

export interface LbsUnit {
  id: string
  serialLvb: string            // Serial No. ของตัว LBS (บังคับ, unique)
  serialOm: string             // Serial No. ของ OM (Operating Mechanism) (บังคับ, unique)
  projectStockId: string
  status: LbsUnitStatus
  jobId: string | null
  unitCost?: number            // ต้นทุนตัว LBS ต่อเครื่อง (บาท) — กรอกตอนสร้าง/รับเข้า Stock
                               // ดึงเข้า Job → บวกเข้า actual หมวด Raw Material (jobBudgetSummary)
  // ข้อมูลลูกค้า/สถานที่ ref จาก Job ที่เครื่องถูกดึงเข้า (single source of truth — ไม่เก็บซ้ำที่นี่)
}

// Project Budget — ต้นทุนแยก 7 หมวด (0021)
// raw_mat/outsourcing: actual มาจากมูลค่าวัสดุใน PR/PO ที่ตัดเข้าหมวดนั้น
// trans/eng/ove/pm/fin: actual กรอกเอง
export type CostCategoryKey = 'raw_mat' | 'outsourcing' | 'trans' | 'eng' | 'ove' | 'pm' | 'fin'
export interface CostCategory {
  budget?: number   // งบประมาณที่ตั้งไว้ (บาท)
  phase?: string    // รหัส Phase Budget (อ้างอิงบัญชี)
  actual?: number   // ต้นทุนใช้จริง — เฉพาะ 5 หมวด manual (trans/eng/ove/pm/fin)
}
export type BudgetCosts = Partial<Record<CostCategoryKey, CostCategory>>

export type JobStatus =
  | 'draft'
  | 'allocated'
  | 'procuring_accessory'
  | 'ready_to_issue'
  | 'issued'
  | 'installed'
  | 'cancelled'

export interface Job {
  id: string
  jobNo: string
  customerName: string
  scope: string
  installLocation: string
  requiredDate: string         // จุดติดตั้งที่ 1 (หลัก) — ทุกหน้าที่แสดง "สถานที่/กำหนด" ใช้คู่นี้
  lbsQtyRequired: number
  // จุดติดตั้งเพิ่มเติม (จุดที่ 2+) — ใช้ได้เมื่อ Job มี LBS > 1 · ข้อมูลวางแผนอย่างเดียว (ไม่ผูก Serial)
  installSites?: { location: string; requiredDate: string }[]
  contactPhone?: string        // เบอร์ติดต่อลูกค้า — ตารางรายเครื่องใน Project Stock ref ค่านี้
  // Project Budget (บาท) — กำไร derive = ราคาขาย − ต้นทุน (ไม่เก็บซ้ำ)
  budgetSalePrice?: number
  budgetCost?: number          // ต้นทุนรวม = Σ งบ 7 หมวด (คำนวณฝั่ง server จาก budgetCosts)
  budgetCosts?: BudgetCosts    // ต้นทุนแยก 7 หมวด (0021)
  // lifecycle marker: null = ยัง active (derive สถานะจากข้อมูล), issued = เบิกแล้วรอติดตั้ง,
  // installed / cancelled = terminal จริง
  terminalStatus: 'issued' | 'installed' | 'cancelled' | null
  openedBy: string
  createdAt: string
  issuedAt?: string
  issuedNote?: string
  // นัดหมายติดตั้งจริง — กรอกตอนเบิกให้ Service (แยกจาก requiredDate/installLocation ที่เป็นแผนตอนเปิด Job)
  installStartDate?: string
  installEndDate?: string
  issueLocation?: string
  installedAt?: string        // วันที่ติดตั้งจริง (Service ยืนยัน)
  installNote?: string
  installConfirmedBy?: string
  // Check-in หน้างานตอนยืนยันติดตั้ง (บังคับ — 0019)
  installCheckinLat?: number
  installCheckinLng?: number
  installPhotoUrl?: string
  cancelledAt?: string
  cancelledBy?: string
  cancelReason?: string
}

export interface AllocationTxn {
  id: string
  jobId: string
  projectStockId: string
  txnType: 'draw' | 'return'
  serialNos: string[]
  performedBy: string
  performedAt: string
  note?: string
}

export interface AccessoryStockRow {
  itemId: string
  qtyOnHand: number
  avgUnitCost?: number         // ต้นทุนถัวเฉลี่ยต่อหน่วย (moving average) — ใช้ตีราคาตอนเบิกเข้า Job
}

// บัญชีเดินสะพัดของคลังคงเหลือ (เฟส S1) — ทุกการเปลี่ยนยอดต้องมีแถวที่นี่
// qty เป็นบวก = เข้าคลัง · ลบ = ออกจากคลัง · balanceAfter = ยอดหลังรายการนี้
export type StockMovementType =
  | 'initial'          // ตั้งยอดเริ่มต้นตอนสร้างวัสดุ
  | 'adjust'           // ปรับยอดด้วยมือ (ต้องมีเหตุผล)
  | 'import_adjust'    // ปรับยอดจากการนำเข้า Excel (เฟส S3)
  | 'issue_to_job'     // เบิกเข้า Job
  | 'return_from_job'  // คืนของที่เบิกไปกลับคลัง
  | 'transfer_from_job'// โอนวัสดุเหลือจาก Job เข้าคลัง (ของที่ซื้อผ่าน PO ก็โอนได้)
  | 'job_cancelled'    // Job ถูกยกเลิก แล้วนำของเข้าคลัง

export interface StockMovement {
  id: string
  itemId: string
  qty: number                  // + เข้า / − ออก
  unitCost?: number            // ต้นทุนต่อหน่วยของรายการนี้
  balanceAfter: number
  type: StockMovementType
  refJobId?: string            // Job ต้นทาง/ปลายทาง
  refRequestId?: string        // line วัสดุที่เกี่ยวข้อง
  note?: string
  performedBy: string
  performedAt: string
}

export type AccReqStatus =
  | 'pending'
  | 'issued'
  | 'pr_sent'
  | 'po_ordered'
  | 'received'
  | 'returned'
  | 'cancelled'

export interface AccessoryRequest {
  id: string
  jobId: string
  itemId: string
  qtyRequested: number
  qtyReceived: number          // สำหรับ partial receive ฝั่ง purchasing
  qtyTransferred?: number      // จำนวนที่โอนคืนเข้าคลังคงเหลือแล้ว (เฟส S1)
                               // ต้นทุนที่ตัดเข้า Job = unitPrice × (qtyRequested − qtyTransferred)
  unitPrice?: number           // ราคาต่อหน่วย (บาท) → มูลค่าวัสดุ = unitPrice × qtyRequested
  phaseBudget?: string         // รหัส Phase Budget (อ้างอิงงบประมาณภายใน) — กรอกตอนขอวัสดุ
  source: 'central_stock' | 'purchasing'
  status: AccReqStatus
  prId: string | null
  poId?: string | null         // PO ที่สั่ง line นี้ (1 PR → หลาย PO, 0022)
  requestedBy: string
  createdAt: string
}

export interface PurchaseRequisition {
  id: string
  prNo: string
  jobId: string
  status: 'pending' | 'po_issued' | 'received' | 'rejected' | 'cancelled'
  requestIds: string[]
  rejectReason?: string
  rejectedAt?: string
  createdBy: string
  createdAt: string
}

export interface PurchaseOrder {
  id: string
  poNo: string
  prId: string
  jobId: string
  supplierName: string
  expectedDate: string
  status: 'issued' | 'received' | 'cancelled'
  createdBy: string
  createdAt: string
  receivedAt?: string
}

// คำขออนุมัติจาก Division (dept ใน DB = 'sales', แสดงผลเป็น "Division")
// project ขอ → division/admin อนุมัติ (execute ทันที) หรือตีกลับพร้อมเหตุผล
export type ApprovalType = 'create_pr' | 'issue_job' | 'cancel_job' | 'swap_lbs'

export interface ApprovalPayload {
  requestIds?: string[]            // create_pr
  startDate?: string               // issue_job
  endDate?: string
  location?: string
  note?: string
  reason?: string                  // cancel_job / swap_lbs (เหตุผลการสลับ)
  receivedToCentral?: boolean
  // swap_lbs: สลับเลข Serial (LVB+OM) ระหว่างเครื่องที่ดึงเข้า Job (allocated) กับเครื่องในคลัง (in_stock)
  swapAllocatedUnitId?: string     // เครื่องบน Job ที่จะรับเลขใหม่
  swapStockUnitId?: string         // เครื่องในคลังที่จะเอาเลขมาสลับ (คงอยู่ในคลัง)
}

export interface ApprovalRequest {
  id: string
  type: ApprovalType
  jobId: string
  payload: ApprovalPayload
  status: 'pending' | 'approved' | 'rejected'
  requestedBy: string
  requestedAt: string
  decidedBy?: string
  decidedAt?: string
  rejectReason?: string
}

export interface AuditLog {
  id: string
  entityType: string
  entityId: string
  action: string
  actorId: string
  detail: string
  createdAt: string
}

export type LineStatus = 'off' | 'pending' | 'sent' | 'failed'

export interface AppNotification {
  id: string
  createdAt: string
  type: string                          // 'pr_created' | 'pr_rejected' | 'po_created' | ...
  message: string
  dept: Department | 'all'              // แผนกผู้รับ
  jobId?: string
  readBy: string[]                      // user ids ที่อ่านแล้ว
  lineStatus: LineStatus                // สถานะส่งเข้า LINE group
}

// ทะเบียนทีมช่างติดตั้ง — เฟส C
// แยกจาก User เพราะ profiles.id อ้าง auth.users (ต้องมีบัญชี login) และไม่มีฟิลด์เบอร์/ตำแหน่ง
// ช่างภาคสนาม/outsource จึงใส่เป็น user ไม่ได้ · userId ผูกบัญชีให้คนที่มี login (optional)
export interface TeamMember {
  id: string
  firstName: string
  lastName: string
  phone: string
  position: string             // free text — หัวหน้าช่าง / ช่างไฟฟ้า / ผู้ช่วยช่าง ฯลฯ
  userId?: string              // ผูกกับบัญชีในระบบ (ถ้าช่างคนนั้นมี login)
  isActive: boolean
  createdAt: string
}

// มอบหมายทีมให้ Job (หลายคนต่องาน · 1 คนเป็นหัวหน้าทีม)
// เป็น "แผนงาน" ไม่ใช่ "สิทธิ์" — ไม่บล็อกการยืนยันติดตั้ง (RPC ตรวจสิทธิ์จากแผนกตามเดิม)
export interface JobAssignment {
  id: string
  jobId: string
  memberId: string
  isLead: boolean
  assignedBy: string
  assignedAt: string
}

// ยืนยันติดตั้ง "รายเครื่อง" (per LBS serial) — เฟส B
// เก็บเป็น log (หลายแถวต่อเครื่องได้) → สถานะปัจจุบันของเครื่อง = แถวล่าสุด
// ทำให้ blocked → ยืนยันใหม่ได้ และเก็บประวัติครบ
// หมายเหตุ: ไม่เก็บบน lbs_units เพราะ trigger trg_block_issued_edit ล็อก UPDATE ตอน job = issued
export type UnitInstallOutcome = 'installed' | 'blocked'
export interface UnitInstallation {
  id: string
  unitId: string
  jobId: string
  outcome: UnitInstallOutcome
  installedDate?: string       // installed: วันที่ติดตั้งจริง (บังคับ)
  reason?: string              // blocked: เหตุผลที่ติดตั้งไม่ได้ (บังคับ)
  checkinLat?: number          // installed: บังคับ (หลักฐานต่อเครื่อง)
  checkinLng?: number
  photoUrl?: string            // installed: บังคับ
  installedByMemberId?: string // ช่างที่ลงมือติดตั้งเครื่องนี้ (เฟส C) — แยกจาก performedBy ที่เป็น user ผู้บันทึก
  note?: string
  performedBy: string
  performedAt: string
}

// บันทึกการออกหน้างานที่ "ยังไม่จบ" — เลื่อนนัด หรือ ติดปัญหา (Job ยังอยู่ issued)
// path สำเร็จใช้ confirmInstall แยกต่างหาก — ที่นี่เก็บเฉพาะ attempt ที่ทำไม่สำเร็จ/ต้องเลื่อน
export type SiteVisitOutcome = 'rescheduled' | 'failed'
export interface SiteVisit {
  id: string
  jobId: string
  outcome: SiteVisitOutcome
  reason: string
  newStartDate?: string        // เฉพาะ rescheduled — นัดใหม่ (อัปเดต installStartDate/EndDate ของ Job ด้วย)
  newEndDate?: string
  performedBy: string
  performedAt: string
}

export interface DB {
  users: User[]
  items: Item[]
  projectStocks: ProjectStock[]
  lbsUnits: LbsUnit[]
  jobs: Job[]
  allocations: AllocationTxn[]
  accessoryStock: AccessoryStockRow[]
  accessoryRequests: AccessoryRequest[]
  prs: PurchaseRequisition[]
  pos: PurchaseOrder[]
  approvalRequests: ApprovalRequest[]
  auditLogs: AuditLog[]
  notifications: AppNotification[]
  siteVisits: SiteVisit[]
  unitInstallations: UnitInstallation[]
  teamMembers: TeamMember[]
  jobAssignments: JobAssignment[]
  stockMovements: StockMovement[]
}

export interface AppSettings {
  lineEnabled: boolean
  lineEndpoint: string     // เช่น /.netlify/functions/line-notify
  lineGroupNote: string    // บันทึกช่วยจำว่าผูกกับกลุ่มไหน (ค่า group id จริงอยู่ฝั่ง server env)
}
