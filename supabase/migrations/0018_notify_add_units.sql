-- =====================================================================
-- 0018: แก้ rpc_add_units_to_stock (2026-07-19)
--  บั๊ก #1 (ร้ายแรง): Import Serial / รับ LBS เพิ่มเข้าคลังเดิม → error
--        "column customer_name of relation lbs_units does not exist"
--        สาเหตุ: 0013 recreate rpc_add_units_to_stock ให้ insert customer_name/
--        contact_phone/install_location ลง lbs_units → 0014 ลบ 3 คอลัมน์นั้นออก
--        แต่ "ลืม recreate rpc_add_units_to_stock" (recreate เฉพาะ create_project_stock)
--        → ฟังก์ชันบน DB ยัง insert คอลัมน์ที่ไม่มีแล้ว = พังทุกครั้ง
--  บั๊ก #2: ฟังก์ชันไม่มี app_notify — รับเพิ่มเข้าคลังเดิม/Excel Import ไม่แจ้ง LINE
--        (มีแต่ตอนสร้างคลังใหม่ที่ส่ง stock_created)
--  แก้ทั้งคู่: recreate ให้ insert แค่ (serial_lvb, serial_om, project_stock_id)
--        + เพิ่ม app_notify('stock_received') dept 'project'
--  ⚡ อิสระจาก 0017 (ใช้แค่ helper จาก 0002) — รันเดี่ยวได้ทันทีเพื่อแก้ error import
--  demo sync ที่ logic.ts addUnitsToStock · idempotent รันซ้ำได้
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_add_units_to_stock(p_stock_id UUID, p_units JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; u JSONB; lvb TEXT; om TEXT; cnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_units, '[]'::jsonb)) LOOP
    lvb := trim(COALESCE(u->>'lvb', '')); om := trim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id) VALUES (lvb, om, p_stock_id);
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;
  -- ใหม่ (0018): แจ้งเข้า LINE ว่ามี LBS เพิ่มเข้าคลัง (เดิมเงียบ)
  PERFORM app_notify('stock_received',
    '📦 Division รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง — พร้อมให้ดึงเข้า Job',
    'project', NULL);
  PERFORM app_audit('project_stock', p_stock_id, 'add_units', actor.id,
    'รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || cnt || ' เครื่อง');
END $$;
