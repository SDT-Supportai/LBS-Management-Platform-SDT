-- =====================================================================
-- 0027: ลบรายการวัสดุที่ยกเลิกออกจากการ์ด (2026-07-24)
--  Project / Division / Manage ลบ job_accessory_requests ที่ status='cancelled'
--  ได้ — เฉพาะรายการที่ "ยังไม่เคยผูก PR/PO" (pr_id/po_id NULL) เพื่อไม่ให้เอกสาร
--  PR/PO อ้างอิงรายการที่หายไป · audit การยกเลิกยังอยู่ใน audit_logs (แยกตาราง)
--  demo sync ที่ src/data/logic.ts deleteAccessoryRequest · รันหลัง 0026 (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_delete_accessory_request(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items;
BEGIN
  actor := app_assert_dept(ARRAY['project', 'sales']);   -- project + sales(+admin auto)
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  IF r.status <> 'cancelled' THEN RAISE EXCEPTION 'ลบออกจากการ์ดได้เฉพาะรายการที่ยกเลิกแล้ว'; END IF;
  IF r.pr_id IS NOT NULL OR r.po_id IS NOT NULL THEN
    RAISE EXCEPTION 'รายการนี้เคยผูก PR/PO ลบไม่ได้ (คงประวัติเอกสาร)';
  END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  DELETE FROM job_accessory_requests WHERE id = p_request_id;
  PERFORM app_audit('job_accessory_request', p_request_id, 'delete_accessory_request', actor.id,
    COALESCE(j.job_no, '') || ' ลบรายการวัสดุที่ยกเลิก ' || COALESCE(it.name, '') || ' ออกจากการ์ด');
END $$;

REVOKE ALL ON FUNCTION public.rpc_delete_accessory_request(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_delete_accessory_request(UUID) TO authenticated;
