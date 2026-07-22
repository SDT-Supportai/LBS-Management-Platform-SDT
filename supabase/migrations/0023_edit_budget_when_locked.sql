-- =====================================================================
-- 0023: Manage แก้งบประมาณได้แม้ Job ล็อกแล้ว (2026-07-21)
--  rpc_update_job เดิมผ่าน app_assert_job_editable → Job ที่ terminal
--  (issued/installed/cancelled) แก้อะไรไม่ได้เลย รวมถึงงบประมาณ
--  เพิ่ม rpc_update_job_budget: แก้เฉพาะราคาขาย + ต้นทุน 7 หมวด
--    - เฉพาะ admin (Manage) — app_assert_dept(ARRAY['admin'])
--    - ไม่เรียก app_assert_job_editable → แก้ได้แม้ล็อก (แก้ตัวเลขบัญชีย้อนหลัง)
--    - ไม่แตะ scope/allocation/Job No. → cap การดึง LBS ยังปลอดภัย
--  demo sync ที่ src/data/logic.ts (updateJobBudget) · รันหลัง 0022 (idempotent)
-- =====================================================================

CREATE OR REPLACE FUNCTION rpc_update_job_budget(p_job_id UUID, p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; total NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['admin']);   -- เฉพาะ Manage
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF j.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Job'; END IF;
  IF p_sale_price IS NOT NULL AND p_sale_price < 0 THEN RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(p_costs, '{}'::jsonb)) e(k, v)
             WHERE COALESCE(NULLIF(v->>'budget','')::NUMERIC, 0) < 0 OR COALESCE(NULLIF(v->>'actual','')::NUMERIC, 0) < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  total := app_sum_budget_costs(p_costs);
  UPDATE jobs SET budget_sale_price = p_sale_price, budget_cost = total, budget_costs = p_costs, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id, 'แก้ไขงบประมาณ ' || j.job_no);
END $$;

-- สิทธิ์เรียก RPC: เฉพาะผู้ login แล้ว (กันในตัว rpc ด้วย app_assert_dept)
REVOKE ALL ON FUNCTION public.rpc_update_job_budget(UUID, NUMERIC, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_job_budget(UUID, NUMERIC, JSONB) TO authenticated;
