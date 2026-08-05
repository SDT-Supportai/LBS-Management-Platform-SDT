-- =====================================================================
-- 0046: Import รายการวัสดุเข้า Standard BOM จาก Excel (2026-08-04)
--  ที่มา: BOM มาตรฐานมักมี 20–50 รายการ กรอกทีละแถวในหน้าเว็บไม่ไหว
--    → ใช้คู่กับ "⬇ Export Excel" ของ 0045 เป็นวงรอบ export → แก้ใน Excel → import
--  2 โหมด (ผู้ใช้เลือกในหน้า preview ก่อนยืนยัน):
--    - append  (default) : เพิ่มต่อท้ายรายการเดิม — ไม่ทำลายข้อมูล
--    - replace           : ลบรายการเดิมทั้งหมดแล้วใส่จากไฟล์ (ไฟล์ = source of truth)
--  ⚠️ ทำเป็น RPC เดียวรับ jsonb (ไม่ให้ client loop เรียก add ทีละบรรทัด) เพราะ
--     ต้อง atomic — ถ้าพังกลางทางต้อง rollback ทั้งชุด ไม่ใช่เหลือครึ่งๆ
--     (pattern เดียวกับ rpc_import_units_to_stock ของ 0025)
--  การผูกฐานข้อมูลวัสดุ: หา items จาก epicor_code ก่อน แล้วค่อย code — เจอ = ผูก item_id
--    และเติมชื่อ/หน่วยจาก master ให้ช่องที่ไฟล์เว้นว่าง · ไม่เจอ = เก็บเป็น free text (ตาม 0045)
--  สิทธิ์เดียวกับ 0045: Project + Division + Manage (app_assert_standards)
--  demo sync ที่ src/data/logic.ts (importStdBomLines) · รันหลัง 0045 · idempotent
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_import_std_bom_lines(
  p_bom_id  UUID,
  p_lines   JSONB,
  p_replace BOOLEAN DEFAULT false
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; b std_boms; ln JSONB;
  v_item UUID; v_ep TEXT; v_name TEXT; v_uom TEXT; v_qty NUMERIC; v_cost NUMERIC;
  i_name TEXT; i_ep TEXT; i_um TEXT;
  n INT := 0; removed INT := 0; linked INT := 0; idx INT := 0;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO b FROM std_boms WHERE id = p_bom_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ BOM นี้'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'ไม่มีรายการวัสดุในไฟล์';
  END IF;

  IF p_replace THEN
    SELECT COUNT(*) INTO removed FROM std_bom_lines WHERE bom_id = p_bom_id;
    DELETE FROM std_bom_lines WHERE bom_id = p_bom_id;
  END IF;

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    idx := idx + 1;
    v_item := NULLIF(ln->>'item_id', '')::UUID;
    v_ep   := NULLIF(btrim(COALESCE(ln->>'epicor_code', '')), '');
    v_name := NULLIF(btrim(COALESCE(ln->>'name', '')), '');
    v_uom  := NULLIF(btrim(COALESCE(ln->>'uom', '')), '');
    v_qty  := NULLIF(ln->>'qty', '')::NUMERIC;
    v_cost := NULLIF(ln->>'est_unit_cost', '')::NUMERIC;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'แถวที่ % : จำนวนต้องมากกว่า 0', idx;
    END IF;
    IF v_cost IS NOT NULL AND v_cost < 0 THEN
      RAISE EXCEPTION 'แถวที่ % : ต้นทุนประมาณการต้องไม่ติดลบ', idx;
    END IF;

    -- ไม่ได้ส่ง item_id มา → ลองผูกจากรหัส Epicor (แล้วค่อย code) ให้เอง
    IF v_item IS NULL AND v_ep IS NOT NULL THEN
      SELECT id INTO v_item FROM items WHERE epicor_code = v_ep LIMIT 1;
      IF v_item IS NULL THEN SELECT id INTO v_item FROM items WHERE code = v_ep LIMIT 1; END IF;
    END IF;

    IF v_item IS NOT NULL THEN
      SELECT name, COALESCE(epicor_code, code), uom INTO i_name, i_ep, i_um FROM items WHERE id = v_item;
      IF i_name IS NULL THEN RAISE EXCEPTION 'แถวที่ % : ไม่พบวัสดุในฐานข้อมูล', idx; END IF;
      -- ช่องที่ไฟล์เว้นว่าง เติมจาก master · ที่กรอกมาให้ใช้ค่าจากไฟล์ (คนกรอกอาจตั้งใจเขียนต่าง)
      v_name := COALESCE(v_name, i_name);
      v_ep   := COALESCE(v_ep, i_ep);
      v_uom  := COALESCE(v_uom, i_um);
      linked := linked + 1;
    END IF;

    IF v_name IS NULL THEN
      RAISE EXCEPTION 'แถวที่ % : ต้องมีชื่ออุปกรณ์ หรือรหัส Epicor ที่มีในฐานข้อมูลวัสดุ', idx;
    END IF;

    INSERT INTO std_bom_lines (bom_id, item_id, epicor_code, name, qty, uom, est_unit_cost, note)
    VALUES (p_bom_id, v_item, v_ep, v_name, v_qty, v_uom, v_cost,
            NULLIF(btrim(COALESCE(ln->>'note', '')), ''));
    n := n + 1;
    v_item := NULL; i_name := NULL; i_ep := NULL; i_um := NULL;   -- reset ก่อนแถวถัดไป
  END LOOP;

  UPDATE std_boms SET updated_by = actor.id, updated_at = now() WHERE id = p_bom_id;

  PERFORM app_audit('std_bom', p_bom_id, 'import_std_bom_lines', actor.id,
    b.title || ' Import Excel: ' ||
    CASE WHEN p_replace THEN 'แทนที่ทั้งหมด (ลบเดิม ' || removed || ' รายการ) ' ELSE 'เพิ่มต่อท้าย ' END ||
    n || ' รายการ (ผูกฐานข้อมูลวัสดุได้ ' || linked || ')');
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_import_std_bom_lines(UUID, JSONB, BOOLEAN) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0046 OK — Import รายการวัสดุเข้า Standard BOM จาก Excel พร้อมใช้งาน'; END $$;
