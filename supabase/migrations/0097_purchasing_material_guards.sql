-- =============================================================================
-- 0097 — ด่านข้อมูลจัดซื้อ/คลังวัสดุ (2026-11-23 · เฟส 4)
--
-- ① PR แตกหลาย PO: ยกเลิก PO ใบหนึ่งต้องไม่ทำให้ PR กลับ "รอออก PO" ถ้ายังมี PO ใบอื่นที่ไม่ถูกยกเลิก
--    ปัญหาเดิม (rpc_cancel_po · 0022): PR กลับ pending เมื่อไม่เหลือบรรทัด po_ordered — ไม่ดูบรรทัดที่รับของแล้ว
--      PR บรรทัด A (PO1 รับครบ) + B (PO2) → ยกเลิก PO2 → PR = pending → ปุ่มตีกลับ/แก้เลข PR กลับมา
--      → rpc_reject_pr ผ่าน (เช็คแค่ status) ⇒ บรรทัด A ที่รับของแล้วชี้ไปที่ PR ที่ถูกตีกลับ
--    แก้: trigger BEFORE UPDATE บน purchase_requisitions
--      • po_issued → pending ขณะยังมี PO ไม่ถูกยกเลิก = คงเป็น po_issued (rpc_cancel_po อัปเดต PO เป็น cancelled ก่อน)
--      • → rejected ขณะยังมี PO ไม่ถูกยกเลิก = RAISE (ด่านซ้อนกันสถานะเพี้ยน)
--      (ยกเลิก Job → cancelled ไม่ถูกกัน — ทางนั้นยกเลิก PO ทั้งหมดอยู่แล้ว)
-- ② ลบวัสดุ (rpc_delete_item): ใช้ใน BOM มาตรฐาน / มีประวัติเคลื่อนไหวคลัง = ลบไม่ได้
--      เดิม: BOM → FK error ดิบ · ประวัติ → ON DELETE CASCADE ลบบัญชีคลังทิ้งทั้งหมด (0038)
--    แก้: trigger BEFORE DELETE บน items (ข้อความอ่านรู้เรื่อง · ครอบทุกทางที่ลบ)
-- ③ คลังคงเหลือไม่ใช่ที่ของ LBS หลัก — rpc_import_stock_count จับคู่ได้ทุก item ⇒ แถวที่ใส่รหัส LBS
--      สร้าง accessory_stock + ตั้ง LBS เป็น is_stockable_centrally
--    แก้: trigger BEFORE INSERT บน accessory_stock (item_type = main_equipment → RAISE · rollback ทั้งชุด)
--
-- mirror: logic.ts cancelPO / rejectPR / deleteItem / importStockCount · materialImport.ts parseCountRows
-- รันซ้ำได้ · ไม่แตะข้อมูล · ท้ายไฟล์แจ้ง (NOTICE) ข้อมูลเก่าที่เข้าข่าย ให้ตรวจเอง
-- =============================================================================

-- ---------- ① สถานะ PR ----------
CREATE OR REPLACE FUNCTION app_pr_status_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE live INT;
BEGIN
  IF NEW.status IN ('pending', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT count(*) INTO live FROM purchase_orders WHERE pr_id = NEW.id AND status <> 'cancelled';
    IF live > 0 THEN
      IF NEW.status = 'pending' AND OLD.status = 'po_issued' THEN
        NEW.status := 'po_issued';      -- ยังมี PO ใบอื่นอยู่ (เช่นรับของครบแล้ว) — PR ยังเป็น "ออก PO แล้ว"
      ELSIF NEW.status = 'rejected' THEN
        RAISE EXCEPTION '% มี PO ที่ยังไม่ถูกยกเลิก — ตีกลับไม่ได้ (ยกเลิก PO ก่อน หรือแก้จำนวนบรรทัดแทน)', NEW.pr_no;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_pr_status_guard() FROM PUBLIC, anon, authenticated;   -- กติกา 0091

DROP TRIGGER IF EXISTS trg_pr_status_guard ON purchase_requisitions;
CREATE TRIGGER trg_pr_status_guard BEFORE UPDATE OF status ON purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION app_pr_status_guard();

-- ---------- ② ลบวัสดุ ----------
CREATE OR REPLACE FUNCTION app_item_delete_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM std_bom_lines WHERE item_id = OLD.id) THEN
    RAISE EXCEPTION '% อยู่ใน BOM มาตรฐาน ลบไม่ได้ — เอาออกจาก BOM ที่หน้า Standards Library ก่อน', OLD.name;
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE item_id = OLD.id) THEN
    RAISE EXCEPTION '% มีประวัติเคลื่อนไหวคลังแล้ว ลบไม่ได้ (คงหลักฐานบัญชีคลัง) — ตั้งเป็น "สั่งซื้อเท่านั้น" แทนถ้าเลิกใช้', OLD.name;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app_item_delete_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_item_delete_guard ON items;
CREATE TRIGGER trg_item_delete_guard BEFORE DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION app_item_delete_guard();

-- ---------- ③ คลังคงเหลือไม่รับ LBS หลัก ----------
CREATE OR REPLACE FUNCTION app_accessory_stock_lbs_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE it items;
BEGIN
  SELECT * INTO it FROM items WHERE id = NEW.item_id;
  IF it.item_type = 'main_equipment' THEN
    RAISE EXCEPTION '% เป็น LBS หลัก — ไม่ใช่วัสดุคลังคงเหลือ (นับที่ LBS Inventory)', it.name;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_accessory_stock_lbs_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_accessory_stock_lbs_guard ON accessory_stock;
CREATE TRIGGER trg_accessory_stock_lbs_guard BEFORE INSERT ON accessory_stock
  FOR EACH ROW EXECUTE FUNCTION app_accessory_stock_lbs_guard();

-- ---------- ตรวจผล + แจ้งข้อมูลเก่าที่เข้าข่าย ----------
DO $$
DECLARE n INT; bad TEXT;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname IN ('trg_pr_status_guard', 'trg_item_delete_guard', 'trg_accessory_stock_lbs_guard') AND NOT tgisinternal;
  IF n <> 3 THEN RAISE EXCEPTION '0097: trigger ไม่ครบ (เจอ %/3)', n; END IF;

  SELECT string_agg(f, ', ') INTO bad FROM unnest(ARRAY[
    'public.app_pr_status_guard()', 'public.app_item_delete_guard()', 'public.app_accessory_stock_lbs_guard()']) f
   WHERE has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0097: ฟังก์ชันภายในถูกเรียกตรงได้: %', bad; END IF;

  -- ข้อมูลเก่า (ไม่แก้ให้ — แจ้งให้ตรวจ)
  SELECT string_agg(pr.pr_no, ', ') INTO bad FROM purchase_requisitions pr
   WHERE pr.status IN ('pending', 'rejected')
     AND EXISTS (SELECT 1 FROM purchase_orders po WHERE po.pr_id = pr.id AND po.status <> 'cancelled');
  IF bad IS NOT NULL THEN RAISE NOTICE '0097: PR ที่สถานะ pending/rejected แต่ยังมี PO อยู่ (ตรวจเอง): %', bad; END IF;
  SELECT string_agg(i.code, ', ') INTO bad FROM accessory_stock s JOIN items i ON i.id = s.item_id
   WHERE i.item_type = 'main_equipment';
  IF bad IS NOT NULL THEN RAISE NOTICE '0097: มีแถวคลังคงเหลือของ LBS หลัก (ตรวจเอง): %', bad; END IF;

  RAISE NOTICE '0097: ตรวจผ่าน';
END $$;
