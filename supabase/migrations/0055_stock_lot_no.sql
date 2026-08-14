-- =====================================================================
-- 0055: Lot No. ในคลังคงเหลือ (2026-08-14)
--  ต้องการ: มีช่องกรอก "Lot No." ให้วัสดุในคลังคงเหลือ
--
--  เก็บ 2 ที่ เพราะตอบคนละคำถาม (ห้ามยุบเหลือที่เดียว):
--    accessory_stock.lot_no  = "ตอนนี้ของในคลังเป็นล็อตไหน"  → ใช้แสดงในตารางคลังคงเหลือ
--    stock_movements.lot_no  = "ครั้งนั้นเข้า/ออกล็อตไหน"     → ใช้สอบย้อนหลังใน ledger
--  ถ้าเก็บแค่ที่แรก จะตอบไม่ได้ว่าของที่เบิกไป Job เมื่อเดือนที่แล้วเป็นล็อตอะไร
--
--  วิธีเดียวกับ 0038: ไม่ patch ทุก RPC — ส่งล็อตผ่าน "บริบท" ที่ trigger อ่าน
--    app_set_stock_lot(lot) ตั้งค่า → trigger fn_log_stock_movement หยิบไปเขียนทั้ง 2 ที่
--    RPC ตัวที่ไม่ได้ตั้งล็อต (เบิกเข้า Job / คืนจาก Job / โอน / ยกเลิก Job) ทำงานเหมือนเดิม
--    และ ledger จะบันทึกล็อตปัจจุบันของคลังให้เอง (รู้ว่าของที่ออกไปมาจากล็อตไหน)
--
--  ⚠️ ไม่แตะ signature ของ app_set_stock_ctx — ถ้าเพิ่มพารามิเตอร์จะได้ overload 2 ตัว
--     แล้ว PostgREST error ambiguous (PGRST203, §9 ข้อ 8) · จึงแยกเป็น setter ตัวใหม่
--  ⚠️ fn_log_stock_movement recreate ได้ปลอดภัย — ไม่มี app_notify จึงไม่โดน 0031 patch
--     (ตรวจแล้ว: ชื่อนี้โผล่เฉพาะใน 0038 ไฟล์เดียว — §9 ข้อ 5)
--
--  demo sync ที่ src/data/logic.ts (applyStockMovement / adjustAccessoryStock /
--    createItem / setStockLot) · รันหลัง 0054 · idempotent
-- =====================================================================

-- ---------- 1) schema ----------
ALTER TABLE accessory_stock  ADD COLUMN IF NOT EXISTS lot_no VARCHAR(60);
ALTER TABLE stock_movements  ADD COLUMN IF NOT EXISTS lot_no VARCHAR(60);
COMMENT ON COLUMN accessory_stock.lot_no IS 'Lot No. ของของที่อยู่ในคลังตอนนี้ (ล็อตล่าสุดที่รับเข้า)';
COMMENT ON COLUMN stock_movements.lot_no IS 'Lot No. ของการเคลื่อนไหวรายการนี้ — ขาออกบันทึกล็อตที่อยู่ในคลังขณะนั้น';

-- ---------- 2) บริบท "ล็อต" (transaction-local เหมือน app_set_stock_ctx) ----------
CREATE OR REPLACE FUNCTION app_set_stock_lot(p_lot TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.stock_lot', COALESCE(NULLIF(btrim(p_lot), ''), ''), true);
END $$;

-- ---------- 3) trigger: เขียน lot_no ลงทั้ง ledger และแถวคลัง ----------
-- เนื้อเดิมจาก 0038 ทุกบรรทัด + ส่วนล็อต (ทำเครื่องหมาย 0055 ไว้)
CREATE OR REPLACE FUNCTION fn_log_stock_movement() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d NUMERIC; old_qty NUMERIC; old_avg NUMERIC; uc NUMERIC; t TEXT; actor_id UUID;
        v_lot TEXT; old_lot TEXT;                                  -- 0055
