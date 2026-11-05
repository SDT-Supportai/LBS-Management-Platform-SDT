-- =============================================================================
-- 0090 — ↩️ ขอยกเลิกผลติดตั้งที่บันทึกผิด (ผ่าน Division) (2026-11-05)
--
-- ที่มา (ผู้ใช้สั่ง 2026-11-05 ต่อจาก 0089): 0089 ล็อกเครื่องที่ยืนยันติดตั้งแล้ว (ห้ามยืนยันซ้ำ /
--   พลิกเป็นติดตั้งไม่ได้) ⇒ ถ้าช่างกดยืนยันผิดเครื่อง (Serial สลับ · กดผิดแถว · GPS/รูปผิดจุด)
--   ไม่มีทางแก้เลยนอกจากแก้ฐานข้อมูลตรง ซึ่งไม่มีร่องรอยว่าใครแก้ เพราะอะไร
--
-- ทางแก้ (append-only — ไม่ลบ ไม่ UPDATE แถวหลักฐานเดิม):
--   1) unit_installations.outcome เพิ่มค่า 'reverted' (+ บังคับเหตุผล) = "ยกเลิกผลก่อนหน้า"
--      แถวล่าสุด = reverted ⇒ เครื่องกลับเป็น "รอติดตั้ง" (view/สรุปทุกตัวนับแค่ installed/blocked อยู่แล้ว)
--   2) approval_requests.req_type เพิ่ม 'revert_install'
--   3) rpc_request_revert_install(job, unit_ids, reason) — Service/Project ขอ (rpc_request_approval
--      เดิมรับแค่ Project + มี guard ระดับใบที่ไม่เกี่ยว จึงแยกทางเข้า แต่ใช้คิว/ปุ่มอนุมัติเดิมทั้งหมด)
--   4) app_exec_revert_install + app_exec_approve (recreate จาก body 0059) เพิ่มสาขา revert_install
--      และ ELSE เดิมที่ตกไป "ยกเลิก Job" เปลี่ยนเป็นสาขา cancel_job ชัด ๆ + ELSE = RAISE
--      (บทเรียน 0041: type ใหม่ที่ไม่มีสาขาเคยตกลงไปทำ action ของ type อื่น)
--   5) trg_unit_install_guard (0089): ยอมให้ต่อแถว reverted ได้เฉพาะหลัง installed
--   6) ป้าย/ผู้รับแจ้ง: rpc_reject_request + rpc_add_approval_comment (patch บรรทัด)
--      ผลอนุมัติ/ตีกลับของ revert_install แจ้ง Service (เจ้าของเรื่อง) แทน Project
--
-- ขอบเขต:
--   · เฉพาะเครื่องที่สถานะล่าสุด = installed บน Job เดียวกัน · หลายเครื่องในคำขอเดียวได้
--   · Job ที่ปิดงานแล้ว (installed) ขอไม่ได้ → ต้องขอเปิดงานใหม่ (reopen_job) ก่อน
--     เพราะเอกสารรับมอบ/Warranty ผูกกับผลติดตั้งเดิม
--   · ค้างได้ 1 คำขอต่อ Job (approval_pending_uq เดิม)
--   · ระหว่างรอ Division พิจารณา ปิดงานไม่ได้ (trigger trg_job_close_revert_guard)
--
-- demo sync: src/data/logic.ts (requestRevertInstall / revertUnitInstall / approveRequest / unitInstallState)
-- ป้าย 4 ที่: logic.ts · src/ui/format.ts · functions/line-approval-push.js · SQL (ไฟล์นี้)
-- ต้องรันหลัง 0089 · **รันก่อน push** (หน้าจอใหม่เรียก rpc_request_revert_install) · idempotent
-- =============================================================================

