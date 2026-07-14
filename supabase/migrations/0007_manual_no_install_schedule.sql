-- =====================================================================
-- 0007: เลขเอกสารกรอกเอง + cap ดึง LBS ตาม Scope + นัดติดตั้งตอนเบิก (2026-07-14)
--  1) Job No. / PO No. ผู้ใช้กรอกเองทุกครั้ง (unique, Job No. แก้ได้ก่อนเบิก)
--  2) ดึง LBS รวมได้ไม่เกิน lbs_qty_required ของ Job
--  3) เบิกให้ Service ต้องระบุนัดติดตั้งจริง Start–End + Location (เก็บแยกจากแผนเดิม)
--  รันหลัง 0006 (idempotent เท่าที่เป็นไปได้)
-- =====================================================================

-- ---------- 1) Schema ----------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS install_start_date DATE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS install_end_date   DATE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS issue_location     TEXT;

-- ---------- 2) ยกเลิก signature เดิม (กัน overload กำกวมใน PostgREST) ----------
DROP FUNCTION IF EXISTS rpc_create_job(TEXT, TEXT, TEXT, DATE, INT, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS rpc_update_job(UUID, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS rpc_create_po(UUID, TEXT, DATE);
DROP FUNCTION IF EXISTS rpc_issue_job(UUID, TEXT);

-- ---------- 3) RPC ----------

-- เปิด Job: กรอก Job No. เอง (unique, case-insensitive)
CREATE OR REPLACE FUNCTION rpc_create_job(p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_cost NUMERIC DEFAULT NULL)
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
  INSERT INTO jobs (job_no, customer_name, scope, install_location, required_date, lbs_qty_required, opened_by, budget_sale_price, budget_cost)
  VALUES (jno, trim(p_customer), p_scope, p_location, p_required_date, p_qty, actor.id, p_sale_price, p_cost) RETURNING id INTO jid;
  PERFORM app_audit('job', jid, 'create_job', actor.id,
    'เปิด ' || jno || ' ลูกค้า ' || trim(p_customer) || ' ต้องการ LBS ' || p_qty || ' เครื่อง');
  RETURN jid;
END $$;

-- แก้ Job: Job No. แก้ได้ก่อนเบิก (app_assert_job_editable บล็อก issued/installed/cancelled อยู่แล้ว)
CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_cost NUMERIC DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; jno TEXT; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  jno := trim(p_job_no);
  IF jno = '' THEN RAISE EXCEPTION 'กรุณาระบุ Job No.'; END IF;
  IF EXISTS (SELECT 1 FROM jobs WHERE id <> p_job_id AND lower(job_no) = lower(jno)) THEN
    RAISE EXCEPTION 'Job No. "%" ซ้ำกับ Job อื่น', jno;
  END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
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

-- ดึง LBS: เพิ่ม cap ตาม Scope (ดึงรวมห้ามเกิน lbs_qty_required — คืนแล้วดึงใหม่ได้)
CREATE OR REPLACE FUNCTION rpc_draw_lbs(p_job_id UUID, p_stock_id UUID, p_unit_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; s project_stocks; held INT; updated INT; serials TEXT[]; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
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

-- ออก PO: กรอก PO No. เอง (unique)
CREATE OR REPLACE FUNCTION rpc_create_po(p_pr_id UUID, p_po_no TEXT, p_supplier TEXT, p_expected_date DATE)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pr purchase_requisitions; j jobs; poid UUID; pono TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO pr FROM purchase_requisitions WHERE id = p_pr_id;
  IF pr.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PR'; END IF;
  IF pr.status <> 'pending' THEN RAISE EXCEPTION '% ออก PO ไปแล้ว ถูกตีกลับ หรือถูกยกเลิก', pr.pr_no; END IF;
  pono := trim(p_po_no);
  IF pono = '' THEN RAISE EXCEPTION 'กรุณาระบุ PO No.'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_orders WHERE lower(po_no) = lower(pono)) THEN
    RAISE EXCEPTION 'PO No. "%" มีอยู่แล้ว', pono;
  END IF;
  IF trim(p_supplier) = '' THEN RAISE EXCEPTION 'กรุณาระบุ Supplier'; END IF;
  SELECT * INTO j FROM jobs WHERE id = pr.job_id;

  INSERT INTO purchase_orders (po_no, pr_id, job_id, supplier_name, expected_date, created_by)
  VALUES (pono, p_pr_id, pr.job_id, trim(p_supplier), p_expected_date, actor.id) RETURNING id INTO poid;
  UPDATE purchase_requisitions SET status = 'po_issued' WHERE id = p_pr_id;
  UPDATE job_accessory_requests SET status = 'po_ordered', updated_at = now() WHERE pr_id = p_pr_id AND status = 'pr_sent';

  PERFORM app_notify('po_created',
    '🛒 ' || pono || ' ออกแล้วจาก ' || pr.pr_no || ' (' || j.job_no || ') Supplier: ' || trim(p_supplier)
    || ' กำหนดส่ง ' || COALESCE(p_expected_date::TEXT, 'ไม่ระบุ'),
    'project', pr.job_id);
  PERFORM app_audit('purchase_order', poid, 'create_po', actor.id,
    'ออก ' || pono || ' จาก ' || pr.pr_no || ' (' || j.job_no || ') Supplier: ' || trim(p_supplier) || ' — แจ้งสถานะกลับ Project Dept แล้ว');
  RETURN poid;
END $$;

-- เบิกให้ Service: ต้องระบุนัดติดตั้งจริง Start–End + Location
-- (คงลำดับจาก 0004: update units ก่อนตั้ง job=issued กัน trigger บล็อกตัวเอง)
CREATE OR REPLACE FUNCTION rpc_issue_job(p_job_id UUID, p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; cnt INT; range TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF app_job_status(p_job_id) <> 'ready_to_issue' THEN
    RAISE EXCEPTION '% ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ', j.job_no;
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)'; END IF;
  IF p_end_date < p_start_date THEN RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง'; END IF;
  IF trim(COALESCE(p_location, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)'; END IF;
  range := CASE WHEN p_start_date = p_end_date THEN p_start_date::TEXT ELSE p_start_date::TEXT || ' – ' || p_end_date::TEXT END;

  UPDATE lbs_units SET status = 'issued', updated_at = now() WHERE job_id = p_job_id AND status = 'allocated';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  UPDATE jobs SET terminal_status = 'issued', issued_at = now(), issued_note = p_note,
    install_start_date = p_start_date, install_end_date = p_end_date, issue_location = trim(p_location),
    updated_at = now()
  WHERE id = p_job_id;

  PERFORM app_notify('job_issued',
    '🚚 ' || j.job_no || ' (' || j.customer_name || ') เบิกของครบแล้ว — Service เข้าติดตั้งที่ '
    || trim(p_location) || ' กำหนด ' || range,
    'service', p_job_id);
  PERFORM app_audit('job', p_job_id, 'issue_to_service', actor.id,
    'เบิก ' || j.job_no || ' ให้ Service ติดตั้ง (LBS ' || cnt || ' เครื่อง) นัดติดตั้ง ' || range || ' ที่ ' || trim(p_location));
END $$;
