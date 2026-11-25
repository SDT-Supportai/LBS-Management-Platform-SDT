-- =====================================================================
-- ⚠️ DRAFT — ยังไม่รันบน Supabase จริง
--    ย้ายไป supabase/migrations/ (เลขถัดไปจริงตอนนั้น) เมื่อผูกระบบตาม docs/service-letter-integration.md
--    ทดสอบบน PGlite (PostgreSQL 16.4) 2026-11-25: ผ่าน 56/56 — test_0100_pglite.mjs ข้างไฟล์นี้
--      (ฟังก์ชัน LBS ที่เรียกใช้ดึงข้อความจริงจาก migrations · จำลอง auth/storage/roles/default privileges 0057+0091)
--      รันซ้ำ 2 รอบไม่ error · สิทธิ์ 7 แผนก + บัญชีปิด · เลขรัน · ตรวจค่า 15 แบบ (error ไทยทุกข้อ) · กระดิ่งไม่ส่ง LINE
--      · เขียนตรง/เรียกฟังก์ชันภายในไม่ได้ · require_active · ไฟล์แนบ · storage policy · ลบ + CASCADE
--      ⚠️ ยังไม่ได้ทดสอบ: กดพร้อมกันหลาย connection (PGlite มี connection เดียว — advisory lock + UNIQUE กันไว้)
--
-- 0100: Service Letter (2026-11-25) — ยกจาก ServiceMS Instance 1 (ตาราง letters + Edge Function api)
--  ต้นแบบ: D:\Claude Code.md\15. DIGITAL & AI AUTOMATION TALENT Service MS\docs\templates\service-letter
--
--  ต่างจาก ServiceMS:
--   • ไม่มี Edge Function / session token เอง — ใช้ Supabase Auth + profiles + RPC SECURITY DEFINER แบบ LBS
--   • เลขที่ "PSP-LBS-YYYY-NNN" (แยกจาก ServiceMS "PSP Service-…") ออกใน RPC ใต้ pg_advisory_xact_lock + UNIQUE
--     (ServiceMS: insert + retry 23505) · ปีตามเวลาไทย · รันร่วมทุกประเภท (GENERAL / SM / WARRANTY)
--   • รับเฉพาะคอลัมน์ที่อนุญาต (ต้นฉบับ spread ทั้งก้อน) · created_by = auth.uid()
--   • ลายเซ็น: CHECK ให้เป็น data URL รูป PNG/JPEG ล้วน (กัน stored XSS ในแท็บพิมพ์)
--   • ไฟล์แนบ: ตาราง service_letter_files + private bucket letter-docs (กติกาเดียวกับ 0076/0079/0091)
--     แทนสตริง "name::url||…" · DB เก็บ path ขอ signed URL ตอนเปิด
--   • อ้างอิงโครงการ = job_id (FK jobs) แทนข้อความ ref_job
--   • ผู้ลงนาม: เลือกจากตาราง letter_signers ที่ Manage ตั้ง (ชื่อ/ตำแหน่ง snapshot ลงจดหมาย ไม่รับที่พิมพ์มาเอง)
--     ไม่มีลายเซ็นเก็บในระบบ — เซ็นอิเล็กทรอนิกส์ต่อฉบับ (sig_image) หรือเว้นที่ให้เซ็นมือ (sig_image ว่าง)
--   • แจ้งเตือน: อ้าง Job = กระดิ่งถึง Project ของงานนั้น (type letter_issued ไม่อยู่ใน allowlist LINE ของ
--     app_notify 0083 ⇒ line_status off อัตโนมัติ — ไม่ส่ง LINE) · ไม่อ้าง Job = ไม่แจ้ง (มี Audit)
--  คำตอบผู้ใช้ 2026-11-25 (docs/service-letter-integration.md):
--  สิทธิ์: ออกจดหมาย/แนบไฟล์ = service + project (+admin อัตโนมัติ) · ลบจดหมาย / ตั้งรายชื่อผู้ลงนาม = admin
--          อ่าน = ทุกแผนกที่ Active
--  demo sync: src/data/letters.ts (createLetterDemo / deleteLetterDemo / upsertSignerDemo)
--  idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS)
-- =====================================================================

