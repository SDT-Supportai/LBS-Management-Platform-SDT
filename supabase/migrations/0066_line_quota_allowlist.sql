-- =====================================================================
-- 0066: allowlist แจ้งเตือน LINE — ให้พอกับโควตา 300 ข้อความ/เดือน (2026-09-02)
--
--  ที่มา: LINE Messaging API ของบัญชีนี้มีโควตา push แค่ **300 ข้อความ/เดือน**
--  แต่ระบบยิงอยู่ 24 ชนิด และหลายตัวยิง "ต่อบรรทัด/ต่อเครื่อง" ไม่ใช่ต่อเหตุการณ์:
--      accessory_issued      → ยิงต่อบรรทัดวัสดุ · Job มีวัสดุ 10 รายการ = 10 ข้อความ
--      po_received (บางส่วน) → ยิงทุกครั้งที่กดรับของ · PO ทยอยมา 3 รอบ = 3 ข้อความ
--      unit_install_blocked  → ยิงต่อเครื่องที่ติดตั้งไม่ได้
--      การ์ดอนุมัติ 1:1      → คิด **รายคน** · ผู้อนุมัติ 2 คน = 3 ข้อความต่อการขอ 1 ครั้ง
--  รวมแล้ว 1 Job กิน ~20 ข้อความ ⇒ ที่ 15 Job/เดือน = เต็มโควตาพอดี ไม่เหลือเผื่อเลย
--
--  เกณฑ์เดียวที่ใช้ตัด (มติผู้ใช้ 2026-09-02):
--    **"ถ้าไม่รู้ตอนนี้ มีใครทำงานต่อไม่ได้ไหม"**
--    ถ้าไม่มีใครถูกบล็อก → ไปดูในเว็บ หรือถามบอท (ข้อความ reply ของบอท **ไม่กินโควตา**)
--
--  ⚠️⚠️ ชนิดที่ตัดออก **ยังถูกบันทึกลง notifications ครบเหมือนเดิม** — ขึ้นหน้า Notifications
--     และ Audit Log ตามปกติ · เปลี่ยนแค่ line_status จาก 'pending' เป็น 'off' ตั้งแต่ตอน insert
--     จึงไม่ถูก rpc_claim_line_pending หยิบไปส่ง · **ห้ามแก้เป็น "ไม่ insert เลย"** เด็ดขาด
--     เพราะหน้า Notifications กับการไล่ประวัติจะโหว่โดยไม่มีใครรู้ตัว
--
--  หลังตัด: ~10 ข้อความ/Job ⇒ ที่ 15 Job = ~150/เดือน เหลือเผื่อ ~150
--  สำหรับเหตุไม่ปกติ (ตีกลับ PR/คำขอ · ติดปัญหาหน้างาน · ยกเลิกงาน)
--
--  ✅ แก้ที่ app_notify ที่เดียว — RPC 20 กว่าตัวที่เรียกมันไม่ต้องแตะเลย
--     + patch ข้อความ 3 ใบให้กระชับ และแยก type ของ "รับของบางส่วน" ออกจาก "รับครบ"
--  demo sync: src/data/logic.ts (LINE_PUSH_TYPES + notify) + 3 เคสใน logic.test.ts
--  รันหลัง 0065 · idempotent
-- =====================================================================

-- ---------- 1) app_notify — ตัดสินตั้งแต่ต้นทางว่าเข้าคิว LINE ไหม ----------
-- ⚠️ รายชื่อนี้ต้องตรงกับ LINE_PUSH_TYPES ใน src/data/logic.ts เสมอ (คนละ runtime กติกาเดียวกัน)
CREATE OR REPLACE FUNCTION app_notify(ntype TEXT, msg TEXT, ndept TEXT, jid UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (type, message, dept, job_id, line_status)
  VALUES (ntype, msg, ndept, jid,
    CASE WHEN ntype IN (
      'pr_created',                  -- Purchasing ต้องออก PO ต่อ
      'pr_rejected',                 -- Project ต้องแก้แล้วส่งใหม่
      'approval_requested',          -- Division ต้องตัดสิน งานค้างทั้งสายจนกว่าจะกด
      'approval_rejected',           -- Project ต้องแก้แล้วขอใหม่
      'po_received',                 -- เฉพาะรับครบ · รับบางส่วนใช้ type po_received_partial
      'lbs_issued_to_service',       -- ทีมช่างต้องเตรียมออกหน้างาน
      'accessory_issued_to_service', -- ของชุดไหนถึงมือทีมช่างแล้ว
      'install_failed',              -- Project ต้องเข้าไปแก้ให้ทีมเดินต่อได้
      'job_cancelled'                -- ทุกแผนกต้องหยุดทำงานกับใบนี้ทันที
    ) THEN 'pending' ELSE 'off' END);
$$;

-- ---------- 2) รับของบางส่วน: แยก type + ข้อความบอกว่าทำอะไรต่อได้ ----------
-- patch เฉพาะบรรทัด (§9.5/§9.6) — rpc_receive_po_items ผ่าน 0022 · 0031 · 0057 มาแล้ว ห้าม recreate
DO $$
BEGIN
  -- 2.1 แยก type: รับครบ = po_received (เข้า LINE) · บางส่วน = po_received_partial (ไม่เข้า)
  PERFORM app_swap_guard('rpc_receive_po_items',
    'PERFORM app_notify(''po_received'',',
    'PERFORM app_notify(CASE WHEN po_complete THEN ''po_received'' ELSE ''po_received_partial'' END,');
END $$;

