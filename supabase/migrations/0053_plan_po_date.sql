-- =====================================================================
-- 0053: Plan PO receipt รายเครื่อง + เปลี่ยนชื่อคอลัมน์บนจอเป็นอังกฤษ (2026-08-08)
--
--  เพิ่ม `lbs_units.plan_po_date` = **วันที่คาดว่าจะได้รับ PO จากลูกค้า** (แผนฝั่งขาย)
--  วางถัดจาก Location / Site ในตาราง เพราะเป็นชุดเดียวกับข้อมูลแผนลูกค้า
--
--  ⚠️⚠️ ระวังสับสนกับ `plan_po_receipt_date` (คอลัมน์เดิมจาก 0043)
--     0043: plan_po_receipt_date = "Plan PO receipt" ในความหมาย **วันที่ของเข้าคลัง**
--     0049: เปลี่ยนความหมาย/ป้ายเป็น **ETA to WH (แบบกรอกเอง)** — ข้อมูลเดิมไม่ต้อง migrate
--     0053: คืนชื่อ "Plan PO receipt" ให้ **ฟิลด์ใหม่** ตามที่ผู้ใช้ต้องการ (วันรับ PO จากลูกค้า)
--     → สองคอลัมน์นี้คนละความหมาย ห้ามสลับกัน:
--          plan_po_date         = วันรับ PO จากลูกค้า      (ป้าย "Plan PO receipt")
--          plan_po_receipt_date = วันของเข้าคลังแบบกรอกเอง (ป้าย "ETA to WH")
--     ฝั่ง UI ถอด alias 'Plan PO receipt' ออกจาก ETA to WH แล้ว ไม่งั้น Import จะลงผิดช่อง
--
--  กติกาเดียวกับ Customer / Contact Number / Location / Site (กฎ 0014):
--  เขียนได้เฉพาะเครื่องที่ยังไม่ผูก Job — เครื่องที่มี Job แล้วค่าจริงมาจาก Job
--
--  demo sync ที่ src/data/logic.ts (updateUnitPlan / importUnitsToStock) · รันหลัง 0052 · idempotent
-- =====================================================================

ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS plan_po_date DATE;
COMMENT ON COLUMN lbs_units.plan_po_date IS
  'Plan PO receipt — วันที่คาดว่าจะได้รับ PO จากลูกค้า (แผนฝั่งขาย) · คนละตัวกับ plan_po_receipt_date ที่เป็น ETA to WH แบบกรอกเอง';

-- ---------- 1) rpc_update_unit_plan: + p_plan_po_date ----------
-- ⚠️ DROP signature ของ 0051/0052 (9 args) ก่อน recreate เป็น 10 args — กัน PGRST203 ambiguous (§9.8)
DROP FUNCTION IF EXISTS rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT);

CREATE OR REPLACE FUNCTION rpc_update_unit_plan(
  p_unit_id         UUID,
  p_unit_cost       NUMERIC DEFAULT NULL,
  p_customer_name   TEXT    DEFAULT NULL,
  p_contact_phone   TEXT    DEFAULT NULL,
  p_install_location TEXT   DEFAULT NULL,
  p_plan_po_receipt DATE    DEFAULT NULL,   -- = ETA to WH แบบกรอกเอง (ชื่อพารามิเตอร์เดิม คงไว้ไม่ให้ client เก่าพัง)
  p_plan_delivery   DATE    DEFAULT NULL,
  p_fob_date        DATE    DEFAULT NULL,
  p_lead_days       INT     DEFAULT NULL,
  p_plan_po_date    DATE    DEFAULT NULL    -- = Plan PO receipt (วันรับ PO จากลูกค้า) — ของใหม่ 0053
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks; v_eta DATE; v_lead INT;
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
    ' ฿ · Customer(แผน) ' || COALESCE(p_customer_name, '-') ||
    ' · Plan PO receipt ' || COALESCE(p_plan_po_date::TEXT, '-') ||
    ' · FOB ' || COALESCE(p_fob_date::TEXT, '-') || ' +' || COALESCE(v_lead, 60) || ' วัน' ||
    ' · ETA to WH ' || COALESCE(v_eta::TEXT, '-') ||
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-'));
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT, DATE) TO authenticated;

