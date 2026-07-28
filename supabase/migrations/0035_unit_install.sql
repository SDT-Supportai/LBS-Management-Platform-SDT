-- 0035: Service — ยืนยันติดตั้ง "รายเครื่อง" (per LBS serial) เฟส B (2026-07-27)
--  เดิม: confirmInstall ยืนยันทั้ง Job ด้วยรูป+GPS ชุดเดียว → งานหลายเครื่อง/หลายจุด
--    รู้ไม่ได้ว่า serial ไหนติดตั้งที่พิกัดไหน
--  ใหม่: unit_installations เก็บหลักฐาน "ต่อเครื่อง" (วันที่ + GPS + รูป บังคับทุกเครื่อง)
--    - เก็บเป็น log หลายแถวได้ → สถานะเครื่อง = แถวล่าสุด (blocked แล้วยืนยันใหม่ได้)
--    - เก็บตารางแยก ไม่ใช่คอลัมน์บน lbs_units เพราะ trigger trg_block_issued_edit (0001)
--      บล็อก UPDATE lbs_units ตอน job = issued/installed
--    - Job ยังเป็น issued จนกด "ปิดงาน" (rpc_close_job_install) — ไม่เพิ่มสถานะใหม่
--      → v_job_status / deriveJobStatus / STATUS_TH ของบอท ไม่ต้องแก้
--    - รองรับเครื่องติดตั้งไม่ได้ (blocked) เพื่อไม่ให้งานค้างตลอดกาล
--  demo sync ที่ src/data/logic.ts (confirmUnitInstall/blockUnitInstall/closeJobInstall)
--  รันหลัง 0034 (idempotent)

-- ---------- 1) ตาราง ----------
CREATE TABLE IF NOT EXISTS unit_installations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        UUID NOT NULL REFERENCES lbs_units(id) ON DELETE CASCADE,
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  outcome        TEXT NOT NULL CHECK (outcome IN ('installed', 'blocked')),
  installed_date DATE,
  reason         TEXT,
  checkin_lat    NUMERIC(9,6),
  checkin_lng    NUMERIC(9,6),
  photo_url      TEXT,
  note           TEXT,
  performed_by   UUID REFERENCES profiles(id),
  performed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- installed ต้องมีวันที่ · blocked ต้องมีเหตุผล
  -- (GPS/รูป บังคับใน RPC ไม่ใช่ constraint — แถว backfill ของงานเก่าไม่มีหลักฐานรายเครื่อง)
  CONSTRAINT unit_install_date_chk   CHECK (outcome <> 'installed' OR installed_date IS NOT NULL),
  CONSTRAINT unit_install_reason_chk CHECK (outcome <> 'blocked'   OR COALESCE(btrim(reason), '') <> '')
);
CREATE INDEX IF NOT EXISTS unit_installations_unit_idx ON unit_installations (unit_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS unit_installations_job_idx  ON unit_installations (job_id);

ALTER TABLE unit_installations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON unit_installations;
CREATE POLICY read_all ON unit_installations FOR SELECT TO authenticated USING (true);
-- เขียนผ่าน RPC เท่านั้น

-- ---------- 2) View: สถานะติดตั้งปัจจุบันต่อเครื่อง (แถวล่าสุดชนะ) ----------
DROP VIEW IF EXISTS v_unit_install_state;
CREATE VIEW v_unit_install_state AS
SELECT DISTINCT ON (unit_id)
  unit_id, job_id, outcome, installed_date, reason, performed_at
FROM unit_installations
ORDER BY unit_id, performed_at DESC;