-- ---------- 1) schema ----------
-- ผู้ลงนาม (Manage ตั้ง) — ปิดใช้งานแทนการลบ เพราะจดหมายเก่าอ้างถึง
CREATE TABLE IF NOT EXISTS letter_signers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL CHECK (btrim(full_name) <> ''),
  position    TEXT NOT NULL DEFAULT '',
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES profiles(id),
  updated_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS service_letters (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_no        TEXT NOT NULL UNIQUE,
  letter_date      DATE NOT NULL,
  category         TEXT NOT NULL DEFAULT 'GENERAL',
  letter_type      TEXT NOT NULL DEFAULT 'EXTERNAL',
  status           TEXT NOT NULL DEFAULT 'ISSUED',
  recipient        TEXT NOT NULL,
  recipient_org    TEXT,
  subject          TEXT NOT NULL,
  reference        TEXT,
  enclosure        TEXT,
  body             TEXT NOT NULL,
  body2            TEXT,
  attention        TEXT,
  site             TEXT,
  tech_list        TEXT,
  job_id           UUID REFERENCES jobs(id) ON DELETE SET NULL,
  cc               TEXT,
  signer_id        UUID NOT NULL REFERENCES letter_signers(id),
  signer_name      TEXT NOT NULL,                -- snapshot จาก letter_signers ณ วันออก
  signer_position  TEXT,
  sig_image        TEXT,                         -- ว่าง = เว้นที่ให้เซ็นมือ
  warranty_type    TEXT,
  warranty_start   DATE,
  warranty_end     DATE,
  warranty_detail  TEXT,
  created_by       UUID NOT NULL REFERENCES profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_letters_category_ck CHECK (category IN ('GENERAL', 'SM', 'WARRANTY')),
  CONSTRAINT service_letters_type_ck     CHECK (letter_type IN ('EXTERNAL', 'INTERNAL')),
  CONSTRAINT service_letters_status_ck   CHECK (status IN ('ISSUED', 'DRAFT')),
  -- 🔴 วางใน <img src="..."> ของเอกสารพิมพ์ — ต้องเป็นรูปล้วน ไม่มี " หรือ javascript:
  CONSTRAINT service_letters_sig_ck CHECK (sig_image IS NULL OR (
    length(sig_image) <= 400000 AND sig_image ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$')),
  CONSTRAINT service_letters_warranty_ck CHECK (
    warranty_start IS NULL OR warranty_end IS NULL OR warranty_start <= warranty_end)
);
CREATE INDEX IF NOT EXISTS idx_service_letters_created ON service_letters(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_letters_job ON service_letters(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_letter_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id    UUID NOT NULL REFERENCES service_letters(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL UNIQUE,          -- path ใน private bucket letter-docs (ไม่ใช่ URL)
  file_name    TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  uploaded_by  UUID NOT NULL REFERENCES profiles(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ชนิดไฟล์ตามต้นฉบับ: PDF / Word / Excel / รูป · ≤ 10MB ต่อไฟล์
  CONSTRAINT service_letter_files_type_ck CHECK (
    mime_type IN ('application/pdf', 'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    OR mime_type LIKE 'image/%'),
  CONSTRAINT service_letter_files_size_ck CHECK (size_bytes > 0 AND size_bytes <= 10 * 1024 * 1024),
  CONSTRAINT service_letter_files_path_ck CHECK (file_path LIKE 'letters/' || letter_id::text || '/%')
);
CREATE INDEX IF NOT EXISTS idx_service_letter_files_letter ON service_letter_files(letter_id);

-- ---------- 2) RLS · ปิดเขียนตรง (0057) · require_active (0058/0091) · realtime ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['letter_signers', 'service_letters', 'service_letter_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS read_all ON %I', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS require_active ON %I', t);
    EXECUTE format('CREATE POLICY require_active ON %I AS RESTRICTIVE FOR SELECT TO authenticated USING (my_is_active())', t);
    -- เขียนได้ทาง RPC เท่านั้น (ไม่มี policy เขียน + ถอนสิทธิ์ตาราง)
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM authenticated, anon', t);
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ---------- 3) Storage bucket แบบปิด + policy (กติกา 0091 ข้อ 1.2) ----------
-- รันบรรทัดนี้ error (สิทธิ์ storage) → สร้าง bucket letter-docs แบบ **ไม่ public** ใน Dashboard แล้วรันต่อ
INSERT INTO storage.buckets (id, name, public) VALUES ('letter-docs', 'letter-docs', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS letter_docs_read ON storage.objects;
CREATE POLICY letter_docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'letter-docs' AND public.my_is_active());
DROP POLICY IF EXISTS letter_docs_insert ON storage.objects;
CREATE POLICY letter_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'letter-docs' AND public.my_is_active()
              AND public.my_department() IN ('service', 'project', 'admin'));
-- ลบไฟล์จริงได้เฉพาะไฟล์ที่ไม่มีแถวอ้างถึงแล้ว (= ต้องผ่าน RPC ลบแถว + Audit ก่อน)
DROP POLICY IF EXISTS letter_docs_delete ON storage.objects;
CREATE POLICY letter_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'letter-docs' AND public.my_is_active()
         AND public.my_department() IN ('service', 'project', 'admin')
         AND NOT EXISTS (SELECT 1 FROM public.service_letter_files f WHERE f.file_path = objects.name));

-- ---------- 4) helper (ภายใน — ไม่ GRANT ให้ผู้ใช้เรียกตรง ตามกติกา 0091) ----------
CREATE OR REPLACE FUNCTION app_assert_letter() RETURNS profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN app_assert_dept(ARRAY['service', 'project']);     -- +admin อัตโนมัติ (0002) · คำตอบผู้ใช้ข้อ 1
END $$;
REVOKE ALL ON FUNCTION app_assert_letter() FROM PUBLIC, anon, authenticated;

-- ---------- 5) RPC ----------
-- p = jsonb จากฟอร์ม (snake_case) · รับเฉพาะคีย์ที่รู้จัก · คืน { id, letter_no }
CREATE OR REPLACE FUNCTION rpc_create_service_letter(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; newid UUID; v_no TEXT; v_year TEXT; v_max INT;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_sig TEXT := NULLIF(btrim(COALESCE(p->>'sig_image', '')), '');
  v_job UUID;                      -- [debug 2026-11-25] เดิม cast ::uuid ใน DECLARE = error อังกฤษก่อนถึงจุดตรวจ
  s letter_signers;
  t TEXT;
  uuid_re CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  actor := app_assert_letter();
  -- [debug 2026-11-25] วันที่ต้องเป็น YYYY-MM-DD ที่มีจริง — ไม่งั้น ::date อ่าน "01/02/2026" ตาม DateStyle (MDY) ผิดเงียบ
  FOREACH t IN ARRAY ARRAY['letter_date', 'warranty_start', 'warranty_end'] LOOP
    IF NULLIF(p->>t, '') IS NOT NULL THEN
      IF (p->>t) !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'รูปแบบวันที่ไม่ถูกต้อง (%) — ต้องเป็นวันที่จริงแบบ YYYY-MM-DD', t;
      END IF;
      BEGIN
        PERFORM (p->>t)::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'รูปแบบวันที่ไม่ถูกต้อง (%) — ไม่มีวันที่นี้ในปฏิทิน', t;
      END;
    END IF;
  END LOOP;
  -- [PGlite 2026-11-25] ตัวเลือกนอกชุด / ช่วงประกันกลับด้าน เดิมปล่อยให้ CHECK ปัดตก ⇒ ผู้ใช้เห็น
  --   "violates check constraint ..." ภาษาอังกฤษ (LBS ไม่มีตัวแปลง error) · CHECK ยังอยู่เป็นด่านสุดท้าย
  IF COALESCE(NULLIF(p->>'category', ''), 'GENERAL') NOT IN ('GENERAL', 'SM', 'WARRANTY') THEN
    RAISE EXCEPTION 'ประเภทจดหมายไม่ถูกต้อง'; END IF;
  IF COALESCE(NULLIF(p->>'letter_type', ''), 'EXTERNAL') NOT IN ('EXTERNAL', 'INTERNAL') THEN
    RAISE EXCEPTION 'ชนิดหนังสือไม่ถูกต้อง (ภายนอก / ภายใน)'; END IF;
  IF COALESCE(NULLIF(p->>'status', ''), 'ISSUED') NOT IN ('ISSUED', 'DRAFT') THEN
    RAISE EXCEPTION 'สถานะจดหมายไม่ถูกต้อง'; END IF;
  IF NULLIF(p->>'warranty_start', '') IS NOT NULL AND NULLIF(p->>'warranty_end', '') IS NOT NULL
     AND (p->>'warranty_start')::date > (p->>'warranty_end')::date THEN
    RAISE EXCEPTION 'วันเริ่มรับประกันต้องไม่หลังวันสิ้นสุด'; END IF;
  IF NULLIF(p->>'job_id', '') IS NOT NULL THEN
    IF (p->>'job_id') !~ uuid_re THEN RAISE EXCEPTION 'ไม่พบ Job ที่อ้างถึง (รหัสไม่ถูกต้อง)'; END IF;
    v_job := (p->>'job_id')::uuid;
  END IF;
  IF COALESCE(btrim(p->>'recipient'), '') = '' OR COALESCE(btrim(p->>'subject'), '') = ''
     OR COALESCE(btrim(p->>'body'), '') = '' THEN
    RAISE EXCEPTION 'กรุณากรอก ผู้รับ / เรื่อง / เนื้อความ ให้ครบ';
  END IF;
  -- ผู้ลงนามต้องมาจากรายชื่อที่ Manage ตั้งและยังใช้งาน · ชื่อ/ตำแหน่งเอาจากตาราง (ไม่รับที่ส่งมา)
  IF NULLIF(p->>'signer_id', '') IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกผู้ลงนาม'; END IF;
  IF (p->>'signer_id') !~ uuid_re THEN RAISE EXCEPTION 'ไม่พบผู้ลงนามในรายชื่อที่ใช้งาน — กรุณาเลือกใหม่'; END IF;
  SELECT * INTO s FROM letter_signers WHERE id = (p->>'signer_id')::uuid AND is_active;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบผู้ลงนามในรายชื่อที่ใช้งาน — กรุณาเลือกใหม่'; END IF;
  -- ข้อความยาวผิดปกติ (กันยัดข้อมูลก้อนใหญ่) — ฟอร์มจริงไม่ถึง
  FOREACH t IN ARRAY ARRAY['recipient','recipient_org','subject','reference','enclosure','body','body2',
                           'attention','site','tech_list','cc',
                           'warranty_type','warranty_detail'] LOOP
    IF length(COALESCE(p->>t, '')) > 20000 THEN RAISE EXCEPTION 'ข้อความช่อง % ยาวเกินไป', t; END IF;
  END LOOP;
  IF v_sig IS NOT NULL AND NOT (length(v_sig) <= 400000
       AND v_sig ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$') THEN
    RAISE EXCEPTION 'ลายเซ็นไม่ถูกต้อง (ต้องเป็นรูป PNG/JPEG ไม่เกิน 300 KB) — กรุณาวาดใหม่';
  END IF;
  IF v_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = v_job) THEN
    RAISE EXCEPTION 'ไม่พบ Job ที่อ้างถึง';
  END IF;

  -- เลขที่: ล็อกตัวนับของระบบจดหมาย (คนกดพร้อมกันได้เลขเรียงกัน ไม่ชน) · ปีไทย · รันร่วมทุกประเภท
  PERFORM pg_advisory_xact_lock(hashtext('lbs:service-letter-no'));
  v_year := to_char(v_today, 'YYYY');
  SELECT COALESCE(MAX((substring(letter_no FROM '(\d+)$'))::int), 0) INTO v_max
    FROM service_letters WHERE letter_no LIKE 'PSP-LBS-' || v_year || '-%';
  v_no := 'PSP-LBS-' || v_year || '-' || lpad((v_max + 1)::text, 3, '0');

  INSERT INTO service_letters (
    letter_no, letter_date, category, letter_type, status, recipient, recipient_org, subject, reference,
    enclosure, body, body2, attention, site, tech_list, job_id, cc, signer_id, signer_name, signer_position, sig_image,
    warranty_type, warranty_start, warranty_end, warranty_detail, created_by)
  VALUES (
    v_no,
    COALESCE(NULLIF(p->>'letter_date', '')::date, v_today),
    COALESCE(NULLIF(p->>'category', ''), 'GENERAL'),
    COALESCE(NULLIF(p->>'letter_type', ''), 'EXTERNAL'),
    COALESCE(NULLIF(p->>'status', ''), 'ISSUED'),
    btrim(p->>'recipient'), NULLIF(btrim(COALESCE(p->>'recipient_org', '')), ''),
    btrim(p->>'subject'), NULLIF(btrim(COALESCE(p->>'reference', '')), ''),
    NULLIF(btrim(COALESCE(p->>'enclosure', '')), ''), btrim(p->>'body'),
    NULLIF(btrim(COALESCE(p->>'body2', '')), ''), NULLIF(btrim(COALESCE(p->>'attention', '')), ''),
    NULLIF(btrim(COALESCE(p->>'site', '')), ''), NULLIF(btrim(COALESCE(p->>'tech_list', '')), ''),
    v_job, NULLIF(btrim(COALESCE(p->>'cc', '')), ''),
    s.id, s.full_name, NULLIF(s.position, ''),
    v_sig,
    NULLIF(btrim(COALESCE(p->>'warranty_type', '')), ''),
    NULLIF(p->>'warranty_start', '')::date, NULLIF(p->>'warranty_end', '')::date,
    NULLIF(btrim(COALESCE(p->>'warranty_detail', '')), ''),
    actor.id)
  RETURNING id INTO newid;           -- ค่าตัวเลือกผิด / วันประกันกลับด้าน → CHECK constraint ปัดตก

  PERFORM app_audit('service_letter', newid, 'create_service_letter', actor.id,
    'ออกจดหมาย ' || v_no || ' — ' || btrim(p->>'subject') || ' · ผู้ลงนาม ' || s.full_name ||
    CASE WHEN v_sig IS NULL THEN ' (เซ็นมือ)' ELSE ' (เซ็นอิเล็กทรอนิกส์)' END);
  -- กระดิ่งถึง Project ของงานที่อ้างถึง — letter_issued ไม่อยู่ใน allowlist LINE (0083) ⇒ ไม่ส่ง LINE
  IF v_job IS NOT NULL THEN
    PERFORM app_notify('letter_issued', '✉️ ออกจดหมาย ' || v_no || ' — ' || btrim(p->>'subject'), 'project', v_job);
  END IF;
  RETURN jsonb_build_object('id', newid, 'letter_no', v_no);
END $$;

-- รายชื่อผู้ลงนาม: เพิ่ม (p_id ว่าง) / แก้ / ปิดใช้งาน — Manage เท่านั้น · คืน id
CREATE OR REPLACE FUNCTION rpc_upsert_letter_signer(
  p_id UUID, p_full_name TEXT, p_position TEXT DEFAULT '', p_sort_order INT DEFAULT NULL, p_is_active BOOLEAN DEFAULT true
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d letter_signers; v_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);      -- admin เท่านั้น
  IF COALESCE(btrim(p_full_name), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุชื่อผู้ลงนาม'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO letter_signers (full_name, position, sort_order, is_active, created_by)
    VALUES (btrim(p_full_name), btrim(COALESCE(p_position, '')),
            COALESCE(p_sort_order, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM letter_signers)),
            COALESCE(p_is_active, true), actor.id)
    RETURNING id INTO v_id;
    PERFORM app_audit('letter_signer', v_id, 'create_letter_signer', actor.id, 'เพิ่มผู้ลงนาม ' || btrim(p_full_name));
  ELSE
    SELECT * INTO d FROM letter_signers WHERE id = p_id FOR UPDATE;
    IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบผู้ลงนามนี้'; END IF;
    UPDATE letter_signers SET full_name = btrim(p_full_name), position = btrim(COALESCE(p_position, '')),
      sort_order = COALESCE(p_sort_order, d.sort_order), is_active = COALESCE(p_is_active, d.is_active),
      updated_by = actor.id, updated_at = now()
    WHERE id = p_id;
    v_id := p_id;
    PERFORM app_audit('letter_signer', p_id, 'update_letter_signer', actor.id,
      'แก้ผู้ลงนาม ' || d.full_name || ' → ' || btrim(p_full_name) ||
      CASE WHEN COALESCE(p_is_active, d.is_active) IS DISTINCT FROM d.is_active
           THEN CASE WHEN p_is_active THEN ' · เปิดใช้งาน' ELSE ' · ปิดใช้งาน' END ELSE '' END);
  END IF;
  RETURN v_id;
END $$;

-- ลบจดหมาย = Manage เท่านั้น · คืน path ไฟล์แนบให้หน้าเว็บลบออกจาก bucket ต่อ (หลังแถวหายแล้ว policy จึงยอม)
CREATE OR REPLACE FUNCTION rpc_delete_service_letter(p_id UUID)
RETURNS TEXT[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d service_letters; paths TEXT[];
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);      -- admin เท่านั้น
  SELECT * INTO d FROM service_letters WHERE id = p_id FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบจดหมายนี้'; END IF;
  SELECT COALESCE(array_agg(file_path), ARRAY[]::TEXT[]) INTO paths FROM service_letter_files WHERE letter_id = p_id;
  DELETE FROM service_letters WHERE id = p_id;     -- ไฟล์แนบ (แถว) ลบตาม CASCADE
  PERFORM app_audit('service_letter', p_id, 'delete_service_letter', actor.id,
    'ลบจดหมาย ' || d.letter_no || ' — ' || d.subject ||
    CASE WHEN array_length(paths, 1) > 0 THEN ' · ไฟล์แนบ ' || array_length(paths, 1) || ' ไฟล์' ELSE '' END);
  RETURN paths;
END $$;

-- แนบไฟล์ (หลังอัปโหลดเข้า bucket แล้ว) — path ต้องอยู่ใต้ letters/<letter_id>/
CREATE OR REPLACE FUNCTION rpc_add_service_letter_file(
  p_letter_id UUID, p_file_path TEXT, p_file_name TEXT, p_mime_type TEXT, p_size_bytes BIGINT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d service_letters; newid UUID;
BEGIN
  actor := app_assert_letter();
  SELECT * INTO d FROM service_letters WHERE id = p_letter_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบจดหมายนี้'; END IF;
  IF COALESCE(btrim(p_file_name), '') = '' THEN RAISE EXCEPTION 'ไม่มีชื่อไฟล์'; END IF;
  -- [PGlite 2026-11-25] ตรวจก่อน CHECK constraint เพื่อให้ error เป็นภาษาไทย (CHECK ยังอยู่เป็นด่านสุดท้าย)
  IF p_file_path IS NULL OR p_file_path NOT LIKE 'letters/' || p_letter_id::text || '/%' THEN
    RAISE EXCEPTION 'ตำแหน่งไฟล์ไม่ตรงกับจดหมายนี้ — กรุณาอัปโหลดใหม่'; END IF;
  IF NOT (p_mime_type IN ('application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          OR p_mime_type LIKE 'image/%') THEN
    RAISE EXCEPTION 'ชนิดไฟล์ไม่รองรับ — แนบได้เฉพาะ PDF / Word / Excel / รูปภาพ'; END IF;
  IF p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 10 * 1024 * 1024 THEN
    RAISE EXCEPTION 'ไฟล์ต้องไม่เกิน 10 MB'; END IF;
  INSERT INTO service_letter_files (letter_id, file_path, file_name, mime_type, size_bytes, uploaded_by)
  VALUES (p_letter_id, p_file_path, left(btrim(p_file_name), 255), p_mime_type, p_size_bytes, actor.id)
  RETURNING id INTO newid;           -- path/ชนิด/ขนาด ผิด → CHECK constraint ปัดตก
  PERFORM app_audit('service_letter', p_letter_id, 'add_service_letter_file', actor.id,
    'แนบไฟล์ ' || left(btrim(p_file_name), 255) || ' ในจดหมาย ' || d.letter_no);
  RETURN newid;
END $$;

-- ลบไฟล์แนบ 1 ไฟล์ — คืน path ให้หน้าเว็บลบออกจาก bucket ต่อ
CREATE OR REPLACE FUNCTION rpc_delete_service_letter_file(p_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; f service_letter_files; d service_letters;
BEGIN
  actor := app_assert_letter();
  SELECT * INTO f FROM service_letter_files WHERE id = p_id FOR UPDATE;
  IF f.id IS NULL THEN RAISE EXCEPTION 'ไม่พบไฟล์นี้'; END IF;
  SELECT * INTO d FROM service_letters WHERE id = f.letter_id;
  DELETE FROM service_letter_files WHERE id = p_id;
  PERFORM app_audit('service_letter', f.letter_id, 'delete_service_letter_file', actor.id,
    'ลบไฟล์แนบ ' || f.file_name || ' จากจดหมาย ' || COALESCE(d.letter_no, '-'));
  RETURN f.file_path;
END $$;

-- ---------- 6) สิทธิ์เรียก RPC (0091: ฟังก์ชันใหม่ไม่ได้สิทธิ์อัตโนมัติ) ----------
REVOKE ALL ON FUNCTION rpc_create_service_letter(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION rpc_delete_service_letter(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION rpc_add_service_letter_file(UUID, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION rpc_delete_service_letter_file(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION rpc_upsert_letter_signer(UUID, TEXT, TEXT, INT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rpc_upsert_letter_signer(UUID, TEXT, TEXT, INT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_create_service_letter(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_delete_service_letter(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_add_service_letter_file(UUID, TEXT, TEXT, TEXT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_delete_service_letter_file(UUID) TO authenticated;

-- ---------- 7) ตรวจผลท้ายไฟล์ ----------
DO $$
DECLARE is_pub BOOLEAN;
BEGIN
  SELECT public INTO is_pub FROM storage.buckets WHERE id = 'letter-docs';
  IF is_pub IS NULL THEN RAISE EXCEPTION '0100: ไม่มี bucket letter-docs'; END IF;
  IF is_pub THEN RAISE EXCEPTION '0100: bucket letter-docs เป็น public — เอกสารจะเปิดได้โดยไม่ต้อง login'; END IF;
  IF has_table_privilege('authenticated', 'public.service_letters', 'INSERT')
     OR has_table_privilege('authenticated', 'public.letter_signers', 'INSERT')
     OR has_table_privilege('authenticated', 'public.letter_signers', 'UPDATE') THEN
    RAISE EXCEPTION '0100: authenticated ยังเขียนตาราง service_letters / letter_signers ตรงได้';
  END IF;
  IF has_function_privilege('authenticated', 'public.app_assert_letter()', 'EXECUTE') THEN
    RAISE EXCEPTION '0100: app_assert_letter เรียกตรงได้ (ต้องเป็นฟังก์ชันภายใน)';
  END IF;
  RAISE NOTICE '0100: OK — Service Letter พร้อมใช้ (bucket ปิด · เขียนผ่าน RPC เท่านั้น)';
END $$;
