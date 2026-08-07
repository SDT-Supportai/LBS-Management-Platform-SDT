import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useStore, can } from './data/StoreContext'
import { ErrorBoundary, ToastProvider, useConfirm, useTryAction } from './ui/components'
import { DEPT_LABEL, fmtDateTime } from './ui/format'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import StocksPage from './pages/StocksPage'
import JobsPage from './pages/JobsPage'
import JobDetailPage from './pages/JobDetailPage'
import PurchasingPage from './pages/PurchasingPage'
import ServicePage from './pages/ServicePage'
import ServiceSchedulingPage from './pages/ServiceSchedulingPage'
import AuditPage from './pages/AuditPage'
import NotificationsPage from './pages/NotificationsPage'
import MasterDataPage from './pages/MasterDataPage'
import StandardsPage from './pages/StandardsPage'
import DevSettingsPage from './pages/DevSettingsPage'
import ApprovalsPage from './pages/ApprovalsPage'
import { deriveJobStatus, unreadNotifications, serviceIssues } from './data/logic'

// Logo จริง (/logo.jpg) + fallback ⚡ ถ้ายังไม่มีไฟล์
function BrandLogo() {
  const [err, setErr] = useState(false)
  if (err) return <>⚡</>
  return <img src="/logo.jpg" alt="" onError={() => setErr(true)} />
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { db, user, logout, resetDemo, mode } = useStore()
  const navigate = useNavigate()
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  if (!user) return null
  const pendingPrs = db.prs.filter(p => p.status === 'pending').length
  const openPos = db.pos.filter(p => p.status === 'issued').length
  const readyJobs = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue').length
  const awaitingInstall = db.jobs.filter(j => j.terminalStatus === 'issued').length
  const pendingApprovals = db.approvalRequests.filter(r => r.status === 'pending').length
  // งานที่เบิกแล้วแต่ยังไม่มอบหมายทีม (เฟส C)
  const unassignedJobs = db.jobs.filter(j =>
    j.terminalStatus === 'issued' && !db.jobAssignments.some(a => a.jobId === j.id)).length
  // ปัญหางานบริการที่ยังไม่ปิดงาน — เตือนที่เมนู Service
  const openServiceIssues = serviceIssues(db).filter(i => !i.jobClosed).length

  const MENU: { to: string; icon: string; label: string; badge?: { text: string; cls: string } }[] = [
    { to: '/dashboard', icon: '📊', label: 'Dashboard' },
    { to: '/stocks', icon: '📦', label: 'Project Stock (LBS)' },
    { to: '/jobs', icon: '🗂️', label: 'Project ID (Jobs)', badge: readyJobs > 0 ? { text: `${readyJobs} พร้อมเบิก`, cls: 'green' } : undefined },
    { to: '/purchasing', icon: '🛒', label: 'Purchasing (PR/PO)', badge: (pendingPrs + openPos) > 0 ? { text: `${pendingPrs + openPos}`, cls: 'amber' } : undefined },
    { to: '/service', icon: '🔧', label: 'Service (Installation)',
      // ปัญหาค้างสำคัญกว่าจำนวนงานรอติดตั้ง → โชว์ก่อนถ้ามี
      badge: openServiceIssues > 0 ? { text: `⚠️ ${openServiceIssues} ปัญหา`, cls: 'red' }
        : awaitingInstall > 0 ? { text: `${awaitingInstall} รอติดตั้ง`, cls: 'blue' } : undefined },
    { to: '/scheduling', icon: '👷', label: 'Service & Scheduling', badge: unassignedJobs > 0 ? { text: `${unassignedJobs} ยังไม่มอบหมาย`, cls: 'amber' } : undefined },
    { to: '/master', icon: '🗄️', label: 'Material Database' },
    // เอกสารมาตรฐาน (0045) — ข้อมูลอ้างอิงเหมือน Material Database จึงวางต่อกัน · ทุกแผนกเปิดดูได้
    { to: '/standards', icon: '📐', label: 'Standard Drawing & BOM' },
    // Awaiting Approval ย้ายมาอยู่ล่าง Material Database (มติ 2026-07-19)
    { to: '/approvals', icon: '✅', label: 'Awaiting Approval', badge: pendingApprovals > 0 ? { text: `${pendingApprovals}`, cls: 'amber' } : undefined },
    // Dev Settings เฉพาะ Manage (admin) — แผนกอื่น "not can DevSettings"
    ...(can(user, 'master.manage') ? [{ to: '/dev', icon: '⚙️', label: 'Dev Settings' }] : []),
  ]

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="brand">
        <span className="brand-logo"><BrandLogo /></span>
        <span>
          115kV LBS Platform
          <small>Project management</small>
        </span>
        <button className="drawer-close" onClick={onClose} aria-label="ปิดเมนู">✕</button>
      </div>
      <nav>
        {MENU.map(m => (
          <NavLink key={m.to} to={m.to} onClick={onClose}>
            <span className="nav-main">
              <span className="nav-icon">{m.icon}</span>
              <span>{m.label}</span>
            </span>
            {m.badge && <span className={`badge ${m.badge.cls}`}>{m.badge.text}</span>}
            <span className="glow-dot" aria-hidden="true" />
          </NavLink>
        ))}
      </nav>
      <div className="userbox">
        <div className="name">{user.fullName} {mode === 'demo' ? <span className="badge amber">DEMO</span> : <span className="badge green">LIVE</span>}</div>
        <div className="dept">แผนก {DEPT_LABEL[user.department]} · {user.email}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="small" onClick={() => { navigate('/audit'); onClose() }}>📜 Audit Log</button>
          <button className="small" onClick={() => logout()}>ออกจากระบบ</button>
          {mode === 'demo' && (
            <button className="small" onClick={async () => {
              if (await askConfirm({
                title: 'รีเซ็ตข้อมูล demo',
                description: <>ข้อมูลทดลองทั้งหมดในเครื่องนี้จะถูกล้างและสร้างใหม่จากชุดตัวอย่าง — <b>ย้อนกลับไม่ได้</b></>,
                confirmLabel: 'รีเซ็ต',
              })) resetDemo()
            }}>รีเซ็ต demo</button>
          )}
        </div>
      </div>
      {confirmEl}
    </aside>
  )
}

