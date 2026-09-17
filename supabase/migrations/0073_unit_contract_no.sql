-- =============================================================================
-- 0073 — 📄 Contract No. รายเครื่อง + "แผน" เลิกเป็นแผนเมื่อมีสัญญา (2026-09-16)
--
-- 0014 (มติ 2026-07-16) ตัดคอลัมน์ลูกค้าออกจาก lbs_units ทิ้งไปรอบหนึ่งแล้ว ให้ Job เป็น
--   source of truth เดียว · 0043 คืนมาเป็น "ข้อมูลแผน" ที่ Division กรอกล่วงหน้าได้
--   ⇒ ปัจจุบันมี 2 สถานะ: ยังไม่ผูก Job = "แผน" · ผูกแล้ว = ค่าจาก Job
--
-- ไฟล์นี้แทรก **สถานะกลาง**: พอมีเลขสัญญาแล้ว ข้อมูลลูกค้าไม่ใช่การเดาอีกต่อไป
--   plan     ยังไม่มีทั้งสัญญาและ Job → ข้อมูลแผน (ติดป้าย "แผน" บนหน้าเว็บ)
--   contract มีเลขสัญญา ยังไม่ผูก Job → ข้อมูลตามสัญญา (ไม่ใช่แผน)
--   job      ผูก Job แล้ว            → **Job ชนะตาม 0014 ไม่เปลี่ยน** · สัญญากลายเป็น Ref.
--
-- 🔴 มติผู้ใช้ 2026-09-16: **ถูกดึงเข้า Job แล้ว Contract No. เป็นข้อมูล Ref.**
--    ⇒ Job ยังเป็นเจ้าของ customer/contact/location เหมือนเดิม ไม่แย่งกัน
--    ⇒ ถ้า 2 ฝั่งไม่ตรงกัน หน้าเว็บขึ้นเตือนให้คนไปตรวจ (ไม่บล็อก ไม่กลืนเงียบ)
--
-- 🔴 contract_no เขียนได้ "ทุกเครื่อง" รวมที่ผูก Job แล้ว — ต่างจาก customer/location
--    ที่ถูกข้ามเมื่อมี Job (กฎ 0014) · เพราะเลขสัญญาเป็นข้อเท็จจริงฝั่งขาย **คนละชั้นกับ Job**
--    (Job ไม่ได้เป็นเจ้าของเลขสัญญา จึงไม่มีอะไรให้ทับ)
--
-- 🔴 ห้ามใส่ contract_no ลง rpc_public_lbs_stock (0069) — เป็นข้อมูลเชิงพาณิชย์
--    0069 มี DO block ตรวจ payload ด้วย whitelist อยู่แล้ว มีแค่ "อย่าไปเติม"
--
-- ⚠️ เปลี่ยน signature ของ rpc_update_unit_plan ⇒ **DROP ก่อน** (§9 ข้อ 8 — PostgREST
--    จะกำกวมถ้ามี 2 overload) และ **ต้องรัน SQL ก่อน push frontend** ไม่งั้นกดบันทึกได้ PGRST202
-- =============================================================================

-- ---------- 1) คอลัมน์ใหม่ + กติกาที่ล็อกระดับ DB ----------
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS contract_no VARCHAR(80);

COMMENT ON COLUMN lbs_units.contract_no IS
  '0073 — เลขที่สัญญาขายของเครื่องนี้ · กรอกแล้ว Customer/Contact/Location เลิกเป็น "ข้อมูลแผน" '
  '· ผูก Job แล้วเป็นข้อมูลอ้างอิง (Ref.) เท่านั้น — Job ยังชนะตาม 0014 '
  '· ห้ามเปิดออกลิงก์สาธารณะ (0069)';

-- กรอกเลขสัญญาแล้วต้องมีลูกค้า + สถานที่ ไม่งั้นป้าย "แผน" หายไปจากช่องที่ไม่มีข้อมูล = แย่กว่าเดิม
-- 🔴 ยกเว้นเครื่องที่ผูก Job แล้ว — ข้อมูลชุดนั้นมาจาก Job ช่องแผนว่างได้ตามปกติ
--    ไม่ยกเว้นจะกรอกเลขสัญญาให้เครื่องที่มี Job ไม่ได้เลย (เคสที่เจอบ่อยที่สุด)
-- เบอร์ติดต่อไม่บังคับ — ตอนเซ็นสัญญามักยังไม่รู้ว่าใครประสานงานหน้างาน
ALTER TABLE lbs_units DROP CONSTRAINT IF EXISTS lbs_units_contract_needs_info_ck;
ALTER TABLE lbs_units
  ADD CONSTRAINT lbs_units_contract_needs_info_ck CHECK (
    contract_no IS NULL
    OR job_id IS NOT NULL
    OR (plan_customer_name IS NOT NULL AND plan_install_location IS NOT NULL)
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_lbs_units_contract ON lbs_units(contract_no) WHERE contract_no IS NOT NULL;

-- ---------- 2) rpc_update_unit_plan: เพิ่ม p_contract_no ----------
-- signature เดิมของ 0053 ต้อง DROP ก่อน ไม่งั้น PostgREST เจอ 2 overload แล้วกำกวม
DROP FUNCTION IF EXISTS rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE);

