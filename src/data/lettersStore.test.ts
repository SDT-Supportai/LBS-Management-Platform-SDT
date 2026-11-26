// =============================================================================
// ผูก Service Letter เข้า LBS (2026-11-25) — action ระดับ DB (demo) · สิทธิ์ · Audit · seed · แปลงข้อมูล LIVE
//   ต่อจาก letters.test.ts (logic ล้วน) — กติกาตรงกับ supabase/migrations/0100_service_letters.sql
// =============================================================================
import { describe, it, expect } from 'vitest'
import type { DB, User } from '../types'
import {
  createServiceLetter, deleteServiceLetter, upsertLetterSigner, addLetterFile, deleteLetterFile,
} from './logic'
import { PERMISSIONS, can } from './permissions'
import { PERM_LABEL } from './admin'
import { AUDIT_ENTITY_LABEL, auditLink } from './audit'
import { auditEntityTone } from '../ui/tone'
import { canLetter, isAllowedLetterFile, LETTER_FILE_MAX_BYTES } from './letters'
import { buildSeedDb, DEMO_LETTER_SIGNERS } from './seed'
import { letterRpcPayload, mapServiceLetter, mapLetterSigner, mapLetterFile } from './remote'

const T = '2026-11-25T03:00:00.000Z'
const EMPTY: DB = {
  users: [], publicShareLinks: [],
  items: [], projectStocks: [], lbsUnits: [], lbsUnitFiles: [], jobs: [], allocations: [],
  accessoryStock: [], accessoryRequests: [], prs: [], pos: [], approvalRequests: [], approvalComments: [],
  auditLogs: [], notifications: [], siteVisits: [], unitInstallations: [],
  teamMembers: [], jobAssignments: [], stockMovements: [], jobPayments: [],
  jobPaymentFiles: [], jobDueExtensions: [], jobWarranties: [], jobCloseoutFiles: [], stockReturns: [],
  stdDrawings: [], stdPrices: [], stdBoms: [], stdBomLines: [],
  serviceLetters: [], serviceLetterFiles: [], letterSigners: [],
}
const user = (department: User['department'], id = `u-${department}`): User =>
  ({ id, email: `${id}@x`, password: '', fullName: `ผู้ใช้ ${department}`, department, isActive: true })
const JOB_ID = '11111111-2222-4333-8444-555555555555'
const db0 = (): DB => ({
  ...EMPTY,
  jobs: [{ id: JOB_ID, jobNo: '102LB10J3076', customerName: 'กฟภ. เขต 1' } as DB['jobs'][number]],
  letterSigners: [
    { id: 's1', fullName: 'ผู้ลงนาม ตัวอย่าง', position: 'ผู้จัดการแผนกบริการ', sortOrder: 1, isActive: true },
    { id: 's2', fullName: 'ผู้ลงนาม ปิดแล้ว', position: 'อดีต', sortOrder: 2, isActive: false },
  ],
})
const input = { recipient: 'ผู้จัดการ', subject: 'แจ้งแผนเข้าดำเนินการ', body: 'เนื้อความ', signerId: 's1', jobId: JOB_ID }

describe('สิทธิ์จดหมาย — ย้ายเข้า permissions.ts (คำตอบผู้ใช้ข้อ 1 + 4)', () => {
  it('letter.manage = Service + Project + Manage · letter.delete / letter.signers = Manage', () => {
    expect(PERMISSIONS['letter.manage']).toEqual(['service', 'project', 'admin'])
    expect(PERMISSIONS['letter.delete']).toEqual(['admin'])
    expect(PERMISSIONS['letter.signers']).toEqual(['admin'])
  })
  it('มีป้ายสิทธิ์ภาษาไทยในหน้าผู้ใช้', () => {
    for (const k of ['letter.manage', 'letter.delete', 'letter.signers'] as const) expect(PERM_LABEL[k]).toBeTruthy()
  })
  it('canLetter ใช้ตารางเดียวกับ can() — ไม่มีรายชื่อแผนกซ้ำ 2 ที่', () => {
    for (const d of ['admin', 'project', 'sales', 'purchasing', 'service', 'vip'] as const)
      for (const p of ['manage', 'delete', 'signers'] as const)
        expect(canLetter(user(d), p), `${d} ${p}`).toBe(can(user(d), `letter.${p}`))
  })
})

