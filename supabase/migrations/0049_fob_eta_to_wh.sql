-- =====================================================================
-- 0049: FOB date + ETA to WH + Status (Pending / On Hand) รายเครื่อง (2026-08-08)
--
--  ที่มา: ตารางรายเครื่องใน Project Stock ต้องบอกได้ว่า "ของถึงคลังหรือยัง"
--    - FOB date       = วันที่ของลงเรือจากผู้ผลิต (กรอก)
--    - ETA to WH      = FOB + 60 วัน (**คำนวณ ไม่เก็บคอลัมน์**)
--    - Status         = ETA ยังไม่ถึง → Pending · ETA ถึง/เกิน → On Hand (**คำนวณ ไม่เก็บคอลัมน์**)
--
--  มติ (2026-08-08) — ทำไมเก็บแค่ fob_date คอลัมน์เดียว:
--   1) ETA/Status เป็น "ฟังก์ชันของ FOB กับวันปัจจุบัน" ล้วน → เก็บลง DB เมื่อไหร่ก็ค้าง
--      (Status ต้องเปลี่ยนเองเมื่อวันผ่านไป ถ้าเก็บเป็นคอลัมน์ต้องมี cron มาไล่อัปเดตทุกวัน)
--      pattern เดียวกับ Actual Delivery/สถานะติดตั้งของ 0043 ที่ derive จาก unit_installations
--   2) **ไม่เพิ่มคอลัมน์วันที่ตัวที่ 3** — `plan_po_receipt_date` (0043) ความหมายคือ
--      "วันที่คาดว่าของจะเข้าคลัง" = ETA to WH อยู่แล้ว → ใช้คอลัมน์เดิมเป็น **ETA แบบกรอกเอง**
--      (ล็อตเก่าที่ไม่รู้ FOB / ล็อตที่รู้วันเข้าคลังตรงๆ) ไม่ต้อง migrate ข้อมูลเดิมเลย
--      กติกาแสดงผล: มี fob_date → ETA = fob + 60 (ป้าย "auto") · ไม่มี → ใช้ plan_po_receipt_date
--   3) ไม่ระบุ ETA เลย = **On Hand** (เครื่องที่รับเข้าคลังโดยไม่บันทึกกำหนดเรือ = ของอยู่ในคลังจริง)
--      → ข้อมูลเดิมทั้งหมดยังถูกต้องโดยไม่ต้องแตะ
--
--  ⚠️ ไม่แตะ rpc_create_project_stock / rpc_add_units_to_stock — 0031 patch สตริงแจ้งเตือนไว้
--     (บทเรียน §9.5: CREATE OR REPLACE ด้วย body เก่า = revert 0031 เงียบๆ)
--     การตั้ง FOB ตอนสร้างคลังใช้ปุ่มใหม่ "🚢 ตั้ง FOB ทั้งคลัง" → rpc_set_stock_fob (ฟังก์ชันใหม่ ไม่มีของเดิมให้พัง)
--
--  demo sync ที่ src/data/logic.ts (unitEta / unitStockState / updateUnitPlan / setStockFob / importUnitsToStock)
--  รันหลัง 0048 · idempotent (รันซ้ำได้)
-- =====================================================================

-- ---------- 1) schema ----------
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS fob_date DATE;
COMMENT ON COLUMN lbs_units.fob_date IS
  'FOB date — วันของลงเรือ · ETA to WH = fob_date + 60 วัน (คำนวณฝั่งแอป ไม่เก็บคอลัมน์)';
COMMENT ON COLUMN lbs_units.plan_po_receipt_date IS
  'ETA to WH แบบกรอกเอง — ใช้เมื่อไม่มี fob_date (0049 เปลี่ยนความหมายจาก "Plan PO receipt" เดิม ค่าเท่ากัน)';

-- ---------- 2) แก้ข้อมูลรายเครื่อง: + p_fob_date ----------
-- ⚠️ ต้อง DROP signature เดิม (7 args) ก่อน ไม่งั้น PostgREST เจอ 2 overload → PGRST203 ambiguous (§9.8)
DROP FUNCTION IF EXISTS rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE);

