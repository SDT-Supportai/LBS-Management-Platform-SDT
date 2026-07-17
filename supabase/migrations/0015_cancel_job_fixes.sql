-- =====================================================================
-- 0015: Fix จาก code review รอบ flow/state-machine (2026-07-17)
--  Fix 1) rpc_cancel_job พังตั้งแต่ 0006: ยังอ้างคอลัมน์ serial_no ที่ถูก rename
--         เป็น serial_lvb → ยกเลิก Job บน LIVE จะ error "column serial_no does
--         not exist" ทุกครั้ง (ฟังก์ชันถูกสร้างก่อน rename และไม่เคย recreate)
--  Fix 2) rpc_cancel_job: วัสดุที่รับจาก PO มาแล้ว "บางส่วน" (po_ordered +
--         qty_received > 0) เดิมถูกตีเป็น cancelled เงียบๆ — ของที่รับเข้าคลังจริง
--         หายจากระบบโดยไม่มีร่องรอย → ใหม่: ปฏิบัติเหมือนรายการ received คือ
--         p_received_to_central = true  → คืน qty_received เข้าสต็อกกลาง (returned)
--         p_received_to_central = false → ปิดยอดเป็น received ตามที่รับจริง
--                                         (ส่วนค้างรับถือว่ายกเลิกไปกับ PO — พิจารณาเป็นเคส)
--  Fix 3) กัน race ระหว่าง transition ที่พึ่งสถานะ derive (เบิกให้ Service ↔
--         เพิ่มวัสดุ/คืน LBS พร้อมกัน อาจได้ Job issued ที่มีวัสดุ pending ค้าง):
--         app_assert_job_editable ล็อกแถว job (SELECT ... FOR UPDATE) —
--         ทุก RPC ที่แก้ปัจจัยของสถานะเรียก assert ตัวนี้เป็นด่านแรกอยู่แล้ว
--         (issue/draw/return/add accessory/cancel/update ฯลฯ) จึง serialize กัน
--         ทั้งหมดอัตโนมัติ และเช็ค terminal_status จากแถวที่ล็อกแล้ว (ไม่ stale)
--  สิทธิ์/signature คงเดิมทุกฟังก์ชัน · demo mode แก้คู่กันที่ src/data/logic.ts
--  รันหลัง 0014 (idempotent รันซ้ำได้)
-- =====================================================================

-- ---------- 1) app_assert_job_editable: ล็อกแถว job กัน race ----------
CREATE OR REPLACE FUNCTION app_assert_job_editable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  -- FOR UPDATE (0015): transition ที่พึ่งสถานะ derive เรียก assert นี้ก่อนเสมอ
  -- → ล็อกที่เดียว serialize ทุกตัว และตรวจ terminal จากแถวล่าสุดหลังได้ lock
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IN ('issued', 'installed') THEN
    RAISE EXCEPTION '% เบิกให้ Service แล้ว — ล็อก แก้ไข allocation ไม่ได้', j.job_no;
  END IF;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว แก้ไขไม่ได้', j.job_no;
  END IF;
  RETURN j;
END $$;

-- ---------- 2) rpc_cancel_job: serial_lvb + จัดการวัสดุรับบางส่วน ----------
CREATE OR REPLACE FUNCTION rpc_cancel_job(p_job_id UUID, p_reason TEXT, p_received_to_central BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; returned INT := 0; partial_cnt INT := 0; stock RECORD; r RECORD;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);   -- ล็อกแถว job แล้ว (0015)
  IF trim(p_reason) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการยกเลิก'; END IF;

  -- 1) คืน LBS กลับ stock เดิม + ลง allocation record ราย stock
  --    (fix 0015: ใช้ serial_lvb — เดิมอ้าง serial_no ที่ถูก rename ไปใน 0006)
  FOR stock IN
    SELECT project_stock_id, array_agg(serial_lvb) AS serials, count(*) AS cnt
    FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated'
    GROUP BY project_stock_id
  LOOP
    INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by, reference_note)
    VALUES (p_job_id, stock.project_stock_id, 'return', stock.serials, actor.id, 'auto-return จากการยกเลิก Job');
    returned := returned + stock.cnt;
  END LOOP;
  UPDATE lbs_units SET status = 'in_stock', job_id = NULL, updated_at = now()
  WHERE job_id = p_job_id AND status = 'allocated';

  -- 2) Accessory: คืนสต็อกกลาง / จัดการรับบางส่วน / ยกเลิกที่ค้าง / รับครบแล้ว
  FOR r IN SELECT * FROM job_accessory_requests WHERE job_id = p_job_id LOOP
    IF r.source = 'central_stock' AND r.status = 'issued' THEN
      UPDATE accessory_stock SET qty_on_hand = qty_on_hand + r.qty_requested, updated_at = now() WHERE item_id = r.item_id;
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    ELSIF r.status = 'po_ordered' AND COALESCE(r.qty_received, 0) > 0 THEN
      -- fix 0015: รับของจาก PO มาแล้วบางส่วน — ห้ามทิ้งเงียบ ปฏิบัติเหมือนรายการ received
      IF p_received_to_central THEN
        INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, r.qty_received)
        ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
        UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
      ELSE
        -- ไม่คืนคลัง: ปิดยอดเป็น received ตามที่รับจริง (ส่วนค้างรับยกเลิกไปกับ PO) — พิจารณาเป็นเคสไป
        UPDATE job_accessory_requests SET status = 'received', updated_at = now() WHERE id = r.id;
      END IF;
      partial_cnt := partial_cnt + 1;
    ELSIF r.status IN ('pending', 'pr_sent', 'po_ordered') THEN
      UPDATE job_accessory_requests SET status = 'cancelled', updated_at = now() WHERE id = r.id;
    ELSIF r.status = 'received' AND p_received_to_central THEN
      INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, r.qty_received)
      ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  -- 3) ปิด PR/PO ที่ค้าง
  UPDATE purchase_requisitions SET status = 'cancelled' WHERE job_id = p_job_id AND status IN ('pending', 'po_issued');
  UPDATE purchase_orders SET status = 'cancelled' WHERE job_id = p_job_id AND status = 'issued';

  UPDATE jobs SET terminal_status = 'cancelled', cancelled_at = now(), cancelled_by = actor.id,
    cancel_reason = trim(p_reason), updated_at = now()
  WHERE id = p_job_id;

  PERFORM app_notify('job_cancelled',
    '❌ ยกเลิก ' || j.job_no || ' (' || j.customer_name || ') เหตุผล: ' || trim(p_reason)
    || ' — คืน LBS ' || returned || ' เครื่อง + Accessory กลับสต็อกอัตโนมัติ'
    || CASE WHEN partial_cnt > 0
         THEN ' (วัสดุรับบางส่วน ' || partial_cnt || ' รายการ'
              || CASE WHEN p_received_to_central THEN ' คืนเข้าสต็อกกลางแล้ว)' ELSE ' คงไว้กับ Job พิจารณาเป็นเคส)' END
         ELSE '' END,
    'all', p_job_id);
  PERFORM app_audit('job', p_job_id, 'cancel_job', actor.id,
    'ยกเลิก ' || j.job_no || ' (' || trim(p_reason) || ') — คืน LBS ' || returned || ' เครื่องกลับสต็อกเดิม'
    || CASE WHEN partial_cnt > 0
         THEN ' + วัสดุรับบางส่วน ' || partial_cnt || ' รายการ'
              || CASE WHEN p_received_to_central THEN ' คืนเข้าสต็อกกลาง' ELSE ' (คงไว้กับ Job พิจารณาเป็นเคส)' END
         ELSE '' END);
END $$;