-- ---------- 1) unit_installations: outcome 'reverted' ----------
DO $$
DECLARE c RECORD;
BEGIN
  -- CHECK เดิมเป็นแบบไม่ตั้งชื่อ (0035) → ชื่อ auto · หาโดยนิยามแทนการเดาชื่อ
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.unit_installations'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ~ 'outcome\s*=\s*ANY'
       AND conname <> 'unit_install_outcome_chk'
  LOOP
    EXECUTE format('ALTER TABLE unit_installations DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE '0090: ลบ CHECK เดิม %', c.conname;
  END LOOP;
END $$;
ALTER TABLE unit_installations DROP CONSTRAINT IF EXISTS unit_install_outcome_chk;
ALTER TABLE unit_installations ADD CONSTRAINT unit_install_outcome_chk
  CHECK (outcome IN ('installed', 'blocked', 'reverted'));
ALTER TABLE unit_installations DROP CONSTRAINT IF EXISTS unit_install_revert_reason_chk;
ALTER TABLE unit_installations ADD CONSTRAINT unit_install_revert_reason_chk
  CHECK (outcome <> 'reverted' OR COALESCE(btrim(reason), '') <> '');

-- ---------- 2) approval_requests: req_type 'revert_install' ----------
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_req_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_req_type_check
  CHECK (req_type IN ('create_pr', 'issue_job', 'cancel_job', 'swap_lbs', 'reopen_job', 'revert_install'));

-- ---------- 3) trigger 0089: ยอมให้ "ยกเลิกผล" ต่อจาก installed เท่านั้น ----------
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
  IF last_outcome = 'installed' THEN
    RAISE EXCEPTION '% ยืนยันติดตั้งไปแล้ว — % ไม่ได้ (ถ้าบันทึกผิด ใช้ "ขอยกเลิกผลติดตั้ง")', v_serial,
      CASE WHEN NEW.outcome = 'blocked' THEN 'บันทึกว่าติดตั้งไม่ได้' ELSE 'ยืนยันซ้ำ' END;
  END IF;
  RETURN NEW;
END $$;
-- trigger trg_unit_install_guard (0089) ชี้ฟังก์ชันนี้อยู่แล้ว — ไม่ต้องสร้างใหม่

