-- =====================================================================
-- 0037: จัดซื้อเพิ่มเติมหลังเบิก (Extra purchase after issue) (2026-07-30)
--  ปัญหา: หลัง Job = issued ระบบล็อกฝั่งจัดซื้อทั้งหมด (app_assert_job_editable)
--    → งานติดตั้งจริงที่ต้องซื้อ Raw Material เพิ่ม หรือจ้าง Outsourcing เพิ่ม ทำไม่ได้
--    ทางเดียวคือเปิด Job ใหม่ → ต้นทุน/กำไรแยกจาก Job เดิม รายงานเพี้ยน
--    (หมวด raw_mat/outsourcing actual derive จาก PR/PO เท่านั้น กรอกมือไม่ได้)
--  แก้: แยก guard เป็น 3 ระดับ
--    - app_assert_job_editable   (เดิม) = แก้ scope/allocation/LBS → ล็อกตั้งแต่ issued  [ไม่แตะ]
--    - app_assert_job_procurable (ใหม่) = เพิ่มวัสดุ/ออก PR → อนุญาตถึง issued, ปิดเมื่อ installed/cancelled
--    - app_assert_job_cost_editable (ใหม่) = แก้ราคาจริงย้อนหลัง → อนุญาตแม้ installed
--      (ใบแจ้งหนี้มักมาช้ากว่าของ) ปิดเฉพาะ cancelled
--  การอนุมัติ: ออก PR หลังเบิกยังต้องผ่าน Division ตามเดิม (rpc_request_approval type=create_pr)
--    อีก 3 ประเภท (issue_job / cancel_job / swap_lbs) ยังล็อกที่ก่อนเบิกเหมือนเดิม
--  วิธีแก้ฟังก์ชัน: pg_get_functiondef + replace() เฉพาะบรรทัด guard — คง body เดิม 100%
--    (เทคนิคเดียวกับ 0031 · ห้าม CREATE OR REPLACE ด้วย body เก่า เพราะจะ revert การย่อ
--     ข้อความแจ้งเตือนของ 0031)
--  demo sync ที่ src/data/logic.ts (assertJobProcurable / assertJobCostEditable)
--  รันหลัง 0036 · idempotent (รันซ้ำได้)
-- =====================================================================

-- ---------- 1) guard ใหม่ ----------
CREATE OR REPLACE FUNCTION app_assert_job_procurable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status = 'installed' THEN
    RAISE EXCEPTION '% ปิดงานติดตั้งแล้ว — จัดซื้อเพิ่มไม่ได้', j.job_no;
  END IF;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว แก้ไขไม่ได้', j.job_no;
  END IF;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION app_assert_job_cost_editable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว แก้ไขไม่ได้', j.job_no;
  END IF;
  RETURN j;
END $$;

-- guard สำหรับ rpc_request_approval — แยกตามประเภทคำขอ
CREATE OR REPLACE FUNCTION app_assert_job_editable_for(jid UUID, req_type TEXT) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF req_type = 'create_pr' THEN
    RETURN app_assert_job_procurable(jid);   -- ออก PR หลังเบิกได้
  END IF;
  RETURN app_assert_job_editable(jid);       -- issue_job / cancel_job / swap_lbs ล็อกตามเดิม
END $$;

