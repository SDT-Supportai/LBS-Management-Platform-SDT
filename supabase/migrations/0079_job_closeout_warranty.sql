-- =============================================================================
-- 0079 — 🏁 ปิดงานติดตั้ง: เอกสารรับมอบ + Warranty (Service (Warranty) เฟส 1 · 2026-09-25)
--
-- ที่มา (ผู้ใช้ขอ 2026-09-25): ปิดงานติดตั้งต้องบังคับ
--   (1) เอกสารรับมอบ 1 ประเภท: PAC / AC / COD / Handover + แนบไฟล์
--   (2) Warranty **ทั้ง 2 แบบคู่กัน** (มติผู้ใช้):
--       · Installation — ประกันงานติดตั้ง ระดับ Job (1 แถว/Job)
--       · LBS          — ประกันตัวเครื่อง ระดับเครื่อง (1 แถว/เครื่องที่ติดตั้งสำเร็จ)
--                        วันเริ่ม default = **วันที่ติดตั้งจริงรายเครื่อง** (มติผู้ใช้)
--       แต่ละแบบ: วันเริ่ม–วันสิ้นสุด + แนบไฟล์ (บังคับ)
--   แล้วเป็นต้นทางของเมนูใหม่ Service (Warranty) → แท็บ Warranty Period
--
-- 🔴 มติผู้ใช้ 2026-09-25: **ต้องมีไฟล์เอกสารรับมอบตอนปิดเท่านั้น** (เลือกแล้วแม้รู้ว่า PAC มักมาหลังปิดงาน
--    ตาม 0076) ⇒ ใบที่ยังไม่มีเอกสารรับมอบ = ปิดงานไม่ได้ · ถ้าวันหลังเจองานค้างเพราะรอ PAC ให้เลือก
--    Handover/COD ตอนปิด แล้วแนบ PAC เพิ่มทีหลังที่แท็บ Warranty (rpc_add_closeout_file)
--
-- 🔴 bucket `service-docs` **private** (กติกาเดียวกับ 0074/0076) — ใบรับมอบ/ใบรับประกันมีเลขสัญญา
--    ชื่อลูกค้า และเงื่อนไขเชิงพาณิชย์ · DB เก็บ path · เปิดผ่าน signed URL 5 นาที
--    แยก bucket จาก unit-docs/payment-docs เพราะเฟส 2–3 (S.O./S.R.) จะเก็บที่นี่ด้วย = คนละกลุ่มผู้อ่าน
--
-- 🔴 rpc_close_job_install **เปลี่ยน signature** (+ เอกสารรับมอบ + Warranty) ⇒ DROP ก่อน (§9 ข้อ 8)
--    body คัดจาก 0040 ทั้งดุ้น (ตรวจแล้ว: 0071 ไม่ได้ swap ตัวนี้ แค่ตรวจว่าด่าน issued ยังอยู่)
--    ⚠️ ต้องคงข้อความ 'ปิดงานได้เฉพาะงานที่เบิกแล้ว' — DO block ของ 0071 ค้นหาข้อความนี้
--    ⚠️ DROP ทิ้ง GRANT ⇒ ให้ใหม่ท้ายไฟล์ ไม่งั้นปุ่มปิดงาน permission denied ทันที
--
-- งานที่ปิดไปก่อน 0079 ไม่มีข้อมูลเหล่านี้ ⇒ rpc_set_job_closeout บันทึกย้อนหลัง/แก้ไขได้
--   (ใบ installed เท่านั้น · Service + Project + Manage)
--
-- demo sync ที่ src/data/logic.ts (closeJobInstall / setJobCloseout / add/deleteCloseoutFile)
-- รันหลัง 0078 · idempotent · **ต้องรันก่อน push** (โมดัลปิดงานใหม่เรียก signature ใหม่)
-- =============================================================================

