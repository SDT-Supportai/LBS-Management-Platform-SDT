-- =============================================================================
-- 0075 — 📅 ขยาย/แก้กำหนดส่ง (EOT) + ประวัติการเลื่อน (2026-09-17)
--
-- ที่มา: Dashboard ขึ้น "เลยกำหนด" กับงานที่ช่างกำลังติดตั้งอยู่หน้างาน เพราะระบบตัดสิน
--   จาก required_date vs วันนี้ อย่างเดียว — ไม่เคยดูว่าของออกจากคลังไปแล้วหรือยัง
--   และ **ไม่มีที่ให้บันทึกว่าตกลงเลื่อนวันส่งมอบกับลูกค้าแล้ว** ⇒ ใบที่เลื่อนโดยชอบธรรม
--   ค้างแดงตลอดไป · คนอ่านเลิกเชื่อสีแดง = ตัวเตือนตายทั้งระบบ
--
-- 🔴 ทำไมเป็น "ตารางประวัติ" ไม่ใช่คอลัมน์ revised_due_date บน jobs:
--    จำนวนครั้งที่เลื่อน + เหตุผลแต่ละครั้ง คือหลักฐานตอนเคลมค่าปรับ/ต่อสัญญา
--    ทับคอลัมน์เดียว = เลื่อนครั้งที่ 2 ลบครั้งที่ 1 ทิ้ง เหลือแต่ผลลัพธ์ ไม่เหลือเหตุผล
--    กติกา "แถวล่าสุดชนะ" เหมือน unit_installations (0035)
--
-- 🔴 required_date **ไม่ถูกแก้** — คือกำหนดตามสัญญาเดิม ใช้เทียบว่าเลื่อนไปกี่วันจากวันแรก
--    UI โชว์คู่กันเสมอ (กำหนดใหม่ + "เดิม dd/mm/yyyy")
--
-- ⚠️ guard = app_assert_job_procurable (0037) — เลื่อนได้จนถึง issued แต่ปิดเมื่อ
--    installed/cancelled · ใบที่ปิดงานแล้วไม่มีอะไรให้เลื่อน และ cancelled ไม่ควรแก้อะไรอีก
--    guard ตัวนี้เรียก app_assert_job_owner (0042) ให้แล้ว = ได้สิทธิ์เจ้าของงานฟรี
--
-- ⚠️ ชนิดแจ้งเตือน job_due_extended **ไม่อยู่ใน allowlist ของ 0066** ⇒ บันทึกลง
--    notifications ครบ ขึ้นหน้าแจ้งเตือน/Audit ตามปกติ แต่ไม่กินโควตา LINE (line_status='off')
--    ตั้งใจ: การเลื่อนวันไม่ได้บล็อกใครให้ทำงานต่อไม่ได้ ณ วินาทีนั้น
--
-- demo sync ที่ src/data/logic.ts (extendJobDue / deleteJobDueExtension / jobDelivery)
-- รันหลัง 0074 · idempotent · **ต้องรันก่อน push** (UI เรียก RPC ใหม่)
-- =============================================================================

-- ---------- 1) ตาราง ----------
CREATE TABLE IF NOT EXISTS job_due_extensions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  prev_due_date DATE,                      -- กำหนดที่มีผล "ก่อน" แถวนี้ (NULL = ยังไม่เคยระบุ)
  new_due_date  DATE NOT NULL,
  reason        TEXT NOT NULL,             -- บังคับ — ไม่มีเหตุผล = เลื่อนไม่ได้
  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_due_ext_reason_ck CHECK (btrim(reason) <> '')
);

COMMENT ON TABLE job_due_extensions IS
  '0075 — ประวัติการเลื่อนกำหนดส่ง · แถวล่าสุด (created_at DESC) คือกำหนดที่มีผล · jobs.required_date คงเป็นกำหนดตามสัญญาเดิมเสมอ';

CREATE INDEX IF NOT EXISTS idx_job_due_ext_job ON job_due_extensions(job_id, created_at DESC);