BEGIN
  old_qty := COALESCE(OLD.qty_on_hand, 0);
  old_avg := COALESCE(OLD.avg_unit_cost, 0);
  old_lot := OLD.lot_no;                                           -- 0055 (INSERT → NULL)
  d := NEW.qty_on_hand - old_qty;
  IF d = 0 THEN RETURN NEW; END IF;
  IF NEW.qty_on_hand < 0 THEN RAISE EXCEPTION 'ยอดคลังคงเหลือติดลบไม่ได้'; END IF;

  uc := NULLIF(current_setting('app.stock_cost', true), '')::NUMERIC;
  t  := NULLIF(current_setting('app.stock_type', true), '');
  IF t IS NULL THEN t := 'adjust'; END IF;   -- ไม่ได้ตั้งบริบท = ปรับยอด (ยังได้ยอดครบ)
  v_lot := NULLIF(current_setting('app.stock_lot', true), '');     -- 0055

  -- ต้นทุนถัวเฉลี่ย
  IF d > 0 AND uc IS NOT NULL AND uc >= 0 THEN
    NEW.avg_unit_cost := CASE WHEN NEW.qty_on_hand > 0
      THEN (old_qty * old_avg + d * uc) / NEW.qty_on_hand ELSE uc END;
  ELSE
    NEW.avg_unit_cost := old_avg;
  END IF;
  IF NEW.qty_on_hand = 0 THEN NEW.avg_unit_cost := 0; END IF;

  -- 0055: ล็อตปัจจุบันของคลัง — ทับก็ต่อเมื่อ "ของเข้าพร้อมระบุล็อต" เท่านั้น
  --   ขาออกไม่เปลี่ยนล็อต · ขาเข้าที่ไม่ระบุล็อต (คืน/โอนจาก Job) ก็คงล็อตเดิมไว้
  --   ไม่ล้างเป็น NULL ที่นี่เด็ดขาด — การแก้/ล้างล็อตทำผ่าน rpc_set_stock_lot เท่านั้น
  IF v_lot IS NOT NULL AND d > 0 THEN
    NEW.lot_no := v_lot;
  ELSE
    NEW.lot_no := COALESCE(old_lot, NEW.lot_no);
  END IF;

  BEGIN actor_id := auth.uid(); EXCEPTION WHEN OTHERS THEN actor_id := NULL; END;

  INSERT INTO stock_movements (item_id, qty, unit_cost, balance_after, movement_type,
    ref_job_id, ref_request_id, note, performed_by, lot_no)
  VALUES (NEW.item_id, d,
    CASE WHEN d > 0 THEN uc ELSE NULLIF(old_avg, 0) END,
    NEW.qty_on_hand, t,
    NULLIF(current_setting('app.stock_job', true), '')::UUID,
    NULLIF(current_setting('app.stock_req', true), '')::UUID,
    NULLIF(current_setting('app.stock_note', true), ''),
    actor_id,
    -- ขาเข้า = ล็อตที่ระบุมา · ขาออก = ล็อตที่อยู่ในคลังขณะนั้น (ตอบได้ว่าของที่ออกไปคือล็อตไหน)
    COALESCE(v_lot, old_lot));

  -- ล้างบริบท กันรั่วไปรายการถัดไปใน transaction เดียวกัน
  PERFORM app_set_stock_ctx(NULL, NULL, NULL, NULL, NULL);
  PERFORM app_set_stock_lot(NULL);                                 -- 0055
  RETURN NEW;
END $$;

-- trigger เดิมชี้ฟังก์ชันชื่อเดิมอยู่แล้ว — สร้างใหม่ให้ชัวร์ว่ายังผูกอยู่หลัง replace
DROP TRIGGER IF EXISTS trg_log_stock_movement ON accessory_stock;
CREATE TRIGGER trg_log_stock_movement
BEFORE INSERT OR UPDATE OF qty_on_hand ON accessory_stock
FOR EACH ROW EXECUTE FUNCTION fn_log_stock_movement();