-- ---------- 1) คอลัมน์เอกสารรับมอบบน jobs ----------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS acceptance_type   TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS acceptance_doc_no TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS acceptance_date   DATE;
DO $$ BEGIN
  ALTER TABLE jobs ADD CONSTRAINT jobs_acceptance_type_ck
    CHECK (acceptance_type IS NULL OR acceptance_type IN ('PAC', 'AC', 'COD', 'HANDOVER'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN jobs.acceptance_type IS
  '0079 — เอกสารรับมอบที่ใช้ปิดงาน: PAC / AC / COD / HANDOVER (ไฟล์อยู่ใน job_closeout_files kind=acceptance)';

-- ---------- 2) Warranty ----------
CREATE TABLE IF NOT EXISTS job_warranties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  unit_id     UUID REFERENCES lbs_units(id) ON DELETE CASCADE,   -- kind=lbs เท่านั้น
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_warranties_kind_ck  CHECK (kind IN ('installation', 'lbs')),
  -- installation = ระดับ Job (ไม่มี unit) · lbs = ระดับเครื่อง (ต้องมี unit)
  CONSTRAINT job_warranties_unit_ck  CHECK ((kind = 'lbs') = (unit_id IS NOT NULL)),
  CONSTRAINT job_warranties_range_ck CHECK (end_date >= start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_warranties_inst ON job_warranties(job_id) WHERE kind = 'installation';
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_warranties_lbs  ON job_warranties(unit_id) WHERE kind = 'lbs';
CREATE INDEX IF NOT EXISTS idx_job_warranties_start ON job_warranties(start_date);

-- ---------- 3) ไฟล์ประกอบการปิดงาน ----------
CREATE TABLE IF NOT EXISTS job_closeout_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  doc_type    TEXT,                          -- kind=acceptance เท่านั้น: PAC / AC / COD / HANDOVER ของไฟล์นี้
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_closeout_files_kind_ck CHECK (kind IN ('acceptance', 'warranty_installation', 'warranty_lbs')),
  -- ไฟล์รับมอบต้องบอกว่าเป็นเอกสารอะไร (PAC ที่มาทีหลังต้องแยกออกจาก Handover ที่ใช้ปิดงานได้) · ไฟล์อื่นห้ามมี
  CONSTRAINT job_closeout_files_doc_type_ck CHECK (
    (kind = 'acceptance' AND doc_type IN ('PAC', 'AC', 'COD', 'HANDOVER')) OR (kind <> 'acceptance' AND doc_type IS NULL)),
  -- กติกาเดียวกับ logic.ts (isAllowedDocFile / MAX_DOC_FILE_MB) — ชั้นสุดท้ายที่กันคนยิง SQL ตรง
  CONSTRAINT job_closeout_files_type_ck CHECK (mime_type = 'application/pdf' OR mime_type LIKE 'image/%'),
  CONSTRAINT job_closeout_files_size_ck CHECK (size_bytes > 0 AND size_bytes <= 10 * 1024 * 1024)
);
COMMENT ON COLUMN job_closeout_files.file_path IS
  '0079 — path ใน private bucket service-docs (ไม่ใช่ URL) · ต้องขอ signed URL ก่อนเปิดทุกครั้ง';
CREATE INDEX IF NOT EXISTS idx_job_closeout_files_job ON job_closeout_files(job_id, kind);
-- รันซ้ำบนตารางที่สร้างจาก 0079 ฉบับร่างแรก (ก่อนมี doc_type) — CREATE TABLE IF NOT EXISTS จะข้ามทั้งก้อน
ALTER TABLE job_closeout_files ADD COLUMN IF NOT EXISTS doc_type TEXT;
DO $$ BEGIN
  ALTER TABLE job_closeout_files ADD CONSTRAINT job_closeout_files_doc_type_ck CHECK (
    (kind = 'acceptance' AND doc_type IN ('PAC', 'AC', 'COD', 'HANDOVER')) OR (kind <> 'acceptance' AND doc_type IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- 4) RLS: อ่านได้ทุกคนที่ login และบัญชียัง active (0058) · เขียนผ่าน RPC เท่านั้น (0057) ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_warranties', 'job_closeout_files'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS read_all ON %I', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS require_active ON %I', t);
    EXECUTE format('CREATE POLICY require_active ON %I AS RESTRICTIVE FOR SELECT TO authenticated USING (my_is_active())', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM authenticated, anon', t);
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ---------- 5) Storage bucket แบบปิด ----------
-- รันบรรทัดนี้ error (สิทธิ์ storage) → สร้าง bucket service-docs แบบ **ไม่ public** ใน Dashboard แล้วรันต่อ
INSERT INTO storage.buckets (id, name, public) VALUES ('service-docs', 'service-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS service_docs_read ON storage.objects;
CREATE POLICY service_docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'service-docs');
DROP POLICY IF EXISTS service_docs_insert ON storage.objects;
-- เขียน/ลบได้เฉพาะแผนกที่บันทึกเอกสารปิดงานได้ (กติกาเดียวกับ rpc_set_job_closeout) — อ่านได้ทุกคนที่ login
-- (0074/0076 เปิดให้ทุก authenticated ลบ object ได้ = ช่องโหว่เดิม ยังไม่ได้แก้ในไฟล์นั้น)
CREATE POLICY service_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'service-docs' AND my_department() IN ('service', 'project', 'admin'));
DROP POLICY IF EXISTS service_docs_delete ON storage.objects;
CREATE POLICY service_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'service-docs' AND my_department() IN ('service', 'project', 'admin'));

