-- =====================================================================
-- 0061: เปิดสิทธิ์ Material Database ให้แผนก Purchasing (2026-08-28)
--
--  ที่มา: ฐานข้อมูลวัสดุ (items ประเภท accessory) คือ "แคตตาล็อกของที่ใช้ตอนออก PR/PO"
--  ซึ่งคนที่รู้ของจริง (รหัส Epicor · หน่วย · ของชิ้นนี้สั่งซื้อหรือเก็บสต็อก) คือ Purchasing
--  แต่เดิม RPC ทั้ง 3 ตัวเป็น admin-only ⇒ ทุกครั้งที่มีวัสดุใหม่ต้องรอ Manage มาเพิ่มให้
--
--  เปิดให้ Purchasing: เพิ่ม / แก้ / ลบ Accessory + นำเข้า Excel (สร้าง+แก้ทีละหลายรายการ)
--  และ **ปรับยอดคลังคงเหลือ + Lot No.** ด้วย เพราะไฟล์ Import Excel มีคอลัมน์
--  "คลังคงเหลือ" + "Lot No." อยู่ในไฟล์เดียวกัน — ถ้าไม่เปิด การนำเข้าจะล้มครึ่งทาง
--  (มติผู้ใช้ 2026-08-28)
--
--  ⚠️ ที่ **ไม่ได้** เปิดให้ Purchasing — ตั้งใจแยกไว้:
--    - Project Stock / LBS รายเครื่อง (rpc_create_project_stock, rpc_add_units_to_stock,
--      rpc_update_unit_info, rpc_set_stock_fob, ...) ยังเป็น ARRAY['sales'] ตามเดิม
--      ⇒ ฝั่ง frontend จึงต้องแยก perm ใหม่ 'accessoryStock.manage' ออกจาก 'stock.manage'
--      ไม่ใช่เติม 'purchasing' ลงใน stock.manage (ไม่งั้น Purchasing แก้คลัง LBS ได้ไปด้วย)
--    - master.manage ฝั่ง frontend ยังครอบ "ข้ามขั้นอนุมัติ" (rpc_create_pr / rpc_issue_job /
--      rpc_cancel_job) + จัดการผู้ใช้ ⇒ จึงแยก perm 'material.manage' ออกมาต่างหาก
--
--  วิธีแก้: **patch เฉพาะบรรทัด app_assert_dept ด้วย app_swap_guard (§9.5/§9.6)**
--  ไม่ recreate body ทั้งก้อน เพราะ definition บน LIVE อาจผ่าน patch ของ 0031 มาแล้ว
--  (ทั้ง 5 ตัวไม่โดน 0031 แต่ยึดกฎเดียวกันไว้ ปลอดภัยกว่าและ diff เล็กกว่า)
--
--  ✅ **ไม่เปลี่ยน signature ของ RPC ตัวไหนเลย** ⇒ ไม่มีเรื่อง PGRST202/PGRST203
--     และ **รัน SQL ก่อนหรือหลัง push frontend ก็ได้** (ก่อนดีกว่า — คนที่ push แล้วเห็นปุ่ม
--     แต่ SQL ยังไม่รัน จะกดแล้วเจอ "แผนกของคุณไม่มีสิทธิ์ทำรายการนี้" จาก server)
--
--  demo sync: src/data/StoreContext.tsx (PERMISSIONS + act wiring) — logic.ts ไม่ต้องแก้
--             เพราะฟังก์ชันใน logic.ts ไม่เช็คสิทธิ์เอง ด่านเดียวคือ run(perm, ...)
--  รันหลัง 0060 · idempotent ทั้งไฟล์ (app_swap_guard ตรวจ "แก้ไปแล้ว" ให้เอง)
-- =====================================================================

-- ---------- 0) PREFLIGHT — ต้องมี app_swap_guard (0037) และ RPC ครบ 5 ตัว ----------
DO $$
DECLARE n INT;
BEGIN
  IF to_regprocedure('public.app_swap_guard(TEXT, TEXT, TEXT)') IS NULL THEN
    RAISE EXCEPTION '0061: ไม่พบ app_swap_guard — ต้องรัน 0037 ก่อน';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname IN (
     'rpc_create_item', 'rpc_update_item', 'rpc_delete_item',
     'rpc_adjust_accessory_stock', 'rpc_set_stock_lot');
  IF n < 5 THEN RAISE EXCEPTION '0061: RPC ไม่ครบ (เจอ %/5) — ต้องรัน 0002/0006/0039/0055 ก่อน', n; END IF;
END $$;

-- ---------- 1) ฐานข้อมูลวัสดุ (catalog) — admin-only → + purchasing ----------
-- ARRAY[]::TEXT[] = "ไม่มีแผนกไหนผ่าน" ซึ่ง app_assert_dept แปลว่า admin เท่านั้น
-- (มันเช็ค `p.department = ANY(allowed) OR p.department = 'admin'` เสมอ)
DO $$
BEGIN
  PERFORM app_swap_guard('rpc_create_item',
    'app_assert_dept(ARRAY[]::TEXT[])', 'app_assert_dept(ARRAY[''purchasing''])');
  PERFORM app_swap_guard('rpc_update_item',
    'app_assert_dept(ARRAY[]::TEXT[])', 'app_assert_dept(ARRAY[''purchasing''])');
  PERFORM app_swap_guard('rpc_delete_item',
    'app_assert_dept(ARRAY[]::TEXT[])', 'app_assert_dept(ARRAY[''purchasing''])');
