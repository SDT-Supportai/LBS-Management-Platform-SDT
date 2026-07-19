-- =====================================================================
-- 0018: แจ้งเตือนตอน "รับ LBS เพิ่มเข้าคลังเดิม" + Excel Import (2026-07-19)
--  บั๊ก: rpc_add_units_to_stock (0008) ไม่มี app_notify — ตอน Division รับ LBS
--        เพิ่มเข้าคลังที่มีอยู่แล้ว หรือ Import Excel จะไม่แจ้งเข้า LINE เลย
--        (มีแต่ตอนสร้างคลังใหม่ rpc_create_project_stock ที่ส่ง stock_created)
--  แก้: เพิ่ม app_notify('stock_received') ท้ายฟังก์ชัน (dept 'project' — Project
--        เจ้าของงานจะได้รู้ว่ามี LBS เพิ่มให้ดึงเข้า Job) · demo sync ที่ logic.ts
--  เนื้อฟังก์ชันคงเดิมทุกบรรทัด เพิ่มเฉพาะ notify · รันหลัง 0017 (idempotent)
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
