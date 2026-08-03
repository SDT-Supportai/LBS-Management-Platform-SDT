-- =====================================================================
-- 0040: บังคับสรุปปัญหาของงานก่อนปิดงานติดตั้ง (2026-07-31)
--  เดิม: ปิดงานมีแค่ช่อง "บันทึกสรุปงาน" (install_note) ที่เว้นว่างได้
--    → ปัญหาหน้างานไม่ถูกถามอย่างเป็นระบบ ไม่มีที่แนบหลักฐาน และรายงานย้อนหลังไม่ได้
--  ใหม่: ตอนปิดงาน Service ต้องตอบ "มีปัญหา / ไม่มีปัญหา" (ปล่อยว่างไม่ได้)
--    - มีปัญหา → บังคับกรอกรายละเอียด + แนบไฟล์ได้ (รูป/PDF/เอกสาร)
--    - เก็บแยกจาก install_note เพื่อให้ query/รายงานได้ (เช่น หางานที่มีปัญหาทั้งหมด)
--  ไฟล์แนบ: ใช้ bucket install-photos เดิม prefix job-issues/<job_id>/ (ไม่ต้องสร้าง bucket ใหม่)
--  demo sync ที่ src/data/logic.ts (closeJobInstall) · รันหลัง 0039 · idempotent
-- =====================================================================

-- ---------- 1) schema ----------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS close_has_issues     BOOLEAN;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS close_issue_detail   TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS close_issue_file_url TEXT;

COMMENT ON COLUMN jobs.close_has_issues IS
  'Service ตอบตอนปิดงานติดตั้ง: true = มีปัญหา · false = ไม่มีปัญหา · NULL = งานที่ปิดก่อน 0040';

-- ---------- 2) rpc_close_job_install — เพิ่ม 3 พารามิเตอร์ (signature ใหม่) ----------
DROP FUNCTION IF EXISTS rpc_close_job_install(UUID, TEXT);
CREATE OR REPLACE FUNCTION rpc_close_job_install(
  p_job_id UUID, p_note TEXT,
  p_has_issues BOOLEAN DEFAULT NULL, p_issue_detail TEXT DEFAULT NULL, p_issue_file_url TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; tot INT; inst INT; blk INT; pend INT; last_date DATE;
        blk_txt TEXT := ''; issue_txt TEXT;
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

  -- บังคับสรุปปัญหา (ใหม่ 0040)
  IF p_has_issues IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุว่างานนี้มีปัญหาหรือไม่ ก่อนปิดงาน';
  END IF;
  IF p_has_issues AND COALESCE(btrim(p_issue_detail), '') = '' THEN
    RAISE EXCEPTION 'เลือก "มีปัญหา" แล้ว ต้องกรอกรายละเอียดปัญหา';
  END IF;

  UPDATE jobs SET terminal_status = 'installed', installed_at = last_date,
    install_note = p_note, install_confirmed_by = actor.id,
    close_has_issues = p_has_issues,
    close_issue_detail   = CASE WHEN p_has_issues THEN btrim(p_issue_detail) ELSE NULL END,
    close_issue_file_url = CASE WHEN p_has_issues THEN NULLIF(btrim(p_issue_file_url), '') ELSE NULL END,
    updated_at = now()
  WHERE id = p_job_id;

  IF COALESCE(blk, 0) > 0 THEN blk_txt := ' · ติดปัญหา ' || blk || ' เครื่อง'; END IF;
  issue_txt := CASE WHEN p_has_issues THEN ' · ⚠️ มีปัญหา: ' || btrim(p_issue_detail) ELSE ' · ไม่มีปัญหา' END;

  PERFORM app_notify('job_installed',
    '🏁 ' || j.job_no || ' ปิดงานติดตั้ง ' || inst || '/' || tot || ' เครื่อง' || blk_txt ||
    ' · ' || last_date || issue_txt || ' · โดย ' || actor.full_name, 'project', p_job_id);
  PERFORM app_audit('job', p_job_id, 'close_job_install', actor.id,
    j.job_no || ' ปิดงานติดตั้ง ' || inst || '/' || tot || ' เครื่อง' || blk_txt ||
    ' วันล่าสุด ' || last_date || issue_txt ||
    CASE WHEN COALESCE(btrim(p_issue_file_url), '') <> '' THEN ' (มีไฟล์แนบ)' ELSE '' END ||
    COALESCE(' — ' || NULLIF(p_note, ''), ''));
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_close_job_install(UUID, TEXT, BOOLEAN, TEXT, TEXT) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0040 OK — ปิดงานติดตั้งต้องสรุปปัญหา (มี/ไม่มี) ก่อนเสมอ'; END $$;
