-- =============================================================================
-- 0098 — ด่านยืนยันติดตั้งรายเครื่อง (2026-11-23 · เฟส 5)
--
-- ① วันที่ติดตั้งในอนาคตไม่ได้ (เวลาไทย) — เดิมไม่มีด่านเลยทั้ง UI/logic/SQL
--    (ประกอบกับหน้าจอเดิมเติมวันที่จาก UTC ⇒ 00:00–06:59 ได้ "เมื่อวาน" · พิมพ์ผิดเป็นปีหน้าก็ผ่าน)
-- ② เครื่องที่มีคำขอคืนเข้า LBS Inventory (return_lbs · 0094) รอ Division พิจารณา ยืนยันติดตั้งไม่ได้
--    เดิม: ช่างกด "ยืนยันใหม่" ได้ → Division อนุมัติคืน → app_exec_return_lbs ปฏิเสธ (ติดตั้งแล้ว คืนไม่ได้)
--    → คำขอค้าง pending ตลอด = ปิดงานไม่ได้ (คำขอค้างเป็นเรื่องค้างก่อนปิด) จนกว่า Division จะตีกลับ
--
-- แก้: trigger BEFORE INSERT บน unit_installations (outcome = installed) — ครอบทุกทางที่บันทึกผลติดตั้ง
--   (rpc_confirm_unit_install · แก้วันติดตั้งหลังปิดงาน 0094) · ไม่แก้ body RPC
-- mirror: logic.ts confirmUnitInstall · รันซ้ำได้ · ไม่แตะข้อมูล
-- =============================================================================

CREATE OR REPLACE FUNCTION app_install_confirm_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sn TEXT;
BEGIN
  IF NEW.installed_date IS NOT NULL AND NEW.installed_date > (now() AT TIME ZONE 'Asia/Bangkok')::date THEN
    RAISE EXCEPTION 'วันที่ติดตั้ง % เป็นวันในอนาคต — ใส่วันที่ติดตั้งจริง', NEW.installed_date;
  END IF;
  IF EXISTS (SELECT 1 FROM approval_requests
              WHERE status = 'pending' AND req_type = 'return_lbs'
                AND job_id = NEW.job_id
                AND COALESCE(payload->'unit_ids', '[]'::jsonb) ? NEW.unit_id::text) THEN
    SELECT serial_lvb INTO sn FROM lbs_units WHERE id = NEW.unit_id;
    RAISE EXCEPTION '% มีคำขอคืนเข้า LBS Inventory รอ Division พิจารณา — ยืนยันติดตั้งไม่ได้ (ให้ Division ตีกลับคำขอก่อนถ้าติดตั้งได้แล้วจริง)', COALESCE(sn, '-');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_install_confirm_guard() FROM PUBLIC, anon, authenticated;   -- กติกา 0091

DROP TRIGGER IF EXISTS trg_install_confirm_guard ON unit_installations;
CREATE TRIGGER trg_install_confirm_guard BEFORE INSERT ON unit_installations
  FOR EACH ROW WHEN (NEW.outcome = 'installed')
  EXECUTE FUNCTION app_install_confirm_guard();

-- ---------- ตรวจผล ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_install_confirm_guard' AND tgrelid = 'unit_installations'::regclass) THEN
    RAISE EXCEPTION '0098: trigger ไม่ได้ติดตั้ง';
  END IF;
  IF has_function_privilege('authenticated', 'public.app_install_confirm_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.app_install_confirm_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION '0098: ฟังก์ชันภายในถูกเรียกตรงได้';
  END IF;
  RAISE NOTICE '0098: ตรวจผ่าน';
END $$;
