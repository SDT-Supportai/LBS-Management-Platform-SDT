-- =====================================================================
-- 0042: สิทธิ์ระดับแถว — Project ดำเนินการได้เฉพาะ Job ที่อีเมลตัวเองเปิด (2026-08-03)
--  ปัญหา: สิทธิ์ทั้งระบบเป็น dept-level 100% (app_assert_dept ตรวจแค่ "เป็นแผนก project ไหม")
--    → Project หลายคนแก้งานกันได้ทุกใบ ไม่มีความรับผิดชอบต่อ Job
--  มติ (2026-08-03):
--    - ล็อกเฉพาะ "การเขียน" · การอ่านเปิดหมดตามเดิม (Job อื่น = ดูได้อย่างเดียว)
--    - เจ้าของ 1 คน = jobs.opened_by (มีข้อมูลอยู่แล้วตั้งแต่ 0001/0002 ไม่ต้อง backfill)
--    - ไม่ทำปุ่มโอนเจ้าของ — คนลาออก/ลาพักร้อนให้ Manage เข้าไปทำแทน (Manage ข้ามได้ทุกด่านอยู่แล้ว)
--    - opened_by IS NULL (งานเก่า/นำเข้า) = ไม่ล็อก ทุกคนในแผนก project ยังแก้ได้ (grandfather)
--  ⚠️ กติกา 3 ข้อที่ทำให้ไม่พังของเดิม:
--    1) บังคับเฉพาะ department = 'project' — Purchasing รับของ / Service ติดตั้ง / Division อนุมัติ
--       ต้องข้ามงานได้ตามธรรมชาติ · ถ้าบังคับทุกแผนกระบบล่มทันที
--    2) auth.uid() หาโปรไฟล์ไม่เจอ → ข้าม — ไม่งั้น "อนุมัติผ่าน LINE" (0033) พังทั้งหมด
--       เพราะ rpc_line_approve รันด้วย service_role (auth.uid() = NULL)
--    3) หลัง Division อนุมัติ app_exec_* รันด้วย uid ของ "ผู้อนุมัติ" (dept sales) → ข้ามเอง
--  ✅ ปลอดภัยจากกับดัก §9.5: guard 4 ตัวนี้ไม่มี app_notify → 0031 ไม่เคยแตะ → recreate เต็มตัวได้
--     (rpc_transfer_job_material_to_stock มี app_notify → ใช้ app_swap_guard patch บรรทัดเดียว)
--  demo sync ที่ src/data/logic.ts (assertJobOwner) · รันหลัง 0041 · idempotent
-- =====================================================================

-- ---------- 1) guard เจ้าของงาน ----------
CREATE OR REPLACE FUNCTION app_assert_job_owner(j jobs) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me profiles;
BEGIN
  SELECT * INTO me FROM profiles WHERE id = auth.uid();
  IF me.id IS NULL THEN RETURN; END IF;               -- service_role (LINE อนุมัติ 0033) → ข้าม
  IF me.department <> 'project' THEN RETURN; END IF;   -- Division/Purchasing/Service/Manage → ข้าม
  IF j.opened_by IS NULL THEN RETURN; END IF;         -- งานเก่าก่อน 0042 → ไม่ล็อก (grandfather)
  IF j.opened_by <> me.id THEN
    RAISE EXCEPTION '% ไม่ใช่งานที่คุณเปิด — ดูได้อย่างเดียว (ผู้รับผิดชอบ: %)',
      j.job_no, COALESCE((SELECT full_name FROM profiles WHERE id = j.opened_by), 'ไม่ระบุ');
  END IF;
END $$;

-- ---------- 2) เสียบเข้า guard chain (จุดคอขวดเดียว ครอบ ~12 RPC) ----------
-- app_assert_job_editable  ← update_job · delete_draft_job · draw_lbs · return_lbs
--                            · app_exec_issue_job/cancel_job/swap_lbs
-- body คงเดิมจาก 0015 (ล็อกแถว FOR UPDATE กัน race) — เพิ่มเฉพาะบรรทัด owner
CREATE OR REPLACE FUNCTION app_assert_job_editable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IN ('issued', 'installed') THEN
    RAISE EXCEPTION '% เบิกให้ Service แล้ว — ล็อก แก้ไข allocation ไม่ได้', j.job_no;
  END IF;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว แก้ไขไม่ได้', j.job_no;
  END IF;
  PERFORM app_assert_job_owner(j);   -- 0042
  RETURN j;
