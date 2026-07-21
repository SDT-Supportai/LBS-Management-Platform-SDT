-- =====================================================================
-- ล้างข้อมูล Job เดียว เพื่อเริ่มสร้างใหม่ (2026-07-20)
-- ใช้เมื่อ Job ค้างสถานะ (เบิก/ยกเลิก/ติดตั้งแล้ว) แล้วอยากลบทิ้งเพื่อเปิด Job No. เดิมใหม่
-- ปลอดภัย: ลบเฉพาะ Job ที่ระบุ + คืน LBS กลับสต็อก (ไม่ลบตัวเครื่อง) + คืน accessory คลังกลาง
-- ⚠️ แก้ค่า v_job_no ด้านล่างให้ตรง Job ที่จะลบ แล้วรันทั้งบล็อกใน Supabase SQL Editor
-- =====================================================================
DO $$
DECLARE
  v_job_no TEXT := '102LB20J3189';   -- << เปลี่ยนเป็น Job No. ที่ต้องการลบ
  v_job UUID; v_lbs INT; v_acc INT;
BEGIN
  SELECT id INTO v_job FROM jobs WHERE job_no = v_job_no;
  IF v_job IS NULL THEN RAISE NOTICE 'ไม่พบ Job "%" — ไม่มีอะไรให้ลบ', v_job_no; RETURN; END IF;

  -- 1) คืน LBS ทุกเครื่องของ Job นี้กลับเข้าสต็อกเดิม (เก็บเครื่อง/serial ไว้ ไม่ลบ)
  --    ปิด trigger trg_block_issued_edit ชั่วคราว — Job ที่ issued/installed จะโดนบล็อกแก้ allocation
  --    (ที่นี่คือการล้าง Job ทิ้งทั้งใบ ไม่ใช่แก้ระหว่างใช้งาน จึงปิดได้)
  ALTER TABLE lbs_units DISABLE TRIGGER trg_block_issued_edit;
  UPDATE lbs_units SET status = 'in_stock', job_id = NULL, updated_at = now()
  WHERE job_id = v_job AND status IN ('allocated', 'issued');
  GET DIAGNOSTICS v_lbs = ROW_COUNT;
  ALTER TABLE lbs_units ENABLE TRIGGER trg_block_issued_edit;

  -- 2) คืน accessory คลังกลางที่เบิกไปแล้ว (issued) กลับยอด
  UPDATE accessory_stock a SET qty_on_hand = a.qty_on_hand + r.qty_requested, updated_at = now()
  FROM job_accessory_requests r
  WHERE r.job_id = v_job AND r.source = 'central_stock' AND r.status = 'issued' AND a.item_id = r.item_id;

  -- 3) ลบเอกสารของ Job นี้ (เรียงตาม FK — ลูกก่อนพ่อ)
  SELECT count(*) INTO v_acc FROM job_accessory_requests WHERE job_id = v_job;
  DELETE FROM job_accessory_requests WHERE job_id = v_job;   -- อ้าง po_id + pr_id
  DELETE FROM purchase_orders        WHERE job_id = v_job;   -- อ้าง pr_id
  DELETE FROM purchase_requisitions  WHERE job_id = v_job;
  DELETE FROM stock_allocations      WHERE job_id = v_job;
  DELETE FROM approval_requests      WHERE job_id = v_job;
  DELETE FROM notification_reads     WHERE notification_id IN (SELECT id FROM notifications WHERE job_id = v_job);
  DELETE FROM notifications          WHERE job_id = v_job;
  DELETE FROM jobs                   WHERE id = v_job;
  -- audit_logs ไม่มี FK กับ jobs — ปล่อยไว้เป็นประวัติ (ไม่บล็อกการเปิด Job No. เดิมใหม่)

  RAISE NOTICE 'ลบ Job "%" แล้ว — คืน LBS % เครื่องเข้าสต็อก, ลบรายการวัสดุ/PR/PO % รายการ. เปิด Job No. เดิมใหม่ได้เลย', v_job_no, v_lbs, v_acc;
END $$;
