-- =============================================================================
-- 0085 — 📄 ทะเบียนสัญญา: PO ลูกค้า 1 ใบ ใช้กับ LBS ได้หลายเครื่อง (2026-10-14)
--
-- ที่มา (ผู้ใช้ขอ 2026-10-14): ลูกค้าออก PO ซื้อมากกว่า 1 set ต้องกรอก Contract No. ซ้ำทุกเครื่อง
--   และที่แย่กว่านั้น — 0082 ถือว่า "พิมพ์เลขที่เครื่องอื่นถืออยู่ = ย้ายสัญญา" ⇒ กรอกเลขเดียวกัน
--   ให้เครื่องที่ 2 จะถอดสัญญา + ข้อมูลลูกค้า + เอกสารแนบออกจากเครื่องที่ 1 ทันที (PO หลาย set ทำไม่ได้เลย)
--
-- ทางแก้ (ผู้ใช้เลือกแบบ B):
--   1) ตาราง contracts = ทะเบียนสัญญา: เลขสัญญา · ลูกค้า · ผู้ติดต่อ · สถานที่หลัก · PO ลูกค้า · จำนวน set
--   2) lbs_units.contract_no เป็น FK → contracts.contract_no (ON UPDATE CASCADE — แก้เลขสัญญาที่เดียว)
--      ลูกค้า/ผู้ติดต่ออ่านจากสัญญา · สถานที่ = รายเครื่อง (ถ้าแก้ทับ) ไม่งั้นสถานที่หลักของสัญญา
--   3) trigger trg_unit_contract_guard บน lbs_units — ทุกทางที่เขียน contract_no ผ่านด่านเดียวกัน
--      (rpc ผูกสัญญา · Import Excel · ทางในอนาคต) ไม่ต้อง patch body ของ rpc_import_units_to_stock
--        · ต้องมีในทะเบียน · ไม่เกินจำนวน set · ห้ามสลับสัญญา A → B ตรง ๆ (ต้องถอดก่อน)
--   4) rpc_update_unit_plan **ไม่แตะ contract_no แล้ว** — เลิกการย้ายสัญญาด้วยการพิมพ์ของ 0082
--      (signature เดิม p_contract_no ยังรับได้แต่ไม่ใช้ — client เก่าไม่พัง)
--   5) RPC ใหม่: rpc_save_contract · rpc_delete_contract · rpc_assign_units_to_contract · rpc_unassign_unit_contract
--   6) ถอด CHECK lbs_units_contract_needs_info_ck (0073) — ลูกค้า/สถานที่บังคับที่สัญญาแทน (NOT NULL)
--
-- backfill: เลขสัญญาที่มีอยู่แล้วบนเครื่อง → สร้างสัญญาอัตโนมัติ 1 ใบต่อเลข
--   ลูกค้า/สถานที่ = ค่าที่พบบ่อยสุดบนเครื่องของเลขนั้น (ไม่มีก็ใช้จาก Job) · จำนวน set = จำนวนเครื่องที่ถืออยู่
--   ⚠️ ไม่แก้แถว lbs_units เลย (เครื่องที่เบิกแล้วถูก trg_block_issued_edit ล็อก แก้ไม่ได้อยู่แล้ว)
--
-- ⚠️ ห้ามเปิด contracts ออกลิงก์สาธารณะ (0069) — ข้อมูลเชิงพาณิชย์ · RLS ให้อ่านเฉพาะ authenticated
-- demo sync: src/data/logic.ts (saveContract / assignUnitsToContract / unassignUnitContract /
--   deleteContract / unitCustomerInfo / updateUnitPlan / importUnitsToStock) · รันหลัง 0084 · idempotent
-- **รันก่อน push** (หน้าจอใหม่เรียก RPC ใหม่ · frontend อ่านตาราง contracts แบบ optional จึงไม่พังถ้ายังไม่รัน)
-- =============================================================================

