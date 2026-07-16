-- =====================================================================
-- 0014: ข้อมูลลูกค้าอ้างอิงจาก Job (2026-07-16) — แทนแนวทาง 0012/0013
--  มติผู้ใช้: ไม่กรอกข้อมูลลูกค้าที่คลัง/รายเครื่อง — Job เป็น source of truth เดียว
--  ตาราง "ดูรายเครื่อง" แสดง ลูกค้า/เบอร์/สถานที่ จาก Job ที่เครื่องถูกดึงเข้า
--  (1) jobs + contact_phone (ใหม่ — ฟอร์มเปิด Job มีชื่อลูกค้า/สถานที่อยู่แล้ว เพิ่มเบอร์ให้ครบ)
--  (2) revert stock RPC กลับไม่มี param ลูกค้า + drop คอลัมน์ลูกค้าที่ project_stocks/lbs_units
--  (3) rpc_update_unit_info เหลือแก้ Serial อย่างเดียว (เฉพาะ in_stock)
--  รันหลัง 0013 (idempotent — รองรับทั้งกรณีที่รัน 0012/0013 แล้วหรือยัง)
-- =====================================================================

-- ---------- 1) Schema ----------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50);

ALTER TABLE project_stocks DROP COLUMN IF EXISTS customer_name;
ALTER TABLE project_stocks DROP COLUMN IF EXISTS contact_phone;
ALTER TABLE project_stocks DROP COLUMN IF EXISTS install_location;
ALTER TABLE lbs_units DROP COLUMN IF EXISTS customer_name;
ALTER TABLE lbs_units DROP COLUMN IF EXISTS contact_phone;
ALTER TABLE lbs_units DROP COLUMN IF EXISTS install_location;

-- ---------- 2) ยกเลิก signature เดิม (กัน overload กำกวมใน PostgREST) ----------
DROP FUNCTION IF EXISTS rpc_create_project_stock(TEXT, UUID, JSONB, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS rpc_update_project_stock(UUID, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS rpc_update_unit_info(UUID, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS rpc_update_lbs_serials(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS rpc_create_job(TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS rpc_update_job(UUID, TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, NUMERIC);

-- ---------- 3) RPC ----------

-- สร้างคลัง: กลับเป็นไม่มีข้อมูลลูกค้า (units = {lvb, om})
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
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id) VALUES (lvb, om, sid);
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

-- แก้ไขคลัง: กลับเป็น notes + status
CREATE OR REPLACE FUNCTION rpc_update_project_stock(p_stock_id UUID, p_notes TEXT, p_status TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  UPDATE project_stocks SET notes = p_notes, status = p_status WHERE id = p_stock_id;
  PERFORM app_audit('project_stock', p_stock_id, 'update_stock', actor.id,
    'แก้ไข ' || s.stock_no || CASE WHEN s.status <> p_status
      THEN CASE WHEN p_status = 'closed' THEN ' (ปิดคลัง — ห้ามดึงเพิ่ม)' ELSE ' (เปิดคลังอีกครั้ง)' END
      ELSE '' END);
END $$;

-- แก้ Serial รายเครื่อง (เฉพาะ in_stock) — ชื่อฟังก์ชันคงเดิมให้ frontend เรียกต่อได้
CREATE OR REPLACE FUNCTION rpc_update_unit_info(p_unit_id UUID, p_serial_lvb TEXT, p_serial_om TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; lvb TEXT; om TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.status <> 'in_stock' THEN
    RAISE EXCEPTION 'แก้ Serial ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (ยังไม่ถูกดึงเข้า Job)';
  END IF;
  lvb := trim(p_serial_lvb); om := trim(p_serial_om);
  IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM'; END IF;
  IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน'; END IF;
  IF EXISTS (SELECT 1 FROM lbs_units
             WHERE id <> p_unit_id AND (serial_lvb IN (lvb, om) OR serial_om IN (lvb, om))) THEN
    RAISE EXCEPTION 'Serial No. "%" / "%" ซ้ำกับเครื่องอื่นในระบบ', lvb, om;
  END IF;
  UPDATE lbs_units SET serial_lvb = lvb, serial_om = om, updated_at = now() WHERE id = p_unit_id;
  PERFORM app_audit('lbs_unit', p_unit_id, 'update_serials', actor.id,
    'แก้ Serial: ' || u.serial_lvb || '/' || u.serial_om || ' → ' || lvb || '/' || om);
END $$;

-- เปิด Job: + เบอร์ติดต่อ
CREATE OR REPLACE FUNCTION rpc_create_job(p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_cost NUMERIC DEFAULT NULL, p_phone TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; jid UUID; jno TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  jno := trim(p_job_no);
  IF jno = '' THEN RAISE EXCEPTION 'กรุณาระบุ Job No.'; END IF;
  IF EXISTS (SELECT 1 FROM jobs WHERE lower(job_no) = lower(jno)) THEN
    RAISE EXCEPTION 'Job No. "%" มีอยู่แล้ว', jno;
  END IF;
  IF trim(p_customer) = '' THEN RAISE EXCEPTION 'กรุณาระบุชื่อลูกค้า'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  IF (p_sale_price IS NOT NULL AND p_sale_price < 0) OR (p_cost IS NOT NULL AND p_cost < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  INSERT INTO jobs (job_no, customer_name, contact_phone, scope, install_location, required_date, lbs_qty_required, opened_by, budget_sale_price, budget_cost)
  VALUES (jno, trim(p_customer), NULLIF(trim(COALESCE(p_phone, '')), ''), p_scope, p_location, p_required_date, p_qty, actor.id, p_sale_price, p_cost) RETURNING id INTO jid;
  PERFORM app_audit('job', jid, 'create_job', actor.id,
    'เปิด ' || jno || ' ลูกค้า ' || trim(p_customer) || ' ต้องการ LBS ' || p_qty || ' เครื่อง');
  RETURN jid;
END $$;

-- แก้ Job: + เบอร์ติดต่อ (คงกติกา 0008: ห้ามลด Scope ต่ำกว่าที่ถือ + FOR UPDATE)
CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_cost NUMERIC DEFAULT NULL, p_phone TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; jno TEXT; held INT; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  PERFORM 1 FROM jobs WHERE id = p_job_id FOR UPDATE;
  jno := trim(p_job_no);
  IF jno = '' THEN RAISE EXCEPTION 'กรุณาระบุ Job No.'; END IF;
  IF EXISTS (SELECT 1 FROM jobs WHERE id <> p_job_id AND lower(job_no) = lower(jno)) THEN
    RAISE EXCEPTION 'Job No. "%" ซ้ำกับ Job อื่น', jno;
  END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  SELECT count(*) INTO held FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated';
  IF p_qty < held THEN
    RAISE EXCEPTION 'ลดจำนวนตาม Scope ต่ำกว่าที่ถืออยู่ (% เครื่อง) ไม่ได้ — คืน LBS กลับสต็อกก่อน', held;
  END IF;
  IF (p_sale_price IS NOT NULL AND p_sale_price < 0) OR (p_cost IS NOT NULL AND p_cost < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  before_status := app_job_status(p_job_id);
  UPDATE jobs SET job_no = jno, customer_name = trim(p_customer),
    contact_phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
    scope = p_scope, install_location = p_location,
    required_date = p_required_date, lbs_qty_required = p_qty,
    budget_sale_price = p_sale_price, budget_cost = p_cost, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_notify_if_ready(p_job_id, before_status);
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id,
    'แก้ไขข้อมูล ' || j.job_no || CASE WHEN jno <> j.job_no THEN ' (เปลี่ยนเลขเป็น ' || jno || ')' ELSE '' END);
END $$;