describe('createServiceLetter — ออกจดหมาย (demo · sync rpc_create_service_letter)', () => {
  it('[Flow] เลข PSP-LBSJXXXX-ปี-001 ตาม Job + Audit + กระดิ่งถึง Project (ไม่ส่ง LINE)', () => {
    const d = createServiceLetter(db0(), user('service'), input)
    expect(d.serviceLetters).toHaveLength(1)
    const l = d.serviceLetters[0]
    expect(l.letterNo).toMatch(/^PSP-LBSJ3076-\d{4}-001$/)
    expect(l.signerName).toBe('ผู้ลงนาม ตัวอย่าง')
    expect(l.createdBy).toBe('u-service')
    expect(d.auditLogs[0]).toMatchObject({ entityType: 'service_letter', entityId: l.id, action: 'create_service_letter' })
    expect(d.auditLogs[0].detail).toContain(l.letterNo)
    expect(d.auditLogs[0].detail).toContain('(เซ็นมือ)')
    const n = d.notifications[d.notifications.length - 1]
    expect(n).toMatchObject({ type: 'letter_issued', dept: 'project', jobId: JOB_ID, lineStatus: 'off' })
  })
  it('[Flow] ไม่เลือก Job = ปัดตก (ต้องเลือก Job No. ก่อนเป็นอันดับแรก)', () => {
    expect(() => createServiceLetter(db0(), user('project'), { ...input, jobId: undefined })).toThrow('Job No.')
  })
  it('อ้าง Job ที่ไม่มีในระบบ = ปัดตก', () => {
    expect(() => createServiceLetter(db0(), user('admin'), { ...input, jobId: '99999999-2222-4333-8444-555555555555' }))
      .toThrow('ไม่พบ Job')
  })
  it('Division / Purchasing / VIP ออกไม่ได้', () => {
    for (const d of ['sales', 'purchasing', 'vip'] as const)
      expect(() => createServiceLetter(db0(), user(d), input), d).toThrow('ไม่มีสิทธิ์')
  })
  it('ผู้ลงนามที่ปิดใช้งาน = ปัดตก', () => {
    expect(() => createServiceLetter(db0(), user('admin'), { ...input, signerId: 's2' })).toThrow('ผู้ลงนาม')
  })
  it('เลขรันต่อจากฉบับล่าสุด', () => {
    let d = createServiceLetter(db0(), user('admin'), input)
    d = createServiceLetter(d, user('admin'), input)
    expect(d.serviceLetters.map(l => l.letterNo.slice(-3))).toEqual(['002', '001'])
  })
  it('ลบฉบับล่าสุดแล้ว เลขไม่ถูกนำกลับมาใช้ (เลขนั้นอาจส่งถึงผู้รับไปแล้ว · sync letter_no_counters)', () => {
    let d = createServiceLetter(db0(), user('admin'), input)
    d = createServiceLetter(d, user('admin'), input)
    d = deleteServiceLetter(d, user('admin'), { letterId: d.serviceLetters[0].id })   // ลบ 002
    d = createServiceLetter(d, user('admin'), input)
    expect(d.serviceLetters[0].letterNo.slice(-3)).toBe('003')
  })
})

describe('deleteServiceLetter — Manage เท่านั้น · ไฟล์แนบหายตาม (CASCADE)', () => {
  const withFile = () => {
    let d = createServiceLetter(db0(), user('admin'), input)
    d = addLetterFile(d, user('service'), { letterId: d.serviceLetters[0].id, fileName: 'a.pdf', filePath: 'data:application/pdf;base64,AA==', mimeType: 'application/pdf', sizeBytes: 10 })
    return d
  }
  it('Manage ลบได้ + ไฟล์แนบหาย + Audit', () => {
    const d0 = withFile()
    const d = deleteServiceLetter(d0, user('admin'), { letterId: d0.serviceLetters[0].id })
    expect(d.serviceLetters).toHaveLength(0)
    expect(d.serviceLetterFiles).toHaveLength(0)
    expect(d.auditLogs[0]).toMatchObject({ entityType: 'service_letter', action: 'delete_service_letter' })
    expect(d.auditLogs[0].detail).toContain('ไฟล์แนบ 1 ไฟล์')
  })
  it('Service / Project ลบไม่ได้', () => {
    const d0 = withFile()
    for (const dep of ['service', 'project'] as const)
      expect(() => deleteServiceLetter(d0, user(dep), { letterId: d0.serviceLetters[0].id })).toThrow('Manage')
  })
})

