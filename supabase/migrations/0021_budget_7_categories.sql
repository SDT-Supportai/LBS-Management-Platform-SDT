-- =====================================================================
-- 0021: Project Budget ต้นทุนแยก 7 หมวด (2026-07-20)
--  แทน "ต้นทุน" ก้อนเดียว (budget_cost) ด้วย 7 หมวด เก็บใน jobs.budget_costs (JSONB):
--    { raw_mat:{budget,phase}, outsourcing:{budget,phase},
--      trans:{budget,phase,actual}, eng:{...}, ove:{...}, pm:{...}, fin:{...} }
--  - budget_cost ยังคงไว้เป็น "ต้นทุนรวม(งบ)" = Σ budget ทุกหมวด (server คำนวณ) เพื่อ
--    ให้ profit/report เดิมทำงานได้ (ไม่ใช่ field แก้ตรง — UI แก้ที่ 7 หมวด)
--  - raw_mat/outsourcing actual = มูลค่าวัสดุ PR/PO ที่ phase_budget = 'raw_mat'/'outsourcing'
--    (คิดฝั่ง client jobBudgetSummary) · อีก 5 หมวด actual เก็บใน JSONB
--  drop+recreate rpc_create_job/rpc_update_job (p_cost NUMERIC → p_costs JSONB)
--  demo sync ที่ src/data/logic.ts · รันหลัง 0020 (idempotent)
-- =====================================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_costs JSONB;

-- backfill: ย้าย budget_cost เดิมของ Job ที่มีอยู่ → งบหมวด raw_mat (คงตัวเลขไว้ ไม่ให้หาย)
UPDATE jobs SET budget_costs = jsonb_build_object('raw_mat', jsonb_build_object('budget', budget_cost))
WHERE budget_cost IS NOT NULL AND budget_costs IS NULL;

-- helper: รวมงบจาก JSONB 7 หมวด
CREATE OR REPLACE FUNCTION app_sum_budget_costs(p_costs JSONB) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_costs IS NULL THEN NULL
    ELSE COALESCE((SELECT sum(COALESCE(NULLIF(v->>'budget','')::NUMERIC, 0))
                   FROM jsonb_each(p_costs) e(k, v)), 0) END;
$$;

DROP FUNCTION IF EXISTS rpc_create_job(TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, NUMERIC, TEXT);
CREATE OR REPLACE FUNCTION rpc_create_job(p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL, p_phone TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; jid UUID; jno TEXT; total NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  jno := trim(p_job_no);
  IF jno = '' THEN RAISE EXCEPTION 'กรุณาระบุ Job No.'; END IF;
  IF EXISTS (SELECT 1 FROM jobs WHERE lower(job_no) = lower(jno)) THEN
    RAISE EXCEPTION 'Job No. "%" มีอยู่แล้ว', jno;
  END IF;
  IF trim(p_customer) = '' THEN RAISE EXCEPTION 'กรุณาระบุชื่อลูกค้า'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  IF p_sale_price IS NOT NULL AND p_sale_price < 0 THEN RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(p_costs, '{}'::jsonb)) e(k, v)
             WHERE COALESCE(NULLIF(v->>'budget','')::NUMERIC, 0) < 0 OR COALESCE(NULLIF(v->>'actual','')::NUMERIC, 0) < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  total := app_sum_budget_costs(p_costs);
  INSERT INTO jobs (job_no, customer_name, contact_phone, scope, install_location, required_date, lbs_qty_required, opened_by, budget_sale_price, budget_cost, budget_costs)
  VALUES (jno, trim(p_customer), NULLIF(trim(COALESCE(p_phone, '')), ''), p_scope, p_location, p_required_date, p_qty, actor.id, p_sale_price, total, p_costs) RETURNING id INTO jid;
  PERFORM app_audit('job', jid, 'create_job', actor.id,
    'เปิด ' || jno || ' ลูกค้า ' || trim(p_customer) || ' ต้องการ LBS ' || p_qty || ' เครื่อง');
  RETURN jid;
END $$;

DROP FUNCTION IF EXISTS rpc_update_job(UUID, TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, NUMERIC, TEXT);
CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL, p_phone TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; jno TEXT; held INT; total NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
  PERFORM 1 FROM jobs WHERE id = p_job_id FOR UPDATE;
  jno := trim(p_job_no);
  IF jno = '' THEN RAISE EXCEPTION 'กรุณาระบุ Job No.'; END IF;
  IF EXISTS (SELECT 1 FROM jobs WHERE id <> p_job_id AND lower(job_no) = lower(jno)) THEN
    RAISE EXCEPTION 'Job No. "%" ซ้ำกับ Job อื่น', jno;
  END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวน LBS ตาม Scope ต้องอย่างน้อย 1 เครื่อง'; END IF;
  SELECT count(*) INTO held FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated';
  IF p_qty < held THEN
    RAISE EXCEPTION 'ลดจำนวนตาม Scope ต่ำกว่าที่ถืออยู่ (% เครื่อง) ไม่ได้ — คืน LBS กลับสต็อกก่อน', held;
  END IF;
  IF p_sale_price IS NOT NULL AND p_sale_price < 0 THEN RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(p_costs, '{}'::jsonb)) e(k, v)
             WHERE COALESCE(NULLIF(v->>'budget','')::NUMERIC, 0) < 0 OR COALESCE(NULLIF(v->>'actual','')::NUMERIC, 0) < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  total := app_sum_budget_costs(p_costs);
  UPDATE jobs SET job_no = jno, customer_name = trim(p_customer),
    contact_phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
    scope = p_scope, install_location = p_location,
    required_date = p_required_date, lbs_qty_required = p_qty,
    budget_sale_price = p_sale_price, budget_cost = total, budget_costs = p_costs, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id,
    'แก้ไขข้อมูล ' || j.job_no || CASE WHEN jno <> j.job_no THEN ' (เปลี่ยนเลขเป็น ' || jno || ')' ELSE '' END);
END $$;
