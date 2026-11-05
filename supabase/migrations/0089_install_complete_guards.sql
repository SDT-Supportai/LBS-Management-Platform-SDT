-- =============================================================================
-- 0089 — 🔒 Service: ติดตั้งครบทุกเครื่องแล้ว = ล็อกงานหน้าไซต์ เหลือแค่ปิดงาน (2026-11-05)
--
-- ที่มา (ผู้ใช้แจ้ง 2026-11-05): ยืนยันติดตั้งรายเครื่องครบแล้ว ปุ่ม 👷 มอบหมายทีม / 🔧 ยืนยันรายเครื่อง /
--   🏁 ปิดงาน / เลื่อน-ติดปัญหา ยังกดได้ทั้งหมด → ตรวจ flow แล้วพบ 3 จุดที่ทำให้ข้อมูลผิดได้จริง:
--   (1) "เลื่อนนัด" งานที่ติดตั้งครบแล้ว → แก้วันนัดติดตั้ง (install_start/end_date) ทับของจริง
--       ⇒ สถานะกำหนดส่ง/รายงานคิดจากวันนัดที่ผิด
--   (2) "ติดปัญหา" งานที่ติดตั้งครบแล้ว → ยิง install_failed เข้ากลุ่ม LINE หา Project ทั้งที่งานเสร็จ
--   (3) "ติดตั้งไม่ได้" เครื่องที่ยืนยันติดตั้งแล้ว → RPC ไม่กัน (หน้าจอแค่ซ่อนปุ่ม) พลิกเครื่องที่มี
--       GPS + รูปเป็นหลักฐานกลายเป็น blocked ได้
--   + มอบหมายทีมใหม่หลังงานจบ → ทีมในใบเปลี่ยน ไม่สะท้อนคนที่ไปติดตั้งจริง
--
-- ทางแก้: trigger บนตารางที่ 3 RPC เขียน (ไม่ patch body ที่ผ่าน app_swap_guard มาแล้วหลายรอบ — 0071)
--   · job_site_visits  BEFORE INSERT          → งานติดตั้งครบแล้ว = ไม่ให้เลื่อนนัด/บันทึกปัญหา
--   · job_assignments  BEFORE INSERT OR DELETE → งานติดตั้งครบแล้ว = ไม่ให้เปลี่ยนทีม
--       (DELETE จาก CASCADE ตอนลบ Job/ช่าง ไม่โดน — ลบได้เฉพาะ Job Draft / ช่างที่ไม่เคยถูกใช้ ซึ่งไม่มีเครื่องติดตั้ง)
--   · unit_installations BEFORE INSERT       → เครื่องที่ผลล่าสุด = installed ห้ามบันทึกซ้ำ/พลิกเป็น blocked
--   "ติดตั้งครบ" = ทุกเครื่องบนใบ (allocated + issued) มีผลล่าสุด = installed · ใบที่ยังเบิกไม่ครบไม่นับ
--   (กติกาเดียวกับ jobInstallComplete ใน logic.ts)
--
-- ⚠️ ปิดงาน (rpc_close_job_install) ไม่โดน — เป็นขั้นที่ควรทำต่อพอดี
-- demo sync: src/data/logic.ts (jobInstallComplete / assignJobTeam / logSiteVisit / blockUnitInstall)
-- รันก่อนหรือหลัง push ก็ได้ (หน้าจอใหม่ซ่อนปุ่มอยู่แล้ว · ไม่เปลี่ยน signature) · idempotent
-- =============================================================================

CREATE OR REPLACE FUNCTION app_job_install_complete(jid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM lbs_units WHERE job_id = jid)
     AND NOT EXISTS (
       SELECT 1 FROM lbs_units u
        WHERE u.job_id = jid
          AND COALESCE((SELECT ui.outcome FROM unit_installations ui
                         WHERE ui.unit_id = u.id
                         ORDER BY ui.performed_at DESC LIMIT 1), 'pending') <> 'installed')
