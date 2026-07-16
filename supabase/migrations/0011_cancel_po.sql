-- =====================================================================
-- 0011: ยกเลิก PO เดี่ยว (2026-07-15)
--  ออก PO ผิด (supplier/เลข/เงื่อนไข) ยกเลิกได้โดยไม่ต้องยกเลิกทั้ง Job:
--  PO → cancelled, PR คืนเป็น pending ให้ Purchasing ออก PO ใหม่ได้,
--  รายการวัสดุ po_ordered → pr_sent (กลับสถานะก่อนออก PO)
--  เงื่อนไข: ยกเลิกได้เฉพาะ PO ที่ยังไม่รับของเลย (ทุกรายการ qty_received = 0)
--  — ถ้ารับบางส่วนแล้ว ของเข้าระบบแล้ว ต้องรับให้จบหรือจัดการที่หน้างานก่อน
--  สิทธิ์: purchasing (+admin) · เหตุผลบันทึกลง audit + แจ้ง Project
--  รันหลัง 0010 (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_cancel_po(p_po_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; po purchase_orders; pr purchase_requisitions; j jobs; got NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id;
  IF po.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PO'; END IF;
  IF po.status <> 'issued' THEN RAISE EXCEPTION '% รับของครบแล้วหรือถูกยกเลิกไปแล้ว', po.po_no; END IF;
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ยกเลิก PO'; END IF;

  SELECT COALESCE(sum(qty_received), 0) INTO got FROM job_accessory_requests WHERE pr_id = po.pr_id;
  IF got > 0 THEN
    RAISE EXCEPTION '% รับของเข้าระบบแล้ว % หน่วย ยกเลิกไม่ได้ — รับส่วนที่เหลือให้จบ หรือติดต่อ Manager', po.po_no, got;
  END IF;

  SELECT * INTO pr FROM purchase_requisitions WHERE id = po.pr_id;
  SELECT * INTO j FROM jobs WHERE id = po.job_id;

  UPDATE purchase_orders SET status = 'cancelled' WHERE id = p_po_id;
  UPDATE purchase_requisitions SET status = 'pending' WHERE id = po.pr_id;
  UPDATE job_accessory_requests SET status = 'pr_sent', updated_at = now()
  WHERE pr_id = po.pr_id AND status = 'po_ordered';

  PERFORM app_notify('po_cancelled',
    '🗑️ ยกเลิก ' || po.po_no || ' (' || j.job_no || ') เหตุผล: ' || trim(p_reason)
    || ' — ' || pr.pr_no || ' กลับมารอออก PO ใหม่',
    'project', po.job_id);
  PERFORM app_audit('purchase_order', p_po_id, 'cancel_po', actor.id,
    'ยกเลิก ' || po.po_no || ' (' || j.job_no || ') เหตุผล: ' || trim(p_reason) || ' — คืน ' || pr.pr_no || ' เป็นรอออก PO');
END $$;