ALTER TABLE job_due_extensions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_due_ext_read ON job_due_extensions;
CREATE POLICY job_due_ext_read ON job_due_extensions FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON job_due_extensions FROM authenticated, anon;

-- ---------- 2) helper: กำหนดที่มีผลของ Job ----------
-- กำหนดตามสัญญา = วันที่ใกล้สุดในบรรดาจุดติดตั้งทั้งหมด (ตรงกับ jobDueDate ฝั่ง client)
CREATE OR REPLACE FUNCTION app_job_contract_due(j jobs) RETURNS DATE
LANGUAGE sql IMMUTABLE AS $$
  SELECT min(d) FROM (
    SELECT j.required_date AS d
    UNION ALL
    SELECT (s ->> 'requiredDate')::DATE
      FROM jsonb_array_elements(COALESCE(j.install_sites, '[]'::jsonb)) s
     WHERE NULLIF(btrim(COALESCE(s ->> 'requiredDate', '')), '') IS NOT NULL
  ) x;
$$;

CREATE OR REPLACE FUNCTION app_job_effective_due(p_job_id UUID) RETURNS DATE
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE j jobs; d DATE;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id;
  IF j.id IS NULL THEN RETURN NULL; END IF;
  SELECT new_due_date INTO d FROM job_due_extensions
   WHERE job_id = p_job_id ORDER BY created_at DESC, id DESC LIMIT 1;
  RETURN COALESCE(d, app_job_contract_due(j));
END $$;

