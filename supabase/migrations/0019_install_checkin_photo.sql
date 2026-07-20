-- =====================================================================
-- 0019: Service check-in + รูปถ่าย (บังคับ) + LINE deep link อนุมัติ (2026-07-19)
--  1) jobs + install_checkin_lat/lng + install_photo_url
--  2) Storage bucket 'install-photos' (public read) + policy ให้ authenticated อัปโหลด
--  3) rpc_confirm_install: เปลี่ยน signature รับ p_lat/p_lng/p_photo_url + บังคับครบ
--     (Service ต้อง Check-in ตำแหน่ง + แนบรูปทุกครั้ง)
--  4) rpc_request_approval: แนบลิงก์หน้า Awaiting Approval ในข้อความ (แจ้งผ่าน LINE
--     แล้วกดลิงก์เข้าแอปมาอนุมัติ — LINE เป็นช่องแจ้ง+ลิงก์ ไม่ใช่ช่อง execute)
--  demo sync ที่ src/data/logic.ts · รันหลัง 0018 (idempotent)
-- =====================================================================

-- ---------- 1) Schema ----------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS install_checkin_lat NUMERIC(9,6);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS install_checkin_lng NUMERIC(9,6);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS install_photo_url   TEXT;

-- ---------- 2) Storage bucket + policies ----------
-- ถ้ารันบรรทัดนี้ error (สิทธิ์ storage) ให้สร้าง bucket ชื่อ install-photos (public) ใน
-- Dashboard → Storage แทน แล้วรัน CREATE POLICY ด้านล่างต่อ
INSERT INTO storage.buckets (id, name, public) VALUES ('install-photos', 'install-photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS install_photos_read ON storage.objects;
CREATE POLICY install_photos_read ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'install-photos');
DROP POLICY IF EXISTS install_photos_insert ON storage.objects;
CREATE POLICY install_photos_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'install-photos');

-- ---------- 3) confirm_install บังคับ check-in + รูป ----------
DROP FUNCTION IF EXISTS rpc_confirm_install(UUID, DATE, TEXT);
CREATE OR REPLACE FUNCTION rpc_confirm_install(p_job_id UUID, p_installed_date DATE, p_note TEXT,
                                               p_lat NUMERIC DEFAULT NULL, p_lng NUMERIC DEFAULT NULL, p_photo_url TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['service']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF j.terminal_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'ยืนยันติดตั้งได้เฉพาะงานที่เบิกแล้ว (Issued) — % อยู่สถานะอื่น', j.job_no;
  END IF;
  IF p_installed_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุวันที่ติดตั้งจริง'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'ต้อง Check-in ตำแหน่งหน้างานก่อนยืนยัน'; END IF;
  IF trim(COALESCE(p_photo_url, '')) = '' THEN RAISE EXCEPTION 'ต้องแนบรูปถ่ายหน้างานก่อนยืนยัน'; END IF;

  UPDATE jobs SET terminal_status = 'installed', installed_at = p_installed_date,
    install_note = p_note, install_confirmed_by = actor.id,
    install_checkin_lat = p_lat, install_checkin_lng = p_lng, install_photo_url = trim(p_photo_url),
    updated_at = now()
  WHERE id = p_job_id;

  PERFORM app_notify('job_installed',
    '🏁 ' || j.job_no || ' (' || j.customer_name || ') ติดตั้งเสร็จเมื่อ ' || p_installed_date
    || ' — ยืนยันโดย ' || actor.full_name || ' 📍 พิกัด ' || round(p_lat, 5) || ', ' || round(p_lng, 5),
    'project', p_job_id);
  PERFORM app_audit('job', p_job_id, 'confirm_install', actor.id,
    j.job_no || ' ติดตั้งเสร็จ วันที่จริง ' || p_installed_date || ' (check-in ' || round(p_lat,5) || ',' || round(p_lng,5) || ')'
    || COALESCE(' — ' || NULLIF(p_note, ''), ''));
END $$;

-- ---------- 4) LINE deep link ในคำขออนุมัติ ----------
CREATE OR REPLACE FUNCTION rpc_request_approval(p_type TEXT, p_job_id UUID, p_payload JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; rid UUID; cnt INT; ids UUID[]; type_label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  IF p_type NOT IN ('create_pr', 'issue_job', 'cancel_job') THEN RAISE EXCEPTION 'ประเภทคำขอไม่ถูกต้อง'; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE job_id = p_job_id AND req_type = p_type AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอประเภทนี้รอ Division อนุมัติอยู่แล้ว', j.job_no;
  END IF;

  IF p_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(COALESCE(p_payload->'request_ids', '[]'::jsonb)) x;
    IF ids IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกรายการที่จะออก PR'; END IF;
    SELECT count(*) INTO cnt FROM job_accessory_requests
    WHERE id = ANY(ids) AND job_id = p_job_id AND source = 'purchasing' AND status = 'pending';
    IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'เลือกได้เฉพาะรายการสั่งซื้อที่ยังไม่ออก PR'; END IF;
    type_label := 'ออก PR (' || array_length(ids, 1) || ' รายการ)';
  ELSIF p_type = 'issue_job' THEN
    IF app_job_status(p_job_id) <> 'ready_to_issue' THEN
      RAISE EXCEPTION '% ยังไม่พร้อมเบิก — ต้องมี LBS ครบตาม Scope และ Accessory ครบทุกรายการ', j.job_no;
    END IF;
    IF (p_payload->>'start_date') IS NULL OR (p_payload->>'end_date') IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)';
    END IF;
    IF (p_payload->>'end_date')::DATE < (p_payload->>'start_date')::DATE THEN
      RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง';
    END IF;
    IF trim(COALESCE(p_payload->>'location', '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)'; END IF;
    type_label := 'เบิกให้ Service';
  ELSE
    IF trim(COALESCE(p_payload->>'reason', '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการยกเลิก'; END IF;
    type_label := 'ยกเลิก Job';
  END IF;

  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES (p_type, p_job_id, COALESCE(p_payload, '{}'::jsonb), actor.id) RETURNING id INTO rid;

  PERFORM app_notify('approval_requested',
    '🔔 ' || j.job_no || ' (' || j.customer_name || ') ขออนุมัติ' || type_label || ' โดย ' || actor.full_name
    || E'\n👉 อนุมัติที่: https://lbs-platform-sdt.pages.dev/#/approvals',
    'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id,
    j.job_no || ' ขออนุมัติ' || type_label);
  RETURN rid;
END $$;
