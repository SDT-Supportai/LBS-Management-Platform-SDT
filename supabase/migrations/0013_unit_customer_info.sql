-- =====================================================================
-- 0013: ข้อมูลลูกค้ารายเครื่อง (2026-07-16)
--  เพิ่ม ชื่อลูกค้า/เบอร์ติดต่อ/สถานที่ติดตั้ง ที่ lbs_units (เครื่องต่อเครื่อง)
--  ค่าระดับคลัง (0012) = ค่าเริ่มต้นของล็อต: เครื่องไหนไม่กรอกเอง UI แสดงค่าของคลัง (fallback)
--  แก้ไขรายเครื่อง: rpc_update_unit_info — Serial แก้ได้เฉพาะ in_stock,
--  ข้อมูลลูกค้าแก้ได้จนกว่าเครื่องถูกเบิก (issued) · Excel import ส่ง field เพิ่มผ่าน jsonb เดิม
--  รันหลัง 0012 (idempotent)
-- =====================================================================

-- ---------- 1) Schema ----------
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS customer_name    VARCHAR(255);
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS contact_phone    VARCHAR(50);
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS install_location TEXT;

-- ---------- 2) ยกเลิกของเดิม ----------
DROP FUNCTION IF EXISTS rpc_update_lbs_serials(UUID, TEXT, TEXT);

-- ---------- 3) RPC ----------

-- แก้ไขรายเครื่อง: Serial (เฉพาะ in_stock) + ข้อมูลลูกค้า (จนกว่า issued)
CREATE OR REPLACE FUNCTION rpc_update_unit_info(p_unit_id UUID, p_serial_lvb TEXT, p_serial_om TEXT,
                                                p_customer TEXT DEFAULT NULL, p_phone TEXT DEFAULT NULL, p_location TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; lvb TEXT; om TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.status = 'issued' THEN RAISE EXCEPTION 'เครื่องนี้ถูกเบิกให้ Service แล้ว แก้ไขไม่ได้'; END IF;
  lvb := trim(p_serial_lvb); om := trim(p_serial_om);
  IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM'; END IF;
  IF (lvb <> u.serial_lvb OR om <> u.serial_om) AND u.status <> 'in_stock' THEN
    RAISE EXCEPTION 'แก้ Serial ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (ยังไม่ถูกดึงเข้า Job)';
  END IF;
  IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน'; END IF;
  IF EXISTS (SELECT 1 FROM lbs_units
             WHERE id <> p_unit_id AND (serial_lvb IN (lvb, om) OR serial_om IN (lvb, om))) THEN
    RAISE EXCEPTION 'Serial No. "%" / "%" ซ้ำกับเครื่องอื่นในระบบ', lvb, om;
  END IF;

  UPDATE lbs_units SET serial_lvb = lvb, serial_om = om,
    customer_name    = NULLIF(trim(COALESCE(p_customer, '')), ''),
    contact_phone    = NULLIF(trim(COALESCE(p_phone, '')), ''),
    install_location = NULLIF(trim(COALESCE(p_location, '')), ''),
    updated_at = now()
  WHERE id = p_unit_id;
  PERFORM app_audit('lbs_unit', p_unit_id, 'update_unit_info', actor.id,
    'แก้ไขเครื่อง ' || u.serial_lvb || CASE WHEN lvb <> u.serial_lvb OR om <> u.serial_om
      THEN ' (Serial → ' || lvb || '/' || om || ')' ELSE '' END
    || CASE WHEN NULLIF(trim(COALESCE(p_customer, '')), '') IS NOT NULL
      THEN ' ลูกค้า ' || trim(p_customer) ELSE '' END);
END $$;

-- สร้างคลัง: รับ field ลูกค้ารายเครื่องเพิ่มจาก jsonb เดิม (signature ไม่เปลี่ยน — replace body)
CREATE OR REPLACE FUNCTION rpc_create_project_stock(p_stock_no TEXT, p_item_id UUID, p_units JSONB, p_notes TEXT,
                                                    p_customer TEXT DEFAULT NULL, p_phone TEXT DEFAULT NULL, p_location TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; sid UUID; u JSONB; lvb TEXT; om TEXT; cnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(p_stock_no) = '' THEN RAISE EXCEPTION 'กรุณาระบุ Stock No.'; END IF;
  IF EXISTS (SELECT 1 FROM project_stocks WHERE stock_no = trim(p_stock_no)) THEN
    RAISE EXCEPTION 'Stock No. "%" มีอยู่แล้ว', trim(p_stock_no);
  END IF;

  INSERT INTO project_stocks (stock_no, item_id, notes, customer_name, contact_phone, install_location, created_by)
  VALUES (trim(p_stock_no), p_item_id, p_notes,
          NULLIF(trim(COALESCE(p_customer, '')), ''),
          NULLIF(trim(COALESCE(p_phone, '')), ''),
          NULLIF(trim(COALESCE(p_location, '')), ''),
          actor.id) RETURNING id INTO sid;

  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_units, '[]'::jsonb)) LOOP
    lvb := trim(COALESCE(u->>'lvb', '')); om := trim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, customer_name, contact_phone, install_location)
    VALUES (lvb, om, sid,
            NULLIF(trim(COALESCE(u->>'customer', '')), ''),
            NULLIF(trim(COALESCE(u->>'phone', '')), ''),
            NULLIF(trim(COALESCE(u->>'location', '')), ''));
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;

  PERFORM app_notify('stock_created',
    '📦 Sales รับ LBS เข้า ' || trim(p_stock_no) || ' จำนวน ' || cnt || ' เครื่อง'
    || CASE WHEN NULLIF(trim(COALESCE(p_customer, '')), '') IS NOT NULL THEN ' (ลูกค้า ' || trim(p_customer) || ')' ELSE '' END
    || ' — พร้อมให้ดึงเข้า Job',
    'project', NULL);
  PERFORM app_audit('project_stock', sid, 'create_stock', actor.id,
    'สร้าง ' || trim(p_stock_no) || ' รับ LBS เข้า ' || cnt || ' เครื่อง'
    || CASE WHEN NULLIF(trim(COALESCE(p_customer, '')), '') IS NOT NULL THEN ' ลูกค้า ' || trim(p_customer) ELSE '' END);
  RETURN sid;
END $$;

-- รับเครื่องเพิ่ม: รับ field ลูกค้ารายเครื่องเพิ่มจาก jsonb เดิม (signature ไม่เปลี่ยน — replace body)
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
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, customer_name, contact_phone, install_location)
    VALUES (lvb, om, p_stock_id,
            NULLIF(trim(COALESCE(u->>'customer', '')), ''),
            NULLIF(trim(COALESCE(u->>'phone', '')), ''),
            NULLIF(trim(COALESCE(u->>'location', '')), ''));
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'add_units', actor.id,
    'รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง');
END $$;
