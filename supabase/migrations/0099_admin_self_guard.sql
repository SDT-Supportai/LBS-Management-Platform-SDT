-- =============================================================================
-- 0099 — กันผู้ดูแลระบบล็อกตัวเองออก (2026-11-24 · เฟส 6 Users & Settings)
--
-- ① เปลี่ยนแผนกของบัญชีตัวเองไม่ได้ — เดิม rpc_update_profile (0002) กันแค่ "ปิดบัญชีตัวเอง"
--    ⇒ Manage ลดตัวเองเป็น Project แล้วกลับมาที่หน้าจัดการผู้ใช้ไม่ได้อีก
-- ② ต้องเหลือ Manage (admin) ที่ใช้งานได้อย่างน้อย 1 บัญชี — ลด/ปิดคนสุดท้ายไม่ได้
--    ครอบทุกทาง (RPC · service role ของ /admin-users · SQL Editor) เพราะเป็น trigger บนตาราง
--    ล็อกแถว Manage ทั้งหมดก่อนนับ (FOR UPDATE) — Manage 2 คนลดกันพร้อมกันไม่หลุดเหลือ 0
--
-- แก้: trigger BEFORE UPDATE OF department, is_active บน profiles · ไม่แก้ body RPC
-- mirror: logic.ts updateUser · รันซ้ำได้ · ไม่แตะข้อมูล
-- =============================================================================

-- รีวิวเฟส 6 (แก้ในไฟล์เดียวกันก่อนรัน):
--   #4 ล็อกด้วย advisory lock คีย์เดียวก่อนนับ — เดิม FOR UPDATE ทุกแถว Manage: 2 ทรานแซกชันถือแถวตัวเองอยู่แล้ว
--      แล้วล็อกแถวอื่นสลับลำดับกัน ⇒ "deadlock detected" (ข้อความดิบ) · advisory lock ไม่รอแถวใคร จึงไม่วนรอกัน
--   #7 ลบบัญชี Manage คนสุดท้ายไม่ได้ด้วย (BEFORE DELETE) — ลบ user ใน Supabase Auth → profile ถูกลบตาม (CASCADE)
--      เดิมกันแค่ UPDATE ⇒ ลบคนสุดท้ายทิ้งได้ (หน้าแดชบอร์ด / สคริปต์ล้างบัญชีทดสอบ)
CREATE OR REPLACE FUNCTION app_profile_self_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE losing BOOLEAN; pid UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id = auth.uid() AND NEW.department IS DISTINCT FROM OLD.department THEN
      RAISE EXCEPTION 'เปลี่ยนแผนกของบัญชีตัวเองไม่ได้ — ให้ Manage อีกคนเปลี่ยนให้';
    END IF;
    IF NEW.id = auth.uid() AND OLD.is_active AND NOT NEW.is_active THEN
      RAISE EXCEPTION 'ปิดการใช้งานบัญชีตัวเองไม่ได้';
    END IF;
    losing := NOT (NEW.department = 'admin' AND NEW.is_active);
  ELSE
    losing := true;                                            -- DELETE
  END IF;
  pid := OLD.id;
  IF OLD.department = 'admin' AND OLD.is_active AND losing THEN
    PERFORM pg_advisory_xact_lock(hashtext('lbs:last-active-admin'));
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id <> pid AND department = 'admin' AND is_active) THEN
      RAISE EXCEPTION 'ต้องเหลือผู้ดูแลระบบ (Manage) ที่ใช้งานได้อย่างน้อย 1 บัญชี — เพิ่ม/เปิด Manage อีกคนก่อน';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_profile_self_guard() FROM PUBLIC, anon, authenticated;   -- กติกา 0091

DROP TRIGGER IF EXISTS trg_profile_self_guard ON profiles;
CREATE TRIGGER trg_profile_self_guard BEFORE UPDATE OF department, is_active ON profiles
  FOR EACH ROW EXECUTE FUNCTION app_profile_self_guard();
DROP TRIGGER IF EXISTS trg_profile_last_admin_delete ON profiles;
CREATE TRIGGER trg_profile_last_admin_delete BEFORE DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION app_profile_self_guard();

-- ---------- ตรวจผล ----------
DO $$
DECLARE n INT;
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'profiles'::regclass
        AND tgname IN ('trg_profile_self_guard', 'trg_profile_last_admin_delete')) <> 2 THEN
    RAISE EXCEPTION '0099: trigger ไม่ได้ติดตั้งครบ 2 ตัว';
  END IF;
  IF has_function_privilege('authenticated', 'public.app_profile_self_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.app_profile_self_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION '0099: ฟังก์ชันภายในถูกเรียกตรงได้';
  END IF;
  SELECT count(*) INTO n FROM profiles WHERE department = 'admin' AND is_active;
  IF n = 0 THEN
    RAISE NOTICE '0099: ⚠️ ตอนนี้ไม่มี Manage ที่ใช้งานได้เลย — เปิดบัญชี Manage ใน SQL Editor ก่อนใช้งาน';
  END IF;
  RAISE NOTICE '0099: ตรวจผ่าน (Manage ที่ใช้งานได้ % บัญชี)', n;
END $$;
