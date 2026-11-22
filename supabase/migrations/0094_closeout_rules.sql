-- =============================================================================
-- 0094 — 🏁 ปิดงาน / หลังปิดงาน (เฟส 1 · มติผู้ใช้ Q1/Q2 2026-11-22 + ผลตรวจ Workflow 2026-11-18)
--
-- ทดสอบก่อนแก้บน Postgres จำลอง (รัน 0001→0093) — ผ่าน 0/11:
--   · ปิดงานได้ทั้งที่มีเครื่อง "ติดตั้งไม่ได้" ค้าง → เครื่องค้างสถานะ "เบิกแล้ว" กับใบที่ปิดไปแล้วตลอด
--   · ปิดงานได้ทั้งที่มีวัสดุซื้อเพิ่ม / คำขอ / คืนวัสดุค้าง → PR/PO/คำขอค้างถาวร ทำต่อไม่ได้
--   · เปิดงานใหม่ได้แม้เริ่มนับประกันแล้ว (ประกัน LBS เริ่มจากวันติดตั้งจริง = ทุกใบที่ปิดแล้ว)
--   · ไม่มีทางแก้ข้อมูลที่บันทึกผิดหลังปิดงาน
--
-- มติผู้ใช้:
--   Q1  เครื่องติดตั้งไม่ได้ → ต้อง "คืนเข้า LBS Inventory" ก่อนปิดงาน · ไม่มีตัดจำหน่าย LBS
--       วิธีคืน = Service/Project (เจ้าของงาน) ขอ → Division ตรวจรับ (คำขอประเภท return_lbs)
--   Q2  เริ่มนับประกันแล้ว ห้ามเปิดงานใหม่ · บันทึกผิดให้ "ขอ Division แก้ไข" (คำขอประเภท correct_closeout)
--       แก้ได้ 4 แบบ: วันที่ติดตั้งรายเครื่อง · วันประกัน · เอกสารรับมอบ · Serial ที่ยืนยันสลับกัน (2 เครื่องบนใบเดียวกัน)
--
-- สิ่งที่ทำ:
--   1) unit_installations.outcome + 'returned' (คืนเข้าคลังแล้ว — เครื่องเริ่มนับใหม่เมื่อไป Job อื่น)
--      approval_requests.req_type + 'return_lbs', 'correct_closeout'
--   2) app_job_close_blockers(job) = รายการเหตุที่ยังปิดไม่ได้ · trigger บน jobs แทน 0090 revert guard
--   3) app_assert_job_reopenable: เริ่มนับประกันแล้ว → RAISE
--   4) rpc_request_return_lbs / app_exec_return_lbs (เครื่อง → in_stock คลังเดิม + ต่อแถว returned + stock_allocations)
--   5) rpc_request_closeout_correction / app_exec_correct_closeout (งานยังปิดอยู่ · แก้แบบต่อแถว ไม่ลบหลักฐาน)
--   6) app_exec_approve / rpc_reject_request / rpc_add_approval_comment: สาขา + ป้ายของ 2 ประเภทใหม่
--      ผลพิจารณาแจ้ง Service + Project (เหมือน revert_install)
--
-- ⚠️ ป้ายคำขอ 4 ที่: logic.ts · src/ui/format.ts · functions/line-approval-push.js · SQL (ไฟล์นี้)
-- demo sync: src/data/logic.ts (jobCloseBlockers · requestReturnLbs · requestCloseoutCorrection · jobWarrantyStarted)
-- **รันก่อน push** (หน้าเว็บเรียก rpc_request_return_lbs / rpc_request_closeout_correction) · idempotent
-- =============================================================================

-- ---------- 1) ค่าใหม่ใน CHECK ----------
ALTER TABLE unit_installations DROP CONSTRAINT IF EXISTS unit_install_outcome_chk;
ALTER TABLE unit_installations ADD CONSTRAINT unit_install_outcome_chk
  CHECK (outcome IN ('installed', 'blocked', 'reverted', 'returned'));
ALTER TABLE unit_installations DROP CONSTRAINT IF EXISTS unit_install_revert_reason_chk;
ALTER TABLE unit_installations ADD CONSTRAINT unit_install_revert_reason_chk
  CHECK (outcome NOT IN ('reverted', 'returned') OR COALESCE(btrim(reason), '') <> '');
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_req_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_req_type_check
  CHECK (req_type IN ('create_pr', 'issue_job', 'cancel_job', 'swap_lbs', 'reopen_job', 'revert_install',
                      'return_lbs', 'correct_closeout'));

-- ---------- 1.1) trigger ผลติดตั้ง: ยอม returned เมื่อผลล่าสุดยังไม่ใช่ installed ----------
CREATE OR REPLACE FUNCTION app_unit_install_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE last_outcome TEXT; v_serial TEXT;
BEGIN
  SELECT outcome INTO last_outcome FROM unit_installations
   WHERE unit_id = NEW.unit_id ORDER BY performed_at DESC LIMIT 1;
  SELECT serial_lvb INTO v_serial FROM lbs_units WHERE id = NEW.unit_id;
  IF NEW.outcome = 'reverted' THEN                                              -- 0090
    IF last_outcome IS DISTINCT FROM 'installed' THEN
      RAISE EXCEPTION '% ยังไม่ได้ยืนยันติดตั้ง — ไม่มีผลให้ยกเลิก', v_serial;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.outcome = 'returned' THEN                                              -- 0094
    IF last_outcome = 'installed' THEN
      RAISE EXCEPTION '% ติดตั้งแล้ว — คืนเข้าคลังไม่ได้', v_serial;
    END IF;
    RETURN NEW;
  END IF;
  IF last_outcome = 'installed' THEN
    RAISE EXCEPTION '% ยืนยันติดตั้งไปแล้ว — % ไม่ได้ (ถ้าบันทึกผิด ใช้ "ขอยกเลิกผลติดตั้ง")', v_serial,
      CASE WHEN NEW.outcome = 'blocked' THEN 'บันทึกว่าติดตั้งไม่ได้' ELSE 'ยืนยันซ้ำ' END;
  END IF;
  RETURN NEW;
