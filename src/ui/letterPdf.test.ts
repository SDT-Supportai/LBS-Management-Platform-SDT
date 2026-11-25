// เอกสารพิมพ์ Service Letter (แม่แบบยกจาก ServiceMS smLetter / warrantyLetter / Official Letter)
//   สร้าง HTML ฝั่งเบราว์เซอร์ (LBS ไม่มี Edge Function) แล้วเปิดแท็บพิมพ์
import { describe, it, expect } from 'vitest'
import { buildLetterHtml, LETTER_ORG_DEFAULT, lbsLetterOrg } from './letterPdf'
import type { ServiceLetter } from '../data/letters'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const lt = (o: Partial<ServiceLetter> = {}): ServiceLetter => ({
  id: 'l1', letterNo: 'PSP-LBS-2026-016', letterDate: '2026-11-25', category: 'GENERAL', letterType: 'EXTERNAL',
  status: 'ISSUED', recipient: 'ผู้จัดการ', recipientOrg: 'กฟภ.', subject: 'เรื่องทดสอบ', body: 'บรรทัด 1\nบรรทัด 2',
  createdBy: 'u1', createdAt: '2026-11-25T02:00:00.000Z', ...o,
})

describe('buildLetterHtml — เลือกแม่แบบตามประเภท', () => {
  it('GENERAL: หัวกระดาษ + เลขที่ + วันที่ DD/MM/YYYY + ป้ายหนังสือภายนอก/ภายใน', () => {
    const h = buildLetterHtml(lt())
    expect(h).toContain('PSP-LBS-2026-016')
    expect(h).toContain('25/11/2026')
    expect(h).toContain('หนังสือภายนอก')
    expect(buildLetterHtml(lt({ letterType: 'INTERNAL' }))).toContain('หนังสือภายใน')
    expect(h).toContain(LETTER_ORG_DEFAULT.name)
  })
  it('SM: รายชื่อเจ้าหน้าที่เป็นลำดับ + เบอร์ · วันที่ DD-MM-YYYY · ผู้รับขึ้นบรรทัดใหม่', () => {
    const h = buildLetterHtml(lt({ category: 'SM', recipient: 'กฟภ.\nฝ่ายปฏิบัติการ', techList: 'สมชาย | 081\nสมศรี' }))
    expect(h).toContain('25-11-2026')
    expect(h).toContain('1. สมชาย')
    expect(h).toContain('เบอร์ 081')
    expect(h).toContain('2. สมศรี')
    expect(h).toContain('กฟภ.<br>ฝ่ายปฏิบัติการ')
  })
  it('WARRANTY: กล่องประเภท + ระยะเวลารับประกัน', () => {
    const h = buildLetterHtml(lt({ category: 'WARRANTY', warrantyType: 'LBS', warrantyStart: '2026-01-01', warrantyEnd: '2028-01-01' }))
    expect(h).toContain('ประเภทการรับประกัน')
    expect(h).toContain('01-01-2026 ถึง 01-01-2028')
  })
})

describe('[debug 2026-11-25] พื้นกระดาษ', () => {
  it('กำหนดพื้นขาวเอง — เดิมไม่กำหนด เบราว์เซอร์บางตัวแสดงพื้นเทา (เจอตอนแสดงตัวอย่าง)', () => {
    for (const category of ['GENERAL', 'SM', 'WARRANTY'] as const)
      expect(buildLetterHtml(lt({ category })), category).toMatch(/html,body\{margin:0;background:#fff\}/)
  })
})

describe('buildLetterHtml — ความปลอดภัย (แท็บพิมพ์เป็น origin เดียวกับแอป)', () => {
  it('🔴 escape ข้อความผู้ใช้ทุกช่อง รวมเครื่องหมายคำพูด', () => {
    const h = buildLetterHtml(lt({ subject: '<script>alert(1)</script>', recipient: '"><img src=x onerror=1>' }))
    expect(h).not.toContain('<script>alert')
    expect(h).not.toContain('<img src=x')
    expect(h).toContain('&lt;script&gt;')
  })
  it('🔴 ลายเซ็นที่ไม่ใช่ data URL รูปล้วน (ข้อมูลเก่า/ปลอม) ไม่ถูกวาง · ลายเซ็นถูกต้องวางได้', () => {
    const bad = buildLetterHtml(lt({ category: 'SM', sigImage: 'x" onerror="alert(1)' }))
    expect(bad).not.toContain('onerror')
    expect(bad).not.toContain('class="sig"')
    expect(buildLetterHtml(lt({ category: 'SM', sigImage: PNG }))).toContain(`<img class="sig" src="${PNG}"`)
  })
  it('ไม่มีลายเซ็นอิเล็กทรอนิกส์ = เว้นที่ให้เซ็นมือ (คำตอบผู้ใช้ข้อ 4) ทั้ง SM และ WARRANTY', () => {
    for (const category of ['SM', 'WARRANTY'] as const) {
      const h = buildLetterHtml(lt({ category, signerName: 'นาย ก' }))
      expect(h, category).toContain('class="sig-space"')
      expect(h).toContain('( นาย ก )')
    }
    expect(buildLetterHtml(lt({ category: 'SM', sigImage: PNG }))).not.toContain('class="sig-space"')
  })
  it('โลโก้ LBS เดิม (public/logo.jpg) ผ่าน lbsLetterOrg(origin) — dev (http://localhost) ก็ใช้ได้', () => {
    const org = lbsLetterOrg('http://localhost:5200')
    expect(org.logoUrl).toBe('http://localhost:5200/logo.jpg')
    expect(org.name).toBe(LETTER_ORG_DEFAULT.name)
    expect(buildLetterHtml(lt({ category: 'SM' }), org)).toContain('<img class="logo" src="http://localhost:5200/logo.jpg"')
    expect(buildLetterHtml(lt(), org)).toContain('src="http://localhost:5200/logo.jpg"')
  })
  it('โลโก้/แถบท้ายกระดาษ: ไม่ตั้งค่า = ไม่วาด <img> ว่าง · URL ไม่ปลอดภัย = ไม่วาด', () => {
    const h = buildLetterHtml(lt({ category: 'SM' }))
    expect(h).not.toContain('class="banner"')
    expect(h).not.toMatch(/<img class="logo" src=""/)
    const h2 = buildLetterHtml(lt({ category: 'SM' }), { ...LETTER_ORG_DEFAULT, logoUrl: 'javascript:alert(1)' })
    expect(h2).not.toContain('javascript:')
  })
})
