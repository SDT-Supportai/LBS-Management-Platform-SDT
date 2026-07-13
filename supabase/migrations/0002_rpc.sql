-- =====================================================================
-- 0002: Business logic เป็น RPC (SECURITY DEFINER) — rule ทุกข้ออยู่ฝั่ง server
-- กัน race condition ด้วย row-level UPDATE แบบ atomic + ตรวจสิทธิ์ตามแผนกทุกฟังก์ชัน
-- Error message เป็นภาษาไทย → supabase-js โยนเป็น error.message ให้ toast แสดงตรงๆ
-- =====================================================================

-- ---------- auto-create profile เมื่อมี auth user ใหม่ ----------
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE dept TEXT;
BEGIN
  -- bootstrap: ถ้ายังไม่มี admin ในระบบเลย → user คนแรกได้เป็น admin อัตโนมัติ
  -- (ตัดขั้นตอนตั้ง admin ด้วย SQL) คนถัดไปใช้ department จาก metadata หรือ 'service'
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE department = 'admin') THEN
    dept := 'admin';
  ELSE
    dept := COALESCE(NEW.raw_user_meta_data->>'department', 'service');
  END IF;

  INSERT INTO profiles (id, email, full_name, department)
  VALUES (
    NEW.id, NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    dept
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION app_assert_dept(allowed TEXT[]) RETURNS profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p profiles;
BEGIN
  SELECT * INTO p FROM profiles WHERE id = auth.uid();
  IF p.id IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบก่อน'; END IF;
  IF NOT p.is_active THEN RAISE EXCEPTION 'บัญชีนี้ถูกปิดการใช้งาน'; END IF;
  IF NOT (p.department = ANY(allowed) OR p.department = 'admin') THEN
    RAISE EXCEPTION 'แผนกของคุณไม่มีสิทธิ์ทำรายการนี้';
  END IF;
  RETURN p;
END $$;

CREATE OR REPLACE FUNCTION app_audit(etype TEXT, eid UUID, act TEXT, actor UUID, detail TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO audit_logs (entity_type, entity_id, action, actor_id, detail)
  VALUES (etype, eid, act, actor, detail);
$$;

CREATE OR REPLACE FUNCTION app_notify(ntype TEXT, msg TEXT, ndept TEXT, jid UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (type, message, dept, job_id, line_status)
  VALUES (ntype, msg, ndept, jid, 'pending');
$$;

CREATE OR REPLACE FUNCTION app_job_status(jid UUID) RETURNS TEXT
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT status FROM v_job_status WHERE job_id = jid;
$$;

-- แจ้ง Project เมื่อ Job ขยับเป็น ready_to_issue
CREATE OR REPLACE FUNCTION app_notify_if_ready(jid UUID, before_status TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  IF before_status <> 'ready_to_issue' AND app_job_status(jid) = 'ready_to_issue' THEN
    SELECT * INTO j FROM jobs WHERE id = jid;
    PERFORM app_notify('job_ready',
      '✅ ' || j.job_no || ' (' || j.customer_name || ') ของครบแล้ว — พร้อมเบิกให้ Service',
      'project', jid);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_next_no(prefix TEXT, col_values TEXT[]) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE yr TEXT := to_char(now(), 'YYYY'); mx INT := 0; v TEXT; m TEXT[];
BEGIN
  FOREACH v IN ARRAY col_values LOOP
    m := regexp_match(v, '^' || prefix || '-' || yr || '-(\d+)$');
    IF m IS NOT NULL AND m[1]::INT > mx THEN mx := m[1]::INT; END IF;
  END LOOP;
  RETURN prefix || '-' || yr || '-' || lpad((mx + 1)::TEXT, 4, '0');
END $$;

-- ---------- Project Stock (Sales) ----------
CREATE OR REPLACE FUNCTION rpc_create_project_stock(p_stock_no TEXT, p_item_id UUID, p_serials TEXT[], p_notes TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; sid UUID; sn TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(p_stock_no) = '' THEN RAISE EXCEPTION 'กรุณาระบุ Stock No.'; END IF;
  IF EXISTS (SELECT 1 FROM project_stocks WHERE stock_no = trim(p_stock_no)) THEN
    RAISE EXCEPTION 'Stock No. "%" มีอยู่แล้ว', trim(p_stock_no);
  END IF;
  IF array_length(p_serials, 1) IS NULL THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;

  INSERT INTO project_stocks (stock_no, item_id, notes, created_by)
  VALUES (trim(p_stock_no), p_item_id, p_notes, actor.id) RETURNING id INTO sid;

  FOREACH sn IN ARRAY p_serials LOOP
    sn := trim(sn);
    CONTINUE WHEN sn = '';
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_no = sn) THEN
      RAISE EXCEPTION 'Serial No. "%" มีอยู่ในระบบแล้ว', sn;
    END IF;
    INSERT INTO lbs_units (serial_no, project_stock_id) VALUES (sn, sid);
  END LOOP;

  PERFORM app_notify('stock_created',
    '📦 Sales รับ LBS เข้า ' || trim(p_stock_no) || ' จำนวน ' || array_length(p_serials, 1) || ' เครื่อง — พร้อมให้ดึงเข้า Job',
    'project', NULL);
  PERFORM app_audit('project_stock', sid, 'create_stock', actor.id,
    'สร้าง ' || trim(p_stock_no) || ' รับ LBS เข้า ' || array_length(p_serials, 1) || ' เครื่อง');
  RETURN sid;
END $$;

CREATE OR REPLACE FUNCTION rpc_add_units_to_stock(p_stock_id UUID, p_serials TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; sn TEXT; cnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  FOREACH sn IN ARRAY p_serials LOOP
    sn := trim(sn);
    CONTINUE WHEN sn = '';
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_no = sn) THEN
      RAISE EXCEPTION 'Serial No. "%" มีอยู่ในระบบแล้ว', sn;
    END IF;
    INSERT INTO lbs_units (serial_no, project_stock_id) VALUES (sn, p_stock_id);
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No.'; END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'add_units', actor.id,
    'รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง');
END $$;

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

-- ---------- Jobs (Project) ----------
CREATE OR REPLACE FUNCTION app_assert_job_editable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IN ('issued', 'installed') THEN
    RAISE EXCEPTION '% เบิกให้ Service แล้ว — ล็อก แก้ไข allocation ไม่ได้', j.job_no;
  END IF;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว แก้ไขไม่ได้', j.job_no;
  END IF;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION rpc_create_job(p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; jid UUID; jno TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  IF trim(p_customer) = '' THEN RAISE EXCEPTION 'กรุณาระบุชื่อลูกค้า'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  jno := app_next_no('JOB', ARRAY(SELECT job_no FROM jobs));
  INSERT INTO jobs (job_no, customer_name, scope, install_location, required_date, lbs_qty_required, opened_by)
  VALUES (jno, trim(p_customer), p_scope, p_location, p_required_date, p_qty, actor.id) RETURNING id INTO jid;
  PERFORM app_audit('job', jid, 'create_job', actor.id,
    'เปิด ' || jno || ' ลูกค้า ' || trim(p_customer) || ' ต้องการ LBS ' || p_qty || ' เครื่อง');
  RETURN jid;
END $$;

CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  before_status := app_job_status(p_job_id);
  UPDATE jobs SET customer_name = trim(p_customer), scope = p_scope, install_location = p_location,
    required_date = p_required_date, lbs_qty_required = p_qty, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_notify_if_ready(p_job_id, before_status);
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id, 'แก้ไขข้อมูล ' || j.job_no);
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_draft_job(p_job_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF EXISTS (SELECT 1 FROM stock_allocations WHERE job_id = p_job_id)
     OR EXISTS (SELECT 1 FROM job_accessory_requests WHERE job_id = p_job_id) THEN
    RAISE EXCEPTION '% มีประวัติ transaction แล้ว ลบไม่ได้ — ใช้ "ยกเลิก Job" แทนเพื่อคง audit trail', j.job_no;
  END IF;
  DELETE FROM jobs WHERE id = p_job_id;
  PERFORM app_audit('job', p_job_id, 'delete_draft_job', actor.id, 'ลบ ' || j.job_no || ' (Draft เปล่า ไม่มี transaction)');
END $$;

-- ดึง LBS: atomic UPDATE กัน race — แถวที่อัพเดทได้ต้องเท่ากับจำนวนที่ขอ
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
    RETURNING serial_no
  )
  SELECT count(*), array_agg(serial_no) INTO updated, serials FROM upd;

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
    RETURNING serial_no
  )
  SELECT count(*), array_agg(serial_no) INTO updated, serials FROM upd;

  IF updated <> array_length(p_unit_ids, 1) THEN
    RAISE EXCEPTION 'มีเครื่องที่ไม่ได้ถูกดึงเข้า Job นี้';
  END IF;

  INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by, reference_note)
  VALUES (p_job_id, p_target_stock_id, 'return', serials, actor.id, p_note);
  PERFORM app_audit('stock_allocation', p_job_id, 'return_lbs', actor.id,
    j.job_no || ' คืน LBS ' || updated || ' เครื่องเข้า ' || t.stock_no || ' (SN: ' || array_to_string(serials, ', ') || ')');
END $$;

-- ---------- Accessory ----------
CREATE OR REPLACE FUNCTION rpc_add_accessory_request(p_job_id UUID, p_item_id UUID, p_qty NUMERIC, p_source TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; it items; onhand NUMERIC; rid UUID; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Accessory'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวนต้องอย่างน้อย 1'; END IF;
  before_status := app_job_status(p_job_id);

  IF p_source = 'central_stock' THEN
    IF NOT it.is_stockable_centrally THEN
      RAISE EXCEPTION '% ไม่มีในสต็อกกลาง ต้องสั่งซื้อผ่าน Purchasing', it.name;
    END IF;
    -- atomic: หักได้เฉพาะเมื่อพอ
    UPDATE accessory_stock SET qty_on_hand = qty_on_hand - p_qty, updated_at = now()
    WHERE item_id = p_item_id AND qty_on_hand >= p_qty;
    IF NOT FOUND THEN
      SELECT COALESCE(qty_on_hand, 0) INTO onhand FROM accessory_stock WHERE item_id = p_item_id;
      RAISE EXCEPTION 'สต็อกกลาง % คงเหลือ % % ไม่พอ (ขอ %) — เปลี่ยนเป็นสั่งซื้อผ่าน Purchasing ได้',
        it.name, COALESCE(onhand, 0), it.uom, p_qty;
    END IF;
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, 'central_stock', 'issued', actor.id) RETURNING id INTO rid;
    PERFORM app_notify_if_ready(p_job_id, before_status);
    PERFORM app_audit('job_accessory_request', rid, 'issue_accessory_from_stock', actor.id,
      j.job_no || ' เบิก ' || it.name || ' ' || p_qty || ' ' || it.uom || ' จากสต็อกกลาง');
  ELSE
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, 'purchasing', 'pending', actor.id) RETURNING id INTO rid;
    PERFORM app_audit('job_accessory_request', rid, 'request_accessory_purchase', actor.id,
      j.job_no || ' ขอซื้อ ' || it.name || ' ' || p_qty || ' ' || it.uom || ' (รอออก PR)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rpc_update_accessory_request_qty(p_request_id UUID, p_qty NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการ Accessory'; END IF;
  j := app_assert_job_editable(r.job_id);
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'แก้จำนวนได้เฉพาะรายการที่ยังไม่ออก PR'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวนต้องอย่างน้อย 1'; END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  UPDATE job_accessory_requests SET qty_requested = p_qty, updated_at = now() WHERE id = p_request_id;
  PERFORM app_audit('job_accessory_request', p_request_id, 'update_accessory_qty', actor.id,
    j.job_no || ' แก้จำนวน ' || it.name || ': ' || r.qty_requested || ' → ' || p_qty || ' ' || it.uom);
END $$;

CREATE OR REPLACE FUNCTION rpc_return_accessory(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการ Accessory'; END IF;
  j := app_assert_job_editable(r.job_id);
  IF r.source <> 'central_stock' OR r.status <> 'issued' THEN
    RAISE EXCEPTION 'คืนได้เฉพาะรายการที่เบิกจากสต็อกกลางแล้วเท่านั้น';
  END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  UPDATE accessory_stock SET qty_on_hand = qty_on_hand + r.qty_requested, updated_at = now() WHERE item_id = r.item_id;
  UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = p_request_id;
  PERFORM app_audit('job_accessory_request', p_request_id, 'return_accessory', actor.id,
    j.job_no || ' คืน ' || it.name || ' ' || r.qty_requested || ' ' || it.uom || ' กลับสต็อกกลาง');
END $$;

CREATE OR REPLACE FUNCTION rpc_cancel_accessory_request(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items; before_status TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการ Accessory'; END IF;
  j := app_assert_job_editable(r.job_id);
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะรายการที่ยังไม่ส่ง PR — ถ้าออก PR/PO แล้วให้ประสาน Purchasing';
  END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  before_status := app_job_status(r.job_id);
  UPDATE job_accessory_requests SET status = 'cancelled', updated_at = now() WHERE id = p_request_id;
  PERFORM app_notify_if_ready(r.job_id, before_status);
  PERFORM app_audit('job_accessory_request', p_request_id, 'cancel_accessory_request', actor.id,
    j.job_no || ' ยกเลิกคำขอ ' || it.name || ' ' || r.qty_requested || ' ' || it.uom);
END $$;

-- ---------- PR / PO ----------
CREATE OR REPLACE FUNCTION rpc_create_pr(p_job_id UUID, p_request_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; prid UUID; prno TEXT; updated INT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF array_length(p_request_ids, 1) IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกรายการที่จะออก PR'; END IF;

  prno := app_next_no('PR', ARRAY(SELECT pr_no FROM purchase_requisitions));
  INSERT INTO purchase_requisitions (pr_no, job_id, created_by) VALUES (prno, p_job_id, actor.id) RETURNING id INTO prid;

  UPDATE job_accessory_requests SET status = 'pr_sent', pr_id = prid, updated_at = now()
  WHERE id = ANY(p_request_ids) AND job_id = p_job_id AND source = 'purchasing' AND status = 'pending';
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated <> array_length(p_request_ids, 1) THEN
    RAISE EXCEPTION 'เลือกได้เฉพาะรายการสั่งซื้อที่ยังไม่ออก PR';
  END IF;

  PERFORM app_notify('pr_created',
    '📄 ' || prno || ' จาก ' || j.job_no || ' (' || j.customer_name || ') รอออก PO — ' || updated || ' รายการ',
    'purchasing', p_job_id);
  PERFORM app_audit('purchase_requisition', prid, 'create_pr', actor.id,
    j.job_no || ' ออก ' || prno || ' ส่ง Purchasing (' || updated || ' รายการ)');
  RETURN prid;
END $$;

CREATE OR REPLACE FUNCTION rpc_reject_pr(p_pr_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pr purchase_requisitions; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO pr FROM purchase_requisitions WHERE id = p_pr_id;
  IF pr.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PR'; END IF;
  IF pr.status <> 'pending' THEN RAISE EXCEPTION '% ออก PO ไปแล้วหรือปิดไปแล้ว ตีกลับไม่ได้', pr.pr_no; END IF;
  IF trim(p_reason) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ตีกลับ'; END IF;
  SELECT * INTO j FROM jobs WHERE id = pr.job_id;

  UPDATE purchase_requisitions SET status = 'rejected', reject_reason = trim(p_reason), rejected_at = now() WHERE id = p_pr_id;
  UPDATE job_accessory_requests SET status = 'pending', pr_id = NULL, updated_at = now()
  WHERE pr_id = p_pr_id AND status = 'pr_sent';

  PERFORM app_notify('pr_rejected',
    '⛔ Purchasing ตีกลับ ' || pr.pr_no || ' (' || j.job_no || ') เหตุผล: ' || trim(p_reason) || ' — รายการเด้งกลับให้แก้ไข/ออก PR ใหม่',
    'project', pr.job_id);
  PERFORM app_audit('purchase_requisition', p_pr_id, 'reject_pr', actor.id,
    'ตีกลับ ' || pr.pr_no || ' (' || j.job_no || ') เหตุผล: ' || trim(p_reason));
END $$;

CREATE OR REPLACE FUNCTION rpc_create_po(p_pr_id UUID, p_supplier TEXT, p_expected_date DATE)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pr purchase_requisitions; j jobs; poid UUID; pono TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO pr FROM purchase_requisitions WHERE id = p_pr_id;
  IF pr.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PR'; END IF;
  IF pr.status <> 'pending' THEN RAISE EXCEPTION '% ออก PO ไปแล้ว ถูกตีกลับ หรือถูกยกเลิก', pr.pr_no; END IF;
  IF trim(p_supplier) = '' THEN RAISE EXCEPTION 'กรุณาระบุ Supplier'; END IF;
  SELECT * INTO j FROM jobs WHERE id = pr.job_id;

  pono := app_next_no('PO', ARRAY(SELECT po_no FROM purchase_orders));
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

-- Partial receive: receipts = [{"request_id": "...", "qty": 2}, ...]
CREATE OR REPLACE FUNCTION rpc_receive_po_items(p_po_id UUID, p_receipts JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; po purchase_orders; j jobs; rec JSONB; r job_accessory_requests; it items;
  qty NUMERIC; newqty NUMERIC; parts TEXT := ''; all_complete BOOLEAN; before_status TEXT; got_any BOOLEAN := false;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id;
  IF po.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PO'; END IF;
  IF po.status <> 'issued' THEN RAISE EXCEPTION '% รับของครบแล้วหรือถูกยกเลิก', po.po_no; END IF;
  SELECT * INTO j FROM jobs WHERE id = po.job_id;
  before_status := app_job_status(po.job_id);

  FOR rec IN SELECT * FROM jsonb_array_elements(p_receipts) LOOP
    qty := (rec->>'qty')::NUMERIC;
    CONTINUE WHEN qty IS NULL OR qty <= 0;
    SELECT * INTO r FROM job_accessory_requests WHERE id = (rec->>'request_id')::UUID AND pr_id = po.pr_id;
    IF r.id IS NULL THEN RAISE EXCEPTION 'มีรายการที่ไม่อยู่ใน PO นี้'; END IF;
    SELECT * INTO it FROM items WHERE id = r.item_id;
    IF qty > r.qty_requested - r.qty_received THEN
      RAISE EXCEPTION '% ค้างรับแค่ % % (กรอก %)', it.name, r.qty_requested - r.qty_received, it.uom, qty;
    END IF;
    newqty := r.qty_received + qty;
    UPDATE job_accessory_requests
       SET qty_received = newqty,
           status = CASE WHEN newqty >= qty_requested THEN 'received' ELSE 'po_ordered' END,
           updated_at = now()
     WHERE id = r.id;
    parts := parts || CASE WHEN parts = '' THEN '' ELSE ', ' END
      || it.name || ' ' || qty || ' ' || it.uom
      || CASE WHEN newqty >= r.qty_requested THEN ' (ครบ)' ELSE ' (รวม ' || newqty || '/' || r.qty_requested || ')' END;
    got_any := true;
  END LOOP;
  IF NOT got_any THEN RAISE EXCEPTION 'กรุณาระบุจำนวนที่รับอย่างน้อย 1 รายการ'; END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM job_accessory_requests
    WHERE pr_id = po.pr_id AND status NOT IN ('received', 'cancelled', 'returned')
  ) INTO all_complete;

  IF all_complete THEN
    UPDATE purchase_orders SET status = 'received', received_at = now() WHERE id = p_po_id;
    UPDATE purchase_requisitions SET status = 'received' WHERE id = po.pr_id;
    PERFORM app_notify('po_received', '📬 ' || po.po_no || ' (' || j.job_no || ') รับของครบทุกรายการแล้ว', 'project', po.job_id);
  ELSE
    PERFORM app_notify('po_received', '📬 ' || po.po_no || ' (' || j.job_no || ') รับของบางส่วน: ' || parts, 'project', po.job_id);
  END IF;
  PERFORM app_notify_if_ready(po.job_id, before_status);
  PERFORM app_audit('purchase_order', p_po_id,
    CASE WHEN all_complete THEN 'receive_po_complete' ELSE 'receive_po_partial' END, actor.id,
    po.po_no || ' (' || j.job_no || ') รับของ' || CASE WHEN all_complete THEN 'ครบ' ELSE 'บางส่วน' END || ': ' || parts);
END $$;

-- ---------- Issue / Install / Cancel ----------
CREATE OR REPLACE FUNCTION rpc_issue_job(p_job_id UUID, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; cnt INT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF app_job_status(p_job_id) <> 'ready_to_issue' THEN
    RAISE EXCEPTION '% ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ', j.job_no;
  END IF;
  -- ต้อง update units เป็น 'issued' ก่อนตั้ง job เป็น terminal
  -- ไม่งั้น trigger trg_block_issued_edit จะเห็นว่า job issued แล้ว แล้วบล็อกการ update unit ของตัวเอง
  UPDATE lbs_units SET status = 'issued', updated_at = now() WHERE job_id = p_job_id AND status = 'allocated';
  GET DIAGNOSTICS cnt = ROW_COUNT;
  UPDATE jobs SET terminal_status = 'issued', issued_at = now(), issued_note = p_note, updated_at = now() WHERE id = p_job_id;
  PERFORM app_notify('job_issued',
    '🚚 ' || j.job_no || ' (' || j.customer_name || ') เบิกของครบแล้ว — Service เข้าติดตั้งที่ '
    || COALESCE(j.install_location, '-') || ' กำหนด ' || COALESCE(j.required_date::TEXT, '-'),
    'service', p_job_id);
  PERFORM app_audit('job', p_job_id, 'issue_to_service', actor.id,
    'เบิก ' || j.job_no || ' ให้ Service ติดตั้ง (LBS ' || cnt || ' เครื่อง) สถานที่: ' || COALESCE(j.install_location, '-'));
END $$;

CREATE OR REPLACE FUNCTION rpc_confirm_install(p_job_id UUID, p_installed_date DATE, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'ยืนยันติดตั้งได้เฉพาะงานที่เบิกแล้ว (Issued) — % อยู่สถานะอื่น', j.job_no;
  END IF;
  IF p_installed_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันที่ติดตั้งจริง'; END IF;
  UPDATE jobs SET terminal_status = 'installed', installed_at = p_installed_date,
    install_note = p_note, install_confirmed_by = actor.id, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_notify('job_installed',
    '🏁 ' || j.job_no || ' (' || j.customer_name || ') ติดตั้งเสร็จเมื่อ ' || p_installed_date || ' — ยืนยันโดย ' || actor.full_name,
    'project', p_job_id);
  PERFORM app_audit('job', p_job_id, 'confirm_install', actor.id,
    j.job_no || ' ติดตั้งเสร็จ วันที่จริง ' || p_installed_date || COALESCE(' — ' || NULLIF(p_note, ''), ''));
END $$;

CREATE OR REPLACE FUNCTION rpc_cancel_job(p_job_id UUID, p_reason TEXT, p_received_to_central BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; returned INT := 0; stock RECORD; r RECORD;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF trim(p_reason) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการยกเลิก'; END IF;

  -- 1) คืน LBS กลับ stock เดิม (unit ผูก stock ที่ดึงมาอยู่แล้ว) + ลง allocation record ราย stock
  FOR stock IN
    SELECT project_stock_id, array_agg(serial_no) AS serials, count(*) AS cnt
    FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated'
    GROUP BY project_stock_id
  LOOP
    INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by, reference_note)
    VALUES (p_job_id, stock.project_stock_id, 'return', stock.serials, actor.id, 'auto-return จากการยกเลิก Job');
    returned := returned + stock.cnt;
  END LOOP;
  UPDATE lbs_units SET status = 'in_stock', job_id = NULL, updated_at = now()
  WHERE job_id = p_job_id AND status = 'allocated';

  -- 2) Accessory: คืนสต็อกกลาง / ยกเลิกที่ค้าง / รับแล้วจาก PO → เข้าสต็อกกลางตามที่เลือก
  FOR r IN SELECT * FROM job_accessory_requests WHERE job_id = p_job_id LOOP
    IF r.source = 'central_stock' AND r.status = 'issued' THEN
      UPDATE accessory_stock SET qty_on_hand = qty_on_hand + r.qty_requested, updated_at = now() WHERE item_id = r.item_id;
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    ELSIF r.status IN ('pending', 'pr_sent', 'po_ordered') THEN
      UPDATE job_accessory_requests SET status = 'cancelled', updated_at = now() WHERE id = r.id;
    ELSIF r.status = 'received' AND p_received_to_central THEN
      INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, r.qty_received)
      ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  -- 3) ปิด PR/PO ที่ค้าง
  UPDATE purchase_requisitions SET status = 'cancelled' WHERE job_id = p_job_id AND status IN ('pending', 'po_issued');
  UPDATE purchase_orders SET status = 'cancelled' WHERE job_id = p_job_id AND status = 'issued';

  UPDATE jobs SET terminal_status = 'cancelled', cancelled_at = now(), cancelled_by = actor.id,
    cancel_reason = trim(p_reason), updated_at = now()
  WHERE id = p_job_id;

  PERFORM app_notify('job_cancelled',
    '❌ ยกเลิก ' || j.job_no || ' (' || j.customer_name || ') เหตุผล: ' || trim(p_reason)
    || ' — คืน LBS ' || returned || ' เครื่อง + Accessory กลับสต็อกอัตโนมัติ',
    'all', p_job_id);
  PERFORM app_audit('job', p_job_id, 'cancel_job', actor.id,
    'ยกเลิก ' || j.job_no || ' (' || trim(p_reason) || ') — คืน LBS ' || returned || ' เครื่องกลับสต็อกเดิม');
END $$;

-- ---------- Master Data ----------
CREATE OR REPLACE FUNCTION rpc_create_item(p_code TEXT, p_name TEXT, p_uom TEXT, p_stockable BOOLEAN, p_initial_qty NUMERIC)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; iid UUID;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);  -- admin เท่านั้น
  IF trim(p_code) = '' OR trim(p_name) = '' THEN RAISE EXCEPTION 'กรุณาระบุรหัสและชื่อ Accessory'; END IF;
  IF EXISTS (SELECT 1 FROM items WHERE lower(code) = lower(trim(p_code))) THEN
    RAISE EXCEPTION 'รหัส "%" มีอยู่แล้ว', trim(p_code);
  END IF;
  INSERT INTO items (code, name, item_type, uom, is_stockable_centrally)
  VALUES (trim(p_code), trim(p_name), 'accessory', COALESCE(NULLIF(trim(p_uom), ''), 'ชิ้น'), p_stockable)
  RETURNING id INTO iid;
  IF p_stockable THEN
    INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (iid, GREATEST(0, COALESCE(p_initial_qty, 0)));
  END IF;
  PERFORM app_audit('item', iid, 'create_item', actor.id,
    'เพิ่ม Accessory ' || trim(p_name) || ' (' || trim(p_code) || ')');
  RETURN iid;
END $$;

CREATE OR REPLACE FUNCTION rpc_update_item(p_item_id UUID, p_code TEXT, p_name TEXT, p_uom TEXT, p_stockable BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; it items; onhand NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการ'; END IF;
  IF it.item_type = 'main_equipment' THEN RAISE EXCEPTION 'แก้ไข LBS หลักไม่ได้จากหน้านี้'; END IF;
  IF EXISTS (SELECT 1 FROM items WHERE id <> p_item_id AND lower(code) = lower(trim(p_code))) THEN
    RAISE EXCEPTION 'รหัส "%" ซ้ำกับรายการอื่น', trim(p_code);
  END IF;
  SELECT COALESCE(qty_on_hand, 0) INTO onhand FROM accessory_stock WHERE item_id = p_item_id;
  IF NOT p_stockable AND COALESCE(onhand, 0) > 0 THEN
    RAISE EXCEPTION 'ยังมีของในสต็อกกลาง % % — ปรับยอดเป็น 0 ก่อนจึงจะปิดการเก็บสต็อกกลางได้', onhand, it.uom;
  END IF;
  UPDATE items SET code = trim(p_code), name = trim(p_name),
    uom = COALESCE(NULLIF(trim(p_uom), ''), uom), is_stockable_centrally = p_stockable
  WHERE id = p_item_id;
  IF p_stockable THEN
    INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (p_item_id, 0) ON CONFLICT (item_id) DO NOTHING;
  END IF;
  PERFORM app_audit('item', p_item_id, 'update_item', actor.id, 'แก้ไข Accessory ' || trim(p_name) || ' (' || trim(p_code) || ')');
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_item(p_item_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; it items;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการ'; END IF;
  IF it.item_type = 'main_equipment' THEN RAISE EXCEPTION 'ลบ LBS หลักไม่ได้'; END IF;
  IF EXISTS (SELECT 1 FROM job_accessory_requests WHERE item_id = p_item_id) THEN
    RAISE EXCEPTION '% ถูกใช้ใน Job แล้ว ลบไม่ได้ (คง audit trail)', it.name;
  END IF;
  IF (SELECT COALESCE(qty_on_hand, 0) FROM accessory_stock WHERE item_id = p_item_id) > 0 THEN
    RAISE EXCEPTION '% ยังมีของในสต็อกกลาง ลบไม่ได้', it.name;
  END IF;
  DELETE FROM accessory_stock WHERE item_id = p_item_id;
  DELETE FROM items WHERE id = p_item_id;
  PERFORM app_audit('item', p_item_id, 'delete_item', actor.id, 'ลบ Accessory ' || it.name || ' (' || it.code || ')');
END $$;

CREATE OR REPLACE FUNCTION rpc_adjust_accessory_stock(p_item_id UUID, p_new_qty NUMERIC, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; it items; oldqty NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL OR NOT it.is_stockable_centrally THEN RAISE EXCEPTION 'รายการนี้ไม่มีสต็อกกลาง'; END IF;
  IF p_new_qty IS NULL OR p_new_qty < 0 THEN RAISE EXCEPTION 'ยอดคงเหลือติดลบไม่ได้'; END IF;
  IF trim(COALESCE(p_note, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการปรับยอด (เพื่อ audit)'; END IF;
  SELECT COALESCE(qty_on_hand, 0) INTO oldqty FROM accessory_stock WHERE item_id = p_item_id;
  INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (p_item_id, p_new_qty)
  ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand, updated_at = now();
  PERFORM app_audit('accessory_stock', p_item_id, 'adjust_stock', actor.id,
    'ปรับยอดสต็อกกลาง ' || it.name || ': ' || COALESCE(oldqty, 0) || ' → ' || p_new_qty || ' ' || it.uom || ' (' || trim(p_note) || ')');
END $$;

-- แก้ profile (ชื่อ/แผนก/สถานะ) — การสร้าง user + เปลี่ยนรหัสผ่านทำผ่าน netlify function (service role)
CREATE OR REPLACE FUNCTION rpc_update_profile(p_user_id UUID, p_full_name TEXT, p_department TEXT, p_is_active BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; t profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);
  SELECT * INTO t FROM profiles WHERE id = p_user_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'ไม่พบผู้ใช้'; END IF;
  IF p_user_id = actor.id AND NOT p_is_active THEN RAISE EXCEPTION 'ปิดการใช้งานบัญชีตัวเองไม่ได้'; END IF;
  UPDATE profiles SET full_name = COALESCE(NULLIF(trim(p_full_name), ''), full_name),
    department = p_department, is_active = p_is_active
  WHERE id = p_user_id;
  PERFORM app_audit('user', p_user_id, 'update_user', actor.id,
    'แก้ไขผู้ใช้ ' || t.full_name || ' (แผนก ' || p_department || CASE WHEN NOT p_is_active THEN ', ปิดการใช้งาน' ELSE '' END || ')');
END $$;

-- ---------- Notifications ----------
CREATE OR REPLACE FUNCTION rpc_mark_notifications_read()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  SELECT * INTO actor FROM profiles WHERE id = auth.uid();
  IF actor.id IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบก่อน'; END IF;
  INSERT INTO notification_reads (notification_id, user_id)
  SELECT n.id, actor.id FROM notifications n
  WHERE (n.dept = 'all' OR n.dept = actor.department OR actor.department = 'admin')
  ON CONFLICT DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION rpc_set_notification_line_status(p_ids UUID[], p_status TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบก่อน'; END IF;
  IF p_status NOT IN ('off', 'sent', 'failed') THEN RAISE EXCEPTION 'สถานะไม่ถูกต้อง'; END IF;
  UPDATE notifications SET line_status = p_status WHERE id = ANY(p_ids) AND line_status = 'pending';
END $$;

-- ---------- Realtime: ให้ client refresh เมื่อแผนกอื่นทำรายการ ----------
-- idempotent: ข้ามตารางที่ถูก add เข้า publication ไปแล้ว (กัน migration ค้างตอนรันซ้ำ)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','lbs_units','project_stocks','stock_allocations',
    'accessory_stock','job_accessory_requests','purchase_requisitions','purchase_orders','notifications']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ---------- สิทธิ์เรียก RPC: เฉพาะผู้ login แล้ว ----------
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE 'rpc\_%' OR p.proname LIKE 'app\_%')
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.' || fn || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.' || fn || ' TO authenticated';
  END LOOP;
END $$;