END $$;

-- ---------- 1.2) เครื่องที่เบิกแล้วแก้ไม่ได้ (0059) — ยกเว้นทางคืนเข้าคลังที่ Division ตรวจรับแล้ว ----------
--   ธงตั้งด้วย set_config ภายใน SECURITY DEFINER เท่านั้น — ผู้ใช้เขียน lbs_units ตรงไม่ได้อยู่แล้ว (0057)
CREATE OR REPLACE FUNCTION fn_block_issued_job_edit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.lbs_return', true) = 'on' THEN RETURN NEW; END IF;   -- 0094
  IF OLD.status = 'issued' THEN
    RAISE EXCEPTION 'LBS % เบิกให้ Service แล้ว — ล็อก แก้ไขไม่ได้', OLD.serial_lvb;
  END IF;
  IF OLD.job_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM jobs WHERE id = OLD.job_id AND terminal_status IN ('issued','installed')) THEN
      RAISE EXCEPTION 'Job % is issued/installed — allocation is locked', OLD.job_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------- 2) เหตุที่ยังปิดงานไม่ได้ + trigger ----------
CREATE OR REPLACE FUNCTION app_job_close_blockers(jid UUID) RETURNS TEXT[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE out TEXT[] := ARRAY[]::TEXT[]; n INT; t TEXT;
BEGIN
  SELECT count(*), string_agg(x.serial_lvb, ', ' ORDER BY x.serial_lvb) INTO n, t
    FROM lbs_units x JOIN v_unit_install_state s ON s.unit_id = x.id
   WHERE x.job_id = jid AND s.outcome = 'blocked';
  IF n > 0 THEN out := out || ('เครื่องติดตั้งไม่ได้ ' || n || ' เครื่อง (' || t || ') — ส่งคำขอคืนเข้า LBS Inventory ก่อน'); END IF;

  SELECT count(*), string_agg(CASE req_type WHEN 'create_pr' THEN 'ออก PR' WHEN 'issue_job' THEN 'เบิก LBS ให้ Service'
           WHEN 'cancel_job' THEN 'ยกเลิก Job' WHEN 'swap_lbs' THEN 'สลับ LBS' WHEN 'reopen_job' THEN 'เปิดงานใหม่'
           WHEN 'revert_install' THEN 'ยกเลิกผลติดตั้ง' WHEN 'return_lbs' THEN 'คืน LBS เข้าคลัง'
           WHEN 'correct_closeout' THEN 'แก้ข้อมูลหลังปิดงาน' ELSE req_type END, ', ') INTO n, t
    FROM approval_requests WHERE job_id = jid AND status = 'pending';
  IF n > 0 THEN out := out || ('มีคำขอรอ Division พิจารณา: ' || t); END IF;

  SELECT count(*) INTO n FROM stock_return_requests WHERE job_id = jid AND status = 'pending';
  IF n > 0 THEN out := out || ('มีคำขอคืนวัสดุรอ Purchasing ตรวจรับ ' || n || ' รายการ'); END IF;

  SELECT count(*) INTO n FROM job_accessory_requests r
   WHERE r.job_id = jid AND (r.status IN ('pending', 'pr_sent', 'po_ordered')
      OR (r.status IN ('issued', 'received') AND app_acc_pending_qty(r) > 0));
  IF n > 0 THEN out := out || ('วัสดุยังค้าง ' || n || ' รายการ (ยังซื้อไม่เสร็จ หรือยังไม่ออกหน้างาน)'); END IF;
  RETURN out;
END $$;
REVOKE ALL ON FUNCTION public.app_job_close_blockers(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_job_close_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b TEXT[];
BEGIN
  b := app_job_close_blockers(NEW.id);
  IF array_length(b, 1) > 0 THEN
    RAISE EXCEPTION '% ยังปิดงานไม่ได้: %', NEW.job_no, array_to_string(b, ' · ');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_job_close_revert_guard ON jobs;     -- 0090 — รวมเข้า guard ใหม่แล้ว (คำขอค้างทุกประเภท)
DROP TRIGGER IF EXISTS trg_job_close_guard ON jobs;
CREATE TRIGGER trg_job_close_guard BEFORE UPDATE OF terminal_status ON jobs
  FOR EACH ROW
  WHEN (NEW.terminal_status = 'installed' AND OLD.terminal_status IS DISTINCT FROM 'installed')
  EXECUTE FUNCTION app_job_close_guard();

-- ---------- 3) ห้ามเปิดงานใหม่หลังเริ่มนับประกัน ----------
CREATE OR REPLACE FUNCTION app_assert_job_reopenable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; v_start DATE;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION 'เปิดงานใหม่ได้เฉพาะงานที่ปิดแล้ว (Installed) — % อยู่สถานะอื่น', j.job_no;
  END IF;
  -- 0094 (มติ Q2): เริ่มนับประกันแล้ว = เปิดงานใหม่ไม่ได้ (ใบเก่าที่ไม่มีประกันยังเปิดได้)
  -- review #8: นับ "วันนี้" ตามเวลาไทย (Supabase = UTC · ตี 0–7 วันที่ยังเป็นเมื่อวาน)
  SELECT min(start_date) INTO v_start FROM job_warranties WHERE job_id = jid AND start_date <= (now() AT TIME ZONE 'Asia/Bangkok')::date;
  IF v_start IS NOT NULL THEN
    RAISE EXCEPTION '% เริ่มนับประกันแล้ว (%) — เปิดงานใหม่ไม่ได้ · ถ้าบันทึกผิดให้ใช้ "ขอแก้ข้อมูลที่บันทึกผิด"', j.job_no, v_start;
  END IF;
  PERFORM app_assert_job_owner(j);   -- 0042
  RETURN j;
END $$;

-- ---------- 3.1) review #3: ขอยกเลิกผลติดตั้ง (0090) บนงานที่ปิดแล้ว ----------
--   ข้อความเดิมบอก "ต้องขอเปิดงานใหม่ก่อน" แต่ข้อ 3 ห้ามเปิดงานใหม่หลังเริ่มประกันแล้ว = ทางตัน
--   ⇒ ชี้ไปที่ "ขอแก้ข้อมูลที่บันทึกผิด" (correct_closeout) · body 0090 ทั้งดุ้น เปลี่ยนแค่ข้อความ
CREATE OR REPLACE FUNCTION app_assert_revertable_units(j jobs, ids UUID[]) RETURNS UUID[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE uniq UUID[]; bad TEXT;
BEGIN
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status = 'installed' THEN
    RAISE EXCEPTION '% ปิดงานแล้ว — ยกเลิกผลติดตั้งไม่ได้ · ถ้าบันทึกผิด (วันที่ / Serial สลับ) ให้ใช้ "ขอแก้ข้อมูลที่บันทึกผิด" ที่หน้า Job', j.job_no;
  END IF;
  IF j.terminal_status = 'cancelled' THEN RAISE EXCEPTION '% ถูกยกเลิกแล้ว', j.job_no; END IF;
  SELECT array_agg(DISTINCT x) INTO uniq FROM unnest(COALESCE(ids, '{}'::UUID[])) x WHERE x IS NOT NULL;
  IF uniq IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกเครื่องที่จะยกเลิกผลติดตั้ง'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(uniq) t(id) LEFT JOIN lbs_units u ON u.id = t.id
              WHERE u.id IS NULL OR u.job_id IS DISTINCT FROM j.id) THEN
    RAISE EXCEPTION 'มีเครื่องที่ไม่ได้อยู่ใน %', j.job_no;
  END IF;
  SELECT u.serial_lvb INTO bad
    FROM lbs_units u LEFT JOIN v_unit_install_state s ON s.unit_id = u.id
   WHERE u.id = ANY(uniq) AND s.outcome IS DISTINCT FROM 'installed'
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '% ยังไม่ได้ยืนยันติดตั้ง — ไม่มีผลให้ยกเลิก', bad;
  END IF;
  RETURN uniq;
