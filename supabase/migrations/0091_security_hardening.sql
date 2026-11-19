-- =============================================================================
-- 0091 — 🔒 ปิดช่องโหว่ความปลอดภัย (ขั้น 1 จากการตรวจ Workflow 2026-11-18) (2026-11-19)
--
-- ที่มา: ตรวจ Workflow ทั้งระบบ แล้วรัน migration 0001–0090 จริงบน Postgres จำลอง (PGlite)
--   เพื่อดูสิทธิ์ที่มีผลจริง (ไม่ใช่อ่านจากไฟล์) พบว่า:
--   · ฟังก์ชันภายใน app_* (app_exec_cancel_job / app_exec_create_pr / app_exec_approve / app_audit /
--     app_notify ฯลฯ) **ผู้ใช้ที่ login แล้วทุกแผนก และบางตัวแม้แต่ anon** เรียกตรงผ่าน
--     POST /rest/v1/rpc/<ชื่อ> ได้ — ส่ง actor ปลอมเข้าไปได้ ⇒ ข้ามขั้น "รอ Division พิจารณา" ทั้งหมด
--     ปลอมประวัติ Audit และยิงข้อความเข้า LINE กลุ่มบริษัทได้
--     ต้นเหตุ: (ก) 0002 แจก EXECUTE ให้ authenticated ทั้ง rpc_% และ app_% · (ข) Supabase ตั้ง default
--     privileges ให้ฟังก์ชันใหม่ทุกตัวได้ EXECUTE ถึง anon/authenticated อัตโนมัติ
--   · ไฟล์สัญญา (unit-docs) / ไฟล์งวดเงิน (payment-docs): policy ลบใน storage เช็คแค่ชื่อ bucket
--     ⇒ ใคร login ก็ลบไฟล์ตรงผ่าน Storage API ได้ ไม่ผ่าน RPC (ไม่ตรวจแผนก ไม่ลง Audit)
--   · กฎ 0058 "บัญชีต้อง Active จึงอ่านได้" ไม่ได้ใส่ให้ตารางที่สร้างทีหลัง 5 ตาราง
--   · 0090 ขอยกเลิกผลติดตั้ง: Project ที่ไม่ใช่เจ้าของงานก็ขอได้ · ผลพิจารณาแจ้งแค่ Service
--   · โค้ดผูก LINE 6 หลัก: เดาได้ไม่จำกัดครั้ง · ผูกทับบัญชีเดิมเงียบ ๆ ไม่มี Audit
--
-- สิ่งที่ทำ:
--   1.1 ถอน EXECUTE ฟังก์ชันภายในทั้งหมดจาก PUBLIC/anon/authenticated (เหลือเฉพาะตัวที่ RLS/trigger ต้องใช้)
--       · rpc_* ทุกตัว: GRANT authenticated ชัด ๆ + ถอน anon (ยกเว้น rpc_public_lbs_stock = ลิงก์สาธารณะ)
--       · default privileges: ฟังก์ชันที่สร้างใหม่ **ไม่ได้สิทธิ์อัตโนมัติอีก**
--         ⚠️ ตั้งแต่ 0091: rpc_ ตัวใหม่ (หรือ DROP + CREATE ตัวเดิม) ต้อง
--            GRANT EXECUTE ON FUNCTION ... TO authenticated เองทุกครั้ง ไม่งั้นหน้าเว็บขึ้น permission denied
--   1.2 ลบไฟล์ใน 3 bucket เอกสาร ได้เฉพาะไฟล์ที่ "ไม่มีแถวในระบบอ้างถึงแล้ว" (= ผ่าน RPC ลบแถวมาก่อน
--       ซึ่ง RPC ตรวจแผนก/เจ้าของงาน และลง Audit) + แผนกตรงกับ RPC + บัญชี Active
--       client ลำดับเดิมอยู่แล้ว (RPC ลบแถว → ลบไฟล์) ไม่ต้องแก้หน้าเว็บ
--   1.3 ใส่ policy require_active ให้ทุกตาราง RLS ที่ยังขาด (วนหาเอง ไม่ hard-code) + ตรวจซ้ำท้ายไฟล์
--   1.4 rpc_request_revert_install: Project ต้องเป็นเจ้าของงาน (app_assert_job_owner · กติกา 0042)
--       ผลอนุมัติ/ตีกลับ revert_install แจ้งทั้ง Service และ Project (LINE กลุ่มยังได้ฉบับเดียว)
--   1.5 app_line_bind: ใส่โค้ดผิดเกิน 5 ครั้ง/15 นาที ต่อ LINE user = ล็อก · ผิดรวมทั้งระบบเกิน 30 ครั้ง/15 นาที
--       = ปิดผูกบัญชีชั่วคราว · ลง Audit ทุกครั้งที่ผูก (และฝั่งบัญชีที่ถูกปลด) + เมื่อถูกล็อก
--
-- demo sync: src/data/logic.ts (requestRevertInstall owner · approve/reject แจ้ง 2 แผนก)
--            src/pages/ServicePage.tsx (ซ่อนปุ่มขอยกเลิกผลจาก Project ที่ไม่ใช่เจ้าของงาน)
-- ทดสอบ: รัน 0001–0091 บน PGlite + ชุดทดสอบสิทธิ์/ฟังก์ชัน (ดู HANDOFF) · idempotent (รันซ้ำได้)
-- =============================================================================

