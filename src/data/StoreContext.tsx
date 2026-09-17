import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DB, User, Department, AppSettings, AppNotification } from '../types'
import { buildSeedDb } from './seed'
import * as L from './logic'
import { supabase, isSupabaseMode } from '../lib/supabase'
import { loadAll, remoteActions, createShareLinkRemote, markNotificationsRead as remoteMarkRead, setNotificationLineStatus as remoteSetLine } from './remote'

const DB_KEY = 'lbs-platform-db-v2'
const DB_KEY_V1 = 'lbs-platform-db-v1'
const SESSION_KEY = 'lbs-platform-session-v1'
const SETTINGS_KEY = 'lbs-platform-settings-v1'

// ล็อกอินหมดอายุแบบ absolute 2 ชั่วโมงนับจากตอน login (ทั้งโหมด demo + Supabase)
const SESSION_EXPIRY_KEY = 'lbs-platform-session-expiry'
const SESSION_EXPIRED_FLAG = 'lbs-platform-session-expired'
const SESSION_MAX_MS = 2 * 60 * 60 * 1000

function startSession() {
  localStorage.setItem(SESSION_EXPIRY_KEY, String(Date.now() + SESSION_MAX_MS))
  localStorage.removeItem(SESSION_EXPIRED_FLAG)
}
function endSession() {
  localStorage.removeItem(SESSION_EXPIRY_KEY)
  localStorage.removeItem(SESSION_EXPIRED_FLAG)
}
// true ถ้าเพิ่งถูก logout เพราะหมดเวลา (LoginPage อ่านไปโชว์ข้อความ)
export function wasSessionExpired(): boolean {
  return localStorage.getItem(SESSION_EXPIRED_FLAG) === '1'
}

