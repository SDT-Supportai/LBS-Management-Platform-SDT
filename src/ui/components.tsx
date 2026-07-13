import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import type { JobStatus } from '../types'
import { JOB_STATUS_LABEL } from './format'

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