-- ---------- 6) helper: ตรวจ + บันทึกไฟล์ 1 รายการ ----------
CREATE OR REPLACE FUNCTION app_add_closeout_file(p_job_id UUID, p_actor UUID, f JSONB)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_kind TEXT; v_doc TEXT; v_name TEXT; v_path TEXT; v_mime TEXT; v_size BIGINT;
BEGIN
  v_kind := NULLIF(f->>'kind', '');
  v_doc  := CASE WHEN v_kind = 'acceptance' THEN NULLIF(f->>'doc_type', '') END;
  v_name := NULLIF(btrim(COALESCE(f->>'name', '')), '');
  v_path := NULLIF(btrim(COALESCE(f->>'path', '')), '');
  v_mime := COALESCE(f->>'mime', '');
  v_size := NULLIF(f->>'size', '')::BIGINT;
  IF v_kind IS NULL OR v_kind NOT IN ('acceptance', 'warranty_installation', 'warranty_lbs') THEN
    RAISE EXCEPTION 'ประเภทไฟล์แนบไม่ถูกต้อง: %', COALESCE(v_kind, '-');
  END IF;
  IF v_kind = 'acceptance' AND (v_doc IS NULL OR v_doc NOT IN ('PAC', 'AC', 'COD', 'HANDOVER')) THEN
    RAISE EXCEPTION 'ไฟล์เอกสารรับมอบต้องระบุประเภท (PAC / AC / COD / Handover)';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'ไม่พบชื่อไฟล์'; END IF;
  IF v_path IS NULL THEN RAISE EXCEPTION '%: อัปโหลดไม่สำเร็จ — ไม่ได้ที่อยู่ไฟล์กลับมา', v_name; END IF;
  IF NOT (v_mime = 'application/pdf' OR v_mime LIKE 'image/%') THEN
    RAISE EXCEPTION '%: รับเฉพาะไฟล์ PDF และรูปภาพ', v_name;
  END IF;
  IF v_size IS NULL OR v_size <= 0 THEN RAISE EXCEPTION '%: ไฟล์ว่าง', v_name; END IF;
  IF v_size > 10 * 1024 * 1024 THEN RAISE EXCEPTION '%: ไฟล์ใหญ่เกิน 10 MB', v_name; END IF;
  INSERT INTO job_closeout_files (job_id, kind, doc_type, file_name, file_path, mime_type, size_bytes, uploaded_by)
  VALUES (p_job_id, v_kind, v_doc, v_name, v_path, v_mime, v_size, p_actor);
  RETURN v_name;
END $$;