// เฝ้าเวลา session — พอถึงกำหนดเรียก onExpire (logout) · เช็คทุก ≤1 นาที
// deps = userId เท่านั้น (ใช้ ref กับ onExpire กัน effect รันซ้ำจาก render)
function useSessionExpiry(userId: string | null, onExpire: () => void) {
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire
  useEffect(() => {
    if (!userId) return
    // backfill: มี session ค้างจากก่อน deploy ฟีเจอร์นี้ (ยังไม่มี key) → เริ่มนับ 2 ชม.จากตอนนี้
    if (!localStorage.getItem(SESSION_EXPIRY_KEY)) startSession()
    let timer: number
    const tick = () => {
      const exp = Number(localStorage.getItem(SESSION_EXPIRY_KEY))
      const rem = exp - Date.now()
      if (!exp || rem <= 0) {
        localStorage.removeItem(SESSION_EXPIRY_KEY)
        localStorage.setItem(SESSION_EXPIRED_FLAG, '1')
        onExpireRef.current()
        return
      }
      timer = window.setTimeout(tick, Math.min(rem, 60_000))
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [userId])
}

// สิทธิ์ตามแผนก — ฝั่ง UI ใช้ซ่อน/แสดงปุ่ม; โหมด Supabase ตัวจริงคือ RPC ฝั่ง server
// (ชื่อแสดงผล: sales = "Division", admin = "Manage" — ค่าใน DB คงเดิม)
export const PERMISSIONS: Record<string, Department[]> = {
  'stock.manage': ['sales', 'admin'],
  'job.manage': ['project', 'admin'],
  'purchasing.manage': ['purchasing', 'admin'],
  'service.confirm': ['service', 'admin'],
  'master.manage': ['admin'],
  // Material Database (0061) — Purchasing เป็นเจ้าของฐานข้อมูลวัสดุ: เพิ่ม/แก้/ลบ Accessory + Import Excel
  // แยกจาก master.manage เพราะ master.manage ยังครอบ "ข้ามขั้นอนุมัติ" (createPR/issueJob/cancelJob) + จัดการผู้ใช้
  'material.manage': ['purchasing', 'admin'],
  // ยอดคลังคงเหลือ accessory (ปรับยอด · Lot No. · แถวใน Import Excel ที่แก้ยอด) — Division + Purchasing
  // แยกจาก stock.manage ที่ครอบ Project Stock / LBS รายเครื่อง ซึ่งยังเป็นของ Division เท่านั้น
  'accessoryStock.manage': ['sales', 'purchasing', 'admin'],
  // ทำเบิก-Epicor (0064) — ธงกระทบยอดกับ ERP · คนที่ตัดใบเบิกใน Epicor จริงคือ Purchasing
  'epicor.issue': ['purchasing', 'admin'],
  'approval.decide': ['sales', 'admin'],   // Division อนุมัติ/ตีกลับคำขอจาก project
  // ความเห็นบนคำขออนุมัติ (0050) — VIP (ผู้บริหาร) ฝากความเห็นให้ Division · Division ตอบกลับได้
  // VIP ไม่มีสิทธิ์อื่นเลย = ดูได้ทุกหน้า แต่แก้ข้อมูลไม่ได้ (ปุ่มทุกปุ่มซ่อนเองผ่าน can())
  'approval.comment': ['vip', 'sales', 'admin'],
  'accessory.cleanup': ['project', 'sales', 'admin'],   // ลบรายการวัสดุที่ยกเลิกออกจากการ์ด (Project/Division/Manage)
  // Standard Drawing / BOM (0045) — แก้ได้ Project/Division/Manage · ดู+ดาวน์โหลดได้ทุกแผนก
  'standards.manage': ['project', 'sales', 'admin'],
  // ดาวน์โหลด "รายงานผู้บริหาร" (Excel) จากหน้า Project Stock / Job / Material Database (2026-09-09)
  //   ไฟล์พาต้นทุน · ราคาต่อหน่วย · มูลค่าคลัง · กำไร/มาร์จิ้น ออกไปนอกระบบ (ส่งต่อทางเมลได้ ยึดคืนไม่ได้)
  //   ⇒ ปุ่ม Export **หายทั้งปุ่ม** ถ้าไม่มีสิทธิ์นี้ (มติ 2026-09-09) ไม่ใช่ออกไฟล์แบบตัดคอลัมน์เงินทิ้ง
  //   ⚠️ แผนกที่เห็นตัวเลขเงิน "บนจอ" อยู่แล้วต้องอยู่ในรายชื่อนี้ ไม่งั้นเป็นการถอยฟีเจอร์เดิม
  //      (Project เห็นงบ 7 หมวด + ราคา/หน่วยในแผง Purchase Orders ของงานตัวเองอยู่แล้ว)
  //   **ทุกแผนกที่ login ได้สิทธิ์นี้ (ผู้ใช้ยืนยัน 2026-09-09)** — เดิมตัด `service` ออกด้วยเหตุผลว่า
  //   หน้างานติดตั้งไม่ใช้ตัวเลขต้นทุน แต่ Service ต้องส่งไฟล์ให้หัวหน้างาน/ลูกค้าเองอยู่แล้ว
  //   ⇒ perm นี้ตอนนี้ครบทุกแผนก จึงเหลือความหมายเป็น "ต้อง login ก่อน" · **ยังไม่ลบทิ้ง**
  //     เพราะเป็นจุดเดียวที่ปิดปุ่ม Export ทั้งระบบได้ทีเดียวถ้าภายหลังต้องจำกัดรายแผนกอีก
  'report.exec': ['sales', 'purchasing', 'project', 'service', 'admin', 'vip'],
}

export function can(user: User | null, perm: keyof typeof PERMISSIONS): boolean {
  if (!user) return false
  return PERMISSIONS[perm].includes(user.department)
}

// สิทธิ์ระดับแถว (0042) — Project ดำเนินการได้เฉพาะ Job ที่อีเมลตัวเองเปิด · Job อื่นดูได้อย่างเดียว
// แผนกอื่น (Division/Purchasing/Service) + Manage ไม่ถูกจำกัด (งานข้าม Job เป็นหน้าที่ปกติ)
// openedBy ว่าง = งานเก่าก่อน 0042 → ไม่ล็อก (grandfather) · ตัวจริงคือ app_assert_job_owner ฝั่ง DB
export function ownsJob(user: User | null, job?: { openedBy?: string } | null): boolean {
  if (!user || !job) return false
  if (user.department !== 'project') return true
  if (!job.openedBy) return true
  return job.openedBy === user.id
}

export function canEditJob(user: User | null, job?: { openedBy?: string } | null): boolean {
  return can(user, 'job.manage') && ownsJob(user, job)
}

const DEFAULT_SETTINGS: AppSettings = {
  lineEnabled: false,
  lineEndpoint: '/line-notify',
  lineGroupNote: '',
}

const EMPTY_DB: DB = {
  users: [], publicShareLinks: [],
  items: [], projectStocks: [], lbsUnits: [], lbsUnitFiles: [], jobs: [], allocations: [],
  accessoryStock: [], accessoryRequests: [], prs: [], pos: [], approvalRequests: [], approvalComments: [],
  auditLogs: [], notifications: [], siteVisits: [], unitInstallations: [],
  teamMembers: [], jobAssignments: [], stockMovements: [], jobPayments: [],
  stdDrawings: [], stdPrices: [], stdBoms: [], stdBomLines: [],
}

// migrate ข้อมูล demo จาก schema เก่า (v1: issued_installed, ไม่มี qtyReceived/notifications)
function migrateDb(raw: unknown): DB {
  const d = raw as DB
  type LegacyUnit = DB['lbsUnits'][number] & { serialNo?: string }
  return {
    ...d,
    users: d.users.map(u => ({ ...u, isActive: u.isActive !== false })),
    // v2→v3: serialNo เดี่ยว → serialLvb + serialOm (คู่)
    lbsUnits: d.lbsUnits.map(u => {
      const lu = u as LegacyUnit
      return {
        ...lu,
        serialLvb: lu.serialLvb ?? lu.serialNo ?? '',
        serialOm: lu.serialOm ?? (lu.serialNo ? `${lu.serialNo}·OM` : ''),
      }
    }),
    jobs: d.jobs.map(j => ({
      ...j,
      terminalStatus: ((j.terminalStatus as string) === 'issued_installed'
        ? 'issued'
        : j.terminalStatus) as DB['jobs'][number]['terminalStatus'],
    })),
    accessoryRequests: d.accessoryRequests.map(r => ({
      ...r,
      qtyReceived: r.qtyReceived ?? (r.status === 'received' ? r.qtyRequested : 0),
    })),
    approvalRequests: d.approvalRequests ?? [],
    publicShareLinks: d.publicShareLinks ?? [],   // 0069
    lbsUnitFiles: d.lbsUnitFiles ?? [],           // 0074 — เอกสารแนบรายเครื่อง
    // scope เพิ่มใน 0051 — คอมเมนต์ที่บันทึกไว้ก่อนหน้าไม่มีฟิลด์นี้ ถ้าไม่เติมจะถูก filter ทิ้งทั้งหมด
    approvalComments: (d.approvalComments ?? []).map(c => ({ ...c, scope: c.scope ?? 'approval' })),
    notifications: d.notifications ?? [],
    siteVisits: d.siteVisits ?? [],
    unitInstallations: d.unitInstallations ?? [],
    teamMembers: d.teamMembers ?? [],
    jobAssignments: d.jobAssignments ?? [],
    stockMovements: d.stockMovements ?? [],
    jobPayments: d.jobPayments ?? [],
    stdDrawings: d.stdDrawings ?? [],
    stdPrices: d.stdPrices ?? [],
    stdBoms: d.stdBoms ?? [],
    stdBomLines: d.stdBomLines ?? [],
  }
}

function loadLocalDb(): DB {
  try {
    const raw = localStorage.getItem(DB_KEY) ?? localStorage.getItem(DB_KEY_V1)
    if (raw) return migrateDb(JSON.parse(raw))
  } catch { /* corrupted → reseed */ }
  return buildSeedDb()
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
      // migrate: ย้าย hosting Netlify → Cloudflare Pages (endpoint เดิม /.netlify/functions/*)
      if (s.lineEndpoint?.startsWith('/.netlify/functions/'))
        s.lineEndpoint = s.lineEndpoint.replace('/.netlify/functions/', '/')
      return s
    }
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS
}

type MaybePromise = void | Promise<void>

export interface StoreActions {
  createProjectStock: (p: Parameters<typeof L.createProjectStock>[2]) => MaybePromise
  addUnitsToStock: (p: Parameters<typeof L.addUnitsToStock>[2]) => MaybePromise
  importUnitsToStock: (p: Parameters<typeof L.importUnitsToStock>[2]) => MaybePromise
  updateProjectStock: (p: Parameters<typeof L.updateProjectStock>[2]) => MaybePromise
  createJob: (p: Parameters<typeof L.createJob>[2]) => MaybePromise
  updateJob: (p: Parameters<typeof L.updateJob>[2]) => MaybePromise
  updateJobBudget: (p: Parameters<typeof L.updateJobBudget>[2]) => MaybePromise
  deleteProjectStock: (p: Parameters<typeof L.deleteProjectStock>[2]) => MaybePromise
  updateUnitInfo: (p: Parameters<typeof L.updateUnitInfo>[2]) => MaybePromise
  updateUnitPlan: (p: Parameters<typeof L.updateUnitPlan>[2]) => MaybePromise
  addUnitFile: (p: Parameters<typeof L.addUnitFile>[2]) => MaybePromise
  deleteUnitFile: (p: Parameters<typeof L.deleteUnitFile>[2]) => MaybePromise
  setStockFob: (p: Parameters<typeof L.setStockFob>[2]) => MaybePromise
  deleteDraftJob: (p: Parameters<typeof L.deleteDraftJob>[2]) => MaybePromise
  drawLbs: (p: Parameters<typeof L.drawLbs>[2]) => MaybePromise
  returnLbs: (p: Parameters<typeof L.returnLbs>[2]) => MaybePromise
  swapLbs: (p: Parameters<typeof L.swapLbs>[2]) => MaybePromise
  addAccessoryRequest: (p: Parameters<typeof L.addAccessoryRequest>[2]) => MaybePromise
  updateAccessoryRequestQty: (p: Parameters<typeof L.updateAccessoryRequestQty>[2]) => MaybePromise
  updateAccessoryRequestPrice: (p: Parameters<typeof L.updateAccessoryRequestPrice>[2]) => MaybePromise
  updatePoLinePrice: (p: Parameters<typeof L.updatePoLinePrice>[2]) => MaybePromise
  returnAccessory: (p: Parameters<typeof L.returnAccessory>[2]) => MaybePromise
  cancelAccessoryRequest: (p: Parameters<typeof L.cancelAccessoryRequest>[2]) => MaybePromise
  deleteAccessoryRequest: (p: Parameters<typeof L.deleteAccessoryRequest>[2]) => MaybePromise
  createPR: (p: Parameters<typeof L.createPR>[2]) => MaybePromise
  updatePrNo: (p: Parameters<typeof L.updatePrNo>[2]) => MaybePromise
  rejectPR: (p: Parameters<typeof L.rejectPR>[2]) => MaybePromise
  createPO: (p: Parameters<typeof L.createPO>[2]) => MaybePromise
  cancelPO: (p: Parameters<typeof L.cancelPO>[2]) => MaybePromise
  receivePOItems: (p: Parameters<typeof L.receivePOItems>[2]) => MaybePromise
  adjustPoLine: (p: Parameters<typeof L.adjustPoLine>[2]) => MaybePromise
  issueJob: (p: Parameters<typeof L.issueJob>[2]) => MaybePromise
  issueJobLbs: (p: Parameters<typeof L.issueJobLbs>[2]) => MaybePromise
  issueJobAccessory: (p: Parameters<typeof L.issueJobAccessory>[2]) => MaybePromise
  confirmInstall: (p: Parameters<typeof L.confirmInstall>[2]) => MaybePromise
  logSiteVisit: (p: Parameters<typeof L.logSiteVisit>[2]) => MaybePromise
  confirmUnitInstall: (p: Parameters<typeof L.confirmUnitInstall>[2]) => MaybePromise
  blockUnitInstall: (p: Parameters<typeof L.blockUnitInstall>[2]) => MaybePromise
  closeJobInstall: (p: Parameters<typeof L.closeJobInstall>[2]) => MaybePromise
  createTeamMember: (p: Parameters<typeof L.createTeamMember>[2]) => MaybePromise
  updateTeamMember: (p: Parameters<typeof L.updateTeamMember>[2]) => MaybePromise
  deleteTeamMember: (p: Parameters<typeof L.deleteTeamMember>[2]) => MaybePromise
  assignJobTeam: (p: Parameters<typeof L.assignJobTeam>[2]) => MaybePromise
  cancelJob: (p: Parameters<typeof L.cancelJob>[2]) => MaybePromise
  reopenJob: (p: Parameters<typeof L.reopenJob>[2]) => MaybePromise
  requestApproval: (p: Parameters<typeof L.requestApproval>[2]) => MaybePromise
  approveRequest: (p: Parameters<typeof L.approveRequest>[2]) => MaybePromise
  rejectApprovalRequest: (p: Parameters<typeof L.rejectApprovalRequest>[2]) => MaybePromise
  addApprovalComment: (p: Parameters<typeof L.addApprovalComment>[2]) => MaybePromise
  addStockComment: (p: Parameters<typeof L.addStockComment>[2]) => MaybePromise
  createItem: (p: Parameters<typeof L.createItem>[2]) => MaybePromise
  updateItem: (p: Parameters<typeof L.updateItem>[2]) => MaybePromise
  deleteItem: (p: Parameters<typeof L.deleteItem>[2]) => MaybePromise
  adjustAccessoryStock: (p: Parameters<typeof L.adjustAccessoryStock>[2]) => MaybePromise
  setStockLot: (p: Parameters<typeof L.setStockLot>[2]) => MaybePromise
  markEpicorIssued: (p: Parameters<typeof L.markEpicorIssued>[2]) => MaybePromise
  undoEpicorIssued: (p: Parameters<typeof L.undoEpicorIssued>[2]) => MaybePromise
  transferJobMaterialToStock: (p: Parameters<typeof L.transferJobMaterialToStock>[2]) => MaybePromise
  /** 0069 — คืน **token ตัวเต็ม** ครั้งเดียวตอนสร้าง (LIVE เก็บแต่ hash · เปิดดูซ้ำภายหลังไม่ได้) */
  createShareLink: (p: Parameters<typeof L.createShareLink>[2]) => Promise<string> | string
  revokeShareLink: (p: Parameters<typeof L.revokeShareLink>[2]) => MaybePromise
  /** นับยอดเปิดดูลิงก์สาธารณะ — demo เท่านั้น (LIVE นับใน RPC ฝั่ง server) · ไม่ต้อง login */
  touchShareLink: (p: { token: string }) => void
  writeOffJobMaterial: (p: Parameters<typeof L.writeOffJobMaterial>[2]) => MaybePromise
  addJobPayment: (p: Parameters<typeof L.addJobPayment>[2]) => MaybePromise
  updateJobPayment: (p: Parameters<typeof L.updateJobPayment>[2]) => MaybePromise
  deleteJobPayment: (p: Parameters<typeof L.deleteJobPayment>[2]) => MaybePromise
  createStdDrawing: (p: Parameters<typeof L.createStdDrawing>[2]) => MaybePromise
  updateStdDrawing: (p: Parameters<typeof L.updateStdDrawing>[2]) => MaybePromise
  deleteStdDrawing: (p: Parameters<typeof L.deleteStdDrawing>[2]) => MaybePromise
  createStdPrice: (p: Parameters<typeof L.createStdPrice>[2]) => MaybePromise
  updateStdPrice: (p: Parameters<typeof L.updateStdPrice>[2]) => MaybePromise
  deleteStdPrice: (p: Parameters<typeof L.deleteStdPrice>[2]) => MaybePromise
  createStdBom: (p: Parameters<typeof L.createStdBom>[2]) => MaybePromise
  updateStdBom: (p: Parameters<typeof L.updateStdBom>[2]) => MaybePromise
  deleteStdBom: (p: Parameters<typeof L.deleteStdBom>[2]) => MaybePromise
  addStdBomLine: (p: Parameters<typeof L.addStdBomLine>[2]) => MaybePromise
  updateStdBomLine: (p: Parameters<typeof L.updateStdBomLine>[2]) => MaybePromise
  deleteStdBomLine: (p: Parameters<typeof L.deleteStdBomLine>[2]) => MaybePromise
  importStdBomLines: (p: Parameters<typeof L.importStdBomLines>[2]) => MaybePromise
  createUser: (p: Parameters<typeof L.createUser>[2]) => MaybePromise
  updateUser: (p: Parameters<typeof L.updateUser>[2]) => MaybePromise
}

interface StoreValue {
  db: DB
  user: User | null
  settings: AppSettings
  mode: 'demo' | 'supabase'
  loading: boolean
  /** โหลดข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ — ต้องบอกผู้ใช้ ไม่ใช่โชว์ตารางว่างเหมือนข้อมูลหาย */
  loadError: string | null
  /** บันทึกสำเร็จแล้ว แต่ดึงข้อมูลใหม่ไม่สำเร็จ → ตัวเลขบนจออาจไม่ล่าสุด (ไม่ใช่ error ของการบันทึก) */
  stale: boolean
  login: (email: string, password: string) => MaybePromise
  logout: () => MaybePromise
  resetDemo: () => void
  updateSettings: (s: AppSettings) => MaybePromise
  importDb: (json: string) => void
  markNotificationsRead: () => MaybePromise
  refresh: () => MaybePromise
  act: StoreActions
}

const Ctx = createContext<StoreValue | null>(null)

// =================================================================
// โหมด Demo — localStorage + business logic ฝั่ง client (logic.ts)
// =================================================================
function DemoProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<DB>(loadLocalDb)
  const [user, setUser] = useState<User | null>(() => {
    const d = loadLocalDb()
    return d.users.find(u => u.id === localStorage.getItem(SESSION_KEY)) ?? null
  })
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  // ล็อกอินหมดอายุใน 2 ชม. → เคลียร์ session + เด้งกลับหน้า login
  useSessionExpiry(user?.id ?? null, () => { localStorage.removeItem(SESSION_KEY); setUser(null) })
  // mirror ของ db สำหรับรัน business logic แบบ synchronous:
  // ถ้า throw ภายใน setState updater React จะ crash ทั้ง tree และ try/catch ฝั่ง UI จับไม่ได้
  const dbRef = useRef(db)
  dbRef.current = db
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => { localStorage.setItem(DB_KEY, JSON.stringify(db)) }, [db])
  useEffect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) }, [settings])

  const value = useMemo<StoreValue>(() => {
    const applyDb = (next: DB) => { dbRef.current = next; setDb(next) }

    const dispatchLine = (created: AppNotification[]) => {
      const s = settingsRef.current
      if (created.length === 0) return
      if (!s.lineEnabled) {
        applyDb(L.setNotificationLineStatus(dbRef.current, { ids: created.map(n => n.id), status: 'off' }))
        return
      }
      created.forEach(n => {
        fetch(s.lineEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: n.message }),
        })
          .then(r => applyDb(L.setNotificationLineStatus(dbRef.current, { ids: [n.id], status: r.ok ? 'sent' : 'failed' })))
          .catch(() => applyDb(L.setNotificationLineStatus(dbRef.current, { ids: [n.id], status: 'failed' })))
      })
    }

    const requireUser = (): User => {
      if (!user) throw new Error('กรุณาเข้าสู่ระบบก่อน')
      return user
    }
    const requirePerm = (perm: keyof typeof PERMISSIONS): User => {
      const u = requireUser()
      if (!can(u, perm)) throw new Error('แผนกของคุณไม่มีสิทธิ์ทำรายการนี้')
      return u
    }
    const run = <P,>(perm: keyof typeof PERMISSIONS, fn: (db: DB, actor: User, p: P) => DB) =>
      (p: P) => {
        const actor = requirePerm(perm)
        const before = dbRef.current
        const next = fn(before, actor, p) // throw ตรงนี้ → useTryAction จับได้
        applyDb(next)
        dispatchLine(next.notifications.slice(before.notifications.length))
      }

    return {
      db, user, settings, mode: 'demo', loading: false, loadError: null, stale: false,
      login: (email, password) => {
        const u = db.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase())
        if (!u || u.password !== password) throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
        if (!u.isActive) throw new Error('บัญชีนี้ถูกปิดการใช้งาน ติดต่อผู้ดูแลระบบ')
        localStorage.setItem(SESSION_KEY, u.id)
        startSession()
        setUser(u)
      },
      logout: () => {
        localStorage.removeItem(SESSION_KEY)
        endSession()
        setUser(null)
      },
      resetDemo: () => applyDb(buildSeedDb()),
      updateSettings: (s) => setSettings(s),
      importDb: (json) => {
        const parsed = JSON.parse(json)
        if (!parsed || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.users))
          throw new Error('ไฟล์ไม่ใช่ข้อมูล LBS Platform ที่ถูกต้อง')
        applyDb(migrateDb(parsed))
      },
      markNotificationsRead: () => {
        const u = requireUser()
        applyDb(L.markAllNotificationsRead(dbRef.current, u, {}))
      },
      refresh: () => applyDb(loadLocalDb()),
      act: {
        createProjectStock: run('stock.manage', L.createProjectStock),
        addUnitsToStock: run('stock.manage', L.addUnitsToStock),
        importUnitsToStock: run('stock.manage', L.importUnitsToStock),
        updateProjectStock: run('stock.manage', L.updateProjectStock),
        createJob: run('job.manage', L.createJob),
        updateJob: run('job.manage', L.updateJob),
        // แก้งบอย่างเดียว — เฉพาะ Manage (admin) และแก้ได้แม้ Job ล็อกแล้ว
        updateJobBudget: run('master.manage', L.updateJobBudget),
        deleteProjectStock: run('stock.manage', L.deleteProjectStock),
        updateUnitInfo: run('stock.manage', L.updateUnitInfo),
        updateUnitPlan: run('stock.manage', L.updateUnitPlan),
        // 0074 — เอกสารแนบรายเครื่อง (Division + Manage เหมือนงานคลังอื่น)
        addUnitFile: run('stock.manage', L.addUnitFile),
        deleteUnitFile: run('stock.manage', L.deleteUnitFile),
        setStockFob: run('stock.manage', L.setStockFob),
        deleteDraftJob: run('job.manage', L.deleteDraftJob),
        drawLbs: run('job.manage', L.drawLbs),
        returnLbs: run('job.manage', L.returnLbs),
        // สลับ LBS ตรง = admin เท่านั้น (project ต้องผ่าน requestApproval — 0028)
        swapLbs: run('master.manage', L.swapLbs),
        addAccessoryRequest: run('job.manage', L.addAccessoryRequest),
        updateAccessoryRequestQty: run('job.manage', L.updateAccessoryRequestQty),
        updateAccessoryRequestPrice: run('job.manage', L.updateAccessoryRequestPrice),
        updatePoLinePrice: run('purchasing.manage', L.updatePoLinePrice),
        returnAccessory: run('job.manage', L.returnAccessory),
        cancelAccessoryRequest: run('job.manage', L.cancelAccessoryRequest),
        deleteAccessoryRequest: run('accessory.cleanup', L.deleteAccessoryRequest),
        // 3 action นี้ต้องผ่านการอนุมัติจาก Division — เรียกตรงได้เฉพาะ admin (ข้ามขั้นอนุมัติ)
        createPR: run('master.manage', L.createPR),
        updatePrNo: run('purchasing.manage', L.updatePrNo),
        rejectPR: run('purchasing.manage', L.rejectPR),
        createPO: run('purchasing.manage', L.createPO),
        cancelPO: run('purchasing.manage', L.cancelPO),
        receivePOItems: run('purchasing.manage', L.receivePOItems),
        // 0070 — แก้จำนวน/ตัด item เกินใน PO: Purchasing กดเองได้ (มติ 2026-09-15) · ลง audit + แจ้ง Project
        adjustPoLine: run('purchasing.manage', L.adjustPoLine),
        issueJob: run('master.manage', L.issueJob),
        // 0059 — เบิก LBS ตรง = Manage เท่านั้น (Project ผ่าน requestApproval type issue_job)
        issueJobLbs: run('master.manage', L.issueJobLbs),
        // เบิก Accessory ที่รับของแล้ว = Project เจ้าของงาน + Manage (ไม่ต้องผ่าน Division · มติ 2026-08-23)
        issueJobAccessory: run('job.manage', L.issueJobAccessory),
        confirmInstall: run('service.confirm', L.confirmInstall),
        logSiteVisit: run('service.confirm', L.logSiteVisit),
        confirmUnitInstall: run('service.confirm', L.confirmUnitInstall),
        blockUnitInstall: run('service.confirm', L.blockUnitInstall),
        closeJobInstall: run('service.confirm', L.closeJobInstall),
        // ทะเบียนทีมช่าง + มอบหมายงาน = ทรัพยากรของ Service เอง (Service + Manage)
        createTeamMember: run('service.confirm', L.createTeamMember),
        updateTeamMember: run('service.confirm', L.updateTeamMember),
        deleteTeamMember: run('service.confirm', L.deleteTeamMember),
        assignJobTeam: run('service.confirm', L.assignJobTeam),
        cancelJob: run('master.manage', L.cancelJob),
        // เปิดงานใหม่ตรง = Manage เท่านั้น · Project ใช้ requestApproval type reopen_job (0041)
        reopenJob: run('master.manage', L.reopenJob),
        requestApproval: run('job.manage', L.requestApproval),
        approveRequest: run('approval.decide', L.approveRequest),
        rejectApprovalRequest: run('approval.decide', L.rejectApprovalRequest),
        addApprovalComment: run('approval.comment', L.addApprovalComment),
        addStockComment: run('approval.comment', L.addStockComment),
        // ฐานข้อมูลวัสดุ = Purchasing + Manage (0061)
        createItem: run('material.manage', L.createItem),
        updateItem: run('material.manage', L.updateItem),
        deleteItem: run('material.manage', L.deleteItem),
        adjustAccessoryStock: run('accessoryStock.manage', L.adjustAccessoryStock),
        setStockLot: run('accessoryStock.manage', L.setStockLot),
        // ทำเบิก-Epicor (0064) — Purchasing + Manage
        markEpicorIssued: run('epicor.issue', L.markEpicorIssued),
        undoEpicorIssued: run('epicor.issue', L.undoEpicorIssued),
        // โอนวัสดุเหลือจาก Job เข้าคลังคงเหลือ — Project เป็นเจ้าของวัสดุใน Job
        transferJobMaterialToStock: run('job.manage', L.transferJobMaterialToStock),
        // คืน token ให้หน้าจอโชว์ทันที — โหมด demo เก็บ token ตรง ๆ ในแถวอยู่แล้ว
        createShareLink: (p: Parameters<typeof L.createShareLink>[2]) => {
          const actor = requirePerm('stock.manage')
          const next = L.createShareLink(dbRef.current, actor, p)
          applyDb(next)
          return next.publicShareLinks[next.publicShareLinks.length - 1].token!
        },
        revokeShareLink: run('stock.manage', L.revokeShareLink),
        touchShareLink: (p: { token: string }) => applyDb(L.touchShareLink(dbRef.current, p.token)),
        writeOffJobMaterial: run('job.manage', L.writeOffJobMaterial),
        // Payment — Project (เจ้าของงาน ตาม 0042) + Manage
        addJobPayment: run('job.manage', L.addJobPayment),
        updateJobPayment: run('job.manage', L.updateJobPayment),
        deleteJobPayment: run('job.manage', L.deleteJobPayment),
        // Standard Drawing / BOM (0045)
        createStdDrawing: run('standards.manage', L.createStdDrawing),
        updateStdDrawing: run('standards.manage', L.updateStdDrawing),
        deleteStdDrawing: run('standards.manage', L.deleteStdDrawing),
        createStdPrice: run('standards.manage', L.createStdPrice),
        updateStdPrice: run('standards.manage', L.updateStdPrice),
        deleteStdPrice: run('standards.manage', L.deleteStdPrice),
        createStdBom: run('standards.manage', L.createStdBom),
        updateStdBom: run('standards.manage', L.updateStdBom),
        deleteStdBom: run('standards.manage', L.deleteStdBom),
        addStdBomLine: run('standards.manage', L.addStdBomLine),
        updateStdBomLine: run('standards.manage', L.updateStdBomLine),
        deleteStdBomLine: run('standards.manage', L.deleteStdBomLine),
        importStdBomLines: run('standards.manage', L.importStdBomLines),
        createUser: run('master.manage', L.createUser),
        updateUser: run('master.manage', L.updateUser),
      },
    }
  }, [db, user, settings])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// =================================================================