CREATE OR REPLACE FUNCTION rpc_update_unit_plan(
  p_unit_id         UUID,
  p_unit_cost       NUMERIC DEFAULT NULL,
  p_customer_name   TEXT    DEFAULT NULL,
  p_contact_phone   TEXT    DEFAULT NULL,
  p_install_location TEXT   DEFAULT NULL,
  p_plan_po_receipt DATE    DEFAULT NULL,   -- = ETA to WH แบบกรอกเอง (ชื่อเดิม คงไว้ไม่ให้ client เก่าพัง)
  p_plan_delivery   DATE    DEFAULT NULL,
  p_fob_date        DATE    DEFAULT NULL,
  p_lead_days       INT     DEFAULT NULL,
  p_plan_po_date    DATE    DEFAULT NULL,   -- = Plan PO receipt (วันรับ PO จากลูกค้า) — 0053
  p_contract_no     TEXT    DEFAULT NULL    -- 0073 — เลขที่สัญญาขาย
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks; v_eta DATE; v_lead INT; v_contract TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);   -- Division + Manage
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id FOR UPDATE;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.status = 'issued' THEN
    RAISE EXCEPTION 'Serial % ถูกเบิกให้ Service แล้ว — แก้ข้อมูลรายเครื่องไม่ได้ (allocation ถูกล็อก)', u.serial_lvb;
  END IF;
  IF p_unit_cost IS NOT NULL AND p_unit_cost < 0 THEN
    RAISE EXCEPTION 'ต้นทุน/เครื่องต้องไม่ติดลบ';
  END IF;
  IF p_lead_days IS NOT NULL AND (p_lead_days < 45 OR p_lead_days > 60) THEN
    RAISE EXCEPTION 'ระยะขนส่ง (วัน) ต้องอยู่ระหว่าง 45–60';
  END IF;

  -- 0073 — ข้อความบอกเหตุผลก่อนที่ CHECK จะเด้งเป็น error ดิบ ๆ ที่คนอ่านไม่รู้เรื่อง
  v_contract := NULLIF(btrim(COALESCE(p_contract_no, '')), '');
  IF v_contract IS NOT NULL AND u.job_id IS NULL
     AND (NULLIF(btrim(COALESCE(p_customer_name, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_install_location, '')), '') IS NULL) THEN
    RAISE EXCEPTION 'กรอก Contract No. แล้วต้องระบุ Customer และ Location / Site ด้วย — ข้อมูลชุดนี้จะเลิกเป็น "แผน"';
  END IF;

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;
  v_lead := CASE WHEN p_fob_date IS NULL THEN NULL ELSE NULLIF(p_lead_days, 60) END;
  v_eta := CASE WHEN p_fob_date IS NOT NULL THEN p_fob_date + COALESCE(v_lead, 60) ELSE p_plan_po_receipt END;

  UPDATE lbs_units SET
    unit_cost             = p_unit_cost,
    contract_no           = v_contract,
    plan_customer_name    = NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
    plan_contact_phone    = NULLIF(btrim(COALESCE(p_contact_phone, '')), ''),
    plan_install_location = NULLIF(btrim(COALESCE(p_install_location, '')), ''),
    plan_po_date          = p_plan_po_date,
    fob_date              = p_fob_date,
    eta_lead_days         = v_lead,
    plan_po_receipt_date  = CASE WHEN p_fob_date IS NOT NULL THEN NULL ELSE p_plan_po_receipt END,
    plan_delivery_date    = p_plan_delivery,
    updated_at            = now()
  WHERE id = p_unit_id;

  PERFORM app_audit('lbs_unit', p_unit_id, 'update_unit_plan', actor.id,
    COALESCE(s.stock_no, '') || ' · ' || u.serial_lvb || '/' || COALESCE(u.serial_om, '-') ||
    ' → ต้นทุน ' || COALESCE(round(p_unit_cost, 2)::TEXT, '-') ||
    ' ฿ · Contract No. ' || COALESCE(v_contract, '-') ||
    ' · Customer' || CASE WHEN v_contract IS NULL THEN '(แผน)' ELSE '' END ||
    ' ' || COALESCE(p_customer_name, '-') ||
    ' · Plan PO receipt ' || COALESCE(p_plan_po_date::TEXT, '-') ||
    ' · FOB ' || COALESCE(p_fob_date::TEXT, '-') || ' +' || COALESCE(v_lead, 60) || ' วัน' ||
    ' · ETA to WH ' || COALESCE(v_eta::TEXT, '-') ||
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-'));
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) TO authenticated;

