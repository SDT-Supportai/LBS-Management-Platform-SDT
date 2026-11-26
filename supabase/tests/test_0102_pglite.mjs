// วิธีรัน (PGlite ไม่ได้อยู่ใน devDependencies — ติดตั้งชั่วคราวนอกโปรเจกต์ แบบเดียวกับ test_0100_pglite.mjs):
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

// ---------- รัน 0100 → 0101 → 0102 (2 รอบ) ----------
const files = ['0100_service_letters.sql', '0101_service_letter_contract_no.sql', '0102_service_letter_no_by_job.sql']
const sql = files.map(readMig).join('\n;\n')
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(cond ? 'PASS' : 'FAIL', name, extra) }
for (const round of [1, 2]) {
  try { await exec(sql); ok(`รัน 0100→0102 รอบ ${round} ไม่มี error`, true) }
  catch (e) { ok(`รัน 0100→0102 รอบ ${round} ไม่มี error`, false, e.message); process.exitCode = 1; break }
}

async function as(user, q, params) {
  await exec(`RESET ROLE`)
  await one(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [user ? U[user] : ''])
  await exec(`SET ROLE authenticated`)
  try { return { rows: (await db.query(q, params)).rows } }
  catch (e) { return { error: e.message } }
  finally { await exec(`RESET ROLE`) }
}
const thai = (s) => /[฀-๿]/.test(s ?? '')
const create = (user, p) => as(user, `SELECT rpc_create_service_letter($1::jsonb) AS r`, [JSON.stringify(p)])
const yr = (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY') AS y`))[0].y
let r = await as('admin', `SELECT rpc_upsert_letter_signer(NULL, 'นาย ก', 'ผู้จัดการ') AS id`)
const S1 = r.rows?.[0]?.id
const base = { recipient: 'กฟภ.', subject: 'เรื่องทดสอบ', body: 'เนื้อความ', signer_id: S1 }
const no = (res) => res.rows?.[0]?.r?.letter_no

// ---------- 1) ต้องเลือก Job ก่อน ----------
r = await create('service', base)
ok('ไม่เลือก Job = ปัดตก · error ไทย "กรุณาเลือก Job No."', /กรุณาเลือก Job No\./.test(r.error ?? ''), r.error)
r = await create('service', { ...base, job_id: '  ' })
ok('job_id ว่าง (ช่องว่าง) = ปัดตก', /กรุณาเลือก Job No\./.test(r.error ?? ''), r.error)
r = await create('service', { ...base, job_id: '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90' })
ok('Job ไม่มีในระบบ = error ไทย', r.error && thai(r.error), r.error)
r = await create('sales', { ...base, job_id: J.a })
ok('Division ออกไม่ได้ (สิทธิ์เดิม)', r.error && thai(r.error), r.error)

// ---------- 2) เลข PSP-LBSJXXXX-YYYY-nnn ตาม Job ----------
r = await create('service', { ...base, job_id: J.a });  const a1 = r.rows?.[0]?.r
ok('Job 102LB10J3076 ฉบับแรก = PSP-LBSJ3076-ปี-001', a1?.letter_no === `PSP-LBSJ3076-${yr}-001`, no(r) ?? r.error)
r = await create('project', { ...base, job_id: J.a, category: 'SM' })
ok('Job เดิม ฉบับที่ 2 = 002 (ทุกประเภทรันร่วมใน Job)', no(r) === `PSP-LBSJ3076-${yr}-002`, no(r) ?? r.error)
r = await create('admin', { ...base, job_id: J.b, category: 'WARRANTY', warranty_start: '2026-01-01', warranty_end: '2027-01-01' })
ok('Job อื่น (102LB20J3189) เริ่ม 001 ของตัวเอง', no(r) === `PSP-LBSJ3189-${yr}-001`, no(r) ?? r.error)
r = await create('service', { ...base, job_id: J.demo })
ok('Job แบบเดโม JOB-2026-0004 → J0004', no(r) === `PSP-LBSJ0004-${yr}-001`, no(r) ?? r.error)
r = await create('service', { ...base, job_id: J.dup });  const d3 = r.rows?.[0]?.r
ok('คนละ Job แต่รหัสซ้ำ (102LB20J3076) = ต่อลำดับเดียวกัน 003 · ไม่ชน UNIQUE', d3?.letter_no === `PSP-LBSJ3076-${yr}-003`, no(r) ?? r.error)

// ลบฉบับล่าสุดของหัวเลขนั้นแล้ว เลขต้องไม่ถูกนำกลับมาใช้
await as('admin', `SELECT rpc_delete_service_letter($1) AS p`, [d3.id])
r = await create('service', { ...base, job_id: J.a })
ok('ลบฉบับล่าสุด (003) แล้ว ฉบับถัดไป = 004 ไม่ใช่ 003', no(r) === `PSP-LBSJ3076-${yr}-004`, no(r) ?? r.error)

// ---------- 3) ของเดิมยังทำงาน ----------
r = await create('project', { ...base, job_id: J.b, contract_no: ' CT-9 ' })
const row = (await one(`SELECT contract_no, job_id FROM service_letters WHERE letter_no = $1`, [no(r)]))[0]
ok('Contract No. (0101) ยังบันทึกได้', row?.contract_no === 'CT-9' && row?.job_id === J.b, JSON.stringify(row ?? r.error))
const n = await one(`SELECT count(*)::int c, bool_and(line_status = 'off') off, bool_and(dept = 'project') pj FROM notifications WHERE type = 'letter_issued'`)
const nLetters = (await one(`SELECT count(*)::int c FROM audit_logs WHERE action = 'create_service_letter'`))[0].c
ok('กระดิ่งถึง Project ทุกฉบับ (เท่าจำนวนที่ออก) · ไม่ส่ง LINE', n[0].c === nLetters && n[0].off && n[0].pj, JSON.stringify({ ...n[0], nLetters }))
r = await as('admin', `SELECT * FROM letter_no_seq`)
ok('ตัวนับ letter_no_seq อ่านตรงไม่ได้ (แม้ Manage)', /permission denied/i.test(r.error ?? ''), r.error ?? JSON.stringify(r.rows))
r = await as('admin', `SELECT app_letter_job_code('x') AS c`)
ok('app_letter_job_code เรียกตรงไม่ได้ (ภายใน)', /permission denied/i.test(r.error ?? ''), r.error ?? JSON.stringify(r.rows))
const codes = await one(`SELECT app_letter_job_code('102LB10J3076') a, app_letter_job_code('J12') b, app_letter_job_code('102LB10J30761') c, app_letter_job_code(' 102lb10j3076 ') d`)
ok('app_letter_job_code ตรงกับ letters.ts (3076 · 0012 · 30761 · ไม่สนตัวพิมพ์/ช่องว่าง)',
  codes[0].a === '3076' && codes[0].b === '0012' && codes[0].c === '30761' && codes[0].d === '3076', JSON.stringify(codes[0]))

const fail = results.filter(x => !x.pass)
console.log(`\nสรุป: ผ่าน ${results.length - fail.length}/${results.length}`)
if (fail.length) { console.log('ไม่ผ่าน:\n- ' + fail.map(f => f.name).join('\n- ')); process.exitCode = 1 }