-- ---------- 2) Import Excel: รับ key 'plan_po' (patch ฟังก์ชันเดิม) ----------
-- signature เดิม (jsonb) — เติม key ใหม่ได้เลย · patch เฉพาะบรรทัดที่เกี่ยว ไม่ recreate ทั้งก้อน
-- (rpc_import_units_to_stock ถูก 0052 patch มาแล้ว — recreate จากไฟล์เก่าจะ revert งาน 0052)
DO $$
DECLARE def TEXT; foid OID;
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid) INTO foid, def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rpc_import_units_to_stock';
  IF foid IS NULL THEN RAISE EXCEPTION '0053: ไม่พบ rpc_import_units_to_stock — ต้องรัน 0051/0052 ก่อน'; END IF;

  IF position('plan_po_date' IN def) > 0 THEN
    RAISE NOTICE '0053: rpc_import_units_to_stock รองรับ plan_po อยู่แล้ว ข้าม';
  ELSE
    -- ⚠️ ทุก pattern ต้องอยู่ "บรรทัดเดียว" — body ใน DB มี CRLF (ไฟล์ repo เป็น CRLF บน Windows)
    --    pattern ที่คร่อมบรรทัดจะ match ไม่เจอ (บทเรียน §9.6)
    DECLARE
      a_decl   CONSTANT TEXT := 'v_fob DATE; v_lead INT;';
      a_read   CONSTANT TEXT := ':= NULLIF(btrim(COALESCE(u->>''location'', '''')), '''');';
      a_skip   CONSTANT TEXT := 'CONTINUE WHEN c IS NULL AND v_cust IS NULL AND v_phone IS NULL AND v_loc IS NULL';
      a_upd    CONSTANT TEXT := 'plan_install_location = CASE WHEN job_id IS NULL THEN COALESCE(v_loc, plan_install_location) ELSE plan_install_location END,';
      a_cols   CONSTANT TEXT := 'plan_customer_name, plan_contact_phone, plan_install_location,';
      a_vals   CONSTANT TEXT := 'NULLIF(btrim(COALESCE(u->>''location'', '''')), ''''),';
    BEGIN
      IF position(a_decl IN def) = 0 OR position(a_read IN def) = 0 OR position(a_skip IN def) = 0
         OR position(a_upd IN def) = 0 OR position(a_cols IN def) = 0 OR position(a_vals IN def) = 0 THEN
        RAISE EXCEPTION '0053: body ของ rpc_import_units_to_stock ต่างจากที่คาด — ตรวจด้วย pg_get_functiondef ก่อนแก้มือ';
      END IF;

      -- (ก) ประกาศตัวแปรใหม่
      def := replace(def, a_decl, a_decl || ' v_ppo DATE;');
      -- (ข) อ่านค่าจาก payload (ต่อท้ายบรรทัดเดียวกับ location)
      def := replace(def, a_read, a_read || ' v_ppo := NULLIF(btrim(COALESCE(u->>''plan_po'', '''')), '''')::DATE;');
      -- (ค) แถวที่ไม่ได้กรอกอะไรเลย ต้องนับ v_ppo ด้วย
      def := replace(def, a_skip, a_skip || ' AND v_ppo IS NULL');
      -- (ง) ขา UPDATE — กติกาเดียวกับ Customer/Contact/Location (เขียนเฉพาะเครื่องที่ยังไม่ผูก Job)
      def := replace(def, a_upd, a_upd ||
        ' plan_po_date = CASE WHEN job_id IS NULL THEN COALESCE(v_ppo, plan_po_date) ELSE plan_po_date END,');
      -- (จ) ขา INSERT — คอลัมน์ + ค่า ต้องเพิ่มตำแหน่งเดียวกัน (ถัดจาก plan_install_location / location)
      def := replace(def, a_cols, a_cols || ' plan_po_date,');
      def := replace(def, a_vals, a_vals || ' NULLIF(btrim(COALESCE(u->>''plan_po'', '''')), '''')::DATE,');

      EXECUTE def;
    END;
    RAISE NOTICE '0053: rpc_import_units_to_stock รับคอลัมน์ Plan PO receipt แล้ว';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '0053 OK — Plan PO receipt (plan_po_date) รายเครื่อง พร้อมใช้งาน'; END $$;
