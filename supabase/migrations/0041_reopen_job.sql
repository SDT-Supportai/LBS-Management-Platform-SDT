-- =====================================================================
-- 0041: เปิดงานใหม่หลังปิดงานผิด (Reopen) ผ่านการอนุมัติ Division (2026-07-31)
--  ปัญหา: ปิดงานติดตั้งแล้ว (installed) เป็น terminal — ถ้ากดปิดผิด/ต้องกลับไปแก้หน้างาน
--    ไม่มีทางกลับ ต้องไปแก้ที่ DB
--  ไม่แก้ด้วยการใส่ปุ่มให้ Service กดเอง เพราะ installed กระทบบัญชี (installed_at),
--    ล็อกจัดซื้อ และรายงาน → ใช้ pattern เดิมของระบบ: ขออนุมัติ Division
--      [Project] ขอเปิดงานใหม่ → ⏳ รอ Division พิจารณา → อนุมัติ → installed → issued
--      [Manage]  ทำตรงได้ (rpc_reopen_job) เหมือนทุก flow
--  หลักการเก็บข้อมูล:
--    - unit_installations คงไว้ทั้งหมด (เครื่องที่ยืนยันแล้วยังยืนยันแล้ว ปิดใหม่ได้ทันที)
--    - ล้าง field การปิดงาน (installed_at / install_note / install_confirmed_by / close_*)
--      เพราะจะถูกเขียนใหม่ตอนปิดรอบหน้า · ถ้าไม่ล้างจะมีงาน issued ที่มีวันปิดงานค้าง = รายงานเพี้ยน
--      → สำเนาเดิมเก็บลง audit ก่อนล้าง
--    - reopen_count นับจำนวนครั้ง (เปิดบ่อย = สัญญาณปัญหาเชิงกระบวนการ)
--  ⚠️ rpc_request_approval / rpc_reject_request ถูก 0031 ย่อข้อความ + 0037 patch guard แล้ว
--     → ใช้ app_swap_guard patch เฉพาะบรรทัด ห้าม CREATE OR REPLACE ด้วย body เก่า
--  demo sync ที่ src/data/logic.ts (reopenJob) · รันหลัง 0040 · idempotent
-- =====================================================================

-- ---------- 1) schema ----------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reopen_count INT NOT NULL DEFAULT 0;

-- เพิ่ม 'reopen_job' ใน CHECK ของ approval_requests.req_type
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_req_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_req_type_check
  CHECK (req_type IN ('create_pr', 'issue_job', 'cancel_job', 'swap_lbs', 'reopen_job'));

-- ---------- 2) guard: เปิดงานใหม่ได้เฉพาะงานที่ปิดแล้ว ----------
CREATE OR REPLACE FUNCTION app_assert_job_reopenable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION 'เปิดงานใหม่ได้เฉพาะงานที่ปิดแล้ว (Installed) — % อยู่สถานะอื่น', j.job_no;
  END IF;
  RETURN j;
END $$;

-- ต่อ app_assert_job_editable_for (0037) — reopen_job ใช้ guard ตัวใหม่
CREATE OR REPLACE FUNCTION app_assert_job_editable_for(jid UUID, req_type TEXT) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF req_type = 'create_pr'   THEN RETURN app_assert_job_procurable(jid); END IF;  -- ออก PR หลังเบิกได้
  IF req_type = 'reopen_job'  THEN RETURN app_assert_job_reopenable(jid); END IF;  -- ต้องปิดงานแล้ว
  RETURN app_assert_job_editable(jid);   -- issue_job / cancel_job / swap_lbs ล็อกตามเดิม
END $$;

