-- =====================================================================
-- 0029: Project Stock + PO No. (2026-07-24)
--  เพิ่ม project_stocks.po_no — กรอกตอนสร้างคลัง (ว่างได้) + แก้ภายหลังได้
--  Remark ใช้คอลัมน์ notes เดิม (แค่เปลี่ยน label ฝั่ง UI เป็น "Remark")
--  drop+recreate rpc_create_project_stock (+p_po_no) / rpc_update_project_stock (+p_po_no)
--    — คงพฤติกรรม 0024/0014 ทุกอย่าง (unit_cost, validation, notify, audit)
--  demo sync ที่ src/data/logic.ts · รันหลัง 0028 (idempotent)
-- =====================================================================

ALTER TABLE project_stocks ADD COLUMN IF NOT EXISTS po_no TEXT;

-- ยกเลิก signature เดิมก่อน recreate ที่มี p_po_no (กัน overload กำกวมใน PostgREST)
DROP FUNCTION IF EXISTS rpc_create_project_stock(TEXT, UUID, JSONB, TEXT);
DROP FUNCTION IF EXISTS rpc_update_project_stock(UUID, TEXT, TEXT);

-- สร้างคลัง: + po_no (คงพฤติกรรม 0024 ทุกอย่าง)
CREATE OR REPLACE FUNCTION rpc_create_project_stock(p_stock_no TEXT, p_item_id UUID, p_units JSONB, p_notes TEXT, p_po_no TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; sid UUID; u JSONB; lvb TEXT; om TEXT; cnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(p_stock_no) = '' THEN RAISE EXCEPTION 'กรุณาระบุ Stock No.'; END IF;
  IF EXISTS (SELECT 1 FROM project_stocks WHERE stock_no = trim(p_stock_no)) THEN
    RAISE EXCEPTION 'Stock No. "%" มีอยู่แล้ว', trim(p_stock_no);
  END IF;

  INSERT INTO project_stocks (stock_no, item_id, notes, po_no, created_by)
  VALUES (trim(p_stock_no), p_item_id, p_notes, NULLIF(trim(COALESCE(p_po_no, '')), ''), actor.id) RETURNING id INTO sid;

  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_units, '[]'::jsonb)) LOOP
    lvb := trim(COALESCE(u->>'lvb', '')); om := trim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, unit_cost)
    VALUES (lvb, om, sid, app_unit_cost(u));
    cnt := cnt + 1;
  END LOOP;
  IF cnt = 0 THEN RAISE EXCEPTION 'กรุณาระบุ Serial No. อย่างน้อย 1 เครื่อง'; END IF;

  PERFORM app_notify('stock_created',
    '📦 Sales รับ LBS เข้า ' || trim(p_stock_no) || ' จำนวน ' || cnt || ' เครื่อง — พร้อมให้ดึงเข้า Job',
    'project', NULL);
  PERFORM app_audit('project_stock', sid, 'create_stock', actor.id,
    'สร้าง ' || trim(p_stock_no) || ' รับ LBS เข้า ' || cnt || ' เครื่อง'
    || CASE WHEN NULLIF(trim(COALESCE(p_po_no, '')), '') IS NOT NULL THEN ' (PO ' || trim(p_po_no) || ')' ELSE '' END);
  RETURN sid;
END $$;

-- แก้ไขคลัง: + po_no (คงพฤติกรรม 0014: notes + status)
CREATE OR REPLACE FUNCTION rpc_update_project_stock(p_stock_id UUID, p_notes TEXT, p_status TEXT, p_po_no TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  UPDATE project_stocks SET notes = p_notes, po_no = NULLIF(trim(COALESCE(p_po_no, '')), ''), status = p_status
  WHERE id = p_stock_id;
  PERFORM app_audit('project_stock', p_stock_id, 'update_stock', actor.id,
    'แก้ไข ' || s.stock_no || CASE WHEN s.status <> p_status
      THEN CASE WHEN p_status = 'closed' THEN ' (ปิดคลัง — ห้ามดึงเพิ่ม)' ELSE ' (เปิดคลังอีกครั้ง)' END
      ELSE '' END);
END $$;

-- สิทธิ์เรียก RPC: เฉพาะผู้ login แล้ว (signature ใหม่ ต้อง grant ใหม่)
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('rpc_create_project_stock', 'rpc_update_project_stock')
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.' || fn || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.' || fn || ' TO authenticated';
  END LOOP;
END $$;