-- ---------- 1.5a) ตารางนับการใส่โค้ด LINE (สร้างก่อน เพื่อให้ข้อ 1.3 วนครอบด้วย) ----------
CREATE TABLE IF NOT EXISTS line_bind_attempts (
  id           BIGSERIAL PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  ok           BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_bind_attempts_user_idx ON line_bind_attempts (line_user_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS line_bind_attempts_at_idx   ON line_bind_attempts (attempted_at DESC);
ALTER TABLE line_bind_attempts ENABLE ROW LEVEL SECURITY;
-- ไม่มี policy อ่าน/เขียน = เข้าถึงผ่าน app_line_bind (service role) เท่านั้น
REVOKE ALL ON line_bind_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE line_bind_attempts_id_seq FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE line_bind_attempts IS
  'การใส่โค้ดผูก LINE (0091) — ใช้จำกัดการเดาโค้ด · เก็บ 30 วัน · เข้าถึงผ่าน app_line_bind เท่านั้น';

-- ---------- 1.5b) app_line_bind: จำกัดการเดา + Audit ----------
CREATE OR REPLACE FUNCTION app_line_bind(p_code TEXT, p_line_user_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c_max_user CONSTANT INT := 5;                       -- ผิดได้กี่ครั้งต่อ LINE user ในช่วงเวลา
  c_max_all  CONSTANT INT := 30;                      -- ผิดรวมทั้งระบบ (กันใช้หลายบัญชี LINE ช่วยกันเดา)
  c_window   CONSTANT INTERVAL := INTERVAL '15 minutes';
  lc line_link_codes; me profiles; prev profiles; v_had TEXT; v_fail INT; v_tail TEXT;
BEGIN
  IF COALESCE(btrim(p_line_user_id), '') = '' THEN RAISE EXCEPTION 'ไม่พบ LINE user'; END IF;
  v_tail := '…' || right(p_line_user_id, 6);          -- Audit เก็บแค่ท้าย ID ไม่เก็บเต็ม

  DELETE FROM line_link_codes WHERE expires_at < now();                       -- เก็บกวาดโค้ดหมดอายุ
  DELETE FROM line_bind_attempts WHERE attempted_at < now() - INTERVAL '30 days';

  -- ด่านล็อก: ตรวจก่อนดูโค้ด ⇒ ระหว่างถูกล็อก แม้ใส่โค้ดถูกก็ไม่ผ่าน (กันเดาต่อ)
  SELECT count(*) INTO v_fail FROM line_bind_attempts
   WHERE line_user_id = p_line_user_id AND NOT ok AND attempted_at > now() - c_window;
  IF v_fail >= c_max_user THEN
    RAISE EXCEPTION 'ใส่โค้ดผิดเกิน % ครั้ง — ระงับชั่วคราว 15 นาที แล้วสร้างโค้ดใหม่ในแอป', c_max_user;
  END IF;
  IF (SELECT count(*) FROM line_bind_attempts WHERE NOT ok AND attempted_at > now() - c_window) >= c_max_all THEN
    RAISE EXCEPTION 'มีการใส่โค้ดผิดจำนวนมาก — ระบบปิดการเชื่อมบัญชีชั่วคราว 15 นาที (แจ้งผู้ดูแลระบบ)';
  END IF;

  SELECT * INTO lc FROM line_link_codes WHERE code = btrim(COALESCE(p_code, '')) AND expires_at >= now();
  IF lc.code IS NULL THEN
    -- RETURN (ไม่ RAISE) เพื่อให้แถวนับครั้งผิดถูก commit จริง
    INSERT INTO line_bind_attempts (line_user_id, ok) VALUES (p_line_user_id, false);
    IF v_fail + 1 = c_max_user THEN
      -- entity_id ต้องไม่ว่าง → ใช้ uuid ศูนย์ = "ไม่ผูกกับแถวใด" (ยังไม่รู้ว่าเป็นใคร)
      PERFORM app_audit('line_bind', '00000000-0000-0000-0000-000000000000'::UUID, 'line_bind_locked', NULL,
        'LINE ' || v_tail || ' ใส่โค้ดเชื่อมบัญชีผิดครบ ' || c_max_user || ' ครั้ง — ระงับ 15 นาที');
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO me FROM profiles WHERE id = lc.user_id FOR UPDATE;
  v_had := me.line_user_id;                                                    -- บัญชีนี้เคยผูก LINE อื่นไหม
  SELECT * INTO prev FROM profiles WHERE line_user_id = p_line_user_id AND id <> lc.user_id;  -- LINE นี้เคยผูกกับคนอื่นไหม

  -- ปลดการผูกเดิมของ LINE user นี้ (ถ้าเคยผูกบัญชีอื่น) แล้วผูกใหม่
  UPDATE profiles SET line_user_id = NULL WHERE line_user_id = p_line_user_id;
  UPDATE profiles SET line_user_id = p_line_user_id WHERE id = lc.user_id RETURNING * INTO me;
  DELETE FROM line_link_codes WHERE user_id = lc.user_id;
  INSERT INTO line_bind_attempts (line_user_id, ok) VALUES (p_line_user_id, true);

  PERFORM app_audit('profile', me.id, 'line_bind', me.id,
    me.full_name || ' เชื่อมบัญชี LINE (' || v_tail || ')' ||
    CASE WHEN v_had IS NULL THEN ''
         WHEN v_had = p_line_user_id THEN ' · ผูกซ้ำ LINE เดิม'
         ELSE ' · แทนที่ LINE เดิม (…' || right(v_had, 6) || ')' END ||
    CASE WHEN prev.id IS NOT NULL THEN ' · ปลด LINE นี้ออกจากบัญชี ' || prev.full_name ELSE '' END);
  IF prev.id IS NOT NULL THEN
    PERFORM app_audit('profile', prev.id, 'line_unbind', me.id,
      prev.full_name || ' ถูกปลด LINE (' || v_tail || ') เพราะ LINE นี้ไปเชื่อมกับบัญชี ' || me.full_name);
  END IF;
  RETURN me.full_name || ' · ' || me.department;
END $$;

-- ---------- 1.4a) ขอยกเลิกผลติดตั้ง: Project ต้องเป็นเจ้าของงาน (body 0090 + 1 บรรทัด) ----------
CREATE OR REPLACE FUNCTION rpc_request_revert_install(p_job_id UUID, p_unit_ids UUID[], p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; ids UUID[]; rid UUID; v_reason TEXT; v_sn TEXT; label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['service', 'project']);
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  PERFORM app_assert_job_owner(j);                                   -- 0091: กติกาเจ้าของงาน (0042)
  ids := app_assert_revertable_units(j, p_unit_ids);
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ขอยกเลิกผลติดตั้ง'; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests
              WHERE job_id = p_job_id AND req_type = 'revert_install' AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอยกเลิกผลติดตั้งรอ Division พิจารณาอยู่แล้ว', j.job_no;
  END IF;

  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES ('revert_install', p_job_id,
          jsonb_build_object('unit_ids', to_jsonb(ids), 'reason', v_reason), actor.id)
  RETURNING id INTO rid;

  SELECT string_agg(serial_lvb, ', ' ORDER BY serial_lvb) INTO v_sn FROM lbs_units WHERE id = ANY(ids);
  label := 'ยกเลิกผลติดตั้ง (' || array_length(ids, 1) || ' เครื่อง)';
  PERFORM app_notify('approval_requested', '🔔 ' || j.job_no || ' ขออนุมัติ' || label, 'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id,
    j.job_no || ' ขออนุมัติ' || label || ': ' || v_sn || ' · เหตุผล: ' || v_reason);
  RETURN rid;
END $$;

-- ---------- 1.4b) app_exec_approve (body 0090 ทั้งดุ้น + สำเนาแจ้ง Project เมื่อเป็น revert_install) ----------
CREATE OR REPLACE FUNCTION app_exec_approve(actor profiles, p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests; j jobs; type_label TEXT; ids UUID[]; v_msg TEXT;
BEGIN
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  UPDATE approval_requests SET status = 'approved', decided_by = actor.id, decided_at = now()
  WHERE id = p_request_id;

  IF r.req_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(r.payload->'request_ids') x;
    PERFORM app_exec_create_pr(actor, r.job_id, ids);
    type_label := 'ออก PR';
  ELSIF r.req_type = 'issue_job' THEN
    -- 0059: อนุมัติแล้วเบิกเฉพาะ LBS ตามรายการที่ขอ (unit_ids ว่าง = ทุกเครื่องที่ Ready ตอนอนุมัติ)
    SELECT array_agg((x)::UUID) INTO ids
      FROM jsonb_array_elements_text(COALESCE(r.payload->'unit_ids', '[]'::jsonb)) x;
    PERFORM app_exec_issue_lbs(actor, r.job_id, ids,
      (r.payload->>'start_date')::DATE, (r.payload->>'end_date')::DATE,
      r.payload->>'location', r.payload->>'note');
    type_label := 'เบิก LBS ให้ Service';
  ELSIF r.req_type = 'swap_lbs' THEN
    PERFORM app_exec_swap_lbs(actor, r.job_id,
      (r.payload->>'swap_allocated_unit_id')::UUID, (r.payload->>'swap_stock_unit_id')::UUID,
      r.payload->>'reason');
    type_label := 'สลับ LBS';
  ELSIF r.req_type = 'reopen_job' THEN
    PERFORM app_exec_reopen_job(actor, r.job_id, r.payload->>'reason');
    type_label := 'เปิดงานใหม่';
  ELSIF r.req_type = 'revert_install' THEN                                       -- 0090
    SELECT array_agg((x)::UUID) INTO ids
      FROM jsonb_array_elements_text(COALESCE(r.payload->'unit_ids', '[]'::jsonb)) x;
    PERFORM app_exec_revert_install(actor, r.job_id, ids, r.payload->>'reason');
    type_label := 'ยกเลิกผลติดตั้ง';
  ELSIF r.req_type = 'cancel_job' THEN                                           -- 0090: เดิมเป็น ELSE
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  ELSE
    -- ห้ามเดาให้ไปทำ action ของ type อื่น (บทเรียน 0041) — type ใหม่ต้องเพิ่มสาขาที่นี่
    RAISE EXCEPTION 'ประเภทคำขอ % ยังไม่รองรับการอนุมัติ', r.req_type;
  END IF;

  v_msg := '✅ อนุมัติ' || type_label || ' · ' || j.job_no || ' · โดย ' || actor.full_name;
  PERFORM app_notify('approval_approved', v_msg,
    CASE WHEN r.req_type = 'revert_install' THEN 'service' ELSE 'project' END,  -- 0090: แจ้งเจ้าของเรื่อง
    r.job_id);
  IF r.req_type = 'revert_install' THEN
    -- 0091: สำเนาถึง Project (เจ้าของงาน/ผู้ขอฝั่ง Project) · approval_approved ไม่ส่ง LINE อยู่แล้ว
    PERFORM app_notify('approval_approved', v_msg, 'project', r.job_id);
  END IF;
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- ---------- 1.4c) rpc_reject_request (body ตัวจริงหลัง patch 0028→0090 ทั้งดุ้น + สำเนาแจ้ง Project) ----------
CREATE OR REPLACE FUNCTION rpc_reject_request(p_request_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; type_label TEXT; v_msg TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ตีกลับ'; END IF;
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  type_label := CASE r.req_type WHEN 'create_pr' THEN 'ออก PR' WHEN 'issue_job' THEN 'เบิก LBS ให้ Service'
                                WHEN 'swap_lbs' THEN 'สลับ LBS' WHEN 'reopen_job' THEN 'เปิดงานใหม่' WHEN 'revert_install' THEN 'ยกเลิกผลติดตั้ง' ELSE 'ยกเลิก Job' END;
  UPDATE approval_requests SET status = 'rejected', decided_by = actor.id, decided_at = now(),
    reject_reason = trim(p_reason)
  WHERE id = p_request_id;
  v_msg := '⛔ ตีกลับ' || type_label || ' · ' || j.job_no || ': ' || trim(p_reason);
  PERFORM app_notify('approval_rejected', v_msg,
    CASE WHEN r.req_type = 'revert_install' THEN 'service' ELSE 'project' END, r.job_id);
  IF r.req_type = 'revert_install' THEN
    -- 0091: สำเนาถึง Project · line_status 'off' เพราะ approval_rejected ขึ้น LINE กลุ่ม
    --        ฉบับแรกส่งไปแล้ว (กลุ่มเดียวกันทั้งบริษัท) — กันข้อความซ้ำ
    INSERT INTO notifications (type, message, dept, job_id, line_status)
    VALUES ('approval_rejected', v_msg, 'project', r.job_id, 'off');
  END IF;
  PERFORM app_audit('approval_request', p_request_id, 'reject_request', actor.id,
    'ตีกลับคำขอ' || type_label || ' ของ ' || j.job_no || ' เหตุผล: ' || trim(p_reason));
END $$;

-- ---------- 1.2) storage: ลบไฟล์เอกสารได้เฉพาะไฟล์ที่ระบบไม่อ้างถึงแล้ว ----------
--   ทางลบที่ถูกต้อง = RPC ลบแถว (ตรวจแผนก/เจ้าของงาน + Audit) → client ลบไฟล์ตาม path (ลำดับเดิมของหน้าเว็บ)
--   ไฟล์ที่ยังมีแถวอ้างถึง ลบตรงผ่าน Storage API ไม่ได้อีก · ไฟล์กำพร้า (อัปโหลดแล้ว RPC ล้ม) ยังเก็บกวาดได้
--   แผนกตรงกับ RPC ของแต่ละ bucket · ทุกคำสั่งต้องเป็นบัญชี Active (อ่านด้วย)
DROP POLICY IF EXISTS unit_docs_read ON storage.objects;
CREATE POLICY unit_docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'unit-docs' AND public.my_is_active());
DROP POLICY IF EXISTS unit_docs_insert ON storage.objects;
CREATE POLICY unit_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'unit-docs' AND public.my_is_active()
              AND public.my_department() IN ('sales', 'admin'));                -- = rpc_add_unit_file
