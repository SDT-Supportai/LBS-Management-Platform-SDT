-- =====================================================================
-- 0103: Letters แบบ Word (2026-11-26) · รันหลัง 0100 → 0101 → 0102
--   คำตอบผู้ใช้:
--     • Popup แบบ Word: เนื้อความเป็น HTML (ตัวหนา/ขนาด/จัดชิด/รายการ/ตาราง/รูป) ⇒ body ยาวได้ถึง 1,000,000 ตัวอักษร
--       รูปเก็บใน bucket letter-docs (private) path letter-img/<uuid> — body เก็บแค่ token "lbsimg:letter-img/…"
--     • แก้จดหมายที่ออกแล้วได้ ⇒ rpc_update_service_letter (Service + Project + Manage · เลขที่/Job แก้ไม่ได้ · Audit)
--     • แก้ nnn ได้ตอนออกเท่านั้น (ค่าเริ่ม = อัตโนมัติ) ⇒ p->>'seq_no' · ห้ามซ้ำ · ตัวนับขยับตาม (GREATEST)
--       + rpc_next_letter_no ให้ฟอร์มแสดงเลขถัดไป (นับฉบับที่ลบแล้วจาก letter_no_seq)
--   🔴 HTML: หน้าเว็บ sanitize แบบ allowlist ทุกครั้งที่บันทึก/แสดง (src/data/letterRich.ts) ·
--      ที่นี่กันชั้นที่ 2: ปฏิเสธแท็กอันตราย / on*= / javascript: ภายในแท็ก (ข้อความผู้ใช้ถูก escape เป็น &lt; แล้วจึงไม่ชน)
--   app_letter_validate = ตรวจค่าร่วมของการออก + แก้ (ภายใน · ไม่ GRANT ตามกติกา 0091)
--   แทนที่ rpc_create_service_letter (ส่วนเลขที่/แจ้งเตือนเหมือน 0102) · idempotent
--   demo sync: src/data/letters.ts (cleanLetterInput / createLetterDemo / updateLetterDemo) · logic.ts (suggestLetterNo)
--   ทดสอบ: supabase/tests/test_0103_pglite.mjs (รัน 0100 → 0103)
-- =====================================================================

