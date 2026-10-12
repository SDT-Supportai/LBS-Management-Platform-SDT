-- =============================================================================
-- 0083 — 🔕 ขออนุมัติไม่ประกาศเข้ากลุ่ม LINE แล้ว (2026-10-12)
--
-- ที่มา (ผู้ใช้ขอ 2026-10-12): นำ approval_requested ออกจากกลุ่ม
--
-- คำขออนุมัติไปถึงผู้อนุมัติ 2 ทางพร้อมกัน:
--   (1) การ์ด Flex พร้อมปุ่มอนุมัติในแชท 1:1 (functions/line-approval-push.js — StoreContext ยิงตรง
--       หลัง requestApproval ไม่อ่านคิว notifications เลย)
--   (2) ข้อความในกลุ่ม LINE ผ่านคิว notifications (line_status = 'pending' → line-notify.js)
-- ทาง (2) ซ้ำกับ (1) และกินโควตา push ฟรี ๆ อีกครั้งละ 1 ข้อความ ⇒ ถอดออกจาก allowlist ของ 0066/0072
--
-- ⚠️ ยังบันทึกลง notifications ครบเหมือนเดิม (ขึ้นหน้า Notifications + Audit) — แค่ line_status = 'off'
-- ⚠️ การ์ด 1:1 ไม่กระทบ — คนละ function คนละเส้นทาง
-- ⚠️ รายชื่อนี้ต้องตรงกับ LINE_PUSH_TYPES ใน src/data/logic.ts เสมอ (คนละ runtime กติกาเดียวกัน)
--
-- ไม่เปลี่ยน signature ⇒ **รันก่อนหรือหลัง push ก็ได้** · idempotent
-- =============================================================================

-- ---------- 1) allowlist LINE กลุ่ม — ถอด approval_requested ----------
CREATE OR REPLACE FUNCTION app_notify(ntype TEXT, msg TEXT, ndept TEXT, jid UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (type, message, dept, job_id, line_status)
  VALUES (ntype, msg, ndept, jid,
    CASE WHEN ntype IN (
      'pr_created',                  -- Purchasing ต้องออก PO ต่อ
      'pr_rejected',                 -- Project ต้องแก้แล้วส่งใหม่
      'approval_rejected',           -- Project ต้องแก้แล้วขอใหม่
      'po_received',                 -- เฉพาะรับครบ · รับบางส่วนใช้ type po_received_partial
      'lbs_issued_to_service',       -- ทีมช่างต้องเตรียมออกหน้างาน
      'accessory_issued_to_service', -- ของชุดไหนถึงมือทีมช่างแล้ว
      'install_failed',              -- Project ต้องเข้าไปแก้ให้ทีมเดินต่อได้
      'job_cancelled',               -- ทุกแผนกต้องหยุดทำงานกับใบนี้ทันที
      'job_ready_to_install'         -- 0072 — ใบครบเพราะโอนคืน/ตัดจำหน่าย/แก้จำนวน ไม่ใช่เพราะการเบิก
      -- 0083: approval_requested ถอดออก — ผู้อนุมัติได้การ์ด 1:1 อยู่แล้ว
    ) THEN 'pending' ELSE 'off' END);
$$;

-- ---------- 2) เคลียร์คิวค้าง ----------
-- ถ้าไม่ทำ คำขอที่ยังค้างคิวอยู่จะถูกส่งเข้ากลุ่มตอนเปิดเว็บครั้งถัดไป
UPDATE notifications SET line_status = 'off'
 WHERE line_status = 'pending' AND type = 'approval_requested';

-- ---------- 3) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE src TEXT; fn TEXT; n INT;
BEGIN
  -- ตัดคอมเมนต์ก่อนเทียบ (บทเรียนจาก 0063) — คอมเมนต์ข้างบนมีคำว่า approval_requested อยู่
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_notify';
  IF src IS NULL THEN RAISE EXCEPTION '0083: ไม่พบ app_notify'; END IF;

  IF position('''approval_requested''' IN src) > 0 THEN
    RAISE EXCEPTION '0083: approval_requested ยังอยู่ใน allowlist ของ app_notify';
  END IF;

  -- ต้องยัง INSERT ทุกใบ ห้ามข้ามการบันทึก (กติกา 0066)
  IF position('INSERT INTO notifications' IN src) = 0 THEN
    RAISE EXCEPTION '0083: app_notify ไม่ได้ INSERT แล้ว — ชนิดที่ตัดต้องยังถูกบันทึก';
  END IF;

  -- allowlist ที่เหลือต้องครบ (กันพิมพ์ใหม่แล้วตกหล่น)
  FOREACH fn IN ARRAY ARRAY['pr_created', 'pr_rejected', 'approval_rejected',
                            'po_received', 'lbs_issued_to_service', 'accessory_issued_to_service',
                            'install_failed', 'job_cancelled', 'job_ready_to_install'] LOOP
    IF position('''' || fn || '''' IN src) = 0 THEN
      RAISE EXCEPTION '0083: app_notify ตกชนิด % ออกจาก allowlist', fn;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM notifications
   WHERE line_status = 'pending' AND type = 'approval_requested';
  IF n <> 0 THEN RAISE EXCEPTION '0083: ยังมีคิว approval_requested ค้าง % แถว', n; END IF;

  RAISE NOTICE '0083: OK — ขออนุมัติไม่เข้ากลุ่ม LINE แล้ว (การ์ด 1:1 ยังส่งตามปกติ) · เหลือ 9 ชนิดในกลุ่ม';
END $$;
