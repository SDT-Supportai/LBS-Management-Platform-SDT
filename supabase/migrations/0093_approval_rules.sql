-- =============================================================================
-- 0093 — ✅ กติกาอนุมัติ (เฟส 1 · มติผู้ใช้ D1 2026-11-22 + ผลตรวจ Workflow 2026-11-18)
--
-- ทดสอบก่อนแก้บน Postgres จำลอง (รัน 0001→0092) — ผ่าน 2/9 (บั๊กเกิดจริง):
--   ① Manage ส่งคำขอเองแล้วอนุมัติ/ตีกลับเองได้ ทั้งหน้าเว็บและปุ่มในการ์ด LINE
--   ② ยกเลิก Job แล้ว คำขออื่นของ Job นั้นค้าง pending ตลอดไป (Badge ไม่ลด · กดอนุมัติแล้ว error)
--   ③ คำขอล้าสมัย: ส่งขอออก PR แล้ว Project ยังแก้จำนวน/ราคาได้ → Division อนุมัติของที่ไม่ได้เห็น
--      ขอเบิก LBS แบบไม่ระบุเครื่อง → ตอนอนุมัติระบบเลือกใหม่ อาจได้มากกว่าที่ Division เห็นตอนขอ
--
-- สิ่งที่ทำ:
--   ① app_exec_approve + rpc_reject_request: requested_by = ผู้ตัดสิน → RAISE (ทุกบัญชี รวม Manage)
--      ครอบทั้งเว็บ (rpc_approve_request) และ LINE (rpc_line_approve → app_exec_approve)
--      + line-approval-push.js ไม่ส่งการ์ดให้ผู้ขอเอง
--   ② trigger บน jobs: ถูกยกเลิก (terminal_status → cancelled) → คำขอ pending ที่เหลือของ Job = rejected
--      เหตุผล "ระบบ: … ถูกยกเลิก" + แจ้ง Project 1 รายการ (ไม่ขึ้น LINE กลุ่ม — มีข้อความยกเลิก Job ไปแล้ว)
--   ③ rpc_request_approval เก็บสำเนา ณ ตอนขอ:
--        create_pr → payload.snapshot = [{id, qty, unit_price}]  · อนุมัติตอนที่ไม่ตรง = "คำขอล้าสมัย"
--        issue_job → payload.unit_ids = เครื่องที่พร้อม ณ ตอนขอ (เมื่อไม่ได้ระบุเครื่อง)
--      คำขอเก่าก่อน 0093 ไม่มี snapshot → ข้ามการตรวจ (ไม่ทำให้คำขอค้างอนุมัติไม่ได้)
--
-- demo sync: src/data/logic.ts (assertNotOwnRequest · assertPrSnapshotFresh · cancelJob · requestApproval)
-- รันก่อนหรือหลัง push ก็ได้ (หน้าเว็บไม่ส่งพารามิเตอร์ใหม่) · idempotent
-- =============================================================================

