-- =====================================================================
-- 0028: สลับเลข Serial LBS (ต้องผ่าน Division อนุมัติ) (2026-07-24)
--  Project ขอสลับเลข Serial (LVB+OM เป็นคู่) ระหว่างเครื่องที่ดึงเข้า Job (allocated)
--  กับเครื่องว่างในคลัง (in_stock) ได้หลังดึง LBS จนถึงก่อนเบิกให้ Service —
--  ต้องให้ Division อนุมัติ (พร้อมเหตุผล) · Manage (admin) ทำตรงได้
--    - เครื่องไม่ย้าย/ไม่เปลี่ยนสถานะ-สังกัดคลัง แค่แลกคู่เลข (permutation)
--    - trg_block_issued_edit ไม่ขวาง เพราะสลับเฉพาะตอน Job ยังไม่ issued
--  โครงต่อจาก 0016: เพิ่ม type 'swap_lbs' ใน approval_requests + app_exec_swap_lbs
--    + rpc_swap_lbs (admin) + ต่อ rpc_request_approval / rpc_approve_request / rpc_reject_request
--  demo sync ที่ src/data/logic.ts (swapLbs) · รันหลัง 0027 (idempotent)
-- =====================================================================

-- ---------- 1) เปิด CHECK ให้รับ type ใหม่ ----------
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_req_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_req_type_check
  CHECK (req_type IN ('create_pr', 'issue_job', 'cancel_job', 'swap_lbs'));

