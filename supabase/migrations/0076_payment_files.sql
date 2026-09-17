-- =============================================================================
-- 0076 — 📎 เอกสารแนบรายงวดเงิน (2026-09-17)
--
-- ใบแจ้งหนี้ · ใบเสร็จ/ใบกำกับภาษี · หนังสือรับรองผลงาน (PAC) · สำเนาโอนเงิน
-- หลายไฟล์ต่อ 1 งวด — แนบจากโมดัล "เพิ่ม/แก้งวด" ได้เลย
--
-- 🔴 bucket `payment-docs` เป็น **private** (กติกาเดียวกับ unit-docs ของ 0074)
--    ใบแจ้งหนี้/ใบเสร็จมีเลขสัญญา ยอดเงิน และข้อมูลลูกค้า ⇒ public bucket = ใครมี URL ก็เปิดได้
--    DB เก็บ **path** ไม่ใช่ URL · client ขอ signed URL (5 นาที) ทุกครั้งที่จะเปิด
--
-- 🔴 ทำไมไม่ใช้ bucket unit-docs ร่วมกัน: เอกสารการเงินกับเอกสารรายเครื่องมีคนละกลุ่มผู้อ่าน
--    ในอนาคต (ถ้าต้องจำกัดให้เฉพาะ Project/Manage อ่านใบเสร็จได้) แยก bucket ไว้ตั้งแต่ต้น
--    = แก้ policy ที่เดียวจบ · รวม bucket แล้วมาแยกทีหลังต้องย้ายไฟล์จริงทั้งหมด
--
-- ⚠️ guard = app_assert_job_cost_editable (เหมือน 0044 ทั้งชุด) ไม่ใช่ตัวปกติ
--    เอกสาร PAC/Retention มาถึง **หลัง** ปิดงานติดตั้งเสมอ — ใช้ guard ปกติ = แนบใบงวดสุดท้ายไม่ได้เลย
--
-- ⚠️ ลบงวดเงิน (rpc_delete_job_payment) → แถวไฟล์หายตาม ON DELETE CASCADE
--    แต่ **ไฟล์จริงใน storage ไม่หายเอง** ⇒ UI ต้องเก็บ path ไว้ก่อนลบงวด แล้วค่อยเก็บกวาด
--    (กติกาเดียวกับ 0074: ลบแถวก่อนเสมอ ไฟล์ค้าง = ขยะที่ไม่มีใครอ้างถึง ไม่ใช่ข้อมูลรั่ว)
--
-- demo sync ที่ src/data/logic.ts (addPaymentFile / deletePaymentFile)
-- รันหลัง 0075 · idempotent · **ต้องรันก่อน push** (ปุ่ม 📎 ในโมดัลงวดเงินเรียก RPC ใหม่)
-- =============================================================================

-- ---------- 1) ตาราง ----------
CREATE TABLE IF NOT EXISTS job_payment_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  UUID NOT NULL REFERENCES job_payments(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  note        TEXT,
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- กติกาเดียวกับ logic.ts (isAllowedDocFile / MAX_DOC_FILE_MB) — ชั้นสุดท้ายที่กันคนยิง SQL ตรง
  CONSTRAINT job_payment_files_type_ck CHECK (mime_type = 'application/pdf' OR mime_type LIKE 'image/%'),
  CONSTRAINT job_payment_files_size_ck CHECK (size_bytes > 0 AND size_bytes <= 10 * 1024 * 1024)
);

COMMENT ON COLUMN job_payment_files.file_path IS
  '0076 — path ใน private bucket payment-docs (ไม่ใช่ URL) · ต้องขอ signed URL ก่อนเปิดทุกครั้ง';

CREATE INDEX IF NOT EXISTS idx_job_payment_files_pay ON job_payment_files(payment_id, uploaded_at DESC);

ALTER TABLE job_payment_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_payment_files_read ON job_payment_files;
CREATE POLICY job_payment_files_read ON job_payment_files FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON job_payment_files FROM authenticated, anon;

-- ---------- 2) Storage bucket แบบปิด + policy ----------
-- รันบรรทัดนี้ error (สิทธิ์ storage) → สร้าง bucket ชื่อ payment-docs แบบ **ไม่ public**
-- ใน Dashboard → Storage แล้วรัน CREATE POLICY ด้านล่างต่อ
INSERT INTO storage.buckets (id, name, public) VALUES ('payment-docs', 'payment-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- 🔴 SELECT ให้ authenticated เท่านั้น — ห้าม TO public (ไม่งั้น private ก็ทะลุผ่าน policy อยู่ดี)
DROP POLICY IF EXISTS payment_docs_read ON storage.objects;
CREATE POLICY payment_docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'payment-docs');
DROP POLICY IF EXISTS payment_docs_insert ON storage.objects;
CREATE POLICY payment_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payment-docs');
DROP POLICY IF EXISTS payment_docs_delete ON storage.objects;
CREATE POLICY payment_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'payment-docs');

