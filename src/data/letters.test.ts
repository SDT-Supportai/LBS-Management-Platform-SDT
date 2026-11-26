// Service Letter (ยกมาจาก ServiceMS · เตรียมรวม 2026-11-25) — logic ล้วน ยังไม่ผูกเข้า DB/เมนู
//   คำตอบผู้ใช้ 2026-11-25: ออก = Service+Project+Manage · เลข PSP-LBS-YYYY-NNN · ผู้ลงนามจาก dropdown ที่ Manage ตั้ง
//   (เซ็นอิเล็กทรอนิกส์ หรือเว้นที่เซ็นมือ) · แจ้งกระดิ่งไม่ส่ง LINE · ปุ่ม Warranty Letter เติมข้อมูลประกันให้
import { describe, it, expect } from 'vitest'
import {
  LETTER_PREFIX, nextLetterNo, jobLetterCode, thaiDateFull, safeSigImage, cleanLetterInput, parseTechList,
  canLetter, createLetterDemo, deleteLetterDemo, upsertSignerDemo, activeSigners, warrantyLetterPrefill, contractNosOfJob,
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
// [Flow 2026-11-25] ออกจดหมายต้องเลือก Job ก่อน — id Job จริงเป็น UUID (L.createJob → uid())
const JOB = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90'
const JOB2 = '4a1b2c3d-5b7d-4e8a-9c21-7d4e5f6a8b91'
const JOBS = [{ id: JOB, jobNo: '102LB10J3076' }, { id: JOB2, jobNo: '102LB20J3189' }]
const base = { recipient: 'กฟภ. เขต 1', subject: 'ขอแจ้งแผนเข้าดำเนินการ', body: 'เนื้อความ', signerId: 's1', jobId: JOB }
const now = '2026-11-25T09:00:00.000Z'
const mk = (letters: ServiceLetter[], u: User, input: Parameters<typeof createLetterDemo>[2], at = now) =>
  createLetterDemo(letters, u, input, at, SIGNERS, [], JOBS)

describe('[Flow 2026-11-25] เลขที่ PSP-LBSJXXXX-YYYY-nnn — รันตาม Job No. เท่านั้น', () => {
  it('prefix ระบบ = PSP-LBS', () => expect(LETTER_PREFIX).toBe('PSP-LBS'))
  it('jobLetterCode: ตัวเลขหลัง J ของ Job No. (102LB10J3076 → 3076) · ไม่มี J = ตัวเลขท้าย · เติม 0 ให้ครบ 4 หลัก (ไม่ตัด)', () => {
    expect(jobLetterCode('102LB10J3076')).toBe('3076')
    expect(jobLetterCode('102LB20J3189')).toBe('3189')
    expect(jobLetterCode('JOB-2026-0004')).toBe('0004')
    expect(jobLetterCode('J12')).toBe('0012')
    expect(jobLetterCode('102LB10J30761')).toBe('30761')
    expect(jobLetterCode(' 102lb10j3076 ')).toBe('3076')
  })
  it('แต่ละ Job รันแยกกัน · ปีใหม่เริ่ม 001 · เลขแบบเก่า PSP-LBS-YYYY-nnn ไม่นับ', () => {
    expect(nextLetterNo([], '102LB10J3076', '2026-11-25')).toBe('PSP-LBSJ3076-2026-001')
    expect(nextLetterNo(['PSP-LBSJ3076-2026-004', 'PSP-LBSJ3189-2026-009', 'PSP-LBS-2026-007', 'PSP-LBSJ3076-2025-020'],
      '102LB10J3076', '2026-11-25')).toBe('PSP-LBSJ3076-2026-005')
    expect(nextLetterNo(['PSP-LBSJ3076-2026-004'], '102LB20J3189', '2026-11-25')).toBe('PSP-LBSJ3189-2026-001')
  })
  it('เกิน 999 ยังต่อได้ (ไม่ตัดหลัก)', () => {
    expect(nextLetterNo(['PSP-LBSJ3076-2026-999'], '102LB10J3076', '2026-01-02')).toBe('PSP-LBSJ3076-2026-1000')
  })
})

describe('[Flow 2026-11-25] วันที่ในจดหมาย = เดือนชื่อเต็ม (พ.ศ.)', () => {
  it('thaiDateFull', () => {
    expect(thaiDateFull('2026-11-25')).toBe('25 พฤศจิกายน 2569')
    expect(thaiDateFull('2026-01-01')).toBe('1 มกราคม 2569')
    expect(thaiDateFull('2027-07-09')).toBe('9 กรกฎาคม 2570')
    expect(thaiDateFull('')).toBe('-')
    expect(thaiDateFull('xx')).toBe('-')
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
  it('[Flow] ไม่เลือก Job = error ก่อนช่องอื่น (Job มาก่อนเป็นอันดับแรก)', () => {
    const r = cleanLetterInput({ subject: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Job No\./)
  })
  it('ขาด Job/ผู้รับ/เรื่อง/เนื้อความ/ผู้ลงนาม = error ภาษาไทย', () => {
    for (const k of ['jobId', 'recipient', 'subject', 'body', 'signerId'] as const) {
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
    const r1 = mk(before, user('service'), { ...base, category: 'SM', sigImage: PNG })
    expect(before).toHaveLength(0)
    expect(r1.letter.letterNo).toBe('PSP-LBSJ3076-2026-001')
    expect(r1.letter.createdBy).toBe('u1')
    expect(r1.letter.signerName).toBe('นาย ก ผู้จัดการ')
    expect(r1.letter.signerPosition).toBe('ผู้จัดการแผนกบริการ')
    expect(r1.letter.sigImage).toBe(PNG)
    const r2 = mk(r1.letters, user('project', 'u2'), base)
    expect(r2.letter.letterNo).toBe('PSP-LBSJ3076-2026-002')
    expect(r2.letters).toHaveLength(2)
    // Job อื่นเริ่ม 001 ของตัวเอง
    expect(mk(r2.letters, user('project'), { ...base, jobId: JOB2 }).letter.letterNo).toBe('PSP-LBSJ3189-2026-001')
  })
  it('ผู้ลงนามที่ไม่ใช้งาน/ไม่มีในรายชื่อ = throw · Job ไม่มีในระบบ = throw', () => {
    expect(() => mk([], user('service'), { ...base, signerId: 's2' })).toThrow(/ผู้ลงนาม/)
    expect(() => mk([], user('service'), { ...base, signerId: 'nope' })).toThrow(/ผู้ลงนาม/)
    expect(() => mk([], user('service'), { ...base, jobId: '9f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90' })).toThrow(/ไม่พบ Job/)
  })
  it('แจ้งกระดิ่ง (ไม่ส่ง LINE) ถึง Project ของ Job ทุกฉบับ', () => {
    expect(mk([], user('service'), base).notify)
      .toEqual({ type: 'letter_issued', dept: 'project', jobId: JOB, message: expect.stringContaining('PSP-LBSJ3076-2026-001') })
  })
  it('ปีตามเวลาไทย: 31 ธ.ค. 17:30 UTC = 1 ม.ค. ไทย → เลขปีใหม่', () => {
    expect(mk([], user('service'), base, '2026-12-31T17:30:00.000Z').letter.letterNo).toBe('PSP-LBSJ3076-2027-001')
  })
  it('แผนกไม่มีสิทธิ์ = throw · ข้อมูลไม่ครบ = throw', () => {
    expect(() => mk([], user('sales'), base)).toThrow(/สิทธิ์/)
    expect(() => mk([], user('service'), { ...base, subject: '' })).toThrow(/กรุณา/)
  })
  it('ลบ: Manage เท่านั้น · ไม่พบ = throw', () => {
    const { letters, letter } = mk([], user('service'), base)
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
    // [Flow 2026-11-25] วันที่ในข้อความ = เดือนชื่อเต็ม พ.ศ.
    expect(p.reference).toBe('PAC เลขที่ PAC-001 ลงวันที่ 20 กันยายน 2569')
    expect(p.warrantyStart).toBe('2026-09-20')
    expect(p.warrantyEnd).toBe('2027-09-19')
    expect(p.warrantyDetail).toContain('ตัวเครื่อง LBS 2 เครื่อง: 20 กันยายน 2569 ถึง 19 กันยายน 2571')
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

describe('[ปรับ 2026-11-25] Contract No. — อ้างอิงสัญญาของงาน (ภายนอก / SM / Warranty)', () => {
  it('cleanLetterInput รับ contractNo', () => {
    const r = cleanLetterInput({ ...base, contractNo: ' CT-2026-0104 ' })
    expect(r.ok && r.value.contractNo).toBe('CT-2026-0104')
  })
  it('contractNosOfJob: เลขสัญญาของเครื่องใน Job (ไม่ซ้ำ เรียง) · ไม่มี = ว่าง', () => {
    const units = [
      { jobId: 'j1', contractNo: 'CT-B' }, { jobId: 'j1', contractNo: 'CT-A' }, { jobId: 'j1', contractNo: 'CT-B' },
      { jobId: 'j1' }, { jobId: 'j2', contractNo: 'CT-Z' },
    ]
    expect(contractNosOfJob(units, 'j1')).toBe('CT-A, CT-B')
    expect(contractNosOfJob(units, 'j3')).toBe('')
  })
  it('warrantyLetterPrefill เติม Contract No. จากเครื่องของงาน', () => {
    const job = { id: 'j1', jobNo: 'J-1', customerName: 'ลูกค้า' } as unknown as Job
    expect(warrantyLetterPrefill(job, [], [{ jobId: 'j1', contractNo: 'CT-2026-0104' }]).contractNo).toBe('CT-2026-0104')
    expect(warrantyLetterPrefill(job, []).contractNo).toBeUndefined()
  })
})
