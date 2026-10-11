-- =============================================================================
-- 0081 — 🔀 ย้าย Contract No. ไปเครื่อง LBS ใหม่ พร้อมเอกสารแนบ (2026-10-11)
--
-- ที่มา (ผู้ใช้ขอ 2026-10-11): ถ้าย้าย Contract No. ไป Serial ใหม่ ต้องย้ายสิ่งแนบไปด้วย
--   เดิมทำได้ทางเดียวคือ "แก้ข้อมูล" ลบเลขสัญญาจากเครื่องเก่า แล้วพิมพ์ใส่เครื่องใหม่
--   ⇒ เอกสารสัญญา (lbs_unit_files · 0074) ค้างอยู่ที่เครื่องเก่า · ข้อมูลลูกค้าต้องพิมพ์ใหม่
--   · ไม่มีบันทึกว่าสัญญานี้ "ย้าย" มาจากไหน (audit เห็นแค่แก้ 2 เครื่องแยกกัน)
--
-- RPC เดียว atomic: ย้าย contract_no + ข้อมูลลูกค้าที่ผูกกับสัญญา (customer · contact · location ·
--   Plan PO receipt · Plan Delivery) + ไฟล์แนบที่เลือก จากเครื่องต้นทาง → เครื่องปลายทาง
--   เครื่องต้นทางกลับเป็น "ยังไม่มีสัญญา" (ข้อมูลลูกค้าถูกล้าง — ไม่งั้นค้างเป็นข้อมูลของลูกค้ารายอื่น)
--
-- กติกา (ตรงกับ rpc_update_unit_plan ของ 0073):
--   · Division + Manage · ทั้ง 2 เครื่องต้องยังไม่ถูกเบิกให้ Service (allocation ล็อก)
--   · ปลายทางต้องยังไม่มี Contract No. (กันทับสัญญาอีกใบเงียบ ๆ) · เหตุผลบังคับ
--   · ไฟล์ที่ไม่ได้เลือก (เช่น รูปสภาพเครื่องเก่า) คงอยู่กับเครื่องเดิม
--   · path ใน storage ไม่เปลี่ยน (เป็นแค่ key) — ย้ายเฉพาะแถว unit_id
--
-- demo sync ที่ src/data/logic.ts (moveUnitContract) · รันหลัง 0080 · idempotent · **ต้องรันก่อน push**
-- =============================================================================

CREATE OR REPLACE FUNCTION rpc_move_unit_contract(
  p_from_unit_id UUID, p_to_unit_id UUID, p_file_ids UUID[] DEFAULT '{}', p_reason TEXT DEFAULT NULL
) RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; a lbs_units; b lbs_units; rsn TEXT; n INT := 0; names TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);   -- Division + Manage (สิทธิ์เดียวกับแก้ข้อมูลรายเครื่อง)
  rsn := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF rsn IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ย้าย Contract'; END IF;
  IF p_from_unit_id IS NULL OR p_to_unit_id IS NULL OR p_from_unit_id = p_to_unit_id THEN
    RAISE EXCEPTION 'กรุณาเลือกเครื่องปลายทางที่ไม่ใช่เครื่องเดิม';
  END IF;

  -- ล็อกตามลำดับ id กัน deadlock เมื่อ 2 คนย้ายสวนทางกัน
  PERFORM 1 FROM lbs_units WHERE id IN (p_from_unit_id, p_to_unit_id) ORDER BY id FOR UPDATE;
  SELECT * INTO a FROM lbs_units WHERE id = p_from_unit_id;
  SELECT * INTO b FROM lbs_units WHERE id = p_to_unit_id;
  IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF a.contract_no IS NULL THEN RAISE EXCEPTION 'Serial % ยังไม่มี Contract No. ให้ย้าย', a.serial_lvb; END IF;
  IF b.contract_no IS NOT NULL THEN
    RAISE EXCEPTION 'Serial % มี Contract No. % อยู่แล้ว — ย้ายทับไม่ได้', b.serial_lvb, b.contract_no;
  END IF;
  IF a.status = 'issued' OR b.status = 'issued' THEN
    RAISE EXCEPTION 'เครื่องที่เบิกให้ Service แล้วย้าย Contract ไม่ได้ (allocation ถูกล็อก)';
  END IF;
  -- ไฟล์ที่ส่งมาต้องเป็นของเครื่องต้นทางทั้งหมด
  IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_file_ids, '{}')) fid
              WHERE NOT EXISTS (SELECT 1 FROM lbs_unit_files f WHERE f.id = fid AND f.unit_id = a.id)) THEN
    RAISE EXCEPTION 'มีไฟล์ที่ไม่ใช่เอกสารของ Serial %', a.serial_lvb;
  END IF;

  -- ปลายทางก่อน (CHECK lbs_units_contract_needs_info_ck: มีสัญญาต้องมีลูกค้า+สถานที่ ถ้ายังไม่ผูก Job)
  UPDATE lbs_units SET
    contract_no = a.contract_no,
    plan_customer_name = a.plan_customer_name, plan_contact_phone = a.plan_contact_phone,
    plan_install_location = a.plan_install_location,
    plan_po_date = a.plan_po_date, plan_delivery_date = a.plan_delivery_date,
    updated_at = now()
  WHERE id = b.id;
  UPDATE lbs_units SET
    contract_no = NULL, plan_customer_name = NULL, plan_contact_phone = NULL, plan_install_location = NULL,
    plan_po_date = NULL, plan_delivery_date = NULL, updated_at = now()
  WHERE id = a.id;

  SELECT COUNT(*), string_agg(file_name, ', ') INTO n, names
    FROM lbs_unit_files WHERE id = ANY(COALESCE(p_file_ids, '{}'));
  UPDATE lbs_unit_files SET unit_id = b.id WHERE id = ANY(COALESCE(p_file_ids, '{}'));

  PERFORM app_audit('lbs_unit', b.id, 'move_unit_contract', actor.id,
    'รับ Contract ' || a.contract_no || ' ย้ายมาจาก ' || a.serial_lvb || ' → ' || b.serial_lvb ||
    ' · เอกสารแนบ ' || n || ' ไฟล์' || COALESCE(' (' || names || ')', '') || ' — ' || rsn);
  PERFORM app_audit('lbs_unit', a.id, 'move_unit_contract', actor.id,
    'ย้าย Contract ' || a.contract_no || ' ออกไปที่ ' || b.serial_lvb || ' (ล้างข้อมูลลูกค้าของเครื่องนี้) — ' || rsn);
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.rpc_move_unit_contract(UUID, UUID, UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_move_unit_contract(UUID, UUID, UUID[], TEXT) TO authenticated;

DO $$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.rpc_move_unit_contract(UUID, UUID, UUID[], TEXT)', 'EXECUTE') THEN
    RAISE EXCEPTION '0081: authenticated เรียก rpc_move_unit_contract ไม่ได้';
  END IF;
  RAISE NOTICE '0081: OK — ย้าย Contract No. ไปเครื่องใหม่พร้อมเอกสารแนบได้';
END $$;
