-- =====================================================================
-- 0056: สลับ LBS ต้องพา "ข้อมูลตัวเครื่อง" ไปกับ Serial (2026-08-20)
--
--  ปัญหา: 0028 (+0032 เติม notify) สลับเฉพาะ serial_lvb/serial_om
--    ⇒ unit_cost / fob_date / eta_lead_days / plan_po_receipt_date ค้างอยู่กับ "แถว"
--       ไม่ตามไปกับ "เครื่อง" ที่ Serial ชี้ถึง · ผลจริง 2 อย่าง:
--       1) jobLbsCost()/หมวด raw_mat actual คิดเงินของเครื่องที่ยังอยู่ในคลัง
--          (ตัวอย่าง: A 1,200,000 บนงาน สลับกับ B 900,000 ในคลัง → งานยังถูกคิด 1,200,000)
--       2) Status/ETA to WH ของทั้งสอง Serial ผิดสลับกัน (เครื่องที่ของถึงแล้วโชว์ Pending และกลับกัน)
--
--  หลักที่ใช้แบ่ง: identity ของเครื่องจริง = คู่ Serial
--    ย้ายตาม Serial : unit_cost (เงินที่จ่ายซื้อเครื่องนั้น)
--                     fob_date / eta_lead_days / plan_po_receipt_date (ล็อตเรือ + วันของเข้าคลังของเครื่องนั้น)
--    อยู่กับที่      : project_stock_id / status / job_id  = ตำแหน่ง ซึ่งเป็นสิ่งที่ swap ตั้งใจเปลี่ยน
--                     plan_customer_name / plan_contact_phone / plan_install_location /
--                     plan_po_date / plan_delivery_date  = แผนฝั่งขายของ "ช่อง" ไม่ใช่ของตัวเครื่อง
--
--  §9.5 grep ก่อน recreate: app_exec_swap_lbs ถูก CREATE OR REPLACE ครั้งล่าสุดที่ 0032
--    (0033/0041 แค่ PERFORM เรียก · 0031 ไม่ได้ patch ฟังก์ชันนี้)
--    ⇒ recreate ทั้งก้อนได้ปลอดภัย body นี้ = ของ 0032 + สลับฟิลด์ตัวเครื่อง + audit บอกต้นทุน
--
--  demo sync ที่ src/data/logic.ts (swapLbs · machineOf)
--  ⚠️ ไม่เปลี่ยน signature ของ rpc_swap_lbs / rpc_approve_request → PostgREST ไม่กระทบ
--  รันหลัง 0055 · idempotent (CREATE OR REPLACE)
-- =====================================================================

CREATE OR REPLACE FUNCTION app_exec_swap_lbs(actor profiles, p_job_id UUID, p_allocated_unit_id UUID, p_stock_unit_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; a lbs_units; b lbs_units;
BEGIN
  j := app_assert_job_editable(p_job_id);   -- lock job + กันสลับหลัง issued/installed/cancelled
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการสลับ LBS'; END IF;
  SELECT * INTO a FROM lbs_units WHERE id = p_allocated_unit_id FOR UPDATE;
  IF a.id IS NULL OR a.job_id <> p_job_id OR a.status <> 'allocated' THEN
    RAISE EXCEPTION 'เครื่องต้นทางต้องเป็น LBS ที่ดึงเข้า Job นี้อยู่ (allocated)';
  END IF;
  SELECT * INTO b FROM lbs_units WHERE id = p_stock_unit_id FOR UPDATE;
  IF b.id IS NULL OR b.status <> 'in_stock' THEN
    RAISE EXCEPTION 'เครื่องที่จะสลับต้องเป็นเครื่องว่างในคลัง (in_stock)';
  END IF;
  IF a.id = b.id THEN RAISE EXCEPTION 'เลือกเครื่องสลับซ้ำกันไม่ได้'; END IF;

  -- a, b เป็น snapshot ก่อน UPDATE → เขียนไล่กันได้ · ผ่านค่าชั่วคราวกันชน unique ระหว่างขั้นตอน
  UPDATE lbs_units SET serial_lvb = 'SWP-' || a.id || '-L', serial_om = 'SWP-' || a.id || '-O', updated_at = now() WHERE id = a.id;
  UPDATE lbs_units SET serial_lvb = a.serial_lvb, serial_om = a.serial_om,
         unit_cost = a.unit_cost, fob_date = a.fob_date, eta_lead_days = a.eta_lead_days,
         plan_po_receipt_date = a.plan_po_receipt_date,
         updated_at = now() WHERE id = b.id;
  UPDATE lbs_units SET serial_lvb = b.serial_lvb, serial_om = b.serial_om,
         unit_cost = b.unit_cost, fob_date = b.fob_date, eta_lead_days = b.eta_lead_days,
         plan_po_receipt_date = b.plan_po_receipt_date,
         updated_at = now() WHERE id = a.id;

  PERFORM app_audit('lbs_unit', a.id, 'swap_lbs_serial', actor.id,
    j.job_no || ' สลับ LBS: ' || a.serial_lvb || '/' || a.serial_om || ' ↔ ' || b.serial_lvb || '/' || b.serial_om
    || ' (คลัง) — เหตุผล: ' || trim(p_reason)
    || ' [ต้นทุน/เครื่องย้ายตาม Serial: ' || COALESCE(a.unit_cost::TEXT, '-') || ' ↔ ' || COALESCE(b.unit_cost::TEXT, '-') || ' ฿]');

  -- action ชั้น 1: แจ้งรายละเอียดการสลับ (เหมือน create_pr / issue_job / cancel_job)
  PERFORM app_notify('lbs_swapped',
    '🔁 ' || j.job_no || ' สลับ LBS: ' || a.serial_lvb || '/' || a.serial_om || ' ↔ ' || b.serial_lvb || '/' || b.serial_om
    || ' (คลัง) · เหตุผล: ' || trim(p_reason),
    'all', p_job_id);
END $$;

-- ---------- ตรวจผล: body ใหม่ต้องมีการสลับ unit_cost แล้ว ----------
DO $$
BEGIN
  IF position('unit_cost = a.unit_cost' IN pg_get_functiondef('app_exec_swap_lbs(profiles,uuid,uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0056 ไม่สมบูรณ์ — app_exec_swap_lbs ยังไม่สลับ unit_cost';
  END IF;
  RAISE NOTICE '0056 OK — swap พา unit_cost / fob_date / eta_lead_days / plan_po_receipt_date ไปกับ Serial';
END $$;

-- ---------- รายงานการสลับย้อนหลัง (ไม่ auto-repair — เดาเจตนาเดิมไม่ได้) ----------
-- รันคำสั่งนี้แยกเพื่อให้ Division ตรวจว่างบของงานที่เคยสลับต้องแก้ไหม:
--   SELECT created_at, detail FROM audit_logs WHERE action = 'swap_lbs_serial' ORDER BY created_at DESC;
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM audit_logs WHERE action = 'swap_lbs_serial';
  IF n > 0 THEN
    RAISE NOTICE '0056: มีประวัติสลับ LBS % ครั้งก่อนแก้ไขนี้ — ต้นทุน/ETA ของเครื่องเหล่านั้นอาจผูกผิด ให้ Division ตรวจจาก audit_logs (action = swap_lbs_serial)', n;
  END IF;
END $$;
