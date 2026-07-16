-- =====================================================================
-- 0012: Project Stock + ข้อมูลลูกค้า (2026-07-16)
--  เพิ่ม ชื่อลูกค้า / เบอร์ติดต่อ / สถานที่ติดตั้ง ให้ project_stocks
--  ทั้ง 3 ช่องเป็น optional (เว้นว่าง = คลังกลางยังไม่ผูกลูกค้า แบบเดิม)
--  กรอกได้ตอนสร้าง + แก้ไขภายหลังผ่าน rpc_update_project_stock
--  รันหลัง 0011 (idempotent)
-- =====================================================================

-- ---------- 1) Schema ----------
ALTER TABLE project_stocks ADD COLUMN IF NOT EXISTS customer_name    VARCHAR(255);
ALTER TABLE project_stocks ADD COLUMN IF NOT EXISTS contact_phone    VARCHAR(50);
ALTER TABLE project_stocks ADD COLUMN IF NOT EXISTS install_location TEXT;

-- ---------- 2) ยกเลิก signature เดิม (กัน overload กำกวมใน PostgREST) ----------
DROP FUNCTION IF EXISTS rpc_create_project_stock(TEXT, UUID, JSONB, TEXT);
DROP FUNCTION IF EXISTS rpc_update_project_stock(UUID, TEXT, TEXT);

-- ---------- 3) RPC ----------

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
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id) VALUES (lvb, om, sid);
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

CREATE OR REPLACE FUNCTION rpc_update_project_stock(p_stock_id UUID, p_notes TEXT, p_status TEXT,
                                                    p_customer TEXT DEFAULT NULL, p_phone TEXT DEFAULT NULL, p_location TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  UPDATE project_stocks SET notes = p_notes, status = p_status,
    customer_name    = NULLIF(trim(COALESCE(p_customer, '')), ''),
    contact_phone    = NULLIF(trim(COALESCE(p_phone, '')), ''),
    install_location = NULLIF(trim(COALESCE(p_location, '')), '')
  WHERE id = p_stock_id;
  PERFORM app_audit('project_stock', p_stock_id, 'update_stock', actor.id,
    'แก้ไข ' || s.stock_no || CASE WHEN s.status <> p_status
      THEN CASE WHEN p_status = 'closed' THEN ' (ปิดคลัง — ห้ามดึงเพิ่ม)' ELSE ' (เปิดคลังอีกครั้ง)' END
      ELSE '' END);
END $$;
