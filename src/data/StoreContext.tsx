import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DB, User, Department, AppSettings, AppNotification } from '../types'
import { buildSeedDb } from './seed'
import * as L from './logic'
import { supabase, isSupabaseMode } from '../lib/supabase'
import { loadAll, remoteActions, markNotificationsRead as remoteMarkRead, setNotificationLineStatus as remoteSetLine } from './remote'

const DB_KEY = 'lbs-platform-db-v2'
const DB_KEY_V1 = 'lbs-platform-db-v1'
const SESSION_KEY = 'lbs-platform-session-v1'
const SETTINGS_KEY = 'lbs-platform-settings-v1'

// สิทธิ์ตามแผนก — ฝั่ง UI ใช้ซ่อน/แสดงปุ่ม; โหมด Supabase ตัวจริงคือ RPC ฝั่ง server
export const PERMISSIONS: Record<string, Department[]> = {
  'stock.manage': ['sales', 'admin'],
  'job.manage': ['project', 'admin'],
  'purchasing.manage': ['purchasing', 'admin'],
  'service.confirm': ['service', 'admin'],
  'master.manage': ['admin'],
}

export function can(user: User | null, perm: keyof typeof PERMISSIONS): boolean {
  if (!user) return false
  return PERMISSIONS[perm].includes(user.department)
}

const DEFAULT_SETTINGS: AppSettings = {
  lineEnabled: false,
  lineEndpoint: '/.netlify/functions/line-notify',
  lineGroupNote: '',
}

const EMPTY_DB: DB = {
  users: [], items: [], projectStocks: [], lbsUnits: [], jobs: [], allocations: [],
  accessoryStock: [], accessoryRequests: [], prs: [], pos: [], auditLogs: [], notifications: [],
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
    notifications: d.notifications ?? [],
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
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS
}

type MaybePromise = void | Promise<void>

export interface StoreActions {
  createProjectStock: (p: Parameters<typeof L.createProjectStock>[2]) => MaybePromise
  addUnitsToStock: (p: Parameters<typeof L.addUnitsToStock>[2]) => MaybePromise
  updateProjectStock: (p: Parameters<typeof L.updateProjectStock>[2]) => MaybePromise
  createJob: (p: Parameters<typeof L.createJob>[2]) => MaybePromise
  updateJob: (p: Parameters<typeof L.updateJob>[2]) => MaybePromise
  deleteDraftJob: (p: Parameters<typeof L.deleteDraftJob>[2]) => MaybePromise
  drawLbs: (p: Parameters<typeof L.drawLbs>[2]) => MaybePromise
  returnLbs: (p: Parameters<typeof L.returnLbs>[2]) => MaybePromise
  addAccessoryRequest: (p: Parameters<typeof L.addAccessoryRequest>[2]) => MaybePromise
  updateAccessoryRequestQty: (p: Parameters<typeof L.updateAccessoryRequestQty>[2]) => MaybePromise
  updateAccessoryRequestPrice: (p: Parameters<typeof L.updateAccessoryRequestPrice>[2]) => MaybePromise
  returnAccessory: (p: Parameters<typeof L.returnAccessory>[2]) => MaybePromise
  cancelAccessoryRequest: (p: Parameters<typeof L.cancelAccessoryRequest>[2]) => MaybePromise
  createPR: (p: Parameters<typeof L.createPR>[2]) => MaybePromise
  rejectPR: (p: Parameters<typeof L.rejectPR>[2]) => MaybePromise
  createPO: (p: Parameters<typeof L.createPO>[2]) => MaybePromise
  receivePOItems: (p: Parameters<typeof L.receivePOItems>[2]) => MaybePromise
  issueJob: (p: Parameters<typeof L.issueJob>[2]) => MaybePromise
  confirmInstall: (p: Parameters<typeof L.confirmInstall>[2]) => MaybePromise
  cancelJob: (p: Parameters<typeof L.cancelJob>[2]) => MaybePromise
  createItem: (p: Parameters<typeof L.createItem>[2]) => MaybePromise
  updateItem: (p: Parameters<typeof L.updateItem>[2]) => MaybePromise
  deleteItem: (p: Parameters<typeof L.deleteItem>[2]) => MaybePromise
  adjustAccessoryStock: (p: Parameters<typeof L.adjustAccessoryStock>[2]) => MaybePromise
  createUser: (p: Parameters<typeof L.createUser>[2]) => MaybePromise
  updateUser: (p: Parameters<typeof L.updateUser>[2]) => MaybePromise
}

