-- =====================================================================
-- 0025: Import Serial แบบ upsert — รับใหม่ + อัพเดทต้นทุนเครื่องที่ซ้ำในคลัง (2026-07-23)
--  เดิม Import เจอ Serial ซ้ำ = error บล็อกทั้งไฟล์ · ตอนนี้ UI แยกแยะให้ผู้ใช้ตัดสินใจ:
--    - ซ้ำในคลังนี้ (คู่ Serial lvb+om ตรงกัน)  → อัพเดทต้นทุนเครื่องเดิม
--    - ชนคลังอื่น / คู่ Serial ไม่ตรง          → error (กรอกผิด/ซ้ำ)
--    - ยังไม่มีในระบบ                          → รับเข้าใหม่
--  rpc_import_units_to_stock(p_new_units, p_update_units):
--    - update: match คู่ Serial เฉพาะในคลังนี้, cost ว่าง = คงค่าเดิม (COALESCE ผ่าน app_unit_cost คืน NULL → skip)
--    - insert: validation เดียวกับ rpc_add_units_to_stock (กันซ้ำทั้งระบบ)
--  demo sync ที่ src/data/logic.ts importUnitsToStock · ใช้ app_unit_cost (0024) · รันหลัง 0024 (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_import_units_to_stock(p_stock_id UUID, p_new_units JSONB, p_update_units JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; u JSONB; lvb TEXT; om TEXT; c NUMERIC; newcnt INT := 0; updcnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;

  -- อัพเดทต้นทุน: match คู่ Serial (lvb+om) เฉพาะเครื่องในคลังนี้ · cost ว่าง (NULL) = คงค่าเดิม
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_update_units, '[]'::jsonb)) LOOP
    lvb := trim(COALESCE(u->>'lvb', '')); om := trim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' OR om = '';
    c := app_unit_cost(u);
    CONTINUE WHEN c IS NULL;
    UPDATE lbs_units SET unit_cost = c, updated_at = now()
      WHERE project_stock_id = p_stock_id AND serial_lvb = lvb AND serial_om = om;
    IF FOUND THEN updcnt := updcnt + 1; END IF;
  END LOOP;

  -- รับเครื่องใหม่ (validation เดียวกับ rpc_add_units_to_stock)
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_new_units, '[]'::jsonb)) LOOP
    lvb := trim(COALESCE(u->>'lvb', '')); om := trim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, unit_cost)
    VALUES (lvb, om, p_stock_id, app_unit_cost(u));
    newcnt := newcnt + 1;
  END LOOP;

  IF newcnt = 0 AND updcnt = 0 THEN RAISE EXCEPTION 'ไม่มีรายการให้นำเข้า'; END IF;
  IF newcnt > 0 THEN
    PERFORM app_notify('stock_received',
      '📦 Division รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || newcnt || ' เครื่อง — พร้อมให้ดึงเข้า Job',
      'project', NULL);
  END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'import_units', actor.id,
    'Import เข้า ' || s.stock_no || ': รับใหม่ ' || newcnt || ' เครื่อง'
    || CASE WHEN updcnt > 0 THEN ' · อัพเดทต้นทุน ' || updcnt || ' เครื่อง' ELSE '' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) TO authenticated;
