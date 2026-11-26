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
  it('GENERAL: หัวกระดาษ + เลขที่ + วันที่เดือนชื่อเต็ม พ.ศ. ([Flow 2026-11-25]) + ป้ายหนังสือภายนอก/ภายใน', () => {
    const h = buildLetterHtml(lt())
    expect(h).toContain('PSP-LBS-2026-016')
    expect(h).toContain('25 พฤศจิกายน 2569')
    expect(h).not.toContain('25-11-2026')
    expect(h).toContain('หนังสือภายนอก')
    expect(buildLetterHtml(lt({ letterType: 'INTERNAL' }))).toContain('หนังสือภายใน')
    expect(h).toContain(LETTER_ORG_DEFAULT.name)
  })
  it('SM: รายชื่อเจ้าหน้าที่เป็นลำดับ + เบอร์ · วันที่เดือนชื่อเต็ม · ผู้รับขึ้นบรรทัดใหม่', () => {
    const h = buildLetterHtml(lt({ category: 'SM', recipient: 'กฟภ.\nฝ่ายปฏิบัติการ', techList: 'สมชาย | 081\nสมศรี' }))
    expect(h).toContain('25 พฤศจิกายน 2569')
    expect(h).toContain('1. สมชาย')
    expect(h).toContain('เบอร์ 081')
    expect(h).toContain('2. สมศรี')
    expect(h).toContain('กฟภ.<br>ฝ่ายปฏิบัติการ')
  })
  it('WARRANTY: กล่องประเภท + ระยะเวลารับประกัน', () => {
    const h = buildLetterHtml(lt({ category: 'WARRANTY', warrantyType: 'LBS', warrantyStart: '2026-01-01', warrantyEnd: '2028-01-01' }))
    expect(h).toContain('ประเภทการรับประกัน')
    expect(h).toContain('1 มกราคม 2569 ถึง 1 มกราคม 2571')
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
  it('[ปรับ 2026-11-25] โลโก้ PRECISE + แถบสีท้ายกระดาษ (public/letter-logo.png · letter-banner.png) ผ่าน lbsLetterOrg(origin)', () => {
    const org = lbsLetterOrg('http://localhost:5200')
    expect(org.logoUrl).toBe('http://localhost:5200/letter-logo.png')
    expect(org.bannerUrl).toBe('http://localhost:5200/letter-banner.png')
    expect(org.name).toBe(LETTER_ORG_DEFAULT.name)
  })
  it('โลโก้/แถบท้ายกระดาษ: ไม่ตั้งค่า = ไม่วาด <img> ว่าง · URL ไม่ปลอดภัย = ไม่วาด', () => {
    const h = buildLetterHtml(lt({ category: 'SM' }))
    expect(h).not.toContain('class="banner"')
    expect(h).not.toMatch(/<img class="logo" src=""/)
    const h2 = buildLetterHtml(lt({ category: 'SM' }), { ...LETTER_ORG_DEFAULT, logoUrl: 'javascript:alert(1)' })
    expect(h2).not.toContain('javascript:')
  })
})

describe('[ผูกระบบ 2026-11-25] Official Letter (GENERAL) รองรับลายเซ็น 2 แบบเหมือน SM/WARRANTY', () => {
  it('มีลายเซ็นอิเล็กทรอนิกส์ = วางรูปเหนือชื่อ · ไม่มี = เว้นที่ให้เซ็นมือ', () => {
    const signed = buildLetterHtml(lt({ sigImage: PNG, signerName: 'นาย ก' }))
    expect(signed).toContain(`<img class="sig" src="${PNG}"`)
    expect(signed).not.toContain('class="sig-space"')
    const hand = buildLetterHtml(lt({ signerName: 'นาย ก' }))
    expect(hand).toContain('class="sig-space"')
    expect(hand).not.toContain('class="sig"')
  })
  it('🔴 ลายเซ็นปลอมใน GENERAL ก็ไม่ถูกวาง', () => {
    const h = buildLetterHtml(lt({ sigImage: 'x" onerror="alert(1)' }))
    expect(h).not.toContain('onerror')
  })
})

