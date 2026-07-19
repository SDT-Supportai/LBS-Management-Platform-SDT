-- =====================================================================
-- 0016: Division approval flow (2026-07-19)
--  ข้อกำหนด: 3 action ของ project ต้องผ่านการอนุมัติจาก Division (dept ใน DB = 'sales')
--    1. ออก PR            → อนุมัติแล้วส่งถึง Purchasing
--    2. เบิกให้ Service    → อนุมัติแล้ว job = issued + แจ้ง Service
--    3. ยกเลิก Job         → อนุมัติแล้วคืนของ + job = cancelled
--  โมเดล "อนุมัติ = ทำงานทันที": project กรอกข้อมูลครบตอนขอ → division กด
--  อนุมัติแล้ว action execute ใน transaction เดียว (fail = rollback ทั้งคู่)
--  admin (แสดงผลเป็น "Manage") ข้ามขั้นอนุมัติได้ (เรียก RPC เดิมตรง) + อนุมัติแทน division ได้
--
--  โครงสร้าง:
--    - ตาราง approval_requests (payload JSONB ต่อ type) + RLS อ่านได้ทุกคน เขียนผ่าน RPC เท่านั้น
--    - แยก core logic เป็น app_exec_create_pr / app_exec_issue_job / app_exec_cancel_job
--    - rpc_create_pr / rpc_issue_job / rpc_cancel_job เปลี่ยนเป็น admin เท่านั้น (กัน project ยิงตรงข้ามขั้นอนุมัติ)
--    - rpc_request_approval (project) / rpc_approve_request / rpc_reject_request (division='sales' + admin)
--  demo mode แก้คู่กันที่ src/data/logic.ts · รันหลัง 0015 (idempotent)
-- =====================================================================

-- ---------- 1) Schema ----------
CREATE TABLE IF NOT EXISTS approval_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  req_type      TEXT NOT NULL CHECK (req_type IN ('create_pr', 'issue_job', 'cancel_job')),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by  UUID REFERENCES profiles(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    UUID REFERENCES profiles(id),
  decided_at    TIMESTAMPTZ,
  reject_reason TEXT
);
-- กันคำขอซ้ำ: pending ได้ทีละ 1 คำขอต่อ (job, type)
CREATE UNIQUE INDEX IF NOT EXISTS approval_pending_uq
  ON approval_requests (job_id, req_type) WHERE status = 'pending';

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON approval_requests;
CREATE POLICY read_all ON approval_requests FOR SELECT TO authenticated USING (true);
-- ไม่มี write policy — เขียนผ่าน RPC (SECURITY DEFINER) เท่านั้น

-- ---------- 2) Core logic (ไม่เช็คแผนก — ผู้เรียกเช็คเอง) ----------

-- จาก rpc_create_pr (0002) — เนื้อเดิมเป๊ะ แค่ตัด dept assert ออก
CREATE OR REPLACE FUNCTION app_exec_create_pr(actor profiles, p_job_id UUID, p_request_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; prid UUID; prno TEXT; updated INT;
BEGIN
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

-- จาก rpc_issue_job (0007)
CREATE OR REPLACE FUNCTION app_exec_issue_job(actor profiles, p_job_id UUID, p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; cnt INT; range TEXT;
BEGIN
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
    || trim(p_location) || ' กำหนด ' || range, 'service', p_job_id);
  PERFORM app_audit('job', p_job_id, 'issue_to_service', actor.id,
    'เบิก ' || j.job_no || ' ให้ Service ติดตั้ง (LBS ' || cnt || ' เครื่อง) นัดติดตั้ง ' || range || ' ที่ ' || trim(p_location));
END $$;

-- จาก rpc_cancel_job (0015 — รวม fix serial_lvb + partial receive แล้ว)
CREATE OR REPLACE FUNCTION app_exec_cancel_job(actor profiles, p_job_id UUID, p_reason TEXT, p_received_to_central BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; returned INT := 0; partial_cnt INT := 0; stock RECORD; r RECORD;
BEGIN
  j := app_assert_job_editable(p_job_id);
  IF trim(p_reason) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการยกเลิก'; END IF;

  FOR stock IN
    SELECT project_stock_id, array_agg(serial_lvb) AS serials, count(*) AS cnt
    FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated'
    GROUP BY project_stock_id
  LOOP
    INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by, reference_note)
    VALUES (p_job_id, stock.project_stock_id, 'return', stock.serials, actor.id, 'auto-return จากการยกเลิก Job');
    returned := returned + stock.cnt;
  END LOOP;
  UPDATE lbs_units SET status = 'in_stock', job_id = NULL, updated_at = now()
  WHERE job_id = p_job_id AND status = 'allocated';

  FOR r IN SELECT * FROM job_accessory_requests WHERE job_id = p_job_id LOOP
    IF r.source = 'central_stock' AND r.status = 'issued' THEN
      UPDATE accessory_stock SET qty_on_hand = qty_on_hand + r.qty_requested, updated_at = now() WHERE item_id = r.item_id;
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    ELSIF r.status = 'po_ordered' AND COALESCE(r.qty_received, 0) > 0 THEN
      IF p_received_to_central THEN
        INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, r.qty_received)
        ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
        UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
      ELSE
        UPDATE job_accessory_requests SET status = 'received', updated_at = now() WHERE id = r.id;
      END IF;
      partial_cnt := partial_cnt + 1;
    ELSIF r.status IN ('pending', 'pr_sent', 'po_ordered') THEN
      UPDATE job_accessory_requests SET status = 'cancelled', updated_at = now() WHERE id = r.id;
    ELSIF r.status = 'received' AND p_received_to_central THEN
      INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, r.qty_received)
      ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  UPDATE purchase_requisitions SET status = 'cancelled' WHERE job_id = p_job_id AND status IN ('pending', 'po_issued');
  UPDATE purchase_orders SET status = 'cancelled' WHERE job_id = p_job_id AND status = 'issued';

  UPDATE jobs SET terminal_status = 'cancelled', cancelled_at = now(), cancelled_by = actor.id,
    cancel_reason = trim(p_reason), updated_at = now()
  WHERE id = p_job_id;

  PERFORM app_notify('job_cancelled',
    '❌ ยกเลิก ' || j.job_no || ' (' || j.customer_name || ') เหตุผล: ' || trim(p_reason)
    || ' — คืน LBS ' || returned || ' เครื่อง + Accessory กลับสต็อกอัตโนมัติ'
    || CASE WHEN partial_cnt > 0
         THEN ' (วัสดุรับบางส่วน ' || partial_cnt || ' รายการ'
              || CASE WHEN p_received_to_central THEN ' คืนเข้าสต็อกกลางแล้ว)' ELSE ' คงไว้กับ Job พิจารณาเป็นเคส)' END
         ELSE '' END,
    'all', p_job_id);
  PERFORM app_audit('job', p_job_id, 'cancel_job', actor.id,
    'ยกเลิก ' || j.job_no || ' (' || trim(p_reason) || ') — คืน LBS ' || returned || ' เครื่องกลับสต็อกเดิม'
    || CASE WHEN partial_cnt > 0
         THEN ' + วัสดุรับบางส่วน ' || partial_cnt || ' รายการ'
              || CASE WHEN p_received_to_central THEN ' คืนเข้าสต็อกกลาง' ELSE ' (คงไว้กับ Job พิจารณาเป็นเคส)' END
         ELSE '' END);
