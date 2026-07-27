-- 0034: Service — บันทึกออกหน้างานแบบยังไม่จบ (เลื่อนนัด / ติดปัญหา) เฟส A (2026-07-27)
--  ปัญหาเดิม: งาน issued มีทางออกทางเดียวคือ confirmInstall (สำเร็จ) — ไปหน้างานแล้วทำไม่ได้/ต้องเลื่อน
--    ไม่มีที่บันทึก งานค้าง issued เงียบ ๆ
--  แก้: ตาราง job_site_visits เก็บ attempt ที่ไม่สำเร็จ; Job คงสถานะ issued (ไม่ใช่ terminal ใหม่)
--    - rescheduled: อัปเดต install_start_date/install_end_date ของ Job เป็นนัดใหม่
--    - failed: บันทึกปัญหาไว้เฉย ๆ รอเข้าใหม่
--  demo sync ที่ src/data/logic.ts (logSiteVisit) · รันหลัง 0033 (idempotent)

CREATE TABLE IF NOT EXISTS job_site_visits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  outcome        TEXT NOT NULL CHECK (outcome IN ('rescheduled', 'failed')),
  reason         TEXT NOT NULL,
  new_start_date DATE,
  new_end_date   DATE,
  performed_by   UUID REFERENCES profiles(id),
  performed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_site_visits_job_idx ON job_site_visits (job_id);

ALTER TABLE job_site_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON job_site_visits;
CREATE POLICY read_all ON job_site_visits FOR SELECT TO authenticated USING (true);
-- เขียนผ่าน RPC เท่านั้น (ไม่มี write policy)

-- Service (dept 'service') + admin บันทึกได้
CREATE OR REPLACE FUNCTION rpc_log_site_visit(
  p_job_id UUID, p_outcome TEXT, p_reason TEXT, p_new_start_date DATE, p_new_end_date DATE
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; s DATE; e DATE; range_txt TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  IF p_outcome NOT IN ('rescheduled', 'failed') THEN RAISE EXCEPTION 'ประเภทไม่ถูกต้อง'; END IF;
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status <> 'issued' THEN RAISE EXCEPTION '%: บันทึกได้เฉพาะงานที่เบิกแล้ว (Issued)', j.job_no; END IF;
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผล/รายละเอียดหน้างาน'; END IF;

  IF p_outcome = 'rescheduled' THEN
    IF p_new_start_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันนัดใหม่'; END IF;
    s := p_new_start_date;
    e := COALESCE(p_new_end_date, p_new_start_date);
    IF e < s THEN RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม'; END IF;
    UPDATE jobs SET install_start_date = s, install_end_date = e WHERE id = p_job_id;
  END IF;

  INSERT INTO job_site_visits (job_id, outcome, reason, new_start_date, new_end_date, performed_by)
  VALUES (p_job_id, p_outcome, trim(p_reason), s, e, actor.id);

  range_txt := CASE WHEN s = e THEN s::TEXT ELSE s::TEXT || ' – ' || e::TEXT END;
  IF p_outcome = 'rescheduled' THEN
    PERFORM app_notify('install_rescheduled',
      '⏰ ' || j.job_no || ' เลื่อนนัดติดตั้ง → ' || range_txt || ' · ' || trim(p_reason), 'project', p_job_id);
    PERFORM app_audit('job', p_job_id, 'reschedule_install', actor.id,
      j.job_no || ' เลื่อนนัดติดตั้งเป็น ' || range_txt || ' — ' || trim(p_reason));
  ELSE
    PERFORM app_notify('install_failed',
      '⚠️ ' || j.job_no || ' ติดปัญหาหน้างาน: ' || trim(p_reason), 'project', p_job_id);
    PERFORM app_audit('job', p_job_id, 'failed_visit', actor.id,
      j.job_no || ' ติดปัญหาหน้างาน — ' || trim(p_reason));
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_log_site_visit(UUID, TEXT, TEXT, DATE, DATE) TO authenticated;

-- Realtime
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE job_site_visits;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
