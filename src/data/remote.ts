import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  DB, User, Item, ProjectStock, LbsUnit, Job, AllocationTxn,
  AccessoryRequest, PurchaseRequisition, PurchaseOrder, AuditLog, AppNotification,
  Department,
} from '../types'

// ---------------------------------------------------------------
// Supabase adapter: โหลดข้อมูลทั้งชุดเป็น DB shape เดียวกับ demo mode
// (ข้อมูลระดับร้อย row — โหลดรวมได้สบาย ทำให้ UI ใช้โค้ดชุดเดียว)
// ทุก action เรียก RPC ที่คุม business rule ฝั่ง server
// ---------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

function mapUser(r: Row): User {
  return {
    id: r.id, email: r.email, password: '', fullName: r.full_name,
    department: r.department as Department, isActive: r.is_active,
  }
}
function mapItem(r: Row): Item {
  return {
    id: r.id, code: r.code, epicorCode: r.epicor_code ?? undefined, name: r.name, itemType: r.item_type,
    uom: r.uom, stockableCentrally: r.is_stockable_centrally,
  }
}
function mapStock(r: Row): ProjectStock {
  return {
    id: r.id, stockNo: r.stock_no, itemId: r.item_id, status: r.status,
    notes: r.notes ?? undefined, createdBy: r.created_by ?? '', createdAt: r.created_at,
  }
}
function mapUnit(r: Row): LbsUnit {
  return { id: r.id, serialLvb: r.serial_lvb, serialOm: r.serial_om ?? '', projectStockId: r.project_stock_id, status: r.status, jobId: r.job_id }
}
function mapJob(r: Row): Job {
  return {
    id: r.id, jobNo: r.job_no, customerName: r.customer_name, scope: r.scope ?? '',
    installLocation: r.install_location ?? '', requiredDate: r.required_date ?? '',
    lbsQtyRequired: r.lbs_qty_required, terminalStatus: r.terminal_status,
    budgetSalePrice: r.budget_sale_price != null ? Number(r.budget_sale_price) : undefined,
    budgetCost: r.budget_cost != null ? Number(r.budget_cost) : undefined,
    openedBy: r.opened_by ?? '', createdAt: r.created_at,
    issuedAt: r.issued_at ?? undefined, issuedNote: r.issued_note ?? undefined,
    installStartDate: r.install_start_date ?? undefined,
    installEndDate: r.install_end_date ?? undefined,
    issueLocation: r.issue_location ?? undefined,
    installedAt: r.installed_at ?? undefined, installNote: r.install_note ?? undefined,
    installConfirmedBy: r.install_confirmed_by ?? undefined,
    cancelledAt: r.cancelled_at ?? undefined, cancelledBy: r.cancelled_by ?? undefined,
    cancelReason: r.cancel_reason ?? undefined,
  }
}
function mapAlloc(r: Row): AllocationTxn {
  return {
    id: r.id, jobId: r.job_id, projectStockId: r.project_stock_id, txnType: r.txn_type,
    serialNos: r.serial_nos ?? [], performedBy: r.performed_by ?? '',
    performedAt: r.performed_at, note: r.reference_note ?? undefined,
  }
}
function mapAccReq(r: Row): AccessoryRequest {
  return {
    id: r.id, jobId: r.job_id, itemId: r.item_id,
    qtyRequested: Number(r.qty_requested), qtyReceived: Number(r.qty_received),
    unitPrice: r.unit_price != null ? Number(r.unit_price) : undefined,
    phaseBudget: r.phase_budget ?? undefined,
    source: r.source, status: r.status, prId: r.pr_id,
    requestedBy: r.requested_by ?? '', createdAt: r.created_at,
  }
}
function mapPr(r: Row, requestIds: string[]): PurchaseRequisition {
  return {
    id: r.id, prNo: r.pr_no, jobId: r.job_id, status: r.status, requestIds,
    rejectReason: r.reject_reason ?? undefined, rejectedAt: r.rejected_at ?? undefined,
    createdBy: r.created_by ?? '', createdAt: r.created_at,
  }
}
function mapPo(r: Row): PurchaseOrder {
  return {
    id: r.id, poNo: r.po_no, prId: r.pr_id, jobId: r.job_id,
    supplierName: r.supplier_name ?? '', expectedDate: r.expected_date ?? '',
    status: r.status, createdBy: r.created_by ?? '', createdAt: r.created_at,
    receivedAt: r.received_at ?? undefined,
  }
}
function mapAudit(r: Row): AuditLog {
  return {
    id: r.id, entityType: r.entity_type, entityId: r.entity_id, action: r.action,
    actorId: r.actor_id ?? '', detail: r.detail ?? '', createdAt: r.created_at,
  }
}
function mapNotif(r: Row, readBy: string[]): AppNotification {
  return {
    id: r.id, createdAt: r.created_at, type: r.type, message: r.message,
    dept: r.dept, jobId: r.job_id ?? undefined, readBy, lineStatus: r.line_status,
  }
}

