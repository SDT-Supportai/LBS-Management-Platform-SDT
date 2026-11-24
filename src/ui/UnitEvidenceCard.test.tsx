// ธีม LBS Glass UI — การ์ดหลักฐานติดตั้งรายเครื่อง (Service Installation · canvas หน้า 7 "Popup รายเครื่อง")
//   ชิ้นแสดงผลล้วน: ปุ่ม/สิทธิ์/สถานะ ส่งมาจาก ServicePage ทาง slot (status / actions) — การ์ดไม่ตัดสินอะไรเอง
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnitEvidenceCard } from './UnitEvidenceCard'

const html = (el: JSX.Element) => renderToStaticMarkup(el)
const base = { serialLvb: 'C106406', serialOm: 'OM-1', site: <>จุดที่ 1</>, status: <span className="badge green">ติดตั้งแล้ว</span>, actions: <button>ขอยกเลิกผลติดตั้ง</button> }

describe('UnitEvidenceCard', () => {
  it('ติดตั้งแล้ว: รูปหน้างานเป็นภาพย่อ (กดเปิดรูปเต็มแท็บใหม่) + วันที่ ช่าง GPS บันทึก', () => {
    const h = html(<UnitEvidenceCard {...base} evidence={{
      date: '2026-09-16', by: 'สมชาย ใจดี', lat: 17.412351, lng: 102.787101,
      photoUrl: 'https://x.supabase.co/storage/v1/object/public/p/1.jpg', note: 'test energize ผ่าน',
    }} />)
    expect(h).toContain('<img')
    expect(h).toContain('src="https://x.supabase.co/storage/v1/object/public/p/1.jpg"')
    expect(h).toContain('alt="รูปถ่ายหน้างาน C106406"')
    expect(h).toContain('loading="lazy"')
    expect(h).toMatch(/<a [^>]*href="https:\/\/x\.supabase\.co[^"]*"[^>]*target="_blank"[^>]*rel="noreferrer"/)
    expect(h).toContain('สมชาย ใจดี')
    expect(h).toContain('test energize ผ่าน')
    expect(h).toContain('17.41235, 102.78710')
    expect(h).toContain('href="https://www.google.com/maps?q=17.412351,102.787101"')
    // slot ที่ส่งมาแสดงครบ
    expect(h).toContain('C106406')
    expect(h).toContain('OM-1')
    expect(h).toContain('จุดที่ 1')
    expect(h).toContain('ขอยกเลิกผลติดตั้ง')
  })

  it('🔴 รูปที่ไม่ใช่ http(s)/data:image ไม่ถูกวาด (กัน javascript: ใน src/href) — ขึ้นกล่องแทนรูป', () => {
    const h = html(<UnitEvidenceCard {...base} evidence={{ date: '2026-09-16', photoUrl: 'javascript:alert(1)' }} />)
    expect(h).not.toContain('<img')
    expect(h).not.toContain('javascript:')
    expect(h).toContain('ไม่มีรูป')
  })

  it('ยังไม่ติดตั้ง / ติดตั้งไม่ได้: ไม่มีแถวหลักฐาน · กล่องรูปบอกสถานะตาม photoLabel', () => {
    const h = html(<UnitEvidenceCard {...base} photoLabel="รอติดตั้ง" />)
    expect(h).not.toContain('<img')
    expect(h).toContain('รอติดตั้ง')
    expect(h).not.toContain('GPS')
    expect(h).not.toContain('ช่าง')
  })

  it('ไม่มีพิกัด/ช่าง/บันทึก = ไม่ขึ้นแถวนั้น (ไม่ขึ้น "-" ลอย ๆ)', () => {
    const h = html(<UnitEvidenceCard {...base} evidence={{ date: '2026-09-16' }} />)
    expect(h).not.toContain('GPS')
    expect(h).not.toContain('>ช่าง<')
    expect(h).not.toContain('บันทึก')
    expect(h).toContain('วันที่ติดตั้ง')
  })
})
