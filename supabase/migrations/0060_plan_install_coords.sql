-- =====================================================================
-- 0060: พิกัดจุดติดตั้ง "ตามแผน" — หมุดวางแผนบนหน้า Map Tracking (2026-08-23)
--
--  ที่มา: หน้า Map Tracking (commit 7e7ce89) วางหมุดจาก **การ Check-in จริง** เท่านั้น
--  ⇒ เห็นแต่งานที่ติดตั้งเสร็จแล้ว · งานที่ยังรอติดตั้งไม่มีหมุดเลย เพราะพิกัดเกิดตอนเช็คอิน
--  ⇒ ใช้แผนที่วางเส้นทางทีมช่างล่วงหน้าไม่ได้ ซึ่งเป็นประโยชน์หลักที่ผู้ใช้ต้องการ
--
--  แก้: เก็บพิกัดของ "จุดติดตั้งตามแผน" ตั้งแต่ตอนเปิด Job
--    จุดที่ 1  → คอลัมน์ใหม่ jobs.plan_lat / plan_lng
--    จุดที่ 2+ → คีย์ lat/lng ใน jobs.install_sites (JSONB เดิมจาก 0026 — ไม่ต้องเพิ่มคอลัมน์)
--
--  ⚠️⚠️ อย่าสับสน 2 ชุดพิกัดบนตาราง jobs:
--    plan_lat / plan_lng                  = **แผน** · Project/Division กรอกตอนเปิดงาน · แก้ได้
--    install_checkin_lat / _lng (0019)    = **หลักฐาน** · เกิดตอน Service ยืนยันติดตั้งหน้างาน
--    หน้าแผนที่แยกสีให้ชัด: ตามแผน = โปร่งเส้นประ · ติดตั้งแล้ว = ทึบเขียว · ติดตั้งไม่ได้ = แดง
--
--  ตรวจพิกัด: ต้องอยู่ในกรอบประเทศไทย (app_th_coord_ok) — เคสที่เจอบ่อยสุดคือ **สลับ lat/lng**
--    ฝั่ง client (parseLatLng) ตรวจแล้วบอกตรง ๆ ว่าสลับพร้อมค่าที่ถูก · ฝั่ง DB เป็นด่านสุดท้าย
--    ⇒ ถ้าไม่ตรวจ หมุดจะไปโผล่กลางทะเลจีนใต้แล้วหน้าแผนที่กรองทิ้งเงียบ ๆ (ข้อมูลหายโดยไม่มีใครรู้)
--
--  ── ที่แก้พ่วงมาด้วย (บั๊กจาก 0059) ──
--    rpc_update_job นับ "LBS ที่ถืออยู่" จาก status = 'allocated' เท่านั้น
--    หลัง 0059 เบิกแยกส่วนได้ เครื่องที่เบิกออกไปแล้วเป็น 'issued' ⇒ หลุดจากการนับ
--    ⇒ Project ลด lbs_qty_required ต่ำกว่าจำนวนเครื่องที่ **ส่งไปมือ Service แล้ว** ได้
--    (demo แก้ไปแล้วตอน 0059 ที่ logic.ts ผ่าน jobAllocatedQty — ฝั่ง SQL ยังค้าง)
--
--  ⚠️ เปลี่ยน signature ของ rpc_create_job / rpc_update_job (+2 args)
--     ⇒ ต้อง DROP+recreate (§9.8) และ **รัน SQL ก่อน push frontend** ไม่งั้น PGRST202 (บทเรียน 0055)
--     body ล่าสุดของทั้งคู่เป็นของ 0026 · grep 0027–0059 แล้วไม่มี patch ตามหลัง (ไม่มี app_notify
--     ในตัวมันจึงไม่โดน 0031 ด้วย) → recreate ทั้งก้อนปลอดภัย
--
--  demo sync: src/data/logic.ts (inThailand / parseLatLng / normalizePlanCoord /
--             normalizeInstallSites / createJob / updateJob) + เทสต์ใน logic.test.ts
--  รันหลัง 0059 · idempotent ทั้งไฟล์
-- =====================================================================