// การแจ้งเตือน + Refresh ย้ายมามุมบนขวา (bell dropdown)
// แบนเนอร์สถานะการเชื่อมต่อ — ต้องบอกให้ชัดว่า "โหลดไม่ได้" ไม่ใช่ "ไม่มีข้อมูล"
function ConnectionBanner() {
  const { loadError, stale, refresh } = useStore()
  const tryAction = useTryAction()
  const [retrying, setRetrying] = useState(false)
  if (!loadError && !stale) return null

  const retry = async () => {
    setRetrying(true)
    await tryAction(async () => { await refresh() }, 'เชื่อมต่อได้แล้ว — ข้อมูลล่าสุด')
    setRetrying(false)
  }
  return (
    <div className={`conn-banner${loadError ? ' error' : ''}`}>
      <span>
        {loadError
          ? <>⚠️ <b>โหลดข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ</b> — ตัวเลขและรายการที่เห็นอาจไม่ครบ <b>ข้อมูลไม่ได้หายไป</b> ลองเช็คอินเทอร์เน็ตแล้วกดลองใหม่</>
          : <>🕓 <b>บันทึกสำเร็จแล้ว</b> แต่ดึงข้อมูลใหม่ไม่สำเร็จ — ตัวเลขบนจออาจยังไม่อัปเดต <b>ไม่ต้องกดบันทึกซ้ำ</b></>}
      </span>
      <button className="small" onClick={retry} disabled={retrying}>
        {retrying ? 'กำลังลองใหม่…' : 'ลองใหม่'}
      </button>
    </div>
  )
}

