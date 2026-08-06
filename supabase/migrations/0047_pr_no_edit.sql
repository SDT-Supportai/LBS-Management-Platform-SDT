-- =====================================================================
-- 0047: Purchasing แก้เลข PR ได้ (2026-08-05)
--  ที่มา: pr_no ระบบรันให้อัตโนมัติ (PR-YYYY-NNNN, 0016) แต่เลข PR ตัวจริงมาจาก Epicor
--    ไม่ตรงกับเลขที่ระบบรัน → Purchasing ต้องแก้ให้ตรงเอกสารจริงได้ (เหมือนที่ 0007
--    เปลี่ยน Job No./PO No. ให้กรอกเอง)
--  มติ (2026-08-05):
--    - แก้ได้ **เฉพาะ PR ที่ยังไม่ออก PO** (status = 'pending') — ออก PO แล้วล็อก
--    - **ไม่ต้องแจ้งเตือน** ลงแต่ audit (หน้า Project อ่าน pr_no จากแถวเดียวกัน
--      จึงเห็นเลขใหม่เองทันที ไม่มี snapshot ที่ต้อง sync)
--  ⚠️ ข้อความแจ้งเตือน/audit เก่าที่เขียนเลข PR ไว้เป็นข้อความ **ไม่แก้ตาม** โดยเจตนา —
--     เป็นบันทึกประวัติ ณ เวลานั้น ถ้าไปแก้ย้อนหลังคือปลอมประวัติ
--  สิทธิ์: purchasing (+admin auto) — ฝั่งที่ถือเอกสาร PR จริง
--  demo sync ที่ src/data/logic.ts (updatePrNo) · รันหลัง 0046 · idempotent
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_update_pr_no(p_pr_id UUID, p_pr_no TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pr purchase_requisitions; j jobs; newno TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO pr FROM purchase_requisitions WHERE id = p_pr_id FOR UPDATE;
  IF pr.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PR นี้'; END IF;

  newno := btrim(COALESCE(p_pr_no, ''));
  IF newno = '' THEN RAISE EXCEPTION 'กรุณาระบุเลข PR'; END IF;
  IF length(newno) > 50 THEN RAISE EXCEPTION 'เลข PR ยาวเกิน 50 ตัวอักษร'; END IF;
  IF newno = pr.pr_no THEN RETURN; END IF;   -- ไม่เปลี่ยน = ไม่ต้องทำอะไร (idempotent)

  -- ล็อกหลังออก PO: PO/รายการวัสดุอ้างถึง PR ใบนี้ในเอกสารที่ส่งซัพไปแล้ว
  IF pr.status <> 'pending' THEN
    RAISE EXCEPTION 'แก้เลข PR ได้เฉพาะใบที่ยังไม่ออก PO — % อยู่สถานะ %', pr.pr_no, pr.status;
  END IF;

  IF EXISTS (SELECT 1 FROM purchase_requisitions WHERE pr_no = newno AND id <> p_pr_id) THEN
    RAISE EXCEPTION 'เลข PR "%" มีอยู่ในระบบแล้ว', newno;
  END IF;

  UPDATE purchase_requisitions SET pr_no = newno WHERE id = p_pr_id;

  SELECT * INTO j FROM jobs WHERE id = pr.job_id;
  PERFORM app_audit('purchase_requisition', p_pr_id, 'update_pr_no', actor.id,
    'แก้เลข PR: ' || pr.pr_no || ' → ' || newno || ' (' || COALESCE(j.job_no, '-') || ')');
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_update_pr_no(UUID, TEXT) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0047 OK — Purchasing แก้เลข PR ได้ (เฉพาะใบที่ยังไม่ออก PO)'; END $$;
