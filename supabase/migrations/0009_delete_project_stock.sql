-- =====================================================================
-- 0009: ลบ Project Stock (2026-07-14)
--  ลบได้เฉพาะคลัง "เปล่า": ทุกเครื่องยังเป็น in_stock และไม่เคยมีประวัติดึง/คืน
--  (แนวเดียวกับ rpc_delete_draft_job) — คลังที่ใช้งานแล้วให้ "ปิดคลัง" แทน เพื่อคง audit trail
--  สิทธิ์: sales (+admin) เหมือนการสร้าง/แก้ Project Stock
--  รันหลัง 0008 (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_delete_project_stock(p_stock_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; bad INT; cnt INT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;

  SELECT count(*) INTO bad FROM lbs_units WHERE project_stock_id = p_stock_id AND status <> 'in_stock';
  IF bad > 0 THEN
    RAISE EXCEPTION '% มีเครื่องที่ถูกดึงเข้า Job/เบิกแล้ว % เครื่อง ลบไม่ได้ — ใช้ "ปิดคลัง" แทน', s.stock_no, bad;
  END IF;
  IF EXISTS (SELECT 1 FROM stock_allocations WHERE project_stock_id = p_stock_id) THEN
    RAISE EXCEPTION '% มีประวัติดึง/คืนแล้ว ลบไม่ได้ — ใช้ "ปิดคลัง" แทนเพื่อคง audit trail', s.stock_no;
  END IF;

  DELETE FROM lbs_units WHERE project_stock_id = p_stock_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  DELETE FROM project_stocks WHERE id = p_stock_id;

  PERFORM app_audit('project_stock', p_stock_id, 'delete_stock', actor.id,
    'ลบ ' || s.stock_no || ' (LBS ในคลัง ' || cnt || ' เครื่อง ไม่เคยมีประวัติดึง/คืน)');
END $$;
