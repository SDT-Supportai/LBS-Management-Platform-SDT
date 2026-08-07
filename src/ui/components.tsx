import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import type { JobStatus, BudgetCosts, CostCategoryKey } from '../types'
import { JOB_STATUS_LABEL, fmtBaht, COST_CATEGORIES } from './format'

// ---------------- Toast + สถานะกำลังบันทึก ----------------
// busy เป็น "ทั้งแอป" ไม่ใช่ต่อปุ่ม — ระหว่างมี action ค้างอยู่ ห้ามยิง action ใหม่
// (กันกดปุ่มซ้ำตอนเน็ตช้าแล้วได้ PR / งวดเงิน / รายการวัสดุซ้ำ)

interface Toast { message: string; error?: boolean }
interface UiCtxValue {
  show: (msg: string, error?: boolean) => void
  busy: boolean
  runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T | typeof SKIPPED>
}
const SKIPPED = Symbol('skipped')
const ToastCtx = createContext<UiCtxValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)      // ref = กันกดรัวก่อน state จะ re-render ทัน
  const timer = useRef<number | undefined>(undefined)

  const show = useCallback((message: string, error = false) => {
    setToast({ message, error })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), error ? 5000 : 3200)
  }, [])

  const runExclusive = useCallback(async <T,>(fn: () => Promise<T> | T) => {
    if (busyRef.current) return SKIPPED          // มี action ค้างอยู่ → ทิ้งคลิกซ้ำ
    busyRef.current = true
    setBusy(true)
    try {
      return await fn()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  // ทำให้ปุ่มยืนยันดู "กำลังทำงาน" ทั้งแอปโดยไม่ต้องแก้ปุ่มทีละตัว (ดู .is-busy ใน styles.css)
  useEffect(() => {
    document.body.classList.toggle('is-busy', busy)
    return () => document.body.classList.remove('is-busy')
  }, [busy])

  return (
    <ToastCtx.Provider value={{ show, busy, runExclusive }}>
      {busy && <div className="busy-bar" aria-hidden="true" />}
      {children}
      {toast && <div className={`toast${toast.error ? ' error' : ''}`}>{toast.message}</div>}
    </ToastCtx.Provider>
  )
}

export function useToast() {
  const v = useContext(ToastCtx)
  if (!v) throw new Error('useToast ต้องอยู่ภายใต้ ToastProvider')
  return v
}

/** true ระหว่างที่มี action กำลังทำงาน — ใช้ disable ปุ่ม/แสดงสถานะ */
export function useBusy(): boolean {
  return useContext(ToastCtx)?.busy ?? false
}

// ---------------- Prompt Modal (แทน window.prompt) ----------------
// เหตุผลที่ต้องเลิกใช้ window.prompt:
//   1) LINE in-app browser (iOS) บล็อก prompt → กดปุ่มแล้วไม่มีอะไรเกิดขึ้น = ผู้ใช้คิดว่าระบบเสีย
//      ทีมเข้าระบบจากการ์ด Flex ใน LINE เป็นหลัก จึงเจอเคสนี้จริง
//   2) ถามซ้อนหลายชั้น (ปรับยอดคลัง = 3 prompt) กด Cancel กลางทางแล้วยกเลิกทั้งชุดแบบเงียบ
//   3) ไม่มี label/หน่วย/validation inline — พิมพ์ "12,000" แล้วถูกปฏิเสธโดยไม่บอกว่าห้ามใส่ comma
// API เป็น promise เพื่อให้แทนที่ prompt() ได้ตรงๆ: const v = await ask({...}); if (!v) return

export interface PromptField {
  key: string
  label: string
  type?: 'text' | 'number' | 'textarea' | 'date'
  value?: string
  placeholder?: string
  hint?: string
  required?: boolean
  min?: number
  suffix?: string                                   // หน่วยต่อท้ายช่อง เช่น บาท / ชุด
  validate?: (v: string, all: Record<string, string>) => string | undefined
}
export interface PromptConfig {
  title: string
  description?: ReactNode
  fields: PromptField[]
  confirmLabel?: string
  danger?: boolean
}

export function usePrompt() {
  const [state, setState] = useState<
    { cfg: PromptConfig; resolve: (v: Record<string, string> | null) => void } | null
  >(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const ask = useCallback((cfg: PromptConfig) => new Promise<Record<string, string> | null>(resolve => {
    setValues(Object.fromEntries(cfg.fields.map(f => [f.key, f.value ?? ''])))
    setErrors({})
    setState({ cfg, resolve })
  }), [])

  const close = (result: Record<string, string> | null) => {
    state?.resolve(result)
    setState(null)
  }

  const submit = () => {
    if (!state) return
    const errs: Record<string, string> = {}
    for (const f of state.cfg.fields) {
      const v = (values[f.key] ?? '').trim()
      if (f.required && !v) { errs[f.key] = 'กรุณากรอกช่องนี้'; continue }
      if (v && f.type === 'number') {
        const n = Number(v)
        if (Number.isNaN(n)) { errs[f.key] = 'ต้องเป็นตัวเลข (ห้ามใส่เครื่องหมาย , )'; continue }
        if (f.min !== undefined && n < f.min) { errs[f.key] = `ต้องไม่น้อยกว่า ${f.min}`; continue }
      }
      const custom = f.validate?.(v, values)
      if (custom) errs[f.key] = custom
    }
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    close(Object.fromEntries(state.cfg.fields.map(f => [f.key, (values[f.key] ?? '').trim()])))
  }

  const element = state ? (
    <Modal
      title={state.cfg.title}
      size={state.cfg.fields.length > 2 ? 'wide' : 'default'}
      onClose={() => close(null)}
      footer={<>
        <button onClick={() => close(null)}>ยกเลิก</button>
        <button className={state.cfg.danger ? 'danger' : 'primary'} onClick={submit}>
          {state.cfg.confirmLabel ?? 'บันทึก'}
        </button>
      </>}
    >
      {state.cfg.description && <div className="muted" style={{ marginBottom: 12 }}>{state.cfg.description}</div>}
      {state.cfg.fields.map(f => (
        <label className="field" key={f.key}>
          <span>{f.label}{f.required ? ' *' : ''}{f.suffix ? ` (${f.suffix})` : ''}</span>
          {f.type === 'textarea'
            ? <textarea rows={2} value={values[f.key] ?? ''} placeholder={f.placeholder}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} />
            : <input
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                min={f.min} value={values[f.key] ?? ''} placeholder={f.placeholder}
                autoFocus={f.key === state.cfg.fields[0].key}
                onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter' && f.type !== 'textarea') submit() }} />}
          {errors[f.key]
            ? <span style={{ color: 'var(--red)', fontSize: 12 }}>{errors[f.key]}</span>
            : f.hint && <span className="muted">{f.hint}</span>}
        </label>
      ))}
    </Modal>
  ) : null

  return { ask, element }
}

// ---------------- Error Boundary ----------------
// render พังที่เดียวไม่ควรทำให้ทั้งแอปเป็นจอขาวจนผู้ใช้ต้องเดาว่าให้ refresh
class ErrorBoundaryInner extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[LBS] หน้าจอเกิดข้อผิดพลาด', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="panel" style={{ margin: 24 }}>
        <div className="panel-body">
          <h3 style={{ marginTop: 0 }}>⚠️ หน้านี้เกิดข้อผิดพลาด</h3>
          <p className="muted">
            ข้อมูลของคุณไม่ได้หายไป — เป็นความผิดพลาดตอนแสดงผลเท่านั้น
            ลองกลับหน้าแรกหรือโหลดหน้าใหม่ ถ้ายังเจอซ้ำให้แจ้งผู้ดูแลระบบพร้อมข้อความด้านล่าง
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button className="primary" onClick={() => { location.hash = '#/dashboard'; location.reload() }}>
              กลับหน้าแรก
            </button>
            <button onClick={() => location.reload()}>โหลดหน้าใหม่</button>
          </div>
          <details>
            <summary className="muted">รายละเอียดสำหรับผู้ดูแลระบบ</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 }}>
              {this.state.error.message}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}

