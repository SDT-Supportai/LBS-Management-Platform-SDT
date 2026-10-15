-- =============================================================================
-- 0087 — ↩️ ยกเลิกทะเบียนสัญญา (0085) · กลับมากรอก Contract No. รายเครื่อง + ซ้ำกันได้ (2026-10-14)
--
-- มติผู้ใช้ (2026-10-14):
--   1) ยกเลิกทะเบียนสัญญา
--   2) ลูกค้าออก PO ซื้อมากกว่า 1 set → กรอก Contract No. ซ้ำกันหลายเครื่องได้
--   3) หน้าจอขึ้นเครื่องหมายเตือนเล็ก ๆ ที่ช่อง Contract No. ว่าเลขนี้ซ้ำ (ฝั่ง frontend — ไม่บล็อก)
--
-- ⚠️ ห้ามเอาการ "พิมพ์เลขที่เครื่องอื่นถืออยู่ = ย้ายสัญญา" ของ 0082 กลับมา
--    นั่นคือต้นเหตุที่ PO หลาย set ใช้ไม่ได้ (เครื่องแรกเสียสัญญา + ลูกค้า + เอกสารแนบ)
--
-- ลำดับ (ข้อมูลไม่หายระหว่างทาง):
--   1) คัดลอกลูกค้า/เบอร์/สถานที่จากสัญญากลับลงเครื่อง — เฉพาะช่องที่ว่างอยู่ · ข้ามเครื่องที่ล็อกแล้ว
--      (0085 ให้เครื่องอ่านค่าจากสัญญา และล้างสถานที่ของเครื่องตอนผูก ⇒ ถ้าไม่คัดกลับ ช่องจะว่าง)
--      ข้ามค่า placeholder "(ไม่ระบุ — แก้ที่ทะเบียนสัญญา)" ที่ backfill ของ 0085 ใส่ไว้
--   2) ถอด FK lbs_units_contract_fk + trigger trg_unit_contract_guard + RPC ทะเบียนสัญญา 4 ตัว
--   3) **ไม่ DROP ตาราง** — เปลี่ยนชื่อเป็น contracts_archive_0085 (ซ่อนจาก client ทั้งหมด) เก็บไว้ตรวจย้อนหลัง
--      ⇒ ย้อนกลับได้ถ้าเปลี่ยนใจ · ลบทิ้งทีหลังได้เมื่อแน่ใจ: DROP TABLE contracts_archive_0085;
--   4) rpc_update_unit_plan เขียน contract_no ได้อีกครั้ง (signature เดิม — p_contract_no ยังอยู่)
--      + บังคับ Customer/Location เมื่อมีเลขสัญญาและยังไม่ผูก Job (กติกา 0073) · ไม่มีการย้ายสัญญา
--      ⚠️ ไม่คืน CHECK lbs_units_contract_needs_info_ck — CHECK แบบ NOT VALID ยังบังคับทุก UPDATE ของแถว
--         แถวเก่าที่ข้อมูลไม่ครบจะดึงเข้า Job/แก้อะไรไม่ได้เลย · ใช้ด่านใน RPC แทน
--
-- คงไว้ไม่แตะ: 0084 (ดึงเข้า Job ต้องมี Contract No.) · 0086 (จุดติดตั้งรายเครื่อง — อ่าน Location รายเครื่อง)
-- demo sync: src/data/logic.ts (contractPeers / contractCustomerConflicts / updateUnitPlan / unitCustomerInfo)
-- **รันหลัง 0086 และก่อน push** (หน้าจอใหม่ส่ง p_contract_no มาอีกครั้ง) · idempotent
-- =============================================================================