-- ---------- 3) Import Excel: รับ key 'contract_no' (patch ฟังก์ชันเดิม) ----------
-- signature เดิม (jsonb) — เติม key ใหม่ได้เลย · patch เฉพาะบรรทัด ไม่ recreate ทั้งก้อน
-- (rpc_import_units_to_stock ผ่าน 0051/0052/0053 มาแล้ว — recreate จากไฟล์เก่าจะ revert งานเหล่านั้น)
-- ⚠️ ทุก pattern ต้องอยู่ "บรรทัดเดียว" — body ใน DB มี CRLF · pattern ที่คร่อมบรรทัดจะ match ไม่เจอ (§9.6)
DO $$
DECLARE def TEXT; foid OID;
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid) INTO foid, def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rpc_import_units_to_stock';
  IF foid IS NULL THEN RAISE EXCEPTION '0073: ไม่พบ rpc_import_units_to_stock — ต้องรัน 0051/0052/0053 ก่อน'; END IF;

  IF position('contract_no' IN def) > 0 THEN
    RAISE NOTICE '0073: rpc_import_units_to_stock รองรับ contract_no อยู่แล้ว ข้าม';
  ELSE
    DECLARE
      -- anchor ชุดเดียวกับที่ 0053 ใช้ (ยืนยันแล้วว่าอยู่บรรทัดเดียวทั้งหมด)
      -- ⚠️ a_upd กับ a_cols ต้องเป็นคนละ anchor — a_cols โผล่เฉพาะใน INSERT (คั่นด้วย ", " ไม่มี "=")
      --    ส่วนขา UPDATE เขียน `plan_install_location = CASE ...` จึงไม่ชนกัน
      --    ถ้าใช้ a_cols แก้ทั้ง 2 ที่ replace() จะยัด `contract_no = COALESCE(...)` ลงไปใน
      --    รายชื่อคอลัมน์ของ INSERT ด้วย → syntax error ทันทีตอน EXECUTE
      a_decl CONSTANT TEXT := 'v_fob DATE; v_lead INT;';
      a_read CONSTANT TEXT := ':= NULLIF(btrim(COALESCE(u->>''location'', '''')), '''');';
      a_skip CONSTANT TEXT := 'CONTINUE WHEN c IS NULL AND v_cust IS NULL AND v_phone IS NULL AND v_loc IS NULL';
      a_upd  CONSTANT TEXT := 'plan_install_location = CASE WHEN job_id IS NULL THEN COALESCE(v_loc, plan_install_location) ELSE plan_install_location END,';
      a_cols CONSTANT TEXT := 'plan_customer_name, plan_contact_phone, plan_install_location,';
      a_vals CONSTANT TEXT := 'NULLIF(btrim(COALESCE(u->>''location'', '''')), ''''),';
    BEGIN
      IF position(a_decl IN def) = 0 OR position(a_read IN def) = 0 OR position(a_skip IN def) = 0
         OR position(a_upd IN def) = 0 OR position(a_cols IN def) = 0 OR position(a_vals IN def) = 0 THEN
        RAISE EXCEPTION '0073: body ของ rpc_import_units_to_stock ต่างจากที่คาด — ตรวจด้วย pg_get_functiondef ก่อนแก้มือ';
      END IF;

      -- (ก) ตัวแปรใหม่
      def := replace(def, a_decl, a_decl || ' v_contract TEXT;');
      -- (ข) อ่านค่าจาก payload (ต่อท้ายบรรทัดเดียวกับ location)
      def := replace(def, a_read, a_read || ' v_contract := NULLIF(btrim(COALESCE(u->>''contract_no'', '''')), '''');');
      -- (ค) แถวที่ไม่ได้กรอกอะไรเลยต้องนับ v_contract ด้วย ไม่งั้นแถวที่กรอกแต่เลขสัญญาถูกข้าม
      --     (0053 ต่อท้าย a_skip ด้วย ' AND v_ppo IS NULL' ไว้ — แทนที่แค่ส่วนหัว ส่วนหางคงอยู่)
      def := replace(def, a_skip, 'CONTINUE WHEN c IS NULL AND v_contract IS NULL AND v_cust IS NULL AND v_phone IS NULL AND v_loc IS NULL');
      -- (ง) ขา UPDATE: **ไม่มี CASE job_id** — เลขสัญญาเขียนได้ทุกเครื่อง (คนละชั้นกับ Job)
      def := replace(def, a_upd, a_upd || ' contract_no = COALESCE(v_contract, contract_no),');
      -- (จ) ขา INSERT: คอลัมน์ + ค่า ต้องเพิ่ม "ตำแหน่งเดียวกัน" (ต่อท้าย anchor ทั้งคู่ ⇒ เรียงตรงกัน)
      -- 🔴 ต้องอ่านจาก u ตรง ๆ **ห้ามใช้ v_contract** — ตัวแปรถูกเซ็ตในลูป UPDATE เท่านั้น
      --    ลูป INSERT เป็นคนละลูป จะได้ค่าค้างจากรอบก่อนติดไปกับเครื่องใหม่ (กติกาเดียวกับที่ 0053 ใช้)
      def := replace(def, a_cols, a_cols || ' contract_no,');
      def := replace(def, a_vals, a_vals || ' NULLIF(btrim(COALESCE(u->>''contract_no'', '''')), ''''),');
      EXECUTE def;
      RAISE NOTICE '0073: patch rpc_import_units_to_stock รองรับ contract_no แล้ว';
    END;
  END IF;