-- ---------- ① + ③ app_exec_approve (body 0091 ทั้งดุ้น + ตรวจผู้ขอ + ตรวจ snapshot) ----------
CREATE OR REPLACE FUNCTION app_exec_approve(actor profiles, p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests; j jobs; type_label TEXT; ids UUID[]; v_msg TEXT; v_stale TEXT;
BEGIN
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  -- 0093 (มติ D1): คนขอกับคนอนุมัติต้องเป็นคนละคน
  IF r.requested_by IS NOT NULL AND r.requested_by = actor.id THEN
    RAISE EXCEPTION 'คำขอนี้คุณเป็นผู้ส่งเอง — ต้องให้ผู้อนุมัติคนอื่นพิจารณา (รอ Division พิจารณา)';
  END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  -- 0093: ออก PR — จำนวน/ราคาต้องตรงกับที่ Division เห็นตอนขอ (คำขอเก่าไม่มี snapshot = ข้าม)
  IF r.req_type = 'create_pr' AND jsonb_typeof(r.payload->'snapshot') = 'array' THEN
    SELECT string_agg(COALESCE(i.name, 'รายการที่ถูกลบ'), ', ') INTO v_stale
      FROM jsonb_array_elements(r.payload->'snapshot') s
      LEFT JOIN job_accessory_requests a ON a.id = (s->>'id')::UUID
      LEFT JOIN items i ON i.id = a.item_id
     WHERE a.id IS NULL
        OR a.qty_requested IS DISTINCT FROM (s->>'qty')::NUMERIC
        OR a.unit_price IS DISTINCT FROM NULLIF(s->>'unit_price', '')::NUMERIC;
    IF v_stale IS NOT NULL THEN
      RAISE EXCEPTION 'คำขอล้าสมัย — รายการถูกแก้หลังส่งคำขอ (%) · กรุณาตีกลับแล้วให้ Project ส่งคำขอใหม่', v_stale;
    END IF;
  END IF;

  UPDATE approval_requests SET status = 'approved', decided_by = actor.id, decided_at = now()
  WHERE id = p_request_id;

  IF r.req_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(r.payload->'request_ids') x;
    PERFORM app_exec_create_pr(actor, r.job_id, ids);
    type_label := 'ออก PR';
  ELSIF r.req_type = 'issue_job' THEN
    SELECT array_agg((x)::UUID) INTO ids
      FROM jsonb_array_elements_text(COALESCE(r.payload->'unit_ids', '[]'::jsonb)) x;
    PERFORM app_exec_issue_lbs(actor, r.job_id, ids,
      (r.payload->>'start_date')::DATE, (r.payload->>'end_date')::DATE,
      r.payload->>'location', r.payload->>'note');
    type_label := 'เบิก LBS ให้ Service';
  ELSIF r.req_type = 'swap_lbs' THEN
    PERFORM app_exec_swap_lbs(actor, r.job_id,
      (r.payload->>'swap_allocated_unit_id')::UUID, (r.payload->>'swap_stock_unit_id')::UUID,
      r.payload->>'reason');
    type_label := 'สลับ LBS';
  ELSIF r.req_type = 'reopen_job' THEN
    PERFORM app_exec_reopen_job(actor, r.job_id, r.payload->>'reason');
    type_label := 'เปิดงานใหม่';
  ELSIF r.req_type = 'revert_install' THEN
    SELECT array_agg((x)::UUID) INTO ids
      FROM jsonb_array_elements_text(COALESCE(r.payload->'unit_ids', '[]'::jsonb)) x;
    PERFORM app_exec_revert_install(actor, r.job_id, ids, r.payload->>'reason');
    type_label := 'ยกเลิกผลติดตั้ง';
  ELSIF r.req_type = 'cancel_job' THEN
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  ELSE
    RAISE EXCEPTION 'ประเภทคำขอ % ยังไม่รองรับการอนุมัติ', r.req_type;
  END IF;

  v_msg := '✅ อนุมัติ' || type_label || ' · ' || j.job_no || ' · โดย ' || actor.full_name;
  PERFORM app_notify('approval_approved', v_msg,
    CASE WHEN r.req_type = 'revert_install' THEN 'service' ELSE 'project' END, r.job_id);
  IF r.req_type = 'revert_install' THEN
    PERFORM app_notify('approval_approved', v_msg, 'project', r.job_id);           -- 0091
  END IF;
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- ---------- ① rpc_reject_request (body 0091 ทั้งดุ้น + ตรวจผู้ขอ) ----------
CREATE OR REPLACE FUNCTION rpc_reject_request(p_request_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; type_label TEXT; v_msg TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ตีกลับ'; END IF;
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  IF r.requested_by IS NOT NULL AND r.requested_by = actor.id THEN                -- 0093 (มติ D1)
    RAISE EXCEPTION 'คำขอนี้คุณเป็นผู้ส่งเอง — ต้องให้ผู้อนุมัติคนอื่นพิจารณา (รอ Division พิจารณา)';
  END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  type_label := CASE r.req_type WHEN 'create_pr' THEN 'ออก PR' WHEN 'issue_job' THEN 'เบิก LBS ให้ Service'
                                WHEN 'swap_lbs' THEN 'สลับ LBS' WHEN 'reopen_job' THEN 'เปิดงานใหม่' WHEN 'revert_install' THEN 'ยกเลิกผลติดตั้ง' ELSE 'ยกเลิก Job' END;
  UPDATE approval_requests SET status = 'rejected', decided_by = actor.id, decided_at = now(),
    reject_reason = trim(p_reason)
  WHERE id = p_request_id;
  v_msg := '⛔ ตีกลับ' || type_label || ' · ' || j.job_no || ': ' || trim(p_reason);
  PERFORM app_notify('approval_rejected', v_msg,
    CASE WHEN r.req_type = 'revert_install' THEN 'service' ELSE 'project' END, r.job_id);
  IF r.req_type = 'revert_install' THEN
    INSERT INTO notifications (type, message, dept, job_id, line_status)
    VALUES ('approval_rejected', v_msg, 'project', r.job_id, 'off');              -- 0091
  END IF;
  PERFORM app_audit('approval_request', p_request_id, 'reject_request', actor.id,
    'ตีกลับคำขอ' || type_label || ' ของ ' || j.job_no || ' เหตุผล: ' || trim(p_reason));
END $$;

-- ---------- ③ rpc_request_approval (body ตัวจริง 0059→0062 ทั้งดุ้น + เก็บสำเนา ณ ตอนขอ) ----------
CREATE OR REPLACE FUNCTION rpc_request_approval(p_type TEXT, p_job_id UUID, p_payload JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; j jobs; rid UUID; cnt INT; ids UUID[]; type_label TEXT;
  ua lbs_units; ub lbs_units; onjob INT; short INT; bad_sn TEXT; bad_blk TEXT;
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable_for(p_job_id, p_type);
  IF p_type NOT IN ('create_pr', 'issue_job', 'cancel_job', 'swap_lbs', 'reopen_job') THEN
    RAISE EXCEPTION 'ประเภทคำขอไม่ถูกต้อง';
  END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE job_id = p_job_id AND req_type = p_type AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอประเภทนี้รอ Division พิจารณาอยู่แล้ว', j.job_no;
  END IF;

  IF p_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(COALESCE(p_payload->'request_ids', '[]'::jsonb)) x;
    IF ids IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกรายการที่จะออก PR'; END IF;
    SELECT count(*) INTO cnt FROM job_accessory_requests
     WHERE id = ANY(ids) AND job_id = p_job_id AND source = 'purchasing' AND status = 'pending';
    IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'เลือกได้เฉพาะรายการสั่งซื้อที่ยังไม่ออก PR'; END IF;
    type_label := 'ออก PR (' || array_length(ids, 1) || ' รายการ)';
    -- 0093: สำเนาจำนวน/ราคาที่ Division จะเห็น
    v_payload := v_payload || jsonb_build_object('snapshot',
      (SELECT jsonb_agg(jsonb_build_object('id', id, 'qty', qty_requested, 'unit_price', unit_price))
         FROM job_accessory_requests WHERE id = ANY(ids)));

  ELSIF p_type = 'issue_job' THEN
    SELECT COUNT(*) INTO onjob FROM lbs_units
     WHERE job_id = p_job_id AND status IN ('allocated', 'issued');
    short := GREATEST(0, j.lbs_qty_required - COALESCE(onjob, 0));
    IF short > 0 THEN
      RAISE EXCEPTION '% ดึง LBS ยังไม่ครบ Scope — ขาดอีก % เครื่อง', j.job_no, short;
    END IF;
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(COALESCE(p_payload->'unit_ids', '[]'::jsonb)) x;
    IF ids IS NULL THEN
      SELECT array_agg(u.id) INTO ids FROM lbs_units u
       WHERE u.job_id = p_job_id AND app_unit_issue_block(u) IS NULL;
    ELSE
      SELECT u.serial_lvb, app_unit_issue_block(u) INTO bad_sn, bad_blk
        FROM lbs_units u
       WHERE u.id = ANY(ids) AND (u.job_id IS DISTINCT FROM p_job_id OR app_unit_issue_block(u) IS NOT NULL)
       LIMIT 1;
      IF bad_sn IS NOT NULL THEN
        RAISE EXCEPTION '%: %', bad_sn, COALESCE(bad_blk, 'ไม่ได้ถูกดึงเข้า ' || j.job_no);
      END IF;
      SELECT count(*) INTO cnt FROM lbs_units WHERE id = ANY(ids) AND job_id = p_job_id;
      IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'มีเครื่องที่ไม่ได้ถูกดึงเข้า Job นี้'; END IF;
    END IF;
    IF ids IS NULL OR array_length(ids, 1) IS NULL THEN
      RAISE EXCEPTION '% ไม่มี LBS ที่เบิกได้ตอนนี้ — เช็ค ETA to WH รายเครื่องที่หน้า LBS Inventory', j.job_no;
    END IF;
    IF COALESCE((p_payload->>'start_date')::DATE, j.install_start_date) IS NULL
       OR COALESCE((p_payload->>'end_date')::DATE, j.install_end_date) IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)';
    END IF;
    IF COALESCE((p_payload->>'end_date')::DATE, j.install_end_date)
       < COALESCE((p_payload->>'start_date')::DATE, j.install_start_date) THEN
      RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง';
    END IF;
    IF COALESCE(NULLIF(trim(COALESCE(p_payload->>'location', '')), ''), NULLIF(j.issue_location, '')) IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)';
    END IF;
    type_label := 'เบิก LBS ให้ Service (' || array_length(ids, 1) || ' เครื่อง)';
    -- 0093: เก็บรายการเครื่อง ณ ตอนขอ — อนุมัติแล้วเบิกตามนี้ ไม่เลือกใหม่
    v_payload := v_payload || jsonb_build_object('unit_ids', to_jsonb(ids));

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
    IF trim(COALESCE(p_payload->>'reason', '')) = '' THEN
      RAISE EXCEPTION '%', CASE WHEN p_type = 'reopen_job'
        THEN 'กรุณาระบุเหตุผลที่ขอเปิดงานใหม่' ELSE 'กรุณาระบุเหตุผลการยกเลิก' END;
    END IF;
    type_label := CASE WHEN p_type = 'reopen_job' THEN 'เปิดงานใหม่' ELSE 'ยกเลิก Job' END;
  END IF;

  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES (p_type, p_job_id, v_payload, actor.id) RETURNING id INTO rid;

  PERFORM app_notify('approval_requested', '🔔 ' || j.job_no || ' ขออนุมัติ' || type_label, 'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id, j.job_no || ' ขออนุมัติ' || type_label);
  RETURN rid;
END $$;

-- ---------- ② Job ถูกยกเลิก → ตีกลับคำขอค้างที่เหลืออัตโนมัติ ----------
--   trigger แทนการ patch app_exec_cancel_job อีกรอบ — ครอบทุกทางที่ยกเลิก (อนุมัติคำขอ / Manage ยกเลิกตรง)
CREATE OR REPLACE FUNCTION app_job_cancel_void_requests() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  UPDATE approval_requests
     SET status = 'rejected', decided_by = NEW.cancelled_by, decided_at = now(),
         reject_reason = 'ระบบ: ' || NEW.job_no || ' ถูกยกเลิก'
   WHERE job_id = NEW.id AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    -- ไม่ขึ้น LINE กลุ่ม (job_cancelled แจ้งทุกแผนกไปแล้ว) · แจ้งในเว็บให้ Project รู้ว่าคำขอปิดไปแล้ว
    INSERT INTO notifications (type, message, dept, job_id, line_status)
    VALUES ('approval_rejected', '⛔ คำขอค้าง ' || n || ' รายการของ ' || NEW.job_no || ' ถูกตีกลับอัตโนมัติ — Job ถูกยกเลิก',
            'project', NEW.id, 'off');
    PERFORM app_audit('job', NEW.id, 'void_pending_requests', NEW.cancelled_by,
      NEW.job_no || ' ถูกยกเลิก — ตีกลับคำขอค้างอัตโนมัติ ' || n || ' รายการ');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_job_cancel_void_requests ON jobs;
CREATE TRIGGER trg_job_cancel_void_requests AFTER UPDATE OF terminal_status ON jobs
  FOR EACH ROW
  WHEN (NEW.terminal_status = 'cancelled' AND OLD.terminal_status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION app_job_cancel_void_requests();

-- ---------- ตรวจผล ----------
DO $$
BEGIN
  IF position('ผู้ส่งเอง' IN pg_get_functiondef('public.app_exec_approve(profiles,uuid)'::regprocedure)) = 0
     OR position('ผู้ส่งเอง' IN pg_get_functiondef('public.rpc_reject_request(uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0093: ยังไม่กันอนุมัติคำขอของตัวเอง';
  END IF;
  IF position('snapshot' IN pg_get_functiondef('public.rpc_request_approval(text,uuid,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0093: rpc_request_approval ยังไม่เก็บสำเนา';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_job_cancel_void_requests' AND tgrelid = 'jobs'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0093: trigger ตีกลับคำขอค้างไม่ได้ติดตั้ง';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_request_approval(text,uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rpc_reject_request(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.app_exec_approve(profiles,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0093: สิทธิ์ฟังก์ชันผิด (CREATE OR REPLACE ต้องคงสิทธิ์เดิม)';
  END IF;
  RAISE NOTICE '0093: ตรวจผ่าน';
END $$;