-- ---------- 3) RPC ----------
CREATE OR REPLACE FUNCTION rpc_extend_job_due(
  p_job_id UUID, p_new_due DATE, p_reason TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; v_reason TEXT; v_prev DATE; new_id UUID; v_contract DATE;
BEGIN
  actor := app_assert_dept(ARRAY['project']);          -- Project + Manage
  j := app_assert_job_procurable(p_job_id);            -- เจ้าของงาน (0042) + ยังไม่ปิด/ยกเลิก

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ต้องระบุเหตุผลที่เลื่อนกำหนดส่ง — เหตุผลคือหลักฐานตอนเคลมค่าปรับ/ต่อสัญญา';
  END IF;
  IF p_new_due IS NULL THEN RAISE EXCEPTION 'กรุณาระบุกำหนดส่งใหม่'; END IF;

  v_prev := app_job_effective_due(p_job_id);
  IF v_prev IS NOT NULL AND p_new_due = v_prev THEN
    RAISE EXCEPTION 'กำหนดส่งใหม่ตรงกับกำหนดเดิม (%) — ไม่มีอะไรเปลี่ยน', to_char(v_prev, 'DD/MM/YYYY');
  END IF;

  v_contract := app_job_contract_due(j);
  INSERT INTO job_due_extensions (job_id, prev_due_date, new_due_date, reason, created_by)
  VALUES (p_job_id, v_prev, p_new_due, v_reason, actor.id)
  RETURNING id INTO new_id;

  PERFORM app_audit('job', p_job_id, 'extend_job_due', actor.id,
    j.job_no || ' เลื่อนกำหนดส่ง ' || COALESCE(to_char(v_prev, 'DD/MM/YYYY'), '(ไม่เคยระบุ)') ||
    ' → ' || to_char(p_new_due, 'DD/MM/YYYY') ||
    CASE WHEN v_contract IS NOT NULL
         THEN ' (ตามสัญญา ' || to_char(v_contract, 'DD/MM/YYYY') || ' · รวม ' ||
              (p_new_due - v_contract) || ' วัน)'
         ELSE '' END ||
    ' · เหตุผล: ' || v_reason);

  -- ไม่เข้า allowlist LINE (0066) → บันทึกอย่างเดียว ไม่กินโควตา
  PERFORM app_notify('job_due_extended',
    '📅 ' || j.job_no || ' เลื่อนกำหนดส่งเป็น ' || to_char(p_new_due, 'DD/MM/YYYY') || ' · ' || v_reason,
    'all', p_job_id);

  RETURN new_id;
END $$;

-- ยกเลิกการเลื่อน — ได้เฉพาะ "แถวล่าสุด" เท่านั้น
-- ลบแถวกลางประวัติได้ = prev_due_date ของแถวถัดไปชี้ไปยังค่าที่ไม่มีอยู่จริง ประวัติอ่านไม่รู้เรื่อง
CREATE OR REPLACE FUNCTION rpc_delete_job_due_extension(p_ext_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; e job_due_extensions; j jobs; latest UUID;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO e FROM job_due_extensions WHERE id = p_ext_id;
  IF e.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการเลื่อนกำหนดส่งนี้'; END IF;
  j := app_assert_job_procurable(e.job_id);

  SELECT id INTO latest FROM job_due_extensions
   WHERE job_id = e.job_id ORDER BY created_at DESC, id DESC LIMIT 1;
  IF latest <> p_ext_id THEN
    RAISE EXCEPTION 'ยกเลิกได้เฉพาะการเลื่อนครั้งล่าสุด — ประวัติก่อนหน้าเป็นหลักฐาน แก้ย้อนหลังไม่ได้';
  END IF;

  DELETE FROM job_due_extensions WHERE id = p_ext_id;
  PERFORM app_audit('job', e.job_id, 'delete_job_due_extension', actor.id,
    j.job_no || ' ยกเลิกการเลื่อนกำหนดส่ง (กลับไปใช้ ' ||
    COALESCE(to_char(e.prev_due_date, 'DD/MM/YYYY'), 'กำหนดตามสัญญา') || ')');
END $$;

REVOKE ALL ON FUNCTION public.rpc_extend_job_due(UUID, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_extend_job_due(UUID, DATE, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_delete_job_due_extension(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_delete_job_due_extension(UUID) TO authenticated;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE job_due_extensions;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- ---------- 4) ตรวจผล ----------
DO $$
DECLARE n INT; d DATE; jid UUID;
BEGIN
  IF to_regclass('public.job_due_extensions') IS NULL THEN
    RAISE EXCEPTION '0075: ไม่มีตาราง job_due_extensions';
  END IF;

  -- เขียนตรงไม่ได้ (กติกา 0057) · อ่านได้
  IF has_table_privilege('authenticated', 'public.job_due_extensions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.job_due_extensions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.job_due_extensions', 'DELETE') THEN
    RAISE EXCEPTION '0075: authenticated เขียน job_due_extensions ตรงได้ — ต้องผ่าน RPC เท่านั้น (0057)';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.job_due_extensions', 'SELECT') THEN
    RAISE EXCEPTION '0075: authenticated อ่าน job_due_extensions ไม่ได้ — ประวัติจะว่างเปล่า';
  END IF;

  -- required_date ต้องไม่ถูกแตะ: ยังไม่มีแถวเลื่อน ⇒ effective = contract
  SELECT id INTO jid FROM jobs WHERE required_date IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM job_due_extensions e WHERE e.job_id = jobs.id) LIMIT 1;
  IF jid IS NOT NULL THEN
    SELECT app_job_effective_due(jid) INTO d;
    IF d IS NULL THEN RAISE EXCEPTION '0075: app_job_effective_due คืน NULL ทั้งที่ Job มีกำหนดตามสัญญา'; END IF;
  END IF;

  -- job_due_extended ต้อง **ไม่** อยู่ใน allowlist LINE (0066)
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_notify'
     AND pg_get_functiondef(p.oid) LIKE '%job_due_extended%';
  IF n <> 0 THEN
    RAISE EXCEPTION '0075: job_due_extended หลุดเข้า allowlist LINE — จะกินโควตา 300/เดือน';
  END IF;

  RAISE NOTICE '0075: OK — ขยาย/แก้กำหนดส่งพร้อมใช้ (ประวัติเก็บครบ · required_date คงเป็นกำหนดตามสัญญา)';
END $$;
