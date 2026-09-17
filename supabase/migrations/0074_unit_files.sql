-- =============================================================================
-- 0074 — 📎 เอกสารแนบรายเครื่อง (2026-09-17)
--
-- สัญญา · ใบส่งของ · รูปสภาพเครื่องตอนส่งมอบ — หลายไฟล์ต่อเครื่อง
--
-- 🔴 bucket `unit-docs` ต้องเป็น **private** ต่างจาก `install-photos` (0019) ที่ตั้ง public = true
--    เอกสารสัญญาเป็นข้อมูลเชิงพาณิชย์ + PDPA · public bucket = ใครมี URL ก็เปิดได้โดยไม่ต้อง login
--    และ URL ของ Supabase เดาได้จาก path ⇒ เท่ากับเปิดสาธารณะจริง ๆ
--    ⇒ DB เก็บ **path** ไม่ใช่ URL · ฝั่ง client ขอ signed URL (อายุ 5 นาที) ทุกครั้งที่จะเปิด
--
-- 🔴 กติกาชนิด/ขนาดไฟล์อยู่ 3 ชั้น เพราะแต่ละชั้นกันคนละทาง:
--    <input accept>  = ตัวกรองในหน้าต่างเลือกไฟล์ (ลากไฟล์ใส่ก็ผ่าน) — สะดวก ไม่ใช่การป้องกัน
--    RPC + logic.ts  = กติกาตัวจริงของแอป
--    CHECK ใน DB     = กันคนยิง SQL ตรง/เขียนสคริปต์เอง
--
-- ⚠️ ไม่บล็อกเครื่องที่เบิกให้ Service ไปแล้ว (ต่างจาก rpc_update_unit_plan) — ใบส่งของและรูป
--    สภาพเครื่องตอนส่งมอบมาถึงหลังของออกจากคลังเสมอ ล็อกไว้ = แนบหลักฐานไม่ได้เลย
--
-- ไม่เปลี่ยน signature ของเดิม · เพิ่มตาราง + RPC ใหม่ 2 ตัว ⇒ **ต้องรันก่อน push**
-- (ปุ่ม 📎 จะโผล่แล้วกดได้ PGRST202 / ตารางไม่มีจริง ถ้า push ก่อน)
-- =============================================================================

-- ---------- 1) ตาราง ----------
CREATE TABLE IF NOT EXISTS lbs_unit_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     UUID NOT NULL REFERENCES lbs_units(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  note        TEXT,
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- กติกาเดียวกับ logic.ts (isAllowedUnitFile / MAX_UNIT_FILE_MB) — ชั้นสุดท้ายที่กันคนยิง SQL ตรง
  CONSTRAINT lbs_unit_files_type_ck CHECK (mime_type = 'application/pdf' OR mime_type LIKE 'image/%'),
  CONSTRAINT lbs_unit_files_size_ck CHECK (size_bytes > 0 AND size_bytes <= 10 * 1024 * 1024)
);

COMMENT ON COLUMN lbs_unit_files.file_path IS
  '0074 — path ใน private bucket unit-docs (ไม่ใช่ URL) · ต้องขอ signed URL ก่อนเปิดทุกครั้ง';

CREATE INDEX IF NOT EXISTS idx_lbs_unit_files_unit ON lbs_unit_files(unit_id, uploaded_at DESC);

-- อ่านได้ทุกคนที่ล็อกอิน (กติกาเดียวกับตารางอื่นตั้งแต่ 0001) · เขียนผ่าน RPC เท่านั้น (0057)
ALTER TABLE lbs_unit_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lbs_unit_files_read ON lbs_unit_files;
CREATE POLICY lbs_unit_files_read ON lbs_unit_files FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON lbs_unit_files FROM authenticated, anon;

-- ---------- 2) Storage bucket แบบปิด + policy ----------
-- ถ้ารันบรรทัดนี้ error (สิทธิ์ storage) ให้สร้าง bucket ชื่อ unit-docs แบบ **ไม่ public**
-- ใน Dashboard → Storage แล้วรัน CREATE POLICY ด้านล่างต่อ
INSERT INTO storage.buckets (id, name, public) VALUES ('unit-docs', 'unit-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- 🔴 SELECT ให้ authenticated เท่านั้น — ห้ามใส่ TO public เหมือน install_photos_read ของ 0019
--    ไม่งั้น bucket ที่ตั้ง private ไว้ก็เปิดทะลุผ่าน policy อยู่ดี
DROP POLICY IF EXISTS unit_docs_read ON storage.objects;
CREATE POLICY unit_docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'unit-docs');
DROP POLICY IF EXISTS unit_docs_insert ON storage.objects;
CREATE POLICY unit_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'unit-docs');
DROP POLICY IF EXISTS unit_docs_delete ON storage.objects;
CREATE POLICY unit_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'unit-docs');

