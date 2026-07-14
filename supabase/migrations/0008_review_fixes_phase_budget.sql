-- =====================================================================
-- 0008: Fix จาก code review + Phase Budget (2026-07-14)
--  Fix 1) rpc_update_job: ห้ามลด Scope ต่ำกว่าจำนวน LBS ที่ถืออยู่ (กัน cap bypass)
--  Fix 2) rpc_draw_lbs: lock แถว job (FOR UPDATE) กัน race ตอนเช็ค cap
--  Fix 3) rpc_create_project_stock / rpc_add_units_to_stock:
--         ห้าม Serial.LVB = Serial.OM ในเครื่องเดียวกัน (demo mode บล็อกอยู่แล้ว)
--  Feature) job_accessory_requests.phase_budget — รหัส Phase Budget ต่อรายการวัสดุ
--         + rpc_add_accessory_request รับ p_phase_budget (เปลี่ยน signature)
--  รันหลัง 0007 (idempotent เท่าที่เป็นไปได้)
-- =====================================================================

-- ---------- 1) Schema ----------
ALTER TABLE job_accessory_requests ADD COLUMN IF NOT EXISTS phase_budget VARCHAR(100);

-- ---------- 2) ยกเลิก signature เดิม (กัน overload กำกวมใน PostgREST) ----------
DROP FUNCTION IF EXISTS rpc_add_accessory_request(UUID, UUID, NUMERIC, TEXT, NUMERIC);

-- ---------- 3) RPC ----------

-- แก้ Job: เพิ่มเช็คห้ามลด Scope ต่ำกว่าจำนวนที่ถืออยู่ + lock แถว job กัน race
CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_cost NUMERIC DEFAULT NULL)
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
  UPDATE jobs SET job_no = jno, customer_name = trim(p_customer), scope = p_scope, install_location = p_location,
    required_date = p_required_date, lbs_qty_required = p_qty,
    budget_sale_price = p_sale_price, budget_cost = p_cost, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_notify_if_ready(p_job_id, before_status);
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id,
    'แก้ไขข้อมูล ' || j.job_no || CASE WHEN jno <> j.job_no THEN ' (เปลี่ยนเลขเป็น ' || jno || ')' ELSE '' END);
END $$;

-- ดึง LBS: lock แถว job ก่อนนับ held — กันสอง request พร้อมกันดึงเกิน Scope
CREATE OR REPLACE FUNCTION rpc_draw_lbs(p_job_id UUID, p_stock_id UUID, p_unit_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; s project_stocks; held INT; updated INT; serials TEXT[]; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  PERFORM 1 FROM jobs WHERE id = p_job_id FOR UPDATE;
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  IF s.status = 'closed' THEN RAISE EXCEPTION '% ถูกปิดคลังแล้ว ดึงเพิ่มไม่ได้', s.stock_no; END IF;
  IF array_length(p_unit_ids, 1) IS NULL THEN RAISE EXCEPTION 'กรุณาเลือก Serial No. ที่จะดึง'; END IF;

  SELECT count(*) INTO held FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated';
  IF held + array_length(p_unit_ids, 1) > j.lbs_qty_required THEN
    RAISE EXCEPTION 'ดึงเกินจำนวนตาม Scope ไม่ได้ — Scope % เครื่อง ถืออยู่ % เครื่อง (ดึงได้อีก %)',
      j.lbs_qty_required, held, j.lbs_qty_required - held;
  END IF;
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

-- Project Stock: เพิ่มเช็ค lvb <> om ภายในเครื่องเดียวกัน
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
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id) VALUES (lvb, om, p_stock_id);
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'add_units', actor.id,
    'รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง');
END $$;

-- Purchase Requisition: + รหัส Phase Budget ต่อรายการวัสดุ
CREATE OR REPLACE FUNCTION rpc_add_accessory_request(p_job_id UUID, p_item_id UUID, p_qty NUMERIC, p_source TEXT,
                                                     p_unit_price NUMERIC DEFAULT NULL, p_phase_budget TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; it items; onhand NUMERIC; rid UUID; ph TEXT; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Accessory'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวนต้องอย่างน้อย 1'; END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN RAISE EXCEPTION 'ราคาต่อหน่วยติดลบไม่ได้'; END IF;
  ph := NULLIF(trim(COALESCE(p_phase_budget, '')), '');
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
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, phase_budget, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, p_unit_price, ph, 'central_stock', 'issued', actor.id) RETURNING id INTO rid;
    PERFORM app_notify_if_ready(p_job_id, before_status);
    PERFORM app_audit('job_accessory_request', rid, 'issue_accessory_from_stock', actor.id,
      j.job_no || ' เบิก ' || it.name || ' ' || p_qty || ' ' || it.uom || ' จากสต็อกกลาง');
  ELSE
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, phase_budget, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, p_unit_price, ph, 'purchasing', 'pending', actor.id) RETURNING id INTO rid;
    PERFORM app_audit('job_accessory_request', rid, 'request_accessory_purchase', actor.id,
      j.job_no || ' ขอซื้อ ' || it.name || ' ' || p_qty || ' ' || it.uom || ' (รอออก PR)');
  END IF;
END $$;
