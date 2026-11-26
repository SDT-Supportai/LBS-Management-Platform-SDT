-- =====================================================================
-- 0102: Service Letter — ออกจดหมายต้องเลือก Job ก่อน · เลขที่รันตาม Job No. (2026-11-25) · รันหลัง 0100 + 0101
--   ผู้ใช้กำหนด (ปรับ Flow Work Letters):
--     1) การออกจดหมายต้องแยก Job No. ก่อนเป็นอันดับแรก ⇒ job_id บังคับ (ไม่มี = error ไทย)
--     2) เลขอัตโนมัติตาม Job No. เท่านั้น: PSP-LBSJXXXX-YYYY-nnn
--        XXXX = ตัวเลขหลัง J ตัวสุดท้ายของ Job No. (102LB10J3076 → 3076) · ไม่มี = ตัวเลขท้าย · เติม 0 ให้ครบ 4 หลัก (ไม่ตัด)
--        YYYY = ปีตามเวลาไทย · nnn = ลำดับของหัวเลขนั้น (Job + ปี) เริ่ม 001
--        วันที่ในเอกสารพิมพ์ = เดือนชื่อเต็ม พ.ศ. (ฝั่งหน้าเว็บ letterPdf.ts — DB เก็บ DATE เหมือนเดิม)
--   ตัวนับ: letter_no_seq (prefix → last_no) · เลขไม่ถูกนำกลับมาใช้แม้ลบ · นับคีย์เป็น "หัวเลข" ไม่ใช่ job_id
--     เพราะ Job ต่างกันอาจได้ XXXX เดียวกัน (เช่น 102LB10J3076 กับ 102LB20J3076) ⇒ ใช้ลำดับร่วม เลขไม่ชน UNIQUE
--   จดหมายที่ออกไปแล้วแบบเก่า (PSP-LBS-YYYY-nnn / ไม่มี Job) คงเดิม · letter_no_counters (0100) ไม่ใช้แล้ว
--   แทนที่ rpc_create_service_letter (ส่วนอื่นเหมือน 0101 ทุกบรรทัด) · CREATE OR REPLACE คงสิทธิ์ EXECUTE เดิม · idempotent
--   demo sync: src/data/letters.ts (jobLetterCode / letterPrefixFor / nextLetterNo / cleanLetterInput)
--   ทดสอบ: supabase/tests/test_0102_pglite.mjs (รัน 0100 → 0101 → 0102)
-- =====================================================================

-- ตัวนับเลขรายหัวเลข (ภายใน — rpc_create_service_letter เท่านั้น)
CREATE TABLE IF NOT EXISTS letter_no_seq (
  prefix   TEXT PRIMARY KEY,                -- เช่น PSP-LBSJ3076-2026
  last_no  INT NOT NULL CHECK (last_no > 0)
);
ALTER TABLE letter_no_seq ENABLE ROW LEVEL SECURITY;          -- ไม่มี policy = ผู้ใช้อ่าน/เขียนไม่ได้
REVOKE ALL ON letter_no_seq FROM PUBLIC, anon, authenticated;

