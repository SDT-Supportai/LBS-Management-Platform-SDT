-- =====================================================================
-- 0006: Serial คู่ (LVB + OM), Project Budget, ราคาต่อวัสดุ, รหัส Epicor
--  รองรับฟีเจอร์ใหม่ (2026-07-14): แต่ละ LBS มี Serial.LVB + Serial.OM,
--  Job มีงบประมาณ (ราคาขาย/ต้นทุน/กำไร auto), วัสดุมีราคาต่อหน่วย → มูลค่าวัสดุ,
--  Accessory Catalog มีรหัส Epicor
--  รันหลัง 0001–0005 ได้เลย (idempotent เท่าที่เป็นไปได้)
-- =====================================================================

-- ---------- 1) Schema alterations ----------

-- items: รหัส Epicor (unique เมื่อไม่ null)
ALTER TABLE items ADD COLUMN IF NOT EXISTS epicor_code VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_epicor_code ON items (lower(epicor_code)) WHERE epicor_code IS NOT NULL;

-- jobs: Project Budget (กำไร derive = ราคาขาย − ต้นทุน ไม่เก็บซ้ำ)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_sale_price NUMERIC(14,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_cost       NUMERIC(14,2);

-- job_accessory_requests: ราคาต่อหน่วย → มูลค่าวัสดุ
ALTER TABLE job_accessory_requests ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14,2);

-- เติมรหัส Epicor ให้ seed items เดิม (ไม่ทับค่าที่มีอยู่)
UPDATE items SET epicor_code = 'EPC-CT-115' WHERE code = 'ACC-CT-01'  AND epicor_code IS NULL;
UPDATE items SET epicor_code = 'EPC-BRK-01' WHERE code = 'ACC-BRK-01' AND epicor_code IS NULL;
UPDATE items SET epicor_code = 'EPC-RLY-7SR' WHERE code = 'ACC-RLY-01' AND epicor_code IS NULL;
UPDATE items SET epicor_code = 'EPC-CBL-25' WHERE code = 'ACC-CBL-01' AND epicor_code IS NULL;

-- lbs_units: serial_no (เดี่ยว) → serial_lvb + serial_om (คู่, บังคับทั้งคู่, unique ทั้งคู่)
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'lbs_units' AND column_name = 'serial_no') THEN
    ALTER TABLE lbs_units RENAME COLUMN serial_no TO serial_lvb;
  END IF;
END $mig$;

ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS serial_om VARCHAR(100);
-- backfill ข้อมูลเดิม (ถ้ามี): seed 'LBSxx-nnn' → 'OMxx-nnn' อื่นๆ ต่อท้าย '·OM' กันชน
-- ปิด trigger trg_block_issued_edit ชั่วคราว — เป็นการเติม column ใหม่ ไม่ใช่แก้ allocation
-- (ถ้าไม่ปิด trigger จะบล็อกแถวของ Job ที่ issued/installed แล้ว)
ALTER TABLE lbs_units DISABLE TRIGGER trg_block_issued_edit;
UPDATE lbs_units
  SET serial_om = CASE WHEN serial_lvb ~ '^LBS' THEN regexp_replace(serial_lvb, '^LBS', 'OM')
                       ELSE serial_lvb || '·OM' END
  WHERE serial_om IS NULL;
ALTER TABLE lbs_units ENABLE TRIGGER trg_block_issued_edit;
ALTER TABLE lbs_units ALTER COLUMN serial_om SET NOT NULL;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_lbs_units_serial_om') THEN
    ALTER TABLE lbs_units ADD CONSTRAINT uq_lbs_units_serial_om UNIQUE (serial_om);
  END IF;
END $mig$;

-- ---------- 2) ยกเลิก signature เดิม (เปลี่ยน type/เพิ่ม param → กัน overload กำกวมใน PostgREST) ----------
DROP FUNCTION IF EXISTS rpc_create_project_stock(TEXT, UUID, TEXT[], TEXT);
DROP FUNCTION IF EXISTS rpc_add_units_to_stock(UUID, TEXT[]);
DROP FUNCTION IF EXISTS rpc_create_job(TEXT, TEXT, TEXT, DATE, INT);
DROP FUNCTION IF EXISTS rpc_update_job(UUID, TEXT, TEXT, TEXT, DATE, INT);
DROP FUNCTION IF EXISTS rpc_add_accessory_request(UUID, UUID, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS rpc_create_item(TEXT, TEXT, TEXT, BOOLEAN, NUMERIC);
DROP FUNCTION IF EXISTS rpc_update_item(UUID, TEXT, TEXT, TEXT, BOOLEAN);

-- ---------- 3) RPC ใหม่ / ปรับปรุง ----------

