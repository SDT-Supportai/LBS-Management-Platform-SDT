import { Link } from 'react-router-dom'
import { useStore } from '../data/StoreContext'
import { unreadNotifications } from '../data/logic'
import { fmtDateTime, DEPT_LABEL } from '../ui/format'
import type { LineStatus } from '../types'

const LINE_BADGE: Record<LineStatus, { text: string; cls: string }> = {
  off: { text: 'LINE ปิดอยู่', cls: 'neutral' },
  pending: { text: 'LINE กำลังส่ง...', cls: 'amber' },
  sent: { text: 'ส่งเข้า LINE แล้ว', cls: 'green' },
  failed: { text: 'ส่ง LINE ไม่สำเร็จ', cls: 'red' },
}

export default function NotificationsPage() {
  const { db, user, markNotificationsRead } = useStore()
  if (!user) return null

  const mine = db.notifications
    .filter(n => n.dept === 'all' || n.dept === user.department || user.department === 'admin')
    .slice()
    .reverse()
  const unread = unreadNotifications(db, user)

  return (
    <>
      <div className="page-title">การแจ้งเตือน (Notifications)</div>
      <div className="page-sub">
        เหตุการณ์ข้ามแผนกที่เกี่ยวกับแผนก {DEPT_LABEL[user.department]} — แจ้งใน App และส่งต่อเข้า LINE group ได้ (ตั้งค่าที่ Dev Settings)
      </div>

      <div style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
        {unread.length > 0
          ? <><span className="badge red">{unread.length} ยังไม่อ่าน</span>
              <button className="small" onClick={markNotificationsRead}>ทำเครื่องหมายอ่านแล้วทั้งหมด</button></>
          : <span className="muted">อ่านครบทุกรายการแล้ว</span>}
      </div>

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead><tr><th>เวลา</th><th>ข้อความ</th><th>ถึงแผนก</th><th>LINE</th></tr></thead>
            <tbody>
              {mine.length === 0 && <tr><td colSpan={4}><div className="empty">ยังไม่มีการแจ้งเตือน — ลองทำ transaction ข้ามแผนกดู เช่น ออก PR หรือรับของตาม PO</div></td></tr>}
              {mine.map(n => {
                const isUnread = !n.readBy.includes(user.id)
                const line = LINE_BADGE[n.lineStatus]
                return (
                  <tr key={n.id} style={isUnread ? { background: '#f2f7ff' } : undefined}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(n.createdAt)}{isUnread && <span className="badge red" style={{ marginLeft: 6 }}>ใหม่</span>}</td>
                    <td>{n.jobId ? <Link to={`/jobs/${n.jobId}`}>{n.message}</Link> : n.message}</td>
                    <td>{n.dept === 'all' ? 'ทุกแผนก' : DEPT_LABEL[n.dept]}</td>
                    <td><span className={`badge ${line.cls}`}>{line.text}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