-- รหัส Job ในเลขจดหมาย (sync jobLetterCode ใน letters.ts) — ⚠️ lpad ของ Postgres ตัดสตริงที่ยาวเกิน ⇒ เติมเองเฉพาะที่สั้นกว่า 4
CREATE OR REPLACE FUNCTION app_letter_job_code(p_job_no TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE s TEXT := upper(btrim(COALESCE(p_job_no, ''))); c TEXT;
BEGIN
  c := substring(s FROM 'J(\d+)$');
  IF c IS NULL THEN c := substring(s FROM '(\d+)$'); END IF;
  IF c IS NULL THEN c := regexp_replace(s, '[^A-Z0-9]', '', 'g'); END IF;
  RETURN CASE WHEN length(c) < 4 THEN lpad(c, 4, '0') ELSE c END;
END $$;
REVOKE ALL ON FUNCTION app_letter_job_code(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION rpc_create_service_letter(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; newid UUID; v_no TEXT; v_year TEXT; v_max INT;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_sig TEXT := NULLIF(btrim(COALESCE(p->>'sig_image', '')), '');
  v_job UUID;                      -- [debug 2026-11-25] เดิม cast ::uuid ใน DECLARE = error อังกฤษก่อนถึงจุดตรวจ
  s letter_signers;
  t TEXT;
  v_job_no TEXT; v_prefix TEXT;    -- [0102] เลขที่ตาม Job
  uuid_re CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  actor := app_assert_letter();
  -- [0102] ต้องเลือก Job No. ก่อนเป็นอันดับแรก — เลขจดหมายรันตาม Job
  IF NULLIF(btrim(COALESCE(p->>'job_id', '')), '') IS NULL THEN
    RAISE EXCEPTION 'กรุณาเลือก Job No. ก่อน — เลขจดหมายรันตาม Job'; END IF;
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
                           'attention','site','tech_list','cc','contract_no',
                           'warranty_type','warranty_detail'] LOOP
    IF length(COALESCE(p->>t, '')) > 20000 THEN RAISE EXCEPTION 'ข้อความช่อง % ยาวเกินไป', t; END IF;
  END LOOP;
  IF v_sig IS NOT NULL AND NOT (length(v_sig) <= 400000
       AND v_sig ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$') THEN
    RAISE EXCEPTION 'ลายเซ็นไม่ถูกต้อง (ต้องเป็นรูป PNG/JPEG ไม่เกิน 300 KB) — กรุณาวาดใหม่';
  END IF;
  SELECT job_no INTO v_job_no FROM jobs WHERE id = v_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบ Job ที่อ้างถึง'; END IF;

  -- [0102] เลขที่ PSP-LBSJXXXX-YYYY-nnn รันตาม Job No. — ล็อกตัวนับของระบบจดหมาย (กดพร้อมกันได้เลขเรียงกัน ไม่ชน)
  PERFORM pg_advisory_xact_lock(hashtext('lbs:service-letter-no'));
  v_year := to_char(v_today, 'YYYY');
  v_prefix := 'PSP-LBSJ' || app_letter_job_code(v_job_no) || '-' || v_year;
  SELECT COALESCE(MAX((substring(letter_no FROM '-(\d+)$'))::int), 0) INTO v_max
    FROM service_letters WHERE letter_no LIKE v_prefix || '-%' AND letter_no ~ ('^' || v_prefix || '-\d+$');
  -- เลขที่ออกแล้วไม่นำกลับมาใช้ แม้ลบฉบับล่าสุด (GREATEST กันตัวนับตามหลังแถวจริง)
  INSERT INTO letter_no_seq (prefix, last_no) VALUES (v_prefix, v_max + 1)
  ON CONFLICT (prefix) DO UPDATE SET last_no = GREATEST(letter_no_seq.last_no, EXCLUDED.last_no - 1) + 1
  RETURNING last_no INTO v_max;
  v_no := v_prefix || '-' || CASE WHEN v_max < 1000 THEN lpad(v_max::text, 3, '0') ELSE v_max::text END;

  INSERT INTO service_letters (
    letter_no, letter_date, category, letter_type, status, recipient, recipient_org, subject, reference,
    enclosure, body, body2, attention, site, tech_list, job_id, contract_no, cc, signer_id, signer_name, signer_position, sig_image,
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
    v_job, NULLIF(btrim(COALESCE(p->>'contract_no', '')), ''),   -- [0101] Contract No.
    NULLIF(btrim(COALESCE(p->>'cc', '')), ''),
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
  -- กระดิ่งถึง Project ของงาน (ทุกฉบับมี Job แล้ว) — letter_issued ไม่อยู่ใน allowlist LINE (0083) ⇒ ไม่ส่ง LINE
  PERFORM app_notify('letter_issued', '✉️ ออกจดหมาย ' || v_no || ' — ' || btrim(p->>'subject'), 'project', v_job);
  RETURN jsonb_build_object('id', newid, 'letter_no', v_no);
END $$;

-- ---------- ตรวจผลท้ายไฟล์ ----------
DO $$
BEGIN
  IF app_letter_job_code('102LB10J3076') <> '3076' OR app_letter_job_code('JOB-2026-0004') <> '0004'
     OR app_letter_job_code('J12') <> '0012' OR app_letter_job_code('102LB10J30761') <> '30761' THEN
    RAISE EXCEPTION '0102: app_letter_job_code ให้ผลไม่ตรงกับ letters.ts';
  END IF;
  IF position('letter_no_seq' IN pg_get_functiondef('public.rpc_create_service_letter(jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0102: rpc_create_service_letter ยังไม่ออกเลขตาม Job';
  END IF;
  IF has_table_privilege('authenticated', 'public.letter_no_seq', 'SELECT')
     OR has_table_privilege('authenticated', 'public.letter_no_seq', 'UPDATE') THEN
    RAISE EXCEPTION '0102: authenticated เข้าถึงตาราง letter_no_seq ได้ (ต้องเป็นตารางภายใน)';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_create_service_letter(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0102: authenticated เรียก rpc_create_service_letter ไม่ได้';
  END IF;
  RAISE NOTICE '0102: OK — ออกจดหมายต้องเลือก Job · เลขที่ PSP-LBSJXXXX-YYYY-nnn';
END $$;