describe('upsertLetterSigner — Manage ตั้งรายชื่อ (เพิ่ม / แก้ / ปิดใช้งาน)', () => {
  it('เพิ่ม + แก้ + ปิดใช้งาน พร้อม Audit letter_signer', () => {
    let d = upsertLetterSigner(EMPTY, user('admin'), { fullName: ' ผู้ลงนาม ใหม่ ', position: 'ผจก.' })
    expect(d.letterSigners[0]).toMatchObject({ fullName: 'ผู้ลงนาม ใหม่', isActive: true, sortOrder: 1 })
    expect(d.auditLogs[0]).toMatchObject({ entityType: 'letter_signer', action: 'create_letter_signer' })
    const id = d.letterSigners[0].id
    d = upsertLetterSigner(d, user('admin'), { id, fullName: 'ผู้ลงนาม ใหม่', position: 'ผจก.', isActive: false })
    expect(d.letterSigners[0].isActive).toBe(false)
    expect(d.auditLogs[0]).toMatchObject({ action: 'update_letter_signer' })
    expect(d.auditLogs[0].detail).toContain('ปิดใช้งาน')
  })
  it('แผนกอื่นตั้งไม่ได้', () => {
    expect(() => upsertLetterSigner(EMPTY, user('service'), { fullName: 'x', position: '' })).toThrow('Manage')
  })
})