-- ---------- 1) ตารางทะเบียนสัญญา ----------
CREATE TABLE IF NOT EXISTS contracts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_no      VARCHAR(80) NOT NULL UNIQUE,
  customer_name    TEXT NOT NULL,
  contact_phone    TEXT,
  install_location TEXT NOT NULL,          -- สถานที่หลัก · รายเครื่องแก้ทับได้ที่ lbs_units.plan_install_location
  customer_po_no   TEXT,                   -- เลขที่ PO ของลูกค้า
  po_date          DATE,
  qty_sets         INT NOT NULL CHECK (qty_sets > 0),
  note             TEXT,
  created_by       UUID REFERENCES profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  -- ⚠️ ไม่ใส่ CHECK btrim — backfill ต้องรับค่าเดิมบนเครื่องตรงตัว (FK เทียบแบบตรงตัว) · RPC trim ให้เองทุกครั้ง
);

COMMENT ON TABLE contracts IS
  '0085 — ทะเบียนสัญญาขาย · PO ลูกค้า 1 ใบ = สัญญา 1 ใบ ใช้กับ LBS ได้ qty_sets เครื่อง · '
  'ห้ามเปิดออกลิงก์สาธารณะ (0069)';

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contracts_read ON contracts;
CREATE POLICY contracts_read ON contracts FOR SELECT TO authenticated USING (true);
-- เขียนผ่าน RPC (SECURITY DEFINER) เท่านั้น
REVOKE INSERT, UPDATE, DELETE ON contracts FROM authenticated, anon;
REVOKE ALL ON contracts FROM anon;

-- ---------- 2) backfill จากเลขสัญญาที่มีอยู่บนเครื่อง ----------
INSERT INTO contracts (contract_no, customer_name, contact_phone, install_location, qty_sets, note)
SELECT u.contract_no,
       COALESCE(mode() WITHIN GROUP (ORDER BY NULLIF(btrim(u.plan_customer_name), '')),
                mode() WITHIN GROUP (ORDER BY j.customer_name), '(ไม่ระบุ — แก้ที่ทะเบียนสัญญา)'),
       COALESCE(mode() WITHIN GROUP (ORDER BY NULLIF(btrim(u.plan_contact_phone), '')),
                mode() WITHIN GROUP (ORDER BY j.contact_phone)),
       COALESCE(mode() WITHIN GROUP (ORDER BY NULLIF(btrim(u.plan_install_location), '')),
                mode() WITHIN GROUP (ORDER BY j.install_location), '(ไม่ระบุ — แก้ที่ทะเบียนสัญญา)'),
       count(*)::INT,
       '0085 — สร้างอัตโนมัติจากเลขสัญญาที่มีอยู่บนเครื่อง · ตรวจลูกค้า/จำนวน set ให้ตรง PO จริง'
  FROM lbs_units u
  LEFT JOIN jobs j ON j.id = u.job_id
 WHERE u.contract_no IS NOT NULL
 GROUP BY u.contract_no
ON CONFLICT (contract_no) DO NOTHING;

-- เคยรันแล้ว backfill ซ้ำ ⇒ จำนวน set ต้องไม่น้อยกว่าเครื่องที่ถืออยู่ (ไม่งั้น FK/trigger ขัดกันเอง)
UPDATE contracts c SET qty_sets = x.n
  FROM (SELECT contract_no, count(*)::INT n FROM lbs_units WHERE contract_no IS NOT NULL GROUP BY contract_no) x
 WHERE x.contract_no = c.contract_no AND c.qty_sets < x.n;

-- ---------- 3) ถอด CHECK ของ 0073 · ใส่ FK ----------
ALTER TABLE lbs_units DROP CONSTRAINT IF EXISTS lbs_units_contract_needs_info_ck;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lbs_units_contract_fk' AND conrelid = 'lbs_units'::regclass) THEN
    ALTER TABLE lbs_units ADD CONSTRAINT lbs_units_contract_fk
      FOREIGN KEY (contract_no) REFERENCES contracts(contract_no) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- ---------- 4) ด่านเดียวของการเขียน contract_no ----------
