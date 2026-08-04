-- =====================================================================
-- 0043: ข้อมูลแผนรายเครื่องในคลัง LBS + แก้ต้นทุน/เครื่องรายแถว (2026-08-04)
--  ที่มา: ตารางรายเครื่องต้องมี Plan PO receipt / Plan Delivery / Actual Delivery
--    และ Division ต้องกรอก Serial / ต้นทุน / ลูกค้า / สถานที่ได้จากตารางนี้ตรงๆ
--  ⚠️ ข้อมูลลูกค้า — 0014 ตั้งกฎว่า "ref จาก Job เท่านั้น" (single source of truth)
--     0043 ไม่ย้อนกฎนั้น: คอลัมน์ใหม่ตั้งชื่อ plan_* = **ข้อมูลแผนก่อนผูก Job**
--     (เครื่องในคลังที่ยังไม่มี Job เดิมโชว์ '-' ทั้งแถว = Division วางแผนไม่ได้เลย)
--     กติกาแสดงผล: มี Job แล้ว → ค่าจาก Job ชนะ · plan_* แสดงเป็นบรรทัดเล็กด้านล่าง
--  มติ (2026-08-04):
--    - Plan PO receipt / Plan Delivery = DATE (กดปฏิทิน) เก็บรายเครื่อง (ของ PO เดียวมาไม่พร้อมกันได้)
--    - Actual Delivery + สถานะ = auto ไม่เก็บคอลัมน์: derive จาก unit_installations (0035) ตอนแสดง
--      → ไม่มีข้อมูลซ้ำ ไม่ต้อง backfill และ reopen (0041) ก็สะท้อนเองอัตโนมัติ
--  ⚠️ แก้ได้เฉพาะเครื่องที่ยังไม่ถูกเบิก (status <> 'issued') เพราะ trigger trg_block_issued_edit
--     (0001) บล็อก UPDATE lbs_units ทุกคอลัมน์เมื่อ Job = issued/installed
--     — เหตุผลเดียวกับที่ 0035 ต้องแยกตาราง unit_installations ออกไป
--  สิทธิ์: Division (sales) + Manage (admin auto) ตาม stock.manage เดิม
--  demo sync ที่ src/data/logic.ts (updateUnitPlan) · รันหลัง 0042 · idempotent
-- =====================================================================

-- ---------- 1) schema ----------
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS plan_customer_name    VARCHAR(255);
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS plan_contact_phone    VARCHAR(50);
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS plan_install_location TEXT;
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS plan_po_receipt_date  DATE;
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS plan_delivery_date    DATE;

-- ---------- 2) แก้ข้อมูลรายเครื่อง (ไม่รวม Serial — ใช้ rpc_update_unit_info เดิมที่มี guard unique) ----------
-- ⚠️ ฟอร์มส่งค่าครบทุกช่องทุกครั้ง → NULL = "ล้างค่า" ไม่ใช่ "ไม่เปลี่ยน"
CREATE OR REPLACE FUNCTION rpc_update_unit_plan(
  p_unit_id         UUID,
  p_unit_cost       NUMERIC DEFAULT NULL,
  p_customer_name   TEXT    DEFAULT NULL,
  p_contact_phone   TEXT    DEFAULT NULL,
  p_install_location TEXT   DEFAULT NULL,
  p_plan_po_receipt DATE    DEFAULT NULL,
  p_plan_delivery   DATE    DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks;
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

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;

  UPDATE lbs_units SET
    unit_cost             = p_unit_cost,
    plan_customer_name    = NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
    plan_contact_phone    = NULLIF(btrim(COALESCE(p_contact_phone, '')), ''),
    plan_install_location = NULLIF(btrim(COALESCE(p_install_location, '')), ''),
    plan_po_receipt_date  = p_plan_po_receipt,
    plan_delivery_date    = p_plan_delivery,
    updated_at            = now()
  WHERE id = p_unit_id;

  PERFORM app_audit('lbs_unit', p_unit_id, 'update_unit_plan', actor.id,
    COALESCE(s.stock_no, '') || ' · ' || u.serial_lvb || '/' || COALESCE(u.serial_om, '-') ||
    ' → ต้นทุน ' || COALESCE(round(p_unit_cost, 2)::TEXT, '-') ||
    ' ฿ · ลูกค้า(แผน) ' || COALESCE(p_customer_name, '-') ||
    ' · Plan PO receipt ' || COALESCE(p_plan_po_receipt::TEXT, '-') ||
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-'));
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0043 OK — ข้อมูลแผนรายเครื่อง (ลูกค้า/Plan PO receipt/Plan Delivery) + แก้ต้นทุนรายแถว พร้อมใช้งาน'; END $$;