-- ---------- 2) helper: สลับ guard ในฟังก์ชันที่มีอยู่ โดยไม่แตะ body ส่วนอื่น ----------
-- แก้ทุก overload ของชื่อนั้น (rpc_add_accessory_request เคยเปลี่ยน signature หลายครั้ง
-- ใน 0002/0006/0008/0017 → LIVE อาจมี overload เก่าค้างอยู่ ต้องแก้ให้ครบ ไม่ใช่ตัวแรกที่เจอ)
CREATE OR REPLACE FUNCTION app_swap_guard(p_fnname TEXT, p_old TEXT, p_new TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE def TEXT; foid OID; total INT := 0; patched INT := 0; already INT := 0;
BEGIN
  FOR foid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = p_fnname
  LOOP
    total := total + 1;
    def := pg_get_functiondef(foid);
    IF position(p_old IN def) > 0 THEN
      EXECUTE replace(def, p_old, p_new);
      patched := patched + 1;
    ELSIF position(p_new IN def) > 0 THEN
      already := already + 1;                     -- แก้ไปแล้ว (idempotent)
    END IF;
  END LOOP;
  IF total = 0 THEN RAISE EXCEPTION 'ไม่พบฟังก์ชัน %', p_fnname; END IF;
  IF patched = 0 AND already = 0 THEN
    RAISE EXCEPTION 'ไม่พบ guard เดิมใน % (% overload) — %', p_fnname, total, p_old;
  END IF;
  RAISE NOTICE '  % : % overload · แก้ % · เดิมอยู่แล้ว %', p_fnname, total, patched, already;
END $$;

DO $$
BEGIN
  -- เพิ่มรายการวัสดุ/Outsourcing เข้า Job (ล่าสุด: 0017)
  PERFORM app_swap_guard('rpc_add_accessory_request',
    'app_assert_job_editable(p_job_id)', 'app_assert_job_procurable(p_job_id)');

  -- ออก PR — ใช้ร่วมทั้ง rpc_create_pr (admin) และ rpc_approve_request (หลัง Division อนุมัติ)
  PERFORM app_swap_guard('app_exec_create_pr',
    'app_assert_job_editable(p_job_id)', 'app_assert_job_procurable(p_job_id)');

  -- แก้จำนวน / แก้ราคาประมาณ / ยกเลิกรายการ / คืนของเข้าคลังกลาง
  PERFORM app_swap_guard('rpc_update_accessory_request_qty',
    'app_assert_job_editable(r.job_id)', 'app_assert_job_procurable(r.job_id)');
  PERFORM app_swap_guard('rpc_update_accessory_request_price',
    'app_assert_job_editable(r.job_id)', 'app_assert_job_procurable(r.job_id)');
  PERFORM app_swap_guard('rpc_cancel_accessory_request',
    'app_assert_job_editable(r.job_id)', 'app_assert_job_procurable(r.job_id)');
  PERFORM app_swap_guard('rpc_return_accessory',
    'app_assert_job_editable(r.job_id)', 'app_assert_job_procurable(r.job_id)');

  -- ราคาจริงหลังออก PO (0030) — ทำได้แม้ปิดงานแล้ว
  PERFORM app_swap_guard('rpc_update_po_line_price',
    'app_assert_job_editable(r.job_id)', 'app_assert_job_cost_editable(r.job_id)');

  -- ขออนุมัติ (0028) — แยกตามประเภท
  PERFORM app_swap_guard('rpc_request_approval',
    'app_assert_job_editable(p_job_id)', 'app_assert_job_editable_for(p_job_id, p_type)');
END $$;

-- ---------- 3) ตรวจผล: ฟังก์ชันเหล่านี้ต้องไม่เหลือ guard เดิมแล้ว ----------
DO $$
DECLARE bad TEXT := '';
BEGIN
  SELECT string_agg(DISTINCT p.proname, ' ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = ANY(ARRAY['rpc_add_accessory_request', 'app_exec_create_pr',
      'rpc_update_accessory_request_qty', 'rpc_update_accessory_request_price',
      'rpc_cancel_accessory_request', 'rpc_return_accessory', 'rpc_update_po_line_price',
      'rpc_request_approval'])
    -- 'app_assert_job_editable(' ไม่ match 'app_assert_job_editable_for(' เพราะมี '_for' คั่น
    AND position('app_assert_job_editable(' IN pg_get_functiondef(p.oid)) > 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0037 ไม่สมบูรณ์ — ยังเหลือ guard เดิมใน: %', bad; END IF;
  RAISE NOTICE '0037 OK — ปลดล็อกฝั่งจัดซื้อหลังเบิกเรียบร้อย';
END $$;
