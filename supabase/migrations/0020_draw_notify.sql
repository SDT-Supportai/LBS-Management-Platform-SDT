-- =====================================================================
-- 0020: แจ้งเตือนตอนดึง LBS + เอา job_ready ออก (2026-07-19)
--  มติ: แทน "job_ready" (ของครบ—พร้อมเบิก) ด้วยแจ้งเตือนตอน "ดึง LBS" ที่ให้
--       ข้อมูลรายเครื่อง (Serial.LVB / Serial.OM) + Stock No. ต้นทาง
--  1) app_notify_if_ready → no-op (เลิกยิง job_ready ทุกจุดที่เรียก: draw/add
--     accessory/receive PO/update job/cancel accessory — คง signature ให้ caller
--     เดิมทำงานได้ ไม่ต้องแก้ทุกตัว)
--  2) rpc_draw_lbs: agg ทั้ง serial_lvb + serial_om แล้ว app_notify('lbs_drawn',
--     ..., 'all') — เข้า LINE group + เด้งทุกแผนกในแอป
--  demo sync ที่ src/data/logic.ts (drawLbs + notifyIfBecameReady) · รันหลัง 0019
-- =====================================================================

-- ---------- 1) เลิกยิง job_ready ทั้งระบบ ----------
CREATE OR REPLACE FUNCTION app_notify_if_ready(jid UUID, before_status TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- no-op (2026-07-19): เลิกแจ้ง job_ready — ใช้แจ้งตอนดึง LBS แทน
  RETURN;
END $$;

-- ---------- 2) rpc_draw_lbs + แจ้งเตือน lbs_drawn ----------
CREATE OR REPLACE FUNCTION rpc_draw_lbs(p_job_id UUID, p_stock_id UUID, p_unit_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; s project_stocks; held INT; updated INT; serials TEXT[]; serials_om TEXT[];
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  PERFORM 1 FROM jobs WHERE id = p_job_id FOR UPDATE;
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  IF s.status = 'closed' THEN RAISE EXCEPTION '% ถูกปิดคลังแล้ว ดึงเพิ่มไม่ได้', s.stock_no; END IF;
  IF array_length(p_unit_ids, 1) IS NULL THEN RAISE EXCEPTION 'กรุณาเลือก Serial No. ที่จะดึง'; END IF;

  SELECT count(*) INTO held FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated';
  IF held + array_length(p_unit_ids, 1) > j.lbs_qty_required THEN
    RAISE EXCEPTION 'ดึงเกินจำนวนตาม Scope ไม่ได้ — Scope % เครื่อง ถืออยู่ % เครื่อง (ดึงได้อีก %)',
      j.lbs_qty_required, held, j.lbs_qty_required - held;
  END IF;

  WITH upd AS (
    UPDATE lbs_units SET status = 'allocated', job_id = p_job_id, updated_at = now()
    WHERE id = ANY(p_unit_ids) AND project_stock_id = p_stock_id AND status = 'in_stock'
    RETURNING serial_lvb, serial_om
  )
  SELECT count(*), array_agg(serial_lvb), array_agg(serial_om) INTO updated, serials, serials_om FROM upd;

  IF updated <> array_length(p_unit_ids, 1) THEN
    RAISE EXCEPTION 'มีเครื่องที่ไม่อยู่ในสต็อกนี้หรือถูกดึงไปแล้ว — ห้ามดึงเกินยอดคงเหลือ';
  END IF;

  INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by)
  VALUES (p_job_id, p_stock_id, 'draw', serials, actor.id);

  PERFORM app_notify('lbs_drawn',
    '✅ ' || j.job_no || ' (' || j.customer_name || ') ดึง LBS ' || updated || ' เครื่องจาก ' || s.stock_no
    || ' — Serial.LVB: ' || array_to_string(serials, ', ') || ' · Serial.OM: ' || array_to_string(serials_om, ', '),
    'all', p_job_id);
  PERFORM app_audit('stock_allocation', p_job_id, 'draw_lbs', actor.id,
    j.job_no || ' ดึง LBS ' || updated || ' เครื่องจาก ' || s.stock_no || ' (SN: ' || array_to_string(serials, ', ') || ')');
END $$;
