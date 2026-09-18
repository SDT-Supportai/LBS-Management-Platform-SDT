-- =============================================================================
-- 0077 — 💰 Project เจ้าของงานแก้งบประมาณได้แม้ Job เบิกไปแล้ว (2026-09-18)
--
-- ที่มา (ผู้ใช้รายงาน 2026-09-18): เปิดใบที่เบิกให้ Service แล้วด้วยบัญชี Project
--   → ปุ่ม "แก้ไขงบประมาณ" หายไปทั้งปุ่ม เพราะ 0023 ตั้ง rpc_update_job_budget ไว้ที่
--   app_assert_dept(ARRAY['admin']) = Manage เท่านั้น
--
-- 🔴 ทำไมกติกาเดิมพัง (ไม่ใช่แค่ไม่สะดวก):
--   ต้นทุนจริงของงานนี้ **เกิดหลังเบิกเป็นส่วนใหญ่** — ค่าขนส่งเข้าไซต์ · ค่าแรงหน้างาน ·
--   ค่า PM ระหว่างติดตั้ง · ดอกเบี้ย/ค่าธรรมเนียมช่วงท้ายงาน
--   หมวด raw_mat/outsourcing มี PR/PO ตัดเข้าหมวดให้อัตโนมัติ (และ 0037 เปิดให้ซื้อเพิ่มหลังเบิกแล้ว)
--   แต่อีก 5 หมวด (trans · eng · ove · pm · fin) **กรอกมือเท่านั้น** ⇒ พอล็อกไว้ที่ Manage
--   คนที่รู้ตัวเลขจริง (เจ้าของงาน) บันทึกไม่ได้ ⇒ รายงานต้นทุนต่ำกว่าความจริงอย่างเป็นระบบ
--   นี่คือเหตุผลเดียวกับที่ 0037 แยก app_assert_job_cost_editable ออกมาตั้งแต่แรก
--
-- มติผู้ใช้ 2026-09-18: **เจ้าของงานแก้ได้ทั้งก้อน** (งบ · ราคาขาย · ใช้จริง) แม้ล็อกแล้ว
--   ⚠️ ผู้ใช้รับทราบผลข้างเคียงแล้ว: ยอดงวดเงินที่ออกใบไปแล้วถูก freeze ไว้ (0044) ไม่ขยับตาม
--      ราคาขายใหม่ · UI มีป้าย "ราคาขายถูกแก้หลังออกใบวางบิล" เตือนอยู่แล้ว และเพิ่มคำเตือน
--      ในโมดัลแก้งบเมื่องานนั้นมีงวดที่คิดจาก % แล้ว
--
-- guard ใหม่ = app_assert_job_cost_editable (0037) ซึ่งให้ครบ 3 อย่างในตัวเดียว:
--   (1) ล็อกแถว FOR UPDATE  (2) กัน Job ที่ถูกยกเลิก  (3) เช็คเจ้าของงานตาม 0042
--   ⇒ Project แก้ได้เฉพาะใบที่ตัวเองเปิด · Manage/แผนกอื่นที่มีสิทธิ์ข้ามได้เหมือนเดิม
-- 🔴 ต่างจากเดิมตรงที่ **Job ที่ยกเลิกแล้วแก้งบไม่ได้อีก** (เดิม Manage แก้ได้เพราะไม่เช็คเลย)
--    ตั้งใจ: ใบที่ยกเลิกไม่ควรมีตัวเลขเงินขยับอีก — ตรงกับ rpc_add/update_job_payment ของ 0044
--
-- ไม่เปลี่ยน signature · CREATE OR REPLACE ตัวเดิมได้ (ตรวจแล้ว: ไม่มี migration ไหนหลัง 0023
-- patch ฟังก์ชันนี้ — 0031 ที่ย่อข้อความ notify ไม่ได้แตะเพราะตัวนี้ไม่ยิง app_notify)
-- demo sync ที่ src/data/logic.ts (updateJobBudget) · รันหลัง 0076 · idempotent
-- =============================================================================

CREATE OR REPLACE FUNCTION rpc_update_job_budget(p_job_id UUID, p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; total NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['project']);   -- Project + Manage
  -- ล็อกแถว + กันใบที่ยกเลิก + เช็คเจ้าของงาน (0042) ครบในตัวเดียว · แก้ได้แม้ปิดงานติดตั้งแล้ว
  j := app_assert_job_cost_editable(p_job_id);
  IF p_sale_price IS NOT NULL AND p_sale_price < 0 THEN RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(p_costs, '{}'::jsonb)) e(k, v)
             WHERE COALESCE(NULLIF(v->>'budget','')::NUMERIC, 0) < 0 OR COALESCE(NULLIF(v->>'actual','')::NUMERIC, 0) < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  total := app_sum_budget_costs(p_costs);
  UPDATE jobs SET budget_sale_price = p_sale_price, budget_cost = total, budget_costs = p_costs, updated_at = now()
  WHERE id = p_job_id;
  -- บอกด้วยว่าแก้ตอนที่ใบล็อกไปแล้วหรือยัง — ไล่ย้อนหลังได้ว่าตัวเลขขยับหลังเบิกไปแล้วกี่ครั้ง
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id,
    'แก้ไขงบประมาณ ' || j.job_no ||
    CASE WHEN j.terminal_status IS NOT NULL THEN ' (แก้ย้อนหลังหลังใบล็อก · ' || j.terminal_status || ')' ELSE '' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_job_budget(UUID, NUMERIC, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_job_budget(UUID, NUMERIC, JSONB) TO authenticated;

-- ---------- ตรวจผล ----------
DO $$
DECLARE src TEXT;
BEGIN
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_update_job_budget';
  IF src IS NULL THEN RAISE EXCEPTION '0077: ไม่พบ rpc_update_job_budget'; END IF;

  -- ต้องเปิดให้ project แล้ว และต้องไม่เหลือ ARRAY['admin'] ที่กันไว้แบบเดิม
  IF position('ARRAY[''project'']' IN src) = 0 THEN
    RAISE EXCEPTION '0077: rpc_update_job_budget ยังไม่เปิดให้แผนก project';
  END IF;
  IF position('ARRAY[''admin'']' IN src) > 0 THEN
    RAISE EXCEPTION '0077: rpc_update_job_budget ยังล็อกไว้ที่ admin อยู่';
  END IF;
  -- ต้องยังเช็คเจ้าของงาน/ใบที่ยกเลิก ผ่าน guard ตัวกลาง ไม่ใช่ปล่อยผ่านทั้งหมด
  IF position('app_assert_job_cost_editable' IN src) = 0 THEN
    RAISE EXCEPTION '0077: rpc_update_job_budget ไม่ได้เรียก app_assert_job_cost_editable — เจ้าของงาน/ใบที่ยกเลิกจะหลุด';
  END IF;
  IF NOT has_function_privilege('authenticated',
        'public.rpc_update_job_budget(UUID, NUMERIC, JSONB)', 'EXECUTE') THEN
    RAISE EXCEPTION '0077: authenticated เรียก rpc_update_job_budget ไม่ได้';
  END IF;

  RAISE NOTICE '0077: OK — Project เจ้าของงานแก้งบประมาณได้แม้ใบล็อกแล้ว (ใบที่ยกเลิกยังแก้ไม่ได้)';
END $$;
