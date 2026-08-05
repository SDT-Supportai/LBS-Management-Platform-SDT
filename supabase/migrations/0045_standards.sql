-- =====================================================================
-- 0045: Standard Drawing and BOM List (2026-08-04)
--  เมนูใหม่ /standards — คลังเอกสารมาตรฐานของ LBS ที่ทุกแผนกใช้ร่วมกัน
--    1) Standard Drawing : 1 แบบ = 1 แถว + PDF ให้ผู้เกี่ยวข้องโหลดไปใช้
--    2) Standard BOM List: 1 BOM = 1 แถว + รายการวัสดุ (Epicor/ชื่อ/จำนวน/หน่วย/ต้นทุนประมาณการ)
--  มติ (2026-08-04):
--    - Drawing แก้ไข = **ทับไฟล์เดิม + stamp ครั้งล่าสุด** (updated_at / updated_by / rev_note)
--      ไม่เก็บตาราง revision · แต่ **ไม่ลบ object เก่าใน Storage** และ audit บันทึก URL เก่า→ใหม่
--      → DB มีเฉพาะตัวล่าสุดตามมติ แต่ยังตามไฟล์เก่าจาก audit_logs ได้ถ้าจำเป็น
--    - BOM = **ตารางอ้างอิง/Export เท่านั้น** ยังไม่ต่อเข้า flow ขอวัสดุของ Job
--      (ถ้าจะต่อทีหลัง: loop std_bom_lines ที่มี item_id → rpc_add_accessory_request
--       ต้นทุนประมาณการ → p_unit_price · บรรทัดที่ item_id ว่างต้องข้าม)
--    - สิทธิ์แก้: **Project + Division + Manage** (dept project/sales +admin auto) · อ่าน/โหลด = ทุกแผนก
--    - PDF เก็บใน bucket เดิม `install-photos` prefix `standard-drawings/` (ไม่ต้องสร้าง bucket ใหม่
--      เหมือนที่ 0040 ใช้ prefix job-issues/) · ⚠️ bucket เป็น public read — ใครมี URL เปิดได้
--  BOM line ผูก items เป็นหลัก (item_id) แต่ยอมให้ว่างแล้วพิมพ์ free text ได้
--    (ของที่ยังไม่เข้า Material Database เช่นรายการที่กำลังร่างมาตรฐาน)
--  demo sync ที่ src/data/logic.ts · รันหลัง 0044 · idempotent
-- =====================================================================

-- ---------- 1) Standard Drawing ----------
CREATE TABLE IF NOT EXISTS std_drawings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(255) NOT NULL,       -- หัวข้อ/ชื่อ Drawing
  drawing_no  VARCHAR(100),                -- เลขแบบ (ถ้ามี) — ห้ามซ้ำเมื่อกรอก
  description TEXT,
  file_url    TEXT,                        -- PDF ล่าสุด (ว่าง = ยังไม่แนบไฟล์)
  file_name   VARCHAR(255),
  rev_note    TEXT,                        -- หมายเหตุการแก้ไขครั้งล่าสุด
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES profiles(id),   -- stamp ผู้แก้ไขล่าสุด
  updated_at  TIMESTAMPTZ DEFAULT NOW()      -- stamp วันที่แก้ไขล่าสุด
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_std_drawings_no ON std_drawings(drawing_no) WHERE drawing_no IS NOT NULL;

-- ---------- 2) Standard BOM List ----------
CREATE TABLE IF NOT EXISTS std_boms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(255) NOT NULL,       -- หัวข้อ/ชื่อ BOM
  bom_no      VARCHAR(100),
  description TEXT,
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES profiles(id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_std_boms_no ON std_boms(bom_no) WHERE bom_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS std_bom_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id        UUID NOT NULL REFERENCES std_boms(id) ON DELETE CASCADE,
  item_id       UUID REFERENCES items(id),   -- ผูกฐานข้อมูลวัสดุ (ว่างได้ = ของที่ยังไม่เข้า master)
  epicor_code   VARCHAR(100),                -- snapshot ตอนบันทึก / free text เมื่อไม่มี item_id
  name          VARCHAR(255) NOT NULL,
  qty           NUMERIC NOT NULL CHECK (qty > 0),
  uom           VARCHAR(50),
  est_unit_cost NUMERIC CHECK (est_unit_cost >= 0),   -- ต้นทุนประมาณการต่อหน่วย
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_std_bom_lines_bom ON std_bom_lines(bom_id);

-- ---------- 3) RLS + realtime ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['std_drawings', 'std_boms', 'std_bom_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS read_all ON %I', t);
    -- ทุกแผนกอ่าน/ดาวน์โหลดได้ (เป็นมาตรฐานที่ทุกคนต้องใช้)
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS standards_write ON %I', t);
    -- write ตัวจริงอยู่ที่ RPC (SECURITY DEFINER) — policy กันคนยิง PostgREST ตรง
    EXECUTE format($f$CREATE POLICY standards_write ON %I FOR ALL TO authenticated
      USING (my_department() IN ('project','sales','admin'))
      WITH CHECK (my_department() IN ('project','sales','admin'))$f$, t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ---------- 4) helper สิทธิ์ ----------
