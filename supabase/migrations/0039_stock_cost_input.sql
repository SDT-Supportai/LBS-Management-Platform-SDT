-- =====================================================================
-- 0039: ใส่ต้นทุนได้ตอนของเข้าคลัง (2026-07-30)
--  ปัญหา: 0038 คิดต้นทุนถัวเฉลี่ยได้ แต่ "ขาเข้า" 2 ทางไม่มีที่ให้ใส่ต้นทุนเลย
--    → avg_unit_cost = 0 → คอลัมน์ "ต้นทุนถัวเฉลี่ย/มูลค่า" ในคลังคงเหลือขึ้น "-" ตลอด
--    (ทางที่มีต้นทุนอยู่แล้ว: คืนของจาก Job · โอนจาก Job · ยกเลิก Job — ใช้ราคาของ line)
--  แก้: เพิ่มพารามิเตอร์ต้นทุนให้ 2 RPC + ส่งเข้า app_set_stock_ctx ให้ trigger คิดค่าเฉลี่ย
--    - rpc_create_item          + p_initial_unit_cost  (ยอดตั้งต้นตอนสร้างวัสดุ)
--    - rpc_adjust_accessory_stock + p_unit_cost        (ปรับยอดขึ้น = ของเข้า)
--  หมายเหตุ: ทั้ง 2 ฟังก์ชันไม่มี app_notify → recreate ได้ ไม่กระทบการย่อข้อความของ 0031
--  demo sync ที่ src/data/logic.ts · รันหลัง 0038 · idempotent
-- =====================================================================

-- ---------- 1) rpc_create_item — เพิ่ม p_initial_unit_cost (signature ใหม่) ----------
DROP FUNCTION IF EXISTS rpc_create_item(TEXT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC);
CREATE OR REPLACE FUNCTION rpc_create_item(
  p_code TEXT, p_epicor_code TEXT, p_name TEXT, p_uom TEXT, p_stockable BOOLEAN,
  p_initial_qty NUMERIC, p_initial_unit_cost NUMERIC DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; iid UUID; ep TEXT; q0 NUMERIC;
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

  INSERT INTO items (code, epicor_code, name, item_type, uom, is_stockable_centrally)
  VALUES (trim(p_code), ep, trim(p_name), 'accessory', COALESCE(NULLIF(trim(p_uom), ''), 'ชิ้น'), p_stockable)
  RETURNING id INTO iid;

  IF p_stockable THEN
    q0 := GREATEST(0, COALESCE(p_initial_qty, 0));
    -- ต้องมีแถวคลังเสมอ (ยอด 0 ก็ได้) — ใช้ ctx ให้ trigger ลง ledger เป็น 'initial' + คิดต้นทุน
    IF q0 > 0 THEN
      PERFORM app_set_stock_ctx('initial', NULL, NULL, 'ยอดเริ่มต้นตอนสร้างวัสดุ', p_initial_unit_cost);
    END IF;
    INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost) VALUES (iid, q0, 0);
  END IF;

  PERFORM app_audit('item', iid, 'create_item', actor.id,
    'เพิ่ม Accessory ' || trim(p_name) || ' (' || trim(p_code) || ')' ||
    CASE WHEN p_stockable AND COALESCE(p_initial_qty, 0) > 0
      THEN ' · ยอดตั้งต้น ' || p_initial_qty ||
           COALESCE(' @ ' || p_initial_unit_cost || ' บาท', ' (ไม่ระบุต้นทุน)')
      ELSE '' END);
  RETURN iid;
END $$;

-- ---------- 2) rpc_adjust_accessory_stock — เพิ่ม p_unit_cost (signature ใหม่) ----------
DROP FUNCTION IF EXISTS rpc_adjust_accessory_stock(UUID, NUMERIC, TEXT);
CREATE OR REPLACE FUNCTION rpc_adjust_accessory_stock(
  p_item_id UUID, p_new_qty NUMERIC, p_note TEXT, p_unit_cost NUMERIC DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; it items; oldqty NUMERIC; delta NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL OR NOT it.is_stockable_centrally THEN RAISE EXCEPTION 'รายการนี้ไม่มีสต็อกกลาง'; END IF;
  IF p_new_qty IS NULL OR p_new_qty < 0 THEN RAISE EXCEPTION 'ยอดคงเหลือติดลบไม่ได้'; END IF;
  IF trim(COALESCE(p_note, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการปรับยอด (เพื่อ audit)'; END IF;
  IF p_unit_cost IS NOT NULL AND p_unit_cost < 0 THEN RAISE EXCEPTION 'ต้นทุนต่อหน่วยติดลบไม่ได้'; END IF;

  SELECT COALESCE(qty_on_hand, 0) INTO oldqty FROM accessory_stock WHERE item_id = p_item_id;
  oldqty := COALESCE(oldqty, 0);
  delta := p_new_qty - oldqty;
  IF delta = 0 THEN RAISE EXCEPTION 'ยอดใหม่เท่ากับยอดเดิม ไม่มีอะไรต้องปรับ'; END IF;

  -- ใส่ต้นทุนได้เฉพาะขาเข้า (ยอดเพิ่ม) — ขาออกไม่กระทบต้นทุนถัวเฉลี่ย
  PERFORM app_set_stock_ctx('adjust', NULL, NULL, trim(p_note),
    CASE WHEN delta > 0 THEN p_unit_cost ELSE NULL END);
  INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost) VALUES (p_item_id, p_new_qty, 0)
  ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand, updated_at = now();

  PERFORM app_audit('accessory_stock', p_item_id, 'adjust_stock', actor.id,
    'ปรับยอดคลังคงเหลือ ' || it.name || ': ' || oldqty || ' → ' || p_new_qty || ' ' || it.uom ||
    CASE WHEN delta > 0 AND p_unit_cost IS NOT NULL THEN ' @ ' || p_unit_cost || ' บาท/' || it.uom ELSE '' END ||
    ' (' || trim(p_note) || ')');
END $$;

-- ---------- 3) สิทธิ์ ----------
GRANT EXECUTE ON FUNCTION public.rpc_create_item(TEXT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_accessory_stock(UUID, NUMERIC, TEXT, NUMERIC) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0039 OK — ใส่ต้นทุนตอนของเข้าคลังได้แล้ว (สร้างวัสดุ / ปรับยอดขึ้น)'; END $$;