END $$;

-- ---------- 4) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE n INT; src TEXT;
BEGIN
  -- 4.1 คอลัมน์ + constraint + index
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'lbs_units' AND column_name = 'contract_no') THEN
    RAISE EXCEPTION '0073: ไม่มีคอลัมน์ lbs_units.contract_no';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'lbs_units'::regclass AND conname = 'lbs_units_contract_needs_info_ck') THEN
    RAISE EXCEPTION '0073: ไม่มี CHECK lbs_units_contract_needs_info_ck';
  END IF;

  -- 4.2 signature เดิมต้องหายไป ไม่งั้น PostgREST กำกวม (§9 ข้อ 8)
  IF to_regprocedure('public.rpc_update_unit_plan(uuid,numeric,text,text,text,date,date,date,int,date)') IS NOT NULL THEN
    RAISE EXCEPTION '0073: signature เดิมของ rpc_update_unit_plan ยังอยู่ — PostgREST จะเลือกไม่ถูก';
  END IF;
  IF to_regprocedure('public.rpc_update_unit_plan(uuid,numeric,text,text,text,date,date,date,int,date,text)') IS NULL THEN
    RAISE EXCEPTION '0073: ไม่พบ rpc_update_unit_plan ตัวใหม่';
  END IF;

  -- 4.3 import ต้องอ่าน contract_no ได้ และ **ต้องไม่** ผูกเงื่อนไข job_id กับคอลัมน์นี้
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_import_units_to_stock';
  IF position('contract_no' IN src) = 0 THEN
    RAISE EXCEPTION '0073: rpc_import_units_to_stock ไม่ได้อ่าน contract_no';
  END IF;
  IF position('contract_no = CASE WHEN job_id' IN src) > 0 THEN
    RAISE EXCEPTION '0073: contract_no ถูกข้ามเมื่อเครื่องมี Job — เลขสัญญาเป็นคนละชั้นกับ Job ต้องเขียนได้เสมอ';
  END IF;

  -- 4.4 🔴 ห้ามหลุดออกลิงก์สาธารณะ (0069)
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_public_lbs_stock';
  IF src IS NOT NULL AND position('contract_no' IN src) > 0 THEN
    RAISE EXCEPTION '0073: contract_no หลุดอยู่ใน rpc_public_lbs_stock — ข้อมูลสัญญาห้ามออกลิงก์สาธารณะ';
  END IF;

  SELECT count(*) INTO n FROM lbs_units WHERE contract_no IS NOT NULL;
  RAISE NOTICE '0073: OK — Contract No. รายเครื่องใช้งานได้ (ตอนนี้มี % เครื่องที่มีเลขสัญญา)', n;
  RAISE NOTICE '  ผูก Job แล้วเลขสัญญาเป็น Ref. · Job ยังเป็นแหล่งความจริงของลูกค้า/สถานที่ตาม 0014';
END $$;
