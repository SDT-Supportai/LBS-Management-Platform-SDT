import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { useStore } from './data/StoreContext'
import { ToastProvider, useTryAction } from './ui/components'
import { DEPT_LABEL, fmtDateTime } from './ui/format'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import StocksPage from './pages/StocksPage'
import JobsPage from './pages/JobsPage'
import JobDetailPage from './pages/JobDetailPage'
import PurchasingPage from './pages/PurchasingPage'
import ServicePage from './pages/ServicePage'
import AuditPage from './pages/AuditPage'
import NotificationsPage from './pages/NotificationsPage'
import MasterDataPage from './pages/MasterDataPage'
import DevSettingsPage from './pages/DevSettingsPage'
import { deriveJobStatus, unreadNotifications } from './data/logic'

function Sidebar() {
  const { db, user, logout, resetDemo, mode } = useStore()
  const navigate = useNavigate()
  if (!user) return null
  const pendingPrs = db.prs.filter(p => p.status === 'pending').length
  const openPos = db.pos.filter(p => p.status === 'issued').length
  const readyJobs = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue').length
  const awaitingInstall = db.jobs.filter(j => j.terminalStatus === 'issued').length

  const MENU: { to: string; icon: string; label: string; badge?: { text: string; cls: string } }[] = [
    { to: '/dashboard', icon: '📊', label: 'Dashboard' },
    { to: '/stocks', icon: '📦', label: 'Project Stock (LBS)' },
    { to: '/jobs', icon: '🗂️', label: 'Jobs', badge: readyJobs > 0 ? { text: `${readyJobs} พร้อมเบิก`, cls: 'green' } : undefined },
    { to: '/purchasing', icon: '🛒', label: 'Purchasing (PR/PO)', badge: (pendingPrs + openPos) > 0 ? { text: `${pendingPrs + openPos}`, cls: 'amber' } : undefined },
    { to: '/service', icon: '🔧', label: 'งานติดตั้ง (Service)', badge: awaitingInstall > 0 ? { text: `${awaitingInstall} รอติดตั้ง`, cls: 'blue' } : undefined },
    { to: '/master', icon: '🗄️', label: 'Material Database' },
    { to: '/dev', icon: '⚙️', label: 'Dev Settings' },
  ]

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo">⚡</span>
        <span>
          115kV LBS Platform
          <small>Project management</small>
        </span>
      </div>
      <nav>
        {MENU.map(m => (
          <NavLink key={m.to} to={m.to}>
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
          <button className="small" onClick={() => navigate('/audit')}>📜 Audit Log</button>
          <button className="small" onClick={() => logout()}>ออกจากระบบ</button>
          {mode === 'demo' && (
            <button className="small" onClick={() => { if (confirm('รีเซ็ตข้อมูล demo ทั้งหมด?')) resetDemo() }}>รีเซ็ต demo</button>
          )}
        </div>
      </div>
    </aside>
  )
}

// การแจ้งเตือน + Refresh ย้ายมามุมบนขวา (bell dropdown)
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
          <Sidebar />
          <main className="main">
            <TopBar />
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/stocks" element={<StocksPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/jobs/:jobId" element={<JobDetailPage />} />
              <Route path="/purchasing" element={<PurchasingPage />} />
              <Route path="/service" element={<ServicePage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/master" element={<MasterDataPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/dev" element={<DevSettingsPage />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </main>
        </div>
      )}
    </ToastProvider>
  )
}
