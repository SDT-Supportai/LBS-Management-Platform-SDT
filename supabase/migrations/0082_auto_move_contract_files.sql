-- =============================================================================
-- 0082 — 📎 ย้าย Contract No. ผ่าน "แก้ข้อมูล" = เอกสารแนบย้ายตามไปอัตโนมัติ (2026-10-11)
--
-- ที่มา (ผู้ใช้ขอ 2026-10-11 · ต่อจาก 0081):
--   (1) ถ้าย้าย Contract No. จาก Serial เดิมไป Serial ใหม่ และเครื่องเดิมมีเอกสารแนบ → ย้ายไปด้วย **อัตโนมัติ**
--   (2) เอาปุ่ม 🔀 ย้าย Contract ออก ⇒ ทางเดียวคือฟอร์ม "แก้ข้อมูล" ตามปกติ (rpc_update_unit_plan)
--
-- ตรวจจับ "การย้าย" ได้ 2 ลำดับที่คนทำจริง:
--   (ก) พิมพ์เลขสัญญาใส่เครื่องใหม่ ทั้งที่เครื่องเดิมยังถือเลขนั้นอยู่
--       ⇒ ถอดเลขสัญญา + ข้อมูลลูกค้าออกจากเครื่องเดิม (สัญญา 1 ใบ = 1 เครื่อง — มติผู้ใช้ "ย้าย")
--   (ข) ลบเลขสัญญาออกจากเครื่องเดิมก่อน แล้วค่อยไปพิมพ์ใส่เครื่องใหม่
--       ⇒ ต้องจำว่าเครื่องไหนเพิ่งถอดเลขนั้นออก → คอลัมน์ใหม่ last_contract_no
--   ทั้ง 2 กรณี: เอกสารแนบ **ทั้งหมด** ของเครื่องเดิมย้ายไปเครื่องใหม่ (lbs_unit_files.unit_id)
--
-- ⚠️ เครื่องเดิมที่เบิกให้ Service แล้ว (กรณี ก) = ถอดสัญญาไม่ได้ (trg_block_issued_edit ล็อกทั้งแถว) → แจ้ง error
--    กรณี ข เครื่องเดิมเบิกไปแล้วก็ยังย้ายไฟล์ได้ (ย้ายแถวไฟล์ ไม่แตะแถวเครื่อง)
-- ⚠️ rpc_update_unit_plan ไม่มี migration ไหนแก้หลัง 0073 (ตรวจแล้ว) ⇒ body คัดจาก 0073 ทั้งดุ้น + เติมส่วนย้าย
--    signature เดิม ⇒ CREATE OR REPLACE ได้ ไม่ต้อง DROP
-- ⚠️ rpc_import_units_to_stock (Import Excel) ยัง **ไม่** ย้ายไฟล์ — ไฟล์ Excel แก้ทีละหลายเครื่อง
--    ตรวจจับการย้ายจากไฟล์แล้วอาจย้ายผิดเครื่องได้ง่าย · ย้ายสัญญาให้ทำทีละเครื่องที่ "แก้ข้อมูล"
--
-- demo sync ที่ src/data/logic.ts (updateUnitPlan / contractMoveSource) · รันหลัง 0081 · idempotent
-- **ต้องรันก่อน push** (frontend เลิกเรียก rpc_move_unit_contract และฟอร์มแสดงตัวอย่างการย้าย)
-- =============================================================================

ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS last_contract_no TEXT;
COMMENT ON COLUMN lbs_units.last_contract_no IS
  '0082 — เลขสัญญาล่าสุดที่ถูกถอดออกจากเครื่องนี้ · ใช้หาเครื่องต้นทางตอนพิมพ์เลขนี้ใส่เครื่องใหม่ (ย้ายเอกสารแนบตาม)';
CREATE INDEX IF NOT EXISTS idx_lbs_units_last_contract ON lbs_units(last_contract_no) WHERE last_contract_no IS NOT NULL;