DO $$
BEGIN
  -- 2.2 ข้อความ: เดิมบอกแค่ "รับของครบแล้ว" ซึ่งไม่ได้บอกว่าทำอะไรต่อได้
  PERFORM app_swap_guard('rpc_receive_po_items',
    ''') รับ'' || CASE WHEN po_complete THEN ''ของครบแล้ว'' ELSE ''บางส่วน: '' || parts END',
    ''') '' || CASE WHEN po_complete THEN ''ของครบ — เบิกให้ Service ได้แล้ว'' ELSE ''รับบางส่วน: '' || parts END');
EXCEPTION WHEN OTHERS THEN
  -- ข้อความผ่าน patch มาหลายชั้น (0031) — ถ้ารูปไม่ตรง ข้ามไป ไม่ใช่ logic
  RAISE NOTICE '0066: ข้ามการแก้ข้อความ po_received (%)', SQLERRM;
END $$;

-- ---------- 3) ข้อความกระชับอีก 2 ใบ ----------
DO $$
BEGIN
  -- ขออนุมัติ: ตัด " · โดย {ชื่อ}" — การ์ดในแชท 1:1 มีชื่อผู้ขออยู่แล้ว
  PERFORM app_swap_guard('rpc_request_approval',
    ''' ขออนุมัติ'' || type_label || '' · โดย '' || actor.full_name',
    ''' ขออนุมัติ'' || type_label');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0066: ข้ามการแก้ข้อความ approval_requested (%)', SQLERRM;
END $$;

DO $$
BEGIN
  -- ยกเลิก Job: ตัดท้าย "คืน LBS n + Accessory เข้าคลัง" — ระบบทำให้เองอยู่แล้ว
  PERFORM app_swap_guard('app_exec_cancel_job',
    ''' · คืน LBS '' || returned || '' + Accessory เข้าคลัง''',
    '''''');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0066: ข้ามการแก้ข้อความ job_cancelled (%)', SQLERRM;
END $$;

-- ---------- 4) เคลียร์คิวเก่าที่ค้างอยู่ของชนิดที่ตัดออกแล้ว ----------
-- ถ้าไม่ทำ พอเปิดเว็บครั้งถัดไป คิวเก่าจะถูกส่งออกไปกินโควตาทั้งก้อน
UPDATE notifications SET line_status = 'off'
 WHERE line_status = 'pending'
   AND type NOT IN (
     'pr_created', 'pr_rejected', 'approval_requested', 'approval_rejected',
     'po_received', 'lbs_issued_to_service', 'accessory_issued_to_service',
     'install_failed', 'job_cancelled');

-- ---------- 5) ตรวจผล ----------
-- ตัดคอมเมนต์ก่อนเทียบ (บทเรียนจาก 0063) และเช็คที่พฤติกรรมจริง ไม่ใช่ชื่อ event
DO $$
DECLARE src TEXT; nm TEXT; n INT;
BEGIN
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_notify';
  IF src IS NULL THEN RAISE EXCEPTION '0066: ไม่พบ app_notify'; END IF;

  -- ต้องมีทั้ง 2 ทาง: เข้าคิว (pending) และไม่เข้าคิว (off)
  IF position('''pending''' IN src) = 0 OR position('''off''' IN src) = 0 THEN
    RAISE EXCEPTION '0066: app_notify ยังไม่มี allowlist (ไม่เจอทั้ง pending และ off)';
  END IF;

  -- ต้องยัง INSERT ทุกใบ ห้ามข้ามการบันทึก
  IF position('INSERT INTO notifications' IN src) = 0 THEN
    RAISE EXCEPTION '0066: app_notify ไม่ได้ INSERT แล้ว — ชนิดที่ตัดต้องยังถูกบันทึก';
  END IF;

  -- ทั้ง 9 ชนิดที่เก็บไว้ต้องอยู่ในเงื่อนไขจริง
  FOREACH nm IN ARRAY ARRAY['pr_created', 'pr_rejected', 'approval_requested', 'approval_rejected',
                             'po_received', 'lbs_issued_to_service', 'accessory_issued_to_service',
                             'install_failed', 'job_cancelled'] LOOP
    SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'app_notify'
       AND regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') LIKE '%''' || nm || '''%';
    IF n <> 1 THEN RAISE EXCEPTION '0066: ไม่เจอชนิด % ใน allowlist ของ app_notify', nm; END IF;
  END LOOP;

  -- ต้องไม่เหลือคิวค้างของชนิดที่ตัดออก
  SELECT count(*) INTO n FROM notifications
   WHERE line_status = 'pending'
     AND type NOT IN ('pr_created', 'pr_rejected', 'approval_requested', 'approval_rejected',
                      'po_received', 'lbs_issued_to_service', 'accessory_issued_to_service',
                      'install_failed', 'job_cancelled');
  IF n <> 0 THEN RAISE EXCEPTION '0066: ยังมีคิวค้างของชนิดที่ตัดออก % แถว', n; END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '0066 OK — เหลือ 9 ชนิดที่ยิงเข้า LINE · ที่เหลือยังบันทึกครบแต่ line_status = off'; END $$;

-- ---------------------------------------------------------------------
-- ปรับรายการทีหลัง: แก้ CASE ใน app_notify (ข้อ 1) + LINE_PUSH_TYPES ใน logic.ts ให้ตรงกัน
-- rollback ทั้งหมด: CREATE OR REPLACE app_notify กลับเป็นเวอร์ชัน 0002 (VALUES … 'pending')
--   แล้วรัน section ที่เกี่ยวข้องของ 0031 ซ้ำเพื่อคืนข้อความเดิม
-- ---------------------------------------------------------------------
