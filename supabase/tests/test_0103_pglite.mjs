// [0103] Letters แบบ Word — วิธีรันเหมือน test_0102_pglite.mjs: node test_0103_pglite.mjs <lbs-platform>/supabase/migrations
//   รัน 0100 → 0103 (2 รอบ) · ตรวจ: nnn กำหนดเอง · เนื้อความ HTML + กันโค้ด · แก้จดหมายที่ออกแล้ว · เลขถัดไป
//   node test_0102_pglite.mjs <lbs-platform>/supabase/migrations
//   รัน 0100 → 0101 → 0102 (2 รอบ = idempotent) แล้วตรวจ Flow ใหม่: ต้องเลือก Job ก่อน · เลข PSP-LBSJXXXX-YYYY-nnn ตาม Job
//   ส่วนตั้งค่า (stub Supabase + ฟังก์ชัน LBS จริงจาก migrations) คัดลอกจาก test_0100_pglite.mjs
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIG = process.argv[2]           // .../lbs-platform/supabase/migrations
const DRAFT = process.argv[3]         // .../lbs-platform/supabase/migrations/0100_service_letters.sql
const readMig = (f) => readFileSync(join(MIG, f), 'utf8')
function extractFn(file, name) {
  const src = readMig(file)
  const i = src.search(new RegExp(`CREATE OR REPLACE FUNCTION (public\\.)?${name}\\(`))
  if (i < 0) throw new Error(`ไม่พบ ${name} ใน ${file}`)
  const j = src.indexOf('$$;', src.indexOf('$$', i) + 2)
  return src.slice(i, j + 3)
}

const db = new PGlite()
const notices = []
db.onNotification?.(() => {})
const exec = (s) => db.exec(s)
const one = async (s, p) => (await db.query(s, p)).rows

// ---------- base: Supabase stubs + ตาราง/ฟังก์ชัน LBS ที่ร่างใช้ ----------
await exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- Supabase ให้สิทธิ์ตารางใหม่ครบเป็น default · 0057 ถอนเขียน · 0091 ถอน EXECUTE ฟังก์ชันใหม่
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS
  $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id TEXT PRIMARY KEY, name TEXT, public BOOLEAN DEFAULT false);
CREATE TABLE storage.objects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT, name TEXT);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;

CREATE PUBLICATION supabase_realtime;

CREATE TABLE profiles (
  id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN ('sales','project','purchasing','service','admin','vip')),
  is_active BOOLEAN DEFAULT true);
CREATE TABLE jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), job_no TEXT);
CREATE TABLE audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL, action VARCHAR(100) NOT NULL, actor_id UUID REFERENCES profiles(id), detail TEXT,
  old_value JSONB, new_value JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL, dept VARCHAR(30) NOT NULL, job_id UUID REFERENCES jobs(id),
  line_status VARCHAR(10) NOT NULL DEFAULT 'off' CHECK (line_status IN ('off','pending','sent','failed')),
  created_at TIMESTAMPTZ DEFAULT NOW());
CREATE FUNCTION my_department() RETURNS TEXT LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS
  $f$ SELECT department FROM profiles WHERE id = auth.uid() $f$;