CREATE OR REPLACE FUNCTION app_unit_contract_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c contracts; n INT;
BEGIN
  NEW.contract_no := NULLIF(btrim(COALESCE(NEW.contract_no, '')), '');
  IF NEW.contract_no IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.contract_no IS NOT DISTINCT FROM OLD.contract_no THEN RETURN NEW; END IF;

  -- ล็อกแถวสัญญา ⇒ ผูกพร้อมกัน 2 คนก็นับจำนวน set ไม่พลาด
  SELECT * INTO c FROM contracts WHERE contract_no = NEW.contract_no FOR UPDATE;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบ Contract No. % ในทะเบียนสัญญา — สร้างสัญญาที่ Project Stock → 📄 ทะเบียนสัญญา ก่อน', NEW.contract_no;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.contract_no IS NOT NULL THEN
    -- เลขเดิมยังอยู่ในทะเบียน = สลับสัญญาตรง ๆ → ไม่ให้ (ต้องถอดก่อน)
    -- เลขเดิมไม่อยู่แล้ว = rpc_save_contract เปลี่ยนเลขสัญญา แล้ว FK ON UPDATE CASCADE ตามมาแก้ → ปล่อยผ่าน
    IF EXISTS (SELECT 1 FROM contracts WHERE contract_no = OLD.contract_no) THEN
      RAISE EXCEPTION '% อยู่ในสัญญา % แล้ว — ถอดออกจากสัญญาเดิมก่อน', NEW.serial_lvb, OLD.contract_no;
    END IF;
    RETURN NEW;                            -- เปลี่ยนชื่อ ไม่ได้เพิ่มเครื่อง ไม่ต้องนับ set
  END IF;

  SELECT count(*) INTO n FROM lbs_units WHERE contract_no = NEW.contract_no AND id <> NEW.id;
  IF n >= c.qty_sets THEN
    RAISE EXCEPTION 'สัญญา % ซื้อ % set — ผูกครบแล้ว (ถ้าลูกค้าซื้อเพิ่ม ให้แก้จำนวน set ในสัญญาก่อน)',
      c.contract_no, c.qty_sets;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_unit_contract_guard ON lbs_units;
CREATE TRIGGER trg_unit_contract_guard
  BEFORE INSERT OR UPDATE OF contract_no ON lbs_units
  FOR EACH ROW EXECUTE FUNCTION app_unit_contract_guard();

-- ---------- 5) rpc_update_unit_plan — ไม่แตะเลขสัญญาแล้ว ----------
-- body คัดจาก 0082 (ไม่มี migration ไหนแก้หลังจากนั้น) · ตัดส่วน 0073 บังคับลูกค้า + ส่วนย้ายสัญญา 0082 ออก
-- signature เดิมทั้งหมด (p_contract_no ยังอยู่แต่ไม่ใช้) ⇒ CREATE OR REPLACE ได้ ไม่ต้อง DROP
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
  p_contract_no     TEXT    DEFAULT NULL    -- 0085: ไม่ใช้แล้ว — ผูก/ถอดสัญญาผ่าน rpc_assign_units_to_contract
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks; c contracts; v_eta DATE; v_lead INT;
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

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;
  SELECT * INTO c FROM contracts WHERE contract_no = u.contract_no;
  v_lead := CASE WHEN p_fob_date IS NULL THEN NULL ELSE NULLIF(p_lead_days, 60) END;
  v_eta := CASE WHEN p_fob_date IS NOT NULL THEN p_fob_date + COALESCE(v_lead, 60) ELSE p_plan_po_receipt END;

  UPDATE lbs_units SET
    unit_cost             = p_unit_cost,
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
    ' ฿ · Contract No. ' || COALESCE(u.contract_no, '-') ||
    CASE WHEN u.contract_no IS NULL
         THEN ' · Customer(แผน) ' || COALESCE(p_customer_name, '-')
         ELSE ' · Customer (ตามสัญญา) ' || COALESCE(c.customer_name, '-') END ||
    ' · Plan PO receipt ' || COALESCE(p_plan_po_date::TEXT, '-') ||
    ' · FOB ' || COALESCE(p_fob_date::TEXT, '-') || ' +' || COALESCE(v_lead, 60) || ' วัน' ||
    ' · ETA to WH ' || COALESCE(v_eta::TEXT, '-') ||
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-'));
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) TO authenticated;

