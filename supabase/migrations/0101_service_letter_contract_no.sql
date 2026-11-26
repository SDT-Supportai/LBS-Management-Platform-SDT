-- =====================================================================
-- 0101: Service Letter — อ้างอิง Contract No. (2026-11-25) · รันหลัง 0100
--   ผู้ใช้กำหนด (ปรับตามไฟล์แนบ):
--     • Official Letter ภายนอก → อ้างอิง Contract No.
--     • Official Letter ภายใน  → อ้างอิง Job No. (job_id เดิม)
--     • Service Official Letter / Warranty Letter → อ้างอิง 1. Contract No. 2. โครงการ Job No.
--   เพิ่มคอลัมน์ contract_no (ข้อความ snapshot ณ วันออก — เครื่องหนึ่ง Job อาจมีหลายสัญญา ⇒ "CT-A, CT-B")
--   แทนที่ rpc_create_service_letter ให้บันทึก contract_no (ส่วนอื่นเหมือน 0100 ทุกบรรทัด)
--   CREATE OR REPLACE คงสิทธิ์ EXECUTE เดิม (GRANT authenticated จาก 0100) · idempotent
--   demo sync: src/data/letters.ts (contractNo) · ทดสอบ: supabase/tests/test_0100_pglite.mjs (รัน 0100 → 0101)
-- =====================================================================

ALTER TABLE service_letters ADD COLUMN IF NOT EXISTS contract_no TEXT;

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
                           'attention','site','tech_list','cc','contract_no',
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
  -- [ผูกระบบ 2026-11-25] เลขที่ออกแล้วไม่นำกลับมาใช้ แม้ลบฉบับล่าสุด (ตัวนับรายปี · GREATEST กันตัวนับตามหลังแถวจริง)
  INSERT INTO letter_no_counters (year, last_no) VALUES (v_year, v_max + 1)
  ON CONFLICT (year) DO UPDATE SET last_no = GREATEST(letter_no_counters.last_no, EXCLUDED.last_no - 1) + 1
  RETURNING last_no INTO v_max;
  v_no := 'PSP-LBS-' || v_year || '-' || lpad(v_max::text, 3, '0');

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
  -- กระดิ่งถึง Project ของงานที่อ้างถึง — letter_issued ไม่อยู่ใน allowlist LINE (0083) ⇒ ไม่ส่ง LINE
  IF v_job IS NOT NULL THEN
    PERFORM app_notify('letter_issued', '✉️ ออกจดหมาย ' || v_no || ' — ' || btrim(p->>'subject'), 'project', v_job);
  END IF;
  RETURN jsonb_build_object('id', newid, 'letter_no', v_no);
END $$;

-- ---------- ตรวจผลท้ายไฟล์ ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'service_letters' AND column_name = 'contract_no') THEN
    RAISE EXCEPTION '0101: ไม่มีคอลัมน์ service_letters.contract_no';
  END IF;
  IF position('contract_no' IN pg_get_functiondef('public.rpc_create_service_letter(jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0101: rpc_create_service_letter ยังไม่บันทึก contract_no';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_create_service_letter(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0101: authenticated เรียก rpc_create_service_letter ไม่ได้';
  END IF;
  RAISE NOTICE '0101: OK — จดหมายบันทึก Contract No. ได้แล้ว';
END $$;