-- ---------- 4) rpc_adjust_accessory_stock — เพิ่ม p_lot_no (signature ใหม่) ----------
-- DROP ตัวเดิมก่อนเสมอ ไม่งั้นเหลือ 2 overload → PostgREST error ambiguous (§9 ข้อ 8)
DROP FUNCTION IF EXISTS rpc_adjust_accessory_stock(UUID, NUMERIC, TEXT, NUMERIC);
CREATE OR REPLACE FUNCTION rpc_adjust_accessory_stock(
  p_item_id UUID, p_new_qty NUMERIC, p_note TEXT, p_unit_cost NUMERIC DEFAULT NULL,
  p_lot_no TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; it items; oldqty NUMERIC; delta NUMERIC; v_lot TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL OR NOT it.is_stockable_centrally THEN RAISE EXCEPTION 'รายการนี้ไม่มีสต็อกกลาง'; END IF;
  IF p_new_qty IS NULL OR p_new_qty < 0 THEN RAISE EXCEPTION 'ยอดคงเหลือติดลบไม่ได้'; END IF;
  IF trim(COALESCE(p_note, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการปรับยอด (เพื่อ audit)'; END IF;
  IF p_unit_cost IS NOT NULL AND p_unit_cost < 0 THEN RAISE EXCEPTION 'ต้นทุนต่อหน่วยติดลบไม่ได้'; END IF;
  v_lot := NULLIF(btrim(COALESCE(p_lot_no, '')), '');

  SELECT COALESCE(qty_on_hand, 0) INTO oldqty FROM accessory_stock WHERE item_id = p_item_id;
  oldqty := COALESCE(oldqty, 0);
  delta := p_new_qty - oldqty;
  IF delta = 0 THEN RAISE EXCEPTION 'ยอดใหม่เท่ากับยอดเดิม ไม่มีอะไรต้องปรับ'; END IF;

  -- ใส่ต้นทุน/ล็อตได้เฉพาะขาเข้า (ยอดเพิ่ม) — ขาออกไม่กระทบต้นทุนถัวเฉลี่ยและไม่เปลี่ยนล็อต
  PERFORM app_set_stock_ctx('adjust', NULL, NULL, trim(p_note),
    CASE WHEN delta > 0 THEN p_unit_cost ELSE NULL END);
  PERFORM app_set_stock_lot(CASE WHEN delta > 0 THEN v_lot ELSE NULL END);
  INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost) VALUES (p_item_id, p_new_qty, 0)
  ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand, updated_at = now();

  PERFORM app_audit('accessory_stock', p_item_id, 'adjust_stock', actor.id,
    'ปรับยอดคลังคงเหลือ ' || it.name || ': ' || oldqty || ' → ' || p_new_qty || ' ' || it.uom ||
    CASE WHEN delta > 0 AND p_unit_cost IS NOT NULL THEN ' @ ' || p_unit_cost || ' บาท/' || it.uom ELSE '' END ||
    CASE WHEN delta > 0 AND v_lot IS NOT NULL THEN ' · Lot ' || v_lot ELSE '' END ||
    ' (' || trim(p_note) || ')');
END $$;

-- ---------- 5) rpc_create_item — เพิ่ม p_initial_lot (signature ใหม่) ----------
DROP FUNCTION IF EXISTS rpc_create_item(TEXT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC, NUMERIC);
CREATE OR REPLACE FUNCTION rpc_create_item(
  p_code TEXT, p_epicor_code TEXT, p_name TEXT, p_uom TEXT, p_stockable BOOLEAN,
  p_initial_qty NUMERIC, p_initial_unit_cost NUMERIC DEFAULT NULL,
  p_initial_lot TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; iid UUID; ep TEXT; q0 NUMERIC; v_lot TEXT;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);   -- admin เท่านั้น (เหมือนเดิม)
  IF trim(COALESCE(p_code, '')) = '' OR trim(COALESCE(p_name, '')) = '' THEN
    RAISE EXCEPTION 'กรุณาระบุรหัสและชื่อ Accessory';
  END IF;
  ep := NULLIF(trim(COALESCE(p_epicor_code, '')), '');
  IF EXISTS (SELECT 1 FROM items WHERE lower(code) = lower(trim(p_code))) THEN
    RAISE EXCEPTION 'รหัส "%" มีอยู่แล้ว', trim(p_code);
  END IF;
  IF ep IS NOT NULL AND EXISTS (SELECT 1 FROM items WHERE lower(epicor_code) = lower(ep)) THEN
    RAISE EXCEPTION 'รหัส Epicor "%" มีอยู่แล้ว', ep;
  END IF;
  IF p_initial_unit_cost IS NOT NULL AND p_initial_unit_cost < 0 THEN
    RAISE EXCEPTION 'ต้นทุนต่อหน่วยติดลบไม่ได้';
  END IF;
  v_lot := NULLIF(btrim(COALESCE(p_initial_lot, '')), '');

  INSERT INTO items (code, epicor_code, name, item_type, uom, is_stockable_centrally)
  VALUES (trim(p_code), ep, trim(p_name), 'accessory', COALESCE(NULLIF(trim(p_uom), ''), 'ชิ้น'), p_stockable)
  RETURNING id INTO iid;

  IF p_stockable THEN
    q0 := GREATEST(0, COALESCE(p_initial_qty, 0));
    -- ต้องมีแถวคลังเสมอ (ยอด 0 ก็ได้) — ใช้ ctx ให้ trigger ลง ledger เป็น 'initial' + คิดต้นทุน
    IF q0 > 0 THEN
      PERFORM app_set_stock_ctx('initial', NULL, NULL, 'ยอดเริ่มต้นตอนสร้างวัสดุ', p_initial_unit_cost);
      PERFORM app_set_stock_lot(v_lot);
    END IF;
    INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost) VALUES (iid, q0, 0);
  END IF;

  PERFORM app_audit('item', iid, 'create_item', actor.id,
    'เพิ่ม Accessory ' || trim(p_name) || ' (' || trim(p_code) || ')' ||
    CASE WHEN p_stockable AND COALESCE(p_initial_qty, 0) > 0
      THEN ' · ยอดตั้งต้น ' || p_initial_qty ||
           COALESCE(' @ ' || p_initial_unit_cost || ' บาท', ' (ไม่ระบุต้นทุน)') ||
           COALESCE(' · Lot ' || v_lot, '')
      ELSE '' END);
  RETURN iid;