async function q(sb: SupabaseClient, table: string, order?: { col: string; asc?: boolean; limit?: number }) {
  let query = sb.from(table).select('*')
  if (order) query = query.order(order.col, { ascending: order.asc ?? true }).limit(order.limit ?? 5000)
  const { data, error } = await query
  if (error) throw new Error(`โหลด ${table} ไม่สำเร็จ: ${error.message}`)
  return data as Row[]
}

export async function loadAll(sb: SupabaseClient): Promise<DB> {
  const [profiles, items, stocks, units, jobs, allocs, accStock, accReqs, prs, pos, audits, notifs, reads] =
    await Promise.all([
      q(sb, 'profiles'),
      q(sb, 'items'),
      q(sb, 'project_stocks', { col: 'created_at' }),
      q(sb, 'lbs_units', { col: 'serial_lvb' }),
      q(sb, 'jobs', { col: 'created_at' }),
      q(sb, 'stock_allocations', { col: 'performed_at' }),
      q(sb, 'accessory_stock'),
      q(sb, 'job_accessory_requests', { col: 'created_at' }),
      q(sb, 'purchase_requisitions', { col: 'created_at' }),
      q(sb, 'purchase_orders', { col: 'created_at' }),
      q(sb, 'audit_logs', { col: 'created_at', asc: false, limit: 500 }),
      q(sb, 'notifications', { col: 'created_at', asc: true, limit: 300 }),
      q(sb, 'notification_reads'),
    ])

  const readsByNotif = new Map<string, string[]>()
  reads.forEach(r => {
    const arr = readsByNotif.get(r.notification_id) ?? []
    arr.push(r.user_id)
    readsByNotif.set(r.notification_id, arr)
  })
  const reqIdsByPr = new Map<string, string[]>()
  accReqs.forEach(r => {
    if (!r.pr_id) return
    const arr = reqIdsByPr.get(r.pr_id) ?? []
    arr.push(r.id)
    reqIdsByPr.set(r.pr_id, arr)
  })

  return {
    users: profiles.map(mapUser),
    items: items.map(mapItem),
    projectStocks: stocks.map(mapStock),
    lbsUnits: units.map(mapUnit),
    jobs: jobs.map(mapJob),
    allocations: allocs.map(mapAlloc),
    accessoryStock: accStock.map(r => ({ itemId: r.item_id, qtyOnHand: Number(r.qty_on_hand) })),
    accessoryRequests: accReqs.map(mapAccReq),
    prs: prs.map(r => mapPr(r, reqIdsByPr.get(r.id) ?? [])),
    pos: pos.map(mapPo),
    auditLogs: audits.map(mapAudit),
    notifications: notifs.map(r => mapNotif(r, readsByNotif.get(r.id) ?? [])),
  }
}

async function rpc(sb: SupabaseClient, fn: string, params: Record<string, unknown>): Promise<void> {
  const { error } = await sb.rpc(fn, params)
  if (error) throw new Error(error.message)
}

