-- =====================================================================
-- 0004: แก้ bug rpc_issue_job (เจอจาก E2E บน DB จริง)
-- เดิม: ตั้ง job เป็น 'issued' ก่อน แล้วค่อย update units -> trigger
--       trg_block_issued_edit บล็อกการ update unit ของ job ที่เพิ่ง issued
-- แก้: update units เป็น 'issued' ก่อน แล้วค่อยตั้ง job เป็น terminal
-- รัน CREATE OR REPLACE นี้ทับได้เลย (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_issue_job(p_job_id UUID, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; cnt INT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF app_job_status(p_job_id) <> 'ready_to_issue' THEN
    RAISE EXCEPTION '% ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ', j.job_no;
  END IF;
  -- units ก่อน (ตอนนี้ job ยังไม่ terminal -> trigger ผ่าน) แล้วค่อยตั้ง job เป็น issued
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
