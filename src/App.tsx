import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { useStore } from './data/StoreContext'
import { ToastProvider } from './ui/components'
import { DEPT_LABEL } from './ui/format'
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
  if (!user) return null
  const pendingPrs = db.prs.filter(p => p.status === 'pending').length
  const openPos = db.pos.filter(p => p.status === 'issued').length
  const readyJobs = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue').length
  const awaitingInstall = db.jobs.filter(j => j.terminalStatus === 'issued').length
  const unread = unreadNotifications(db, user).length

  const MENU: { to: string; icon: string; label: string; badge?: { text: string; cls: string } }[] = [
    { to: '/dashboard', icon: '📊', label: 'แดชบอร์ด' },
    { to: '/stocks', icon: '📦', label: 'Project Stock (LBS)' },
    { to: '/jobs', icon: '🗂️', label: 'Jobs', badge: readyJobs > 0 ? { text: `${readyJobs} พร้อมเบิก`, cls: 'green' } : undefined },
    { to: '/purchasing', icon: '🛒', label: 'Purchasing (PR/PO)', badge: (pendingPrs + openPos) > 0 ? { text: `${pendingPrs + openPos}`, cls: 'amber' } : undefined },
    { to: '/service', icon: '🔧', label: 'งานติดตั้ง (Service)', badge: awaitingInstall > 0 ? { text: `${awaitingInstall} รอติดตั้ง`, cls: 'blue' } : undefined },
    { to: '/notifications', icon: '🔔', label: 'การแจ้งเตือน', badge: unread > 0 ? { text: `${unread}`, cls: 'red' } : undefined },
    { to: '/master', icon: '🗄️', label: 'ข้อมูลหลัก (Master Data)' },
    { to: '/audit', icon: '📜', label: 'Audit Log' },
    { to: '/dev', icon: '⚙️', label: 'Dev Settings' },
  ]

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo">⚡</span>
        <span>
          115kV LBS Platform
          <small>Project Stock &amp; Job Workflow</small>
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="small" onClick={() => logout()}>ออกจากระบบ</button>
          {mode === 'demo' && (
            <button className="small" onClick={() => { if (confirm('รีเซ็ตข้อมูล demo ทั้งหมด?')) resetDemo() }}>รีเซ็ต demo</button>
          )}
        </div>
      </div>
    </aside>
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