`)
for (const [file, fn] of [['0058_read_requires_active.sql', 'my_is_active'], ['0002_rpc.sql', 'app_assert_dept'],
  ['0002_rpc.sql', 'app_audit'], ['0083_approval_requested_off_group.sql', 'app_notify']]) await exec(extractFn(file, fn))
await exec(`GRANT EXECUTE ON FUNCTION my_department(), my_is_active() TO authenticated;`)

// ผู้ใช้ทดสอบ (1 คนต่อแผนก + Service ที่ถูกปิดบัญชี)
const U = {}
for (const d of ['admin', 'service', 'project', 'sales', 'purchasing', 'vip', 'off']) {
  const [{ id }] = await one(`SELECT gen_random_uuid() AS id`)
  U[d] = id
  await one(`INSERT INTO profiles (id, email, full_name, department, is_active) VALUES ($1,$2,$3,$4,$5)`,
    [id, `${d}@t`, `ผู้ใช้ ${d}`, d === 'off' ? 'service' : d, d !== 'off'])
}

// ---------- Job ทดสอบ: รูปแบบจริง (102LB..J....) + แบบเดโม + รหัสซ้ำคนละ Job ----------
const J = {}
for (const [k, no] of [['a', '102LB10J3076'], ['b', '102LB20J3189'], ['demo', 'JOB-2026-0004'], ['dup', '102LB20J3076']]) {
  J[k] = (await one(`INSERT INTO jobs (job_no) VALUES ($1) RETURNING id`, [no]))[0].id
}

// ---------- รัน 0100 → 0103 (2 รอบ) ----------
const files = ['0100_service_letters.sql', '0101_service_letter_contract_no.sql', '0102_service_letter_no_by_job.sql', '0103_service_letter_word.sql']
const sql = files.map(readMig).join('\n;\n')
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(cond ? 'PASS' : 'FAIL', name, extra) }
for (const round of [1, 2]) {
  try { await exec(sql); ok(`รัน 0100→0103 รอบ ${round} ไม่มี error`, true) }
  catch (e) { ok(`รัน 0100→0103 รอบ ${round} ไม่มี error`, false, e.message); process.exitCode = 1; break }
}
async function as(user, q, params) {
  await exec(`RESET ROLE`)
  await one(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [user && user !== 'anon' ? U[user] : ''])
  await exec(`SET ROLE ${user === 'anon' ? 'anon' : 'authenticated'}`)
  try { return { rows: (await db.query(q, params)).rows } }
  catch (e) { return { error: e.message } }
  finally { await exec(`RESET ROLE`) }
}
const thai = (s) => /[฀-๿]/.test(s ?? '')
const create = (user, p) => as(user, `SELECT rpc_create_service_letter($1::jsonb) AS r`, [JSON.stringify(p)])
const update = (user, id, p) => as(user, `SELECT rpc_update_service_letter($1, $2::jsonb)`, [id, JSON.stringify(p)])
const yr = (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY') AS y`))[0].y
let r = await as('admin', `SELECT rpc_upsert_letter_signer(NULL, 'นาย ก', 'ผู้จัดการ') AS id`)
const S1 = r.rows?.[0]?.id
r = await as('admin', `SELECT rpc_upsert_letter_signer(NULL, 'นาย ข', 'รองผู้จัดการ') AS id`)
const S2 = r.rows?.[0]?.id
const P = `PSP-LBSJ3076-${yr}`
const base = { recipient: 'กฟภ.', subject: 'เรื่องทดสอบ', body: '<p>เนื้อความ</p>', signer_id: S1, job_id: J.a }
const no = (res) => res.rows?.[0]?.r?.letter_no

// ---------- 1) nnn กำหนดเองตอนออก ----------
r = await create('service', base); const L1 = r.rows?.[0]?.r
ok('ไม่ระบุ nnn = อัตโนมัติ 001', L1?.letter_no === `${P}-001`, no(r) ?? r.error)
r = await create('service', { ...base, seq_no: '7' })
ok('ระบุ nnn = 7 → 007', no(r) === `${P}-007`, no(r) ?? r.error)
r = await create('project', { ...base, seq_no: '7' })
ok('nnn ซ้ำ = error ไทย "มีอยู่แล้ว"', /มีอยู่แล้ว/.test(r.error ?? '') && thai(r.error), r.error)
r = await create('service', base); const L8 = r.rows?.[0]?.r
ok('อัตโนมัติต่อจากเลขที่กำหนดเอง = 008', L8?.letter_no === `${P}-008`, no(r) ?? r.error)
for (const bad of ['abc', '0', '100000', '-1', '1.5']) {
  r = await create('service', { ...base, seq_no: bad })
  ok(`nnn "${bad}" = error ไทย`, r.error && thai(r.error), r.error)
}
const aud = await one(`SELECT detail FROM audit_logs WHERE action = 'create_service_letter' AND detail LIKE $1`, [`%${P}-007%`])
ok('Audit บอกว่ากำหนดเลขเอง', aud[0]?.detail?.includes('กำหนดเลขเอง'), aud[0]?.detail)

