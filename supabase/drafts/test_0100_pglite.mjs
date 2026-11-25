// วิธีรัน (ไม่ได้อยู่ใน devDependencies — ติดตั้งชั่วคราวนอกโปรเจกต์):
//   mkdir <temp> && cd <temp> && echo {"type":"module"} > package.json && npm i @electric-sql/pglite@0.2.17
//   copy ไฟล์นี้ไป <temp> แล้ว: node test_0100_pglite.mjs <lbs-platform>/supabase/migrations <lbs-platform>/supabase/drafts/0100_service_letters.sql
//   ผล 2026-11-25: ผ่าน 56/56 (PostgreSQL 16.4 / PGlite 0.2.17)
// PGlite harness — ทดสอบ supabase/drafts/0100_service_letters.sql บน Postgres 16 จริง
//   จำลองเฉพาะส่วน Supabase (auth.uid / storage / roles / publication / default privileges แบบ 0057+0091)
//   ฟังก์ชัน LBS ที่ร่างเรียกใช้ ดึง "ข้อความจริง" จากไฟล์ migration (ไม่เขียนเลียนแบบ)
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIG = process.argv[2]           // .../lbs-platform/supabase/migrations
const DRAFT = process.argv[3]         // .../lbs-platform/supabase/drafts/0100_service_letters.sql
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
const [{ id: JOB }] = await one(`INSERT INTO jobs (job_no) VALUES ('JOB-T-1') RETURNING id`)

// ---------- รันร่าง (2 รอบ = idempotent) ----------
const draft = readFileSync(DRAFT, 'utf8')
const results = []
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(cond ? 'PASS' : 'FAIL', name, extra) }
for (const round of [1, 2]) {
  try { await exec(draft); ok(`รันร่างรอบ ${round} ไม่มี error`, true) }
  catch (e) { ok(`รันร่างรอบ ${round} ไม่มี error`, false, e.message); process.exitCode = 1; break }
}