function TopBar() {
  const { db, user, markNotificationsRead, refresh } = useStore()
  const tryAction = useTryAction()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (!user) return null
  const unread = unreadNotifications(db, user)
  const recent = db.notifications
    .filter(n => n.dept === 'all' || n.dept === user.department || user.department === 'admin')
    .slice().reverse().slice(0, 8)

  const doRefresh = async () => {
    setRefreshing(true)
    await tryAction(async () => { await refresh() }, 'อัปเดตข้อมูลล่าสุดแล้ว')
    setRefreshing(false)
  }

  return (
    <div className="topbar">
      <button className="topbar-btn" onClick={doRefresh} disabled={refreshing} title="โหลดข้อมูลล่าสุด">
        <span className={`tb-icon${refreshing ? ' spin' : ''}`}>↻</span> Refresh
      </button>
      <div className="notif-wrap" ref={wrapRef}>
        <button className="topbar-btn bell" onClick={() => setOpen(o => !o)} title="การแจ้งเตือน">
          🔔{unread.length > 0 && <span className="notif-count">{unread.length}</span>}
        </button>
        {open && (
          <div className="notif-dropdown">
            <div className="notif-dd-head">
              <b>การแจ้งเตือน</b>
              {unread.length > 0 && (
                <button className="small" onClick={() => markNotificationsRead()}>อ่านทั้งหมด</button>
              )}
            </div>
            <div className="notif-dd-list">
              {recent.length === 0 && <div className="empty">ยังไม่มีการแจ้งเตือน</div>}
              {recent.map(n => {
                const isUnread = !n.readBy.includes(user.id)
                return (
                  <div
                    key={n.id}
                    className={`notif-item${isUnread ? ' unread' : ''}`}
                    onClick={() => { setOpen(false); if (n.jobId) navigate(`/jobs/${n.jobId}`) }}
                  >
                    <div className="notif-msg">{n.message}</div>
                    <div className="muted">{fmtDateTime(n.createdAt)}</div>
                  </div>
                )
              })}
            </div>
            <div className="notif-dd-foot">
              <Link to="/notifications" onClick={() => setOpen(false)}>ดูทั้งหมด →</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const { user, loading } = useStore()
  const [navOpen, setNavOpen] = useState(false)   // mobile drawer
  const isManage = can(user, 'master.manage')     // Dev Settings เฉพาะ Manage (admin)
  const { pathname } = useLocation()              // reset ErrorBoundary เมื่อเปลี่ยนหน้า

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <h1>115kV LBS Platform</h1>
          <div className="sub">กำลังเชื่อมต่อ Supabase...</div>
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      {!user ? (
        <LoginPage />
      ) : (
        <div className="app">
          {/* mobile header: hamburger + brand (แสดงเฉพาะจอเล็ก) */}
          <header className="mobile-header">
            <button className="hamburger" onClick={() => setNavOpen(true)} aria-label="เปิดเมนู">☰</button>
            <span className="brand-logo"><BrandLogo /></span>
            <b>115kV LBS Platform</b>
          </header>
          {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
          <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
          <main className="main">
            <TopBar />
            <ConnectionBanner />
            {/* render พังที่หน้าใดหน้าหนึ่ง ต้องไม่ทำให้ทั้งแอปเป็นจอขาว · เปลี่ยนหน้าแล้ว reset ให้ลองใหม่ */}
            <ErrorBoundary resetKey={pathname}>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/stocks" element={<StocksPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/jobs/:jobId" element={<JobDetailPage />} />
              <Route path="/purchasing" element={<PurchasingPage />} />
              <Route path="/service" element={<ServicePage />} />
              <Route path="/scheduling" element={<ServiceSchedulingPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/master" element={<MasterDataPage />} />
              <Route path="/standards" element={<StandardsPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/dev" element={isManage ? <DevSettingsPage /> : <Navigate to="/dashboard" replace />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
            </ErrorBoundary>
          </main>
        </div>
      )}
    </ToastProvider>
  )
}
