// Service Letter (ยกมาจาก ServiceMS · เตรียมรวม 2026-11-25) — logic ล้วน ยังไม่ผูกเข้า DB/เมนู
//   คำตอบผู้ใช้ 2026-11-25: ออก = Service+Project+Manage · เลข PSP-LBS-YYYY-NNN · ผู้ลงนามจาก dropdown ที่ Manage ตั้ง
//   (เซ็นอิเล็กทรอนิกส์ หรือเว้นที่เซ็นมือ) · แจ้งกระดิ่งไม่ส่ง LINE · ปุ่ม Warranty Letter เติมข้อมูลประกันให้
import { describe, it, expect } from 'vitest'
import {
  LETTER_PREFIX, nextLetterNo, safeSigImage, cleanLetterInput, parseTechList,
  canLetter, createLetterDemo, deleteLetterDemo, upsertSignerDemo, activeSigners, warrantyLetterPrefill,
  type ServiceLetter, type LetterSigner,
} from './letters'
import type { Job, JobWarranty, User } from '../types'

const user = (department: User['department'], id = 'u1'): User =>
  ({ id, email: `${id}@x`, password: '', fullName: 'ช่าง ก', department, isActive: true })
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const SIGNERS: LetterSigner[] = [
  { id: 's1', fullName: 'นาย ก ผู้จัดการ', position: 'ผู้จัดการแผนกบริการ', sortOrder: 1, isActive: true },
  { id: 's2', fullName: 'นาย ข เกษียณแล้ว', position: 'อดีตผู้จัดการ', sortOrder: 2, isActive: false },
]
const base = { recipient: 'กฟภ. เขต 1', subject: 'ขอแจ้งแผนเข้าดำเนินการ', body: 'เนื้อความ', signerId: 's1' }
const now = '2026-11-25T09:00:00.000Z'

describe('nextLetterNo — PSP-LBS-YYYY-NNN แยกจาก ServiceMS · รันร่วมทุกประเภท ต่อปี', () => {
  it('prefix = PSP-LBS', () => expect(LETTER_PREFIX).toBe('PSP-LBS'))
  it('ปีนี้ยังไม่มี = 001 · มีแล้ว = max+1 · ปีอื่น/prefix อื่น (เลข ServiceMS) ไม่นับ', () => {
    expect(nextLetterNo([], '2026-11-25')).toBe('PSP-LBS-2026-001')
    expect(nextLetterNo(['PSP-LBS-2026-007', 'PSP Service-2026-015', 'PSP-LBS-2025-099'], '2026-11-25'))
      .toBe('PSP-LBS-2026-008')
  })
  it('เกิน 999 ยังต่อได้ (ไม่ตัดหลัก)', () => {
    expect(nextLetterNo(['PSP-LBS-2026-999'], '2026-01-02')).toBe('PSP-LBS-2026-1000')
  })
})