-- ---------- 1) คอลัมน์ใหม่ ----------
-- NUMERIC(9,6): ทศนิยม 6 ตำแหน่ง ≈ 0.11 เมตร ละเอียดเกินพอสำหรับจุดติดตั้ง
-- และรับ longitude 3 หลักหน้าจุดได้ (ไทย ~97–106)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS plan_lat NUMERIC(9, 6),
  ADD COLUMN IF NOT EXISTS plan_lng NUMERIC(9, 6);

COMMENT ON COLUMN jobs.plan_lat IS
  '0060: พิกัดจุดติดตั้งที่ 1 ตามแผน (latitude) — คนละตัวกับ install_checkin_lat ที่เป็นพิกัดจริงตอนเช็คอิน';
COMMENT ON COLUMN jobs.plan_lng IS
  '0060: พิกัดจุดติดตั้งที่ 1 ตามแผน (longitude) — คนละตัวกับ install_checkin_lng';

-- ---------- 2) ตรวจพิกัด ----------
-- กรอบประเทศไทยโดยประมาณ — mirror ของ TH_BOUNDS / inThailand ใน src/data/logic.ts
CREATE OR REPLACE FUNCTION app_th_coord_ok(p_lat NUMERIC, p_lng NUMERIC) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_lat BETWEEN 5.5 AND 20.6 AND p_lng BETWEEN 97.3 AND 105.7
$$;

-- คู่พิกัดต้องมาครบคู่และอยู่ในกรอบ · ครึ่งคู่ = ปล่อยผ่าน (ฝั่งเรียกจะเก็บเป็น NULL ทั้งคู่)
CREATE OR REPLACE FUNCTION app_assert_th_coord(p_lat NUMERIC, p_lng NUMERIC, p_what TEXT) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN RETURN; END IF;
  IF app_th_coord_ok(p_lat, p_lng) THEN RETURN; END IF;
  -- บอกให้ตรงจุด: ถ้าสลับกันแล้วเข้ากรอบ แปลว่าผู้ใช้สลับ lat/lng (เคสที่เจอบ่อยสุด)
  IF app_th_coord_ok(p_lng, p_lat) THEN
    RAISE EXCEPTION 'พิกัด% สลับกัน — ลองใส่ %, %', ' ' || p_what, p_lng, p_lat;
  END IF;
  RAISE EXCEPTION 'พิกัด% (%, %) อยู่นอกประเทศไทย — ตรวจอีกครั้ง', ' ' || p_what, p_lat, p_lng;
END $$;

-- ตรวจพิกัดในจุดติดตั้งเพิ่มเติม (JSONB array จาก 0026)
-- ⚠️ guard jsonb_typeof ก่อน — jsonb_array_elements บนค่าที่ไม่ใช่ array จะ error แบบอ่านไม่รู้เรื่อง
CREATE OR REPLACE FUNCTION app_assert_sites_coord(p_sites JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE e JSONB; i INT := 1;
BEGIN
  IF p_sites IS NULL OR jsonb_typeof(p_sites) <> 'array' THEN RETURN; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_sites) LOOP
    i := i + 1;   -- จุดที่ 2 เป็นต้นไป (จุดที่ 1 คือ plan_lat/plan_lng)
    IF (e->>'lat') IS NOT NULL AND (e->>'lng') IS NOT NULL THEN
      PERFORM app_assert_th_coord((e->>'lat')::NUMERIC, (e->>'lng')::NUMERIC, 'จุดติดตั้งที่ ' || i);
    END IF;
  END LOOP;
END $$;

-- ---------- 3) rpc_create_job / rpc_update_job (+ p_plan_lat, p_plan_lng) ----------
-- ยกเลิก signature เดิม (0026) ก่อน recreate — กัน overload กำกวมใน PostgREST (§9.8)
DROP FUNCTION IF EXISTS rpc_create_job(TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, JSONB, TEXT, JSONB);
DROP FUNCTION IF EXISTS rpc_update_job(UUID, TEXT, TEXT, TEXT, TEXT, DATE, INT, NUMERIC, JSONB, TEXT, JSONB);

