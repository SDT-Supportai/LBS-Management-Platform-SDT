import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useStore, can } from './data/StoreContext'
import { ErrorBoundary, ToastProvider, useConfirm, useTryAction } from './ui/components'
import { DEPT_LABEL, fmtDateTime } from './ui/format'
import LoginPage from './pages/LoginPage'
import PublicStockPage from './pages/PublicStockPage'   // 0069 — หน้าสาธารณะ ไม่ต้อง login
import DashboardPage from './pages/DashboardPage'
// Map Tracking โหลดแยก chunk — leaflet + CSS ของมันรวม ~150 kB
// และคนส่วนใหญ่เปิดแอปมาเพื่อดู Dashboard/Jobs ไม่ใช่แผนที่ (2026-08-23)
//   xlsx (~430 kB) แยก chunk อยู่แล้วผ่าน dynamic import ตอนกดปุ่ม Export/Import
const MapTrackingPage = lazy(() => import('./pages/MapTrackingPage'))
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
  const { ask: askConfirm, element: confirmEl } = useConfirm()
  if (!user) return null
  const pendingPrs = db.prs.filter(p => p.status === 'pending').length
  const openPos = db.pos.filter(p => p.status === 'issued').length
  const readyJobs = db.jobs.filter(j => deriveJobStatus(db, j) === 'ready_to_issue').length
  const awaitingInstall = db.jobs.filter(j => j.terminalStatus === 'issued').length
  const pendingIds = new Set(db.approvalRequests.filter(r => r.status === 'pending').map(r => r.id))
  const pendingApprovals = pendingIds.size
  // ความเห็นผู้บริหาร (0050) ที่แปะอยู่บนคำขอซึ่งยังไม่ตัดสิน — Division ควรเห็นก่อนกดอนุมัติ
  const pendingComments = db.approvalComments.filter(c => !!c.requestId && pendingIds.has(c.requestId)).length
  // งานที่เบิกแล้วแต่ยังไม่มอบหมายทีม (เฟส C)
  const unassignedJobs = db.jobs.filter(j =>
    j.terminalStatus === 'issued' && !db.jobAssignments.some(a => a.jobId === j.id)).length
  // ปัญหางานบริการที่ยังไม่ปิดงาน — เตือนที่เมนู Service
  const openServiceIssues = serviceIssues(db).filter(i => !i.jobClosed).length
  // จำนวนจุดที่มีพิกัดบนแผนที่ (เช็คอินราย Serial) — นับเครื่องที่มีพิกัด ไม่ใช่จำนวนแถว log
  const mapPins = new Set(
    db.unitInstallations.filter(r => r.checkinLat != null && r.checkinLng != null).map(r => r.unitId),
  ).size

  // ---------------------------------------------------------------------------
  // เมนู 2 ชั้น: Module → หน้า (มติ 2026-08-22)
  //
  // เกณฑ์แบ่ง Module = "หน้านี้ทำอะไรกับสายงาน" ไม่ใช่ "หน้านี้ของแผนกไหน"
  //   (แผนกปรับโครงสร้างได้ แต่ลำดับที่ของจริงเดินไม่เปลี่ยน)
  //   1. เปลี่ยนสถานะ Serial/Job ไหม → Operations
  //   2. ขวางสายงานไหม / เป็นหลักฐานไหม → Approvals & Audit
  //   3. เป็นข้อมูลอ้างอิงที่ตั้งครั้งเดียวใช้ยาวไหม → Master Data
  //   4. จัดคน+เวลาให้งาน แต่ไม่ทำให้ Job ขยับสถานะ → Workforce & Scheduling
  //
  // เดิมเป็น list ชั้นเดียว 10 รายการที่เอา 4 ประเภทนี้มาปนกัน — ข้อมูลตั้งต้น
  // (Material/Standards) แทรกกลางสายงานทั้งที่แตะเดือนละครั้ง ส่วน Awaiting Approval
  // ซึ่งขวางทั้งสายกลับอยู่ล่างสุด
  //
  // มติที่คุยกันไว้: หัวข้อ Module เป็น "หัวข้อคั่นแบบกางตลอด" ไม่ใช่ accordion
  //   → ไม่ต้องเก็บสถานะพับ/กาง และไม่ต้องมี badge รวมขึ้นหัว Module
  // มติ: ไม่ซ่อน Module ตามแผนก (คงพฤติกรรมเดิม ตรงกับ RLS read_all)
  //   → ยกเว้น Administration ที่เป็น Manage เท่านั้น ซึ่งเป็นของเดิมของ Dev Settings อยู่แล้ว
  //
  // ⚠️ ไม่แตะ route เลย — ทุก `to` เป็นเส้นทางเดิมทั้งหมด bookmark เก่าใช้ได้ปกติ
  // ⚠️ ป้าย badge เป็นอังกฤษให้เข้าชุดกับชื่อ Job status ที่เป็นอังกฤษอยู่แล้ว
  //    (Ready to Issue / Issued / Installed) — ทั้ง sidebar เป็นภาษาเดียว
  // ---------------------------------------------------------------------------
  type MenuItem = { to: string; icon: string; label: string; badge?: { text: string; cls: string } }
  const MENU: { mod: string; icon: string; items: MenuItem[] }[] = [
    // อ่านอย่างเดียว รวมทุกแผนก — Map Tracking อยู่ที่นี่เพราะเป็นมุมมองสรุป ไม่ทำให้อะไรขยับสถานะ
    { mod: 'Overview', icon: '📊', items: [
      { to: '/dashboard', icon: '📊', label: 'Dashboard' },
      { to: '/map', icon: '🗺️', label: 'Map Tracking — ประเทศไทย',
        badge: mapPins > 0 ? { text: `${mapPins} จุด`, cls: 'blue' } : undefined },
    ] },
    // เรียงตามลำดับที่ของจริงเดิน: เข้าคลัง → เปิดงาน → ซื้อของ → ติดตั้ง
    { mod: 'Operations', icon: '🏭', items: [
      { to: '/stocks', icon: '📦', label: 'LBS Inventory' },
      { to: '/jobs', icon: '🗂️', label: 'Jobs', badge: readyJobs > 0 ? { text: `${readyJobs} Ready to Issue`, cls: 'green' } : undefined },
      { to: '/purchasing', icon: '🛒', label: 'Purchasing (PR/PO)', badge: (pendingPrs + openPos) > 0 ? { text: `${pendingPrs + openPos}`, cls: 'amber' } : undefined },
      { to: '/service', icon: '🔧', label: 'Site Installation',
        // ปัญหาค้างสำคัญกว่าจำนวนงานรอติดตั้ง → โชว์ก่อนถ้ามี
        badge: openServiceIssues > 0 ? { text: `⚠️ ${openServiceIssues} Issues`, cls: 'red' }
          : awaitingInstall > 0 ? { text: `${awaitingInstall} Awaiting Install`, cls: 'blue' } : undefined },
    ] },
    // ทะเบียนทีมช่างยังอยู่ใน ServicePage — เฟส 2 จะย้ายมาที่ /scheduling แล้วแยก 2 เมนูจริง
    { mod: 'Workforce & Scheduling', icon: '👷', items: [
      { to: '/scheduling', icon: '👷', label: 'Assignment & Schedule', badge: unassignedJobs > 0 ? { text: `${unassignedJobs} Unassigned`, cls: 'amber' } : undefined },
    ] },
    // ขวางสายงาน = อยู่ในเมนู · Notifications/Audit Log ย้ายไปมุมขวาบน (มติ 2026-08-23)
    //   เหตุผล: 2 หน้านั้นเป็น "เปิดดูตอนสงสัย" ไม่ใช่ "ขั้นที่ต้องเดิน" — อยู่ในเมนูสายงานทำให้เมนูยาวขึ้น
    //   โดยไม่ช่วยให้เดินงานเร็วขึ้น · Notifications ยังซ้ำกับกระดิ่งมุมขวาบนที่มีของเดิมอยู่แล้ว
    //   ⚠️ route ยังอยู่ครบ (/notifications · /audit) — bookmark เก่า ลิงก์ "ดูทั้งหมด →" และลิงก์ใน LINE ใช้ได้ปกติ
    { mod: 'Approvals', icon: '✅', items: [
      { to: '/approvals', icon: '✅', label: 'Approval Queue',
        badge: pendingApprovals > 0
          ? { text: `${pendingApprovals}${pendingComments > 0 ? ` · 💬${pendingComments}` : ''}`, cls: 'amber' }
          : undefined },
    ] },
    { mod: 'Master Data', icon: '📚', items: [
      { to: '/master', icon: '🗄️', label: 'Material Master' },
      { to: '/standards', icon: '📐', label: 'Standards Library' },
    ] },
    // Administration เฉพาะ Manage (admin) — เดิมคือ Dev Settings
    ...(can(user, 'master.manage')
      ? [{ mod: 'Administration', icon: '⚙️', items: [{ to: '/dev', icon: '⚙️', label: 'Users & System Settings' }] }]
      : []),
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
        {MENU.map(g => (
          // role=group + aria-label ให้ screen reader อ่านว่าอยู่ Module ไหน
          // ส่วนหัวข้อที่มองเห็นตั้ง aria-hidden กัน announce ซ้ำ
          <div className="nav-group" role="group" aria-label={g.mod} key={g.mod}>
            <div className="nav-mod" aria-hidden="true">
              <span className="nav-mod-icon">{g.icon}</span>
              <span className="nav-mod-text">{g.mod}</span>
              <span className="nav-mod-line" />
            </div>
            {g.items.map(m => (
              <NavLink key={`${g.mod}:${m.to}:${m.label}`} to={m.to} onClick={onClose}>
                <span className="nav-main">
                  <span className="nav-icon">{m.icon}</span>
                  <span>{m.label}</span>
                </span>
                {m.badge && <span className={`badge ${m.badge.cls}`}>{m.badge.text}</span>}
                <span className="glow-dot" aria-hidden="true" />
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="userbox">
        <div className="name">{user.fullName} {mode === 'demo' ? <span className="badge amber">DEMO</span> : <span className="badge green">LIVE</span>}</div>
        <div className="dept">แผนก {DEPT_LABEL[user.department]} · {user.email}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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

// การแจ้งเตือน + Refresh + Audit Log อยู่มุมบนขวาทั้งชุด (2026-08-23)
//   เกณฑ์: "เครื่องมือประจำหน้าจอ" (โหลดใหม่ / ดูว่ามีอะไรเกิดขึ้น / ย้อนดูว่าใครทำอะไร)
//   ไม่ใช่ขั้นตอนในสายงาน จึงไม่ควรกินที่ในเมนูซ้าย — ดู §13 ใน HANDOFF
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
      {/* Audit Log — ย้ายจากเมนูซ้าย + กล่องผู้ใช้ท้าย sidebar มารวมที่นี่ (ที่เดียว ไม่ซ้ำ) */}
      <button className="topbar-btn" onClick={() => navigate('/audit')} title="ประวัติการทำรายการทั้งระบบ">
        <span className="tb-icon">📜</span> Audit Log
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
  // ลิงก์สาธารณะ: #/share/<token> — เช็คจาก pathname ตรง ๆ เพราะอยู่นอก <Routes> ของแอป
  const shareToken = pathname.startsWith('/share/') ? pathname.slice('/share/'.length) : ''

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

  // 🔴 ลิงก์สาธารณะ (0069) — **ต้องอยู่เหนือด่าน `!user`** ไม่งั้นคนที่ยังไม่ login เจอหน้า Login
  //    หน้านี้ไม่มี sidebar / ปุ่มทำรายการ · ข้อมูลถูกกรองตั้งแต่ชั้น RPC แล้ว ไม่ใช่ซ่อนที่หน้าจอ
  if (shareToken) return <ToastProvider><PublicStockPage token={shareToken} /></ToastProvider>

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
            {/* fallback ต้องมีข้อความ ไม่ใช่จอขาว — เน็ตช้าแล้ว chunk มาช้า คนจะคิดว่าแอปค้าง */}
            <Suspense fallback={<div className="empty">กำลังโหลดหน้า…</div>}>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/map" element={<MapTrackingPage />} />
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
            </Suspense>
            </ErrorBoundary>
          </main>
        </div>
      )}
    </ToastProvider>
  )
}
