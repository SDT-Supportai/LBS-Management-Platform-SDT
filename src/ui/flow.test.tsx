// เฟส 2 — ตรวจ markup ของชิ้นส่วนกลาง (render เป็น HTML บน node ไม่ต้องมี DOM)
// พฤติกรรมที่ต้องใช้เบราว์เซอร์จริง (Esc / ถามก่อนทิ้งข้อมูล / เต็มจอบนมือถือ) ตรวจในหน้าจอ Demo
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { DB, User } from '../types'
import { GateButton, NextStepBar, PendingBadge, ConfirmSummary, MyWorkPanel } from './flow'
import type { NextStep, WorkItem } from '../data/flow'

const html = (el: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)
const user = (department: User['department']): User =>
  ({ id: 'u', email: 'u@x', password: '', fullName: 'U', department, isActive: true })
const step = (over: Partial<NextStep> = {}): NextStep =>
  ({ title: 'เบิกให้ Service', detail: 'ของครบแล้ว', who: ['project'], tone: 'neutral', pending: [], ...over })

describe('GateButton — ปุ่มไม่หายเงียบ', () => {
  it('กดได้: ปุ่มปกติ ไม่มีกุญแจ ไม่มีบรรทัดเหตุผล', () => {
    const h = html(<GateButton gate={{ ok: true }} className="primary">เบิก</GateButton>)
    expect(h).not.toContain('disabled')
    expect(h).not.toContain('🔒')
    expect(h).not.toContain('gate-why')
    expect(h).toContain('class="primary"')
  })
  it('กดไม่ได้: ปุ่ม disabled + 🔒 + เหตุผลใต้ปุ่ม + tooltip เดียวกัน', () => {
    const h = html(<GateButton gate={{ ok: false, reason: 'สำหรับ Purchasing', who: ['purchasing'] }}>ออก PO</GateButton>)
    expect(h).toContain('disabled=""')
    expect(h).toContain('🔒')
    expect(h).toContain('<span class="gate-why">สำหรับ Purchasing</span>')
    expect(h).toContain('title="สำหรับ Purchasing"')
  })
  it("reason='tooltip' (ที่แคบ เช่น ในตาราง): ไม่มีบรรทัดใต้ปุ่ม แต่ยังมี tooltip", () => {
    const h = html(<GateButton gate={{ ok: false, reason: 'X' }} reason="tooltip">ก</GateButton>)
    expect(h).not.toContain('gate-why')
    expect(h).toContain('title="X"')
  })
  it('disabled ฝั่งหน้าจอ (ยังไม่เลือกรายการ) ปิดปุ่มได้โดยไม่ขึ้นกุญแจ', () => {
    const h = html(<GateButton gate={{ ok: true }} disabled>ยืนยัน</GateButton>)
    expect(h).toContain('disabled=""')
    expect(h).not.toContain('🔒')
  })
  it('รีวิวข้อ 6: กดได้แต่มีหมายเหตุ → บรรทัดหมายเหตุสีปกติใต้ปุ่ม (ไม่ใช่กุญแจ/เหตุผลกดไม่ได้)', () => {
    const h = html(<GateButton gate={{ ok: true, note: 'LBS รอ Division · วัสดุเบิกได้' }}>เบิก</GateButton>)
    expect(h).not.toContain('disabled')
    expect(h).not.toContain('🔒')
    expect(h).not.toContain('gate-why')
    expect(h).toContain('<span class="gate-note">LBS รอ Division · วัสดุเบิกได้</span>')
    expect(h).toContain('title="LBS รอ Division · วัสดุเบิกได้"')
  })
})

describe('NextStepBar — ขั้นต่อไป · ใครทำ · ภายในวันที่', () => {
  it('ถึงคิวผู้ใช้ = ป้าย "ถึงคิวคุณ" · แผนกอื่นไม่มีป้าย', () => {
    expect(html(<NextStepBar step={step()} user={user('project')} today="2026-11-23" />)).toContain('ถึงคิวคุณ')
    expect(html(<NextStepBar step={step()} user={user('service')} today="2026-11-23" />)).not.toContain('ถึงคิวคุณ')
  })
  it('แสดงชื่อแผนก (Division ไม่ใช่ sales)', () => {
    const h = html(<NextStepBar step={step({ who: ['sales'] })} user={null} today="2026-11-23" />)
    expect(h).toContain('👤 Division')
    expect(h).not.toContain('sales')
  })
  it('วันที่: เหลือกี่วัน · วันนี้ · เลยกี่วัน (สีแดง)', () => {
    const s = (due: string) => html(<NextStepBar step={step({ due, dueLabel: 'กำหนดส่ง' })} user={null} today="2026-11-23" />)
    expect(s('2026-11-30')).toContain('อีก 7 วัน')
    expect(s('2026-11-23')).toContain('กำหนดส่งวันนี้')
    const late = s('2026-11-20')
    expect(late).toContain('เลยกำหนดส่ง 3 วัน')
    expect(late).toContain('next-step-late')
  })
  it('ไม่มีผู้ต้องทำ (ปิด/ยกเลิก) ไม่ขึ้นวันที่', () => {
    const h = html(<NextStepBar step={step({ who: [], title: 'ปิดงานแล้ว' })} user={user('admin')} today="2026-11-23" />)
    expect(h).toContain('ไม่มีผู้ต้องทำ')
    expect(h).not.toContain('ถึงคิวคุณ')
    expect(h).not.toContain('📅')
  })
})