describe('safeSigImage — ลายเซ็นอิเล็กทรอนิกส์ต้องเป็นรูป data URL ล้วน (ถูกวางใน <img src> ของเอกสารพิมพ์)', () => {
  it('PNG/JPEG base64 ผ่าน', () => {
    expect(safeSigImage(PNG)).toBe(PNG)
    expect(safeSigImage('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==')
  })
  it('🔴 กัน XSS: มีเครื่องหมายคำพูด / SVG / javascript: / ใหญ่เกิน = ว่าง', () => {
    for (const bad of ['x" onerror="alert(1)', `${PNG}" onerror="alert(1)`, 'data:image/svg+xml;base64,PHN2Zz4=',
      'javascript:alert(1)', 'https://evil.example/x.png', `data:image/png;base64,${'A'.repeat(400_001)}`])
      expect(safeSigImage(bad), bad.slice(0, 40)).toBe('')
  })
})

describe('cleanLetterInput — รับเฉพาะคอลัมน์ที่อนุญาต (เดิม ServiceMS spread ทั้งก้อน)', () => {
  it('ตัดคอลัมน์อื่นทิ้ง (รวมชื่อ/ตำแหน่งผู้ลงนามที่พิมพ์เอง — ต้องมาจากรายชื่อ) · ค่าเริ่มต้น ISSUED / GENERAL / EXTERNAL', () => {
    const r = cleanLetterInput({ ...base, subject: '  เรื่อง  ', id: 'x', letterNo: 'X', createdBy: 'ปลอม',
      signerName: 'ชื่อปลอม', signerPosition: 'ตำแหน่งปลอม' } as never)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const k of ['id', 'letterNo', 'createdBy', 'signerName', 'signerPosition']) expect(r.value).not.toHaveProperty(k)
    expect(r.value.subject).toBe('เรื่อง')
    expect(r.value.signerId).toBe('s1')
    expect(r.value.status).toBe('ISSUED')
    expect(r.value.category).toBe('GENERAL')
    expect(r.value.letterType).toBe('EXTERNAL')
  })
  it('ขาด ผู้รับ/เรื่อง/เนื้อความ/ผู้ลงนาม = error ภาษาไทย', () => {
    for (const k of ['recipient', 'subject', 'body', 'signerId'] as const) {
      const r = cleanLetterInput({ ...base, [k]: '  ' })
      expect(r.ok, k).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/กรุณา/)
    }
  })
  it('ตัวเลือกนอกชุด = error · ลายเซ็นไม่ผ่าน = error (ไม่ใช่ทิ้งเงียบ ๆ) · ไม่มีลายเซ็น = เว้นที่เซ็นมือ (ผ่าน)', () => {
    expect(cleanLetterInput({ ...base, category: 'HACK' as never }).ok).toBe(false)
    const s = cleanLetterInput({ ...base, sigImage: 'x" onerror="y' })
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.error).toMatch(/ลายเซ็น/)
    const wet = cleanLetterInput(base)
    expect(wet.ok && wet.value.sigImage).toBeFalsy()
  })
  it('🔴 [debug 2026-11-25] วันที่ต้องเป็น YYYY-MM-DD ที่มีจริง — เดิม "25/11/2026" / "2026-13-45" ผ่าน ⇒ RPC ::date error อังกฤษ หรืออ่าน 01/02 เป็น MDY ผิดเงียบ', () => {
    for (const [k, v] of [['letterDate', '25/11/2026'], ['letterDate', '01/02/2026'], ['letterDate', '2026-02-30'],
      ['warrantyStart', '2026-13-45'], ['warrantyEnd', '2026-1-5']] as const) {
      const r = cleanLetterInput({ ...base, category: 'WARRANTY', [k]: v })
      expect(r.ok, `${k}=${v}`).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/วันที่/)
    }
    expect(cleanLetterInput({ ...base, letterDate: '2028-02-29', warrantyStart: '2026-01-31', warrantyEnd: '2026-12-31' }).ok).toBe(true)
  })
  it('🟡 [debug 2026-11-25] jobId ต้องเป็น UUID — เดิม "abc" ผ่าน ⇒ RPC error "invalid input syntax for type uuid"', () => {
    const r = cleanLetterInput({ ...base, jobId: 'abc' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Job/)
    expect(cleanLetterInput({ ...base, jobId: '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90' }).ok).toBe(true)
  })
  it('Warranty: วันเริ่มต้องไม่หลังวันสิ้นสุด', () => {
    expect(cleanLetterInput({ ...base, category: 'WARRANTY', warrantyStart: '2027-01-01', warrantyEnd: '2026-01-01' }).ok).toBe(false)
  })
})

describe('parseTechList — รายชื่อเจ้าหน้าที่ "ชื่อ | เบอร์" บรรทัดละคน', () => {
  it('รองรับ | , tab · ตัดบรรทัดว่าง', () => {
    expect(parseTechList('สมชาย ใจดี | 081-000-0000\n\nสมศรี,082\nประสิทธิ์')).toEqual([
      { name: 'สมชาย ใจดี', phone: '081-000-0000' },
      { name: 'สมศรี', phone: '082' },
      { name: 'ประสิทธิ์', phone: '' },
    ])
  })
  it('🟡 [debug 2026-11-25] มี | แล้ว ตัดที่ | เท่านั้น — เดิม comma ในชื่อทำให้เบอร์หาย', () => {
    expect(parseTechList('บจก. ก, สาขา 2 | 081-111')).toEqual([{ name: 'บจก. ก, สาขา 2', phone: '081-111' }])
  })
})