-- ---------- 3) Backfill งานที่ปิดไปแล้ว (ก่อนมีการยืนยันรายเครื่อง) ----------
-- ไม่ใส่ GPS/รูปปลอม — บันทึกตามจริงว่าเป็นข้อมูลระดับ Job
INSERT INTO unit_installations (unit_id, job_id, outcome, installed_date, photo_url, note, performed_by, performed_at)
SELECT u.id, j.id, 'installed',
       COALESCE(j.installed_at, (j.updated_at)::DATE, CURRENT_DATE),
       j.install_photo_url,
       'backfill: ข้อมูลยืนยันระดับ Job (ก่อนมีการยืนยันรายเครื่อง)',
       j.install_confirmed_by,
       COALESCE(j.updated_at, now())
FROM jobs j
JOIN lbs_units u ON u.job_id = j.id
WHERE j.terminal_status = 'installed'
  AND NOT EXISTS (SELECT 1 FROM unit_installations ui WHERE ui.unit_id = u.id);

-- ---------- 4) helper: ตรวจว่าเครื่องอยู่บน Job ที่ issued ----------
CREATE OR REPLACE FUNCTION app_assert_unit_on_issued_job(p_unit_id UUID)
RETURNS lbs_units LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u lbs_units; j jobs;
BEGIN
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.job_id IS NULL THEN RAISE EXCEPTION 'เครื่องนี้ยังไม่ได้ผูกกับ Job'; END IF;
  SELECT * INTO j FROM jobs WHERE id = u.job_id FOR UPDATE;
  IF j.terminal_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'ยืนยันติดตั้งได้เฉพาะงานที่เบิกแล้ว (Issued) — % อยู่สถานะอื่น', j.job_no;
  END IF;
  RETURN u;
END $$;

