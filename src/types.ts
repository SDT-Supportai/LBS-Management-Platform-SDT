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
  notes?: string
  // ข้อมูลลูกค้า (optional — เว้นว่าง = คลังกลางยังไม่ผูกลูกค้า) แก้ไขภายหลังได้
  customerName?: string
  contactPhone?: string
  installLocation?: string
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
  // ข้อมูลลูกค้ารายเครื่อง (optional) — เว้นว่าง = ใช้ค่าของคลัง (fallback), แก้ได้จนกว่าเครื่องถูกเบิก
  customerName?: string
  contactPhone?: string
  installLocation?: string
}

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
  requiredDate: string
  lbsQtyRequired: number
  // Project Budget (บาท) — กำไร derive = ราคาขาย − ต้นทุน (ไม่เก็บซ้ำ)
  budgetSalePrice?: number
  budgetCost?: number
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
  unitPrice?: number           // ราคาต่อหน่วย (บาท) → มูลค่าวัสดุ = unitPrice × qtyRequested
  phaseBudget?: string         // รหัส Phase Budget (อ้างอิงงบประมาณภายใน) — กรอกตอนขอวัสดุ
  source: 'central_stock' | 'purchasing'
  status: AccReqStatus
  prId: string | null
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
  auditLogs: AuditLog[]
  notifications: AppNotification[]
}

export interface AppSettings {
  lineEnabled: boolean
  lineEndpoint: string     // เช่น /.netlify/functions/line-notify
  lineGroupNote: string    // บันทึกช่วยจำว่าผูกกับกลุ่มไหน (ค่า group id จริงอยู่ฝั่ง server env)
}