-- ---------- 3) RPC ----------
CREATE OR REPLACE FUNCTION rpc_add_payment_file(
  p_payment_id UUID, p_file_name TEXT, p_file_path TEXT,
  p_mime_type TEXT, p_size_bytes BIGINT, p_note TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pm job_payments; j jobs; v_name TEXT; new_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY['project']);          -- Project + Manage (เหมือนงวดเงินทั้งชุด)
  SELECT * INTO pm FROM job_payments WHERE id = p_payment_id;
  IF pm.id IS NULL THEN RAISE EXCEPTION 'ไม่พบงวดเงินนี้'; END IF;
  j := app_assert_job_cost_editable(pm.job_id);        -- เจ้าของงาน (0042) + แนบได้แม้ปิดงานแล้ว

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

  INSERT INTO job_payment_files (payment_id, file_name, file_path, mime_type, size_bytes, note, uploaded_by)
  VALUES (p_payment_id, v_name, btrim(p_file_path), p_mime_type, p_size_bytes,
          NULLIF(btrim(COALESCE(p_note, '')), ''), actor.id)
  RETURNING id INTO new_id;

  PERFORM app_audit('job_payment', pm.job_id, 'add_payment_file', actor.id,
    j.job_no || ' งวด ' || pm.pay_type || ' #' || pm.seq || ' แนบเอกสาร "' || v_name ||
    '" (' || round(p_size_bytes / 1024.0) || ' KB)');
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_payment_file(p_file_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; f job_payment_files; pm job_payments; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO f FROM job_payment_files WHERE id = p_file_id;
  IF f.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเอกสารแนบ'; END IF;
  SELECT * INTO pm FROM job_payments WHERE id = f.payment_id;
  j := app_assert_job_cost_editable(pm.job_id);

  DELETE FROM job_payment_files WHERE id = p_file_id;

  -- ไฟล์จริงใน storage ถูกลบโดย client หลัง RPC นี้สำเร็จ · ลบไม่สำเร็จ = ไฟล์กำพร้าที่ไม่มีใครอ้างถึง
  PERFORM app_audit('job_payment', pm.job_id, 'delete_payment_file', actor.id,
    j.job_no || ' งวด ' || pm.pay_type || ' #' || pm.seq || ' ลบเอกสารแนบ "' || f.file_name || '"');
END $$;

-- ---------- 3.1) rpc_add_job_payment ต้องคืน id ของงวดที่เพิ่งสร้าง ----------
-- โมดัล "เพิ่มงวด" ให้เลือกไฟล์ก่อนกดบันทึก ⇒ ตอนกดบันทึกต้องรู้ id ทันทีเพื่อผูกไฟล์ต่อ
-- ไม่งั้นต้องบันทึกงวด → ปิดโมดัล → เปิดใหม่เพื่อแนบ = สิ่งที่ผู้ใช้ขอให้เลิกทำ
-- 🔴 เปลี่ยน return type ด้วย CREATE OR REPLACE ไม่ได้ ⇒ ต้อง DROP ก่อน
--    body ด้านล่างคัดจาก 0044 **ทั้งดุ้น** เพิ่มแค่ RETURNS UUID + RETURN new_id
--    (ตรวจแล้วว่าไม่มี migration ไหนหลัง 0044 patch ฟังก์ชันนี้ — ถ้ามีต้องคัดจากตัวล่าสุดแทน)
DROP FUNCTION IF EXISTS rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT);
CREATE FUNCTION rpc_add_job_payment(
  p_job_id      UUID,
  p_type        TEXT,
  p_invoice_no  TEXT DEFAULT NULL,
  p_invoice_date DATE DEFAULT NULL,
  p_percent     NUMERIC DEFAULT NULL,
  p_amount      NUMERIC DEFAULT NULL,
  p_paid_at     DATE DEFAULT NULL,
  p_note        TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; amt NUMERIC; nextseq INT; new_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY['project']);           -- Project + Manage
  j := app_assert_job_cost_editable(p_job_id);          -- ล็อกแถว + ไม่ใช่ Job ที่ยกเลิก + เจ้าของงาน (0042)
  IF p_type NOT IN ('advance', 'progress', 'retention') THEN
    RAISE EXCEPTION 'ประเภทงวดเงินไม่ถูกต้อง';
  END IF;
  amt := app_payment_amount(j, p_percent, p_amount);

  SELECT COALESCE(MAX(seq), 0) + 1 INTO nextseq
    FROM job_payments WHERE job_id = p_job_id AND pay_type = p_type;

  INSERT INTO job_payments (job_id, pay_type, seq, invoice_no, invoice_date,
                            percent, amount, base_sale_price, paid_at, note, created_by)
  VALUES (p_job_id, p_type, nextseq,
          NULLIF(btrim(COALESCE(p_invoice_no, '')), ''), p_invoice_date,
          p_percent, amt, j.budget_sale_price, p_paid_at,
          NULLIF(btrim(COALESCE(p_note, '')), ''), actor.id)
  RETURNING id INTO new_id;

  PERFORM app_audit('job_payment', p_job_id, 'add_job_payment', actor.id,
    j.job_no || ' บันทึกงวด ' || p_type || ' #' || nextseq ||
    ' · Invoice ' || COALESCE(p_invoice_no, '-') ||
    ' · ' || COALESCE(p_percent::TEXT || '%', 'ยอดกรอกเอง') || ' = ' || round(amt, 2) || ' ฿');

  RETURN new_id;