CREATE OR REPLACE FUNCTION rpc_create_job(p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL, p_phone TEXT DEFAULT NULL,
                                          p_install_sites JSONB DEFAULT NULL,
                                          p_plan_lat NUMERIC DEFAULT NULL, p_plan_lng NUMERIC DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; jid UUID; jno TEXT; total NUMERIC; v_lat NUMERIC; v_lng NUMERIC;
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
  -- 0060: พิกัดตามแผน — เก็บเฉพาะคู่ที่ครบและอยู่ในกรอบไทย (ครึ่งคู่ = ทิ้งทั้งคู่)
  PERFORM app_assert_th_coord(p_plan_lat, p_plan_lng, 'จุดติดตั้งที่ 1');
  PERFORM app_assert_sites_coord(p_install_sites);
  IF p_plan_lat IS NOT NULL AND p_plan_lng IS NOT NULL THEN
    v_lat := p_plan_lat; v_lng := p_plan_lng;
  END IF;

  total := app_sum_budget_costs(p_costs);
  INSERT INTO jobs (job_no, customer_name, contact_phone, scope, install_location, required_date, lbs_qty_required, opened_by, budget_sale_price, budget_cost, budget_costs, install_sites, plan_lat, plan_lng)
  VALUES (jno, trim(p_customer), NULLIF(trim(COALESCE(p_phone, '')), ''), p_scope, p_location, p_required_date, p_qty, actor.id, p_sale_price, total, p_costs, p_install_sites, v_lat, v_lng) RETURNING id INTO jid;
  PERFORM app_audit('job', jid, 'create_job', actor.id,
    'เปิด ' || jno || ' ลูกค้า ' || trim(p_customer) || ' ต้องการ LBS ' || p_qty || ' เครื่อง');
  RETURN jid;
END $$;

CREATE OR REPLACE FUNCTION rpc_update_job(p_job_id UUID, p_job_no TEXT, p_customer TEXT, p_scope TEXT, p_location TEXT, p_required_date DATE, p_qty INT,
                                          p_sale_price NUMERIC DEFAULT NULL, p_costs JSONB DEFAULT NULL, p_phone TEXT DEFAULT NULL,
                                          p_install_sites JSONB DEFAULT NULL,
                                          p_plan_lat NUMERIC DEFAULT NULL, p_plan_lng NUMERIC DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; jno TEXT; held INT; total NUMERIC; v_lat NUMERIC; v_lng NUMERIC;
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
  -- ⚠️ 0060 แก้บั๊กจาก 0059: ต้องนับเครื่องที่ "เบิกให้ Service ไปแล้ว" (issued) ด้วย
  --    ไม่งั้นลด Scope ต่ำกว่าจำนวนของที่อยู่ในมือ Service ได้ (คืนกลับก็ไม่ได้แล้ว)
  SELECT count(*) INTO held FROM lbs_units
   WHERE job_id = p_job_id AND status IN ('allocated', 'issued');
  IF p_qty < held THEN
    RAISE EXCEPTION 'ลดจำนวนตาม Scope ต่ำกว่าที่ถืออยู่ (% เครื่อง) ไม่ได้ — คืน LBS กลับสต็อกก่อน', held;
  END IF;
  IF p_sale_price IS NOT NULL AND p_sale_price < 0 THEN RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(p_costs, '{}'::jsonb)) e(k, v)
             WHERE COALESCE(NULLIF(v->>'budget','')::NUMERIC, 0) < 0 OR COALESCE(NULLIF(v->>'actual','')::NUMERIC, 0) < 0) THEN
    RAISE EXCEPTION 'มูลค่างบประมาณติดลบไม่ได้';
  END IF;
  PERFORM app_assert_th_coord(p_plan_lat, p_plan_lng, 'จุดติดตั้งที่ 1');
  PERFORM app_assert_sites_coord(p_install_sites);
  IF p_plan_lat IS NOT NULL AND p_plan_lng IS NOT NULL THEN
    v_lat := p_plan_lat; v_lng := p_plan_lng;
  END IF;

  total := app_sum_budget_costs(p_costs);
  UPDATE jobs SET job_no = jno, customer_name = trim(p_customer),
    contact_phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
    scope = p_scope, install_location = p_location,
    required_date = p_required_date, lbs_qty_required = p_qty,
    budget_sale_price = p_sale_price, budget_cost = total, budget_costs = p_costs,
    install_sites = p_install_sites,
    -- ส่งค่าว่างมา = ล้างพิกัด (ตรงกับฟอร์มที่ลบข้อความในช่องพิกัดแล้วบันทึก)
    plan_lat = v_lat, plan_lng = v_lng,
    updated_at = now()
  WHERE id = p_job_id;
  PERFORM app_audit('job', p_job_id, 'update_job', actor.id,
    'แก้ไขข้อมูล ' || j.job_no || CASE WHEN jno <> j.job_no THEN ' (เปลี่ยนเลขเป็น ' || jno || ')' ELSE '' END);