-- ---------- 4) ตรวจเครื่องที่ขอยกเลิก (ใช้ร่วมกันตอนขอ + ตอนอนุมัติ) ----------
CREATE OR REPLACE FUNCTION app_assert_revertable_units(j jobs, ids UUID[]) RETURNS UUID[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE uniq UUID[]; bad TEXT;
BEGIN
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status = 'installed' THEN
    RAISE EXCEPTION '% ปิดงานแล้ว — ต้องขอเปิดงานใหม่ก่อน จึงจะยกเลิกผลติดตั้งได้', j.job_no;
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

-- ---------- 5) ขอยกเลิกผลติดตั้ง (Service + Project · admin ผ่านในตัว) ----------
CREATE OR REPLACE FUNCTION rpc_request_revert_install(p_job_id UUID, p_unit_ids UUID[], p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; ids UUID[]; rid UUID; v_reason TEXT; v_sn TEXT; label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service', 'project']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  ids := app_assert_revertable_units(j, p_unit_ids);
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ขอยกเลิกผลติดตั้ง'; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests
              WHERE job_id = p_job_id AND req_type = 'revert_install' AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอยกเลิกผลติดตั้งรอ Division พิจารณาอยู่แล้ว', j.job_no;
  END IF;

  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES ('revert_install', p_job_id,
          jsonb_build_object('unit_ids', to_jsonb(ids), 'reason', v_reason), actor.id)
  RETURNING id INTO rid;

  SELECT string_agg(serial_lvb, ', ' ORDER BY serial_lvb) INTO v_sn FROM lbs_units WHERE id = ANY(ids);
  label := 'ยกเลิกผลติดตั้ง (' || array_length(ids, 1) || ' เครื่อง)';
  PERFORM app_notify('approval_requested', '🔔 ' || j.job_no || ' ขออนุมัติ' || label, 'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id,
    j.job_no || ' ขออนุมัติ' || label || ': ' || v_sn || ' · เหตุผล: ' || v_reason);
  RETURN rid;
END $$;
REVOKE ALL ON FUNCTION public.rpc_request_revert_install(UUID, UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_request_revert_install(UUID, UUID[], TEXT) TO authenticated;

-- ---------- 6) execute หลังอนุมัติ: ต่อแถว reverted (หลักฐานเดิมไม่ถูกแตะ) ----------
CREATE OR REPLACE FUNCTION app_exec_revert_install(actor profiles, p_job_id UUID, p_unit_ids UUID[], p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; ids UUID[]; v_reason TEXT; u RECORD;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  ids := app_assert_revertable_units(j, p_unit_ids);       -- ตรวจซ้ำ ณ ตอนอนุมัติ (สถานะอาจเปลี่ยนระหว่างรอ)
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ขอยกเลิกผลติดตั้ง'; END IF;

  FOR u IN
    SELECT x.id, x.serial_lvb, x.serial_om, s.installed_date
      FROM lbs_units x JOIN v_unit_install_state s ON s.unit_id = x.id
     WHERE x.id = ANY(ids)
  LOOP
    INSERT INTO unit_installations (unit_id, job_id, outcome, reason, performed_by)
    VALUES (u.id, p_job_id, 'reverted', v_reason, actor.id);
    PERFORM app_audit('lbs_unit', u.id, 'revert_unit_install', actor.id,
      j.job_no || ' ยกเลิกผลติดตั้ง ' || u.serial_lvb || '/' || u.serial_om ||
      ' (เดิมยืนยันวันที่ ' || COALESCE(u.installed_date::TEXT, '-') || ') — ' || v_reason);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.app_exec_revert_install(profiles, UUID, UUID[], TEXT) FROM PUBLIC, anon, authenticated;

-- ---------- 7) app_exec_approve (body 0059 + สาขา revert_install + ELSE ปลอดภัย) ----------
CREATE OR REPLACE FUNCTION app_exec_approve(actor profiles, p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests; j jobs; type_label TEXT; ids UUID[];
BEGIN
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
    -- 0059: อนุมัติแล้วเบิกเฉพาะ LBS ตามรายการที่ขอ (unit_ids ว่าง = ทุกเครื่องที่ Ready ตอนอนุมัติ)
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
  ELSIF r.req_type = 'revert_install' THEN                                       -- 0090
    SELECT array_agg((x)::UUID) INTO ids
      FROM jsonb_array_elements_text(COALESCE(r.payload->'unit_ids', '[]'::jsonb)) x;
    PERFORM app_exec_revert_install(actor, r.job_id, ids, r.payload->>'reason');
    type_label := 'ยกเลิกผลติดตั้ง';
  ELSIF r.req_type = 'cancel_job' THEN                                           -- 0090: เดิมเป็น ELSE
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  ELSE
    -- ห้ามเดาให้ไปทำ action ของ type อื่น (บทเรียน 0041) — type ใหม่ต้องเพิ่มสาขาที่นี่
    RAISE EXCEPTION 'ประเภทคำขอ % ยังไม่รองรับการอนุมัติ', r.req_type;
  END IF;

  PERFORM app_notify('approval_approved',
    '✅ อนุมัติ' || type_label || ' · ' || j.job_no || ' · โดย ' || actor.full_name,
    CASE WHEN r.req_type = 'revert_install' THEN 'service' ELSE 'project' END,  -- 0090: แจ้งเจ้าของเรื่อง
    r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- ---------- 7.5) ระหว่างรอ Division พิจารณา → ห้ามปิดงาน ----------
--   ปิดก่อนตัดสิน = ปิดบนผลติดตั้งที่อาจผิด (เอกสารรับมอบ/Warranty ผูกกับผลเดิม) และคำขอจะอนุมัติไม่ได้
--   trigger บน jobs แทนการ patch rpc_close_job_install (body ผ่าน swap มาหลายรอบ — แนวเดียวกับ 0089)
CREATE OR REPLACE FUNCTION app_job_close_revert_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM approval_requests
              WHERE job_id = NEW.id AND req_type = 'revert_install' AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอยกเลิกผลติดตั้งรอ Division พิจารณา — ปิดงานได้หลัง Division ตัดสินแล้ว', NEW.job_no;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_job_close_revert_guard ON jobs;
CREATE TRIGGER trg_job_close_revert_guard BEFORE UPDATE OF terminal_status ON jobs
  FOR EACH ROW
  WHEN (NEW.terminal_status = 'installed' AND OLD.terminal_status IS DISTINCT FROM 'installed')
  EXECUTE FUNCTION app_job_close_revert_guard();

-- ---------- 8) ป้าย + ผู้รับแจ้ง ใน rpc_reject_request / rpc_add_approval_comment (patch บรรทัด) ----------
--   ⚠️ guard idempotent เอง (ข้อความใหม่ครอบข้อความเดิม → app_swap_guard จะ patch ซ้ำถ้ารันสองรอบ)
DO $$
BEGIN
  IF to_regprocedure('public.app_swap_guard(TEXT, TEXT, TEXT)') IS NULL THEN
    RAISE EXCEPTION '0090: ไม่พบ app_swap_guard — ต้องรัน 0037 ก่อน';
  END IF;

  IF position('revert_install' IN pg_get_functiondef('public.rpc_reject_request(uuid, text)'::regprocedure)) = 0 THEN
    PERFORM app_swap_guard('rpc_reject_request',
      'WHEN ''reopen_job'' THEN ''เปิดงานใหม่'' ELSE ''ยกเลิก Job'' END',
      'WHEN ''reopen_job'' THEN ''เปิดงานใหม่'' WHEN ''revert_install'' THEN ''ยกเลิกผลติดตั้ง'' ELSE ''ยกเลิก Job'' END');
    PERFORM app_swap_guard('rpc_reject_request',
      '''project'', r.job_id);',
      'CASE WHEN r.req_type = ''revert_install'' THEN ''service'' ELSE ''project'' END, r.job_id);');
  END IF;

  IF position('revert_install' IN pg_get_functiondef('public.rpc_add_approval_comment(uuid, text)'::regprocedure)) = 0 THEN
    PERFORM app_swap_guard('rpc_add_approval_comment',
      'WHEN ''reopen_job'' THEN ''เปิดงานใหม่''',
      'WHEN ''reopen_job'' THEN ''เปิดงานใหม่'' WHEN ''revert_install'' THEN ''ยกเลิกผลติดตั้ง''');
  END IF;
END $$;

-- ---------- 9) ตรวจผล ----------
DO $$
DECLARE d TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unit_install_outcome_chk'
                  AND pg_get_constraintdef(oid) LIKE '%reverted%') THEN
    RAISE EXCEPTION '0090: CHECK outcome ไม่มี reverted';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.unit_installations'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) ~ 'outcome\s*=\s*ANY') <> 1 THEN
    RAISE EXCEPTION '0090: CHECK outcome เดิมยังค้าง (จะกัน reverted)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_req_type_check'
                  AND pg_get_constraintdef(oid) LIKE '%revert_install%') THEN
    RAISE EXCEPTION '0090: CHECK req_type ไม่มี revert_install';
  END IF;
  IF to_regprocedure('public.rpc_request_revert_install(uuid, uuid[], text)') IS NULL
     OR to_regprocedure('public.app_exec_revert_install(profiles, uuid, uuid[], text)') IS NULL THEN
    RAISE EXCEPTION '0090: ฟังก์ชันขอ/ยกเลิกผลติดตั้งไม่ครบ';
  END IF;
  d := pg_get_functiondef('public.app_exec_approve(profiles, uuid)'::regprocedure);
  IF position('app_exec_revert_install' IN d) = 0 OR position('ยังไม่รองรับการอนุมัติ' IN d) = 0 THEN
    RAISE EXCEPTION '0090: app_exec_approve ไม่มีสาขา revert_install / ELSE ปลอดภัย';
  END IF;
  IF position('revert_install' IN pg_get_functiondef('public.rpc_reject_request(uuid, text)'::regprocedure)) = 0
     OR position('revert_install' IN pg_get_functiondef('public.rpc_add_approval_comment(uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0090: ป้าย revert_install ใน reject/comment ไม่ครบ';
  END IF;
  IF position('reverted' IN pg_get_functiondef('public.app_unit_install_guard()'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_unit_install_guard' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0090: trigger trg_unit_install_guard ยังไม่รองรับ reverted (รัน 0089 ก่อน)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_job_close_revert_guard' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0090: trigger trg_job_close_revert_guard ไม่ได้ติดตั้ง';
  END IF;
  RAISE NOTICE '0090: OK — ขอยกเลิกผลติดตั้ง → รอ Division พิจารณา → เครื่องกลับเป็นรอติดตั้ง (หลักฐานเดิมอยู่ครบ)';
END $$;
