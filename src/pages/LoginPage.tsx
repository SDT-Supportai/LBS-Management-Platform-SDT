import { useState } from 'react'
import { useStore, wasSessionExpired } from '../data/StoreContext'
import { useToast } from '../ui/components'
import { DEPT_LABEL } from '../ui/format'

// =============================================================================
// หน้า Login — Glassmorphism โทนเข้ม + Motion (ตามแบบ Canvas "Main" ที่ผู้ใช้อนุมัติ 2026-11)
//   ซ้าย: ข้อความแบรนด์ + 4 โมดูลหลัก · ขวา: การ์ดกระจกสำหรับเข้าสู่ระบบ
//   ข้อความทั้งหน้าเป็นภาษาอังกฤษ (ผู้ใช้กำหนด) · Motion ปิดเองเมื่อผู้ใช้ตั้ง prefers-reduced-motion
//   สไตล์ทั้งหมดอยู่ใน styles.css หัวข้อ "login (Glass + Motion)" — คลาสขึ้นต้น gl-
// =============================================================================

const ICON = {
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  eye: 'M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a15 15 0 0 1-3 3.4M6.5 7.6A15 15 0 0 0 3 12s4 6 9 6a9 9 0 0 0 3.4-.7M9.9 9.9a3 3 0 0 0 4.2 4.2',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
}

