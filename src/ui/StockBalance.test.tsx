// Dashboard — LBS Stock Balance แบบการ์ด Glass ตาม canvas หน้า 2 (เดิมเป็นตาราง 8 คอลัมน์)
//   ตัวเลขทุกตัวในตารางเดิมยังต้องเห็นได้ (ไม่มีอะไรหาย) — แค่จัดเป็นแถวต่อคลัง + แถบสัดส่วน + สรุปท้ายการ์ด
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { StockBalanceCard, type StockSum } from './StockBalance'

const html = (el: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>)
const sum = (o: Partial<StockSum>): StockSum =>
  ({ total: 0, onHand: 0, pending: 0, unknown: 0, allocated: 0, issued: 0, noContract: 0, ...o })

const s1 = sum({ total: 30, onHand: 4, unknown: 22, noContract: 18, allocated: 3, issued: 1 })
const s2 = sum({ total: 6, pending: 6 })
const totals = sum({ total: 36, onHand: 4, pending: 6, unknown: 22, noContract: 18, allocated: 3, issued: 1 })

describe('StockBalanceCard', () => {
  it('แถวต่อคลัง: ชื่อ (ลิงก์ไปหน้าคลัง) · ยอดรวม · แถบสัดส่วน · ปิดคลังมีป้าย', () => {
    const h = html(<StockBalanceCard rows={[
      { id: 'a', stockNo: 'Project Stock No.1', closed: false, sum: s1 },
      { id: 'b', stockNo: 'Project Stock No.3', closed: true, sum: s2 },
    ]} totals={totals} />)
    expect(h).toContain('Project Stock No.1')
    expect(h).toMatch(/href="\/stocks"/)
    expect(h).toContain('ปิดคลัง')
    expect((h.match(/class="kpi-bar"/g) ?? []).length).toBe(2)
    expect(h).toContain('aria-label="On Hand 4 · ไม่ระบุ ETA 22 · ถูกดึงเข้า Job 3 · เบิกติดตั้งแล้ว 1 จาก 30"')
  })

  it('ตัวเลขทุกคอลัมน์ของตารางเดิมยังเห็น (เฉพาะที่มีค่า) · ไม่มี Contract No. เป็นสีแดง', () => {
    const h = html(<StockBalanceCard rows={[{ id: 'a', stockNo: 'S1', closed: false, sum: s1 }]} totals={s1} />)
    for (const t of ['On Hand 4', 'ไม่ระบุ ETA 22', 'ไม่มี Contract No. 18', 'ถูกดึงเข้า Job 3', 'เบิกติดตั้งแล้ว 1']) expect(h, t).toContain(t)
    expect(h).not.toContain('Pending 0')
    expect(h).toMatch(/class="sb-warn"[^>]*>ไม่มี Contract No\. 18/)
  })

  it('สรุปท้ายการ์ด: รวมทุกคลัง · On Hand (0 = แดง) · Pending · ถูกดึงเข้า Job · เบิกแล้ว · ลิงก์เครื่องที่ไม่มี Contract No.', () => {
    const h = html(<StockBalanceCard rows={[{ id: 'b', stockNo: 'S3', closed: false, sum: s2 }]} totals={s2} />)
    expect(h).toMatch(/class="sb-tile-n red"[^>]*>0</)        // On Hand 0
    expect(h).toMatch(/class="sb-tile-n amber"[^>]*>6</)      // Pending 6
    expect(h).toContain('รวมทุกคลัง')
    const h2 = html(<StockBalanceCard rows={[{ id: 'a', stockNo: 'S1', closed: false, sum: s1 }]} totals={s1} />)
    expect(h2).toContain('href="/stocks?f=no_contract"')
  })

  it('ยังไม่มีคลัง: ขึ้นข้อความว่าง ไม่มีแถบ', () => {
    const h = html(<StockBalanceCard rows={[]} totals={sum({})} />)
    expect(h).toContain('ยังไม่มี Project Stock')
    expect(h).not.toContain('kpi-bar')
  })
})
