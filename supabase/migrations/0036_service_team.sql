-- 0036: Service — ทะเบียนทีมช่าง + มอบหมายงาน + ผู้ติดตั้งรายเครื่อง เฟส C (2026-07-28)
--  ทำไมแยกจาก profiles: profiles.id อ้าง auth.users (ทุก user ต้องมีบัญชี login)
--    และไม่มีฟิลด์เบอร์/ตำแหน่ง → ช่างภาคสนาม/outsource ใส่เป็น user ไม่ได้
--    team_members.user_id (nullable) ผูกบัญชีให้ช่างที่มี login
--  ความสัมพันธ์กับ 0035 (ตรวจแล้วไม่ขัดแย้ง):
--    - assignment เป็น "แผนงาน" ไม่ใช่ "สิทธิ์" — rpc_confirm_unit_install ยังตรวจสิทธิ์
--      จาก app_assert_dept(['service']) ตามเดิม (ช่างไม่มี login จะบังคับด้วย assignment ไม่ได้)
--    - unit_installations.performed_by = user ผู้บันทึก (คงเดิม)
--      + เพิ่ม installed_by_member_id = ช่างที่ลงมือติดตั้งจริง → traceability ราย serial
--    - lock lifecycle เดียวกับ 0035: มอบหมาย/แก้ได้เฉพาะ job terminal_status = 'issued'
--    - ตารางรายบุคคล derive วันนัดจาก jobs.install_start_date/end_date
--      (เฟส A 0034 เลื่อนนัดแล้วค่านี้ขยับตามเอง — ไม่ copy เก็บซ้ำ)
--  demo sync ที่ src/data/logic.ts · รันหลัง 0035 (idempotent)

-- ---------- 1) ทะเบียนทีมช่าง ----------
CREATE TABLE IF NOT EXISTS team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(120) NOT NULL,
  last_name  VARCHAR(120) NOT NULL,
  phone      VARCHAR(40)  NOT NULL,
  position   VARCHAR(120) NOT NULL,
  user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 1 บัญชี login ผูกได้กับช่าง 1 คน
CREATE UNIQUE INDEX IF NOT EXISTS team_members_user_uq ON team_members (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON team_members;
CREATE POLICY read_all ON team_members FOR SELECT TO authenticated USING (true);

-- ---------- 2) มอบหมายทีมให้ Job ----------
CREATE TABLE IF NOT EXISTS job_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  is_lead     BOOLEAN NOT NULL DEFAULT false,
  assigned_by UUID REFERENCES profiles(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_assignments_uq UNIQUE (job_id, member_id)
);
CREATE INDEX IF NOT EXISTS job_assignments_member_idx ON job_assignments (member_id);

ALTER TABLE job_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON job_assignments;
CREATE POLICY read_all ON job_assignments FOR SELECT TO authenticated USING (true);

-- ---------- 3) ต่อ 0035: ช่างที่ลงมือติดตั้งเครื่องนี้ ----------
ALTER TABLE unit_installations
  ADD COLUMN IF NOT EXISTS installed_by_member_id UUID REFERENCES team_members(id) ON DELETE SET NULL;

-- view สถานะรายเครื่อง — เพิ่มคอลัมน์ผู้ติดตั้ง (ต้อง DROP ก่อนเพราะ column list เปลี่ยน)
DROP VIEW IF EXISTS v_unit_install_state;
CREATE VIEW v_unit_install_state AS
SELECT DISTINCT ON (unit_id)
  unit_id, job_id, outcome, installed_date, reason, installed_by_member_id, performed_at
FROM unit_installations
ORDER BY unit_id, performed_at DESC;