DROP POLICY IF EXISTS unit_docs_delete ON storage.objects;
CREATE POLICY unit_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'unit-docs' AND public.my_is_active()
         AND public.my_department() IN ('sales', 'admin')                        -- = rpc_delete_unit_file
         AND NOT EXISTS (SELECT 1 FROM public.lbs_unit_files f WHERE f.file_path = objects.name));

DROP POLICY IF EXISTS payment_docs_read ON storage.objects;
CREATE POLICY payment_docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'payment-docs' AND public.my_is_active());
DROP POLICY IF EXISTS payment_docs_insert ON storage.objects;
CREATE POLICY payment_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payment-docs' AND public.my_is_active()
              AND public.my_department() IN ('project', 'admin'));              -- = rpc_add_payment_file
DROP POLICY IF EXISTS payment_docs_delete ON storage.objects;
CREATE POLICY payment_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'payment-docs' AND public.my_is_active()
         AND public.my_department() IN ('project', 'admin')                      -- = rpc_delete_payment_file
         AND NOT EXISTS (SELECT 1 FROM public.job_payment_files f WHERE f.file_path = objects.name));

-- service-docs (เอกสารรับมอบ/Warranty 0079) ช่องเดียวกัน: เดิมตรวจแผนกแล้ว แต่ลบไฟล์ที่ยังอ้างถึงได้
DROP POLICY IF EXISTS service_docs_read ON storage.objects;
CREATE POLICY service_docs_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'service-docs' AND public.my_is_active());
DROP POLICY IF EXISTS service_docs_insert ON storage.objects;
CREATE POLICY service_docs_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'service-docs' AND public.my_is_active()
              AND public.my_department() IN ('service', 'project', 'admin'));