describe('ไฟล์แนบจดหมาย — PDF / Word / Excel / รูป · ≤ 10 MB (sync rpc_add_service_letter_file)', () => {
  it('isAllowedLetterFile', () => {
    for (const ok of ['application/pdf', 'image/png', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
      expect(isAllowedLetterFile(ok), ok).toBe(true)
    for (const bad of ['text/html', 'application/zip', '', 'image/svg+xml']) expect(isAllowedLetterFile(bad), bad).toBe(false)
  })
  const d1 = () => createServiceLetter(db0(), user('admin'), input)
  const f = (o: Partial<{ fileName: string; mimeType: string; sizeBytes: number; letterId: string }> = {}) =>
    ({ letterId: '', fileName: 'สัญญา.pdf', filePath: 'data:application/pdf;base64,AA==', mimeType: 'application/pdf', sizeBytes: 100, ...o })
  it('แนบได้ + Audit ที่จดหมาย · ลบได้', () => {
    const d0 = d1()
    const id = d0.serviceLetters[0].id
    let d = addLetterFile(d0, user('project'), f({ letterId: id }))
    expect(d.serviceLetterFiles[0]).toMatchObject({ letterId: id, fileName: 'สัญญา.pdf', uploadedBy: 'u-project' })
    expect(d.auditLogs[0]).toMatchObject({ entityType: 'service_letter', entityId: id, action: 'add_service_letter_file' })
    d = deleteLetterFile(d, user('service'), { fileId: d.serviceLetterFiles[0].id })
    expect(d.serviceLetterFiles).toHaveLength(0)
    expect(d.auditLogs[0]).toMatchObject({ action: 'delete_service_letter_file' })
  })
  it('ชนิดไฟล์ / ขนาด / จดหมายไม่มี = ข้อความไทย', () => {
    const d0 = d1()
    const id = d0.serviceLetters[0].id
    expect(() => addLetterFile(d0, user('admin'), f({ letterId: id, mimeType: 'text/html' }))).toThrow('ชนิดไฟล์ไม่รองรับ')
    expect(() => addLetterFile(d0, user('admin'), f({ letterId: id, sizeBytes: LETTER_FILE_MAX_BYTES + 1 }))).toThrow('10 MB')
    expect(() => addLetterFile(d0, user('admin'), f({ letterId: 'nope' }))).toThrow('ไม่พบจดหมาย')
  })
  it('Division แนบไม่ได้', () => {
    const d0 = d1()
    expect(() => addLetterFile(d0, user('sales'), f({ letterId: d0.serviceLetters[0].id }))).toThrow('ไม่มีสิทธิ์')
  })
})

describe('Audit Log — ชื่อ / สี / ลิงก์ของจดหมาย', () => {
  it('ป้ายภาษาไทย + สีไม่เทา + ลิงก์ไปหน้าจดหมาย / หน้าตั้งค่า', () => {
    expect(AUDIT_ENTITY_LABEL.service_letter).toBe('จดหมาย')
    expect(AUDIT_ENTITY_LABEL.letter_signer).toBe('ผู้ลงนามจดหมาย')
    expect(auditEntityTone('service_letter')).not.toBe('neutral')
    const log = (entityType: string) => ({ id: 'a', entityType, entityId: 'x', action: '', actorId: '', detail: '', createdAt: T })
    expect(auditLink(log('service_letter'), EMPTY)).toBe('/letters')
    expect(auditLink(log('letter_signer'), EMPTY)).toBe('/dev')
  })
})

describe('seed — โหมดเดโมออกจดหมายได้ทันที', () => {
  it('มีผู้ลงนามที่ใช้งาน ≥ 1 + จดหมายตัวอย่าง 2 ฉบับ (เลขไม่ซ้ำ)', () => {
    const d = buildSeedDb()
    expect(d.letterSigners.filter(s => s.isActive).length).toBeGreaterThanOrEqual(1)
    expect(DEMO_LETTER_SIGNERS.length).toBeGreaterThanOrEqual(2)
    expect(d.serviceLetters).toHaveLength(2)
    expect(new Set(d.serviceLetters.map(l => l.letterNo)).size).toBe(2)
  })
})

describe('remote — แปลง camelCase ↔ snake_case ตรงกับ 0100', () => {
  it('letterRpcPayload: รับเฉพาะคอลัมน์ที่อนุญาต · ไม่ส่งชื่อผู้ลงนาม (server ดึงจากตารางเอง)', () => {
    const p = letterRpcPayload({ ...input, category: 'WARRANTY', jobId: JOB_ID, warrantyStart: '2026-01-01', techList: 'ก | 081' })
    expect(p).toMatchObject({ recipient: 'ผู้จัดการ', signer_id: 's1', category: 'WARRANTY', job_id: JOB_ID, warranty_start: '2026-01-01', tech_list: 'ก | 081' })
    expect(Object.keys(p)).not.toContain('signer_name')
    expect(Object.keys(p).every(k => k === k.toLowerCase())).toBe(true)
  })
  it('letterRpcPayload ข้อมูลผิด = throw ข้อความไทยก่อนยิง RPC', () => {
    expect(() => letterRpcPayload({ ...input, signerId: '' })).toThrow('กรุณาเลือกผู้ลงนาม')
  })
  it('map แถวจาก DB → ชนิดข้อมูลของแอป', () => {
    expect(mapServiceLetter({
      id: 'l1', letter_no: 'PSP-LBS-2026-001', letter_date: '2026-11-25', category: 'SM', letter_type: 'EXTERNAL', status: 'ISSUED',
      recipient: 'r', recipient_org: null, subject: 's', reference: null, enclosure: null, body: 'b', body2: null, attention: 'a',
      site: null, tech_list: 'ก | 1', job_id: JOB_ID, cc: null, signer_id: 's1', signer_name: 'n', signer_position: 'p',
      sig_image: null, warranty_type: null, warranty_start: null, warranty_end: null, warranty_detail: null,
      created_by: 'u1', created_at: T,
    })).toMatchObject({ letterNo: 'PSP-LBS-2026-001', techList: 'ก | 1', jobId: JOB_ID, signerName: 'n', sigImage: undefined, recipientOrg: undefined })
    expect(mapLetterSigner({ id: 's1', full_name: 'n', position: 'p', sort_order: 2, is_active: false }))
      .toEqual({ id: 's1', fullName: 'n', position: 'p', sortOrder: 2, isActive: false })
    expect(mapLetterFile({ id: 'f1', letter_id: 'l1', file_path: 'letters/l1/x.pdf', file_name: 'x.pdf', mime_type: 'application/pdf', size_bytes: '12', uploaded_by: 'u1', uploaded_at: T }))
      .toMatchObject({ letterId: 'l1', filePath: 'letters/l1/x.pdf', sizeBytes: 12 })
  })
})

describe('[0101] Contract No. ฝั่ง LIVE', () => {
  it('letterRpcPayload ส่ง contract_no · mapServiceLetter อ่าน contract_no', () => {
    expect(letterRpcPayload({ ...input, contractNo: 'CT-2026-0103' })).toMatchObject({ contract_no: 'CT-2026-0103' })
    expect(mapServiceLetter({ id: 'l1', letter_no: 'n', letter_date: '2026-11-25', category: 'GENERAL', letter_type: 'EXTERNAL',
      status: 'ISSUED', recipient: 'r', subject: 's', body: 'b', contract_no: 'CT-1', created_by: 'u', created_at: T }).contractNo).toBe('CT-1')
  })
  it('ก่อนรัน 0101 (ไม่มีคอลัมน์) = contractNo ว่าง ไม่ error', () => {
    expect(mapServiceLetter({ id: 'l1', letter_no: 'n', letter_date: '2026-11-25', category: 'GENERAL', letter_type: 'EXTERNAL',
      status: 'ISSUED', recipient: 'r', subject: 's', body: 'b', created_by: 'u', created_at: T }).contractNo).toBeUndefined()
  })
})
