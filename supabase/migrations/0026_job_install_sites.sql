-- =====================================================================
-- 0026: หลายจุดติดตั้งต่อ Job (2026-07-23)
--  Job มี LBS > 1 → เพิ่มจุดติดตั้ง (จุดที่ 2+) ได้ · ข้อมูลวางแผนอย่างเดียว (ไม่ผูก Serial,
--  ไม่แตะ flow issue/confirm install) · จุดที่ 1 ยังใช้ install_location/required_date เดิม
--  - jobs.install_sites JSONB = array ของ {location, requiredDate} (จุดที่ 2+)
--  - drop+recreate rpc_create_job / rpc_update_job (+ p_install_sites JSONB) — คงพฤติกรรมเดิมทุกอย่าง
--  demo sync ที่ src/data/logic.ts (createJob/updateJob + normalizeInstallSites) · รันหลัง 0025 (idempotent)
-- =====================================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS install_sites JSONB;

-- ยกเลิก signature เดิม (0021) ก่อน recreate ที่มี p_install_sites (กัน overload กำกวมใน PostgREST)
DROP FUNCTION IF EXISTS rpc_create_job(TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, JSONB, TEXT);
DROP FUNCTION IF EXISTS rpc_update_job(UUID, TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, JSONB, TEXT);

CREATE OR REPLACE FUNCTION rpc_create_job(p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL, p_phone TEXT DEFAULT NULL,
                                          p_install_sites JSONB DEFAULT NULL)
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
  INSERT INTO jobs (job_no, customer_name, contact_phone, scope, install_location, required_date, lbs_qty_required, opened_by, budget_sale_price, budget_cost, budget_costs, install_sites)
  VALUES (jno, trim(p_customer), NULLIF(trim(COALESCE(p_phone, '')), ''), p_scope, p_location, p_required_date, p_qty, actor.id, p_sale_price, total, p_costs, p_install_sites) RETURNING id INTO jid;
  PERFORM app_audit('job', jid, 'create_job', actor.id,
    'เปิด ' || jno || ' ลูกค้า ' || trim(p_customer) || ' ต้องการ LBS ' || p_qty || ' เครื่อง');
  RETURN jid;
END $$;

CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL, p_phone TEXT DEFAULT NULL,
                                          p_install_sites JSONB DEFAULT NULL)
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
    budget_sale_price = p_sale_price, budget_cost = total, budget_costs = p_costs,
    install_sites = p_install_sites, updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id,
    'แก้ไขข้อมูล ' || j.job_no || CASE WHEN jno <> j.job_no THEN ' (เปลี่ยนเลขเป็น ' || jno || ')' ELSE '' END);
END $$;

-- สิทธิ์เรียก RPC: เฉพาะผู้ login แล้ว (signature ใหม่ ต้อง grant ใหม่)
DO $$
DECLARE fn TEXT;
BEGIN
  FOR fn IN
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('rpc_create_job', 'rpc_update_job')
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.' || fn || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.' || fn || ' TO authenticated';
  END LOOP;
END $$;