DROP POLICY IF EXISTS service_docs_delete ON storage.objects;
CREATE POLICY service_docs_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'service-docs' AND public.my_is_active()
         AND public.my_department() IN ('service', 'project', 'admin')
         AND NOT EXISTS (SELECT 1 FROM public.job_closeout_files f WHERE f.file_path = objects.name));

-- ---------- 1.3) require_active ให้ทุกตาราง RLS ที่ยังขาด (หาเอง ไม่ hard-code ชื่อ) ----------
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity
       AND NOT EXISTS (SELECT 1 FROM pg_policies p
                        WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'require_active')
  LOOP
    EXECUTE format(
      'CREATE POLICY require_active ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (my_is_active())',
      t.relname);
    RAISE NOTICE '0091: เพิ่ม require_active ให้ %', t.relname;
  END LOOP;
END $$;

-- ---------- 1.1) ถอนสิทธิ์เรียกฟังก์ชันภายใน ----------
-- my_department ไม่มี search_path (0001) — ใช้ใน RLS + storage policy ⇒ ล็อกไว้
ALTER FUNCTION public.my_department() SET search_path = public;

DO $$
DECLARE f RECORD;
BEGIN
  -- (ก) ทุกฟังก์ชันที่ไม่ใช่ rpc_ และไม่ใช่ trigger: ถอนจาก PUBLIC / anon / authenticated
  --     (trigger function เรียกตรงไม่ได้อยู่แล้ว และ Postgres ไม่ตรวจ EXECUTE ตอน trigger ทำงาน)
  --     service_role (LINE webhook) ไม่ถูกแตะ
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
       AND p.prorettype <> 'trigger'::regtype
       AND p.proname NOT LIKE 'rpc\_%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')  -- ข้ามฟังก์ชันของ extension
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
  END LOOP;

  -- (ข) rpc_*: authenticated ชัด ๆ (ไม่พึ่ง PUBLIC) + ถอน anon
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname LIKE 'rpc\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    IF f.proname <> 'rpc_line_approve' THEN            -- อนุมัติผ่าน LINE = service role เท่านั้น (0033)
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    END IF;
  END LOOP;