const TILES = [
  { name: 'LBS Inventory', desc: 'Unit-level stock tracked by serial number', tint: 'blue',
    icon: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8' },
  { name: 'Jobs', desc: 'Projects, delivery deadlines and budgets', tint: 'indigo',
    icon: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z' },
  { name: 'Purchasing', desc: 'PR / PO issuing and goods receipt', tint: 'amber',
    icon: 'M3 4h2l2.5 11h11L21 7H6M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01' },
  { name: 'Site Installation', desc: 'Per-unit sign-off with GPS and photo', tint: 'green',
    icon: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z' },
]

function Icon({ d, size = 18, className }: { d: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

/** พื้นหลังเคลื่อนไหว: แสงลอย 4 ดวง + สายไฟ 115kV ที่มีกระแสวิ่ง (ใช้ร่วมกับหน้าโหลดใน App.tsx) */
export function GlassBackdrop() {
  const wave = (y: number) => `M0 ${y} Q 240 ${y + 110} 480 ${y} Q 720 ${y + 110} 960 ${y} Q 1200 ${y + 110} 1440 ${y}`
  return (
    <>
      <div aria-hidden="true" className="gl-orb gl-orb-a" />
      <div aria-hidden="true" className="gl-orb gl-orb-b" />
      <div aria-hidden="true" className="gl-orb gl-orb-c" />
      <div aria-hidden="true" className="gl-orb gl-orb-d" />
      <svg aria-hidden="true" className="gl-lines" viewBox="0 0 1440 200" preserveAspectRatio="none">
        <path d={wave(60)} className="gl-wire" />
        <path d={wave(90)} className="gl-wire gl-wire-2" />
        <path d={wave(60)} className="gl-flow" />
        <path d={wave(90)} className="gl-flow gl-flow-slow" />
        <path d="M480 60 V 200 M960 60 V 200 M462 78 H 498 M942 78 H 978" className="gl-pole" />
      </svg>
    </>
  )
}

export default function LoginPage() {
  const { db, login, mode } = useStore()
  const { show } = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [logoErr, setLogoErr] = useState(false)   // ไม่มีไฟล์ /logo.jpg → fallback ⚡
  const [expired] = useState(wasSessionExpired)    // เพิ่งหมดเวลา session 2 ชม.

  const doLogin = async (em: string, pw: string) => {
    if (busy) return
    setBusy(true)
    try {
      await login(em, pw)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
    setBusy(false)
  }

  return (
    <div className="gl-wrap">
      <GlassBackdrop />

      {/* ---------- ซ้าย: ข้อความแบรนด์ ---------- */}
      <section className="gl-hero">
        <div className="gl-chip gl-rise">
          <span className="gl-dot" aria-hidden="true" />
          115kV Load Break Switch
        </div>
        <div className="gl-rise gl-d1">
          <h1 className="gl-title">
            <span>On-time delivery.</span>
            <span className="gl-grad">Lasting customer care.</span>
          </h1>
          <div className="gl-tagline">
            <span className="gl-rule" aria-hidden="true" />
            From purchase to after-sales service
          </div>
        </div>
        <p className="gl-lead gl-rise gl-d2">
          Serial-tracked LBS inventory · Project deadlines and budgets · PR / PO purchasing ·
          Installation verified with GPS and photos · Per-unit installation history and warranty
          for after-sales support
        </p>
        <div className="gl-tiles">
          {TILES.map((t, i) => (
            <div key={t.name} className={`gl-tile gl-rise gl-d${i + 3}`}>
              <div className={`gl-tile-ic gl-tint-${t.tint}`}><Icon d={t.icon} /></div>
              <div>
                <div className="gl-tile-name">{t.name}</div>
                <div className="gl-tile-desc">{t.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- ขวา: การ์ดเข้าสู่ระบบ ---------- */}
      <section className="gl-card" aria-label="Sign in">
        <div className="gl-brand">
          <div className="gl-logo">
            {!logoErr ? (
              <img src="/logo.jpg" alt="115kV LBS Platform logo" onError={() => setLogoErr(true)} />
            ) : (
              <span className="gl-logo-fallback" aria-hidden="true">⚡</span>
            )}
          </div>
          <div>
            <h2>115kV LBS Project Management Platform</h2>
            <div className="gl-dev">Dev. Mr. Siradanai Sirisunthorn</div>
          </div>
        </div>

        {expired && (
          <div className="gl-notice" role="status">
            <Icon d={ICON.clock} size={16} />
            <span>Your session expired (2-hour limit). Please sign in again.</span>
          </div>
        )}

        <form className="gl-form" onSubmit={e => { e.preventDefault(); doLogin(email, password) }}>
          <label className="gl-label">Email
            <span className="gl-field">
              <Icon d={ICON.mail} className="gl-field-ic" />
              <input className="gl-input" type="email" autoComplete="username" autoFocus required
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder={mode === 'demo' ? 'project@demo.co' : 'you@company.com'} />
            </span>
          </label>
          <label className="gl-label">Password
            <span className="gl-field">
              <Icon d={ICON.lock} className="gl-field-ic" />
              <input className="gl-input gl-input-pw" type={showPw ? 'text' : 'password'}
                autoComplete="current-password" required
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Your password" />
              <button type="button" className="gl-eye" onClick={() => setShowPw(v => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw}>
                <Icon d={showPw ? ICON.eyeOff : ICON.eye} />
              </button>
            </span>
          </label>
          <button type="submit" className="gl-cta" disabled={busy}>
            <span className="gl-sheen" aria-hidden="true" />
            {busy ? (
              <><span className="gl-spin" aria-hidden="true" /><span className="gl-cta-txt">Signing in…</span></>
            ) : (
              <><span className="gl-cta-txt">Sign in</span><Icon d={ICON.arrow} className="gl-cta-ic" /></>
            )}
          </button>
        </form>

        {mode === 'demo' ? (
          <div className="gl-demo">
            <div className="gl-demo-head">
              <Icon d={ICON.user} size={15} />
              Demo accounts — click to sign in instantly (password 1234)
            </div>
            <div className="gl-demo-list">
              {db.users.map(u => (
                <button key={u.id} type="button" className="gl-demo-btn" disabled={busy}
                  onClick={() => doLogin(u.email, u.password)}>
                  <span className="gl-demo-name">{u.fullName}</span>
                  <span className="gl-demo-dept">{DEPT_LABEL[u.department]}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="gl-foot">
            <Icon d={ICON.shield} size={16} />
            <span>Use the account provided by your administrator. Sessions expire after 2 hours to keep your data secure.</span>
          </div>
        )}
      </section>
    </div>
  )
}