-- ---------- 3) execute: installed → issued ----------
CREATE OR REPLACE FUNCTION app_exec_reopen_job(actor profiles, p_job_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; prev TEXT; tot INT; inst INT; closer TEXT;
BEGIN
  j := app_assert_job_reopenable(p_job_id);
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ขอเปิดงานใหม่'; END IF;

  SELECT full_name INTO closer FROM profiles WHERE id = j.install_confirmed_by;
  prev := 'วันปิดงานเดิม ' || COALESCE(j.installed_at::TEXT, '-') ||
          ' · ผู้ปิด ' || COALESCE(closer, '-') ||
          ' · ' || CASE WHEN j.close_has_issues THEN 'ปัญหาเดิม: ' || COALESCE(j.close_issue_detail, '-')
                        ELSE 'ไม่มีปัญหา' END;

  UPDATE jobs SET terminal_status = 'issued',
    installed_at = NULL, install_note = NULL, install_confirmed_by = NULL,
    close_has_issues = NULL, close_issue_detail = NULL, close_issue_file_url = NULL,
    reopen_count = COALESCE(reopen_count, 0) + 1, updated_at = now()
  WHERE id = p_job_id;

  SELECT COUNT(*) INTO tot FROM lbs_units WHERE job_id = p_job_id;
  SELECT COUNT(*) INTO inst FROM v_unit_install_state s
    JOIN lbs_units x ON x.id = s.unit_id
   WHERE x.job_id = p_job_id AND s.outcome = 'installed';

  PERFORM app_notify('job_reopened',
    '🔄 เปิดงาน ' || j.job_no || ' ใหม่: ' || btrim(p_reason) ||
    ' · กลับเป็นรอติดตั้ง (ยืนยันแล้ว ' || COALESCE(inst, 0) || '/' || tot || ' เครื่อง)', 'all', p_job_id);
  PERFORM app_audit('job', p_job_id, 'reopen_job', actor.id,
    'เปิดงาน ' || j.job_no || ' ใหม่ (ครั้งที่ ' || (COALESCE(j.reopen_count, 0) + 1) || ') — ' ||
    btrim(p_reason) || ' [ข้อมูลการปิดงานเดิม: ' || prev || ']');
END $$;

-- Manage (admin) ทำตรง
CREATE OR REPLACE FUNCTION rpc_reopen_job(p_job_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);   -- admin เท่านั้น
  PERFORM app_exec_reopen_job(actor, p_job_id, p_reason);
END $$;

-- ---------- 4) ต่อ app_exec_approve (0033) — เพิ่ม branch reopen_job ----------
-- 0031 ไม่ได้แตะฟังก์ชันนี้ (เกิดหลัง 0031) → recreate ได้ปลอดภัย
-- พร้อมกันนี้ปรับข้อความให้ตรงกับ demo (สั้นลง) ให้สองฝั่งพูดเหมือนกัน
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
    PERFORM app_exec_issue_job(actor, r.job_id,
      (r.payload->>'start_date')::DATE, (r.payload->>'end_date')::DATE,
      r.payload->>'location', r.payload->>'note');
    type_label := 'เบิกให้ Service';
  ELSIF r.req_type = 'swap_lbs' THEN
    PERFORM app_exec_swap_lbs(actor, r.job_id,
      (r.payload->>'swap_allocated_unit_id')::UUID, (r.payload->>'swap_stock_unit_id')::UUID,
      r.payload->>'reason');
    type_label := 'สลับ LBS';
  ELSIF r.req_type = 'reopen_job' THEN
    PERFORM app_exec_reopen_job(actor, r.job_id, r.payload->>'reason');
    type_label := 'เปิดงานใหม่';
  ELSE
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  END IF;

  PERFORM app_notify('approval_approved',
    '✅ อนุมัติ' || type_label || ' · ' || j.job_no || ' · โดย ' || actor.full_name,
    'project', r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- ---------- 5) patch rpc_request_approval / rpc_reject_request (ห้าม recreate) ----------
DO $$
BEGIN
  -- อนุญาตประเภทใหม่
  PERFORM app_swap_guard('rpc_request_approval',
    '''create_pr'', ''issue_job'', ''cancel_job'', ''swap_lbs''',
    '''create_pr'', ''issue_job'', ''cancel_job'', ''swap_lbs'', ''reopen_job''');

  -- reopen_job ตกลง ELSE เดียวกับ cancel_job → ทำให้ 2 บรรทัดนั้นแยกตามประเภทเอง
  -- ⚠️ ต้อง patch แบบ "บรรทัดเดียว" เท่านั้น — body ที่เก็บใน DB อาจมี CRLF (ไฟล์ repo เป็น CRLF
  --    บน Windows) ทำให้การ match ข้ามบรรทัดด้วย E'\n' ไม่เจอ
  PERFORM app_swap_guard('rpc_request_approval',
    'type_label := ''ยกเลิก Job'';',
    'type_label := CASE WHEN p_type = ''reopen_job'' THEN ''เปิดงานใหม่'' ELSE ''ยกเลิก Job'' END;');

  PERFORM app_swap_guard('rpc_request_approval',
    'RAISE EXCEPTION ''กรุณาระบุเหตุผลการยกเลิก'';',
    'RAISE EXCEPTION ''%'', CASE WHEN p_type = ''reopen_job'' THEN ''กรุณาระบุเหตุผลที่ขอเปิดงานใหม่'' ELSE ''กรุณาระบุเหตุผลการยกเลิก'' END;');

  -- label ตอนตีกลับ
  PERFORM app_swap_guard('rpc_reject_request',
    'WHEN ''swap_lbs'' THEN ''สลับ LBS'' ELSE ''ยกเลิก Job'' END',
    'WHEN ''swap_lbs'' THEN ''สลับ LBS'' WHEN ''reopen_job'' THEN ''เปิดงานใหม่'' ELSE ''ยกเลิก Job'' END');
END $$;

-- ---------- 6) สิทธิ์ ----------
GRANT EXECUTE ON FUNCTION public.rpc_reopen_job(UUID, TEXT) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0041 OK — เปิดงานใหม่ผ่านการอนุมัติ Division พร้อมใช้งาน'; END $$;