-- Project Stock: รับ units เป็น jsonb array [{lvb, om}, ...]
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
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id) VALUES (lvb, om, p_stock_id);
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'add_units', actor.id,
    'รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง');
END $$;

-- ดึง/คืน LBS: allocation.serial_nos เก็บ serial_lvb (primary identifier)
CREATE OR REPLACE FUNCTION rpc_draw_lbs(p_job_id UUID, p_stock_id UUID, p_unit_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; s project_stocks; updated INT; serials TEXT[]; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  IF s.status = 'closed' THEN RAISE EXCEPTION '% ถูกปิดคลังแล้ว ดึงเพิ่มไม่ได้', s.stock_no; END IF;
  IF array_length(p_unit_ids, 1) IS NULL THEN RAISE EXCEPTION 'กรุณาเลือก Serial No. ที่จะดึง'; END IF;
  before_status := app_job_status(p_job_id);

  WITH upd AS (
    UPDATE lbs_units SET status = 'allocated', job_id = p_job_id, updated_at = now()
    WHERE id = ANY(p_unit_ids) AND project_stock_id = p_stock_id AND status = 'in_stock'
    RETURNING serial_lvb
  )
  SELECT count(*), array_agg(serial_lvb) INTO updated, serials FROM upd;

  IF updated <> array_length(p_unit_ids, 1) THEN
    RAISE EXCEPTION 'มีเครื่องที่ไม่อยู่ในสต็อกนี้หรือถูกดึงไปแล้ว — ห้ามดึงเกินยอดคงเหลือ';
  END IF;

  INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by)
  VALUES (p_job_id, p_stock_id, 'draw', serials, actor.id);
  PERFORM app_notify_if_ready(p_job_id, before_status);
  PERFORM app_audit('stock_allocation', p_job_id, 'draw_lbs', actor.id,
    j.job_no || ' ดึง LBS ' || updated || ' เครื่องจาก ' || s.stock_no || ' (SN: ' || array_to_string(serials, ', ') || ')');
END $$;

CREATE OR REPLACE FUNCTION rpc_return_lbs(p_job_id UUID, p_unit_ids UUID[], p_target_stock_id UUID, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; t project_stocks; updated INT; serials TEXT[];
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  SELECT * INTO t FROM project_stocks WHERE id = p_target_stock_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'กรุณาเลือก Stock No. ปลายทางที่จะคืน'; END IF;
  IF array_length(p_unit_ids, 1) IS NULL THEN RAISE EXCEPTION 'กรุณาเลือก Serial No. ที่จะคืน'; END IF;

  WITH upd AS (
    UPDATE lbs_units SET status = 'in_stock', job_id = NULL, project_stock_id = p_target_stock_id, updated_at = now()
    WHERE id = ANY(p_unit_ids) AND job_id = p_job_id AND status = 'allocated'
    RETURNING serial_lvb
  )
  SELECT count(*), array_agg(serial_lvb) INTO updated, serials FROM upd;

  IF updated <> array_length(p_unit_ids, 1) THEN
    RAISE EXCEPTION 'มีเครื่องที่ไม่ได้ถูกดึงเข้า Job นี้';
  END IF;

  INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by, reference_note)
  VALUES (p_job_id, p_target_stock_id, 'return', serials, actor.id, p_note);
  PERFORM app_audit('stock_allocation', p_job_id, 'return_lbs', actor.id,
    j.job_no || ' คืน LBS ' || updated || ' เครื่องเข้า ' || t.stock_no || ' (SN: ' || array_to_string(serials, ', ') || ')');
END $$;