// โหมด Supabase — Auth จริง + business rule อยู่ใน Postgres RPC
// =================================================================
function SupabaseProvider({ children }: { children: ReactNode }) {
  const sb = supabase!
  const [db, setDb] = useState<DB>(EMPTY_DB)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const userIdRef = useRef<string | null>(null)
  // ล็อกอินหมดอายุใน 2 ชม. → signOut (onAuthStateChange จะเคลียร์ user ให้)
  useSessionExpiry(user?.id ?? null, () => { sb.auth.signOut() })

  useEffect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) }, [settings])

  const reload = useCallback(async (): Promise<DB> => {
    let data: DB
    try {
      data = await loadAll(sb)
    } catch (e) {
      // โหลดไม่สำเร็จ → เก็บไว้โชว์เป็นแบนเนอร์ แล้วโยนต่อให้ผู้เรียกตัดสินใจ
      setLoadError(e instanceof Error ? e.message : String(e))
      throw e
    }
    setLoadError(null)
    setStale(false)
    setDb(data)
    if (userIdRef.current) setUser(data.users.find(u => u.id === userIdRef.current) ?? null)
    // สวิตช์ LINE เป็น global ใน DB (0017) — ถ้าตารางยังไม่มี (ยังไม่รัน migration) คงค่า local เดิม
    try {
      const { data: ls } = await sb.from('app_settings').select('value').eq('key', 'line_enabled').maybeSingle()
      if (ls) {
        const enabled = ls.value === true
        setSettings(prev => prev.lineEnabled === enabled ? prev : { ...prev, lineEnabled: enabled })
      }
    } catch { /* ยังไม่รัน 0017 */ }
    return data
  }, [sb])

  // ส่ง notification ค้างเข้า LINE — ผ่าน rpc_claim_line_pending (0017):
  // server เป็นคนตัดสินจากสวิตช์ global + atomic claim กันหลายเครื่องส่งซ้ำ
  // เครื่องนี้ส่งเฉพาะรายการที่ claim ได้ / ส่ง fail ค่อย mark 'failed'
  // ⚠️ ห้ามใส่ gate ที่อ่านจาก db.notifications ที่โหลดมา (เดิมเช็ค some(lineStatus==='pending'))
  //    เพราะ loadAll ตัดมาแค่ 300 แถว → คิวที่ค้างอยู่นอก slice ทำให้ gate เป็น false ตลอดกาล
  //    แล้ว LINE หยุดส่งทั้งระบบโดยไม่มี error · ตัวตัดสินที่ถูกคือ server: rpc_claim_line_pending
  //    คืน array ว่างเองเมื่อสวิตช์ปิด/ไม่มีคิว/เครื่องอื่น claim ไปแล้ว
  const dispatchLine = useCallback(async () => {
    const { data: claimed, error } = await sb.rpc('rpc_claim_line_pending')
    if (error || !claimed || claimed.length === 0) return   // สวิตช์ปิด (server mark off เอง) / เครื่องอื่น claim ไปแล้ว / ยังไม่รัน 0017
    const { data: { session } } = await sb.auth.getSession()
    const failed: string[] = []
    for (const n of claimed as { id: string; message: string }[]) {
      let ok = false
      try {
        const r = await fetch(settingsRef.current.lineEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),   // /line-notify ต้องมี JWT แล้ว
          },
          body: JSON.stringify({ message: n.message }),
        })
        ok = r.ok
      } catch { ok = false }
      if (!ok) failed.push(n.id)
    }
    if (failed.length > 0) await remoteSetLine(sb, failed, 'failed').catch(() => undefined)
    setDb(prev => ({
      ...prev,
      notifications: prev.notifications.map(x => {
        if (!(claimed as { id: string }[]).some(c => c.id === x.id)) return x
        return { ...x, lineStatus: failed.includes(x.id) ? 'failed' as const : 'sent' as const }
      }),
    }))
  }, [sb])

  useEffect(() => {
    let cancelled = false
    const init = async (sessionUserId: string | null) => {
      userIdRef.current = sessionUserId
      if (!sessionUserId) {
        if (!cancelled) { setUser(null); setDb(EMPTY_DB); setLoading(false) }
        return
      }
      try {
        await reload()
      } catch (e) {
        // reload() ตั้ง loadError ให้แล้ว → App แสดงแบนเนอร์ + ปุ่มลองใหม่
        // (เดิม console.error เฉยๆ ทำให้ผู้ใช้เห็นตารางว่างเหมือนข้อมูลถูกลบ)
        console.error('โหลดข้อมูลจาก Supabase ไม่สำเร็จ', e)
      }
      if (!cancelled) setLoading(false)
    }

    sb.auth.getSession().then(({ data: { session } }) => init(session?.user.id ?? null))
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      init(session?.user.id ?? null)
    })

    // realtime: ข้อมูลเปลี่ยนจากแผนกอื่น → โหลดใหม่ (debounce)
    let timer: number | undefined
    const channel = sb
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => { if (userIdRef.current) reload().catch(() => undefined) }, 800)
      })
      .subscribe()

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
      sb.removeChannel(channel)
      window.clearTimeout(timer)
    }
  }, [sb, reload])

  const value = useMemo<StoreValue>(() => {
    const remote = remoteActions(sb)
    // ⚠️ แยก 2 ความล้มเหลวออกจากกัน:
    //   fn(p) พัง = "บันทึกไม่สำเร็จ" จริง → โยนต่อให้ useTryAction ขึ้น toast แดง
    //   reload() พัง = บันทึก "สำเร็จแล้ว" แต่ดึงข้อมูลใหม่ไม่ได้ → ห้ามขึ้น toast ว่าบันทึกล้มเหลว
    //   ไม่งั้นผู้ใช้กดบันทึกซ้ำ → ได้ PR / งวดเงิน / รายการวัสดุซ้ำ
    const wrap = <P,>(fn: (p: P) => Promise<void>) => async (p: P) => {
      await fn(p)
      try {
        await reload()
        dispatchLine().catch(() => undefined)
      } catch {
        setStale(true)                   // แบนเนอร์ "ข้อมูลบนจออาจไม่ล่าสุด · กดโหลดใหม่"
      }
    }
    const act = Object.fromEntries(
      Object.entries(remote).map(([k, fn]) => [k, wrap(fn as (p: unknown) => Promise<void>)]),
    ) as unknown as StoreActions

    // 0069 — createShareLink ต้องคืน token ที่ server สุ่มให้ · rpc() ตัวกลางคืน void
    //   จึงต่อเองแล้ว reload ต่อท้ายให้เหมือน action อื่น (แถวใหม่ต้องโผล่ในตารางทันที)
    act.createShareLink = async (p) => {
      const token = await createShareLinkRemote(sb, p)
      try { await reload() } catch { setStale(true) }
      return token
    }

    // หลังขออนุมัติสำเร็จ → ดันการ์ด Flex (ปุ่มอนุมัติ) เข้าแชท 1:1 ผู้อนุมัติ (best-effort, เฉพาะตอนเปิด LINE)
    const baseRequestApproval = act.requestApproval
    act.requestApproval = async (p) => {
      await baseRequestApproval(p)
      if (!settingsRef.current.lineEnabled) return
      try {
        const { data: { session } } = await sb.auth.getSession()
        const endpoint = settingsRef.current.lineEndpoint.replace(/line-notify\/?$/, 'line-approval-push')
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
          body: JSON.stringify({ jobId: p.jobId, type: p.type }),
        })
      } catch { /* best-effort — คำขอถูกบันทึกแล้ว, การ์ด LINE พลาดไม่กระทบ flow */ }
    }

    return {
      db, user, settings, mode: 'supabase', loading, loadError, stale,
      login: async (email, password) => {
        const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
        if (error) {
          // บัญชีที่ถูกปิดการใช้งานถูก ban ที่ระดับ auth ด้วย (F3) → GoTrue ตอบ user_banned ไม่ใช่รหัสผ่านผิด
          // ถ้าไม่แยกเคสนี้ ผู้ใช้จะเห็น "อีเมลหรือรหัสผ่านไม่ถูกต้อง" แล้วไปนั่งลองรหัสผ่านใหม่/โทรหา admin ผิดเรื่อง
          const banned = (error as { code?: string }).code === 'user_banned' || /banned/i.test(error.message)
          throw new Error(banned
            ? 'บัญชีนี้ถูกปิดการใช้งาน ติดต่อผู้ดูแลระบบ'
            : 'อีเมลหรือรหัสผ่านไม่ถูกต้อง')
        }
        // ยังเช็คซ้ำที่ profiles — บัญชีเก่าที่ถูกปิดก่อนมีระบบ ban จะยังไม่ถูก ban ที่ auth
        const { data: profile } = await sb.from('profiles').select('is_active').eq('id', data.user.id).single()
        if (profile && !profile.is_active) {
          await sb.auth.signOut()
          throw new Error('บัญชีนี้ถูกปิดการใช้งาน ติดต่อผู้ดูแลระบบ')
        }
        startSession()
      },
      logout: async () => { endSession(); await sb.auth.signOut() },
      resetDemo: () => { throw new Error('รีเซ็ตได้เฉพาะโหมด demo — โหมด Supabase จัดการข้อมูลผ่าน SQL Editor') },
      // สวิตช์ LINE เขียนลง DB (global ทุกเครื่อง, admin เท่านั้น) — endpoint/note เก็บ local ตามเดิม
      updateSettings: async (s) => {
        const prevEnabled = settingsRef.current.lineEnabled
        setSettings(s)
        if (s.lineEnabled !== prevEnabled) {
          const { error } = await sb.rpc('rpc_set_line_enabled', { p_enabled: s.lineEnabled })
          if (error) {
            setSettings(x => ({ ...x, lineEnabled: prevEnabled }))
            throw new Error(`ตั้งสวิตช์ LINE ไม่สำเร็จ: ${error.message} (ต้องเป็น Manage และรัน migration 0017 แล้ว)`)
          }
        }
      },
      importDb: () => { throw new Error('Import ได้เฉพาะโหมด demo') },
      markNotificationsRead: async () => { await remoteMarkRead(sb); await reload() },
      refresh: async () => { await reload() },
      act,
    }
  }, [sb, db, user, settings, loading, reload, dispatchLine])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function StoreProvider({ children }: { children: ReactNode }) {
  return isSupabaseMode
    ? <SupabaseProvider>{children}</SupabaseProvider>
    : <DemoProvider>{children}</DemoProvider>
}

export function useStore(): StoreValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStore ต้องอยู่ภายใต้ StoreProvider')
  return v
}