// map action ชื่อเดียวกับ demo mode → RPC ฝั่ง server
export function remoteActions(sb: SupabaseClient) {
  return {
    createProjectStock: (p: { stockNo: string; itemId: string; units: { lvb: string; om: string }[]; notes?: string }) =>
      rpc(sb, 'rpc_create_project_stock', { p_stock_no: p.stockNo, p_item_id: p.itemId, p_units: p.units, p_notes: p.notes ?? null }),
    addUnitsToStock: (p: { stockId: string; units: { lvb: string; om: string }[] }) =>
      rpc(sb, 'rpc_add_units_to_stock', { p_stock_id: p.stockId, p_units: p.units }),
    updateProjectStock: (p: { stockId: string; notes: string; status: 'open' | 'closed' }) =>
      rpc(sb, 'rpc_update_project_stock', { p_stock_id: p.stockId, p_notes: p.notes, p_status: p.status }),
    deleteProjectStock: (p: { stockId: string }) =>
      rpc(sb, 'rpc_delete_project_stock', { p_stock_id: p.stockId }),
    createJob: (p: { jobNo: string; customerName: string; scope: string; installLocation: string; requiredDate: string; lbsQtyRequired: number; budgetSalePrice?: number; budgetCost?: number }) =>
      rpc(sb, 'rpc_create_job', { p_job_no: p.jobNo, p_customer: p.customerName, p_scope: p.scope, p_location: p.installLocation, p_required_date: p.requiredDate || null, p_qty: p.lbsQtyRequired, p_sale_price: p.budgetSalePrice ?? null, p_cost: p.budgetCost ?? null }),
    updateJob: (p: { jobId: string; jobNo: string; customerName: string; scope: string; installLocation: string; requiredDate: string; lbsQtyRequired: number; budgetSalePrice?: number; budgetCost?: number }) =>
      rpc(sb, 'rpc_update_job', { p_job_id: p.jobId, p_job_no: p.jobNo, p_customer: p.customerName, p_scope: p.scope, p_location: p.installLocation, p_required_date: p.requiredDate || null, p_qty: p.lbsQtyRequired, p_sale_price: p.budgetSalePrice ?? null, p_cost: p.budgetCost ?? null }),
    deleteDraftJob: (p: { jobId: string }) => rpc(sb, 'rpc_delete_draft_job', { p_job_id: p.jobId }),
    drawLbs: (p: { jobId: string; stockId: string; unitIds: string[] }) =>
      rpc(sb, 'rpc_draw_lbs', { p_job_id: p.jobId, p_stock_id: p.stockId, p_unit_ids: p.unitIds }),
    returnLbs: (p: { jobId: string; unitIds: string[]; targetStockId: string; note?: string }) =>
      rpc(sb, 'rpc_return_lbs', { p_job_id: p.jobId, p_unit_ids: p.unitIds, p_target_stock_id: p.targetStockId, p_note: p.note ?? null }),
    addAccessoryRequest: (p: { jobId: string; itemId: string; qty: number; source: 'central_stock' | 'purchasing'; unitPrice?: number; phaseBudget?: string }) =>
      rpc(sb, 'rpc_add_accessory_request', { p_job_id: p.jobId, p_item_id: p.itemId, p_qty: p.qty, p_source: p.source, p_unit_price: p.unitPrice ?? null, p_phase_budget: p.phaseBudget ?? null }),
    updateAccessoryRequestQty: (p: { requestId: string; qty: number }) =>
      rpc(sb, 'rpc_update_accessory_request_qty', { p_request_id: p.requestId, p_qty: p.qty }),
    updateAccessoryRequestPrice: (p: { requestId: string; unitPrice?: number }) =>
      rpc(sb, 'rpc_update_accessory_request_price', { p_request_id: p.requestId, p_unit_price: p.unitPrice ?? null }),
    returnAccessory: (p: { requestId: string }) => rpc(sb, 'rpc_return_accessory', { p_request_id: p.requestId }),
    cancelAccessoryRequest: (p: { requestId: string }) => rpc(sb, 'rpc_cancel_accessory_request', { p_request_id: p.requestId }),
    createPR: (p: { jobId: string; requestIds: string[] }) =>
      rpc(sb, 'rpc_create_pr', { p_job_id: p.jobId, p_request_ids: p.requestIds }),
    rejectPR: (p: { prId: string; reason: string }) => rpc(sb, 'rpc_reject_pr', { p_pr_id: p.prId, p_reason: p.reason }),
    createPO: (p: { prId: string; poNo: string; supplierName: string; expectedDate: string }) =>
      rpc(sb, 'rpc_create_po', { p_pr_id: p.prId, p_po_no: p.poNo, p_supplier: p.supplierName, p_expected_date: p.expectedDate || null }),
    receivePOItems: (p: { poId: string; receipts: { requestId: string; qty: number }[] }) =>
      rpc(sb, 'rpc_receive_po_items', { p_po_id: p.poId, p_receipts: p.receipts.map(r => ({ request_id: r.requestId, qty: r.qty })) }),
    issueJob: (p: { jobId: string; startDate: string; endDate: string; location: string; note?: string }) =>
      rpc(sb, 'rpc_issue_job', { p_job_id: p.jobId, p_start_date: p.startDate || null, p_end_date: p.endDate || null, p_location: p.location, p_note: p.note ?? null }),
    confirmInstall: (p: { jobId: string; installedDate: string; note?: string }) =>
      rpc(sb, 'rpc_confirm_install', { p_job_id: p.jobId, p_installed_date: p.installedDate, p_note: p.note ?? null }),
    cancelJob: (p: { jobId: string; reason: string; receivedAccessoryToCentral: boolean }) =>
      rpc(sb, 'rpc_cancel_job', { p_job_id: p.jobId, p_reason: p.reason, p_received_to_central: p.receivedAccessoryToCentral }),
    createItem: (p: { code: string; epicorCode?: string; name: string; uom: string; stockableCentrally: boolean; initialQty?: number }) =>
      rpc(sb, 'rpc_create_item', { p_code: p.code, p_epicor_code: p.epicorCode ?? null, p_name: p.name, p_uom: p.uom, p_stockable: p.stockableCentrally, p_initial_qty: p.initialQty ?? 0 }),
    updateItem: (p: { itemId: string; code: string; epicorCode?: string; name: string; uom: string; stockableCentrally: boolean }) =>
      rpc(sb, 'rpc_update_item', { p_item_id: p.itemId, p_code: p.code, p_epicor_code: p.epicorCode ?? null, p_name: p.name, p_uom: p.uom, p_stockable: p.stockableCentrally }),
    deleteItem: (p: { itemId: string }) => rpc(sb, 'rpc_delete_item', { p_item_id: p.itemId }),
    adjustAccessoryStock: (p: { itemId: string; newQty: number; note: string }) =>
      rpc(sb, 'rpc_adjust_accessory_stock', { p_item_id: p.itemId, p_new_qty: p.newQty, p_note: p.note }),
    // สร้าง user + เปลี่ยนรหัสผ่านต้องใช้ service role → ผ่าน netlify function
    createUser: async (p: { email: string; fullName: string; department: Department; password: string }) => {
      await callAdminFn(sb, { action: 'create', ...p })
    },
    updateUser: async (p: { userId: string; fullName: string; department: Department; password?: string; isActive: boolean }) => {
      await rpc(sb, 'rpc_update_profile', { p_user_id: p.userId, p_full_name: p.fullName, p_department: p.department, p_is_active: p.isActive })
      if (p.password) await callAdminFn(sb, { action: 'set_password', userId: p.userId, password: p.password })
    },
  }
}

async function callAdminFn(sb: SupabaseClient, body: Record<string, unknown>): Promise<void> {
  const { data: { session } } = await sb.auth.getSession()
  if (!session) throw new Error('กรุณาเข้าสู่ระบบก่อน')
  let res: Response
  try {
    res = await fetch('/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('เรียก admin function ไม่ได้ — ฟีเจอร์นี้ใช้ได้เมื่อ deploy บน Cloudflare Pages (หรือรัน wrangler pages dev)')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
}

export async function markNotificationsRead(sb: SupabaseClient): Promise<void> {
  await rpc(sb, 'rpc_mark_notifications_read', {})
}

export async function setNotificationLineStatus(sb: SupabaseClient, ids: string[], status: 'off' | 'sent' | 'failed'): Promise<void> {
  await rpc(sb, 'rpc_set_notification_line_status', { p_ids: ids, p_status: status })
}