/** key = เปลี่ยนหน้าแล้วให้ลองเรนเดอร์ใหม่ (ไม่ค้างที่หน้า error เดิม) */
export function ErrorBoundary({ children, resetKey }: { children: ReactNode; resetKey?: string }) {
  return <ErrorBoundaryInner key={resetKey}>{children}</ErrorBoundaryInner>
}

/** เรียก action ที่อาจ throw business rule error (sync ใน demo / async RPC ใน Supabase)
 *  → แสดงเป็น toast แทน crash — คืน Promise<boolean> ให้ caller await เพื่อปิด modal เมื่อสำเร็จ */
// เรียก action + จัดการ toast ให้ครบในที่เดียว
// กันกดซ้ำ: ระหว่างมี action ค้างอยู่ คลิกถัดไปจะถูกทิ้ง (คืน false) ไม่ยิงซ้ำเข้าเซิร์ฟเวอร์
export function useTryAction() {
  const { show, runExclusive } = useToast()
  return useCallback(async (fn: () => void | Promise<void>, successMsg?: string): Promise<boolean> => {
    const result = await runExclusive(async () => {
      try {
        await fn()
        if (successMsg) show(successMsg)
        return true
      } catch (e) {
        show(e instanceof Error ? e.message : String(e), true)
        return false
      }
    })
    return result === SKIPPED ? false : result
  }, [show, runExclusive])
}