ALTER TABLE service_letters ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);
ALTER TABLE service_letters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- ---------- ตรวจค่าร่วม (ออก + แก้) ----------
CREATE OR REPLACE FUNCTION app_letter_validate(p JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t TEXT; v_sig TEXT := NULLIF(btrim(COALESCE(p->>'sig_image', '')), ''); v_body TEXT := COALESCE(p->>'body', '');
BEGIN
  -- วันที่ต้องเป็น YYYY-MM-DD ที่มีจริง (0100 debug) — ไม่งั้น ::date อ่าน "01/02/2026" ตาม DateStyle ผิดเงียบ
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
  IF COALESCE(NULLIF(p->>'category', ''), 'GENERAL') NOT IN ('GENERAL', 'SM', 'WARRANTY') THEN
    RAISE EXCEPTION 'ประเภทจดหมายไม่ถูกต้อง'; END IF;
  IF COALESCE(NULLIF(p->>'letter_type', ''), 'EXTERNAL') NOT IN ('EXTERNAL', 'INTERNAL') THEN
    RAISE EXCEPTION 'ชนิดหนังสือไม่ถูกต้อง (ภายนอก / ภายใน)'; END IF;
  IF COALESCE(NULLIF(p->>'status', ''), 'ISSUED') NOT IN ('ISSUED', 'DRAFT') THEN
    RAISE EXCEPTION 'สถานะจดหมายไม่ถูกต้อง'; END IF;
  IF NULLIF(p->>'warranty_start', '') IS NOT NULL AND NULLIF(p->>'warranty_end', '') IS NOT NULL
     AND (p->>'warranty_start')::date > (p->>'warranty_end')::date THEN
    RAISE EXCEPTION 'วันเริ่มรับประกันต้องไม่หลังวันสิ้นสุด'; END IF;
  -- 🔴 ชั้นที่ 2 ของ sanitizer: โค้ดในเนื้อความ (แท็กอันตราย / on*= / javascript: ภายในแท็ก) — ตรวจก่อนช่องว่าง
  --    (เนื้อความที่มีแต่ <iframe> ต้องได้ข้อความนี้ ไม่ใช่ "กรุณากรอกเนื้อความ")
  IF v_body ~* '<\s*/?\s*(script|iframe|object|embed|style|svg|math|template|link|meta|base|form)\M'
     OR v_body ~* '<[^>]*\son[a-z]+\s*='
     OR v_body ~* '<[^>]*javascript\s*:' THEN
    RAISE EXCEPTION 'เนื้อความมีโค้ดที่ไม่อนุญาต — กรุณาวางข้อความใหม่จากตัวแก้ไขในระบบ';
  END IF;
  -- เนื้อความ HTML ที่ไม่มีข้อความ/รูปจริง (<p><br></p>) = ว่าง
  IF COALESCE(btrim(p->>'recipient'), '') = '' OR COALESCE(btrim(p->>'subject'), '') = ''
     OR (btrim(regexp_replace(regexp_replace(v_body, '<[^>]*>', '', 'g'), '&nbsp;|\s', ' ', 'g')) = '' AND v_body !~* '<img\M') THEN
    RAISE EXCEPTION 'กรุณากรอก ผู้รับ / เรื่อง / เนื้อความ ให้ครบ';
  END IF;
  IF length(v_body) > 1000000 THEN
    RAISE EXCEPTION 'เนื้อความยาวเกินไป — แบ่งเป็นหลายฉบับ หรือลดขนาดตาราง/ข้อความ'; END IF;
  FOREACH t IN ARRAY ARRAY['recipient','recipient_org','subject','reference','enclosure','body2',
                           'attention','site','tech_list','cc','contract_no',
                           'warranty_type','warranty_detail'] LOOP
    IF length(COALESCE(p->>t, '')) > 20000 THEN RAISE EXCEPTION 'ข้อความช่อง % ยาวเกินไป', t; END IF;
  END LOOP;
  IF v_sig IS NOT NULL AND NOT (length(v_sig) <= 400000
       AND v_sig ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$') THEN
    RAISE EXCEPTION 'ลายเซ็นไม่ถูกต้อง (ต้องเป็นรูป PNG/JPEG ไม่เกิน 300 KB) — กรุณาวาดใหม่';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app_letter_validate(JSONB) FROM PUBLIC, anon, authenticated;

-- ---------- ออกจดหมาย (แทนที่ 0102) ----------
CREATE OR REPLACE FUNCTION rpc_create_service_letter(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; newid UUID; v_no TEXT; v_year TEXT; v_max INT; v_seq INT;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_sig TEXT := NULLIF(btrim(COALESCE(p->>'sig_image', '')), '');
  v_job UUID; s letter_signers; v_job_no TEXT; v_prefix TEXT;
  uuid_re CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  actor := app_assert_letter();
  -- [0102] ต้องเลือก Job No. ก่อนเป็นอันดับแรก — เลขจดหมายรันตาม Job
  IF NULLIF(btrim(COALESCE(p->>'job_id', '')), '') IS NULL THEN
    RAISE EXCEPTION 'กรุณาเลือก Job No. ก่อน — เลขจดหมายรันตาม Job'; END IF;
  IF (p->>'job_id') !~ uuid_re THEN RAISE EXCEPTION 'ไม่พบ Job ที่อ้างถึง (รหัสไม่ถูกต้อง)'; END IF;
  v_job := (p->>'job_id')::uuid;
  PERFORM app_letter_validate(p);
  -- [0103] nnn กำหนดเอง (ไม่ส่ง = อัตโนมัติ)
  IF NULLIF(btrim(COALESCE(p->>'seq_no', '')), '') IS NOT NULL THEN
    IF btrim(p->>'seq_no') !~ '^\d{1,5}$' OR btrim(p->>'seq_no')::int < 1 THEN
      RAISE EXCEPTION 'เลขลำดับ (nnn) ต้องเป็นจำนวนเต็ม 1–99999'; END IF;
    v_seq := btrim(p->>'seq_no')::int;
  END IF;
  -- ผู้ลงนามต้องมาจากรายชื่อที่ Manage ตั้งและยังใช้งาน · ชื่อ/ตำแหน่งเอาจากตาราง (ไม่รับที่ส่งมา)
  IF NULLIF(p->>'signer_id', '') IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกผู้ลงนาม'; END IF;
  IF (p->>'signer_id') !~ uuid_re THEN RAISE EXCEPTION 'ไม่พบผู้ลงนามในรายชื่อที่ใช้งาน — กรุณาเลือกใหม่'; END IF;
  SELECT * INTO s FROM letter_signers WHERE id = (p->>'signer_id')::uuid AND is_active;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบผู้ลงนามในรายชื่อที่ใช้งาน — กรุณาเลือกใหม่'; END IF;
  SELECT job_no INTO v_job_no FROM jobs WHERE id = v_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบ Job ที่อ้างถึง'; END IF;

  -- เลขที่ PSP-LBSJXXXX-YYYY-nnn ตาม Job — ล็อกตัวนับ (กดพร้อมกันได้เลขเรียงกัน ไม่ชน)
  PERFORM pg_advisory_xact_lock(hashtext('lbs:service-letter-no'));
  v_year := to_char(v_today, 'YYYY');
  v_prefix := 'PSP-LBSJ' || app_letter_job_code(v_job_no) || '-' || v_year;
  IF v_seq IS NOT NULL THEN
    v_no := v_prefix || '-' || CASE WHEN v_seq < 1000 THEN lpad(v_seq::text, 3, '0') ELSE v_seq::text END;
    IF EXISTS (SELECT 1 FROM service_letters WHERE letter_no = v_no) THEN
      RAISE EXCEPTION 'เลขที่ % มีอยู่แล้ว — กรุณาใช้เลขอื่น', v_no; END IF;
    -- ตัวนับขยับตามเลขที่กำหนดเอง (ฉบับถัดไปแบบอัตโนมัติต่อจากเลขสูงสุด)
    INSERT INTO letter_no_seq (prefix, last_no) VALUES (v_prefix, v_seq)
    ON CONFLICT (prefix) DO UPDATE SET last_no = GREATEST(letter_no_seq.last_no, EXCLUDED.last_no);
  ELSE
    SELECT COALESCE(MAX((substring(letter_no FROM '-(\d+)$'))::int), 0) INTO v_max
      FROM service_letters WHERE letter_no LIKE v_prefix || '-%' AND letter_no ~ ('^' || v_prefix || '-\d+$');
    INSERT INTO letter_no_seq (prefix, last_no) VALUES (v_prefix, v_max + 1)
    ON CONFLICT (prefix) DO UPDATE SET last_no = GREATEST(letter_no_seq.last_no, EXCLUDED.last_no - 1) + 1
    RETURNING last_no INTO v_max;
    v_no := v_prefix || '-' || CASE WHEN v_max < 1000 THEN lpad(v_max::text, 3, '0') ELSE v_max::text END;
  END IF;

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
    v_job, NULLIF(btrim(COALESCE(p->>'contract_no', '')), ''),
    NULLIF(btrim(COALESCE(p->>'cc', '')), ''),
    s.id, s.full_name, NULLIF(s.position, ''),
    v_sig,
    NULLIF(btrim(COALESCE(p->>'warranty_type', '')), ''),
    NULLIF(p->>'warranty_start', '')::date, NULLIF(p->>'warranty_end', '')::date,
    NULLIF(btrim(COALESCE(p->>'warranty_detail', '')), ''),
    actor.id)
  RETURNING id INTO newid;

  PERFORM app_audit('service_letter', newid, 'create_service_letter', actor.id,
    'ออกจดหมาย ' || v_no || CASE WHEN v_seq IS NOT NULL THEN ' (กำหนดเลขเอง)' ELSE '' END ||
    ' — ' || btrim(p->>'subject') || ' · ผู้ลงนาม ' || s.full_name ||
    CASE WHEN v_sig IS NULL THEN ' (เซ็นมือ)' ELSE ' (เซ็นอิเล็กทรอนิกส์)' END);
  PERFORM app_notify('letter_issued', '✉️ ออกจดหมาย ' || v_no || ' — ' || btrim(p->>'subject'), 'project', v_job);
  RETURN jsonb_build_object('id', newid, 'letter_no', v_no);
END $$;

-- ---------- แก้จดหมายที่ออกแล้ว ----------
-- เลขที่ / Job / ผู้ออก / วันที่ออก แก้ไม่ได้ · ผู้ลงนามคนเดิม = คง snapshot · คนใหม่ = ต้องใช้งานอยู่ · ไม่แจ้งกระดิ่งซ้ำ
CREATE OR REPLACE FUNCTION rpc_update_service_letter(p_id UUID, p JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; d service_letters; s letter_signers;
  v_sig TEXT := NULLIF(btrim(COALESCE(p->>'sig_image', '')), '');
  v_sname TEXT; v_spos TEXT;
  uuid_re CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  actor := app_assert_letter();
  SELECT * INTO d FROM service_letters WHERE id = p_id FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบจดหมายนี้'; END IF;
  IF NULLIF(btrim(COALESCE(p->>'job_id', '')), '') IS NOT NULL AND (p->>'job_id') IS DISTINCT FROM d.job_id::text THEN
    RAISE EXCEPTION 'เปลี่ยน Job ของจดหมายที่ออกแล้วไม่ได้ (เลขที่ผูกกับ Job)'; END IF;
  PERFORM app_letter_validate(p);
  IF NULLIF(p->>'signer_id', '') IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกผู้ลงนาม'; END IF;
  IF (p->>'signer_id') !~ uuid_re THEN RAISE EXCEPTION 'ไม่พบผู้ลงนามในรายชื่อที่ใช้งาน — กรุณาเลือกใหม่'; END IF;
  IF (p->>'signer_id')::uuid = d.signer_id THEN
    v_sname := d.signer_name; v_spos := d.signer_position;
  ELSE
    SELECT * INTO s FROM letter_signers WHERE id = (p->>'signer_id')::uuid AND is_active;
    IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบผู้ลงนามในรายชื่อที่ใช้งาน — กรุณาเลือกใหม่'; END IF;
    v_sname := s.full_name; v_spos := NULLIF(s.position, '');
  END IF;

  UPDATE service_letters SET
    letter_date = COALESCE(NULLIF(p->>'letter_date', '')::date, d.letter_date),
    category = COALESCE(NULLIF(p->>'category', ''), 'GENERAL'),
    letter_type = COALESCE(NULLIF(p->>'letter_type', ''), 'EXTERNAL'),
    status = COALESCE(NULLIF(p->>'status', ''), 'ISSUED'),
    recipient = btrim(p->>'recipient'), recipient_org = NULLIF(btrim(COALESCE(p->>'recipient_org', '')), ''),
    subject = btrim(p->>'subject'), reference = NULLIF(btrim(COALESCE(p->>'reference', '')), ''),
    enclosure = NULLIF(btrim(COALESCE(p->>'enclosure', '')), ''), body = btrim(p->>'body'),
    body2 = NULLIF(btrim(COALESCE(p->>'body2', '')), ''), attention = NULLIF(btrim(COALESCE(p->>'attention', '')), ''),
    site = NULLIF(btrim(COALESCE(p->>'site', '')), ''), tech_list = NULLIF(btrim(COALESCE(p->>'tech_list', '')), ''),
    contract_no = NULLIF(btrim(COALESCE(p->>'contract_no', '')), ''), cc = NULLIF(btrim(COALESCE(p->>'cc', '')), ''),
    signer_id = (p->>'signer_id')::uuid, signer_name = v_sname, signer_position = v_spos, sig_image = v_sig,
    warranty_type = NULLIF(btrim(COALESCE(p->>'warranty_type', '')), ''),
    warranty_start = NULLIF(p->>'warranty_start', '')::date, warranty_end = NULLIF(p->>'warranty_end', '')::date,
    warranty_detail = NULLIF(btrim(COALESCE(p->>'warranty_detail', '')), ''),
    updated_by = actor.id, updated_at = now()
  WHERE id = p_id;

  PERFORM app_audit('service_letter', p_id, 'update_service_letter', actor.id,
    'แก้ไขจดหมาย ' || d.letter_no || ' — ' || btrim(p->>'subject') ||
    CASE WHEN (p->>'signer_id')::uuid IS DISTINCT FROM d.signer_id THEN ' · เปลี่ยนผู้ลงนามเป็น ' || v_sname ELSE '' END);
END $$;

-- ---------- เลขถัดไปที่จะออก (ช่อง nnn ของฟอร์ม) ----------
CREATE OR REPLACE FUNCTION rpc_next_letter_no(p_job_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job_no TEXT; v_prefix TEXT; v_max INT; v_seq INT;
BEGIN
  PERFORM app_assert_letter();
  SELECT job_no INTO v_job_no FROM jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบ Job ที่อ้างถึง'; END IF;
  v_prefix := 'PSP-LBSJ' || app_letter_job_code(v_job_no) || '-' || to_char((now() AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY');
  SELECT COALESCE(MAX((substring(letter_no FROM '-(\d+)$'))::int), 0) INTO v_max
    FROM service_letters WHERE letter_no LIKE v_prefix || '-%' AND letter_no ~ ('^' || v_prefix || '-\d+$');
  SELECT last_no INTO v_seq FROM letter_no_seq WHERE prefix = v_prefix;
  v_max := GREATEST(v_max, COALESCE(v_seq, 0)) + 1;
  RETURN v_prefix || '-' || CASE WHEN v_max < 1000 THEN lpad(v_max::text, 3, '0') ELSE v_max::text END;
END $$;

REVOKE ALL ON FUNCTION rpc_update_service_letter(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION rpc_next_letter_no(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rpc_update_service_letter(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_next_letter_no(UUID) TO authenticated;

-- ---------- ตรวจผลท้ายไฟล์ ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'service_letters' AND column_name = 'updated_at') THEN
    RAISE EXCEPTION '0103: ไม่มีคอลัมน์ service_letters.updated_at';
  END IF;
  IF position('seq_no' IN pg_get_functiondef('public.rpc_create_service_letter(jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0103: rpc_create_service_letter ยังไม่รับเลขที่กำหนดเอง';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_update_service_letter(uuid, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rpc_next_letter_no(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rpc_create_service_letter(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0103: authenticated เรียก RPC จดหมายไม่ได้';
  END IF;
  IF has_function_privilege('authenticated', 'public.app_letter_validate(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0103: app_letter_validate เรียกตรงได้ (ต้องเป็นฟังก์ชันภายใน)';
  END IF;
  RAISE NOTICE '0103: OK — Letters แบบ Word (HTML · รูป · แก้จดหมาย · กำหนด nnn เอง)';
END $$;