-- ---------- 7) helper: บันทึกเอกสารรับมอบ + Warranty (ใช้ร่วมกันระหว่างปิดงาน / บันทึกย้อนหลัง) ----------
-- p_files       = ไฟล์ **ใหม่** ที่เพิ่งอัปโหลด [{kind,doc_type,name,path,mime,size}] (ไฟล์เดิมคงไว้)
-- p_lbs         = [{unit_id,start,end}] ครบทุกเครื่องที่ติดตั้งสำเร็จ
-- บังคับ (นับรวมไฟล์เดิม): ไฟล์รับมอบ **ประเภทเดียวกับที่เลือก** ≥ 1 · Warranty ติดตั้ง ≥ 1 · Warranty LBS ≥ 1 (ถ้ามีเครื่อง)
CREATE OR REPLACE FUNCTION app_save_job_closeout(
  j jobs, p_actor UUID,
  p_acceptance_type TEXT, p_acceptance_doc_no TEXT, p_acceptance_date DATE,
  p_inst_start DATE, p_inst_end DATE, p_lbs JSONB, p_files JSONB
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f JSONB; w JSONB; v_unit UUID; v_start DATE; v_end DATE; n INT;
        need INT; got INT; lbs_txt TEXT;
BEGIN
  IF p_acceptance_type IS NULL OR p_acceptance_type NOT IN ('PAC', 'AC', 'COD', 'HANDOVER') THEN
    RAISE EXCEPTION 'กรุณาเลือกเอกสารรับมอบ 1 ประเภท (PAC / AC / COD / Handover)';
  END IF;
  IF p_acceptance_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันที่ของเอกสารรับมอบ'; END IF;
  IF p_inst_start IS NULL OR p_inst_end IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุวันเริ่ม–วันสิ้นสุด Warranty งานติดตั้ง (Installation)';
  END IF;
  IF p_inst_end < p_inst_start THEN
    RAISE EXCEPTION 'Warranty งานติดตั้ง: วันสิ้นสุดต้องไม่ก่อนวันเริ่ม';
  END IF;
  IF p_lbs IS NOT NULL AND jsonb_typeof(p_lbs) <> 'array' THEN RAISE EXCEPTION 'รูปแบบ Warranty LBS ไม่ถูกต้อง'; END IF;
  IF p_files IS NOT NULL AND jsonb_typeof(p_files) <> 'array' THEN RAISE EXCEPTION 'รูปแบบไฟล์แนบไม่ถูกต้อง'; END IF;

  -- ทุกเครื่องที่ติดตั้งสำเร็จต้องมี Warranty LBS ครบ (เครื่องที่ติดตั้งไม่ได้ ไม่มีประกันให้นับ)
  SELECT COUNT(*) INTO need FROM lbs_units x JOIN v_unit_install_state s ON s.unit_id = x.id
   WHERE x.job_id = j.id AND s.outcome = 'installed';
  SELECT COUNT(DISTINCT (e->>'unit_id')) INTO got FROM jsonb_array_elements(COALESCE(p_lbs, '[]'::jsonb)) e;
  IF got <> jsonb_array_length(COALESCE(p_lbs, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Warranty LBS มีเครื่องซ้ำกัน';
  END IF;

  DELETE FROM job_warranties WHERE job_id = j.id;   -- บันทึกทับทั้งชุด (ปิดใหม่หลัง reopen / แก้ย้อนหลัง)
  -- เครื่องที่เคยมี Warranty จาก Job อื่น (reopen แล้วเครื่องย้ายใบ) — ไม่ลบ = ชน uq_job_warranties_lbs ปิดงานไม่ได้
  DELETE FROM job_warranties w USING jsonb_array_elements(COALESCE(p_lbs, '[]'::jsonb)) e
   WHERE w.kind = 'lbs' AND w.unit_id = NULLIF(e->>'unit_id', '')::UUID;
  INSERT INTO job_warranties (job_id, kind, start_date, end_date, created_by)
  VALUES (j.id, 'installation', p_inst_start, p_inst_end, p_actor);

  n := 0;
  FOR w IN SELECT * FROM jsonb_array_elements(COALESCE(p_lbs, '[]'::jsonb)) LOOP
    v_unit  := NULLIF(w->>'unit_id', '')::UUID;
    v_start := NULLIF(w->>'start', '')::DATE;
    v_end   := NULLIF(w->>'end', '')::DATE;
    IF NOT EXISTS (SELECT 1 FROM lbs_units x JOIN v_unit_install_state s ON s.unit_id = x.id
                    WHERE x.id = v_unit AND x.job_id = j.id AND s.outcome = 'installed') THEN
      RAISE EXCEPTION 'Warranty LBS: เครื่องนี้ไม่ได้ติดตั้งสำเร็จใน % (unit %)', j.job_no, COALESCE(v_unit::TEXT, '-');
    END IF;
    IF v_start IS NULL OR v_end IS NULL THEN
      RAISE EXCEPTION 'Warranty LBS: กรุณาระบุวันเริ่ม–วันสิ้นสุดให้ครบทุกเครื่อง';
    END IF;
    IF v_end < v_start THEN
      RAISE EXCEPTION 'Warranty LBS %: วันสิ้นสุดต้องไม่ก่อนวันเริ่ม', (SELECT serial_lvb FROM lbs_units WHERE id = v_unit);
    END IF;
    INSERT INTO job_warranties (job_id, kind, unit_id, start_date, end_date, created_by)
    VALUES (j.id, 'lbs', v_unit, v_start, v_end, p_actor);
    n := n + 1;
  END LOOP;
  IF n <> need THEN
    RAISE EXCEPTION 'Warranty LBS ต้องครบทุกเครื่องที่ติดตั้งสำเร็จ (% จาก % เครื่อง)', n, need;
  END IF;

  FOR f IN SELECT * FROM jsonb_array_elements(COALESCE(p_files, '[]'::jsonb)) LOOP
    PERFORM app_add_closeout_file(j.id, p_actor, f);
  END LOOP;
  -- 🔴 ไฟล์รับมอบต้องเป็น **ประเภทเดียวกับที่เลือก** — เลือก PAC แต่มีแค่ไฟล์ Handover เดิม = ไม่มีหลักฐาน PAC
  IF NOT EXISTS (SELECT 1 FROM job_closeout_files
                  WHERE job_id = j.id AND kind = 'acceptance' AND doc_type = p_acceptance_type) THEN
    RAISE EXCEPTION 'ต้องแนบไฟล์เอกสารรับมอบประเภท %', p_acceptance_type;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM job_closeout_files WHERE job_id = j.id AND kind = 'warranty_installation') THEN
    RAISE EXCEPTION 'ต้องแนบไฟล์ Warranty งานติดตั้ง (Installation)';
  END IF;
  -- ใบที่ไม่มีเครื่องบันทึกผลติดตั้งรายเครื่อง (ปิดด้วย flow เก่าก่อน 0035) ไม่มี Warranty LBS ให้แนบไฟล์
  IF need > 0 AND NOT EXISTS (SELECT 1 FROM job_closeout_files WHERE job_id = j.id AND kind = 'warranty_lbs') THEN
    RAISE EXCEPTION 'ต้องแนบไฟล์ Warranty ตัวเครื่อง (LBS)';
  END IF;

  UPDATE jobs SET acceptance_type = p_acceptance_type,
    acceptance_doc_no = NULLIF(btrim(COALESCE(p_acceptance_doc_no, '')), ''),
    acceptance_date = p_acceptance_date, updated_at = now()
  WHERE id = j.id;

  SELECT MIN(start_date) || '→' || MAX(end_date) INTO lbs_txt FROM job_warranties WHERE job_id = j.id AND kind = 'lbs';
  RETURN ' · รับมอบ ' || p_acceptance_type || COALESCE(' ' || NULLIF(btrim(COALESCE(p_acceptance_doc_no, '')), ''), '') ||
         ' (' || p_acceptance_date || ')' ||
         ' · Warranty ติดตั้ง ' || p_inst_start || '→' || p_inst_end ||
         ' · Warranty LBS ' || n || ' เครื่อง' || COALESCE(' ' || lbs_txt, '');
END $$;

-- ---------- 8) rpc_close_job_install (signature ใหม่) ----------
DROP FUNCTION IF EXISTS rpc_close_job_install(UUID, TEXT, BOOLEAN, TEXT, TEXT);
CREATE FUNCTION rpc_close_job_install(
  p_job_id UUID, p_note TEXT,
  p_has_issues BOOLEAN DEFAULT NULL, p_issue_detail TEXT DEFAULT NULL, p_issue_file_url TEXT DEFAULT NULL,
  p_acceptance_type TEXT DEFAULT NULL, p_acceptance_doc_no TEXT DEFAULT NULL, p_acceptance_date DATE DEFAULT NULL,
  p_inst_warranty_start DATE DEFAULT NULL, p_inst_warranty_end DATE DEFAULT NULL,
  p_lbs_warranties JSONB DEFAULT '[]'::jsonb, p_files JSONB DEFAULT '[]'::jsonb
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; tot INT; inst INT; blk INT; pend INT; last_date DATE;
        blk_txt TEXT := ''; issue_txt TEXT; closeout_txt TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'ปิดงานได้เฉพาะงานที่เบิกแล้ว (Issued) — % อยู่สถานะอื่น', j.job_no;
  END IF;

  SELECT COUNT(*) INTO tot FROM lbs_units WHERE job_id = p_job_id;
  IF tot = 0 THEN RAISE EXCEPTION '% ไม่มีเครื่องที่เบิกไว้', j.job_no; END IF;

  SELECT
    COUNT(*) FILTER (WHERE s.outcome = 'installed'),
    COUNT(*) FILTER (WHERE s.outcome = 'blocked'),
    MAX(s.installed_date) FILTER (WHERE s.outcome = 'installed')
  INTO inst, blk, last_date
  FROM lbs_units x LEFT JOIN v_unit_install_state s ON s.unit_id = x.id
  WHERE x.job_id = p_job_id;

  pend := tot - COALESCE(inst, 0) - COALESCE(blk, 0);
  IF pend > 0 THEN
    RAISE EXCEPTION 'ยังมี % เครื่องที่ยังไม่ได้ข้อสรุป — ยืนยันติดตั้ง หรือระบุว่าติดตั้งไม่ได้ ให้ครบก่อนปิดงาน', pend;
  END IF;
  IF COALESCE(inst, 0) = 0 THEN RAISE EXCEPTION 'ต้องมีเครื่องที่ติดตั้งสำเร็จอย่างน้อย 1 เครื่องจึงปิดงานได้'; END IF;

  -- บังคับสรุปปัญหา (0040)
  IF p_has_issues IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุว่างานนี้มีปัญหาหรือไม่ ก่อนปิดงาน';
  END IF;
  IF p_has_issues AND COALESCE(btrim(p_issue_detail), '') = '' THEN
    RAISE EXCEPTION 'เลือก "มีปัญหา" แล้ว ต้องกรอกรายละเอียดปัญหา';
  END IF;

  -- เอกสารรับมอบ + Warranty (0079) — throw ตรงนี้ = ทั้งธุรกรรม rollback ใบยังไม่ปิด
  closeout_txt := app_save_job_closeout(j, actor.id, p_acceptance_type, p_acceptance_doc_no, p_acceptance_date,
    p_inst_warranty_start, p_inst_warranty_end, p_lbs_warranties, p_files);

  UPDATE jobs SET terminal_status = 'installed', installed_at = last_date,
    install_note = p_note, install_confirmed_by = actor.id,
    close_has_issues = p_has_issues,
    close_issue_detail   = CASE WHEN p_has_issues THEN btrim(p_issue_detail) ELSE NULL END,
    close_issue_file_url = CASE WHEN p_has_issues THEN NULLIF(btrim(p_issue_file_url), '') ELSE NULL END,
    updated_at = now()
  WHERE id = p_job_id;

  IF COALESCE(blk, 0) > 0 THEN blk_txt := ' · ติดปัญหา ' || blk || ' เครื่อง'; END IF;
  issue_txt := CASE WHEN p_has_issues THEN ' · ⚠️ มีปัญหา: ' || btrim(p_issue_detail) ELSE ' · ไม่มีปัญหา' END;

  PERFORM app_notify('job_installed',
    '🏁 ' || j.job_no || ' ปิดงานติดตั้ง ' || inst || '/' || tot || ' เครื่อง' || blk_txt ||
    ' · ' || last_date || ' · รับมอบ ' || p_acceptance_type || issue_txt || ' · โดย ' || actor.full_name, 'project', p_job_id);
  PERFORM app_audit('job', p_job_id, 'close_job_install', actor.id,
    j.job_no || ' ปิดงานติดตั้ง ' || inst || '/' || tot || ' เครื่อง' || blk_txt ||
    ' วันล่าสุด ' || last_date || issue_txt || closeout_txt ||
    CASE WHEN COALESCE(btrim(p_issue_file_url), '') <> '' THEN ' (มีไฟล์แนบปัญหา)' ELSE '' END ||
    COALESCE(' — ' || NULLIF(p_note, ''), ''));
END $$;

-- ---------- 9) บันทึกย้อนหลัง / แก้ไข (ใบที่ปิดแล้ว) ----------
CREATE OR REPLACE FUNCTION rpc_set_job_closeout(
  p_job_id UUID,
  p_acceptance_type TEXT, p_acceptance_doc_no TEXT, p_acceptance_date DATE,
  p_inst_warranty_start DATE, p_inst_warranty_end DATE,
  p_lbs_warranties JSONB DEFAULT '[]'::jsonb, p_files JSONB DEFAULT '[]'::jsonb
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; had BOOLEAN; txt TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service', 'project']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION '% ยังไม่ได้ปิดงานติดตั้ง — บันทึกเอกสารรับมอบ/Warranty ที่ขั้นตอนปิดงาน', j.job_no;
  END IF;
  had := j.acceptance_type IS NOT NULL;
  txt := app_save_job_closeout(j, actor.id, p_acceptance_type, p_acceptance_doc_no, p_acceptance_date,
    p_inst_warranty_start, p_inst_warranty_end, p_lbs_warranties, p_files);
  PERFORM app_audit('job', p_job_id, CASE WHEN had THEN 'update_job_closeout' ELSE 'backfill_job_closeout' END, actor.id,
    j.job_no || CASE WHEN had THEN ' แก้เอกสารรับมอบ/Warranty' ELSE ' บันทึกเอกสารรับมอบ/Warranty ย้อนหลัง' END || txt);
END $$;

-- ---------- 10) แนบเพิ่ม / ลบไฟล์ (เช่น PAC ที่มาทีหลัง) ----------
CREATE OR REPLACE FUNCTION rpc_add_closeout_file(p_job_id UUID, p_file JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; v_name TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service', 'project']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION '% ยังไม่ได้ปิดงานติดตั้ง', j.job_no;
  END IF;
  v_name := app_add_closeout_file(p_job_id, actor.id, p_file);
  PERFORM app_audit('job', p_job_id, 'add_closeout_file', actor.id,
    j.job_no || ' แนบเอกสาร ' || (p_file->>'kind') || COALESCE(' ' || NULLIF(p_file->>'doc_type', ''), '') || ' "' || v_name || '"');
END $$;

-- ห้ามลบไฟล์สุดท้ายของประเภทที่บังคับ — ไม่งั้นใบที่ปิดแล้วจะกลายเป็นไม่มีหลักฐานรับมอบ
CREATE OR REPLACE FUNCTION rpc_delete_closeout_file(p_file_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; f job_closeout_files; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['service', 'project']);
  SELECT * INTO f FROM job_closeout_files WHERE id = p_file_id;
  IF f.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเอกสารแนบ'; END IF;
  SELECT * INTO j FROM jobs WHERE id = f.job_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM job_closeout_files WHERE job_id = f.job_id AND kind = f.kind AND id <> f.id) THEN
    RAISE EXCEPTION '"%" เป็นไฟล์สุดท้ายของประเภทนี้ — แนบไฟล์ใหม่ก่อนแล้วค่อยลบไฟล์เดิม', f.file_name;
  END IF;
  -- ไฟล์รับมอบประเภทที่ใช้ปิดงาน ต้องเหลืออย่างน้อย 1 ไฟล์ (ลบ Handover ตัวสุดท้ายทิ้งทั้งที่ปิดด้วย Handover ไม่ได้)
  IF f.kind = 'acceptance' AND f.doc_type = j.acceptance_type AND NOT EXISTS (
       SELECT 1 FROM job_closeout_files WHERE job_id = f.job_id AND kind = 'acceptance'
          AND doc_type = f.doc_type AND id <> f.id) THEN
    RAISE EXCEPTION '"%" เป็นไฟล์ % ตัวสุดท้ายที่ใช้ปิดงาน — แนบไฟล์ใหม่ก่อน หรือเปลี่ยนประเภทเอกสารรับมอบที่ "แก้ไข"', f.file_name, f.doc_type;
  END IF;
  DELETE FROM job_closeout_files WHERE id = p_file_id;
  PERFORM app_audit('job', f.job_id, 'delete_closeout_file', actor.id,
    j.job_no || ' ลบเอกสาร ' || f.kind || COALESCE(' ' || f.doc_type, '') || ' "' || f.file_name || '"');
END $$;

-- ---------- 11) สิทธิ์เรียก ----------
REVOKE ALL ON FUNCTION public.app_add_closeout_file(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_save_job_closeout(jobs, UUID, TEXT, TEXT, DATE, DATE, DATE, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_close_job_install(UUID, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_close_job_install(UUID, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, JSONB, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_set_job_closeout(UUID, TEXT, TEXT, DATE, DATE, DATE, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_job_closeout(UUID, TEXT, TEXT, DATE, DATE, DATE, JSONB, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_add_closeout_file(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_closeout_file(UUID, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_delete_closeout_file(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_delete_closeout_file(UUID) TO authenticated;

-- ---------- 12) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE n INT; is_pub BOOLEAN; src TEXT;
BEGIN
  IF to_regclass('public.job_warranties') IS NULL OR to_regclass('public.job_closeout_files') IS NULL THEN
    RAISE EXCEPTION '0079: ตาราง job_warranties / job_closeout_files ไม่ครบ';
  END IF;

  -- ต้องเหลือ rpc_close_job_install ตัวเดียว (2 overload = PostgREST กำกวม · §9 ข้อ 8)
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_close_job_install';
  IF n <> 1 THEN RAISE EXCEPTION '0079: rpc_close_job_install มี % ตัว (ต้อง 1)', n; END IF;
  IF NOT has_function_privilege('authenticated',
       'public.rpc_close_job_install(UUID, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, JSONB, JSONB)', 'EXECUTE') THEN
    RAISE EXCEPTION '0079: authenticated เรียก rpc_close_job_install ไม่ได้ — GRANT หายตอน DROP';
  END IF;

  -- ด่าน issued ต้องยังอยู่ (0071 ตรวจข้อความนี้) + ต้องเรียก helper บันทึกเอกสาร/Warranty
  SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_close_job_install';
  IF position('ปิดงานได้เฉพาะงานที่เบิกแล้ว' IN src) = 0 THEN
    RAISE EXCEPTION '0079: rpc_close_job_install ไม่มีด่าน terminal_status = issued แล้ว';
  END IF;
  IF position('app_save_job_closeout' IN src) = 0 THEN
    RAISE EXCEPTION '0079: rpc_close_job_install ไม่ได้บังคับเอกสารรับมอบ/Warranty';
  END IF;

  -- เขียนตรงไม่ได้ (0057) · อ่านได้
  IF has_table_privilege('authenticated', 'public.job_warranties', 'INSERT')
     OR has_table_privilege('authenticated', 'public.job_closeout_files', 'INSERT') THEN
    RAISE EXCEPTION '0079: authenticated เขียนตาราง Warranty/ไฟล์ตรงได้ — ต้องผ่าน RPC เท่านั้น (0057)';
  END IF;

  -- helper ภายในต้องเรียกตรงไม่ได้ (ไม่งั้นข้ามด่านสิทธิ์ของ rpc ได้)
  IF has_function_privilege('authenticated', 'public.app_add_closeout_file(UUID, UUID, JSONB)', 'EXECUTE') THEN
    RAISE EXCEPTION '0079: authenticated เรียก app_add_closeout_file ตรงได้ — ข้ามด่านสิทธิ์';
  END IF;

  SELECT public INTO is_pub FROM storage.buckets WHERE id = 'service-docs';
  IF is_pub IS NULL THEN RAISE EXCEPTION '0079: ไม่มี bucket service-docs'; END IF;
  IF is_pub THEN RAISE EXCEPTION '0079: bucket service-docs เป็น public — เอกสารรับมอบเปิดได้โดยไม่ต้อง login'; END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'service_docs_read'
     AND ('public' = ANY(roles) OR 'anon' = ANY(roles));
  IF n > 0 THEN RAISE EXCEPTION '0079: policy service_docs_read เปิดให้ public/anon'; END IF;

  RAISE NOTICE '0079: OK — ปิดงานต้องมีเอกสารรับมอบ + Warranty (Installation + LBS) · bucket ปิด';
END $$;
