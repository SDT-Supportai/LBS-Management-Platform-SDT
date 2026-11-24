// =============================================================================
// เฟส 6 (2026-11-24) — Audit Log: ค้นตามช่วงวันที่ (เวลาไทย) · ลิงก์ไปหน้าที่ตรงกับข้อมูล
//   เดิมหน้า Audit กรองแค่ 500 รายการล่าสุดที่โหลดมาตอนเปิดแอป ⇒ ค้นย้อนหลังไม่เจอ
//   LIVE: ค้นที่ฐานข้อมูล (remote.ts fetchAuditLogs ใช้ auditRangeIso) · demo: filterAuditLogs
// =============================================================================
import type { AuditLog, DB } from '../types'
import { bkkDate } from './flow'
import { addDaysIso } from './logic'

export interface AuditFilter {
  /** YYYY-MM-DD (เวลาไทย) */
  from?: string
  to?: string
  q?: string
  actorId?: string
  entityType?: string
}

export const AUDIT_ENTITY_LABEL: Record<string, string> = {
  job: 'Job', job_payment: 'งวดเงิน', job_accessory_request: 'วัสดุของ Job', accessory_request: 'วัสดุของ Job',
  approval_request: 'คำขออนุมัติ', purchase_requisition: 'PR', purchase_order: 'PO',
  lbs_unit: 'LBS รายเครื่อง', project_stock: 'คลัง LBS', stock_allocation: 'ดึง/คืน LBS', share_link: 'ลิงก์ผู้บริหาร',
  contract: 'Contract', item: 'วัสดุ', accessory_stock: 'คลังวัสดุ', stock_comment: 'ความเห็นคลัง',
  std_drawing: 'Standard Drawing', std_price: 'Standard Price', std_bom: 'Standard BOM',
  team_member: 'ทีมช่าง', user: 'ผู้ใช้', profile: 'ผู้ใช้', line_bind: 'ผูก LINE', app_settings: 'ตั้งค่าระบบ',
}

/**
 * ตัวเลือก "ประเภทข้อมูล" — ชื่อเดียวกันรวมเป็นตัวเลือกเดียวที่ครอบทุกชนิด (รีวิวเฟส 6 #5)
 *   เดิมขึ้น "วัสดุของ Job" 2 อัน (accessory_request / job_accessory_request) เลือกอันหนึ่งแล้วอีกชนิดหาย
 *   key = ชนิดแรกของกลุ่ม · ชนิดที่ไม่รู้จัก (จากข้อมูลจริง) ต่อท้ายด้วยชื่อดิบ
 */
export function auditTypeOptions(extraTypes: string[] = []): { key: string; label: string; types: string[] }[] {
  const byLabel = new Map<string, string[]>()
  for (const [t, label] of Object.entries(AUDIT_ENTITY_LABEL)) byLabel.set(label, [...(byLabel.get(label) ?? []), t])
  const opts = [...byLabel].map(([label, types]) => ({ key: types[0], label, types }))
  for (const t of new Set(extraTypes)) if (!AUDIT_ENTITY_LABEL[t]) opts.push({ key: t, label: t, types: [t] })
  return opts.sort((a, b) => a.label.localeCompare(b.label))
}
/** ชนิดทั้งหมดที่ใช้ชื่อเดียวกับชนิดนี้ (ไม่รู้จัก = ตัวมันเอง) */
export function auditTypesFor(type: string): string[] {
  const label = AUDIT_ENTITY_LABEL[type]
  return label ? Object.keys(AUDIT_ENTITY_LABEL).filter(t => AUDIT_ENTITY_LABEL[t] === label) : [type]
}

/** ช่วงวันที่ (เวลาไทย) → ขอบเวลา UTC สำหรับค้นที่ฐานข้อมูล: gte = 00:00 น. วันแรก · lt = 00:00 น. วันถัดจากวันสุดท้าย */
export function auditRangeIso(from?: string, to?: string): { gte?: string; lt?: string } {
  const at = (d: string) => new Date(`${d}T00:00:00+07:00`).toISOString()
  return {
    ...(from ? { gte: at(from) } : {}),
    ...(to ? { lt: at(addDaysIso(to, 1)) } : {}),
  }
}

