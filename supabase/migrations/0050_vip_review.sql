-- =====================================================================
-- 0050: แผนก VIP (ผู้บริหารสูงสุด) + ความเห็นบนคำขออนุมัติ (2026-08-08)
--
--  ข้อกำหนด:
--    1. เพิ่มแผนก "VIP" = ผู้บริหารสูงสุด
--    2. VIP รีวิวคำขอ + มีช่องคอมเมนต์ แจ้งให้ Division รับทราบ
--    3. คอมเมนต์ของ VIP แสดงที่หน้า Awaiting Approval (คู่กับคำขอ)
--
--  มติการออกแบบ (2026-08-08) — ทำไม VIP เป็น "ผู้ให้ความเห็น" ไม่ใช่ "ผู้อนุมัติชั้นที่ 2":
--    - ถ้าทำเป็นขั้นอนุมัติเพิ่ม ทุกคำขอจะค้างรอผู้บริหาร → งานหน้างาน (ออก PR/เบิกของ) หยุดทั้งสาย
--      เมื่อผู้บริหารติดประชุม · โมเดล "อนุมัติ = ทำงานทันที" ของ 0016 จะเสียไป
--    - VIP จึงได้ **สิทธิ์ดูทุกอย่าง (RLS read_all เดิมครอบให้แล้ว) + ให้ความเห็น**
--      อำนาจตัดสินยังอยู่ที่ Division/Manage ตามเดิม — ความเห็นเป็นข้อมูลประกอบ ไม่บล็อกใคร
--    - ถ้าภายหลังต้องการ "VIP ต้องเห็นชอบก่อนวงเงินเกิน X" ให้ทำเป็น gate แยกตามวงเงิน
--      (ต่อยอดจากตารางนี้ได้ — เพิ่มคอลัมน์ ack ไม่ต้องรื้อ)
--
--  ⚠️ VIP ไม่ถูกใส่ใน app_assert_dept ของ RPC ตัวไหนเลยนอกจาก rpc_add_approval_comment
--     → เรียก RPC เขียนข้อมูลอื่นไม่ได้ทั้งหมด (server-side กันจริง ไม่ใช่แค่ซ่อนปุ่ม)
--
--  demo sync ที่ src/data/logic.ts (addApprovalComment) · รันหลัง 0049 · idempotent
-- =====================================================================

-- ---------- 1) เปิดแผนก vip ที่ CHECK constraint ----------
-- ⚠️ ต้องใช้ชื่อ constraint เดิม profiles_department_check (บทเรียน §9.9)
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_department_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_department_check
  CHECK (department IN ('sales', 'project', 'purchasing', 'service', 'admin', 'vip'));

-- ---------- 2) ตารางความเห็นบนคำขอ ----------
CREATE TABLE IF NOT EXISTS approval_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 1000),
  author_id  UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_comments_request_idx ON approval_comments (request_id, created_at);

ALTER TABLE approval_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON approval_comments;
-- อ่านได้ทุกแผนก (โปร่งใส: Project เห็นความเห็นที่มีผลกับงานตัวเองด้วย)
CREATE POLICY read_all ON approval_comments FOR SELECT TO authenticated USING (true);
-- ไม่มี write policy — เขียนผ่าน RPC (SECURITY DEFINER) เท่านั้น

-- ---------- 3) RPC: ฝากความเห็น ----------
-- VIP คอมเมนต์ → แจ้ง Division (ผู้ตัดสิน) · Division คอมเมนต์ → แจ้งกลับ VIP
-- ให้ความเห็นได้ทั้งคำขอที่ยังไม่ตัดสินและที่ตัดสินไปแล้ว (ผู้บริหารรีวิวย้อนหลังได้)
CREATE OR REPLACE FUNCTION rpc_add_approval_comment(p_request_id UUID, p_body TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; cid UUID;
        v_body TEXT; v_who TEXT; v_to TEXT; v_type TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['vip', 'sales']);   -- VIP + Division (+admin auto)
  v_body := btrim(COALESCE(p_body, ''));
  IF v_body = '' THEN RAISE EXCEPTION 'กรุณาพิมพ์ความเห็นก่อนส่ง'; END IF;
  IF length(v_body) > 1000 THEN RAISE EXCEPTION 'ความเห็นยาวเกิน 1,000 ตัวอักษร'; END IF;

  SELECT * INTO r FROM approval_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  INSERT INTO approval_comments (request_id, body, author_id)
  VALUES (p_request_id, v_body, actor.id) RETURNING id INTO cid;

  v_type := CASE r.req_type
    WHEN 'create_pr'  THEN 'ออก PR'
    WHEN 'issue_job'  THEN 'เบิกให้ Service'
    WHEN 'cancel_job' THEN 'ยกเลิก Job'
    WHEN 'swap_lbs'   THEN 'สลับ LBS'
    WHEN 'reopen_job' THEN 'เปิดงานใหม่'
    ELSE r.req_type END;
  v_who := CASE WHEN actor.department = 'vip' THEN 'VIP' ELSE 'Division' END;
  v_to  := CASE WHEN actor.department = 'vip' THEN 'sales' ELSE 'vip' END;

  PERFORM app_notify('approval_comment',
    '💬 ' || v_who || ' ให้ความเห็นคำขอ' || v_type || ' · ' || COALESCE(j.job_no, '-') || ': ' || left(v_body, 120),
    v_to, r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'comment_request', actor.id,
    v_who || ' ให้ความเห็นคำขอ' || v_type || ' ของ ' || COALESCE(j.job_no, '-') || ': ' || v_body);
  RETURN cid;
END $$;

REVOKE ALL ON FUNCTION public.rpc_add_approval_comment(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_approval_comment(UUID, TEXT) TO authenticated;

-- ---------- 4) Realtime ----------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE approval_comments;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN RAISE NOTICE '0050 OK — แผนก VIP + ความเห็นบนคำขออนุมัติ (approval_comments) พร้อมใช้งาน'; END $$;