-- ⚠️ ฟอร์มส่งค่าครบทุกช่องทุกครั้ง → NULL = "ล้างค่า" ไม่ใช่ "ไม่เปลี่ยน" (คงกติกา 0043)
CREATE OR REPLACE FUNCTION rpc_update_unit_plan(
  p_unit_id         UUID,
  p_unit_cost       NUMERIC DEFAULT NULL,
  p_customer_name   TEXT    DEFAULT NULL,
  p_contact_phone   TEXT    DEFAULT NULL,
  p_install_location TEXT   DEFAULT NULL,
  p_plan_po_receipt DATE    DEFAULT NULL,
  p_plan_delivery   DATE    DEFAULT NULL,
  p_fob_date        DATE    DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks; v_eta DATE;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);   -- Division + Manage
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id FOR UPDATE;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.status = 'issued' THEN
    RAISE EXCEPTION 'Serial % ถูกเบิกให้ Service แล้ว — แก้ข้อมูลรายเครื่องไม่ได้ (allocation ถูกล็อก)', u.serial_lvb;
  END IF;
  IF p_unit_cost IS NOT NULL AND p_unit_cost < 0 THEN
    RAISE EXCEPTION 'ต้นทุน/เครื่องต้องไม่ติดลบ';
  END IF;

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;
  -- มี FOB → ETA เป็นค่าคำนวณ (ไม่เก็บซ้ำ) · ไม่มี FOB → ETA คือค่าที่กรอกเอง
  v_eta := CASE WHEN p_fob_date IS NOT NULL THEN p_fob_date + 60 ELSE p_plan_po_receipt END;

  UPDATE lbs_units SET
    unit_cost             = p_unit_cost,
    plan_customer_name    = NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
    plan_contact_phone    = NULLIF(btrim(COALESCE(p_contact_phone, '')), ''),
    plan_install_location = NULLIF(btrim(COALESCE(p_install_location, '')), ''),
    fob_date              = p_fob_date,
    -- มี FOB แล้วต้องล้างค่ากรอกมือทิ้ง ไม่งั้นเหลือ 2 แหล่งความจริงของ ETA
    plan_po_receipt_date  = CASE WHEN p_fob_date IS NOT NULL THEN NULL ELSE p_plan_po_receipt END,
    plan_delivery_date    = p_plan_delivery,
    updated_at            = now()
  WHERE id = p_unit_id;

  PERFORM app_audit('lbs_unit', p_unit_id, 'update_unit_plan', actor.id,
    COALESCE(s.stock_no, '') || ' · ' || u.serial_lvb || '/' || COALESCE(u.serial_om, '-') ||
    ' → ต้นทุน ' || COALESCE(round(p_unit_cost, 2)::TEXT, '-') ||
    ' ฿ · ลูกค้า(แผน) ' || COALESCE(p_customer_name, '-') ||
    ' · FOB ' || COALESCE(p_fob_date::TEXT, '-') ||
    ' · ETA to WH ' || COALESCE(v_eta::TEXT, '-') ||
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-'));
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE) TO authenticated;