export function filterAuditLogs(logs: AuditLog[], f: AuditFilter): AuditLog[] {
  const q = f.q?.trim().toLowerCase()
  const types = f.entityType ? auditTypesFor(f.entityType) : null
  return logs.filter(l => {
    if (f.actorId && l.actorId !== f.actorId) return false
    if (types && !types.includes(l.entityType)) return false
    if (f.from || f.to) {
      const d = bkkDate(l.createdAt)
      if (!d || (f.from && d < f.from) || (f.to && d > f.to)) return false
    }
    if (q && ![l.detail, l.action, l.entityId].some(s => s?.toLowerCase().includes(q))) return false
    return true
  })
}

// ---------------- ตัวคุมการค้นบน LIVE (รีวิวเฟส 6 #1 #2) ----------------
export interface AuditSearchState { rows: AuditLog[]; hasMore: boolean; loading: boolean; error: string | null }
export type AuditFetcher = (f: AuditFilter, page: { limit: number; before?: string }) => Promise<{ logs: AuditLog[]; hasMore: boolean }>

/**
 * ค้น + โหลดเพิ่ม โดย:
 *   · ผลของคำขอที่ถูกแทนแล้ว (ค้นใหม่ / โหลดเพิ่มของการค้นเก่า) ถูกทิ้ง — เดิมคำตอบที่มาช้ากว่าทับผลล่าสุด
 *   · เริ่มค้นใหม่ = ล้างผลเก่าทันที (ไม่โชว์ผลเก่าใต้ตัวกรองใหม่)
 *   · โหลดเพิ่มอ้าง "เวลาของแถวสุดท้าย" (before) แทน offset + ตัดแถวซ้ำตาม id
 *     — เดิม offset: มีรายการใหม่เข้ามาระหว่างโหลด แถวท้ายหน้าแรกโผล่ซ้ำ
 */
export function createAuditSearch(fetch: AuditFetcher, onChange: (s: AuditSearchState) => void, limit = 200) {
  let seq = 0
  let filter: AuditFilter = {}
  let state: AuditSearchState = { rows: [], hasMore: false, loading: false, error: null }
  const set = (s: Partial<AuditSearchState>) => { state = { ...state, ...s }; onChange(state) }
  const run = async (token: number, page: { limit: number; before?: string }, append: boolean) => {
    try {
      const r = await fetch(filter, page)
      if (token !== seq) return
      const seen = new Set(append ? state.rows.map(x => x.id) : [])
      const rows = append ? [...state.rows, ...r.logs.filter(x => !seen.has(x.id))] : r.logs
      set({ rows, hasMore: r.hasMore, loading: false, error: null })
    } catch (e) {
      if (token !== seq) return
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return {
    search(f: AuditFilter) {
      filter = f
      const token = ++seq
      set({ rows: [], hasMore: false, loading: true, error: null })
      return run(token, { limit }, false)
    },
    more() {
      if (state.loading || !state.hasMore) return Promise.resolve()
      const token = ++seq
      set({ loading: true })
      return run(token, { limit, before: state.rows[state.rows.length - 1]?.createdAt }, true)
    },
    reset() { seq++; set({ rows: [], hasMore: false, loading: false, error: null }) },
  }
}

/** หน้าที่ดูข้อมูลของรายการนี้ได้ — ไม่รู้จัก/หาไม่เจอ = null (ไม่ทำลิงก์หลอก) */
export function auditLink(l: AuditLog, db: DB): string | null {
  switch (l.entityType) {
    case 'job': return `/jobs/${l.entityId}`
    case 'job_payment': { const p = db.jobPayments.find(x => x.id === l.entityId); return p ? `/jobs/${p.jobId}` : null }
    case 'job_accessory_request':
    case 'accessory_request': { const r = db.accessoryRequests.find(x => x.id === l.entityId); return r ? `/jobs/${r.jobId}` : null }
    case 'approval_request': return '/approvals'
    case 'purchase_requisition': case 'purchase_order': return '/purchasing'
    case 'lbs_unit': case 'project_stock': case 'stock_allocation': case 'share_link': case 'contract': return '/stocks'
    case 'item': case 'accessory_stock': case 'stock_comment': return '/master'
    case 'std_drawing': case 'std_price': case 'std_bom': return '/standards'
    case 'team_member': return '/scheduling'
    case 'user': case 'profile': case 'line_bind': case 'app_settings': return '/dev'
    default: return null
  }
}
