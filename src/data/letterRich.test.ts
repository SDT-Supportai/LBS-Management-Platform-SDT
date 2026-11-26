// =============================================================================
// Letters แบบ Word (2026-11-26) — เนื้อความ HTML · รูป · ตรวจคำผิด · จัดรูปแบบอัตโนมัติ (logic ล้วน)
//   คำตอบผู้ใช้: ฟังก์ชันพื้นฐาน + ตาราง + หน้า A4 + แก้จดหมายที่ออกแล้ว · รูปเก็บใน bucket · พจนานุกรมในระบบ
// =============================================================================
import { describe, it, expect } from 'vitest'
import {
  sanitizeLetterHtml, isRichBody, bodyToHtml, letterImagePaths, resolveLetterImages, LETTER_IMG_PREFIX,
  findMisspellings, fixMisspellings, autoFormatThai, richToPlainText,
} from './letterRich'

const IMG = `${LETTER_IMG_PREFIX}3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90.jpg`

describe('sanitizeLetterHtml — 🔴 เนื้อความถูกวางในแท็บพิมพ์ (origin เดียวกับแอป) และใน contentEditable', () => {
  it('คงรูปแบบพื้นฐานของ Word: ตัวหนา/เอียง/ขีดเส้นใต้ · ย่อหน้า · จัดชิด · ขนาดตัวอักษร · รายการ', () => {
    const h = sanitizeLetterHtml('<p style="text-align: center; font-size: 18pt">หัวเรื่อง <b>หนา</b> <i>เอียง</i> <u>เส้น</u></p><ul><li>ก</li></ul><ol><li>ข</li></ol>')
    expect(h).toBe('<p style="text-align:center;font-size:18pt">หัวเรื่อง <b>หนา</b> <i>เอียง</i> <u>เส้น</u></p><ul><li>ก</li></ul><ol><li>ข</li></ol>')
  })
  it('ตาราง (colspan/rowspan) ผ่าน', () => {
    const h = sanitizeLetterHtml('<table><tbody><tr><td colspan="2">ก</td></tr><tr><td rowspan="1">ข</td><td>ค</td></tr></tbody></table>')
    expect(h).toBe('<table><tbody><tr><td colspan="2">ก</td></tr><tr><td rowspan="1">ข</td><td>ค</td></tr></tbody></table>')
  })
  it('🔴 ตัด script / style / iframe ทั้งก้อน · ตัด on* · javascript: · แท็กที่ไม่รู้จักเหลือแต่ข้อความ', () => {
    const h = sanitizeLetterHtml('<p onclick="x()">ก<script>alert(1)</script><style>p{}</style><iframe src="x"></iframe><a href="javascript:alert(1)">ลิงก์</a><font color="red">แดง</font></p>')
    expect(h).toBe('<p>กลิงก์แดง</p>')
  })
  it('🔴 รูป: รับเฉพาะ path ใน bucket ของระบบ หรือ data URL รูปล้วน · อย่างอื่นทิ้งทั้งแท็ก', () => {
    expect(sanitizeLetterHtml(`<img src="${IMG}" style="width:50%">`)).toBe(`<img src="${IMG}" style="width:50%">`)
    expect(sanitizeLetterHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe('<img src="data:image/png;base64,iVBORw0KGgo=">')
    for (const bad of ['<img src="https://evil.com/x.png">', '<img src="x" onerror="alert(1)">', '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
      `<img src="${LETTER_IMG_PREFIX}../../x.jpg">`, '<img src="javascript:alert(1)">'])
      expect(sanitizeLetterHtml(bad), bad).toBe('')
  })
  it('🔴 style: รับเฉพาะคุณสมบัติ/ค่าที่อนุญาต (กัน url() / expression)', () => {
    expect(sanitizeLetterHtml('<p style="color:red;background:url(javascript:x);font-size:16pt;text-indent:15mm;margin-left:40px">ก</p>'))
      .toBe('<p style="font-size:16pt;text-indent:15mm;margin-left:40px">ก</p>')
    expect(sanitizeLetterHtml('<span style="font-size:999pt">ก</span>')).toBe('<span>ก</span>')
  })
  it('🔴 attribute ที่ปิดไม่ครบ / เครื่องหมายคำพูดหลุด ไม่ทะลุออกมาเป็นโค้ด', () => {
    const h = sanitizeLetterHtml('<p title="a" onmouseover=alert(1) style=\'font-size:16pt\'>"><img src=x onerror=alert(1)>ข</p>')
    expect(h).not.toMatch(/on\w+=/i)
    expect(h).not.toContain('<img')
    expect(h).toContain('ข')
  })
  it('ข้อความ escape · entity ที่มีอยู่แล้วไม่ถูก escape ซ้ำ · แท็กเปิดค้างถูกปิดให้', () => {
    expect(sanitizeLetterHtml('<p>a &lt; b &amp; c&nbsp;d 5 > 3')).toBe('<p>a &lt; b &amp; c d 5 &gt; 3</p>')
    expect(sanitizeLetterHtml('<b>ก<i>ข</b>ค')).toBe('<b>ก<i>ข</i></b>ค')
  })
  it('div จาก contentEditable → p · br คงไว้', () => {
    expect(sanitizeLetterHtml('<div>ก<br>ข</div>')).toBe('<p>ก<br>ข</p>')
  })
})

describe('isRichBody / bodyToHtml — จดหมายเก่าเป็นข้อความล้วน ต้องแสดงเหมือนเดิม', () => {
  it('ข้อความล้วน → ย่อหน้าละบรรทัด escape แล้ว · HTML → ผ่าน sanitizer', () => {
    expect(isRichBody('บรรทัด 1\nบรรทัด 2')).toBe(false)
    expect(isRichBody('<p>ก</p>')).toBe(true)
    expect(bodyToHtml('a < b\nบรรทัด 2')).toBe('<p>a &lt; b</p><p>บรรทัด 2</p>')
    expect(bodyToHtml('<p onclick="x">ก</p>')).toBe('<p>ก</p>')
    expect(bodyToHtml('')).toBe('')
  })
  it('richToPlainText — สำหรับค้นหา/ตรวจคำผิด/ข้อความใน Audit', () => {
    expect(richToPlainText('<p>ก <b>ข</b></p><p>ค&amp;ง</p>')).toBe('ก ข\nค&ง')
  })
})

describe('รูปในจดหมาย — เก็บ path ใน bucket · แทนด้วย signed URL ตอนแสดง', () => {
  it('letterImagePaths ดึง path รูปของระบบ (ไม่ซ้ำ)', () => {
    expect(letterImagePaths(`<p><img src="${IMG}"><img src="${IMG}"><img src="data:image/png;base64,AA=="></p>`)).toEqual([IMG])
  })
  it('resolveLetterImages: path → URL ที่ให้มา (+ data-path ไว้แปลงกลับ) · ไม่มี URL = ตัดรูปทิ้ง', () => {
    const url = 'https://x.supabase.co/storage/v1/object/sign/letter-docs/a.jpg?token=abc'
    expect(resolveLetterImages(`<img src="${IMG}">`, { [IMG]: url })).toBe(`<img src="${url}" data-path="${IMG}">`)
    expect(resolveLetterImages(`<img src="${IMG}">`, {})).toBe('')
  })
  it('sanitize แปลง src ที่ resolve แล้วกลับเป็น path (มี data-path) — ไม่เก็บ signed URL ลง DB', () => {
    expect(sanitizeLetterHtml(`<img src="https://x/y?token=1" data-path="${IMG}">`)).toBe(`<img src="${IMG}">`)
    expect(sanitizeLetterHtml('<img src="https://x/y?token=1" data-path="../../etc">')).toBe('')
  })
})

describe('ตรวจคำผิด (พจนานุกรมในระบบ)', () => {
  it('พบคำที่มักเขียนผิด + คำที่ถูก + ตำแหน่ง', () => {
    const r = findMisspellings('ขออนุญาติติดตั้ง ตามกฏหมาย ลายเซ็นต์')
    expect(r.map(x => [x.wrong, x.right])).toEqual([['อนุญาติ', 'อนุญาต'], ['กฏหมาย', 'กฎหมาย'], ['ลายเซ็นต์', 'ลายเซ็น']])
    expect(r[0].index).toBe(2)
  })
  it('🔴 ไม่แจ้งผิดในคำที่ถูก (ไทยไม่มีช่องว่างคั่นคำ — ต้องไม่ชนคำถูกที่มีคำผิดอยู่ข้างใน)', () => {
    expect(findMisspellings('ปรากฏ ปฏิบัติ สังเกต อนุญาต มาตรฐาน กฎหมาย ลายเซ็น ประสบการณ์ อีเมล เว็บไซต์ ต่าง ๆ')).toEqual([])
  })
  it('fixMisspellings แก้ทั้งหมด', () => {
    expect(fixMisspellings('ขออนุญาติ และ ปฎิบัติตามกฏหมาย')).toBe('ขออนุญาต และ ปฏิบัติตามกฎหมาย')
  })
})

describe('จัดรูปแบบประโยคอัตโนมัติ (แบบหนังสือราชการไทย)', () => {
  it('ช่องว่างซ้ำ → 1 · ตัดช่องว่างหัวท้าย', () => {
    expect(autoFormatThai('  ก   ข  ')).toBe('ก ข')
  })
  it('ไม้ยมก: วรรคหน้าและหลัง (ต่างๆนานา → ต่าง ๆ นานา) · ท้ายข้อความไม่เติม', () => {
    expect(autoFormatThai('ต่างๆนานา')).toBe('ต่าง ๆ นานา')
    expect(autoFormatThai('เร็วๆ')).toBe('เร็ว ๆ')
  })
  it('เว้นวรรคระหว่างอักษรไทยกับตัวเลข/อังกฤษ', () => {
    expect(autoFormatThai('ติดตั้งLoad Break Switchจำนวน2ชุด')).toBe('ติดตั้ง Load Break Switch จำนวน 2 ชุด')
  })
  it('ไม่แตะเลขที่/อักษรย่อ/ตัวเลขทศนิยม/เครื่องหมายวรรคตอนติดคำ', () => {
    expect(autoFormatThai('พ.ศ. 2569 เลขที่ PSP-LBSJ3076-2026-001 ราคา 1,250.50 บาท (สามรายการ)')).toBe('พ.ศ. 2569 เลขที่ PSP-LBSJ3076-2026-001 ราคา 1,250.50 บาท (สามรายการ)')
  })
})
