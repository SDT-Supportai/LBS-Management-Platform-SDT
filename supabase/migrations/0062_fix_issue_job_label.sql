-- =====================================================================
-- 0062: ป้าย issue_job ที่ตกค้างใน rpc_add_approval_comment (2026-08-28)
--
--  ที่มา: 0059 เปลี่ยนความหมายของคำขอ issue_job ให้แคบลงเป็น "เบิก **LBS** ให้ Service"
--  (Accessory ที่รับของครบแล้ว Project เบิกเองได้ ไม่ผ่านคำขอนี้อีก) และแก้ป้ายไว้ 3 ที่:
--      rpc_request_approval → 'เบิก LBS ให้ Service (N เครื่อง)'
--      app_exec_approve     → 'เบิก LBS ให้ Service'
--      rpc_reject_request   → patch ผ่าน app_swap_guard
--  แต่ **ตกหล่น rpc_add_approval_comment** (ป้ายอยู่ใน CASE ของ 0051) ⇒ บน LIVE ตอนนี้
--  ความเห็นของ VIP/Division ยังแจ้งเตือนว่า "ให้ความเห็นคำขอเบิกให้ Service"
--  ขณะที่ตัวคำขอในหน้าเดียวกันเขียน "เบิก LBS ให้ Service" — คนอ่านนึกว่าคนละเรื่องกัน
--
--  ⚠️ ป้ายชุดนี้ถูกก็อปไว้ 4 ที่ · แก้ที่เดียวไม่พอ (บทเรียนจากรอบนี้):
--      1) src/data/logic.ts APPROVAL_TYPE_LABEL   → LINE + Audit ของโหมด demo
--      2) src/ui/format.ts APPROVAL_TYPE_LABEL    → ป้ายบนหน้าเว็บ
--      3) functions/line-approval-push.js         → การ์ด Flex ในแชท 1:1 ผู้อนุมัติ
--      4) SQL 4 ฟังก์ชัน (ไฟล์นี้ปิดตัวสุดท้าย)
--     (1) และ (3) แก้มาพร้อมกับ commit ที่พาไฟล์นี้เข้ามา
--
--  วิธีแก้: app_swap_guard patch เฉพาะบรรทัด (§9.5/§9.6) — ไม่ recreate body
--  เพราะ rpc_add_approval_comment เป็นของ 0051 และ **ไม่มี migration ไหนแตะตามหลัง**
--  แต่ยึดกฎ patch-บรรทัดเดียวไว้ ปลอดภัยกว่าและ diff เล็กกว่า
--
--  ✅ ไม่เปลี่ยน signature · เป็นการแก้ "ข้อความ" ล้วน ไม่แตะ logic/สิทธิ์
--     รันก่อนหรือหลัง push frontend ก็ได้
--  รันหลัง 0061 · idempotent (app_swap_guard ตรวจ "แก้ไปแล้ว" ให้เอง)
-- =====================================================================

DO $$
BEGIN
  IF to_regprocedure('public.app_swap_guard(TEXT, TEXT, TEXT)') IS NULL THEN
    RAISE EXCEPTION '0062: ไม่พบ app_swap_guard — ต้องรัน 0037 ก่อน';
  END IF;
  IF to_regprocedure('public.rpc_add_approval_comment(UUID, TEXT)') IS NULL THEN
    RAISE EXCEPTION '0062: ไม่พบ rpc_add_approval_comment — ต้องรัน 0050/0051 ก่อน';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM app_swap_guard('rpc_add_approval_comment',
    'WHEN ''issue_job''  THEN ''เบิกให้ Service''',
    'WHEN ''issue_job''  THEN ''เบิก LBS ให้ Service''');
EXCEPTION WHEN OTHERS THEN
  -- ช่องว่างใน CASE อาจต่างจากไฟล์ 0051 ถ้ามีใครแก้มือบน LIVE — ลองแบบเว้นวรรคเดียว
  PERFORM app_swap_guard('rpc_add_approval_comment',
    'WHEN ''issue_job'' THEN ''เบิกให้ Service''',
    'WHEN ''issue_job'' THEN ''เบิก LBS ให้ Service''');
END $$;

-- ---------- ตรวจผล ----------
DO $$
DECLARE n INT;
BEGIN
  -- ป้ายใหม่ต้องติดใน rpc_add_approval_comment
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_add_approval_comment'
     AND pg_get_functiondef(p.oid) LIKE '%เบิก LBS ให้ Service%';
  IF n <> 1 THEN RAISE EXCEPTION '0062: ป้ายใน rpc_add_approval_comment ยังไม่ถูกแก้'; END IF;

  -- และต้องไม่เหลือป้ายเก่าในฟังก์ชันสาย approval ทั้ง 4 ตัว
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('rpc_request_approval', 'app_exec_approve', 'rpc_reject_request', 'rpc_add_approval_comment')
     AND pg_get_functiondef(p.oid) LIKE '%''เบิกให้ Service''%';
  IF n <> 0 THEN
    RAISE EXCEPTION '0062: ยังเหลือป้าย "เบิกให้ Service" ในฟังก์ชันสาย approval % ตัว', n;
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '0062 OK — ป้าย issue_job ตรงกันครบทั้ง 4 ที่แล้ว (เบิก LBS ให้ Service)'; END $$;

-- ---------------------------------------------------------------------
-- rollback:
-- DO $$ BEGIN
--   PERFORM app_swap_guard('rpc_add_approval_comment',
--     'WHEN ''issue_job''  THEN ''เบิก LBS ให้ Service''',
--     'WHEN ''issue_job''  THEN ''เบิกให้ Service''');
-- END $$;