CREATE OR REPLACE FUNCTION app_assert_standards() RETURNS profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN app_assert_dept(ARRAY['project', 'sales']);   -- +admin auto
END $$;

-- ---------- 5) RPC: Standard Drawing ----------
CREATE OR REPLACE FUNCTION rpc_create_std_drawing(
  p_title TEXT, p_drawing_no TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_file_url TEXT DEFAULT NULL, p_file_name TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; newid UUID;
BEGIN
  actor := app_assert_standards();
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุหัวข้อ/ชื่อ Drawing'; END IF;
  INSERT INTO std_drawings (title, drawing_no, description, file_url, file_name, created_by, updated_by)
  VALUES (btrim(p_title), NULLIF(btrim(COALESCE(p_drawing_no, '')), ''),
          NULLIF(btrim(COALESCE(p_description, '')), ''),
          NULLIF(btrim(COALESCE(p_file_url, '')), ''), NULLIF(btrim(COALESCE(p_file_name, '')), ''),
          actor.id, actor.id)
  RETURNING id INTO newid;
  PERFORM app_audit('std_drawing', newid, 'create_std_drawing', actor.id,
    'เพิ่ม Standard Drawing "' || btrim(p_title) || '"' ||
    CASE WHEN p_file_name IS NOT NULL THEN ' · ไฟล์ ' || p_file_name ELSE ' · ยังไม่แนบไฟล์' END);
END $$;

-- แก้ไข = ทับข้อมูลเดิม + stamp ผู้แก้/วันที่ · p_file_url ว่าง = คงไฟล์เดิม (ไม่ได้อัปโหลดใหม่)
CREATE OR REPLACE FUNCTION rpc_update_std_drawing(
  p_id UUID, p_title TEXT, p_drawing_no TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_file_url TEXT DEFAULT NULL, p_file_name TEXT DEFAULT NULL, p_rev_note TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d std_drawings; newurl TEXT; newname TEXT;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO d FROM std_drawings WHERE id = p_id FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Drawing นี้'; END IF;
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุหัวข้อ/ชื่อ Drawing'; END IF;

  newurl  := COALESCE(NULLIF(btrim(COALESCE(p_file_url, '')), ''), d.file_url);
  newname := CASE WHEN NULLIF(btrim(COALESCE(p_file_url, '')), '') IS NOT NULL
                  THEN NULLIF(btrim(COALESCE(p_file_name, '')), '') ELSE d.file_name END;

  UPDATE std_drawings SET
    title       = btrim(p_title),
    drawing_no  = NULLIF(btrim(COALESCE(p_drawing_no, '')), ''),
    description = NULLIF(btrim(COALESCE(p_description, '')), ''),
    file_url    = newurl,
    file_name   = newname,
    rev_note    = NULLIF(btrim(COALESCE(p_rev_note, '')), ''),
    updated_by  = actor.id,
    updated_at  = now()
  WHERE id = p_id;

  -- ไฟล์เก่าไม่ถูกลบออกจาก Storage — เก็บ URL เดิมไว้ใน audit เผื่อต้องย้อนดูแบบก่อนแก้
  PERFORM app_audit('std_drawing', p_id, 'update_std_drawing', actor.id,
    'แก้ Standard Drawing "' || d.title || '" → "' || btrim(p_title) || '"' ||
    CASE WHEN newurl IS DISTINCT FROM d.file_url
      THEN ' · เปลี่ยนไฟล์: ' || COALESCE(d.file_name, '-') || ' [' || COALESCE(d.file_url, '-') || ']' ||
           ' → ' || COALESCE(newname, '-')
      ELSE ' · ไฟล์เดิม' END ||
    CASE WHEN p_rev_note IS NOT NULL THEN ' · หมายเหตุ: ' || btrim(p_rev_note) ELSE '' END);
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_std_drawing(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d std_drawings;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO d FROM std_drawings WHERE id = p_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Drawing นี้'; END IF;
  DELETE FROM std_drawings WHERE id = p_id;
  PERFORM app_audit('std_drawing', p_id, 'delete_std_drawing', actor.id,
    'ลบ Standard Drawing "' || d.title || '" (ไฟล์ ' || COALESCE(d.file_name, '-') || ' ยังอยู่ใน Storage)');
END $$;

-- ---------- 6) RPC: Standard BOM ----------
CREATE OR REPLACE FUNCTION rpc_create_std_bom(
  p_title TEXT, p_bom_no TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; newid UUID;
BEGIN
  actor := app_assert_standards();
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุหัวข้อ/ชื่อ BOM'; END IF;
  INSERT INTO std_boms (title, bom_no, description, created_by, updated_by)
  VALUES (btrim(p_title), NULLIF(btrim(COALESCE(p_bom_no, '')), ''),
          NULLIF(btrim(COALESCE(p_description, '')), ''), actor.id, actor.id)
  RETURNING id INTO newid;
  PERFORM app_audit('std_bom', newid, 'create_std_bom', actor.id, 'เพิ่ม Standard BOM "' || btrim(p_title) || '"');
END $$;

CREATE OR REPLACE FUNCTION rpc_update_std_bom(
  p_id UUID, p_title TEXT, p_bom_no TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; b std_boms;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO b FROM std_boms WHERE id = p_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ BOM นี้'; END IF;
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุหัวข้อ/ชื่อ BOM'; END IF;
  UPDATE std_boms SET
    title = btrim(p_title),
    bom_no = NULLIF(btrim(COALESCE(p_bom_no, '')), ''),
    description = NULLIF(btrim(COALESCE(p_description, '')), ''),
    updated_by = actor.id, updated_at = now()
  WHERE id = p_id;
  PERFORM app_audit('std_bom', p_id, 'update_std_bom', actor.id,
    'แก้ Standard BOM "' || b.title || '" → "' || btrim(p_title) || '"');
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_std_bom(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; b std_boms; n INT;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO b FROM std_boms WHERE id = p_id;
  IF b.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ BOM นี้'; END IF;
  SELECT COUNT(*) INTO n FROM std_bom_lines WHERE bom_id = p_id;
  DELETE FROM std_boms WHERE id = p_id;   -- ลูก ON DELETE CASCADE
  PERFORM app_audit('std_bom', p_id, 'delete_std_bom', actor.id,
    'ลบ Standard BOM "' || b.title || '" พร้อมรายการวัสดุ ' || n || ' รายการ');
END $$;

-- ---------- 7) RPC: รายการวัสดุใน BOM ----------
-- item_id ว่างได้ (ของที่ยังไม่เข้า Material Database) แต่ต้องมีชื่อ + จำนวนเสมอ
-- ถ้าส่ง item_id มา → เติม epicor/ชื่อ/หน่วยจาก master ให้เอง (snapshot กันชื่อเพี้ยนภายหลัง)
CREATE OR REPLACE FUNCTION rpc_add_std_bom_line(
  p_bom_id UUID, p_item_id UUID DEFAULT NULL, p_epicor_code TEXT DEFAULT NULL,
  p_name TEXT DEFAULT NULL, p_qty NUMERIC DEFAULT NULL, p_uom TEXT DEFAULT NULL,
  p_est_unit_cost NUMERIC DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; b std_boms; i_name TEXT; i_ep TEXT; i_um TEXT; nm TEXT; ep TEXT; um TEXT; newid UUID;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO b FROM std_boms WHERE id = p_bom_id;
  IF b.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ BOM นี้'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'จำนวนต้องมากกว่า 0'; END IF;

  IF p_item_id IS NOT NULL THEN
    SELECT name, COALESCE(epicor_code, code), uom INTO i_name, i_ep, i_um FROM items WHERE id = p_item_id;
    IF i_name IS NULL THEN RAISE EXCEPTION 'ไม่พบวัสดุในฐานข้อมูล'; END IF;
  END IF;
  nm := COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), i_name);
  ep := COALESCE(NULLIF(btrim(COALESCE(p_epicor_code, '')), ''), i_ep);
  um := COALESCE(NULLIF(btrim(COALESCE(p_uom, '')), ''), i_um);
  IF nm IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกวัสดุจากฐานข้อมูล หรือกรอกชื่ออุปกรณ์'; END IF;

  INSERT INTO std_bom_lines (bom_id, item_id, epicor_code, name, qty, uom, est_unit_cost, note)
  VALUES (p_bom_id, p_item_id, ep, nm, p_qty, um, p_est_unit_cost,
          NULLIF(btrim(COALESCE(p_note, '')), ''))
  RETURNING id INTO newid;

  UPDATE std_boms SET updated_by = actor.id, updated_at = now() WHERE id = p_bom_id;
  PERFORM app_audit('std_bom', p_bom_id, 'add_std_bom_line', actor.id,
    b.title || ' เพิ่มรายการ ' || COALESCE(ep, '-') || ' ' || nm || ' × ' || p_qty || ' ' || COALESCE(um, ''));
END $$;

CREATE OR REPLACE FUNCTION rpc_update_std_bom_line(
  p_line_id UUID, p_item_id UUID DEFAULT NULL, p_epicor_code TEXT DEFAULT NULL,
  p_name TEXT DEFAULT NULL, p_qty NUMERIC DEFAULT NULL, p_uom TEXT DEFAULT NULL,
  p_est_unit_cost NUMERIC DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; ln std_bom_lines; i_name TEXT; i_ep TEXT; i_um TEXT; nm TEXT; ep TEXT; um TEXT;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO ln FROM std_bom_lines WHERE id = p_line_id FOR UPDATE;
  IF ln.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุใน BOM'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'จำนวนต้องมากกว่า 0'; END IF;

  IF p_item_id IS NOT NULL THEN
    SELECT name, COALESCE(epicor_code, code), uom INTO i_name, i_ep, i_um FROM items WHERE id = p_item_id;
    IF i_name IS NULL THEN RAISE EXCEPTION 'ไม่พบวัสดุในฐานข้อมูล'; END IF;
  END IF;
  nm := COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), i_name);
  ep := COALESCE(NULLIF(btrim(COALESCE(p_epicor_code, '')), ''), i_ep);
  um := COALESCE(NULLIF(btrim(COALESCE(p_uom, '')), ''), i_um);
  IF nm IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกวัสดุจากฐานข้อมูล หรือกรอกชื่ออุปกรณ์'; END IF;

  UPDATE std_bom_lines SET
    item_id = p_item_id, epicor_code = ep, name = nm, qty = p_qty, uom = um,
    est_unit_cost = p_est_unit_cost, note = NULLIF(btrim(COALESCE(p_note, '')), '')
  WHERE id = p_line_id;

  UPDATE std_boms SET updated_by = actor.id, updated_at = now() WHERE id = ln.bom_id;
  PERFORM app_audit('std_bom', ln.bom_id, 'update_std_bom_line', actor.id,
    'แก้รายการ ' || ln.name || ' × ' || ln.qty || ' → ' || nm || ' × ' || p_qty || ' ' || COALESCE(um, ''));
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_std_bom_line(p_line_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; ln std_bom_lines;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO ln FROM std_bom_lines WHERE id = p_line_id;
  IF ln.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุใน BOM'; END IF;
  DELETE FROM std_bom_lines WHERE id = p_line_id;
  UPDATE std_boms SET updated_by = actor.id, updated_at = now() WHERE id = ln.bom_id;
  PERFORM app_audit('std_bom', ln.bom_id, 'delete_std_bom_line', actor.id,
    'ลบรายการ ' || COALESCE(ln.epicor_code, '-') || ' ' || ln.name || ' × ' || ln.qty);
END $$;

-- ---------- 8) สิทธิ์เรียก ----------
GRANT EXECUTE ON FUNCTION public.rpc_create_std_drawing(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_std_drawing(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_std_drawing(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_std_bom(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_std_bom(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_std_bom(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_add_std_bom_line(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_std_bom_line(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_std_bom_line(UUID) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0045 OK — Standard Drawing and BOM List พร้อมใช้งาน (แก้ได้: Project/Division/Manage · อ่านได้ทุกแผนก)'; END $$;