END $$;

-- ---------- 2) ยอดคลังคงเหลือ accessory — sales → sales + purchasing ----------
-- p_new ไม่มี p_old เป็น substring (ARRAY['sales']) ≠ ARRAY['sales', 'purchasing']))
-- ⇒ รันซ้ำแล้ว app_swap_guard นับเป็น "แก้ไปแล้ว" ไม่ error
DO $$
BEGIN
  PERFORM app_swap_guard('rpc_adjust_accessory_stock',
    'app_assert_dept(ARRAY[''sales''])', 'app_assert_dept(ARRAY[''sales'', ''purchasing''])');
  PERFORM app_swap_guard('rpc_set_stock_lot',
    'app_assert_dept(ARRAY[''sales''])', 'app_assert_dept(ARRAY[''sales'', ''purchasing''])');
END $$;

-- ---------- 3) สิทธิ์ EXECUTE ----------
-- CREATE OR REPLACE รักษา grant เดิมไว้อยู่แล้ว (ต่างจาก DROP+CREATE) — ใส่ซ้ำกันพลาด
GRANT EXECUTE ON FUNCTION public.rpc_create_item(TEXT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_item(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_item(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_accessory_stock(UUID, NUMERIC, TEXT, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_stock_lot(UUID, TEXT) TO authenticated;

-- ---------- 4) ตรวจผล — ต้องผ่านทุกข้อ ----------
DO $$
DECLARE n INT;
BEGIN
  -- 4.1 catalog 3 ตัวต้องมี 'purchasing' ใน guard แล้ว และต้องไม่เหลือ ARRAY[]::TEXT[]
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('rpc_create_item', 'rpc_update_item', 'rpc_delete_item')
     AND pg_get_functiondef(p.oid) LIKE '%app_assert_dept(ARRAY[''purchasing''])%';
  IF n <> 3 THEN RAISE EXCEPTION '0061: catalog RPC ยังไม่เปิดให้ purchasing (เจอ %/3)', n; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('rpc_create_item', 'rpc_update_item', 'rpc_delete_item')
     AND pg_get_functiondef(p.oid) LIKE '%app_assert_dept(ARRAY[]::TEXT[])%';
  IF n <> 0 THEN RAISE EXCEPTION '0061: ยังเหลือ guard admin-only ใน catalog RPC (% ตัว)', n; END IF;

  -- 4.2 ยอดคลัง 2 ตัวต้องเป็น sales + purchasing
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('rpc_adjust_accessory_stock', 'rpc_set_stock_lot')
     AND pg_get_functiondef(p.oid) LIKE '%app_assert_dept(ARRAY[''sales'', ''purchasing''])%';
  IF n <> 2 THEN RAISE EXCEPTION '0061: RPC ยอดคลังคงเหลือยังไม่เปิดให้ purchasing (เจอ %/2)', n; END IF;

  -- 4.3 ต้อง **ไม่** เผลอไปแตะ Project Stock / LBS — ยังต้องเป็น sales ล้วน
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('rpc_create_project_stock', 'rpc_add_units_to_stock',
                       'rpc_update_project_stock', 'rpc_delete_project_stock',
                       'rpc_update_unit_info', 'rpc_set_stock_fob')
     AND pg_get_functiondef(p.oid) LIKE '%purchasing%';
  IF n <> 0 THEN RAISE EXCEPTION '0061: หลุดไปเปิดสิทธิ์คลัง LBS ให้ purchasing (% ตัว) — ต้องเป็นของ Division เท่านั้น', n; END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '0061 OK — Purchasing จัดการ Material Database ได้ (catalog + ยอดคลังคงเหลือ + Import/Export Excel)'; END $$;

-- ---------------------------------------------------------------------
-- rollback (ถ้าต้องถอย): กลับ guard เป็นของเดิม
-- ---------------------------------------------------------------------
-- DO $$
-- BEGIN
--   PERFORM app_swap_guard('rpc_create_item', 'app_assert_dept(ARRAY[''purchasing''])', 'app_assert_dept(ARRAY[]::TEXT[])');
--   PERFORM app_swap_guard('rpc_update_item', 'app_assert_dept(ARRAY[''purchasing''])', 'app_assert_dept(ARRAY[]::TEXT[])');
--   PERFORM app_swap_guard('rpc_delete_item', 'app_assert_dept(ARRAY[''purchasing''])', 'app_assert_dept(ARRAY[]::TEXT[])');
--   PERFORM app_swap_guard('rpc_adjust_accessory_stock', 'app_assert_dept(ARRAY[''sales'', ''purchasing''])', 'app_assert_dept(ARRAY[''sales''])');
--   PERFORM app_swap_guard('rpc_set_stock_lot', 'app_assert_dept(ARRAY[''sales'', ''purchasing''])', 'app_assert_dept(ARRAY[''sales''])');
-- END $$;