describe('สิทธิ์ — ออกจดหมาย Service + Project + Manage · ลบ / ตั้งรายชื่อผู้ลงนาม = Manage', () => {
  it('canLetter', () => {
    for (const d of ['service', 'project', 'admin'] as const) expect(canLetter(user(d), 'manage'), d).toBe(true)
    for (const d of ['sales', 'purchasing', 'vip'] as const) expect(canLetter(user(d), 'manage'), d).toBe(false)
    for (const d of ['service', 'project'] as const) {
      expect(canLetter(user(d), 'delete'), d).toBe(false)
      expect(canLetter(user(d), 'signers'), d).toBe(false)
    }
    expect(canLetter(user('admin'), 'delete')).toBe(true)
    expect(canLetter(user('admin'), 'signers')).toBe(true)
    expect(canLetter(null, 'manage')).toBe(false)
  })
})

describe('รายชื่อผู้ลงนาม (Manage ตั้ง)', () => {
  it('activeSigners: เฉพาะที่ใช้งาน เรียงตามลำดับ', () => {
    expect(activeSigners([SIGNERS[1], { ...SIGNERS[0], sortOrder: 5 }, { ...SIGNERS[0], id: 's3', sortOrder: 0 }]).map(s => s.id))
      .toEqual(['s3', 's1'])
  })
  it('upsertSignerDemo: Manage เพิ่ม/แก้ได้ · ชื่อว่าง = error · แผนกอื่น = error', () => {
    const added = upsertSignerDemo([], user('admin'), { fullName: '  นาง ค  ', position: 'หัวหน้าส่วน' })
    expect(added).toHaveLength(1)
    expect(added[0].fullName).toBe('นาง ค')
    expect(added[0].isActive).toBe(true)
    const edited = upsertSignerDemo(added, user('admin'), { id: added[0].id, fullName: 'นาง ค', position: 'ผู้จัดการ', isActive: false })
    expect(edited[0].position).toBe('ผู้จัดการ')
    expect(edited[0].isActive).toBe(false)
    expect(() => upsertSignerDemo([], user('admin'), { fullName: ' ', position: '' })).toThrow(/ชื่อ/)
    expect(() => upsertSignerDemo([], user('service'), { fullName: 'ก', position: '' })).toThrow(/สิทธิ์/)
  })
})

describe('โหมดเดโม — createLetterDemo / deleteLetterDemo', () => {
  it('ออกเลขถัดไป · ชื่อ/ตำแหน่งผู้ลงนามมาจากรายชื่อ (snapshot) · created_by = ผู้ใช้จริง · ไม่แก้ array เดิม', () => {
    const before: ServiceLetter[] = []
    const r1 = createLetterDemo(before, user('service'), { ...base, category: 'SM', sigImage: PNG }, now, SIGNERS)
    expect(before).toHaveLength(0)
    expect(r1.letter.letterNo).toBe('PSP-LBS-2026-001')
    expect(r1.letter.createdBy).toBe('u1')
    expect(r1.letter.signerName).toBe('นาย ก ผู้จัดการ')
    expect(r1.letter.signerPosition).toBe('ผู้จัดการแผนกบริการ')
    expect(r1.letter.sigImage).toBe(PNG)
    const r2 = createLetterDemo(r1.letters, user('project', 'u2'), base, now, SIGNERS)
    expect(r2.letter.letterNo).toBe('PSP-LBS-2026-002')
    expect(r2.letters).toHaveLength(2)
  })
  it('ผู้ลงนามที่ไม่ใช้งาน/ไม่มีในรายชื่อ = throw', () => {
    expect(() => createLetterDemo([], user('service'), { ...base, signerId: 's2' }, now, SIGNERS)).toThrow(/ผู้ลงนาม/)
    expect(() => createLetterDemo([], user('service'), { ...base, signerId: 'nope' }, now, SIGNERS)).toThrow(/ผู้ลงนาม/)
  })
  it('แจ้งกระดิ่ง (ไม่ส่ง LINE): อ้าง Job = แจ้ง Project พร้อม job · ไม่อ้าง Job = ไม่แจ้ง', () => {
    const JOB = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90'   // id Job จริงเป็น UUID (L.createJob → uid())
    const withJob = createLetterDemo([], user('service'), { ...base, jobId: JOB }, now, SIGNERS)
    expect(withJob.notify).toEqual({ type: 'letter_issued', dept: 'project', jobId: JOB, message: expect.stringContaining('PSP-LBS-2026-001') })
    expect(createLetterDemo([], user('service'), base, now, SIGNERS).notify).toBeUndefined()
  })
  it('ปีตามเวลาไทย: 31 ธ.ค. 17:30 UTC = 1 ม.ค. ไทย → เลขปีใหม่', () => {
    expect(createLetterDemo([], user('service'), base, '2026-12-31T17:30:00.000Z', SIGNERS).letter.letterNo).toBe('PSP-LBS-2027-001')
  })
  it('แผนกไม่มีสิทธิ์ = throw · ข้อมูลไม่ครบ = throw', () => {
    expect(() => createLetterDemo([], user('sales'), base, now, SIGNERS)).toThrow(/สิทธิ์/)
    expect(() => createLetterDemo([], user('service'), { ...base, subject: '' }, now, SIGNERS)).toThrow(/กรุณา/)
  })
  it('ลบ: Manage เท่านั้น · ไม่พบ = throw', () => {
    const { letters, letter } = createLetterDemo([], user('service'), base, now, SIGNERS)
    expect(() => deleteLetterDemo(letters, user('service'), letter.id)).toThrow(/สิทธิ์/)
    expect(deleteLetterDemo(letters, user('admin'), letter.id)).toHaveLength(0)
    expect(() => deleteLetterDemo(letters, user('admin'), 'nope')).toThrow(/ไม่พบ/)
  })
})