// =============================================================================
// ปรับตามไฟล์แนบ (2026-11-25) — หัว/ท้ายกระดาษเดียวกันทุกแบบ · TH SarabunPSK 16 · การอ้างอิง Contract No. / Job No.
// =============================================================================
describe('[ปรับ 2026-11-25] หัว/ท้ายกระดาษตามไฟล์แนบ — ทั้ง 3 แบบ', () => {
  const org = lbsLetterOrg('https://lbs.example.com')
  for (const category of ['GENERAL', 'SM', 'WARRANTY'] as const) {
    it(`${category}: โลโก้ PRECISE ซ้าย · ที่อยู่บริษัทขวา · ท้ายกระดาษ ชื่อแผนก + อีเมล + แถบสี`, () => {
      const h = buildLetterHtml(lt({ category }), org)
      expect(h).toContain('<img class="logo" src="https://lbs.example.com/letter-logo.png"')
      expect(h).toContain('1/333 Moo 9, Chaengwattana Road')
      expect(h).toContain('T : +66(0)2 584 2367')
      expect(h).toContain('Service &amp; Maintenance Section')
      expect(h).toContain('psp102.service@precise.co.th')
      expect(h).toContain('<img class="banner" src="https://lbs.example.com/letter-banner.png"')
    })
    it(`${category}: ฟอนต์ TH SarabunPSK ขนาด 16`, () => {
      const h = buildLetterHtml(lt({ category }), org)
      expect(h).toMatch(/body\{font-family:'TH SarabunPSK'/)
      expect(h).toContain('font-size:16pt')
    })
  }
})

describe('[ปรับ 2026-11-25] การอ้างอิงตามประเภทหนังสือ', () => {
  it('Official Letter ภายนอก → อ้างอิง Contract No. (ไม่แสดง Job No.)', () => {
    const h = buildLetterHtml(lt({ letterType: 'EXTERNAL', contractNo: 'CT-2026-0103' }), LETTER_ORG_DEFAULT, 'JOB-2026-0003')
    expect(h).toContain('Contract No. CT-2026-0103')
    expect(h).not.toContain('JOB-2026-0003')
  })
  it('Official Letter ภายใน → อ้างอิง Job No. (ไม่แสดง Contract No.)', () => {
    const h = buildLetterHtml(lt({ letterType: 'INTERNAL', contractNo: 'CT-2026-0103' }), LETTER_ORG_DEFAULT, 'JOB-2026-0003')
    expect(h).toContain('Job No. JOB-2026-0003')
    expect(h).not.toContain('CT-2026-0103')
  })
  for (const category of ['SM', 'WARRANTY'] as const) {
    it(`${category} → อ้างอิง 1. Contract No. 2. โครงการ Job No.`, () => {
      const h = buildLetterHtml(lt({ category, contractNo: 'CT-2026-0104' }), LETTER_ORG_DEFAULT, 'JOB-2026-0004')
      expect(h).toContain('1. Contract No. CT-2026-0104')
      expect(h).toContain('2. โครงการ Job No. JOB-2026-0004')
    })
  }
  it('ไม่มีทั้ง Contract No. และ Job = ไม่มีบล็อกอ้างอิง · มีอย่างเดียว = อีกบรรทัดเป็น "-"', () => {
    expect(buildLetterHtml(lt({ category: 'SM' }))).not.toContain('Contract No.')
    const h = buildLetterHtml(lt({ category: 'SM' }), LETTER_ORG_DEFAULT, 'JOB-2026-0004')
    expect(h).toContain('1. Contract No. -')
    expect(h).toContain('2. โครงการ Job No. JOB-2026-0004')
  })
  it('🔴 Contract No. ถูก escape', () => {
    const h = buildLetterHtml(lt({ contractNo: '<b>x</b>' }))
    expect(h).not.toContain('<b>x</b>')
  })
})
