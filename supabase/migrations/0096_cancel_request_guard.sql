-- =============================================================================
-- 0096 — กันส่งคำขอยกเลิก Job ที่เบิกของให้ Service ไปแล้วบางส่วน (2026-11-23 · รีวิวเฟส 2 รอบสุดท้ายข้อ 2)
--
-- ปัญหา: rpc_request_approval('cancel_job') ไม่เช็คของที่ออกหน้างานแล้ว ⇒ Project ส่งคำขอได้
--   แล้วไปค้างรอ Division · พอ Division กดอนุมัติ app_exec_cancel_job → app_assert_no_issued_out
--   ถึงจะ error ("เบิกของให้ Service ไปแล้วบางส่วน — ยกเลิกไม่ได้") = เสียรอบพิจารณาฟรี
--
-- แก้: trigger BEFORE INSERT บน approval_requests (เฉพาะ req_type = 'cancel_job') เรียกด่านเดิม
--   app_assert_no_issued_out (0067) — ข้อความเดียวกับตอนยกเลิกจริง · ไม่ต้องแก้ body rpc_request_approval
--   (mirror ของ logic.ts: requestApproval → jobCancelBlockReason)
-- รันซ้ำได้ · ไม่แตะข้อมูล · คำขอยกเลิกที่ค้างอยู่แล้ว (ถ้ามี) ไม่ถูกแตะ — Division ตีกลับเองได้
-- =============================================================================

CREATE OR REPLACE FUNCTION app_cancel_request_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_assert_no_issued_out(NEW.job_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_cancel_request_guard() FROM PUBLIC, anon, authenticated;   -- กติกา 0091

DROP TRIGGER IF EXISTS trg_cancel_request_guard ON approval_requests;
CREATE TRIGGER trg_cancel_request_guard BEFORE INSERT ON approval_requests
  FOR EACH ROW
  WHEN (NEW.req_type = 'cancel_job')
  EXECUTE FUNCTION app_cancel_request_guard();

-- ---------- ตรวจผล ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cancel_request_guard' AND tgrelid = 'approval_requests'::regclass) THEN
    RAISE EXCEPTION '0096: trigger กันคำขอยกเลิกไม่ได้ติดตั้ง';
  END IF;
  IF position('qty_issued_to_service' IN pg_get_functiondef('public.app_assert_no_issued_out(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0096: app_assert_no_issued_out ยังไม่ใช่เวอร์ชัน 0067 (วัดด้วยจำนวน)';
  END IF;
  RAISE NOTICE '0096: ตรวจผ่าน';
END $$;