-- ---------- 6) RPC ทะเบียนสัญญา ----------
CREATE OR REPLACE FUNCTION rpc_save_contract(
  p_id UUID, p_contract_no TEXT, p_customer_name TEXT, p_contact_phone TEXT, p_install_location TEXT,
  p_customer_po_no TEXT, p_po_date DATE, p_qty_sets INT, p_note TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; old contracts; v_no TEXT; v_cust TEXT; v_loc TEXT; n INT; locked TEXT; new_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);   -- Division + Manage
  v_no   := NULLIF(btrim(COALESCE(p_contract_no, '')), '');
  v_cust := NULLIF(btrim(COALESCE(p_customer_name, '')), '');
  v_loc  := NULLIF(btrim(COALESCE(p_install_location, '')), '');
  IF v_no IS NULL THEN RAISE EXCEPTION 'กรุณาระบุ Contract No.'; END IF;
  IF v_cust IS NULL THEN RAISE EXCEPTION 'กรุณาระบุ Customer'; END IF;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้งหลัก (Location / Site)'; END IF;
  IF p_qty_sets IS NULL OR p_qty_sets < 1 THEN
    RAISE EXCEPTION 'จำนวน set ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป';
  END IF;
  IF EXISTS (SELECT 1 FROM contracts WHERE contract_no = v_no AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION 'Contract No. % มีอยู่ในทะเบียนแล้ว', v_no;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO contracts (contract_no, customer_name, contact_phone, install_location,
                           customer_po_no, po_date, qty_sets, note, created_by)
    VALUES (v_no, v_cust, NULLIF(btrim(COALESCE(p_contact_phone, '')), ''), v_loc,
            NULLIF(btrim(COALESCE(p_customer_po_no, '')), ''), p_po_date, p_qty_sets,
            NULLIF(btrim(COALESCE(p_note, '')), ''), actor.id)
    RETURNING id INTO new_id;
    PERFORM app_audit('contract', new_id, 'create_contract', actor.id,
      'สร้างสัญญา ' || v_no || ' · ' || v_cust || ' · ' || p_qty_sets || ' set' ||
      COALESCE(' · PO ลูกค้า ' || NULLIF(btrim(COALESCE(p_customer_po_no, '')), ''), ''));
    RETURN new_id;
  END IF;

  SELECT * INTO old FROM contracts WHERE id = p_id FOR UPDATE;
  IF old.id IS NULL THEN RAISE EXCEPTION 'ไม่พบสัญญา'; END IF;
  SELECT count(*) INTO n FROM lbs_units WHERE contract_no = old.contract_no;
  IF p_qty_sets < n THEN
    RAISE EXCEPTION 'สัญญานี้ผูกเครื่องไว้แล้ว % เครื่อง — ลดจำนวน set ต่ำกว่านั้นไม่ได้ (ถอดเครื่องออกก่อน)', n;
  END IF;
  IF v_no <> old.contract_no THEN
    -- เครื่องที่เบิกแล้วถูก trg_block_issued_edit ล็อกทั้งแถว ⇒ CASCADE จะพังกลางทาง — บอกให้ชัดก่อน
    SELECT u.serial_lvb INTO locked FROM lbs_units u LEFT JOIN jobs j ON j.id = u.job_id
     WHERE u.contract_no = old.contract_no
       AND (u.status = 'issued' OR j.terminal_status IN ('issued', 'installed'))
     LIMIT 1;
    IF locked IS NOT NULL THEN
      RAISE EXCEPTION 'เปลี่ยนเลขสัญญาไม่ได้ — % เบิกให้ Service แล้ว (ข้อมูลเครื่องถูกล็อก)', locked;
    END IF;
  END IF;

  UPDATE contracts SET
    contract_no      = v_no,               -- เปลี่ยนเลข → FK ON UPDATE CASCADE แก้ lbs_units ตามให้
    customer_name    = v_cust,
    contact_phone    = NULLIF(btrim(COALESCE(p_contact_phone, '')), ''),
    install_location = v_loc,
    customer_po_no   = NULLIF(btrim(COALESCE(p_customer_po_no, '')), ''),
    po_date          = p_po_date,
    qty_sets         = p_qty_sets,
    note             = NULLIF(btrim(COALESCE(p_note, '')), ''),
    updated_at       = now()
  WHERE id = p_id;

  PERFORM app_audit('contract', p_id, 'update_contract', actor.id,
    'แก้สัญญา ' || v_no || CASE WHEN v_no <> old.contract_no THEN ' (เดิม ' || old.contract_no || ')' ELSE '' END ||
    ' · ' || v_cust || ' · ' || p_qty_sets || ' set' ||
    COALESCE(' · PO ลูกค้า ' || NULLIF(btrim(COALESCE(p_customer_po_no, '')), ''), ''));
  RETURN p_id;
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_contract(p_contract_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; c contracts; n INT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO c FROM contracts WHERE id = p_contract_id FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'ไม่พบสัญญา'; END IF;
  SELECT count(*) INTO n FROM lbs_units WHERE contract_no = c.contract_no;
  IF n > 0 THEN
    RAISE EXCEPTION 'สัญญา % ยังผูกเครื่องอยู่ % เครื่อง — ถอดออกให้หมดก่อนลบ', c.contract_no, n;
  END IF;
  DELETE FROM contracts WHERE id = c.id;
  PERFORM app_audit('contract', c.id, 'delete_contract', actor.id,
    'ลบสัญญา ' || c.contract_no || ' · ' || c.customer_name);
END $$;

-- ผูกทีละหลายเครื่อง (PO หลาย set) · เครื่องที่ยังไม่ผูก Job: ล้างสถานที่แผนเดิม ให้ใช้สถานที่หลักของสัญญา
CREATE OR REPLACE FUNCTION rpc_assign_units_to_contract(p_contract_id UUID, p_unit_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; c contracts; u RECORD; n_found INT := 0; n_have INT; n_new INT; serials TEXT[];
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO c FROM contracts WHERE id = p_contract_id FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'ไม่พบสัญญา'; END IF;
  n_new := COALESCE(array_length(p_unit_ids, 1), 0);
  IF n_new = 0 THEN RAISE EXCEPTION 'กรุณาเลือกเครื่องที่จะผูกเข้าสัญญา'; END IF;

  FOR u IN
    SELECT x.id, x.serial_lvb, x.status, x.contract_no, j.terminal_status
      FROM lbs_units x LEFT JOIN jobs j ON j.id = x.job_id
     WHERE x.id = ANY(p_unit_ids)
       FOR UPDATE OF x
  LOOP
    n_found := n_found + 1;
    IF u.status = 'issued' OR u.terminal_status IN ('issued', 'installed') THEN
      RAISE EXCEPTION '% เบิกให้ Service แล้ว — ผูกสัญญาไม่ได้', u.serial_lvb;
    END IF;
    IF u.contract_no = c.contract_no THEN RAISE EXCEPTION '% อยู่ในสัญญานี้แล้ว', u.serial_lvb; END IF;
    IF u.contract_no IS NOT NULL THEN
      RAISE EXCEPTION '% อยู่ในสัญญา % แล้ว — ถอดออกจากสัญญาเดิมก่อน', u.serial_lvb, u.contract_no;
    END IF;
  END LOOP;
  IF n_found <> n_new THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS บางเครื่อง'; END IF;

  SELECT count(*) INTO n_have FROM lbs_units WHERE contract_no = c.contract_no;
  IF n_have + n_new > c.qty_sets THEN
    RAISE EXCEPTION 'สัญญา % ซื้อ % set — ผูกได้อีก % เครื่อง (เลือกมา %) · ถ้าลูกค้าซื้อเพิ่ม ให้แก้จำนวน set ในสัญญาก่อน',
      c.contract_no, c.qty_sets, c.qty_sets - n_have, n_new;
  END IF;

  WITH upd AS (
    UPDATE lbs_units SET
      contract_no = c.contract_no,
      plan_install_location = CASE WHEN job_id IS NULL THEN NULL ELSE plan_install_location END,
      updated_at = now()
    WHERE id = ANY(p_unit_ids)
    RETURNING serial_lvb
  )
  SELECT array_agg(serial_lvb ORDER BY serial_lvb) INTO serials FROM upd;

  PERFORM app_audit('contract', c.id, 'assign_units', actor.id,
    'ผูก ' || n_new || ' เครื่องเข้าสัญญา ' || c.contract_no || ' (' || array_to_string(serials, ', ') || ') · รวม ' ||
    (n_have + n_new) || '/' || c.qty_sets || ' set');
END $$;

-- ถอดได้เฉพาะเครื่องที่ยังอยู่ในคลัง — ไม่งั้น Job จะถือเครื่องที่ไม่มีสัญญา (ขัด 0084)
CREATE OR REPLACE FUNCTION rpc_unassign_unit_contract(p_unit_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; c contracts; v_job TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id FOR UPDATE;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.contract_no IS NULL THEN RAISE EXCEPTION '% ไม่ได้ผูกสัญญาอยู่', u.serial_lvb; END IF;
  IF u.status = 'issued' THEN RAISE EXCEPTION '% เบิกให้ Service แล้ว — ถอดสัญญาไม่ได้', u.serial_lvb; END IF;
  IF u.status <> 'in_stock' THEN
    SELECT job_no INTO v_job FROM jobs WHERE id = u.job_id;
    RAISE EXCEPTION '% ถูกดึงเข้า % แล้ว — คืนเข้าคลังก่อนถอดสัญญา', u.serial_lvb, COALESCE(v_job, '-');
  END IF;
  SELECT * INTO c FROM contracts WHERE contract_no = u.contract_no;
  UPDATE lbs_units SET contract_no = NULL, updated_at = now() WHERE id = u.id;
  PERFORM app_audit('contract', COALESCE(c.id, u.id), 'unassign_unit', actor.id,
    'ถอด ' || u.serial_lvb || ' ออกจากสัญญา ' || u.contract_no);
END $$;

REVOKE ALL ON FUNCTION public.rpc_save_contract(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, INT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_save_contract(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, INT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_delete_contract(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_delete_contract(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_assign_units_to_contract(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_assign_units_to_contract(UUID, UUID[]) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_unassign_unit_contract(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_unassign_unit_contract(UUID) TO authenticated;

-- ---------- 7) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE src TEXT; n INT; cid UUID; u1 UUID; u2 UUID; ok_one BOOLEAN := false; ok_cap BOOLEAN := false;
        ok_unknown BOOLEAN := false; ok_rename BOOLEAN := false;
BEGIN
  -- 7.1 โครงสร้าง
  IF to_regclass('public.contracts') IS NULL THEN RAISE EXCEPTION '0085: ไม่มีตาราง contracts'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lbs_units_contract_fk' AND conrelid = 'lbs_units'::regclass) THEN
    RAISE EXCEPTION '0085: ไม่มี FK lbs_units_contract_fk';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lbs_units_contract_needs_info_ck') THEN
    RAISE EXCEPTION '0085: CHECK lbs_units_contract_needs_info_ck (0073) ยังอยู่';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_unit_contract_guard' AND tgrelid = 'lbs_units'::regclass
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0085: trigger trg_unit_contract_guard ไม่ได้ติดตั้ง/ถูกปิด';
  END IF;
  SELECT count(*) INTO n FROM lbs_units u WHERE u.contract_no IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.contract_no = u.contract_no);
  IF n > 0 THEN RAISE EXCEPTION '0085: มีเครื่อง % เครื่องที่เลขสัญญาไม่อยู่ในทะเบียน', n; END IF;

  -- 7.2 rpc_update_unit_plan ต้องไม่เขียน contract_no แล้ว (ตัดคอมเมนต์ก่อนเทียบ)
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_update_unit_plan';
  -- ⚠️ ห้ามจับแค่ 'contract_no =' — body ใหม่มี "WHERE contract_no = u.contract_no" (อ่านสัญญามาเขียน Audit)
  IF src ~ 'contract_no\s*=\s*v_contract' OR position('last_contract_no' IN src) > 0
     OR position('lbs_unit_files' IN src) > 0 THEN
    RAISE EXCEPTION '0085: rpc_update_unit_plan ยังเขียนเลขสัญญา/ย้ายเอกสารแนบอยู่ (ของ 0082)';
  END IF;

  -- 7.3 ลองจริงกับสัญญาชั่วคราว แล้วย้อนทิ้งทั้งหมด
  SELECT id INTO u1 FROM lbs_units WHERE status = 'in_stock' AND contract_no IS NULL AND job_id IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO u2 FROM lbs_units WHERE status = 'in_stock' AND contract_no IS NULL AND job_id IS NULL AND id <> u1 ORDER BY id LIMIT 1;
  IF u2 IS NULL THEN
    RAISE NOTICE '0085: มีเครื่องว่างไม่ถึง 2 เครื่อง — ข้ามการทดสอบจริงของ trigger';
  ELSE
    BEGIN
      INSERT INTO contracts (contract_no, customer_name, install_location, qty_sets)
      VALUES ('__0085_TEST__', 'test', 'test', 1) RETURNING id INTO cid;
      UPDATE lbs_units SET contract_no = '__0085_TEST__' WHERE id = u1;     -- เครื่องแรกต้องผ่าน
      ok_one := true;
      BEGIN
        UPDATE lbs_units SET contract_no = '__0085_TEST__' WHERE id = u2;   -- เกิน 1 set ต้องโดนปฏิเสธ
      EXCEPTION WHEN raise_exception THEN ok_cap := position('ผูกครบแล้ว' IN SQLERRM) > 0;
      END;
      BEGIN
        UPDATE lbs_units SET contract_no = '__0085_NOPE__' WHERE id = u2;   -- เลขที่ไม่มีในทะเบียน
      EXCEPTION WHEN raise_exception THEN ok_unknown := position('ไม่พบ Contract No.' IN SQLERRM) > 0;
      END;
      UPDATE contracts SET contract_no = '__0085_TEST2__' WHERE id = cid; -- เปลี่ยนเลข → CASCADE
      ok_rename := EXISTS (SELECT 1 FROM lbs_units WHERE id = u1 AND contract_no = '__0085_TEST2__');
      RAISE EXCEPTION '__0085_ROLLBACK__';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> '__0085_ROLLBACK__' THEN RAISE; END IF;
    END;
    IF NOT ok_one THEN RAISE EXCEPTION '0085: ผูกเครื่องแรกเข้าสัญญาไม่ผ่าน'; END IF;
    IF NOT ok_cap THEN RAISE EXCEPTION '0085: ผูกเกินจำนวน set ได้ — trigger ไม่ทำงาน'; END IF;
    IF NOT ok_unknown THEN RAISE EXCEPTION '0085: ใส่เลขสัญญาที่ไม่มีในทะเบียนได้'; END IF;
    IF NOT ok_rename THEN RAISE EXCEPTION '0085: เปลี่ยนเลขสัญญาแล้วเครื่องไม่ตาม (CASCADE)'; END IF;
  END IF;

  SELECT count(*) INTO n FROM contracts;
  RAISE NOTICE '0085: OK — ทะเบียนสัญญาพร้อมใช้ (% สัญญา · backfill จากเลขเดิมบนเครื่องแล้ว)', n;
END $$;
