import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import type { JobStatus } from '../types'
import { JOB_STATUS_LABEL, fmtBaht } from './format'

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

export function Modal({ title, onClose, children, footer }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
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

/** ช่องกรอกงบประมาณ: ราคาขาย / ต้นทุน + กำไร auto (= ราคาขาย − ต้นทุน) */
export function BudgetFields({ sale, cost, onSale, onCost }: {
  sale: string; cost: string
  onSale: (v: string) => void; onCost: (v: string) => void
}) {
  const s = toBudgetNum(sale), c = toBudgetNum(cost)
  const profit = s !== undefined && c !== undefined ? s - c : undefined
  const margin = profit !== undefined && s ? (profit / s) * 100 : undefined
  return (
    <>
      <div className="row">
        <label className="field"><span>ราคาขาย (บาท)</span>
          <input type="number" min={0} value={sale} onChange={e => onSale(e.target.value)} placeholder="0" />
        </label>
        <label className="field"><span>ต้นทุน (บาท)</span>
          <input type="number" min={0} value={cost} onChange={e => onCost(e.target.value)} placeholder="0" />
        </label>
      </div>
      <div className="budget-profit">
        <span>กำไร (auto)</span>
        <b className={profit !== undefined && profit < 0 ? 'neg' : 'pos'}>
          {fmtBaht(profit)}{margin !== undefined && <span className="muted"> · {margin.toFixed(1)}%</span>}
        </b>
      </div>
    </>
  )
}