describe('PendingBadge — รอ Division พิจารณา', () => {
  const db = { users: [user('project')].map(u => ({ ...u, id: 'u-p', fullName: 'วิชัย' })) } as unknown as DB
  it('ไม่มีคำขอ = ไม่แสดงอะไร', () => {
    expect(html(<PendingBadge db={db} reqs={[]} />)).toBe('')
  })
  it('แสดงจำนวน · ประเภทคำขอ · ผู้ส่ง · ลิงก์ไปหน้ารออนุมัติ', () => {
    const h = html(<PendingBadge db={db} reqs={[
      { id: 'a', type: 'create_pr', jobId: 'j1', payload: {}, status: 'pending', requestedBy: 'u-p', requestedAt: '2026-11-20T03:00:00Z' },
      { id: 'b', type: 'return_lbs', jobId: 'j1', payload: {}, status: 'pending', requestedBy: 'u-p', requestedAt: '2026-11-21T03:00:00Z' },
    ]} />)
    expect(h).toContain('รอ Division พิจารณา 2 คำขอ')
    expect(h).toContain('ออก PR')
    expect(h).toContain('คืน LBS เข้าคลัง')
    expect(h).toContain('ส่งโดย วิชัย')
    expect(h).toContain('href="/approvals"')
  })
})

describe('ConfirmSummary — สรุปก่อนกดคำสั่งที่ย้อนไม่ได้', () => {
  it('มีคำเตือนย้อนไม่ได้ + รายการผลที่จะเกิด', () => {
    const h = html(<ConfirmSummary items={['LBS 2 เครื่องกลับคลัง', 'PR ที่ค้างถูกยกเลิก']} />)
    expect(h).toContain('ย้อนกลับไม่ได้')
    expect(h).toContain('<li>LBS 2 เครื่องกลับคลัง</li>')
  })
  it('irreversible=false ไม่ขึ้นคำเตือน', () => {
    expect(html(<ConfirmSummary items={['x']} irreversible={false} />)).not.toContain('ย้อนกลับไม่ได้')
  })
})

describe('MyWorkPanel — กล่องงานของฉัน (เฟส 3)', () => {
  const item = (over: Partial<WorkItem> = {}): WorkItem => ({
    key: 'job:j1', title: 'เบิกให้ Service', detail: 'ของครบแล้ว', jobId: 'j1', jobNo: 'J-001', customer: 'กฟภ.',
    link: '/jobs/j1', lateDays: 0, tone: 'blue', ...over,
  })
  it('ไม่มีงาน: บอกว่าไม่มีงานรอ · VIP บอกว่าเป็นมุมมองภาพรวม', () => {
    expect(html(<MyWorkPanel items={[]} user={user('project')} today="2026-11-23" />)).toContain('ไม่มีงานที่รอคุณ')
    expect(html(<MyWorkPanel items={[]} user={user('vip')} today="2026-11-23" />)).toContain('ไม่มีงานที่ต้องลงมือ')
  })
  it('แต่ละรายการ: ต้องทำอะไร · งานไหน · ค้างกี่วัน/เลยกี่วัน · ปุ่มไปทำทันที', () => {
    const h = html(<MyWorkPanel user={user('project')} today="2026-11-23" items={[
      item({ key: 'a', lateDays: 3, due: '2026-11-20', dueLabel: 'กำหนดส่ง', tone: 'red' }),
      item({ key: 'b', title: 'พิจารณาคำขอ: ออก PR', link: '/approvals?id=x', waitingDays: 9, tone: 'amber' }),
      item({ key: 'c', due: '2026-11-30', dueLabel: 'กำหนดส่ง' }),
    ]} />)
    expect(h).toContain('งานของฉัน')
    expect(h).toContain('mywork-count">3<')
    expect(h).toContain('เลยกำหนดส่ง 3 วัน')
    expect(h).toContain('ค้าง 9 วัน')
    expect(h).toContain('อีก 7 วัน')
    expect(h).toContain('J-001')
    expect(h).toContain('href="/approvals?id=x"')
    expect(h).toContain('ไปทำ')
  })
  it('รายการเกินที่กำหนด: ซ่อนส่วนที่เหลือไว้ใต้ "ดูอีก n รายการ"', () => {
    const items = Array.from({ length: 10 }, (_, i) => item({ key: String(i) }))
    const h = html(<MyWorkPanel items={items} user={user('admin')} limit={8} today="2026-11-23" />)
    expect(h).toContain('ดูอีก 2 รายการ')
  })
})