-- ---------- 1) คัดลอกข้อมูลจากสัญญากลับลงเครื่อง ----------
DO $$
DECLARE n INT;
BEGIN
  IF to_regclass('public.contracts') IS NULL THEN
    RAISE NOTICE '0087: ไม่พบตาราง contracts (รันไปแล้ว หรือไม่เคยรัน 0085) — ข้ามการคัดลอก';
    RETURN;
  END IF;
  EXECUTE $q$
    UPDATE lbs_units u SET
      plan_customer_name    = COALESCE(NULLIF(btrim(u.plan_customer_name), ''),
                                CASE WHEN c.customer_name LIKE '(ไม่ระบุ%' THEN NULL ELSE c.customer_name END),
      plan_contact_phone    = COALESCE(NULLIF(btrim(u.plan_contact_phone), ''), c.contact_phone),
      plan_install_location = COALESCE(NULLIF(btrim(u.plan_install_location), ''),
                                CASE WHEN c.install_location LIKE '(ไม่ระบุ%' THEN NULL ELSE c.install_location END),
      updated_at = now()
      FROM contracts c
     WHERE c.contract_no = u.contract_no
       AND u.status <> 'issued'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = u.job_id AND j.terminal_status IN ('issued', 'installed'))
       AND (NULLIF(btrim(u.plan_customer_name), '') IS NULL
         OR NULLIF(btrim(u.plan_contact_phone), '') IS NULL
         OR NULLIF(btrim(u.plan_install_location), '') IS NULL)
  $q$;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '0087: คัดลอกข้อมูลลูกค้า/สถานที่จากสัญญากลับลงเครื่อง % เครื่อง', n;
END $$;

-- ---------- 2) ถอดกลไกทะเบียนสัญญา ----------
DROP TRIGGER IF EXISTS trg_unit_contract_guard ON lbs_units;
DROP FUNCTION IF EXISTS app_unit_contract_guard();
ALTER TABLE lbs_units DROP CONSTRAINT IF EXISTS lbs_units_contract_fk;
DROP FUNCTION IF EXISTS rpc_save_contract(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, INT, TEXT);
DROP FUNCTION IF EXISTS rpc_delete_contract(UUID);
DROP FUNCTION IF EXISTS rpc_assign_units_to_contract(UUID, UUID[]);
DROP FUNCTION IF EXISTS rpc_unassign_unit_contract(UUID);

-- ---------- 3) เก็บตารางไว้เป็น archive (ซ่อนจาก client) ----------
DO $$
BEGIN
  IF to_regclass('public.contracts') IS NOT NULL AND to_regclass('public.contracts_archive_0085') IS NULL THEN
    ALTER TABLE contracts RENAME TO contracts_archive_0085;
  END IF;
  IF to_regclass('public.contracts_archive_0085') IS NOT NULL THEN
    DROP POLICY IF EXISTS contracts_read ON contracts_archive_0085;   -- RLS เปิดอยู่ + ไม่มี policy = client มองไม่เห็น
    REVOKE ALL ON contracts_archive_0085 FROM anon, authenticated;
    COMMENT ON TABLE contracts_archive_0085 IS
      '0087 — ทะเบียนสัญญาของ 0085 ที่ถูกยกเลิก (เก็บไว้ตรวจย้อนหลังเท่านั้น · ไม่มีโค้ดอ่าน) · ลบได้: DROP TABLE contracts_archive_0085';
  END IF;
END $$;

-- ---------- 4) rpc_update_unit_plan — เขียน Contract No. ได้อีกครั้ง (ซ้ำได้ · ไม่ย้ายสัญญา) ----------
-- body จาก 0085 (ไม่มี migration ไหนแก้หลังจากนั้น) + เขียน contract_no + ด่าน Customer/Location ของ 0073
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
  p_contract_no     TEXT    DEFAULT NULL    -- 0073 · 0087: ซ้ำกับเครื่องอื่นได้ (PO หลาย set)
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks; v_eta DATE; v_lead INT; v_contract TEXT; v_peers TEXT;
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

  -- 0073: มีเลขสัญญา = ข้อมูลลูกค้า "ตกลงแล้ว" ⇒ ต้องมี Customer + Location (ยกเว้นเครื่องที่ผูก Job — ข้อมูลมาจาก Job)
  v_contract := NULLIF(btrim(COALESCE(p_contract_no, '')), '');
  IF v_contract IS NOT NULL AND u.job_id IS NULL
     AND (NULLIF(btrim(COALESCE(p_customer_name, '')), '') IS NULL
       OR NULLIF(btrim(COALESCE(p_install_location, '')), '') IS NULL) THEN
    RAISE EXCEPTION 'กรอก Contract No. แล้วต้องระบุ Customer และ Location / Site ด้วย — ข้อมูลชุดนี้จะเลิกเป็น "แผน"';
  END IF;
  -- 0087: เลขซ้ำไม่บล็อก — แค่จดลง Audit ว่าใช้ร่วมกับเครื่องไหน (ไล่ย้อนได้ว่า PO หลาย set มีเครื่องอะไรบ้าง)
  IF v_contract IS NOT NULL THEN
    SELECT string_agg(serial_lvb, ', ' ORDER BY serial_lvb) INTO v_peers FROM lbs_units
     WHERE id <> u.id AND upper(btrim(contract_no)) = upper(v_contract);
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
    COALESCE(' (ใช้ร่วมกับ ' || v_peers || ')', '') ||
    ' · Customer' || CASE WHEN v_contract IS NULL THEN '(แผน)' ELSE '' END ||
    ' ' || COALESCE(p_customer_name, '-') ||
    ' · Plan PO receipt ' || COALESCE(p_plan_po_date::TEXT, '-') ||
    ' · FOB ' || COALESCE(p_fob_date::TEXT, '-') || ' +' || COALESCE(v_lead, 60) || ' วัน' ||
    ' · ETA to WH ' || COALESCE(v_eta::TEXT, '-') ||
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-'));
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) TO authenticated;