interface StoreValue {
  db: DB
  user: User | null
  settings: AppSettings
  mode: 'demo' | 'supabase'
  loading: boolean
  login: (email: string, password: string) => MaybePromise
  logout: () => MaybePromise
  resetDemo: () => void
  updateSettings: (s: AppSettings) => void
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
      db, user, settings, mode: 'demo', loading: false,
      login: (email, password) => {
        const u = db.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase())
        if (!u || u.password !== password) throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
        if (!u.isActive) throw new Error('บัญชีนี้ถูกปิดการใช้งาน ติดต่อผู้ดูแลระบบ')
        localStorage.setItem(SESSION_KEY, u.id)
        setUser(u)
      },
      logout: () => {
        localStorage.removeItem(SESSION_KEY)
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
        updateProjectStock: run('stock.manage', L.updateProjectStock),
        createJob: run('job.manage', L.createJob),
        updateJob: run('job.manage', L.updateJob),
        deleteDraftJob: run('job.manage', L.deleteDraftJob),
        drawLbs: run('job.manage', L.drawLbs),
        returnLbs: run('job.manage', L.returnLbs),
        addAccessoryRequest: run('job.manage', L.addAccessoryRequest),
        updateAccessoryRequestQty: run('job.manage', L.updateAccessoryRequestQty),
        updateAccessoryRequestPrice: run('job.manage', L.updateAccessoryRequestPrice),
        returnAccessory: run('job.manage', L.returnAccessory),
        cancelAccessoryRequest: run('job.manage', L.cancelAccessoryRequest),
        createPR: run('job.manage', L.createPR),
        rejectPR: run('purchasing.manage', L.rejectPR),
        createPO: run('purchasing.manage', L.createPO),
        receivePOItems: run('purchasing.manage', L.receivePOItems),
        issueJob: run('job.manage', L.issueJob),
        confirmInstall: run('service.confirm', L.confirmInstall),
        cancelJob: run('job.manage', L.cancelJob),
        createItem: run('master.manage', L.createItem),
        updateItem: run('master.manage', L.updateItem),
        deleteItem: run('master.manage', L.deleteItem),
        adjustAccessoryStock: run('stock.manage', L.adjustAccessoryStock),
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
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const userIdRef = useRef<string | null>(null)

  useEffect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) }, [settings])

  const reload = useCallback(async (): Promise<DB> => {
    const data = await loadAll(sb)
    setDb(data)
    if (userIdRef.current) setUser(data.users.find(u => u.id === userIdRef.current) ?? null)
    return data
  }, [sb])

  // ส่ง notification ที่ค้างสถานะ pending เข้า LINE (ผ่าน netlify function)
  const dispatchLine = useCallback(async (data: DB) => {
    const pending = data.notifications.filter(n => n.lineStatus === 'pending')
    if (pending.length === 0) return
    const s = settingsRef.current
    if (!s.lineEnabled) {
      await remoteSetLine(sb, pending.map(n => n.id), 'off').catch(() => undefined)
      setDb(prev => ({
        ...prev,
        notifications: prev.notifications.map(n => n.lineStatus === 'pending' ? { ...n, lineStatus: 'off' } : n),
      }))
      return
    }
    for (const n of pending) {
      let ok = false
      try {
        const r = await fetch(s.lineEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: n.message }),
        })
        ok = r.ok
      } catch { ok = false }
      await remoteSetLine(sb, [n.id], ok ? 'sent' : 'failed').catch(() => undefined)
      setDb(prev => ({
        ...prev,
        notifications: prev.notifications.map(x => x.id === n.id ? { ...x, lineStatus: ok ? 'sent' : 'failed' } : x),
      }))
    }
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
    const wrap = <P,>(fn: (p: P) => Promise<void>) => async (p: P) => {
      await fn(p)                        // error จาก RPC → useTryAction จับได้
      const data = await reload()
      dispatchLine(data).catch(() => undefined)
    }
    const act = Object.fromEntries(
      Object.entries(remote).map(([k, fn]) => [k, wrap(fn as (p: unknown) => Promise<void>)]),
    ) as unknown as StoreActions

    return {
      db, user, settings, mode: 'supabase', loading,
      login: async (email, password) => {
        const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
        if (error) throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
        const { data: profile } = await sb.from('profiles').select('is_active').eq('id', data.user.id).single()
        if (profile && !profile.is_active) {
          await sb.auth.signOut()
          throw new Error('บัญชีนี้ถูกปิดการใช้งาน ติดต่อผู้ดูแลระบบ')
        }
      },
      logout: async () => { await sb.auth.signOut() },
      resetDemo: () => { throw new Error('รีเซ็ตได้เฉพาะโหมด demo — โหมด Supabase จัดการข้อมูลผ่าน SQL Editor') },
      updateSettings: (s) => setSettings(s),
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