// ---------- helpers: เรียกในบทบาท authenticated เหมือนหน้าเว็บ ----------
async function as(user, sql, params) {
  await exec(`RESET ROLE`)
  await one(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [user ? U[user] : ''])
  await exec(`SET ROLE authenticated`)
  try { return { rows: (await db.query(sql, params)).rows } }
  catch (e) { return { error: e.message } }
  finally { await exec(`RESET ROLE`) }
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const thai = (s) => /[฀-๿]/.test(s ?? '')
const create = (user, p) => as(user, `SELECT rpc_create_service_letter($1::jsonb) AS r`, [JSON.stringify(p)])
const base = { recipient: 'กฟภ.', subject: 'เรื่องทดสอบ', body: 'เนื้อความ' }

// ---------- ผู้ลงนาม ----------
let r = await as('admin', `SELECT rpc_upsert_letter_signer(NULL, 'นาย ก', 'ผู้จัดการ') AS id`)
const S1 = r.rows?.[0]?.id; ok('Manage เพิ่มผู้ลงนามได้', S1, r.error)
r = await as('admin', `SELECT rpc_upsert_letter_signer(NULL, 'นาย ข', 'อดีต', NULL, false) AS id`)
const S2 = r.rows?.[0]?.id; ok('Manage เพิ่มผู้ลงนาม (ปิดใช้งาน) ได้', S2, r.error)
r = await as('service', `SELECT rpc_upsert_letter_signer(NULL, 'นาย ค', '') AS id`)
ok('Service ตั้งรายชื่อผู้ลงนามไม่ได้ (error ไทย)', r.error && thai(r.error), r.error)
r = await as('admin', `SELECT rpc_upsert_letter_signer(NULL, '  ', '') AS id`)
ok('ชื่อผู้ลงนามว่าง = error ไทย', r.error && thai(r.error), r.error)

// ---------- ออกจดหมาย ----------
const yr = (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY') AS y`))[0].y
r = await create('service', { ...base, signer_id: S1, signer_name: 'ชื่อปลอม', created_by: U.sales, letter_no: 'X-1' })
const L1 = r.rows?.[0]?.r
ok('Service ออกจดหมายได้ · เลข PSP-LBS-ปี-001', L1?.letter_no === `PSP-LBS-${yr}-001`, JSON.stringify(L1 ?? r.error))
r = await create('project', { ...base, signer_id: S1, job_id: JOB, sig_image: PNG, category: 'SM' })
const L2 = r.rows?.[0]?.r
ok('Project ออกจดหมายได้ · เลขถัดไป 002', L2?.letter_no === `PSP-LBS-${yr}-002`, JSON.stringify(L2 ?? r.error))
r = await create('admin', { ...base, signer_id: S1, category: 'WARRANTY', warranty_start: '2026-01-31', warranty_end: '2027-01-30' })
ok('Manage ออกจดหมายได้ (Warranty วันที่ถูก)', r.rows?.[0]?.r?.letter_no === `PSP-LBS-${yr}-003`, r.error)
for (const d of ['sales', 'purchasing', 'vip']) {
  r = await create(d, { ...base, signer_id: S1 }); ok(`${d} ออกจดหมายไม่ได้ (error ไทย)`, r.error && thai(r.error), r.error)
}
r = await create('off', { ...base, signer_id: S1 }); ok('บัญชีที่ถูกปิด ออกไม่ได้', /ปิดการใช้งาน/.test(r.error ?? ''), r.error)
r = await create(null, { ...base, signer_id: S1 }); ok('ไม่ได้ login ออกไม่ได้', /เข้าสู่ระบบ/.test(r.error ?? ''), r.error)

const row1 = (await one(`SELECT * FROM service_letters WHERE id = $1`, [L1.id]))[0]
ok('ชื่อผู้ลงนาม snapshot จากตาราง (ไม่รับ "ชื่อปลอม")', row1.signer_name === 'นาย ก' && row1.signer_position === 'ผู้จัดการ', row1.signer_name)
ok('created_by = ผู้ล็อกอินจริง (ไม่ใช่ที่ส่งมา)', row1.created_by === U.service)
ok('letter_no ระบบออกเอง (ไม่รับ X-1)', row1.letter_no.startsWith('PSP-LBS-'))
ok('ไม่มีลายเซ็น = sig_image NULL (เว้นที่เซ็นมือ)', row1.sig_image === null)

// ---------- ตรวจค่า ----------
const cases = [
  ['ผู้ลงนามปิดใช้งาน', { signer_id: S2 }], ['signer_id ไม่ใช่ UUID', { signer_id: 'abc' }], ['ไม่เลือกผู้ลงนาม', {}],
  ['วันที่ 01/02/2026 (MDY)', { signer_id: S1, letter_date: '01/02/2026' }], ['วันที่ 2026-02-30', { signer_id: S1, letter_date: '2026-02-30' }],
  ['ประกัน 2026-13-45', { signer_id: S1, warranty_start: '2026-13-45' }], ['job_id ไม่ใช่ UUID', { signer_id: S1, job_id: 'abc' }],
  ['job_id ไม่มีจริง', { signer_id: S1, job_id: '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90' }],
  ['ลายเซ็นอันตราย', { signer_id: S1, sig_image: 'x" onerror="alert(1)' }], ['ลายเซ็น SVG', { signer_id: S1, sig_image: 'data:image/svg+xml;base64,PHN2Zz4=' }],
  ['ขาดเรื่อง', { signer_id: S1, subject: ' ' }],
  ['category นอกชุด', { signer_id: S1, category: 'HACK' }], ['letter_type นอกชุด', { signer_id: S1, letter_type: 'X' }],
  ['status นอกชุด', { signer_id: S1, status: 'X' }], ['ประกันวันเริ่มหลังวันจบ', { signer_id: S1, warranty_start: '2027-01-01', warranty_end: '2026-01-01' }],
]
for (const [name, p] of cases) {
  r = await create('service', { ...base, ...p })
  ok(`ปัดตก: ${name} · error ภาษาไทย`, r.error && thai(r.error), r.error)
}

// ---------- แจ้งเตือน + Audit ----------
const n = await one(`SELECT type, dept, job_id, line_status FROM notifications`)
ok('อ้าง Job → กระดิ่งถึง Project 1 รายการ · line_status off (ไม่ส่ง LINE)',
  n.length === 1 && n[0].type === 'letter_issued' && n[0].dept === 'project' && n[0].job_id === JOB && n[0].line_status === 'off', JSON.stringify(n))
const a = await one(`SELECT action, count(*)::int c FROM audit_logs GROUP BY action ORDER BY action`)
ok('Audit: create_service_letter 3 · create_letter_signer 2', JSON.stringify(a).includes('"create_service_letter","c":3') && JSON.stringify(a).includes('"create_letter_signer","c":2'), JSON.stringify(a))

// ---------- เขียนตารางตรง / ฟังก์ชันภายใน / RLS ----------
r = await as('admin', `INSERT INTO service_letters (letter_no, letter_date, recipient, subject, body, signer_id, signer_name, created_by)
  VALUES ('HACK', current_date, 'a', 'b', 'c', '${S1}', 'x', '${U.admin}')`)
ok('INSERT ตรงลง service_letters ไม่ได้ (แม้ Manage)', /permission denied/i.test(r.error ?? ''), r.error)
r = await as('admin', `UPDATE letter_signers SET is_active = true`)
ok('UPDATE ตรงลง letter_signers ไม่ได้', /permission denied/i.test(r.error ?? ''), r.error)
r = await as('service', `SELECT app_assert_letter()`)
ok('app_assert_letter เรียกตรงไม่ได้', /permission denied/i.test(r.error ?? ''), r.error)
r = await as('sales', `SELECT count(*)::int c FROM service_letters`)
ok('ทุกแผนกที่ Active อ่านจดหมายได้ (sales เห็น 3)', r.rows?.[0]?.c === 3, r.error)
r = await as('off', `SELECT count(*)::int c FROM service_letters`)
ok('บัญชีที่ถูกปิด อ่านไม่ได้ (require_active)', r.rows?.[0]?.c === 0, r.error ?? JSON.stringify(r.rows))

// ---------- ไฟล์แนบ ----------
const addFile = (user, letter, path, mime = 'application/pdf', size = 1000) =>
  as(user, `SELECT rpc_add_service_letter_file($1, $2, 'ไฟล์.pdf', $3, $4) AS id`, [letter, path, mime, size])
r = await addFile('project', L1.id, `letters/${L1.id}/a.pdf`); const F1 = r.rows?.[0]?.id
ok('Project แนบไฟล์ได้ (path ใต้ letters/<id>/)', F1, r.error)
r = await addFile('service', L1.id, `letters/${L2.id}/x.pdf`); ok('path ของจดหมายอื่น = ปัดตก', r.error, r.error)
r = await addFile('service', L1.id, `letters/${L1.id}/b.exe`, 'application/x-msdownload'); ok('ชนิดไฟล์ .exe = ปัดตก', r.error, r.error)
r = await addFile('service', L1.id, `letters/${L1.id}/c.pdf`, 'application/pdf', 11 * 1024 * 1024); ok('ไฟล์ > 10MB = ปัดตก', r.error, r.error)
r = await addFile('sales', L1.id, `letters/${L1.id}/d.pdf`); ok('sales แนบไฟล์ไม่ได้', r.error && thai(r.error), r.error)
// [harness fix] เดิมเคส "path อื่น" ส่ง path ที่ถูกต้อง (letters/<id>/z) ⇒ แนบสำเร็จโดยไม่ตั้งใจ
for (const [name, path, mime, size] of [['path อื่น', `letters/${L2.id}/z.pdf`, 'application/pdf', 1],
  ['ชนิดไฟล์', `letters/${L1.id}/z.exe`, 'application/x-msdownload', 1], ['ขนาด', `letters/${L1.id}/z.pdf`, 'application/pdf', 99e9]]) {
  // error ที่ผู้ใช้จะเห็น ต้องเป็นภาษาไทย (LBS ไม่มีตัวแปลง error — grep แล้ว)
  r = await addFile('service', L1.id, path, mime, size)
  ok(`แนบไฟล์ผิด (${name}) · error ภาษาไทย`, r.error && thai(r.error), r.error)
}

// ---------- storage policy ----------
await exec(`RESET ROLE`)
r = await as('project', `INSERT INTO storage.objects (bucket_id, name) VALUES ('letter-docs', 'letters/${L1.id}/a.pdf')`)
ok('storage: Project อัปโหลดเข้า letter-docs ได้', !r.error, r.error)
r = await as('sales', `INSERT INTO storage.objects (bucket_id, name) VALUES ('letter-docs', 'letters/x/y.pdf')`)
ok('storage: sales อัปโหลดไม่ได้', /row-level security/i.test(r.error ?? ''), r.error)
r = await as('service', `DELETE FROM storage.objects WHERE name = 'letters/${L1.id}/a.pdf' RETURNING name`)
ok('storage: ลบไฟล์ที่ยังมีแถวอ้างถึงไม่ได้', (r.rows?.length ?? 0) === 0, r.error ?? JSON.stringify(r.rows))

// ---------- ลบ ----------
r = await as('service', `SELECT rpc_delete_service_letter($1) AS p`, [L1.id]); ok('Service ลบจดหมายไม่ได้ (error ไทย)', r.error && thai(r.error), r.error)
r = await as('admin', `SELECT rpc_delete_service_letter($1) AS p`, [L1.id])
ok('Manage ลบได้ · คืน path ไฟล์แนบ', JSON.stringify(r.rows?.[0]?.p) === JSON.stringify([`letters/${L1.id}/a.pdf`]), r.error ?? JSON.stringify(r.rows))
ok('แถวไฟล์แนบหายตาม (CASCADE)', (await one(`SELECT count(*)::int c FROM service_letter_files`))[0].c === 0)
r = await as('service', `DELETE FROM storage.objects WHERE name = 'letters/${L1.id}/a.pdf' RETURNING name`)
ok('storage: หลังลบแถวแล้ว ลบไฟล์จริงได้', r.rows?.length === 1, r.error ?? JSON.stringify(r.rows))
r = await create('service', { ...base, signer_id: S1 })
ok('ลบแล้วเลขไม่ย้อน/ไม่ชน (ได้ 004)', r.rows?.[0]?.r?.letter_no === `PSP-LBS-${yr}-004`, JSON.stringify(r.rows?.[0]?.r ?? r.error))

const fail = results.filter(x => !x.pass)
console.log(`\nสรุป: ผ่าน ${results.length - fail.length}/${results.length}`)
if (fail.length) { console.log('ไม่ผ่าน:\n- ' + fail.map(f => f.name).join('\n- ')); process.exitCode = 1 }
