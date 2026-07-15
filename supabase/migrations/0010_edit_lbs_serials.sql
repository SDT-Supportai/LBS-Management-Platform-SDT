-- =====================================================================
-- 0010: แก้ Serial.LVB / Serial.OM ของเครื่อง LBS (2026-07-15)
--  แก้ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (status = 'in_stock', job_id = NULL)
--  → ไม่กระทบ snapshot serial ใน stock_allocations/audit ของ Job ที่ดึงไปแล้ว
--  → trigger trg_block_issued_edit ไม่ยุ่ง เพราะ unit in_stock มี job_id = NULL
--  สิทธิ์: sales (+admin) เหมือนการสร้าง/รับเข้าสต็อก
--  รันหลัง 0009 (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_update_lbs_serials(p_unit_id UUID, p_serial_lvb TEXT, p_serial_om TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; lvb TEXT; om TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.status <> 'in_stock' THEN
    RAISE EXCEPTION 'แก้ Serial ได้เฉพาะเครื่องที่ยังอยู่ในสต็อก (ยังไม่ถูกดึงเข้า Job)';
  END IF;
  lvb := trim(p_serial_lvb); om := trim(p_serial_om);
  IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM'; END IF;
  IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน'; END IF;
  IF EXISTS (SELECT 1 FROM lbs_units
             WHERE id <> p_unit_id AND (serial_lvb IN (lvb, om) OR serial_om IN (lvb, om))) THEN
    RAISE EXCEPTION 'Serial No. "%" / "%" ซ้ำกับเครื่องอื่นในระบบ', lvb, om;
  END IF;

  UPDATE lbs_units SET serial_lvb = lvb, serial_om = om, updated_at = now() WHERE id = p_unit_id;
  PERFORM app_audit('lbs_unit', p_unit_id, 'update_serials', actor.id,
    'แก้ Serial: ' || u.serial_lvb || '/' || u.serial_om || ' → ' || lvb || '/' || om);
END $$;