describe('warrantyLetterPrefill — ปุ่ม "ออก Warranty Letter" ในหน้า Warranty เติมข้อมูลประกันให้', () => {
  const job = {
    id: 'j1', jobNo: '102LB10J3076', customerName: 'บริษัท เลม่อน โกลด์ ฟาร์ม จำกัด', installLocation: 'จ.อุดรธานี',
    acceptanceType: 'PAC', acceptanceDocNo: 'PAC-001', acceptanceDate: '2026-09-20',
  } as unknown as Job
  const w = (o: Partial<JobWarranty>): JobWarranty => ({ id: 'w', jobId: 'j1', kind: 'lbs', startDate: '', endDate: '', createdAt: '', ...o })

  it('ลูกค้า · สถานที่ · อ้างถึงเอกสารรับมอบ · ช่วงประกันงานติดตั้ง · รายละเอียดประกันตัวเครื่อง', () => {
    const p = warrantyLetterPrefill(job, [
      w({ kind: 'installation', startDate: '2026-09-20', endDate: '2027-09-19' }),
      w({ kind: 'lbs', unitId: 'u1', startDate: '2026-09-20', endDate: '2028-09-19' }),
      w({ kind: 'lbs', unitId: 'u2', startDate: '2026-09-20', endDate: '2028-09-19' }),
      w({ jobId: 'other', kind: 'installation', startDate: '2020-01-01', endDate: '2020-12-31' }),
    ])
    expect(p.category).toBe('WARRANTY')
    expect(p.jobId).toBe('j1')
    expect(p.recipient).toBe('บริษัท เลม่อน โกลด์ ฟาร์ม จำกัด')
    expect(p.site).toBe('จ.อุดรธานี')
    expect(p.subject).toContain('102LB10J3076')
    expect(p.reference).toBe('PAC เลขที่ PAC-001 ลงวันที่ 20-09-2026')
    expect(p.warrantyStart).toBe('2026-09-20')
    expect(p.warrantyEnd).toBe('2027-09-19')
    expect(p.warrantyDetail).toContain('ตัวเครื่อง LBS 2 เครื่อง: 20-09-2026 ถึง 19-09-2028')
  })
  it('ไม่มีประกันงานติดตั้ง → ใช้ช่วงกว้างสุดของตัวเครื่อง · ไม่มีเอกสารรับมอบ → ไม่มีบรรทัดอ้างถึง', () => {
    const p = warrantyLetterPrefill({ ...job, acceptanceType: undefined } as Job, [
      w({ unitId: 'u1', startDate: '2026-10-01', endDate: '2028-09-30' }),
      w({ unitId: 'u2', startDate: '2026-09-01', endDate: '2028-08-31' }),
    ])
    expect(p.warrantyStart).toBe('2026-09-01')
    expect(p.warrantyEnd).toBe('2028-09-30')
    expect(p.reference).toBeUndefined()
  })
})