END $$;
REVOKE ALL ON FUNCTION public.app_assert_revertable_units(jobs, UUID[]) FROM PUBLIC, anon, authenticated;

-- ---------- 4) คืน LBS ที่เบิกแล้วเข้าคลัง (Division ตรวจรับ) ----------
CREATE OR REPLACE FUNCTION app_assert_returnable_units(j jobs, p_unit_ids UUID[]) RETURNS UUID[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uniq UUID[]; bad TEXT;
BEGIN
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'issued' AND j.terminal_status IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION '% ยังไม่ได้เบิกให้ Service — ใช้ "คืน LBS กลับสต็อก" ที่หน้า Job', j.job_no;
  END IF;
  SELECT array_agg(DISTINCT x) INTO uniq FROM unnest(COALESCE(p_unit_ids, ARRAY[]::UUID[])) x;
  IF uniq IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกเครื่องที่จะคืน'; END IF;
  IF (SELECT count(*) FROM lbs_units WHERE id = ANY(uniq) AND job_id = j.id) <> array_length(uniq, 1) THEN
    RAISE EXCEPTION 'มีเครื่องที่ไม่ได้อยู่ใน %', j.job_no;
  END IF;
  SELECT serial_lvb INTO bad FROM lbs_units WHERE id = ANY(uniq) AND status <> 'issued' LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '% ยังไม่ได้เบิกให้ Service — ใช้ "คืน LBS กลับสต็อก" ที่หน้า Job', bad;
  END IF;
  SELECT u.serial_lvb INTO bad FROM lbs_units u JOIN v_unit_install_state s ON s.unit_id = u.id
   WHERE u.id = ANY(uniq) AND s.outcome = 'installed' LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '% ติดตั้งแล้ว — คืนไม่ได้ (ถ้าบันทึกผิดใช้ "ขอยกเลิกผลติดตั้ง")', bad;
  END IF;
  RETURN uniq;
END $$;
REVOKE ALL ON FUNCTION public.app_assert_returnable_units(jobs, UUID[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION rpc_request_return_lbs(p_job_id UUID, p_unit_ids UUID[], p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; ids UUID[]; rid UUID; v_reason TEXT; v_sn TEXT; label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service', 'project']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  PERFORM app_assert_job_owner(j);
  ids := app_assert_returnable_units(j, p_unit_ids);
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ขอคืนเข้าคลัง'; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE job_id = p_job_id AND req_type = 'return_lbs' AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอคืน LBS รอ Division พิจารณาอยู่แล้ว', j.job_no;
  END IF;
  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES ('return_lbs', p_job_id, jsonb_build_object('unit_ids', to_jsonb(ids), 'reason', v_reason), actor.id)
  RETURNING id INTO rid;
  SELECT string_agg(serial_lvb, ', ' ORDER BY serial_lvb) INTO v_sn FROM lbs_units WHERE id = ANY(ids);
  label := 'คืน LBS เข้าคลัง (' || array_length(ids, 1) || ' เครื่อง)';
  PERFORM app_notify('approval_requested', '🔔 ' || j.job_no || ' ขออนุมัติ' || label, 'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id,
    j.job_no || ' ขออนุมัติ' || label || ': ' || v_sn || ' · เหตุผล: ' || v_reason);
  RETURN rid;
END $$;
REVOKE ALL ON FUNCTION public.rpc_request_return_lbs(UUID, UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_request_return_lbs(UUID, UUID[], TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION app_exec_return_lbs(actor profiles, p_job_id UUID, p_unit_ids UUID[], p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; ids UUID[]; v_reason TEXT; u RECORD; st RECORD;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  ids := app_assert_returnable_units(j, p_unit_ids);            -- ตรวจซ้ำ ณ ตอนอนุมัติ
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ขอคืนเข้าคลัง'; END IF;

  FOR u IN SELECT id, serial_lvb, serial_om FROM lbs_units WHERE id = ANY(ids) LOOP
    INSERT INTO unit_installations (unit_id, job_id, outcome, reason, performed_by, performed_at)
    VALUES (u.id, p_job_id, 'returned', v_reason, actor.id, clock_timestamp());
    PERFORM app_audit('lbs_unit', u.id, 'return_issued_lbs', actor.id,
      j.job_no || ' คืน ' || u.serial_lvb || '/' || u.serial_om || ' เข้า LBS Inventory (ติดตั้งไม่ได้) — ' || v_reason);
  END LOOP;
  FOR st IN SELECT project_stock_id, array_agg(serial_lvb ORDER BY serial_lvb) AS serials
              FROM lbs_units WHERE id = ANY(ids) GROUP BY project_stock_id LOOP
    INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by, reference_note)
    VALUES (p_job_id, st.project_stock_id, 'return', st.serials, actor.id,
            'คืนจาก ' || j.job_no || ' หลังเบิก (ติดตั้งไม่ได้) — ' || v_reason);
  END LOOP;

  PERFORM set_config('app.lbs_return', 'on', true);             -- ผ่านด่าน fn_block_issued_job_edit เฉพาะขั้นนี้
  UPDATE lbs_units SET status = 'in_stock', job_id = NULL, install_site_id = NULL, updated_at = now()
   WHERE id = ANY(ids);
  PERFORM set_config('app.lbs_return', '', true);
END $$;
REVOKE ALL ON FUNCTION public.app_exec_return_lbs(profiles, UUID, UUID[], TEXT) FROM PUBLIC, anon, authenticated;

-- ---------- 5) ขอแก้ข้อมูลหลังปิดงาน ----------
--   c (jsonb): {kind:'install_date', unit_id, installed_date} | {kind:'warranty', unit_id?, start_date, end_date}
--              | {kind:'acceptance', acceptance_type, acceptance_doc_no?, acceptance_date} | {kind:'swap_serial', unit_ids:[a,b]}
CREATE OR REPLACE FUNCTION app_correction_label(c JSONB) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE c->>'kind'
    WHEN 'install_date' THEN 'วันที่ติดตั้ง ' || COALESCE((SELECT serial_lvb FROM lbs_units WHERE id = (c->>'unit_id')::UUID), '-') || ' → ' || (c->>'installed_date')
    WHEN 'warranty' THEN 'ประกัน' || COALESCE(' LBS ' || (SELECT serial_lvb FROM lbs_units WHERE id = NULLIF(c->>'unit_id', '')::UUID), 'งานติดตั้ง')
                         || ' → ' || (c->>'start_date') || ' ถึง ' || (c->>'end_date')
    WHEN 'acceptance' THEN 'เอกสารรับมอบ → ' || (c->>'acceptance_type') || COALESCE(' ' || NULLIF(c->>'acceptance_doc_no', ''), '') || ' (' || (c->>'acceptance_date') || ')'
    WHEN 'swap_serial' THEN 'สลับผลติดตั้ง ' || (SELECT string_agg(serial_lvb, ' ↔ ') FROM lbs_units
                                                 WHERE id IN (SELECT (x)::UUID FROM jsonb_array_elements_text(c->'unit_ids') x))
    ELSE COALESCE(c->>'kind', '-') END
$$;
REVOKE ALL ON FUNCTION public.app_correction_label(JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_assert_correctable(j jobs, c JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k TEXT := c->>'kind'; u UUID; ids UUID[]; v_d DATE; v_s DATE; v_e DATE; v_t TEXT; bad TEXT;
BEGIN
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION 'ขอแก้ข้อมูลได้เฉพาะงานที่ปิดงานแล้ว — % ยังไม่ได้ปิดงาน (แก้ได้ที่หน้า Service ตามปกติ)', j.job_no;
  END IF;
  IF k = 'install_date' THEN
    ids := ARRAY[(c->>'unit_id')::UUID];
    v_d := NULLIF(c->>'installed_date', '')::DATE;
    IF v_d IS NULL OR v_d > (now() AT TIME ZONE 'Asia/Bangkok')::date THEN RAISE EXCEPTION 'วันที่ติดตั้งไม่ถูกต้อง (ต้องไม่เกินวันนี้)'; END IF;
  ELSIF k = 'warranty' THEN
    u := NULLIF(c->>'unit_id', '')::UUID;
    IF u IS NOT NULL THEN ids := ARRAY[u]; END IF;
    v_s := NULLIF(c->>'start_date', '')::DATE; v_e := NULLIF(c->>'end_date', '')::DATE;
    IF v_s IS NULL OR v_e IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันเริ่ม–วันสิ้นสุดประกัน'; END IF;
    IF v_e < v_s THEN RAISE EXCEPTION 'วันสิ้นสุดประกันต้องไม่ก่อนวันเริ่ม'; END IF;
    IF NOT EXISTS (SELECT 1 FROM job_warranties WHERE job_id = j.id
                    AND ((u IS NULL AND kind = 'installation') OR (u IS NOT NULL AND kind = 'lbs' AND unit_id = u))) THEN
      RAISE EXCEPTION 'ไม่พบประกันที่จะแก้ของงานนี้';
    END IF;
  ELSIF k = 'acceptance' THEN
    v_t := c->>'acceptance_type';
    IF v_t IS NULL OR v_t NOT IN ('PAC', 'AC', 'COD', 'HANDOVER') THEN RAISE EXCEPTION 'กรุณาเลือกประเภทเอกสารรับมอบ'; END IF;
    IF NULLIF(c->>'acceptance_date', '') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันที่เอกสารรับมอบ'; END IF;
    IF NOT EXISTS (SELECT 1 FROM job_closeout_files WHERE job_id = j.id AND kind = 'acceptance' AND doc_type = v_t) THEN
      RAISE EXCEPTION 'ต้องแนบไฟล์เอกสารรับมอบประเภท % ก่อน (แนบได้ที่หน้า Service (Warranty))', v_t;
    END IF;
  ELSIF k = 'swap_serial' THEN
    -- review #1: exec อ่านตำแหน่งที่ 1/2 ของ array ดิบ ⇒ ต้องมีพอดี 2 ตัวและไม่ซ้ำ ([a,a,b] เดิมผ่าน แล้วสลับ a กับ a เอง)
    IF jsonb_typeof(c->'unit_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'unit_ids') <> 2 THEN
      RAISE EXCEPTION 'เลือกเครื่องที่ยืนยันสลับกัน 2 เครื่อง (ไม่ซ้ำกัน)';
    END IF;
    SELECT array_agg(DISTINCT (x)::UUID) INTO ids FROM jsonb_array_elements_text(c->'unit_ids') x;
    IF COALESCE(array_length(ids, 1), 0) <> 2 THEN RAISE EXCEPTION 'เลือกเครื่องที่ยืนยันสลับกัน 2 เครื่อง (ไม่ซ้ำกัน)'; END IF;
  ELSE
    RAISE EXCEPTION 'ประเภทการแก้ไขไม่ถูกต้อง';
  END IF;
  IF ids IS NOT NULL THEN
    IF (SELECT count(*) FROM lbs_units WHERE id = ANY(ids) AND job_id = j.id) <> array_length(ids, 1) THEN
      RAISE EXCEPTION 'มีเครื่องที่ไม่ได้อยู่ใน %', j.job_no;
    END IF;
    SELECT x.serial_lvb INTO bad FROM lbs_units x LEFT JOIN v_unit_install_state s ON s.unit_id = x.id
     WHERE x.id = ANY(ids) AND s.outcome IS DISTINCT FROM 'installed' LIMIT 1;
    IF bad IS NOT NULL THEN RAISE EXCEPTION '% ไม่ได้อยู่ในสถานะติดตั้งแล้ว', bad; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.app_assert_correctable(jobs, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION rpc_request_closeout_correction(p_job_id UUID, p_correction JSONB, p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; rid UUID; v_reason TEXT; label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service', 'project']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  PERFORM app_assert_job_owner(j);
  PERFORM app_assert_correctable(j, p_correction);
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ขอแก้ไข'; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE job_id = p_job_id AND req_type = 'correct_closeout' AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอแก้ข้อมูลรอ Division พิจารณาอยู่แล้ว', j.job_no;
  END IF;
  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES ('correct_closeout', p_job_id, jsonb_build_object('correction', p_correction, 'reason', v_reason), actor.id)
  RETURNING id INTO rid;
  label := app_correction_label(p_correction);
  PERFORM app_notify('approval_requested', '🔔 ' || j.job_no || ' ขอแก้ข้อมูลหลังปิดงาน: ' || label, 'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id,
    j.job_no || ' ขอแก้ข้อมูลหลังปิดงาน: ' || label || ' · เหตุผล: ' || v_reason);
  RETURN rid;
END $$;
REVOKE ALL ON FUNCTION public.rpc_request_closeout_correction(UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_request_closeout_correction(UUID, JSONB, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION app_exec_correct_closeout(actor profiles, p_job_id UUID, c JSONB, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; k TEXT := c->>'kind'; v_reason TEXT; u UUID; a UUID; b UUID;
        ra unit_installations; rb unit_installations; wa job_warranties; wb job_warranties; v_last DATE;
        v_wshift INT := 0;
        -- ลำดับแถวต้องชัดเจนแม้อยู่ธุรกรรมเดียว (DISTINCT ON performed_at) — นาฬิกาบางเครื่องละเอียดไม่พอ ⇒ บวกทีละ 1 µs
        ts TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  PERFORM app_assert_correctable(j, c);                         -- ตรวจซ้ำ ณ ตอนอนุมัติ
  v_reason := 'แก้หลังปิดงาน: ' || btrim(COALESCE(p_reason, ''));

  IF k = 'install_date' THEN
    u := (c->>'unit_id')::UUID;
    SELECT * INTO ra FROM unit_installations WHERE unit_id = u ORDER BY performed_at DESC LIMIT 1;
    -- ต่อแถว (ไม่แก้แถวเดิม — เป็นหลักฐาน) · clock_timestamp ให้ลำดับถูกแม้อยู่ธุรกรรมเดียวกัน
    INSERT INTO unit_installations (unit_id, job_id, outcome, reason, performed_by, performed_at)
    VALUES (u, p_job_id, 'reverted', v_reason, actor.id, ts);
    INSERT INTO unit_installations (unit_id, job_id, outcome, installed_date, checkin_lat, checkin_lng, photo_url,
                                    installed_by_member_id, note, performed_by, performed_at)
    VALUES (u, p_job_id, 'installed', (c->>'installed_date')::DATE, ra.checkin_lat, ra.checkin_lng, ra.photo_url,
            ra.installed_by_member_id, v_reason, actor.id, ts + interval '1 microsecond');
    -- review #2: มติผู้ใช้ "ประกัน LBS เริ่มจากวันติดตั้งจริงรายเครื่อง" ⇒ ประกันที่เริ่มตรงวันติดตั้งเดิมเลื่อนตาม
    --   (ระยะประกันเท่าเดิม) · ประกันที่ตั้งเป็นวันอื่น (แก้ตามสัญญา) ไม่แตะ — ขอแก้ประกันแยกได้
    UPDATE job_warranties
       SET start_date = (c->>'installed_date')::DATE,
           end_date   = end_date + ((c->>'installed_date')::DATE - ra.installed_date)
     WHERE job_id = p_job_id AND kind = 'lbs' AND unit_id = u AND start_date = ra.installed_date;
    GET DIAGNOSTICS v_wshift = ROW_COUNT;

  ELSIF k = 'swap_serial' THEN
    SELECT (x)::UUID INTO a FROM jsonb_array_elements_text(c->'unit_ids') WITH ORDINALITY t(x, i) WHERE i = 1;
    SELECT (x)::UUID INTO b FROM jsonb_array_elements_text(c->'unit_ids') WITH ORDINALITY t(x, i) WHERE i = 2;
    SELECT * INTO ra FROM unit_installations WHERE unit_id = a ORDER BY performed_at DESC LIMIT 1;
    SELECT * INTO rb FROM unit_installations WHERE unit_id = b ORDER BY performed_at DESC LIMIT 1;
    INSERT INTO unit_installations (unit_id, job_id, outcome, reason, performed_by, performed_at)
    VALUES (a, p_job_id, 'reverted', v_reason, actor.id, ts);
    INSERT INTO unit_installations (unit_id, job_id, outcome, reason, performed_by, performed_at)
    VALUES (b, p_job_id, 'reverted', v_reason, actor.id, ts + interval '1 microsecond');
    INSERT INTO unit_installations (unit_id, job_id, outcome, installed_date, checkin_lat, checkin_lng, photo_url,
                                    installed_by_member_id, note, performed_by, performed_at)
    VALUES (a, p_job_id, 'installed', rb.installed_date, rb.checkin_lat, rb.checkin_lng, rb.photo_url,
            rb.installed_by_member_id, v_reason, actor.id, ts + interval '2 microseconds');
    INSERT INTO unit_installations (unit_id, job_id, outcome, installed_date, checkin_lat, checkin_lng, photo_url,
                                    installed_by_member_id, note, performed_by, performed_at)
    VALUES (b, p_job_id, 'installed', ra.installed_date, ra.checkin_lat, ra.checkin_lng, ra.photo_url,
            ra.installed_by_member_id, v_reason, actor.id, ts + interval '3 microseconds');
    -- ประกัน LBS ตามเครื่องจริง (เริ่มจากวันติดตั้งของเครื่องนั้น) ⇒ สลับวันกันด้วย
    SELECT * INTO wa FROM job_warranties WHERE kind = 'lbs' AND unit_id = a;
    SELECT * INTO wb FROM job_warranties WHERE kind = 'lbs' AND unit_id = b;
    IF wa.id IS NOT NULL AND wb.id IS NOT NULL THEN
      UPDATE job_warranties SET start_date = wb.start_date, end_date = wb.end_date WHERE id = wa.id;
      UPDATE job_warranties SET start_date = wa.start_date, end_date = wa.end_date WHERE id = wb.id;
    END IF;

  ELSIF k = 'warranty' THEN
    u := NULLIF(c->>'unit_id', '')::UUID;
    UPDATE job_warranties SET start_date = (c->>'start_date')::DATE, end_date = (c->>'end_date')::DATE
     WHERE job_id = p_job_id AND ((u IS NULL AND kind = 'installation') OR (u IS NOT NULL AND kind = 'lbs' AND unit_id = u));

  ELSIF k = 'acceptance' THEN
    UPDATE jobs SET acceptance_type = c->>'acceptance_type',
      acceptance_doc_no = NULLIF(btrim(COALESCE(c->>'acceptance_doc_no', '')), ''),
      acceptance_date = (c->>'acceptance_date')::DATE, updated_at = now()
     WHERE id = p_job_id;
  END IF;

  -- วันที่ติดตั้งเปลี่ยน → วันปิดงาน (= วันติดตั้งล่าสุด) ตามให้ตรง
  IF k IN ('install_date', 'swap_serial') THEN
    SELECT max(s.installed_date) INTO v_last FROM lbs_units x JOIN v_unit_install_state s ON s.unit_id = x.id
     WHERE x.job_id = p_job_id AND s.outcome = 'installed';
    IF v_last IS NOT NULL THEN UPDATE jobs SET installed_at = v_last, updated_at = now() WHERE id = p_job_id; END IF;
  END IF;

  PERFORM app_audit('job', p_job_id, 'correct_closeout', actor.id,
    j.job_no || ' แก้ข้อมูลหลังปิดงาน: ' || app_correction_label(c) ||
    CASE WHEN v_wshift > 0 THEN ' (ประกัน LBS เลื่อนตามวันติดตั้ง)' ELSE '' END ||
    ' — ' || btrim(COALESCE(p_reason, '')));
END $$;
REVOKE ALL ON FUNCTION public.app_exec_correct_closeout(profiles, UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- ---------- 6) app_exec_approve (body 0093 ทั้งดุ้น + 2 สาขาใหม่) ----------
CREATE OR REPLACE FUNCTION app_exec_approve(actor profiles, p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests; j jobs; type_label TEXT; ids UUID[]; v_msg TEXT; v_stale TEXT;
BEGIN
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  IF r.requested_by IS NOT NULL AND r.requested_by = actor.id THEN                -- 0093
    RAISE EXCEPTION 'คำขอนี้คุณเป็นผู้ส่งเอง — ต้องให้ผู้อนุมัติคนอื่นพิจารณา (รอ Division พิจารณา)';
  END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  IF r.req_type = 'create_pr' AND jsonb_typeof(r.payload->'snapshot') = 'array' THEN  -- 0093
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
  ELSIF r.req_type = 'return_lbs' THEN                                           -- 0094
    SELECT array_agg((x)::UUID) INTO ids
      FROM jsonb_array_elements_text(COALESCE(r.payload->'unit_ids', '[]'::jsonb)) x;
    PERFORM app_exec_return_lbs(actor, r.job_id, ids, r.payload->>'reason');
    type_label := 'คืน LBS เข้าคลัง';
  ELSIF r.req_type = 'correct_closeout' THEN                                     -- 0094
    PERFORM app_exec_correct_closeout(actor, r.job_id, r.payload->'correction', r.payload->>'reason');
    type_label := 'แก้ข้อมูลหลังปิดงาน';
  ELSIF r.req_type = 'cancel_job' THEN
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  ELSE
    RAISE EXCEPTION 'ประเภทคำขอ % ยังไม่รองรับการอนุมัติ', r.req_type;
  END IF;

  v_msg := '✅ อนุมัติ' || type_label || ' · ' || j.job_no || ' · โดย ' || actor.full_name;
  IF r.req_type IN ('revert_install', 'return_lbs', 'correct_closeout') THEN
    -- คำขอจากหน้างาน (Service หรือ Project) → แจ้งทั้งสองแผนก (0091/0094)
    PERFORM app_notify('approval_approved', v_msg, 'service', r.job_id);
    PERFORM app_notify('approval_approved', v_msg, 'project', r.job_id);
  ELSE
    PERFORM app_notify('approval_approved', v_msg, 'project', r.job_id);
  END IF;
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- ---------- 6.1) rpc_reject_request (body 0093 ทั้งดุ้น + ป้าย/ผู้รับแจ้งของ 2 ประเภทใหม่) ----------
CREATE OR REPLACE FUNCTION rpc_reject_request(p_request_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; type_label TEXT; v_msg TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ตีกลับ'; END IF;
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  IF r.requested_by IS NOT NULL AND r.requested_by = actor.id THEN
    RAISE EXCEPTION 'คำขอนี้คุณเป็นผู้ส่งเอง — ต้องให้ผู้อนุมัติคนอื่นพิจารณา (รอ Division พิจารณา)';
  END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  type_label := CASE r.req_type WHEN 'create_pr' THEN 'ออก PR' WHEN 'issue_job' THEN 'เบิก LBS ให้ Service'
                                WHEN 'swap_lbs' THEN 'สลับ LBS' WHEN 'reopen_job' THEN 'เปิดงานใหม่'
                                WHEN 'revert_install' THEN 'ยกเลิกผลติดตั้ง'
                                WHEN 'return_lbs' THEN 'คืน LBS เข้าคลัง' WHEN 'correct_closeout' THEN 'แก้ข้อมูลหลังปิดงาน'
                                ELSE 'ยกเลิก Job' END;
  UPDATE approval_requests SET status = 'rejected', decided_by = actor.id, decided_at = now(),
    reject_reason = trim(p_reason)
  WHERE id = p_request_id;
  v_msg := '⛔ ตีกลับ' || type_label || ' · ' || j.job_no || ': ' || trim(p_reason);
  IF r.req_type IN ('revert_install', 'return_lbs', 'correct_closeout') THEN
    PERFORM app_notify('approval_rejected', v_msg, 'service', r.job_id);
    -- สำเนาถึง Project ไม่ขึ้น LINE กลุ่มซ้ำ
    INSERT INTO notifications (type, message, dept, job_id, line_status)
    VALUES ('approval_rejected', v_msg, 'project', r.job_id, 'off');
  ELSE
    PERFORM app_notify('approval_rejected', v_msg, 'project', r.job_id);
  END IF;
  PERFORM app_audit('approval_request', p_request_id, 'reject_request', actor.id,
    'ตีกลับคำขอ' || type_label || ' ของ ' || j.job_no || ' เหตุผล: ' || trim(p_reason));
END $$;

-- ---------- 6.2) rpc_add_approval_comment (body ตัวจริง 0050→0090 ทั้งดุ้น + ป้ายใหม่) ----------
CREATE OR REPLACE FUNCTION rpc_add_approval_comment(p_request_id UUID, p_body TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; cid UUID;
        v_body TEXT; v_who TEXT; v_to TEXT; v_type TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['vip', 'sales']);
  v_body := btrim(COALESCE(p_body, ''));
  IF v_body = '' THEN RAISE EXCEPTION 'กรุณาพิมพ์ความเห็นก่อนส่ง'; END IF;
  IF length(v_body) > 1000 THEN RAISE EXCEPTION 'ความเห็นยาวเกิน 1,000 ตัวอักษร'; END IF;
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  INSERT INTO approval_comments (scope, request_id, body, author_id)
  VALUES ('approval', p_request_id, v_body, actor.id) RETURNING id INTO cid;
  v_type := CASE r.req_type
    WHEN 'create_pr'  THEN 'ออก PR'
    WHEN 'issue_job'  THEN 'เบิก LBS ให้ Service'
    WHEN 'cancel_job' THEN 'ยกเลิก Job'
    WHEN 'swap_lbs'   THEN 'สลับ LBS'
    WHEN 'reopen_job' THEN 'เปิดงานใหม่' WHEN 'revert_install' THEN 'ยกเลิกผลติดตั้ง'
    WHEN 'return_lbs' THEN 'คืน LBS เข้าคลัง' WHEN 'correct_closeout' THEN 'แก้ข้อมูลหลังปิดงาน'   -- 0094
    ELSE r.req_type END;
  v_who := CASE WHEN actor.department = 'vip' THEN 'VIP' ELSE 'Division' END;
  v_to  := CASE WHEN actor.department = 'vip' THEN 'sales' ELSE 'vip' END;
  PERFORM app_notify('approval_comment',
    '💬 ' || v_who || ' ให้ความเห็นคำขอ' || v_type || ' · ' || COALESCE(j.job_no, '-') || ': ' || left(v_body, 120),
    v_to, r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'comment_request', actor.id,
    v_who || ' ให้ความเห็นคำขอ' || v_type || ' ของ ' || COALESCE(j.job_no, '-') || ': ' || v_body);
  RETURN cid;
END $$;

-- ---------- 7) review #4: คำขอเปิดงานใหม่ที่ค้างก่อน 0094 บนงานที่เริ่มประกันแล้ว → ตีกลับ ----------
--   อนุมัติไม่ได้แล้ว (ข้อ 3) — ปล่อยไว้จะค้างในคิว Division ตลอด · แจ้ง Project ในเว็บ (ไม่ขึ้น LINE)
WITH voided AS (
  UPDATE approval_requests r
     SET status = 'rejected', decided_at = now(),
         reject_reason = 'ระบบ (0094): เริ่มนับประกันแล้ว เปิดงานใหม่ไม่ได้ — ถ้าบันทึกผิดให้ใช้ "ขอแก้ข้อมูลที่บันทึกผิด" ที่หน้า Job'
   WHERE r.req_type = 'reopen_job' AND r.status = 'pending'
     AND EXISTS (SELECT 1 FROM job_warranties w WHERE w.job_id = r.job_id AND w.start_date <= (now() AT TIME ZONE 'Asia/Bangkok')::date)
  RETURNING r.job_id
)
INSERT INTO notifications (type, message, dept, job_id, line_status)
SELECT 'approval_rejected', '⛔ คำขอเปิดงานใหม่ของ ' || j.job_no || ' ถูกตีกลับ — เริ่มนับประกันแล้ว ใช้ "ขอแก้ข้อมูลที่บันทึกผิด" แทน',
       'project', v.job_id, 'off'
  FROM voided v JOIN jobs j ON j.id = v.job_id;

-- ---------- ตรวจผล ----------
DO $$
DECLARE bad TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_job_close_guard' AND tgrelid = 'jobs'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0094: trigger ด่านปิดงานไม่ได้ติดตั้ง';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_job_close_revert_guard' AND tgrelid = 'jobs'::regclass) THEN
    RAISE EXCEPTION '0094: trigger 0090 เดิมยังค้าง';
  END IF;
  IF position('job_warranties' IN pg_get_functiondef('public.app_assert_job_reopenable(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0094: ยังไม่กันเปิดงานใหม่หลังเริ่มประกัน';
  END IF;
  IF position('return_lbs' IN pg_get_functiondef('public.app_exec_approve(profiles,uuid)'::regprocedure)) = 0
     OR position('correct_closeout' IN pg_get_functiondef('public.app_exec_approve(profiles,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0094: app_exec_approve ยังไม่มีสาขาใหม่';
  END IF;
  -- สิทธิ์: rpc ใหม่ = authenticated · app_ ใหม่ = ไม่มีใครเรียกตรง (กติกา 0091)
  SELECT string_agg(f, ', ') INTO bad FROM unnest(ARRAY[
    'public.rpc_request_return_lbs(uuid,uuid[],text)', 'public.rpc_request_closeout_correction(uuid,jsonb,text)']) f
   WHERE NOT has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0094: สิทธิ์ rpc ใหม่ผิด: %', bad; END IF;
  SELECT string_agg(f, ', ') INTO bad FROM unnest(ARRAY[
    'public.app_exec_return_lbs(profiles,uuid,uuid[],text)', 'public.app_exec_correct_closeout(profiles,uuid,jsonb,text)',
    'public.app_job_close_blockers(uuid)', 'public.app_assert_returnable_units(jobs,uuid[])',
    'public.app_assert_correctable(jobs,jsonb)', 'public.app_correction_label(jsonb)']) f
   WHERE has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0094: ฟังก์ชันภายในถูกเรียกตรงได้: %', bad; END IF;
  RAISE NOTICE '0094: ตรวจผ่าน';
END $$;