END $$;

-- DROP ทิ้ง grant เดิมไปด้วย — ต้องให้ใหม่ ไม่งั้นหน้าเว็บจะได้ permission denied ทันทีหลังรัน
REVOKE ALL ON FUNCTION public.rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.rpc_add_payment_file(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_payment_file(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_delete_payment_file(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_delete_payment_file(UUID) TO authenticated;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE job_payment_files;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- ---------- 4) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE n INT; is_pub BOOLEAN;
BEGIN
  IF to_regclass('public.job_payment_files') IS NULL THEN
    RAISE EXCEPTION '0076: ไม่มีตาราง job_payment_files';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'job_payment_files'::regclass
     AND conname IN ('job_payment_files_type_ck', 'job_payment_files_size_ck');
  IF n <> 2 THEN RAISE EXCEPTION '0076: CHECK ชนิด/ขนาดไฟล์ไม่ครบ (เจอ %)', n; END IF;

  -- ลบงวดแล้วไฟล์ต้องหายตาม ไม่งั้นเหลือแถวกำพร้าที่ชี้ไป payment ที่ไม่มีแล้ว
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'job_payment_files'::regclass AND contype = 'f' AND confdeltype = 'c';
  IF n <> 1 THEN RAISE EXCEPTION '0076: FK payment_id ไม่ได้เป็น ON DELETE CASCADE'; END IF;

  -- เขียนตรงไม่ได้ (กติกา 0057) · อ่านได้
  IF has_table_privilege('authenticated', 'public.job_payment_files', 'INSERT')
     OR has_table_privilege('authenticated', 'public.job_payment_files', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.job_payment_files', 'DELETE') THEN
    RAISE EXCEPTION '0076: authenticated เขียน job_payment_files ตรงได้ — ต้องผ่าน RPC เท่านั้น (0057)';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.job_payment_files', 'SELECT') THEN
    RAISE EXCEPTION '0076: authenticated อ่าน job_payment_files ไม่ได้ — รายการเอกสารจะว่างเปล่า';
  END IF;

  -- 🔴 bucket ต้องปิด และ policy อ่านต้องไม่เปิดให้ public/anon
  SELECT public INTO is_pub FROM storage.buckets WHERE id = 'payment-docs';
  IF is_pub IS NULL THEN RAISE EXCEPTION '0076: ไม่มี bucket payment-docs'; END IF;
  IF is_pub THEN
    RAISE EXCEPTION '0076: bucket payment-docs เป็น public — ใบแจ้งหนี้/ใบเสร็จจะเปิดได้โดยไม่ต้อง login';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'payment_docs_read'
     AND ('public' = ANY(roles) OR 'anon' = ANY(roles));
  IF n > 0 THEN
    RAISE EXCEPTION '0076: policy payment_docs_read เปิดให้ public/anon — bucket private ก็ทะลุอยู่ดี';
  END IF;

  -- rpc_add_job_payment ต้องคืน uuid (ไม่งั้นโมดัลแนบไฟล์ตอนสร้างงวดใหม่ผูกไฟล์ไม่ได้)
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_add_job_payment'
     AND p.prorettype = 'uuid'::regtype;
  IF n <> 1 THEN
    RAISE EXCEPTION '0076: rpc_add_job_payment ไม่ได้คืน UUID (เจอ % ตัว) — แนบไฟล์ตอนเพิ่มงวดจะพัง', n;
  END IF;
  IF NOT has_function_privilege('authenticated',
        'public.rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT)', 'EXECUTE') THEN
    RAISE EXCEPTION '0076: authenticated เรียก rpc_add_job_payment ไม่ได้ — GRANT หายตอน DROP';
  END IF;

  RAISE NOTICE '0076: OK — เอกสารแนบรายงวดพร้อมใช้ (bucket ปิด · เปิดไฟล์ผ่าน signed URL เท่านั้น)';
END $$;