END $$;

-- (ค) ตัวที่ต้องเปิดไว้ให้ผู้ใช้ — ถูกเรียก "ด้วยสิทธิ์ของผู้ใช้" ไม่ใช่ผ่าน SECURITY DEFINER
--     RLS ของทุกตาราง + storage policy
GRANT EXECUTE ON FUNCTION public.my_department() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_is_active()  TO authenticated;
--     ถูกเรียกจาก trigger ที่ไม่ใช่ SECURITY DEFINER (คำเตือน 0086) · ไม่มีผลข้างเคียง (อ่านอย่างเดียว)
GRANT EXECUTE ON FUNCTION public.app_install_sites_with_ids(JSONB)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_match_job_site(TEXT, JSONB, TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_job_install_complete(UUID)          TO authenticated;
--     ลิงก์สาธารณะดูคลัง (0069) — ไม่ต้อง login
GRANT EXECUTE ON FUNCTION public.rpc_public_lbs_stock(TEXT) TO anon;
--     LINE webhook (service role)
GRANT EXECUTE ON FUNCTION public.app_line_bind(TEXT, TEXT)  TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_line_approve(UUID, TEXT) TO service_role;

-- (ง) ฟังก์ชันที่สร้างใหม่หลังจากนี้: ไม่ได้ EXECUTE อัตโนมัติ (ต้อง GRANT เองทีละตัว)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------- ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE (ยกเลิกทั้งไฟล์) ----------
DO $$
DECLARE bad TEXT;
  keep CONSTANT TEXT[] := ARRAY['my_department', 'my_is_active',
    'app_install_sites_with_ids', 'app_match_job_site', 'app_job_install_complete'];
BEGIN
  -- 1.1 ฟังก์ชันภายในที่ผู้ใช้ยังเรียกได้ (นอกรายการที่ตั้งใจเปิด)
  SELECT string_agg(p.oid::regprocedure::TEXT, ', ') INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
     AND p.prorettype <> 'trigger'::regtype AND p.proname NOT LIKE 'rpc\_%'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR (has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT p.proname = ANY(keep)));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0091: ฟังก์ชันภายในยังถูกเรียกตรงได้: %', bad; END IF;

  SELECT string_agg(p.oid::regprocedure::TEXT, ', ') INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rpc\_%'
     AND has_function_privilege('anon', p.oid, 'EXECUTE') AND p.proname <> 'rpc_public_lbs_stock';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0091: rpc ที่ anon เรียกได้: %', bad; END IF;

  SELECT string_agg(p.oid::regprocedure::TEXT, ', ') INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rpc\_%'
     AND p.proname <> 'rpc_line_approve' AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0091: rpc ที่หน้าเว็บเรียกไม่ได้: %', bad; END IF;

  IF NOT has_function_privilege('service_role', 'public.app_line_bind(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.rpc_line_approve(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0091: LINE webhook (service role) เรียก app_line_bind / rpc_line_approve ไม่ได้';
  END IF;

  -- 1.1 (ง) ฟังก์ชันใหม่ต้องไม่ได้สิทธิ์อัตโนมัติ — สร้างตัวลองจริงแล้วลบทิ้ง
  CREATE FUNCTION public.app_0091_probe() RETURNS INT LANGUAGE sql AS 'SELECT 1';
  IF has_function_privilege('anon', 'public.app_0091_probe()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.app_0091_probe()', 'EXECUTE') THEN
    DROP FUNCTION public.app_0091_probe();
    RAISE EXCEPTION '0091: default privileges ยังแจก EXECUTE ให้ฟังก์ชันใหม่';
  END IF;
  DROP FUNCTION public.app_0091_probe();

  -- 1.3 ทุกตาราง RLS มี require_active
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'require_active');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0091: ตารางที่ยังขาด require_active: %', bad; END IF;

  -- 1.2 policy ลบไฟล์ต้องมีเงื่อนไข "ไม่มีแถวอ้างถึง"
  SELECT string_agg(policyname, ', ') INTO bad FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('unit_docs_delete', 'payment_docs_delete', 'service_docs_delete')
     AND qual NOT LIKE '%NOT (EXISTS%';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0091: policy ลบไฟล์ยังไม่ตรวจการอ้างถึง: %', bad; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname IN ('unit_docs_delete', 'payment_docs_delete', 'service_docs_delete')) <> 3 THEN
    RAISE EXCEPTION '0091: policy ลบไฟล์ไม่ครบ 3 bucket';
  END IF;

  -- 1.4 / 1.5 body ใหม่ติดตั้งจริง
  IF position('app_assert_job_owner' IN pg_get_functiondef('public.rpc_request_revert_install(uuid,uuid[],text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0091: rpc_request_revert_install ยังไม่ตรวจเจ้าของงาน';
  END IF;
  IF position('line_bind_attempts' IN pg_get_functiondef('public.app_line_bind(text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0091: app_line_bind ยังไม่จำกัดการเดาโค้ด';
  END IF;
  RAISE NOTICE '0091: ตรวจผ่านทุกข้อ';
END $$;
