-- 0033: อนุมัติผ่าน LINE ส่วนตัว (1:1) — เชื่อมบัญชีด้วยโค้ด 6 หลัก + อนุมัติจากปุ่ม Flex (2026-07-26)
--  Flow:
--    1) ผู้อนุมัติ (Division/admin) กด "สร้างโค้ดเชื่อม LINE" ในแอป → rpc_line_gen_code() คืนโค้ด 6 หลัก (หมดอายุ 10 นาที)
--    2) เพิ่มบอทเป็นเพื่อน แล้วพิมพ์โค้ดในแชท 1:1 → line-webhook เรียก app_line_bind(code, line_user_id)
--       → ผูก profiles.line_user_id
--    3) เมื่อ project ขออนุมัติ → เว็บยิง /line-approval-push → ดันการ์ด Flex (ปุ่ม ✅ อนุมัติ + 🔎 ตรวจสอบ) เข้า 1:1 ผู้อนุมัติทุกคน
--    4) ผู้อนุมัติกด ✅ → line-webhook (postback) เรียก rpc_line_approve(request_id, line_user_id)
--       → เช็คสิทธิ์จาก line_user_id → execute เหมือนกดอนุมัติในเว็บ
--  หมายเหตุความปลอดภัย: ตีกลับ (reject) ทำได้เฉพาะบนเว็บ (ต้องมีเหตุผล) — LINE อนุมัติอย่างเดียว
--  รันหลัง 0032 (idempotent)

-- ---------- 1) profiles.line_user_id ----------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS line_user_id TEXT;
-- 1 LINE user ผูกได้กับ 1 บัญชีแอปเท่านั้น
CREATE UNIQUE INDEX IF NOT EXISTS profiles_line_user_id_uq
  ON profiles (line_user_id) WHERE line_user_id IS NOT NULL;

-- ---------- 2) โค้ดเชื่อมบัญชี (หมดอายุสั้น) ----------
CREATE TABLE IF NOT EXISTS line_link_codes (
  code       TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE line_link_codes ENABLE ROW LEVEL SECURITY;
-- ไม่มี policy = อ่าน/เขียนตรงไม่ได้ (เข้าถึงผ่าน RPC / service role เท่านั้น) กันโค้ดรั่ว

-- ผู้ใช้ที่ login แล้วขอโค้ดของตัวเอง (ล้างโค้ดเก่าทิ้งก่อน — โค้ดล่าสุดใช้ได้ตัวเดียว)
CREATE OR REPLACE FUNCTION rpc_line_gen_code()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me profiles; c TEXT;
BEGIN
  SELECT * INTO me FROM profiles WHERE id = auth.uid();
  IF me.id IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบก่อน'; END IF;
  IF NOT me.is_active THEN RAISE EXCEPTION 'บัญชีนี้ถูกปิดการใช้งาน'; END IF;
  DELETE FROM line_link_codes WHERE user_id = me.id;
  c := lpad((floor(random() * 1000000))::INT::TEXT, 6, '0');
  INSERT INTO line_link_codes (code, user_id, expires_at) VALUES (c, me.id, now() + INTERVAL '10 minutes');
  RETURN c;
END $$;

-- webhook (service role) เรียกตอนผู้ใช้พิมพ์โค้ดในแชท — คืนชื่อผู้ผูกถ้าสำเร็จ / NULL ถ้าโค้ดผิดหรือหมดอายุ
CREATE OR REPLACE FUNCTION app_line_bind(p_code TEXT, p_line_user_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE lc line_link_codes; me profiles;
BEGIN
  DELETE FROM line_link_codes WHERE expires_at < now();   -- เก็บกวาดโค้ดหมดอายุ
  SELECT * INTO lc FROM line_link_codes WHERE code = trim(p_code) AND expires_at >= now();
  IF lc.code IS NULL THEN RETURN NULL; END IF;
  -- ปลดการผูกเดิมของ LINE user นี้ (ถ้าเคยผูกบัญชีอื่น) แล้วผูกใหม่
  UPDATE profiles SET line_user_id = NULL WHERE line_user_id = p_line_user_id;
  UPDATE profiles SET line_user_id = p_line_user_id WHERE id = lc.user_id
  RETURNING * INTO me;
  DELETE FROM line_link_codes WHERE user_id = lc.user_id;
  RETURN me.full_name || ' · ' || me.department;
END $$;

-- ---------- 3) refactor: แยก execute อนุมัติออกมาให้ทั้งเว็บ (JWT) และ LINE (service role) ใช้ร่วม ----------
CREATE OR REPLACE FUNCTION app_exec_approve(actor profiles, p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests; j jobs; type_label TEXT; ids UUID[];
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
    PERFORM app_exec_issue_job(actor, r.job_id,
      (r.payload->>'start_date')::DATE, (r.payload->>'end_date')::DATE,
      r.payload->>'location', r.payload->>'note');
    type_label := 'เบิกให้ Service';
  ELSIF r.req_type = 'swap_lbs' THEN
    PERFORM app_exec_swap_lbs(actor, r.job_id,
      (r.payload->>'swap_allocated_unit_id')::UUID, (r.payload->>'swap_stock_unit_id')::UUID,
      r.payload->>'reason');
    type_label := 'สลับ LBS';
  ELSE
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  END IF;

  PERFORM app_notify('approval_approved',
    '✅ Division อนุมัติ' || type_label || ' ของ ' || j.job_no || ' แล้ว (โดย ' || actor.full_name || ')',
    'project', r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- เว็บ (เดิม) — เช็คสิทธิ์จาก JWT แล้วเรียก exec ร่วม
CREATE OR REPLACE FUNCTION rpc_approve_request(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  PERFORM app_exec_approve(actor, p_request_id);
END $$;

-- LINE (ใหม่) — เช็คสิทธิ์จาก line_user_id (service role เรียกจาก webhook เท่านั้น)
CREATE OR REPLACE FUNCTION rpc_line_approve(p_request_id UUID, p_line_user_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs;
BEGIN
  SELECT * INTO actor FROM profiles WHERE line_user_id = p_line_user_id;
  IF actor.id IS NULL THEN RETURN 'unlinked'; END IF;   -- ยังไม่ได้เชื่อมบัญชี
  IF NOT actor.is_active THEN RETURN 'inactive'; END IF;
  IF NOT (actor.department = 'sales' OR actor.department = 'admin') THEN RETURN 'forbidden'; END IF;
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN 'notfound'; END IF;
  IF r.status <> 'pending' THEN RETURN 'decided'; END IF;   -- อนุมัติ/ตีกลับไปแล้ว
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  PERFORM app_exec_approve(actor, p_request_id);
  RETURN 'ok:' || j.job_no;
END $$;

-- ---------- 4) สิทธิ์เรียก RPC ----------
-- gen_code: ผู้ใช้ที่ login แล้วเรียกได้
GRANT EXECUTE ON FUNCTION public.rpc_line_gen_code() TO authenticated;
-- bind + line_approve: service role เท่านั้น (กัน user ที่ login แล้วอนุมัติแทนคนอื่นผ่าน line_user_id)
REVOKE ALL ON FUNCTION public.app_line_bind(TEXT, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.rpc_line_approve(UUID, TEXT) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.app_line_bind(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_line_approve(UUID, TEXT) TO service_role;
