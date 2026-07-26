-- 0032: เพิ่มข้อความแจ้งเตือน (action ชั้น 1) ตอนสลับ LBS (2026-07-26)
--  ปัญหาเดิม: app_exec_swap_lbs (0028) บันทึกแค่ app_audit → ตอน Division อนุมัติ "สลับ LBS"
--    ผู้รับเห็นแค่ '✅ อนุมัติสลับ LBS' (ชั้น 2) ไม่เห็นรายละเอียดว่า Serial ไหนสลับกับไหน
--  แก้: เติม app_notify('lbs_swapped', ..., 'all', job) ให้เหมือนอีก 3 ประเภท (draw ใช้ 'all' เช่นกัน)
--  demo sync ที่ src/data/logic.ts (swapLbs) · รันหลัง 0031 (idempotent — CREATE OR REPLACE)

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

  -- action ชั้น 1: แจ้งรายละเอียดการสลับ (เหมือน create_pr / issue_job / cancel_job)
  PERFORM app_notify('lbs_swapped',
    '🔁 ' || j.job_no || ' สลับ LBS: ' || a.serial_lvb || '/' || a.serial_om || ' ↔ ' || b.serial_lvb || '/' || b.serial_om
    || ' (คลัง) · เหตุผล: ' || trim(p_reason),
    'all', p_job_id);
END $$;
