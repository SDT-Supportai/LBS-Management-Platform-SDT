import { useState } from 'react'
import { useStore } from '../data/StoreContext'
import { useToast } from '../ui/components'
import { DEPT_LABEL } from '../ui/format'

export default function LoginPage() {
  const { db, login, mode } = useStore()
  const { show } = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const doLogin = async (em: string, pw: string) => {
    setBusy(true)
    try {
      await login(em, pw)
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), true)
    }
    setBusy(false)
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>115kV LBS Project Management Platform</h1>
        <div className="sub">Project Stock &amp; Job Workflow — Sales · Project · Purchasing · Service</div>
        <form onSubmit={e => { e.preventDefault(); doLogin(email, password) }}>
          <label className="field">
            <span>อีเมล</span>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="project@demo.co" autoFocus />
          </label>
          <label className="field">
            <span>รหัสผ่าน</span>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="1234" />
          </label>
          <button className="primary" style={{ width: '100%' }} type="submit" disabled={busy}>
            {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>
        {mode === 'demo' ? (
          <div className="demo-users">
            <div className="muted" style={{ marginBottom: 8 }}>โหมด Demo — บัญชีทดลอง (รหัสผ่าน 1234) คลิกเพื่อเข้าใช้ทันที:</div>
            {db.users.map(u => (
              <button key={u.id} onClick={() => doLogin(u.email, u.password)}>
                <span>{u.fullName}</span>
                <span className="badge blue">{DEPT_LABEL[u.department]}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="demo-users">
            <div className="muted">เชื่อมต่อ Supabase แล้ว — ใช้บัญชีที่สร้างใน Supabase Authentication (ผู้ดูแลเพิ่มบัญชีได้ที่เมนู ข้อมูลหลัก)</div>
          </div>
        )}
      </div>
    </div>
  )
}
