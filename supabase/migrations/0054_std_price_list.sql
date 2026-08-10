-- =====================================================================
-- 0054: Standard Price list (2026-08-08)
--  เพิ่มทะเบียน "ราคามาตรฐาน" เป็นแท็บที่ 3 คู่กับ Standard Drawing / BOM List
--  ใช้หลักการเดียวกับ Standard Drawing เป๊ะ (มติผู้ใช้):
--    1 รายการ = 1 แถว + ไฟล์ PDF ล่าสุด · แก้ไข = ทับข้อมูลเดิม + stamp updated_at/updated_by
--    (ไม่เก็บตาราง revision) · ลบ = ลบทะเบียน **ไฟล์ยังอยู่ใน Storage** และ URL เดิมยังเปิดได้
--
--  แยกตารางจาก std_drawings เพราะเป็นทะเบียนคนละชุด (ราคา vs แบบ) เลขเอกสารคนละระบบ
--  และต้อง unique แยกกัน — ถ้ายัดตารางเดียวกันด้วยคอลัมน์ kind จะทำ unique ต่อชนิดยุ่งกว่า
--
--  สิทธิ์: perm `standards.manage` เดิม = project + sales + admin · ทุกแผนกอ่าน/ดาวน์โหลดได้
--  ไฟล์ PDF: bucket `install-photos` prefix `standard-prices/` (bucket เดียวกับ 0045)
--  demo sync ที่ src/data/logic.ts (createStdPrice / updateStdPrice / deleteStdPrice)
--  รันหลัง 0053 · idempotent
-- =====================================================================

-- ---------- 1) schema ----------
CREATE TABLE IF NOT EXISTS std_prices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(255) NOT NULL,
  price_no    VARCHAR(100) UNIQUE,          -- เลขเอกสารราคา (ว่างได้ แต่ห้ามซ้ำ)
  description TEXT,
  file_url    TEXT,
  file_name   VARCHAR(255),
  rev_note    TEXT,
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES profiles(id),
  updated_at  TIMESTAMPTZ
);

-- ---------- 2) RLS + realtime (คัดลอกกติกาจาก 0045) ----------
DO $$
BEGIN
  ALTER TABLE std_prices ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS read_all ON std_prices;
  -- ทุกแผนกอ่าน/ดาวน์โหลดได้ (เป็นมาตรฐานที่ทุกคนต้องใช้)
  CREATE POLICY read_all ON std_prices FOR SELECT TO authenticated USING (true);
  DROP POLICY IF EXISTS standards_write ON std_prices;
  -- write ตัวจริงอยู่ที่ RPC (SECURITY DEFINER) — policy กันคนยิง PostgREST ตรง
  CREATE POLICY standards_write ON std_prices FOR ALL TO authenticated
    USING (my_department() IN ('project','sales','admin'))
    WITH CHECK (my_department() IN ('project','sales','admin'));
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'std_prices'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.std_prices;
  END IF;
END $$;

