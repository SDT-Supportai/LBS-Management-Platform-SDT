-- =====================================================================
-- 0030: Purchasing บันทึกราคาจริงหลังออก PO (2026-07-25)
--  ต้นทุนใช้จริงในงบ = unit_price ของ job_accessory_requests (คิดฝั่ง client)
--  เดิมกรอกตอนขอวัสดุ (ประมาณการ) · เพิ่มให้ Purchasing แก้ราคาจริงหลังออก PO
--  rpc_update_po_line_price: เฉพาะ dept purchasing(+admin) · รายการที่ po_id ไม่ว่าง
--    + status po_ordered/received · Job ยังไม่ล็อก (app_assert_job_editable)
--    ราคาเดียว — ราคาจริงทับประมาณการ (กระทบงบ actual ทันที)
--  demo sync ที่ src/data/logic.ts updatePoLinePrice · รันหลัง 0029 (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_update_po_line_price(p_request_id UUID, p_unit_price NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items; po purchase_orders;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);   -- Purchasing (+admin)
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  IF r.po_id IS NULL OR r.status NOT IN ('po_ordered', 'received') THEN
    RAISE EXCEPTION 'บันทึกราคาจริงได้เฉพาะรายการที่ออก PO แล้ว';
  END IF;
  j := app_assert_job_editable(r.job_id);   -- ล็อกเมื่อ Job ถูกเบิก/ยกเลิก
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN RAISE EXCEPTION 'ราคาต่อหน่วยติดลบไม่ได้'; END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  SELECT * INTO po FROM purchase_orders WHERE id = r.po_id;
  UPDATE job_accessory_requests SET unit_price = p_unit_price, updated_at = now() WHERE id = p_request_id;
  PERFORM app_audit('job_accessory_request', p_request_id, 'update_po_actual_price', actor.id,
    j.job_no || ' บันทึกราคาจริง ' || it.name || ' = ' || COALESCE(p_unit_price, 0) || ' บาท/' || it.uom
    || COALESCE(' (' || po.po_no || ')', ''));
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_po_line_price(UUID, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_po_line_price(UUID, NUMERIC) TO authenticated;
