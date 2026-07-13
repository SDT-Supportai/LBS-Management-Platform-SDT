import { useState } from 'react'
import { useStore } from '../data/StoreContext'
import { useToast, useTryAction } from '../ui/components'

export default function DevSettingsPage() {
  const { db, settings, updateSettings, resetDemo, importDb, mode } = useStore()
  const { show } = useToast()
  const tryAction = useTryAction()
  const [form, setForm] = useState(settings)
  const [testing, setTesting] = useState(false)

  const save = () => { updateSettings(form); show('บันทึกการตั้งค่าแล้ว') }

  const testLine = async () => {
    setTesting(true)
    try {
      const r = await fetch(form.lineEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '🔔 ทดสอบการแจ้งเตือนจาก 115kV LBS Platform' }),
      })
      show(r.ok ? 'ส่งทดสอบสำเร็จ — เช็คข้อความใน LINE group' : `endpoint ตอบกลับ ${r.status} — เช็ค env LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID บน Netlify`, !r.ok)
    } catch {
      show('เรียก endpoint ไม่ได้ — บน localhost ยังไม่มี Netlify Function ให้รัน (ใช้ netlify dev หรือ deploy ก่อน)', true)
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
        <div className="panel-head"><h3>LINE Messaging API — แจ้งเตือนเข้ากลุ่ม</h3></div>
        <div className="panel-body">
          <p className="muted" style={{ marginBottom: 12 }}>
            Browser เรียก LINE API ตรงไม่ได้ (CORS + token ต้องเป็นความลับ) — ระบบจึงส่งผ่าน Netlify Function
            <span className="mono"> netlify/functions/line-notify</span> ที่เตรียมไว้ใน repo แล้ว
            ตอน deploy ให้ตั้ง env <span className="mono">LINE_CHANNEL_ACCESS_TOKEN</span> และ <span className="mono">LINE_GROUP_ID</span> บน Netlify
          </p>
          <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.lineEnabled}
              onChange={e => setForm({ ...form, lineEnabled: e.target.checked })} />
            <span style={{ margin: 0 }}>เปิดส่งการแจ้งเตือนเข้า LINE group (ทุกเหตุการณ์ข้ามแผนก)</span>
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
          <div>2. LINE แจ้งเตือนกลุ่ม: deploy Netlify + ตั้ง env 2 ตัว → เปิดสวิตช์ด้านบน</div>
          <div>3. LINE ตอบโต้ลูกค้า (webhook bot): template อยู่ที่ <span className="mono">netlify/functions/line-webhook.mjs</span> — ตั้ง Webhook URL ใน LINE Developers Console</div>
        </div>
      </div>
    </>
  )
}