// ---------------- Modal ----------------

export function Modal({ title, onClose, children, footer, size = 'default' }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'default' | 'wide'
}) {
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal${size === 'wide' ? ' modal-wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------- Badges ----------------

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge ${status}`}>{JOB_STATUS_LABEL[status]}</span>
}

// ---------------- จุดติดตั้งเพิ่มเติม (จุดที่ 2+) ----------------
export interface InstallSite { location: string; requiredDate: string }

/** แก้ไขจุดติดตั้งเพิ่มเติม (จุดที่ 2, 3, …) — โผล่เฉพาะ Job ที่ LBS > 1 · จำกัด ≤ max จุด */
export function InstallSitesEditor({ sites, onChange, max }: {
  sites: InstallSite[]; onChange: (next: InstallSite[]) => void; max: number
}) {
  const set = (i: number, field: keyof InstallSite, v: string) =>
    onChange(sites.map((s, idx) => idx === i ? { ...s, [field]: v } : s))
  const add = () => onChange([...sites, { location: '', requiredDate: '' }])
  const remove = (i: number) => onChange(sites.filter((_, idx) => idx !== i))
  return (
    <div>
      {sites.map((s, i) => (
        <div className="row" key={i} style={{ alignItems: 'flex-end' }}>
          <label className="field"><span>จุดที่ {i + 2} — สถานที่ติดตั้ง</span>
            <input value={s.location} onChange={e => set(i, 'location', e.target.value)} placeholder="เช่น สถานีย่อยแม่ริม" />
          </label>
          <label className="field"><span>วันที่ต้องการติดตั้ง</span>
            <input type="date" value={s.requiredDate} onChange={e => set(i, 'requiredDate', e.target.value)} />
          </label>
          <button className="small danger" type="button" style={{ marginBottom: 12 }} onClick={() => remove(i)} title="ลบจุดนี้">✕</button>
        </div>
      ))}
      <button className="small" type="button" onClick={add} disabled={sites.length >= max}>
        + เพิ่มจุดติดตั้ง{sites.length >= max ? ` (สูงสุด ${max + 1} จุดตามจำนวน LBS)` : ''}
      </button>
    </div>
  )
}

// ---------------- Project Budget fields ----------------

export const toBudgetNum = (s: string): number | undefined => {
  const t = s.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isNaN(n) ? undefined : n
}

// ---------------- Project Budget: ต้นทุน 7 หมวด (0021) ----------------
export type CostForm = Record<CostCategoryKey, { budget: string; phase: string; actual: string }>

export const emptyCostForm = (): CostForm =>
  Object.fromEntries(COST_CATEGORIES.map(c => [c.key, { budget: '', phase: '', actual: '' }])) as CostForm

export const costFormFromJob = (bc?: BudgetCosts): CostForm =>
  Object.fromEntries(COST_CATEGORIES.map(c => {
    const v = bc?.[c.key]
    return [c.key, {
      budget: v?.budget != null ? String(v.budget) : '',
      phase: v?.phase ?? '',
      actual: v?.actual != null ? String(v.actual) : '',
    }]
  })) as CostForm

export const costFormToApi = (f: CostForm): BudgetCosts => {
  const out: BudgetCosts = {}
  for (const c of COST_CATEGORIES) {
    const v = f[c.key]
    const budget = toBudgetNum(v.budget)
    const phase = v.phase.trim() || undefined
    const actual = c.fromPR ? undefined : toBudgetNum(v.actual)   // 2 หมวดแรก actual มาจาก PR/PO
    if (budget !== undefined || phase !== undefined || actual !== undefined)
      out[c.key] = { budget, phase, actual }
  }
  return out
}

/** ช่องกรอกงบประมาณ: ราคาขาย + ต้นทุน 7 หมวด (งบ/Phase/ใช้จริง) + กำไร auto */
export function BudgetFields({ sale, costs, onSale, onCosts }: {
  sale: string; costs: CostForm
  onSale: (v: string) => void; onCosts: (next: CostForm) => void
}) {
  const s = toBudgetNum(sale)
  const totalCost = COST_CATEGORIES.reduce((sum, c) => sum + (toBudgetNum(costs[c.key].budget) ?? 0), 0)
  const hasCost = COST_CATEGORIES.some(c => costs[c.key].budget.trim() !== '')
  const cost = hasCost ? totalCost : undefined
  const profit = s !== undefined && cost !== undefined ? s - cost : undefined
  const margin = profit !== undefined && s ? (profit / s) * 100 : undefined
  const setCat = (key: CostCategoryKey, field: 'budget' | 'phase' | 'actual', val: string) =>
    onCosts({ ...costs, [key]: { ...costs[key], [field]: val } })
  return (
    <>
      <label className="field"><span>ราคาขาย (บาท)</span>
        <input type="number" min={0} value={sale} onChange={e => onSale(e.target.value)} placeholder="0" />
      </label>
      <div className="budget-legend">ต้นทุน (บาท) — แยก 7 หมวด</div>
      <div className="cost-grid cost-grid-head">
        <span>หมวด</span><span>งบประมาณ</span><span>Phase Budget</span><span>ใช้จริง</span>
      </div>
      {COST_CATEGORIES.map(c => (
        <div className="cost-grid" key={c.key}>
          <span className="cost-label">{c.label}</span>
          <input type="number" min={0} value={costs[c.key].budget} placeholder="0"
            onChange={e => setCat(c.key, 'budget', e.target.value)} />
          <input value={costs[c.key].phase} placeholder="Phase"
            onChange={e => setCat(c.key, 'phase', e.target.value)} />
          {c.fromPR
            ? <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>จาก PR/PO</span>
            : <input type="number" min={0} value={costs[c.key].actual} placeholder="0"
                onChange={e => setCat(c.key, 'actual', e.target.value)} />}
        </div>
      ))}
      <div className="budget-profit" style={{ marginTop: 10 }}>
        <span>ต้นทุนรวม (งบ)</span><b>{fmtBaht(cost)}</b>
      </div>
      <div className="budget-profit">
        <span>กำไร (auto = ราคาขาย − ต้นทุนรวม)</span>
        <b className={profit !== undefined && profit < 0 ? 'neg' : 'pos'}>
          {fmtBaht(profit)}{margin !== undefined && <span className="muted"> · {margin.toFixed(1)}%</span>}
        </b>
      </div>
    </>
  )
}