-- ---------- 5) ยืนยันติดตั้งรายเครื่อง ----------
-- ไม่ notify ต่อเครื่อง (กัน noise) — แจ้งตอน blocked / ปิดงาน เท่านั้น
CREATE OR REPLACE FUNCTION rpc_confirm_unit_install(
  p_unit_id UUID, p_installed_date DATE, p_lat NUMERIC, p_lng NUMERIC, p_photo_url TEXT, p_note TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; j jobs; cur TEXT; inst INT; tot INT;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  u := app_assert_unit_on_issued_job(p_unit_id);
  SELECT * INTO j FROM jobs WHERE id = u.job_id;

  SELECT outcome INTO cur FROM v_unit_install_state WHERE unit_id = p_unit_id;
  IF cur = 'installed' THEN RAISE EXCEPTION '% ยืนยันติดตั้งไปแล้ว', u.serial_lvb; END IF;

  IF p_installed_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันที่ติดตั้งจริง'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'ต้อง Check-in ตำแหน่งของเครื่องนี้ก่อนยืนยัน'; END IF;
  IF COALESCE(btrim(p_photo_url), '') = '' THEN RAISE EXCEPTION 'ต้องแนบรูปถ่ายของเครื่องนี้ก่อนยืนยัน'; END IF;

  INSERT INTO unit_installations (unit_id, job_id, outcome, installed_date, checkin_lat, checkin_lng, photo_url, note, performed_by)
  VALUES (p_unit_id, u.job_id, 'installed', p_installed_date, p_lat, p_lng, btrim(p_photo_url), p_note, actor.id);

  SELECT COUNT(*) INTO tot FROM lbs_units WHERE job_id = u.job_id;
  SELECT COUNT(*) INTO inst FROM v_unit_install_state s
    JOIN lbs_units x ON x.id = s.unit_id
   WHERE x.job_id = u.job_id AND s.outcome = 'installed';

  PERFORM app_audit('lbs_unit', p_unit_id, 'confirm_unit_install', actor.id,
    j.job_no || ' ติดตั้ง ' || u.serial_lvb || '/' || u.serial_om || ' วันที่ ' || p_installed_date ||
    ' (check-in ' || round(p_lat, 5) || ',' || round(p_lng, 5) || ') — คืบหน้า ' || inst || '/' || tot);
END $$;

-- ---------- 6) เครื่องติดตั้งไม่ได้ ----------
CREATE OR REPLACE FUNCTION rpc_block_unit_install(p_unit_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  u := app_assert_unit_on_issued_job(p_unit_id);
  SELECT * INTO j FROM jobs WHERE id = u.job_id;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ติดตั้งไม่ได้'; END IF;

  INSERT INTO unit_installations (unit_id, job_id, outcome, reason, performed_by)
  VALUES (p_unit_id, u.job_id, 'blocked', btrim(p_reason), actor.id);

  PERFORM app_notify('unit_install_blocked',
    '⚠️ ' || j.job_no || ' ติดตั้ง ' || u.serial_lvb || ' ไม่ได้: ' || btrim(p_reason), 'project', u.job_id);
  PERFORM app_audit('lbs_unit', p_unit_id, 'block_unit_install', actor.id,
    j.job_no || ' ติดตั้ง ' || u.serial_lvb || '/' || u.serial_om || ' ไม่ได้ — ' || btrim(p_reason));
END $$;

-- ---------- 7) ปิดงานติดตั้ง (ขั้นตอนแยก) ----------
CREATE OR REPLACE FUNCTION rpc_close_job_install(p_job_id UUID, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; tot INT; inst INT; blk INT; pend INT; last_date DATE; blk_txt TEXT := '';
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'ปิดงานได้เฉพาะงานที่เบิกแล้ว (Issued) — % อยู่สถานะอื่น', j.job_no;
  END IF;

  SELECT COUNT(*) INTO tot FROM lbs_units WHERE job_id = p_job_id;
  IF tot = 0 THEN RAISE EXCEPTION '% ไม่มีเครื่องที่เบิกไว้', j.job_no; END IF;

  SELECT
    COUNT(*) FILTER (WHERE s.outcome = 'installed'),
    COUNT(*) FILTER (WHERE s.outcome = 'blocked'),
    MAX(s.installed_date) FILTER (WHERE s.outcome = 'installed')
  INTO inst, blk, last_date
  FROM lbs_units x LEFT JOIN v_unit_install_state s ON s.unit_id = x.id
  WHERE x.job_id = p_job_id;

  pend := tot - COALESCE(inst, 0) - COALESCE(blk, 0);
  IF pend > 0 THEN
    RAISE EXCEPTION 'ยังมี % เครื่องที่ยังไม่ได้ข้อสรุป — ยืนยันติดตั้ง หรือระบุว่าติดตั้งไม่ได้ ให้ครบก่อนปิดงาน', pend;
  END IF;
  IF COALESCE(inst, 0) = 0 THEN RAISE EXCEPTION 'ต้องมีเครื่องที่ติดตั้งสำเร็จอย่างน้อย 1 เครื่องจึงปิดงานได้'; END IF;

  UPDATE jobs SET terminal_status = 'installed', installed_at = last_date,
    install_note = p_note, install_confirmed_by = actor.id, updated_at = now()
  WHERE id = p_job_id;

  IF COALESCE(blk, 0) > 0 THEN blk_txt := ' · ติดปัญหา ' || blk || ' เครื่อง'; END IF;
  PERFORM app_notify('job_installed',
    '🏁 ' || j.job_no || ' ปิดงานติดตั้ง ' || inst || '/' || tot || ' เครื่อง' || blk_txt ||
    ' · ' || last_date || ' · โดย ' || actor.full_name, 'project', p_job_id);
  PERFORM app_audit('job', p_job_id, 'close_job_install', actor.id,
    j.job_no || ' ปิดงานติดตั้ง ' || inst || '/' || tot || ' เครื่อง' || blk_txt ||
    ' วันล่าสุด ' || last_date || COALESCE(' — ' || NULLIF(p_note, ''), ''));
END $$;

-- ---------- 8) สิทธิ์ + Realtime ----------
GRANT EXECUTE ON FUNCTION public.rpc_confirm_unit_install(UUID, DATE, NUMERIC, NUMERIC, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_block_unit_install(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_close_job_install(UUID, TEXT) TO authenticated;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE unit_installations;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