-- 0081 ถูกแทนด้วยการย้ายอัตโนมัติ — ไม่มี client เรียกแล้ว ทิ้งไว้จะเป็นทางลัดที่ไม่มีใครดูแล
DROP FUNCTION IF EXISTS rpc_move_unit_contract(UUID, UUID, UUID[], TEXT);

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
        src lbs_units; n_files INT := 0; move_txt TEXT := '';
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

  -- ---------- 0082: ย้าย Contract มาจากเครื่องอื่น → เอกสารแนบตามมาด้วย ----------
  IF v_contract IS NOT NULL AND v_contract IS DISTINCT FROM u.contract_no THEN
    -- (ก) เครื่องอื่นยังถือเลขนี้อยู่
    SELECT * INTO src FROM lbs_units
     WHERE id <> u.id AND contract_no = v_contract
     ORDER BY updated_at DESC NULLS LAST LIMIT 1 FOR UPDATE;
    IF src.id IS NOT NULL THEN
      IF src.status = 'issued' THEN
        RAISE EXCEPTION 'Contract No. % อยู่กับ Serial % ซึ่งเบิกให้ Service แล้ว — ย้ายสัญญาออกไม่ได้', v_contract, src.serial_lvb;
      END IF;
      UPDATE lbs_units SET contract_no = NULL, plan_customer_name = NULL, plan_contact_phone = NULL,
        plan_install_location = NULL, plan_po_date = NULL, plan_delivery_date = NULL,
        last_contract_no = NULL, updated_at = now()
      WHERE id = src.id;
    ELSE
      -- (ข) เครื่องที่เพิ่งถอดเลขนี้ออก (ยังไม่มีสัญญาใบใหม่)
      SELECT * INTO src FROM lbs_units
       WHERE id <> u.id AND contract_no IS NULL AND last_contract_no = v_contract
       ORDER BY updated_at DESC NULLS LAST LIMIT 1 FOR UPDATE;
      IF src.id IS NOT NULL AND src.status <> 'issued' THEN
        UPDATE lbs_units SET last_contract_no = NULL, updated_at = now() WHERE id = src.id;
      END IF;
    END IF;

    IF src.id IS NOT NULL THEN
      UPDATE lbs_unit_files SET unit_id = u.id WHERE unit_id = src.id;
      GET DIAGNOSTICS n_files = ROW_COUNT;
      move_txt := ' · ย้าย Contract มาจาก ' || src.serial_lvb || ' (เอกสารแนบตามมา ' || n_files || ' ไฟล์)';
      PERFORM app_audit('lbs_unit', src.id, 'move_unit_contract', actor.id,
        'Contract ' || v_contract || ' ย้ายไปที่ ' || u.serial_lvb || ' · เอกสารแนบ ' || n_files || ' ไฟล์ย้ายตามไป' ||
        CASE WHEN src.contract_no IS NOT NULL THEN ' (ถอดเลขสัญญา + ข้อมูลลูกค้าออกจากเครื่องนี้)' ELSE '' END);
    END IF;
  END IF;

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;
  v_lead := CASE WHEN p_fob_date IS NULL THEN NULL ELSE NULLIF(p_lead_days, 60) END;
  v_eta := CASE WHEN p_fob_date IS NOT NULL THEN p_fob_date + COALESCE(v_lead, 60) ELSE p_plan_po_receipt END;

  UPDATE lbs_units SET
    unit_cost             = p_unit_cost,
    contract_no           = v_contract,
    -- 0082: ถอด/เปลี่ยนเลขสัญญา → จำเลขเดิมไว้ ให้เครื่องที่รับเลขนี้ไปทีหลังดึงเอกสารแนบตามได้
    last_contract_no      = CASE WHEN u.contract_no IS NOT NULL AND u.contract_no IS DISTINCT FROM v_contract
                                 THEN u.contract_no ELSE u.last_contract_no END,
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
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-') || move_txt);
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE, TEXT) TO authenticated;

DO $$
DECLARE src TEXT; n INT;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_update_unit_plan';
  IF n <> 1 THEN RAISE EXCEPTION '0082: rpc_update_unit_plan มี % ตัว (ต้อง 1)', n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_update_unit_plan';
  IF position('lbs_unit_files' IN src) = 0 THEN RAISE EXCEPTION '0082: rpc_update_unit_plan ยังไม่ย้ายเอกสารแนบ'; END IF;
  IF position('ถูกเบิกให้ Service แล้ว' IN src) = 0 THEN RAISE EXCEPTION '0082: ด่านเครื่องที่เบิกแล้วหายไป'; END IF;
  IF to_regprocedure('public.rpc_move_unit_contract(uuid, uuid, uuid[], text)') IS NOT NULL THEN
    RAISE EXCEPTION '0082: rpc_move_unit_contract ยังอยู่';
  END IF;
  RAISE NOTICE '0082: OK — ย้าย Contract ผ่าน "แก้ข้อมูล" แล้วเอกสารแนบย้ายตามอัตโนมัติ';
END $$;
