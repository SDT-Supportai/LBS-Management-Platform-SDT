-- =====================================================================
-- 0048: Import อัพเดทข้อมูลแผนรายเครื่องได้ (2026-08-05)
--  เดิม Import (0025) อัพเดทเครื่องที่ Serial ซ้ำได้แค่ "ต้นทุน/เครื่อง"
--  ตอนนี้อัพเดทได้อีก 5 ช่องที่ 0043 เพิ่มไว้:
--    ชื่อลูกค้า(แผน) · เบอร์ติดต่อ(แผน) · สถานที่ติดตั้ง(แผน) · Plan PO receipt · Plan Delivery
--
--  ✅ **ไม่เปลี่ยน signature** — payload เป็น jsonb อยู่แล้ว เติม key ใหม่เข้าไปได้เลย
--     → ไม่มีความเสี่ยง PGRST202 ตามบทเรียน §9.8 · เรียกแบบเดิม (มีแต่ cost) ยังทำงานได้
--
--  3 กติกา (มติ 2026-08-05):
--   1) **ช่องว่างในไฟล์ = คงค่าเดิม ไม่ล้างค่า** (ต่อจากพฤติกรรม cost เดิมของ 0025)
--      ต่างจาก modal "แก้ข้อมูล" ที่ช่องว่าง = ล้างค่า — ไฟล์ที่กรอกไม่ครบไม่ควรลบข้อมูลคนอื่น
--      ถ้าต้องการล้างค่าจริง ใช้ modal แก้รายเครื่อง
--   2) **ลูกค้า/เบอร์/สถานที่ อัพเดทเฉพาะเครื่องที่ยังไม่เข้า Job (job_id IS NULL)**
--      เครื่องที่มี Job แล้วค่าจริงมาจาก Job (กฎ single source of truth ของ 0014)
--      ถ้า import ทับจะเป็นการก็อปข้อมูล Job ลงมาซ้ำที่ unit = ข้อมูล 2 ชุดขัดกัน
--      (ไฟล์ Export เขียนคอลัมน์ลูกค้าจาก Job → ถ้า import กลับ ต้องไม่เขียนย้อนลง unit)
--   3) **ข้ามเครื่องที่เบิกแล้ว (status = 'issued')** — trigger trg_block_issued_edit (0001)
--      บล็อก UPDATE lbs_units ทุกคอลัมน์เมื่อ Job = issued/installed
--      ถ้าไม่กันไว้ เครื่องเดียวจะทำให้ทั้งไฟล์ error ทั้งชุด · UI แจ้งจำนวนที่ถูกข้ามใน preview
--
--  demo sync ที่ src/data/logic.ts importUnitsToStock · รันหลัง 0043 (ใช้คอลัมน์ plan_*) · idempotent
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_import_units_to_stock(p_stock_id UUID, p_new_units JSONB, p_update_units JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; s project_stocks; u JSONB; lvb TEXT; om TEXT; c NUMERIC;
  v_cust TEXT; v_phone TEXT; v_loc TEXT; v_por DATE; v_del DATE;
  newcnt INT := 0; updcnt INT := 0; lockedcnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;

  -- ---------- อัพเดทเครื่องเดิม: match คู่ Serial (lvb+om) เฉพาะในคลังนี้ ----------
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_update_units, '[]'::jsonb)) LOOP
    lvb := btrim(COALESCE(u->>'lvb', '')); om := btrim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' OR om = '';

    c       := app_unit_cost(u);                                        -- validate ≥0 ในตัว (0024)
    v_cust  := NULLIF(btrim(COALESCE(u->>'customer', '')), '');
    v_phone := NULLIF(btrim(COALESCE(u->>'phone', '')), '');
    v_loc   := NULLIF(btrim(COALESCE(u->>'location', '')), '');
    v_por   := NULLIF(btrim(COALESCE(u->>'plan_po_receipt', '')), '')::DATE;
    v_del   := NULLIF(btrim(COALESCE(u->>'plan_delivery', '')), '')::DATE;

    -- ไฟล์ไม่ได้กรอกอะไรให้แถวนี้เลย → ข้าม (ไม่นับเป็นอัพเดท)
    CONTINUE WHEN c IS NULL AND v_cust IS NULL AND v_phone IS NULL
             AND v_loc IS NULL AND v_por IS NULL AND v_del IS NULL;

    -- เครื่องที่เบิกแล้วแก้ไม่ได้ (trigger ล็อก) → นับไว้บอกผู้ใช้ ไม่ทำให้ทั้งไฟล์ล้ม
    IF EXISTS (
      SELECT 1 FROM lbs_units
       WHERE project_stock_id = p_stock_id AND serial_lvb = lvb AND serial_om = om AND status = 'issued'
    ) THEN
      lockedcnt := lockedcnt + 1;
      CONTINUE;
    END IF;

    UPDATE lbs_units SET
      unit_cost            = COALESCE(c, unit_cost),
      plan_po_receipt_date = COALESCE(v_por, plan_po_receipt_date),
      plan_delivery_date   = COALESCE(v_del, plan_delivery_date),
      -- ลูกค้า/เบอร์/สถานที่: เขียนได้เฉพาะเครื่องที่ยังไม่ผูก Job (กฎ 0014)
      plan_customer_name    = CASE WHEN job_id IS NULL THEN COALESCE(v_cust, plan_customer_name)  ELSE plan_customer_name    END,
      plan_contact_phone    = CASE WHEN job_id IS NULL THEN COALESCE(v_phone, plan_contact_phone) ELSE plan_contact_phone    END,
      plan_install_location = CASE WHEN job_id IS NULL THEN COALESCE(v_loc, plan_install_location) ELSE plan_install_location END,
      updated_at           = now()
    WHERE project_stock_id = p_stock_id AND serial_lvb = lvb AND serial_om = om AND status <> 'issued';
    IF FOUND THEN updcnt := updcnt + 1; END IF;
  END LOOP;

  -- ---------- รับเครื่องใหม่ (validation เดียวกับ rpc_add_units_to_stock) ----------
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_new_units, '[]'::jsonb)) LOOP
    lvb := btrim(COALESCE(u->>'lvb', '')); om := btrim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    -- เครื่องใหม่ยังไม่มี Job แน่นอน → ใส่ข้อมูลแผนได้ทุกช่อง
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, unit_cost,
                           plan_customer_name, plan_contact_phone, plan_install_location,
                           plan_po_receipt_date, plan_delivery_date)
    VALUES (lvb, om, p_stock_id, app_unit_cost(u),
            NULLIF(btrim(COALESCE(u->>'customer', '')), ''),
            NULLIF(btrim(COALESCE(u->>'phone', '')), ''),
            NULLIF(btrim(COALESCE(u->>'location', '')), ''),
            NULLIF(btrim(COALESCE(u->>'plan_po_receipt', '')), '')::DATE,
            NULLIF(btrim(COALESCE(u->>'plan_delivery', '')), '')::DATE);
    newcnt := newcnt + 1;
  END LOOP;

  IF newcnt = 0 AND updcnt = 0 THEN
    IF lockedcnt > 0 THEN
      RAISE EXCEPTION 'ทุกเครื่องในไฟล์ถูกเบิกให้ Service แล้ว (% เครื่อง) แก้ข้อมูลไม่ได้', lockedcnt;
    END IF;
    RAISE EXCEPTION 'ไม่มีรายการให้นำเข้า';
  END IF;

  IF newcnt > 0 THEN
    PERFORM app_notify('stock_received',
      '📦 Division รับ LBS เพิ่มเข้า ' || s.stock_no || ' จำนวน ' || newcnt || ' เครื่อง — พร้อมให้ดึงเข้า Job',
      'project', NULL);
  END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'import_units', actor.id,
    'Import เข้า ' || s.stock_no || ': รับใหม่ ' || newcnt || ' เครื่อง'
    || CASE WHEN updcnt > 0 THEN ' · อัพเดทข้อมูลเครื่องเดิม ' || updcnt || ' เครื่อง' ELSE '' END
    || CASE WHEN lockedcnt > 0 THEN ' · ข้ามเครื่องที่เบิกแล้ว ' || lockedcnt || ' เครื่อง' ELSE '' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0048 OK — Import อัพเดทต้นทุน + ข้อมูลแผนรายเครื่อง (ลูกค้า/เบอร์/สถานที่/Plan PO receipt/Plan Delivery) ได้แล้ว'; END $$;
