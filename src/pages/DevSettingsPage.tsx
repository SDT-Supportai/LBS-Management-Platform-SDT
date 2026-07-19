import { useState } from 'react'
import { useStore, can } from '../data/StoreContext'
import { Modal, useToast, useTryAction } from '../ui/components'
import { DEPT_LABEL } from '../ui/format'
import { supabase } from '../lib/supabase'
import type { Department, User } from '../types'

const DEPTS: Department[] = ['sales', 'project', 'purchasing', 'service', 'admin']

export default function DevSettingsPage() {
  const { db, user, act, settings, updateSettings, resetDemo, importDb, mode } = useStore()
  const { show } = useToast()
  const tryAction = useTryAction()
  const canMaster = can(user, 'master.manage')
  const [form, setForm] = useState(settings)
  const [testing, setTesting] = useState(false)

  // ---- จัดการผู้ใช้งาน (ย้ายมาจาก Material Database) ----
  const [userModal, setUserModal] = useState<'create' | 'edit' | null>(null)
  const [userTarget, setUserTarget] = useState<User | null>(null)
  const [userForm, setUserForm] = useState({ email: '', fullName: '', department: 'project' as Department, password: '', isActive: true })

  const openCreateUser = () => { setUserForm({ email: '', fullName: '', department: 'project', password: '', isActive: true }); setUserTarget(null); setUserModal('create') }
  const openEditUser = (u: User) => { setUserForm({ email: u.email, fullName: u.fullName, department: u.department, password: '', isActive: u.isActive }); setUserTarget(u); setUserModal('edit') }
  const submitUser = async () => {
    const emailChanged = userForm.email.trim().toLowerCase() !== userTarget?.email.toLowerCase()
    const ok = userModal === 'create'
      ? await tryAction(() => act.createUser(userForm), 'เพิ่มผู้ใช้แล้ว')
      : await tryAction(() => act.updateUser({
          userId: userTarget!.id,
          email: emailChanged ? userForm.email : undefined,   // ส่งเฉพาะตอนเปลี่ยนจริง
          fullName: userForm.fullName, department: userForm.department,
          password: userForm.password || undefined, isActive: userForm.isActive,
        }), emailChanged ? 'บันทึกแล้ว — อีเมลใหม่ใช้ login ได้ทันที' : 'บันทึกแล้ว')
    if (ok) setUserModal(null)
  }

  const save = () => tryAction(async () => { await updateSettings(form) }, 'บันทึกการตั้งค่าแล้ว (สวิตช์ LINE มีผลทุกเครื่อง)')

  const testLine = async () => {
    setTesting(true)
    try {
      // /line-notify ต้องมี Supabase JWT (โหมด LIVE) — กันคนนอกยิงข้อความเข้ากลุ่ม
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (supabase) {
        const { data: { session } } = await supabase.auth.getSession()
        if (session) headers.Authorization = `Bearer ${session.access_token}`
      }
      const r = await fetch(form.lineEndpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ message: '🔔 ทดสอบการแจ้งเตือนจาก 115kV LBS Platform' }),
      })
      show(r.ok ? 'ส่งทดสอบสำเร็จ — เช็คข้อความใน LINE group' : `endpoint ตอบกลับ ${r.status} — เช็ค env LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID บน Cloudflare Pages`, !r.ok)
    } catch {
      show('เรียก endpoint ไม่ได้ — บน localhost ยังไม่มี Pages Function ให้รัน (ใช้ npx wrangler pages dev dist หรือ deploy ก่อน)', true)
    }
    setTesting(false)
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lbs-platform-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    show('ดาวน์โหลดไฟล์ backup แล้ว')
  }

  const importJson = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => tryAction(() => importDb(String(reader.result)), 'นำเข้าข้อมูลเรียบร้อย')
    reader.readAsText(file)
  }

  const dbSizeKb = Math.round((localStorage.getItem('lbs-platform-db-v2')?.length ?? 0) / 1024)

  return (
    <>
      <div className="page-title">Dev Settings <span className="badge amber">DEV</span></div>
      <div className="page-sub">
        เครื่องมือสำหรับการพัฒนา/ทดสอบระบบ — โหมดปัจจุบัน:{' '}
        {mode === 'demo'
          ? <span className="badge amber">Demo (localStorage) — ตั้ง VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY เพื่อสลับเป็นโหมดจริง</span>
          : <span className="badge green">Supabase (LIVE) — ข้อมูลอยู่บนฐานข้อมูลจริง</span>}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>ผู้ใช้งาน ({db.users.length})</h3>
          {canMaster && <button className="small primary" onClick={openCreateUser}>+ เพิ่มผู้ใช้</button>}
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>ชื่อ</th><th>อีเมล</th><th>แผนก</th><th>สถานะ</th><th></th></tr></thead>
            <tbody>
              {db.users.map(u => (
                <tr key={u.id}>
                  <td>{u.fullName}</td>
                  <td>{u.email}</td>
                  <td><span className="badge blue">{DEPT_LABEL[u.department]}</span></td>
                  <td>{u.isActive ? <span className="badge green">ใช้งานได้</span> : <span className="badge red">ปิดการใช้งาน</span>}</td>
                  <td>{canMaster && <button className="small" onClick={() => openEditUser(u)}>แก้ไข</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>LINE Messaging API — แจ้งเตือนเข้ากลุ่ม</h3></div>
        <div className="panel-body">
          <p className="muted" style={{ marginBottom: 12 }}>
            Browser เรียก LINE API ตรงไม่ได้ (CORS + token ต้องเป็นความลับ) — ระบบจึงส่งผ่าน Cloudflare Pages Function
            <span className="mono"> functions/line-notify.js</span> ที่เตรียมไว้ใน repo แล้ว (route <span className="mono">/line-notify</span>)
            ตอน deploy ให้ตั้ง env <span className="mono">LINE_CHANNEL_ACCESS_TOKEN</span> และ <span className="mono">LINE_GROUP_ID</span> บน Cloudflare Pages
          </p>
          <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.lineEnabled}
              onChange={e => setForm({ ...form, lineEnabled: e.target.checked })} />
            <span style={{ margin: 0 }}>เปิดส่งการแจ้งเตือนเข้า LINE group (ทุกเหตุการณ์ข้ามแผนก) — <b>สวิตช์รวมทั้งระบบ มีผลทุกเครื่อง</b></span>
          </label>
          <div className="row">
            <label className="field"><span>Endpoint</span>
              <input value={form.lineEndpoint} onChange={e => setForm({ ...form, lineEndpoint: e.target.value })} />
            </label>
            <label className="field"><span>บันทึกช่วยจำ (ผูกกับกลุ่มไหน)</span>
              <input value={form.lineGroupNote} onChange={e => setForm({ ...form, lineGroupNote: e.target.value })}
                placeholder="เช่น กลุ่ม LBS-Project-Team" />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" onClick={save}>บันทึกการตั้งค่า</button>
            <button onClick={testLine} disabled={testing}>{testing ? 'กำลังทดสอบ...' : 'ส่งข้อความทดสอบ'}</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>ข้อมูล ({mode === 'demo' ? 'localStorage — Prototype' : 'Supabase'})</h3></div>
        <div className="panel-body">
          <p className="muted" style={{ marginBottom: 12 }}>
            {mode === 'demo' && <>ขนาดข้อมูลปัจจุบัน ~{dbSizeKb} KB · </>}
            Jobs {db.jobs.length} · LBS {db.lbsUnits.length} เครื่อง ·
            Audit {db.auditLogs.length} รายการ · การแจ้งเตือน {db.notifications.length} รายการ
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={exportJson}>⬇️ Export ข้อมูลเป็น JSON</button>
            {mode === 'demo' && <>
              <label>
                <span className="badge neutral" style={{ cursor: 'pointer', padding: '8px 14px', borderRadius: 8 }}>⬆️ Import จากไฟล์ JSON</span>
                <input type="file" accept=".json" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = '' }} />
              </label>
              <button className="danger" onClick={() => { if (confirm('รีเซ็ตข้อมูลทั้งหมดกลับเป็น demo seed?')) resetDemo() }}>♻️ รีเซ็ต demo</button>
            </>}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Roadmap เชื่อมระบบจริง</h3></div>
        <div className="panel-body muted">
          <div>1. Supabase: รัน <span className="mono">supabase/migrations/0001_schema.sql</span> + เปิด Auth แล้วสลับ data layer</div>
          <div>2. LINE แจ้งเตือนกลุ่ม: deploy Cloudflare Pages + ตั้ง env 2 ตัว → เปิดสวิตช์ด้านบน</div>
          <div>3. LINE ตอบโต้ลูกค้า (webhook bot): template อยู่ที่ <span className="mono">functions/line-webhook.js</span> — ตั้ง Webhook URL <span className="mono">https://&lt;project&gt;.pages.dev/line-webhook</span> ใน LINE Developers Console</div>
        </div>
      </div>

      {userModal && (
        <Modal title={userModal === 'create' ? 'เพิ่มผู้ใช้' : `แก้ไข ${userTarget?.fullName}`} onClose={() => setUserModal(null)}
          footer={<>
            <button onClick={() => setUserModal(null)}>ยกเลิก</button>
            <button className="primary" onClick={submitUser}>บันทึก</button>
          </>}>
          <label className="field"><span>ชื่อ-นามสกุล *</span>
            <input value={userForm.fullName} onChange={e => setUserForm({ ...userForm, fullName: e.target.value })} />
          </label>
          <label className="field"><span>อีเมล * (ใช้เข้าสู่ระบบ{userModal === 'edit' ? ' — เปลี่ยนแล้วมีผลทันที' : ''})</span>
            <input value={userForm.email}
              onChange={e => setUserForm({ ...userForm, email: e.target.value })} />
          </label>
          <div className="row">
            <label className="field"><span>แผนก</span>
              <select value={userForm.department} onChange={e => setUserForm({ ...userForm, department: e.target.value as Department })}>
                {DEPTS.map(d => <option key={d} value={d}>{DEPT_LABEL[d]}</option>)}
              </select>
            </label>
            <label className="field"><span>{userModal === 'create' ? 'รหัสผ่าน *' : 'รหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)'}</span>
              <input type="password" value={userForm.password} onChange={e => setUserForm({ ...userForm, password: e.target.value })} />
            </label>
          </div>
          {userModal === 'edit' && (
            <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={userForm.isActive}
                onChange={e => setUserForm({ ...userForm, isActive: e.target.checked })} />
              <span style={{ margin: 0 }}>เปิดใช้งานบัญชี</span>
            </label>
          )}
        </Modal>
      )}
    </>
  )
}