-- ---------- 4) RPC: ทะเบียนช่าง (Service + admin) ----------
CREATE OR REPLACE FUNCTION rpc_create_team_member(
  p_first_name TEXT, p_last_name TEXT, p_phone TEXT, p_position TEXT, p_user_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; mid UUID;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  IF COALESCE(btrim(p_first_name), '') = '' OR COALESCE(btrim(p_last_name), '') = '' THEN
    RAISE EXCEPTION 'กรุณากรอกชื่อและนามสกุล';
  END IF;
  IF COALESCE(btrim(p_phone), '') = '' THEN RAISE EXCEPTION 'กรุณากรอกเบอร์ติดต่อ'; END IF;
  IF COALESCE(btrim(p_position), '') = '' THEN RAISE EXCEPTION 'กรุณากรอกตำแหน่ง'; END IF;
  IF p_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM team_members WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'บัญชีนี้ถูกผูกกับช่างคนอื่นแล้ว';
  END IF;

  INSERT INTO team_members (first_name, last_name, phone, position, user_id)
  VALUES (btrim(p_first_name), btrim(p_last_name), btrim(p_phone), btrim(p_position), p_user_id)
  RETURNING id INTO mid;

  PERFORM app_audit('team_member', mid, 'create_team_member', actor.id,
    'เพิ่มช่าง ' || btrim(p_first_name) || ' ' || btrim(p_last_name) ||
    ' (' || btrim(p_position) || ') โทร ' || btrim(p_phone));
END $$;

CREATE OR REPLACE FUNCTION rpc_update_team_member(
  p_member_id UUID, p_first_name TEXT, p_last_name TEXT, p_phone TEXT, p_position TEXT,
  p_user_id UUID, p_is_active BOOLEAN
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; m team_members; active_jobs TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  SELECT * INTO m FROM team_members WHERE id = p_member_id FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'ไม่พบช่างในทะเบียน'; END IF;
  IF COALESCE(btrim(p_first_name), '') = '' OR COALESCE(btrim(p_last_name), '') = '' THEN
    RAISE EXCEPTION 'กรุณากรอกชื่อและนามสกุล';
  END IF;
  IF COALESCE(btrim(p_phone), '') = '' THEN RAISE EXCEPTION 'กรุณากรอกเบอร์ติดต่อ'; END IF;
  IF COALESCE(btrim(p_position), '') = '' THEN RAISE EXCEPTION 'กรุณากรอกตำแหน่ง'; END IF;
  IF p_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM team_members WHERE user_id = p_user_id AND id <> p_member_id) THEN
    RAISE EXCEPTION 'บัญชีนี้ถูกผูกกับช่างคนอื่นแล้ว';
  END IF;

  -- ปิดใช้งานไม่ได้ถ้ายังมีงานรอติดตั้งค้าง (กันคิวงานหาย)
  IF p_is_active = false AND m.is_active = true THEN
    SELECT string_agg(j.job_no, ', ') INTO active_jobs
    FROM job_assignments a JOIN jobs j ON j.id = a.job_id
    WHERE a.member_id = p_member_id AND j.terminal_status = 'issued';
    IF active_jobs IS NOT NULL THEN
      RAISE EXCEPTION 'ปิดใช้งานไม่ได้ — ยังมีงานรอติดตั้ง (%) ให้ย้ายมอบหมายก่อน', active_jobs;
    END IF;
  END IF;

  UPDATE team_members SET first_name = btrim(p_first_name), last_name = btrim(p_last_name),
    phone = btrim(p_phone), position = btrim(p_position), user_id = p_user_id, is_active = p_is_active
  WHERE id = p_member_id;

  PERFORM app_audit('team_member', p_member_id, 'update_team_member', actor.id,
    'แก้ข้อมูลช่าง ' || btrim(p_first_name) || ' ' || btrim(p_last_name) ||
    ' (' || btrim(p_position) || ')' || CASE WHEN p_is_active THEN '' ELSE ' — ปิดใช้งาน' END);
END $$;

-- ลบได้เฉพาะช่างที่ยังไม่เคยถูกใช้งาน — ที่เหลือใช้ปิดใช้งาน (คงประวัติ)
CREATE OR REPLACE FUNCTION rpc_delete_team_member(p_member_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; m team_members;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  SELECT * INTO m FROM team_members WHERE id = p_member_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'ไม่พบช่างในทะเบียน'; END IF;
  IF EXISTS (SELECT 1 FROM job_assignments WHERE member_id = p_member_id) THEN
    RAISE EXCEPTION 'ช่างคนนี้เคยถูกมอบหมายงาน ลบไม่ได้ (คงประวัติ) — ใช้ปิดใช้งานแทน';
  END IF;
  IF EXISTS (SELECT 1 FROM unit_installations WHERE installed_by_member_id = p_member_id) THEN
    RAISE EXCEPTION 'ช่างคนนี้มีประวัติติดตั้ง ลบไม่ได้ (คงประวัติ) — ใช้ปิดใช้งานแทน';
  END IF;
  DELETE FROM team_members WHERE id = p_member_id;
  PERFORM app_audit('team_member', p_member_id, 'delete_team_member', actor.id,
    'ลบช่าง ' || m.first_name || ' ' || m.last_name || ' ออกจากทะเบียน');
END $$;

-- ---------- 5) RPC: มอบหมายทีม (แทนที่ชุดเดิมทั้งชุด · [] = ยกเลิกมอบหมาย) ----------
CREATE OR REPLACE FUNCTION rpc_assign_job_team(p_job_id UUID, p_member_ids UUID[], p_lead_member_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; ids UUID[]; bad TEXT; names TEXT; lead_name TEXT; cnt INT;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'มอบหมายทีมได้เฉพาะงานที่เบิกแล้ว (Issued) — % อยู่สถานะอื่น', j.job_no;
  END IF;

  SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(p_member_ids, ARRAY[]::UUID[]))) INTO ids;
  cnt := COALESCE(array_length(ids, 1), 0);

  IF cnt > 0 THEN
    -- ต้องมีอยู่จริงและ active ทุกคน
    SELECT string_agg(x::TEXT, ', ') INTO bad
    FROM unnest(ids) x
    WHERE NOT EXISTS (SELECT 1 FROM team_members m WHERE m.id = x AND m.is_active);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'มีช่างที่ไม่พบในทะเบียนหรือถูกปิดใช้งาน'; END IF;

    IF p_lead_member_id IS NOT NULL AND NOT (p_lead_member_id = ANY(ids)) THEN
      RAISE EXCEPTION 'หัวหน้าทีมต้องเป็นหนึ่งในช่างที่เลือก';
    END IF;
  END IF;

  DELETE FROM job_assignments WHERE job_id = p_job_id;
  IF cnt > 0 THEN
    INSERT INTO job_assignments (job_id, member_id, is_lead, assigned_by)
    SELECT p_job_id, x, (x = p_lead_member_id), actor.id FROM unnest(ids) x;

    SELECT string_agg(m.first_name || ' ' || m.last_name, ', ') INTO names
    FROM team_members m WHERE m.id = ANY(ids);
    SELECT m.first_name || ' ' || m.last_name INTO lead_name
    FROM team_members m WHERE m.id = p_lead_member_id;

    PERFORM app_notify('team_assigned',
      '👷 ' || j.job_no || ' มอบหมาย ' || cnt || ' คน' ||
      COALESCE(' · หัวหน้าทีม ' || lead_name, ''), 'service', p_job_id);
    PERFORM app_audit('job', p_job_id, 'assign_job_team', actor.id,
      'มอบหมาย ' || j.job_no || ' ให้ ' || names || COALESCE(' (หัวหน้าทีม: ' || lead_name || ')', ''));
  ELSE
    PERFORM app_notify('team_unassigned', '👷 ยกเลิกมอบหมายทีม ' || j.job_no, 'service', p_job_id);
    PERFORM app_audit('job', p_job_id, 'assign_job_team', actor.id, 'ยกเลิกมอบหมายทีมของ ' || j.job_no);
  END IF;