END $$;

-- ---------- 4) สิทธิ์เรียก RPC (signature ใหม่ ต้อง grant ใหม่) ----------
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

GRANT EXECUTE ON FUNCTION public.app_th_coord_ok(NUMERIC, NUMERIC) TO authenticated;

-- ---------- 5) ตรวจผล — ต้องผ่านทุกข้อ ----------
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name IN ('plan_lat', 'plan_lng');
  IF n <> 2 THEN RAISE EXCEPTION '0060: คอลัมน์ plan_lat/plan_lng ไม่ครบ (เจอ %/2)', n; END IF;

  -- signature ใหม่ต้องมีจริง (ถ้าไม่มี = frontend จะได้ PGRST202)
  IF to_regprocedure('public.rpc_create_job(text,text,text,text,date,integer,numeric,jsonb,text,jsonb,numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION '0060: rpc_create_job signature ใหม่ไม่ถูกสร้าง';
  END IF;
  IF to_regprocedure('public.rpc_update_job(uuid,text,text,text,text,date,integer,numeric,jsonb,text,jsonb,numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION '0060: rpc_update_job signature ใหม่ไม่ถูกสร้าง';
  END IF;
  -- ต้องเหลือ overload เดียวต่อฟังก์ชัน ไม่งั้น PostgREST เลือกไม่ถูก (§9.8)
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_create_job';
  IF n <> 1 THEN RAISE EXCEPTION '0060: rpc_create_job มี % overload — ต้องเหลือ 1', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_update_job';
  IF n <> 1 THEN RAISE EXCEPTION '0060: rpc_update_job มี % overload — ต้องเหลือ 1', n; END IF;

  -- guard นับเครื่องที่เบิกแล้ว (บั๊กจาก 0059) ต้องติด
  IF position('IN (''allocated'', ''issued'')' IN
      pg_get_functiondef('public.rpc_update_job(uuid,text,text,text,text,date,integer,numeric,jsonb,text,jsonb,numeric,numeric)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0060: rpc_update_job ยังนับเฉพาะ allocated — guard ลด Scope ไม่ครอบเครื่องที่เบิกแล้ว';
  END IF;

  -- ตรวจพิกัด: ในกรอบผ่าน · นอกกรอบต้องโยน
  PERFORM app_assert_th_coord(13.7563, 100.5018, 'ทดสอบ');
  BEGIN
    PERFORM app_assert_th_coord(100.5018, 13.7563, 'ทดสอบ');
    RAISE EXCEPTION '0060: app_assert_th_coord ไม่จับพิกัดสลับ';
  EXCEPTION WHEN OTHERS THEN
    IF position('สลับกัน' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;

  RAISE NOTICE '0060 OK — พิกัดจุดติดตั้งตามแผน + guard ลด Scope ครอบเครื่องที่เบิกแล้ว';
END $$;