END $$;

-- app_assert_job_procurable ← add/update/cancel_accessory_request · return_accessory
--                             · app_exec_create_pr   (body เดิมจาก 0037)
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
  PERFORM app_assert_job_owner(j);   -- 0042
  RETURN j;
END $$;

-- app_assert_job_cost_editable ← update_po_line_price (dept purchasing → ข้ามเอง)
-- ใส่ไว้เพื่อความสม่ำเสมอ เผื่ออนาคตมี RPC ฝั่ง project มาใช้ guard ตัวนี้ (body เดิมจาก 0037)
CREATE OR REPLACE FUNCTION app_assert_job_cost_editable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว แก้ไขไม่ได้', j.job_no;
  END IF;
  PERFORM app_assert_job_owner(j);   -- 0042
  RETURN j;
END $$;

-- app_assert_job_reopenable ← rpc_request_approval(reopen_job) ผ่าน app_assert_job_editable_for
-- (body เดิมจาก 0041) — ขอเปิดงานใหม่ได้เฉพาะงานของตัวเอง
CREATE OR REPLACE FUNCTION app_assert_job_reopenable(jid UUID) RETURNS jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = jid FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'installed' THEN
    RAISE EXCEPTION 'เปิดงานใหม่ได้เฉพาะงานที่ปิดแล้ว (Installed) — % อยู่สถานะอื่น', j.job_no;
  END IF;
  PERFORM app_assert_job_owner(j);   -- 0042
  RETURN j;
END $$;

-- ---------- 3) 2 RPC ฝั่ง project ที่ไม่ผ่าน guard chain ----------
-- (ก) rpc_delete_accessory_request (0027) — ไม่มี app_notify → recreate เต็มตัวปลอดภัย
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
  PERFORM app_assert_job_owner(j);   -- 0042
  SELECT * INTO it FROM items WHERE id = r.item_id;
  DELETE FROM job_accessory_requests WHERE id = p_request_id;
  PERFORM app_audit('job_accessory_request', p_request_id, 'delete_accessory_request', actor.id,
    COALESCE(j.job_no, '') || ' ลบรายการวัสดุที่ยกเลิก ' || COALESCE(it.name, '') || ' ออกจากการ์ด');
END $$;

-- (ข) rpc_transfer_job_material_to_stock (0038) — มี app_notify → patch บรรทัดเดียวเท่านั้น
--     ⚠️ ห้าม CREATE OR REPLACE ด้วย body จากไฟล์เก่า (บทเรียน §9.5) · บรรทัดนี้ unique ในฟังก์ชัน
DO $$
BEGIN
  PERFORM app_swap_guard('rpc_transfer_job_material_to_stock',
    'SELECT * INTO j FROM jobs WHERE id = r.job_id FOR UPDATE;',
    'SELECT * INTO j FROM jobs WHERE id = r.job_id FOR UPDATE; PERFORM app_assert_job_owner(j);');
END $$;

-- ---------- 4) RLS — defense in depth (ตัวจริงคือ RPC ข้างบน) ----------
-- client เขียนตารางตรงไม่ได้อยู่แล้ว (ทุก write ผ่าน RPC SECURITY DEFINER ซึ่ง bypass RLS)
-- แต่รัด policy ไว้กันคนยิง PostgREST ตรงด้วย JWT ของตัวเอง · SELECT ยังเปิดหมดผ่าน policy read_all
DROP POLICY IF EXISTS project_jobs ON jobs;
CREATE POLICY project_jobs ON jobs FOR ALL TO authenticated
  USING (
    my_department() = 'admin'
    OR (my_department() = 'project' AND (opened_by = auth.uid() OR opened_by IS NULL))
  )
  WITH CHECK (
    my_department() = 'admin'
    OR (my_department() = 'project' AND (opened_by = auth.uid() OR opened_by IS NULL))
  );

-- ---------- 5) รายงานผลตอนรัน ----------
DO $$
DECLARE tot INT; orphan INT;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE opened_by IS NULL) INTO tot, orphan FROM jobs;
  RAISE NOTICE '0042 OK — Project ทำรายการได้เฉพาะ Job ที่ตัวเองเปิด (Job อื่นดูได้อย่างเดียว)';
  RAISE NOTICE '  Job ทั้งหมด % ใบ · ไม่มีเจ้าของ (opened_by NULL, ทุกคนยังแก้ได้) % ใบ', tot, orphan;
END $$;
