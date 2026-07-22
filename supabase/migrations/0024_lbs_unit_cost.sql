-- =====================================================================
-- 0024: ต้นทุนตัว LBS ต่อเครื่อง (2026-07-22)
--  เพิ่ม lbs_units.unit_cost — กรอกราคาต่อเครื่องตอนสร้าง/รับเข้า Project Stock
--  units JSONB รับ field ใหม่ 'cost' (ต่อเครื่อง) นอกจาก lvb/om เดิม (backward-compatible:
--    ไฟล์/ฟอร์มเดิมที่ไม่ส่ง cost → unit_cost = NULL)
--  งบ Job: ดึง LBS เข้า Job → ต้นทุนเครื่องบวกเข้า actual หมวด Raw Material
--    (คิดฝั่ง client jobBudgetSummary + jobLbsCost — ไม่ต้องแก้ RPC ดึง/คืน LBS)
--  recreate rpc_create_project_stock / rpc_add_units_to_stock (คงพฤติกรรมเดิมทุกอย่าง
--    + อ่าน cost จาก JSONB, validate >= 0, insert unit_cost)
--  demo sync ที่ src/data/logic.ts · รันหลัง 0023 (idempotent รันซ้ำได้)
-- =====================================================================

ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS unit_cost NUMERIC;

-- helper: อ่าน cost จาก unit JSONB (คืน NULL ถ้าไม่ส่ง/ว่าง, error ถ้าติดลบ/ไม่ใช่ตัวเลข)
CREATE OR REPLACE FUNCTION app_unit_cost(u JSONB) RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c NUMERIC;
BEGIN
  IF u->>'cost' IS NULL OR trim(u->>'cost') = '' THEN RETURN NULL; END IF;
  BEGIN
    c := (u->>'cost')::NUMERIC;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'ต้นทุนตัว LBS ต้องเป็นตัวเลข ("%")', u->>'cost';
  END;
  IF c < 0 THEN RAISE EXCEPTION 'ต้นทุนตัว LBS ติดลบไม่ได้'; END IF;
  RETURN c;
END $$;

-- สร้างคลัง: + unit_cost ต่อเครื่อง
CREATE OR REPLACE FUNCTION rpc_create_project_stock(p_stock_no TEXT, p_item_id UUID, p_units JSONB, p_notes TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; sid UUID; u JSONB; lvb TEXT; om TEXT; cnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(p_stock_no) = '' THEN RAISE EXCEPTION 'กรุณาระบุ Stock No.'; END IF;
  IF EXISTS (SELECT 1 FROM project_stocks WHERE stock_no = trim(p_stock_no)) THEN
    RAISE EXCEPTION 'Stock No. "%" มีอยู่แล้ว', trim(p_stock_no);
  END IF;

  INSERT INTO project_stocks (stock_no, item_id, notes, created_by)
  VALUES (trim(p_stock_no), p_item_id, p_notes, actor.id) RETURNING id INTO sid;

  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_units, '[]'::jsonb)) LOOP
    lvb := trim(COALESCE(u->>'lvb', '')); om := trim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, unit_cost)
    VALUES (lvb, om, sid, app_unit_cost(u));
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;

  PERFORM app_notify('stock_created',
    '📦 Sales รับ LBS เข้า ' || trim(p_stock_no) || ' จำนวน ' || cnt || ' เครื่อง — พร้อมให้ดึงเข้า Job',
    'project', NULL);
  PERFORM app_audit('project_stock', sid, 'create_stock', actor.id,
    'สร้าง ' || trim(p_stock_no) || ' รับ LBS เข้า ' || cnt || ' เครื่อง');
  RETURN sid;
END $$;

-- รับเข้าคลังเดิม / Excel import: + unit_cost ต่อเครื่อง (คงพฤติกรรม 0018 ทุกอย่าง)
CREATE OR REPLACE FUNCTION rpc_add_units_to_stock(p_stock_id UUID, p_units JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; u JSONB; lvb TEXT; om TEXT; cnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_units, '[]'::jsonb)) LOOP
    lvb := trim(COALESCE(u->>'lvb', '')); om := trim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, unit_cost)
    VALUES (lvb, om, p_stock_id, app_unit_cost(u));
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;
  PERFORM app_notify('stock_received',
    '📦 Division รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง — พร้อมให้ดึงเข้า Job',
    'project', NULL);
  PERFORM app_audit('project_stock', p_stock_id, 'add_units', actor.id,
    'รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง');
END $$;

-- สิทธิ์เรียก RPC: เฉพาะผู้ login แล้ว (signature เดิมไม่เปลี่ยน — grant คงอยู่ แต่ re-apply กันพลาด)
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('rpc_create_project_stock', 'rpc_add_units_to_stock', 'app_unit_cost')
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.' || fn || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.' || fn || ' TO authenticated';
  END LOOP;
END $$;