-- Jobs: + งบประมาณ
CREATE OR REPLACE FUNCTION rpc_create_job(p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_cost NUMERIC DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; jid UUID; jno TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  IF trim(p_customer) = '' THEN RAISE EXCEPTION 'กรุณาระบุชื่อลูกค้า'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  IF (p_sale_price IS NOT NULL AND p_sale_price < 0) OR (p_cost IS NOT NULL AND p_cost < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  jno := app_next_no('JOB', ARRAY(SELECT job_no FROM jobs));
  INSERT INTO jobs (job_no, customer_name, scope, install_location, required_date, lbs_qty_required, opened_by, budget_sale_price, budget_cost)
  VALUES (jno, trim(p_customer), p_scope, p_location, p_required_date, p_qty, actor.id, p_sale_price, p_cost) RETURNING id INTO jid;
  PERFORM app_audit('job', jid, 'create_job', actor.id,
    'เปิด ' || jno || ' ลูกค้า ' || trim(p_customer) || ' ต้องการ LBS ' || p_qty || ' เครื่อง');
  RETURN jid;
END $$;

CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_cost NUMERIC DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  IF (p_sale_price IS NOT NULL AND p_sale_price < 0) OR (p_cost IS NOT NULL AND p_cost < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  before_status := app_job_status(p_job_id);
  UPDATE jobs SET customer_name = trim(p_customer), scope = p_scope, install_location = p_location,
    required_date = p_required_date, lbs_qty_required = p_qty,
    budget_sale_price = p_sale_price, budget_cost = p_cost, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_notify_if_ready(p_job_id, before_status);
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id, 'แก้ไขข้อมูล ' || j.job_no);
END $$;

-- Accessory / Purchase Orders: + ราคาต่อหน่วย
CREATE OR REPLACE FUNCTION rpc_add_accessory_request(p_job_id UUID, p_item_id UUID, p_qty NUMERIC, p_source TEXT,
                                                     p_unit_price NUMERIC DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; it items; onhand NUMERIC; rid UUID; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Accessory'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวนต้องอย่างน้อย 1'; END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN RAISE EXCEPTION 'ราคาต่อหน่วยติดลบไม่ได้'; END IF;
  before_status := app_job_status(p_job_id);

  IF p_source = 'central_stock' THEN
    IF NOT it.is_stockable_centrally THEN
      RAISE EXCEPTION '% ไม่มีในสต็อกกลาง ต้องสั่งซื้อผ่าน Purchasing', it.name;
    END IF;
    UPDATE accessory_stock SET qty_on_hand = qty_on_hand - p_qty, updated_at = now()
    WHERE item_id = p_item_id AND qty_on_hand >= p_qty;
    IF NOT FOUND THEN
      SELECT COALESCE(qty_on_hand, 0) INTO onhand FROM accessory_stock WHERE item_id = p_item_id;
      RAISE EXCEPTION 'สต็อกกลาง % คงเหลือ % % ไม่พอ (ขอ %) — เปลี่ยนเป็นสั่งซื้อผ่าน Purchasing ได้',
        it.name, COALESCE(onhand, 0), it.uom, p_qty;
    END IF;
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, p_unit_price, 'central_stock', 'issued', actor.id) RETURNING id INTO rid;
    PERFORM app_notify_if_ready(p_job_id, before_status);
    PERFORM app_audit('job_accessory_request', rid, 'issue_accessory_from_stock', actor.id,
      j.job_no || ' เบิก ' || it.name || ' ' || p_qty || ' ' || it.uom || ' จากสต็อกกลาง');
  ELSE
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, p_unit_price, 'purchasing', 'pending', actor.id) RETURNING id INTO rid;
    PERFORM app_audit('job_accessory_request', rid, 'request_accessory_purchase', actor.id,
      j.job_no || ' ขอซื้อ ' || it.name || ' ' || p_qty || ' ' || it.uom || ' (รอออก PR)');
  END IF;
END $$;

-- แก้ราคาต่อหน่วย (ทุกรายการที่ยัง active)
CREATE OR REPLACE FUNCTION rpc_update_accessory_request_price(p_request_id UUID, p_unit_price NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  j := app_assert_job_editable(r.job_id);
  IF r.status IN ('cancelled', 'returned') THEN RAISE EXCEPTION 'แก้ราคาได้เฉพาะรายการที่ยังใช้งานอยู่'; END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN RAISE EXCEPTION 'ราคาต่อหน่วยติดลบไม่ได้'; END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  UPDATE job_accessory_requests SET unit_price = p_unit_price, updated_at = now() WHERE id = p_request_id;
  PERFORM app_audit('job_accessory_request', p_request_id, 'update_accessory_price', actor.id,
    j.job_no || ' แก้ราคา ' || it.name || ' เป็น ' || COALESCE(p_unit_price, 0) || ' บาท/' || it.uom);
END $$;

-- Master Data items: + รหัส Epicor
CREATE OR REPLACE FUNCTION rpc_create_item(p_code TEXT, p_epicor_code TEXT, p_name TEXT, p_uom TEXT, p_stockable BOOLEAN, p_initial_qty NUMERIC)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; iid UUID; ep TEXT;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);  -- admin เท่านั้น
  ep := NULLIF(trim(COALESCE(p_epicor_code, '')), '');
  IF trim(p_code) = '' OR trim(p_name) = '' THEN RAISE EXCEPTION 'กรุณาระบุรหัสและชื่อ Accessory'; END IF;
  IF EXISTS (SELECT 1 FROM items WHERE lower(code) = lower(trim(p_code))) THEN
    RAISE EXCEPTION 'รหัส "%" มีอยู่แล้ว', trim(p_code);
  END IF;
  IF ep IS NOT NULL AND EXISTS (SELECT 1 FROM items WHERE lower(epicor_code) = lower(ep)) THEN
    RAISE EXCEPTION 'รหัส Epicor "%" มีอยู่แล้ว', ep;
  END IF;
  INSERT INTO items (code, epicor_code, name, item_type, uom, is_stockable_centrally)
  VALUES (trim(p_code), ep, trim(p_name), 'accessory', COALESCE(NULLIF(trim(p_uom), ''), 'ชิ้น'), p_stockable)
  RETURNING id INTO iid;
  IF p_stockable THEN
    INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (iid, GREATEST(0, COALESCE(p_initial_qty, 0)));
  END IF;
  PERFORM app_audit('item', iid, 'create_item', actor.id,
    'เพิ่ม Accessory ' || trim(p_name) || ' (' || trim(p_code) || ')');
  RETURN iid;
END $$;

CREATE OR REPLACE FUNCTION rpc_update_item(p_item_id UUID, p_code TEXT, p_epicor_code TEXT, p_name TEXT, p_uom TEXT, p_stockable BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; it items; onhand NUMERIC; ep TEXT;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);
  ep := NULLIF(trim(COALESCE(p_epicor_code, '')), '');
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการ'; END IF;
  IF it.item_type = 'main_equipment' THEN RAISE EXCEPTION 'แก้ไข LBS หลักไม่ได้จากหน้านี้'; END IF;
  IF EXISTS (SELECT 1 FROM items WHERE id <> p_item_id AND lower(code) = lower(trim(p_code))) THEN
    RAISE EXCEPTION 'รหัส "%" ซ้ำกับรายการอื่น', trim(p_code);
  END IF;
  IF ep IS NOT NULL AND EXISTS (SELECT 1 FROM items WHERE id <> p_item_id AND lower(epicor_code) = lower(ep)) THEN
    RAISE EXCEPTION 'รหัส Epicor "%" ซ้ำกับรายการอื่น', ep;
  END IF;
  SELECT COALESCE(qty_on_hand, 0) INTO onhand FROM accessory_stock WHERE item_id = p_item_id;
  IF NOT p_stockable AND COALESCE(onhand, 0) > 0 THEN
    RAISE EXCEPTION 'ยังมีของในสต็อกกลาง % % — ปรับยอดเป็น 0 ก่อนจึงจะปิดการเก็บสต็อกกลางได้', onhand, it.uom;
  END IF;
  UPDATE items SET code = trim(p_code), epicor_code = ep, name = trim(p_name),
    uom = COALESCE(NULLIF(trim(p_uom), ''), uom), is_stockable_centrally = p_stockable
  WHERE id = p_item_id;
  IF p_stockable THEN
    INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (p_item_id, 0) ON CONFLICT (item_id) DO NOTHING;
  END IF;
  PERFORM app_audit('item', p_item_id, 'update_item', actor.id, 'แก้ไข Accessory ' || trim(p_name) || ' (' || trim(p_code) || ')');
END $$;