-- ---------- 5) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE src TEXT; u1 UUID; u2 UUID; ok_dup BOOLEAN := false;
BEGIN
  IF to_regclass('public.contracts') IS NOT NULL THEN RAISE EXCEPTION '0087: ตาราง contracts ยังอยู่'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lbs_units_contract_fk') THEN
    RAISE EXCEPTION '0087: FK lbs_units_contract_fk ยังอยู่';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_unit_contract_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0087: trigger trg_unit_contract_guard ยังอยู่';
  END IF;
  IF to_regprocedure('public.rpc_assign_units_to_contract(uuid, uuid[])') IS NOT NULL
     OR to_regprocedure('public.rpc_unassign_unit_contract(uuid)') IS NOT NULL
     OR to_regprocedure('public.rpc_delete_contract(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                 WHERE ns.nspname = 'public' AND p.proname = 'rpc_save_contract') THEN
    RAISE EXCEPTION '0087: RPC ทะเบียนสัญญายังเหลืออยู่';
  END IF;

  -- rpc_update_unit_plan ต้องเขียนเลขสัญญา และต้องไม่มีกลไกย้ายสัญญาของ 0082 (ตัดคอมเมนต์ก่อนเทียบ)
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_update_unit_plan';
  IF src !~ 'contract_no\s*=\s*v_contract' THEN RAISE EXCEPTION '0087: rpc_update_unit_plan ไม่เขียน contract_no'; END IF;
  IF position('lbs_unit_files' IN src) > 0 OR position('last_contract_no' IN src) > 0 THEN
    RAISE EXCEPTION '0087: rpc_update_unit_plan มีกลไกย้ายสัญญาของ 0082 — PO หลาย set จะพังอีก';
  END IF;

  -- ลองจริง: ใส่เลขเดียวกัน 2 เครื่องต้องผ่าน แล้วย้อนทิ้ง
  SELECT id INTO u1 FROM lbs_units WHERE status = 'in_stock' AND job_id IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO u2 FROM lbs_units WHERE status = 'in_stock' AND job_id IS NULL AND id <> u1 ORDER BY id LIMIT 1;
  IF u2 IS NULL THEN
    RAISE NOTICE '0087: มีเครื่องว่างไม่ถึง 2 เครื่อง — ข้ามการทดสอบเลขซ้ำ';
  ELSE
    BEGIN
      UPDATE lbs_units SET contract_no = '__0087_TEST__' WHERE id IN (u1, u2);
      ok_dup := (SELECT count(*) FROM lbs_units WHERE contract_no = '__0087_TEST__') = 2;
      RAISE EXCEPTION '__0087_ROLLBACK__';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> '__0087_ROLLBACK__' THEN RAISE; END IF;
    END;
    IF NOT ok_dup THEN RAISE EXCEPTION '0087: ใส่ Contract No. เดียวกัน 2 เครื่องไม่ผ่าน'; END IF;
  END IF;

  RAISE NOTICE '0087: OK — ยกเลิกทะเบียนสัญญาแล้ว (เก็บเป็น contracts_archive_0085) · Contract No. ซ้ำกันหลายเครื่องได้';
END $$;
