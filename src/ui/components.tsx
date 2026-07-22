import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import type { JobStatus, BudgetCosts, CostCategoryKey } from '../types'
import { JOB_STATUS_LABEL, fmtBaht, COST_CATEGORIES } from './format'

// ---------------- Toast ----------------

interface Toast { message: string; error?: boolean }
const ToastCtx = createContext<{ show: (msg: string, error?: boolean) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((message: string, error = false) => {
    setToast({ message, error })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), error ? 5000 : 3200)
  }, [])
  return (
    <ToastCtx.Provider value={{ show }}>
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

/** เรียก action ที่อาจ throw business rule error (sync ใน demo / async RPC ใน Supabase)
 *  → แสดงเป็น toast แทน crash — คืน Promise<boolean> ให้ caller await เพื่อปิด modal เมื่อสำเร็จ */
export function useTryAction() {
  const { show } = useToast()
  return useCallback(async (fn: () => void | Promise<void>, successMsg?: string): Promise<boolean> => {
    try {
      await fn()
      if (successMsg) show(successMsg)
      return true
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
      return false
    }
  }, [show])
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