// ---------- 2) เลขถัดไป (นับฉบับที่ลบแล้ว) ----------
await as('admin', `SELECT rpc_delete_service_letter($1) AS p`, [L8.id])
r = await as('service', `SELECT rpc_next_letter_no($1) AS n`, [J.a])
ok('rpc_next_letter_no หลังลบ 008 = 009 (ไม่นำเลขกลับมาใช้)', r.rows?.[0]?.n === `${P}-009`, r.rows?.[0]?.n ?? r.error)
r = await as('service', `SELECT rpc_next_letter_no($1) AS n`, [J.b])
ok('Job อื่นยังไม่มีจดหมาย = 001', r.rows?.[0]?.n === `PSP-LBSJ3189-${yr}-001`, r.rows?.[0]?.n ?? r.error)
r = await as('sales', `SELECT rpc_next_letter_no($1) AS n`, [J.a])
ok('Division ขอเลขถัดไปไม่ได้', r.error && thai(r.error), r.error)

// ---------- 3) เนื้อความ HTML + กันโค้ด ----------
const IMG = 'lbsimg:letter-img/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90.jpg'
r = await create('service', { ...base, body: `<p style="text-align:center"><b>หัว</b></p><table><tbody><tr><td colspan="2">ช่อง</td></tr></tbody></table><img src="${IMG}" style="width:50%">` })
ok('HTML (ตาราง/รูป/จัดกลาง) บันทึกได้', !!no(r), r.error)
r = await create('service', { ...base, body: '<p>ข้อความ &lt;script&gt; และคำว่า javascript: ในเนื้อหา</p>' })
ok('ข้อความที่พูดถึง <script>/javascript: (escape แล้ว) ไม่ถูกปัดตก', !!no(r), r.error)
const danger = [['<script>', '<p>ก</p><script>alert(1)</script>'], ['<img onerror>', '<img src="x" onerror="alert(1)">'],
  ['javascript: ใน href', '<a href="javascript:alert(1)">x</a>'], ['<iframe>', '<iframe src="x"></iframe>'], ['<svg>', '<svg onload=x>']]
for (const [name, body] of danger) {
  r = await create('service', { ...base, body })
  ok(`🔴 ${name} ในเนื้อความ = error ไทย`, r.error && /โค้ดที่ไม่อนุญาต/.test(r.error), r.error)
}
r = await create('service', { ...base, body: '<p><br></p>' })
ok('HTML ว่าง (<p><br></p>) = กรุณากรอกเนื้อความ', /กรุณากรอก/.test(r.error ?? ''), r.error)
r = await create('service', { ...base, body: `<img src="${IMG}">` })
ok('มีแต่รูป (ไม่มีข้อความ) = บันทึกได้', !!no(r), r.error)
r = await create('service', { ...base, body: '<p>' + 'ก'.repeat(1000001) + '</p>' })
ok('เนื้อความ > 1,000,000 ตัวอักษร = error ไทย', /ยาวเกินไป/.test(r.error ?? ''), r.error?.slice(0, 80))
r = await create('service', { ...base, body: '<p>' + 'ก'.repeat(30000) + '</p>' })
ok('เนื้อความ 30,000 ตัวอักษร (เกินเพดานเดิม 20,000) = บันทึกได้', !!no(r), r.error)

// ---------- 4) แก้จดหมายที่ออกแล้ว ----------
const nBefore = (await one(`SELECT count(*)::int c FROM notifications`))[0].c
r = await update('project', L1.id, { ...base, subject: 'แก้แล้ว', body: '<p>เนื้อความใหม่</p>', contract_no: 'CT-1' })
const row = (await one(`SELECT letter_no, subject, contract_no, updated_by, job_id, created_by FROM service_letters WHERE id = $1`, [L1.id]))[0]
ok('Project แก้ได้ · เลขที่/Job/ผู้ออก คงเดิม · บันทึกผู้แก้', !r.error && row.subject === 'แก้แล้ว' && row.letter_no === L1.letter_no
  && row.job_id === J.a && row.created_by === U.service && row.updated_by === U.project && row.contract_no === 'CT-1', r.error ?? JSON.stringify(row))