-- ---------- 3) RPC ----------
CREATE OR REPLACE FUNCTION rpc_add_unit_file(
  p_unit_id UUID, p_file_name TEXT, p_file_path TEXT,
  p_mime_type TEXT, p_size_bytes BIGINT, p_note TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks; v_name TEXT; new_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);   -- Division + Manage (กติกาเดียวกับงานคลังอื่น)
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;

  v_name := NULLIF(btrim(COALESCE(p_file_name, '')), '');
  IF v_name IS NULL THEN RAISE EXCEPTION 'ไม่พบชื่อไฟล์'; END IF;
  IF NULLIF(btrim(COALESCE(p_file_path, '')), '') IS NULL THEN
    RAISE EXCEPTION 'อัปโหลดไฟล์ไม่สำเร็จ — ไม่ได้ที่อยู่ไฟล์กลับมา';
  END IF;
  IF NOT (p_mime_type = 'application/pdf' OR p_mime_type LIKE 'image/%') THEN
    RAISE EXCEPTION '%: รับเฉพาะไฟล์ PDF และรูปภาพ', v_name;
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes <= 0 THEN RAISE EXCEPTION '%: ไฟล์ว่าง', v_name; END IF;
  IF p_size_bytes > 10 * 1024 * 1024 THEN RAISE EXCEPTION '%: ไฟล์ใหญ่เกิน 10 MB', v_name; END IF;

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;
  INSERT INTO lbs_unit_files (unit_id, file_name, file_path, mime_type, size_bytes, note, uploaded_by)
  VALUES (p_unit_id, v_name, btrim(p_file_path), p_mime_type, p_size_bytes,
          NULLIF(btrim(COALESCE(p_note, '')), ''), actor.id)
  RETURNING id INTO new_id;

  PERFORM app_audit('lbs_unit', p_unit_id, 'add_unit_file', actor.id,
    COALESCE(s.stock_no, '') || ' · ' || u.serial_lvb || ' แนบเอกสาร "' || v_name ||
    '" (' || round(p_size_bytes / 1024.0) || ' KB)');
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_unit_file(p_file_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; f lbs_unit_files; u lbs_units;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO f FROM lbs_unit_files WHERE id = p_file_id;
  IF f.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเอกสารแนบ'; END IF;
  SELECT * INTO u FROM lbs_units WHERE id = f.unit_id;

  DELETE FROM lbs_unit_files WHERE id = p_file_id;

  -- ไฟล์จริงใน storage ถูกลบโดย client หลัง RPC นี้สำเร็จ · ลบไม่สำเร็จ = ไฟล์กำพร้าที่ไม่มีใครอ้างถึง
  PERFORM app_audit('lbs_unit', f.unit_id, 'delete_unit_file', actor.id,
    COALESCE(u.serial_lvb, '') || ' ลบเอกสารแนบ "' || f.file_name || '"');
END $$;

REVOKE ALL ON FUNCTION public.rpc_add_unit_file(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_unit_file(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_delete_unit_file(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_delete_unit_file(UUID) TO authenticated;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE lbs_unit_files;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- ---------- 4) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE n INT; is_pub BOOLEAN;
BEGIN
  -- 4.1 ตาราง + constraint
  IF to_regclass('public.lbs_unit_files') IS NULL THEN
    RAISE EXCEPTION '0074: ไม่มีตาราง lbs_unit_files';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'lbs_unit_files'::regclass
     AND conname IN ('lbs_unit_files_type_ck', 'lbs_unit_files_size_ck');
  IF n <> 2 THEN RAISE EXCEPTION '0074: CHECK ชนิด/ขนาดไฟล์ไม่ครบ (เจอ %)', n; END IF;

  -- 4.2 เขียนตรงไม่ได้ (กติกา 0057) · อ่านได้
  IF has_table_privilege('authenticated', 'public.lbs_unit_files', 'INSERT')
     OR has_table_privilege('authenticated', 'public.lbs_unit_files', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.lbs_unit_files', 'DELETE') THEN
    RAISE EXCEPTION '0074: authenticated เขียน lbs_unit_files ตรงได้ — ต้องผ่าน RPC เท่านั้น (0057)';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.lbs_unit_files', 'SELECT') THEN
    RAISE EXCEPTION '0074: authenticated อ่าน lbs_unit_files ไม่ได้ — หน้าเอกสารจะว่างเปล่า';
  END IF;

  -- 4.3 🔴 bucket ต้องเป็น private และ policy อ่านต้องไม่เปิดให้ public/anon
  SELECT public INTO is_pub FROM storage.buckets WHERE id = 'unit-docs';
  IF is_pub IS NULL THEN RAISE EXCEPTION '0074: ไม่มี bucket unit-docs'; END IF;
  IF is_pub THEN
    RAISE EXCEPTION '0074: bucket unit-docs เป็น public — เอกสารสัญญาจะเปิดได้โดยไม่ต้อง login';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'unit_docs_read'
     AND ('public' = ANY(roles) OR 'anon' = ANY(roles));
  IF n > 0 THEN
    RAISE EXCEPTION '0074: policy unit_docs_read เปิดให้ public/anon — bucket private ก็ทะลุอยู่ดี';
  END IF;

  RAISE NOTICE '0074: OK — เอกสารแนบรายเครื่องพร้อมใช้ (bucket ปิด · เปิดไฟล์ผ่าน signed URL เท่านั้น)';
END $$;