END $$;

-- ---------- 6) rpc_set_stock_lot — แก้ Lot No. อย่างเดียว ไม่แตะยอด ----------
-- จำเป็นเพราะ rpc_adjust_accessory_stock ปฏิเสธเมื่อยอดใหม่ = ยอดเดิม
-- (พิมพ์ล็อตผิดแล้วจะแก้ ไม่ควรต้องปรับยอดขึ้น-ลงหลอกๆ ให้ ledger สกปรก)
-- ไม่ลง stock_movements เพราะของไม่ได้เคลื่อนไหว — ร่องรอยอยู่ใน audit_logs แทน
CREATE OR REPLACE FUNCTION rpc_set_stock_lot(p_item_id UUID, p_lot_no TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; it items; old_lot TEXT; v_lot TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL OR NOT it.is_stockable_centrally THEN RAISE EXCEPTION 'รายการนี้ไม่มีสต็อกกลาง'; END IF;
  SELECT lot_no INTO old_lot FROM accessory_stock WHERE item_id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ยังไม่มีแถวคลังของวัสดุนี้ — ปรับยอดเข้าคลังก่อน'; END IF;
  v_lot := NULLIF(btrim(COALESCE(p_lot_no, '')), '');   -- เว้นว่าง = ล้าง Lot No.
  IF v_lot IS NOT DISTINCT FROM old_lot THEN RAISE EXCEPTION 'Lot No. เหมือนเดิม ไม่มีอะไรต้องแก้'; END IF;

  -- ไม่แตะ qty_on_hand → trigger trg_log_stock_movement ไม่ทำงาน (ผูกกับ UPDATE OF qty_on_hand)
  UPDATE accessory_stock SET lot_no = v_lot, updated_at = now() WHERE item_id = p_item_id;

  PERFORM app_audit('accessory_stock', p_item_id, 'set_stock_lot', actor.id,
    'แก้ Lot No. คลังคงเหลือ ' || it.name || ': ' ||
    COALESCE(old_lot, '(ไม่ระบุ)') || ' → ' || COALESCE(v_lot, '(ไม่ระบุ)'));
END $$;

-- ---------- 7) สิทธิ์ ----------
GRANT EXECUTE ON FUNCTION public.app_set_stock_lot(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_stock_lot(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_accessory_stock(UUID, NUMERIC, TEXT, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_item(TEXT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC, NUMERIC, TEXT) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0055 OK — Lot No. ในคลังคงเหลือ (accessory_stock.lot_no + stock_movements.lot_no)'; END $$;