$$;
COMMENT ON FUNCTION app_job_install_complete(UUID) IS
  '0089 — ทุกเครื่องบนใบมีผลติดตั้งล่าสุด = installed (รอแค่ปิดงาน) · sync jobInstallComplete ใน logic.ts';

-- ---------- เลื่อนนัด / ติดปัญหาหน้างาน ----------
CREATE OR REPLACE FUNCTION app_site_visit_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_no TEXT;
BEGIN
  IF app_job_install_complete(NEW.job_id) THEN
    SELECT job_no INTO v_no FROM jobs WHERE id = NEW.job_id;
    RAISE EXCEPTION '% ติดตั้งครบทุกเครื่องแล้ว — เลื่อนนัด/บันทึกปัญหาหน้างานไม่ได้ · ขั้นต่อไปคือ 🏁 ปิดงาน', v_no;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_site_visit_guard ON job_site_visits;
CREATE TRIGGER trg_site_visit_guard BEFORE INSERT ON job_site_visits
  FOR EACH ROW EXECUTE FUNCTION app_site_visit_guard();

-- ---------- มอบหมาย/เปลี่ยนทีม ----------
CREATE OR REPLACE FUNCTION app_job_assignment_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE jid UUID; v_no TEXT;
BEGIN
  jid := CASE WHEN TG_OP = 'DELETE' THEN OLD.job_id ELSE NEW.job_id END;
  IF app_job_install_complete(jid) THEN
    SELECT job_no INTO v_no FROM jobs WHERE id = jid;
    RAISE EXCEPTION '% ติดตั้งครบทุกเครื่องแล้ว — เปลี่ยนทีมไม่ได้ · ขั้นต่อไปคือ 🏁 ปิดงาน', v_no;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS trg_job_assignment_guard ON job_assignments;
CREATE TRIGGER trg_job_assignment_guard BEFORE INSERT OR DELETE ON job_assignments
  FOR EACH ROW EXECUTE FUNCTION app_job_assignment_guard();

-- ---------- ผลติดตั้งรายเครื่อง ----------
CREATE OR REPLACE FUNCTION app_unit_install_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE last_outcome TEXT; v_serial TEXT;
BEGIN
  SELECT outcome INTO last_outcome FROM unit_installations
   WHERE unit_id = NEW.unit_id ORDER BY performed_at DESC LIMIT 1;
  IF last_outcome = 'installed' THEN
    SELECT serial_lvb INTO v_serial FROM lbs_units WHERE id = NEW.unit_id;
    RAISE EXCEPTION '% ยืนยันติดตั้งไปแล้ว — % ไม่ได้', v_serial,
      CASE WHEN NEW.outcome = 'blocked' THEN 'บันทึกว่าติดตั้งไม่ได้' ELSE 'ยืนยันซ้ำ' END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_unit_install_guard ON unit_installations;
CREATE TRIGGER trg_unit_install_guard BEFORE INSERT ON unit_installations
  FOR EACH ROW EXECUTE FUNCTION app_unit_install_guard();

-- ---------- ตรวจผล ----------
DO $$
DECLARE t TEXT; n INT;
BEGIN
  FOREACH t IN ARRAY ARRAY['trg_site_visit_guard', 'trg_job_assignment_guard', 'trg_unit_install_guard'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t AND NOT tgisinternal AND tgenabled <> 'D') THEN
      RAISE EXCEPTION '0089: trigger % ไม่ได้ติดตั้ง/ถูกปิด', t;
    END IF;
  END LOOP;
  -- งานที่ติดตั้งครบแล้วตอนนี้ (รอปิดงาน) — แค่รายงานให้เห็นว่าด่านจะมีผลกับใบไหนบ้าง
  SELECT count(*) INTO n FROM jobs j
   WHERE j.terminal_status IS DISTINCT FROM 'installed' AND j.terminal_status IS DISTINCT FROM 'cancelled'
     AND app_job_install_complete(j.id);
  RAISE NOTICE '0089: OK — ล็อกงานหน้าไซต์ของใบที่ติดตั้งครบแล้ว · ตอนนี้มี % ใบที่ติดตั้งครบและรอปิดงาน', n;
END $$;