ok('แก้แล้วไม่แจ้งกระดิ่งซ้ำ', (await one(`SELECT count(*)::int c FROM notifications`))[0].c === nBefore)
const au = await one(`SELECT detail FROM audit_logs WHERE action = 'update_service_letter' AND entity_id = $1`, [L1.id])
ok('Audit update_service_letter', au.length === 1 && au[0].detail.includes(L1.letter_no), JSON.stringify(au))
r = await update('service', L1.id, { ...base, job_id: J.b })
ok('เปลี่ยน Job = error ไทย', /เปลี่ยน Job/.test(r.error ?? ''), r.error)
r = await update('sales', L1.id, base)
ok('Division แก้ไม่ได้', r.error && thai(r.error), r.error)
r = await update('service', '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90', base)
ok('แก้ฉบับที่ไม่มี = error ไทย', /ไม่พบจดหมาย/.test(r.error ?? ''), r.error)
r = await update('service', L1.id, { ...base, body: '<script>x</script><p>ก</p>' })
ok('🔴 แก้แล้วใส่โค้ด = ปัดตก', /โค้ดที่ไม่อนุญาต/.test(r.error ?? ''), r.error)
r = await update('service', L1.id, { ...base, seq_no: '99' })
const row2 = (await one(`SELECT letter_no FROM service_letters WHERE id = $1`, [L1.id]))[0]
ok('ส่ง seq_no ตอนแก้ = เลขที่ไม่เปลี่ยน (แก้ nnn ได้ตอนออกเท่านั้น)', !r.error && row2.letter_no === L1.letter_no, r.error ?? row2.letter_no)
// ผู้ลงนาม: คนเดิมที่ถูกปิดใช้งานภายหลัง = คง snapshot · เปลี่ยนเป็นคนใหม่ = snapshot ใหม่
await as('admin', `SELECT rpc_upsert_letter_signer($1, 'นาย ก', 'ผู้จัดการ', NULL, false)`, [S1])
r = await update('service', L1.id, { ...base, subject: 'แก้รอบ 2' })
ok('ผู้ลงนามเดิมถูกปิดใช้งานแล้ว ยังแก้ฉบับเดิมได้ (คงชื่อเดิม)', !r.error, r.error)
r = await update('service', L1.id, { ...base, signer_id: S2 })
const row3 = (await one(`SELECT signer_name, signer_position FROM service_letters WHERE id = $1`, [L1.id]))[0]
ok('เปลี่ยนผู้ลงนาม = ชื่อ/ตำแหน่งจากรายชื่อ', !r.error && row3.signer_name === 'นาย ข' && row3.signer_position === 'รองผู้จัดการ', r.error ?? JSON.stringify(row3))

// ---------- 5) สิทธิ์ฟังก์ชัน ----------
r = await as('admin', `SELECT app_letter_validate('{}'::jsonb)`)
ok('app_letter_validate เรียกตรงไม่ได้ (ภายใน)', /permission denied/i.test(r.error ?? ''), r.error)
r = await as('anon', `SELECT rpc_update_service_letter($1, '{}'::jsonb)`, [L1.id])
ok('anon เรียกแก้จดหมายไม่ได้', /permission denied/i.test(r.error ?? ''), r.error)
r = await as('anon', `SELECT rpc_next_letter_no($1)`, [J.a])
ok('anon ขอเลขถัดไปไม่ได้', /permission denied/i.test(r.error ?? ''), r.error)

const fail = results.filter(x => !x.pass)
console.log(`\nสรุป: ผ่าน ${results.length - fail.length}/${results.length}`)
if (fail.length) { console.log('ไม่ผ่าน:\n- ' + fail.map(f => f.name).join('\n- ')); process.exitCode = 1 }