-- ---------- 2) Core: สลับคู่ Serial ผ่านค่าชั่วคราว (กันชน unique ระหว่างขั้นตอน) ----------
CREATE OR REPLACE FUNCTION app_exec_swap_lbs(actor profiles, p_job_id UUID, p_allocated_unit_id UUID, p_stock_unit_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; a lbs_units; b lbs_units;
BEGIN
  j := app_assert_job_editable(p_job_id);   -- lock job + กันสลับหลัง issued/installed/cancelled
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการสลับ LBS'; END IF;
  SELECT * INTO a FROM lbs_units WHERE id = p_allocated_unit_id FOR UPDATE;
  IF a.id IS NULL OR a.job_id <> p_job_id OR a.status <> 'allocated' THEN
    RAISE EXCEPTION 'เครื่องต้นทางต้องเป็น LBS ที่ดึงเข้า Job นี้อยู่ (allocated)';
  END IF;
  SELECT * INTO b FROM lbs_units WHERE id = p_stock_unit_id FOR UPDATE;
  IF b.id IS NULL OR b.status <> 'in_stock' THEN
    RAISE EXCEPTION 'เครื่องที่จะสลับต้องเป็นเครื่องว่างในคลัง (in_stock)';
  END IF;
  IF a.id = b.id THEN RAISE EXCEPTION 'เลือกเครื่องสลับซ้ำกันไม่ได้'; END IF;

  UPDATE lbs_units SET serial_lvb = 'SWP-' || a.id || '-L', serial_om = 'SWP-' || a.id || '-O', updated_at = now() WHERE id = a.id;
  UPDATE lbs_units SET serial_lvb = a.serial_lvb, serial_om = a.serial_om, updated_at = now() WHERE id = b.id;
  UPDATE lbs_units SET serial_lvb = b.serial_lvb, serial_om = b.serial_om, updated_at = now() WHERE id = a.id;

  PERFORM app_audit('lbs_unit', a.id, 'swap_lbs_serial', actor.id,
    j.job_no || ' สลับ LBS: ' || a.serial_lvb || '/' || a.serial_om || ' ↔ ' || b.serial_lvb || '/' || b.serial_om
    || ' (คลัง) — เหตุผล: ' || trim(p_reason));
END $$;

-- rpc ตรง: admin เท่านั้น (project ใช้ rpc_request_approval)
CREATE OR REPLACE FUNCTION rpc_swap_lbs(p_job_id UUID, p_allocated_unit_id UUID, p_stock_unit_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);   -- admin เท่านั้น
  PERFORM app_exec_swap_lbs(actor, p_job_id, p_allocated_unit_id, p_stock_unit_id, p_reason);
END $$;

-- ---------- 3) ต่อ rpc_request_approval — validate swap_lbs ----------
CREATE OR REPLACE FUNCTION rpc_request_approval(p_type TEXT, p_job_id UUID, p_payload JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; rid UUID; cnt INT; ids UUID[]; type_label TEXT; ua lbs_units; ub lbs_units;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF p_type NOT IN ('create_pr', 'issue_job', 'cancel_job', 'swap_lbs') THEN RAISE EXCEPTION 'ประเภทคำขอไม่ถูกต้อง'; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE job_id = p_job_id AND req_type = p_type AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอประเภทนี้รอ Division อนุมัติอยู่แล้ว', j.job_no;
  END IF;

  IF p_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(COALESCE(p_payload->'request_ids', '[]'::jsonb)) x;
    IF ids IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกรายการที่จะออก PR'; END IF;
    SELECT count(*) INTO cnt FROM job_accessory_requests
    WHERE id = ANY(ids) AND job_id = p_job_id AND source = 'purchasing' AND status = 'pending';
    IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'เลือกได้เฉพาะรายการสั่งซื้อที่ยังไม่ออก PR'; END IF;
    type_label := 'ออก PR (' || array_length(ids, 1) || ' รายการ)';
  ELSIF p_type = 'issue_job' THEN
    IF app_job_status(p_job_id) <> 'ready_to_issue' THEN
      RAISE EXCEPTION '% ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ', j.job_no;
    END IF;
    IF (p_payload->>'start_date') IS NULL OR (p_payload->>'end_date') IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)';
    END IF;
    IF (p_payload->>'end_date')::DATE < (p_payload->>'start_date')::DATE THEN
      RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง';
    END IF;
    IF trim(COALESCE(p_payload->>'location', '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)'; END IF;
    type_label := 'เบิกให้ Service';
  ELSIF p_type = 'swap_lbs' THEN
    IF trim(COALESCE(p_payload->>'reason', '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการสลับ LBS'; END IF;
    SELECT * INTO ua FROM lbs_units WHERE id = (p_payload->>'swap_allocated_unit_id')::UUID;
    IF ua.id IS NULL OR ua.job_id <> p_job_id OR ua.status <> 'allocated' THEN
      RAISE EXCEPTION 'เครื่องต้นทางต้องเป็น LBS ที่ดึงเข้า Job นี้อยู่ (allocated)';
    END IF;
    SELECT * INTO ub FROM lbs_units WHERE id = (p_payload->>'swap_stock_unit_id')::UUID;
    IF ub.id IS NULL OR ub.status <> 'in_stock' THEN
      RAISE EXCEPTION 'เครื่องที่จะสลับต้องเป็นเครื่องว่างในคลัง (in_stock)';
    END IF;
    type_label := 'สลับ LBS';
  ELSE
    IF trim(COALESCE(p_payload->>'reason', '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการยกเลิก'; END IF;
    type_label := 'ยกเลิก Job';
  END IF;

  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES (p_type, p_job_id, COALESCE(p_payload, '{}'::jsonb), actor.id) RETURNING id INTO rid;

  PERFORM app_notify('approval_requested',
    '🔔 ' || j.job_no || ' (' || j.customer_name || ') ขออนุมัติ' || type_label || ' โดย ' || actor.full_name,
    'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id,
    j.job_no || ' ขออนุมัติ' || type_label);
  RETURN rid;
END $$;

-- ---------- 4) ต่อ rpc_approve_request — execute swap_lbs ----------
CREATE OR REPLACE FUNCTION rpc_approve_request(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; type_label TEXT; ids UUID[];
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  UPDATE approval_requests SET status = 'approved', decided_by = actor.id, decided_at = now()
  WHERE id = p_request_id;

  IF r.req_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(r.payload->'request_ids') x;
    PERFORM app_exec_create_pr(actor, r.job_id, ids);
    type_label := 'ออก PR';
  ELSIF r.req_type = 'issue_job' THEN
    PERFORM app_exec_issue_job(actor, r.job_id,
      (r.payload->>'start_date')::DATE, (r.payload->>'end_date')::DATE,
      r.payload->>'location', r.payload->>'note');
    type_label := 'เบิกให้ Service';
  ELSIF r.req_type = 'swap_lbs' THEN
    PERFORM app_exec_swap_lbs(actor, r.job_id,
      (r.payload->>'swap_allocated_unit_id')::UUID, (r.payload->>'swap_stock_unit_id')::UUID,
      r.payload->>'reason');
    type_label := 'สลับ LBS';
  ELSE
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  END IF;

  PERFORM app_notify('approval_approved',
    '✅ Division อนุมัติ' || type_label || ' ของ ' || j.job_no || ' แล้ว (โดย ' || actor.full_name || ')',
    'project', r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- ---------- 5) ต่อ rpc_reject_request — label swap_lbs ----------
CREATE OR REPLACE FUNCTION rpc_reject_request(p_request_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; type_label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ตีกลับ'; END IF;
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  type_label := CASE r.req_type WHEN 'create_pr' THEN 'ออก PR' WHEN 'issue_job' THEN 'เบิกให้ Service'
                                WHEN 'swap_lbs' THEN 'สลับ LBS' ELSE 'ยกเลิก Job' END;

  UPDATE approval_requests SET status = 'rejected', decided_by = actor.id, decided_at = now(),
    reject_reason = trim(p_reason)
  WHERE id = p_request_id;

  PERFORM app_notify('approval_rejected',
    '⛔ Division ตีกลับคำขอ' || type_label || ' ของ ' || j.job_no || ' — เหตุผล: ' || trim(p_reason),
    'project', r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'reject_request', actor.id,
    'ตีกลับคำขอ' || type_label || ' ของ ' || j.job_no || ' เหตุผล: ' || trim(p_reason));
END $$;

-- ---------- 6) สิทธิ์เรียก RPC ----------
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('rpc_swap_lbs', 'app_exec_swap_lbs', 'rpc_request_approval', 'rpc_approve_request', 'rpc_reject_request')
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.' || fn || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.' || fn || ' TO authenticated';
  END LOOP;
END $$;