-- ---------- 3) ตั้ง FOB date ทั้งคลังในครั้งเดียว (ฟังก์ชันใหม่) ----------
-- ล็อตหนึ่ง PO มักลงเรือพร้อมกัน → ไม่ต้องกรอกทีละ 30 เครื่อง
-- p_overwrite = false → เติมเฉพาะเครื่องที่ยังไม่มี FOB (ไม่ทับของที่ตั้งไว้แล้ว)
-- ข้ามเครื่องที่เบิกแล้วเสมอ — trigger trg_block_issued_edit (0001) บล็อก UPDATE อยู่
CREATE OR REPLACE FUNCTION rpc_set_stock_fob(p_stock_id UUID, p_fob_date DATE, p_overwrite BOOLEAN DEFAULT FALSE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; cnt INT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF p_fob_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุ FOB date'; END IF;
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;

  UPDATE lbs_units SET
    fob_date             = p_fob_date,
    plan_po_receipt_date = NULL,       -- ETA กลายเป็นค่าคำนวณ → ล้างค่ากรอกมือ (แหล่งความจริงเดียว)
    updated_at           = now()
  WHERE project_stock_id = p_stock_id
    AND status <> 'issued'
    AND (COALESCE(p_overwrite, FALSE) OR fob_date IS NULL)
    AND fob_date IS DISTINCT FROM p_fob_date;
  GET DIAGNOSTICS cnt = ROW_COUNT;

  IF cnt = 0 THEN
    RAISE EXCEPTION 'ไม่มีเครื่องที่ต้องอัพเดท (ทุกเครื่องมี FOB นี้อยู่แล้ว หรือถูกเบิกไปหมดแล้ว)';
  END IF;

  PERFORM app_audit('project_stock', p_stock_id, 'set_stock_fob', actor.id,
    'ตั้ง FOB date ' || p_fob_date::TEXT || ' ให้ ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง' ||
    ' (ETA to WH = ' || (p_fob_date + 60)::TEXT || ')' ||
    CASE WHEN COALESCE(p_overwrite, FALSE) THEN ' · ทับค่าเดิม' ELSE ' · เฉพาะเครื่องที่ยังว่าง' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_set_stock_fob(UUID, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_stock_fob(UUID, DATE, BOOLEAN) TO authenticated;

-- ---------- 4) Import Excel: รับคอลัมน์ FOB date ----------
-- ✅ signature เดิม (jsonb) — เติม key 'fob' เข้า payload ได้เลย ไม่เสี่ยง PGRST202 (แนวเดียวกับ 0048)
-- body นี้ = ของ 0048 ทั้งดุ้น + จัดการ fob (แก้เท่าที่จำเป็น ตาม §9.5)
-- กติกา: ไฟล์มี FOB → เขียน fob_date + ล้าง plan_po_receipt_date (ETA เป็นค่าคำนวณ)
--        ไฟล์ไม่มี FOB → คอลัมน์ ETA to WH ในไฟล์ลง plan_po_receipt_date ตามเดิม (UI เป็นคนตัดสินและส่งมาให้แล้ว)
CREATE OR REPLACE FUNCTION rpc_import_units_to_stock(p_stock_id UUID, p_new_units JSONB, p_update_units JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; s project_stocks; u JSONB; lvb TEXT; om TEXT; c NUMERIC;
  v_cust TEXT; v_phone TEXT; v_loc TEXT; v_por DATE; v_del DATE; v_fob DATE;
  newcnt INT := 0; updcnt INT := 0; lockedcnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;

  -- ---------- อัพเดทเครื่องเดิม: match คู่ Serial (lvb+om) เฉพาะในคลังนี้ ----------
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_update_units, '[]'::jsonb)) LOOP
    lvb := btrim(COALESCE(u->>'lvb', '')); om := btrim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' OR om = '';

    c       := app_unit_cost(u);                                        -- validate ≥0 ในตัว (0024)
    v_cust  := NULLIF(btrim(COALESCE(u->>'customer', '')), '');
    v_phone := NULLIF(btrim(COALESCE(u->>'phone', '')), '');
    v_loc   := NULLIF(btrim(COALESCE(u->>'location', '')), '');
    v_fob   := NULLIF(btrim(COALESCE(u->>'fob', '')), '')::DATE;
    v_por   := NULLIF(btrim(COALESCE(u->>'plan_po_receipt', '')), '')::DATE;
    v_del   := NULLIF(btrim(COALESCE(u->>'plan_delivery', '')), '')::DATE;

    -- ไฟล์ไม่ได้กรอกอะไรให้แถวนี้เลย → ข้าม (ไม่นับเป็นอัพเดท)
    CONTINUE WHEN c IS NULL AND v_cust IS NULL AND v_phone IS NULL
             AND v_loc IS NULL AND v_fob IS NULL AND v_por IS NULL AND v_del IS NULL;

    -- เครื่องที่เบิกแล้วแก้ไม่ได้ (trigger ล็อก) → นับไว้บอกผู้ใช้ ไม่ทำให้ทั้งไฟล์ล้ม
    IF EXISTS (
      SELECT 1 FROM lbs_units
       WHERE project_stock_id = p_stock_id AND serial_lvb = lvb AND serial_om = om AND status = 'issued'
    ) THEN
      lockedcnt := lockedcnt + 1;
      CONTINUE;
    END IF;

    UPDATE lbs_units SET
      unit_cost            = COALESCE(c, unit_cost),
      fob_date             = COALESCE(v_fob, fob_date),
      -- มี FOB ในไฟล์ → ETA เป็นค่าคำนวณ ล้างค่ากรอกมือทิ้ง · ไม่มี FOB → รับค่า ETA ที่ไฟล์ส่งมา
      plan_po_receipt_date = CASE WHEN v_fob IS NOT NULL THEN NULL
                                  ELSE COALESCE(v_por, plan_po_receipt_date) END,
      plan_delivery_date   = COALESCE(v_del, plan_delivery_date),
      -- ลูกค้า/เบอร์/สถานที่: เขียนได้เฉพาะเครื่องที่ยังไม่ผูก Job (กฎ 0014)
      plan_customer_name    = CASE WHEN job_id IS NULL THEN COALESCE(v_cust, plan_customer_name)  ELSE plan_customer_name    END,
      plan_contact_phone    = CASE WHEN job_id IS NULL THEN COALESCE(v_phone, plan_contact_phone) ELSE plan_contact_phone    END,
      plan_install_location = CASE WHEN job_id IS NULL THEN COALESCE(v_loc, plan_install_location) ELSE plan_install_location END,
      updated_at           = now()
    WHERE project_stock_id = p_stock_id AND serial_lvb = lvb AND serial_om = om AND status <> 'issued';
    IF FOUND THEN updcnt := updcnt + 1; END IF;
  END LOOP;

  -- ---------- รับเครื่องใหม่ (validation เดียวกับ rpc_add_units_to_stock) ----------
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_new_units, '[]'::jsonb)) LOOP
    lvb := btrim(COALESCE(u->>'lvb', '')); om := btrim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    v_fob := NULLIF(btrim(COALESCE(u->>'fob', '')), '')::DATE;
    -- เครื่องใหม่ยังไม่มี Job แน่นอน → ใส่ข้อมูลแผนได้ทุกช่อง
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, unit_cost,
                           plan_customer_name, plan_contact_phone, plan_install_location,
                           fob_date, plan_po_receipt_date, plan_delivery_date)
    VALUES (lvb, om, p_stock_id, app_unit_cost(u),
            NULLIF(btrim(COALESCE(u->>'customer', '')), ''),
            NULLIF(btrim(COALESCE(u->>'phone', '')), ''),
            NULLIF(btrim(COALESCE(u->>'location', '')), ''),
            v_fob,
            CASE WHEN v_fob IS NOT NULL THEN NULL
                 ELSE NULLIF(btrim(COALESCE(u->>'plan_po_receipt', '')), '')::DATE END,
            NULLIF(btrim(COALESCE(u->>'plan_delivery', '')), '')::DATE);
    newcnt := newcnt + 1;
  END LOOP;

  IF newcnt = 0 AND updcnt = 0 THEN
    IF lockedcnt > 0 THEN
      RAISE EXCEPTION 'ทุกเครื่องในไฟล์ถูกเบิกให้ Service แล้ว (% เครื่อง) แก้ข้อมูลไม่ได้', lockedcnt;
    END IF;
    RAISE EXCEPTION 'ไม่มีรายการให้นำเข้า';
  END IF;

  IF newcnt > 0 THEN
    PERFORM app_notify('stock_received',
      '📦 เพิ่ม LBS เข้า ' || s.stock_no || ' +' || newcnt || ' เครื่อง (พร้อมดึงเข้า Job)',
      'project', NULL);
  END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'import_units', actor.id,
    'Import เข้า ' || s.stock_no || ': รับใหม่ ' || newcnt || ' เครื่อง'
    || CASE WHEN updcnt > 0 THEN ' · อัพเดทข้อมูลเครื่องเดิม ' || updcnt || ' เครื่อง' ELSE '' END
    || CASE WHEN lockedcnt > 0 THEN ' · ข้ามเครื่องที่เบิกแล้ว ' || lockedcnt || ' เครื่อง' ELSE '' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0049 OK — FOB date + ETA to WH (FOB+60, คำนวณ) + Status Pending/On Hand + ตั้ง FOB ทั้งคลัง'; END $$;
