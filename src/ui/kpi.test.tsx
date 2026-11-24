// Dashboard — การ์ด KPI แบบ Glass ตาม canvas หน้า 2 (แถบสัดส่วน · คำอธิบายสี · วงแหวนติดตั้ง)
//   ชิ้นแสดงผลล้วน: ตัวเลขทั้งหมดคำนวณใน DashboardPage จากที่มาเดิม (ไม่แตะ Flow)
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { StackBar, KpiLegend, ProgressRing, lbsCountTone } from './kpi'

const html = (el: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)

describe('StackBar — แถบสัดส่วน', () => {
  it('กว้างตามสัดส่วนของทั้งหมด (ไม่ยืดเต็มถ้าส่วนที่แสดงไม่ครบ) · ส่วนที่เป็น 0 ไม่วาด', () => {
    const h = html(<StackBar total={50} parts={[
      { label: 'พร้อมดึง', value: 0, tone: 'green' },
      { label: 'รอเข้าคลัง', value: 30, tone: 'amber' },
      { label: 'เบิกติดตั้งแล้ว', value: 10, tone: 'blue' },
    ]} />)
    expect(h).toContain('width:60%')
    expect(h).toContain('width:20%')
    expect(h).not.toContain('kpi-seg green')
    expect(h).toContain('kpi-seg amber')
    // อ่านด้วย screen reader ได้ (ไม่ใช่แค่สี)
    expect(h).toContain('role="img"')
    expect(h).toContain('aria-label="รอเข้าคลัง 30 · เบิกติดตั้งแล้ว 10 จาก 50"')
  })
  it('ทั้งหมด = 0 ไม่หารศูนย์ · ไม่มีส่วนไหนเกิน 100%', () => {
    expect(html(<StackBar total={0} parts={[{ label: 'a', value: 0, tone: 'blue' }]} />)).not.toContain('NaN')
    const h = html(<StackBar total={10} parts={[{ label: 'a', value: 8, tone: 'blue' }, { label: 'b', value: 8, tone: 'amber' }]} />)
    const widths = [...h.matchAll(/width:([\d.]+)%/g)].map(m => Number(m[1]))
    expect(widths.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(100)
  })
})

describe('KpiLegend — คำอธิบายสี + ตัวเลข', () => {
  it('จุดสี + ชื่อ + ตัวเลข · มีลิงก์เมื่อส่ง to · ค่าเน้นสีตาม emphasis เฉพาะเมื่อ > 0', () => {
    const h = html(<KpiLegend items={[
      { label: 'พร้อมเบิก', value: 3, tone: 'green', to: '/jobs?f=ready_to_issue' },
      { label: 'ต้องเร่ง', value: 0, tone: 'red', emphasis: 'red', to: '/jobs?f=at_risk' },
      { label: 'รอเข้าคลัง', value: 48, tone: 'amber', emphasis: 'amber', title: 'ยังไม่ถึงคลัง' },
    ]} />)
    expect(h).toContain('kpi-dot green')
    expect(h).toContain('href="/jobs?f=ready_to_issue"')
    expect(h).toContain('title="ยังไม่ถึงคลัง"')
    expect(h).toMatch(/class="kpi-num amber"[^>]*>48</)
    expect(h).not.toMatch(/class="kpi-num red"/)          // 0 ไม่ต้องเตือนแดง
  })
})

describe('ProgressRing — วงแหวนติดตั้ง', () => {
  it('ครบทุกเครื่อง: วงเต็ม สีเขียว มีเครื่องหมายถูก', () => {
    const h = html(<ProgressRing done={2} total={2} />)
    expect(h).toContain('aria-label="ติดตั้งแล้ว 2 จาก 2 เครื่อง"')
    expect(h).toContain('kpi-ring-check')
    expect(h).toContain('kpi-ring-bar done')
  })
  it('ยังไม่ครบ: ไม่มีเครื่องหมายถูก · ความยาววงตามสัดส่วน', () => {
    const h = html(<ProgressRing done={1} total={4} />)
    expect(h).not.toContain('kpi-ring-check')
    expect(h).not.toContain('kpi-ring-bar done')
    expect(h).toMatch(/stroke-dasharray="59\.\d+ 238\.\d+"/)   // 25% ของเส้นรอบวง r=38
  })
  it('ยังไม่มีเครื่องที่เบิก (0/0): วงว่าง ไม่ขึ้นถูก ไม่ NaN', () => {
    const h = html(<ProgressRing done={0} total={0} />)
    expect(h).not.toContain('kpi-ring-check')
    expect(h).not.toContain('NaN')
  })
})

describe('สีตัวเลข LBS ใน Job List', () => {
  it('ดึงครบตาม Scope = ok (เขียว) · ยังไม่ครบ = short (น้ำตาล) · Scope 0 = short', () => {
    expect(lbsCountTone(1, 1)).toBe('ok')
    expect(lbsCountTone(3, 2)).toBe('ok')
    expect(lbsCountTone(0, 1)).toBe('short')
    expect(lbsCountTone(0, 0)).toBe('short')
  })
})