-- ---------- 3) RPC ----------
CREATE OR REPLACE FUNCTION rpc_create_std_price(
  p_title TEXT, p_price_no TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_file_url TEXT DEFAULT NULL, p_file_name TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; newid UUID; v_no TEXT;
BEGIN
  actor := app_assert_standards();            -- project + sales + admin (0045)
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุหัวข้อ/ชื่อรายการราคา'; END IF;
  v_no := NULLIF(btrim(COALESCE(p_price_no, '')), '');
  IF v_no IS NOT NULL AND EXISTS (SELECT 1 FROM std_prices WHERE price_no = v_no) THEN
    RAISE EXCEPTION 'เลขเอกสารราคา "%" มีอยู่แล้ว', v_no;
  END IF;

  INSERT INTO std_prices (title, price_no, description, file_url, file_name, created_by, updated_by, updated_at)
  VALUES (btrim(p_title), v_no,
          NULLIF(btrim(COALESCE(p_description, '')), ''),
          NULLIF(btrim(COALESCE(p_file_url, '')), ''), NULLIF(btrim(COALESCE(p_file_name, '')), ''),
          actor.id, actor.id, now())
  RETURNING id INTO newid;

  PERFORM app_audit('std_price', newid, 'create_std_price', actor.id,
    'เพิ่ม Standard Price list "' || btrim(p_title) || '"' ||
    CASE WHEN NULLIF(btrim(COALESCE(p_file_name, '')), '') IS NOT NULL
         THEN ' · ไฟล์ ' || btrim(p_file_name) ELSE ' · ยังไม่แนบไฟล์' END);
END $$;

-- p_file_url ว่าง = ไม่ได้อัปโหลดใหม่ → คงไฟล์เดิม (กติกาเดียวกับ rpc_update_std_drawing)
CREATE OR REPLACE FUNCTION rpc_update_std_price(
  p_id UUID, p_title TEXT, p_price_no TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_file_url TEXT DEFAULT NULL, p_file_name TEXT DEFAULT NULL, p_rev_note TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d std_prices; v_no TEXT; v_url TEXT; v_name TEXT;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO d FROM std_prices WHERE id = p_id FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการราคานี้'; END IF;
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุหัวข้อ/ชื่อรายการราคา'; END IF;
  v_no := NULLIF(btrim(COALESCE(p_price_no, '')), '');
  IF v_no IS NOT NULL AND EXISTS (SELECT 1 FROM std_prices WHERE price_no = v_no AND id <> p_id) THEN
    RAISE EXCEPTION 'เลขเอกสารราคา "%" มีอยู่แล้ว', v_no;
  END IF;

  v_url  := COALESCE(NULLIF(btrim(COALESCE(p_file_url, '')), ''), d.file_url);
  v_name := CASE WHEN NULLIF(btrim(COALESCE(p_file_url, '')), '') IS NOT NULL
                 THEN NULLIF(btrim(COALESCE(p_file_name, '')), '') ELSE d.file_name END;

  UPDATE std_prices SET
    title = btrim(p_title), price_no = v_no,
    description = NULLIF(btrim(COALESCE(p_description, '')), ''),
    file_url = v_url, file_name = v_name,
    rev_note = NULLIF(btrim(COALESCE(p_rev_note, '')), ''),
    updated_by = actor.id, updated_at = now()
  WHERE id = p_id;

  PERFORM app_audit('std_price', p_id, 'update_std_price', actor.id,
    'แก้ Standard Price list "' || d.title || '" → "' || btrim(p_title) || '"' ||
    CASE WHEN v_url IS DISTINCT FROM d.file_url
         THEN ' · เปลี่ยนไฟล์: ' || COALESCE(d.file_name, '-') || ' → ' || COALESCE(v_name, '-')
         ELSE ' · ไฟล์เดิม' END ||
    CASE WHEN NULLIF(btrim(COALESCE(p_rev_note, '')), '') IS NOT NULL
         THEN ' · หมายเหตุ: ' || btrim(p_rev_note) ELSE '' END);
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_std_price(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d std_prices;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO d FROM std_prices WHERE id = p_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการราคานี้'; END IF;
  DELETE FROM std_prices WHERE id = p_id;
  PERFORM app_audit('std_price', p_id, 'delete_std_price', actor.id,
    'ลบ Standard Price list "' || d.title || '" (ไฟล์ ' || COALESCE(d.file_name, '-') || ' ยังอยู่ใน Storage)');
END $$;

-- ---------- 4) grant ----------
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('rpc_create_std_price', 'rpc_update_std_price', 'rpc_delete_std_price')
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.' || fn || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.' || fn || ' TO authenticated';
  END LOOP;
END $$;

DO $$ BEGIN RAISE NOTICE '0054 OK — Standard Price list (std_prices) พร้อมใช้งาน'; END $$;