END $$;

-- ---------- 3) RPC เดิม 3 ตัว → admin เท่านั้น (project ต้องผ่านขั้นอนุมัติ) ----------
-- คง RETURNS UUID ตามเดิม (CREATE OR REPLACE เปลี่ยน return type ไม่ได้)
CREATE OR REPLACE FUNCTION rpc_create_pr(p_job_id UUID, p_request_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);   -- admin เท่านั้น — project ใช้ rpc_request_approval
  RETURN app_exec_create_pr(actor, p_job_id, p_request_ids);
END $$;

CREATE OR REPLACE FUNCTION rpc_issue_job(p_job_id UUID, p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);
  PERFORM app_exec_issue_job(actor, p_job_id, p_start_date, p_end_date, p_location, p_note);
END $$;

CREATE OR REPLACE FUNCTION rpc_cancel_job(p_job_id UUID, p_reason TEXT, p_received_to_central BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);
  PERFORM app_exec_cancel_job(actor, p_job_id, p_reason, p_received_to_central);
END $$;

-- ---------- 4) ขอ/อนุมัติ/ตีกลับ ----------

CREATE OR REPLACE FUNCTION rpc_request_approval(p_type TEXT, p_job_id UUID, p_payload JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; rid UUID; cnt INT; ids UUID[]; type_label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);   -- lock job + เช็ค editable
  IF p_type NOT IN ('create_pr', 'issue_job', 'cancel_job') THEN RAISE EXCEPTION 'ประเภทคำขอไม่ถูกต้อง'; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE job_id = p_job_id AND req_type = p_type AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอประเภทนี้รอ Division อนุมัติอยู่แล้ว', j.job_no;
  END IF;

  -- validate ล่วงหน้าตาม type (validate เต็มอีกรอบตอน execute)
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

CREATE OR REPLACE FUNCTION rpc_approve_request(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; type_label TEXT; ids UUID[];
BEGIN
  actor := app_assert_dept(ARRAY['sales']);   -- Division (+admin)
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  UPDATE approval_requests SET status = 'approved', decided_by = actor.id, decided_at = now()
  WHERE id = p_request_id;

  -- execute ใน transaction เดียวกัน — ถ้า fail ทั้งคำขอและ action ย้อนกลับหมด
  IF r.req_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(r.payload->'request_ids') x;
    PERFORM app_exec_create_pr(actor, r.job_id, ids);
    type_label := 'ออก PR';
  ELSIF r.req_type = 'issue_job' THEN
    PERFORM app_exec_issue_job(actor, r.job_id,
      (r.payload->>'start_date')::DATE, (r.payload->>'end_date')::DATE,
      r.payload->>'location', r.payload->>'note');
    type_label := 'เบิกให้ Service';
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
  type_label := CASE r.req_type WHEN 'create_pr' THEN 'ออก PR' WHEN 'issue_job' THEN 'เบิกให้ Service' ELSE 'ยกเลิก Job' END;

  UPDATE approval_requests SET status = 'rejected', decided_by = actor.id, decided_at = now(),
    reject_reason = trim(p_reason)
  WHERE id = p_request_id;

  PERFORM app_notify('approval_rejected',
    '⛔ Division ตีกลับคำขอ' || type_label || ' ของ ' || j.job_no || ' — เหตุผล: ' || trim(p_reason),
    'project', r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'reject_request', actor.id,
    'ตีกลับคำขอ' || type_label || ' ของ ' || j.job_no || ' เหตุผล: ' || trim(p_reason));
END $$;

-- ---------- 5) Realtime ----------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE approval_requests;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