END $$;

-- ---------- 6) ต่อ 0035: rpc_confirm_unit_install รับ p_member_id (เปลี่ยน signature) ----------
DROP FUNCTION IF EXISTS rpc_confirm_unit_install(UUID, DATE, NUMERIC, NUMERIC, TEXT, TEXT);
CREATE OR REPLACE FUNCTION rpc_confirm_unit_install(
  p_unit_id UUID, p_installed_date DATE, p_lat NUMERIC, p_lng NUMERIC, p_photo_url TEXT,
  p_member_id UUID, p_note TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; j jobs; cur TEXT; inst INT; tot INT; by_txt TEXT := '';
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  u := app_assert_unit_on_issued_job(p_unit_id);
  SELECT * INTO j FROM jobs WHERE id = u.job_id;

  SELECT outcome INTO cur FROM v_unit_install_state WHERE unit_id = p_unit_id;
  IF cur = 'installed' THEN RAISE EXCEPTION '% ยืนยันติดตั้งไปแล้ว', u.serial_lvb; END IF;

  IF p_installed_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันที่ติดตั้งจริง'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'ต้อง Check-in ตำแหน่งของเครื่องนี้ก่อนยืนยัน'; END IF;
  IF COALESCE(btrim(p_photo_url), '') = '' THEN RAISE EXCEPTION 'ต้องแนบรูปถ่ายของเครื่องนี้ก่อนยืนยัน'; END IF;
  IF p_member_id IS NOT NULL THEN
    SELECT ' · ช่าง ' || m.first_name || ' ' || m.last_name INTO by_txt
    FROM team_members m WHERE m.id = p_member_id AND m.is_active;
    IF by_txt IS NULL THEN RAISE EXCEPTION 'ไม่พบช่างที่เลือก หรือช่างถูกปิดใช้งานแล้ว'; END IF;
  END IF;

  INSERT INTO unit_installations (unit_id, job_id, outcome, installed_date, checkin_lat, checkin_lng,
    photo_url, installed_by_member_id, note, performed_by)
  VALUES (p_unit_id, u.job_id, 'installed', p_installed_date, p_lat, p_lng,
    btrim(p_photo_url), p_member_id, p_note, actor.id);

  SELECT COUNT(*) INTO tot FROM lbs_units WHERE job_id = u.job_id;
  SELECT COUNT(*) INTO inst FROM v_unit_install_state s
    JOIN lbs_units x ON x.id = s.unit_id
   WHERE x.job_id = u.job_id AND s.outcome = 'installed';

  PERFORM app_audit('lbs_unit', p_unit_id, 'confirm_unit_install', actor.id,
    j.job_no || ' ติดตั้ง ' || u.serial_lvb || '/' || u.serial_om || ' วันที่ ' || p_installed_date || by_txt ||
    ' (check-in ' || round(p_lat, 5) || ',' || round(p_lng, 5) || ') — คืบหน้า ' || inst || '/' || tot);
END $$;

-- ---------- 7) สิทธิ์ + Realtime ----------
GRANT EXECUTE ON FUNCTION public.rpc_create_team_member(TEXT, TEXT, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_team_member(UUID, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_team_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_assign_job_team(UUID, UUID[], UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_unit_install(UUID, DATE, NUMERIC, NUMERIC, TEXT, UUID, TEXT) TO authenticated;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE team_members;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE job_assignments;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
