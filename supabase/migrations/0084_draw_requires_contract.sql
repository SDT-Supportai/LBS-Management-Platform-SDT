-- =============================================================================
-- 0084 — 📄 ดึง LBS เข้า Job ได้เฉพาะเครื่องที่มี Contract No. แล้ว (2026-10-12)
--
-- ที่มา (ผู้ใช้ขอ 2026-10-12): popup "ดึง LBS เข้า Job" แสดงเฉพาะเครื่องที่มีสัญญา
--   แล้วให้ฐานข้อมูลปฏิเสธเครื่องที่ไม่มีสัญญาด้วย — ไม่ใช่แค่ซ่อนที่หน้าจอ
--
-- ทำเป็น trigger บน lbs_units แทนการ patch body ของ rpc_draw_lbs เพราะ
--   (1) ไม่ต้องคัด body เดิมทั้งดุ้น (เสี่ยง revert การย่อข้อความของ 0031) และไม่เจอปัญหา CRLF ของ app_swap_guard
--   (2) กันทุกทางที่ "ดึงเครื่องจากคลังเข้า Job" รวม RPC ที่จะเพิ่มในอนาคต
--
-- เงื่อนไข: เฉพาะ transition in_stock → allocated (= การดึงเข้า Job) เท่านั้น
--   ⚠️ ไม่แตะ issued → allocated (ย้อนการเบิก/เปิด Job ใหม่) — เครื่องเก่าที่ผูก Job ก่อนกติกานี้ต้องเดินต่อได้
--   ⚠️ ไม่แตะการสลับ Serial (app_exec_swap_lbs) — สลับแค่เลข ไม่เปลี่ยน status
--   ⚠️ ไม่ย้อนตรวจเครื่องที่ผูก Job ไปแล้ว — มีผลกับการดึงครั้งถัดไปเท่านั้น
--
-- demo sync ที่ src/data/logic.ts (drawLbs) + seed ที่ให้เลขสัญญาก่อนดึง · idempotent
-- ไม่เปลี่ยน signature · **รันก่อน push** (หลัง push หน้าจอกรองให้อยู่แล้ว แต่ DB ยังไม่บังคับจนกว่าจะรัน)
-- =============================================================================

CREATE OR REPLACE FUNCTION app_block_draw_without_contract() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = 'in_stock' AND NEW.status = 'allocated'
     AND NULLIF(btrim(COALESCE(NEW.contract_no, '')), '') IS NULL THEN
    RAISE EXCEPTION 'ดึงได้เฉพาะเครื่องที่มี Contract No. แล้ว — % ยังไม่มีสัญญา (กรอกที่ LBS Inventory → แก้ข้อมูล)',
      NEW.serial_lvb;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION app_block_draw_without_contract() IS
  '0084 — กันดึงเครื่องที่ยังไม่มี contract_no เข้า Job (เฉพาะ in_stock → allocated)';

DROP TRIGGER IF EXISTS trg_draw_requires_contract ON lbs_units;
CREATE TRIGGER trg_draw_requires_contract
  BEFORE UPDATE OF status ON lbs_units
  FOR EACH ROW EXECUTE FUNCTION app_block_draw_without_contract();

-- ---------- ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE u lbs_units; ok BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_draw_requires_contract' AND tgrelid = 'lbs_units'::regclass
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0084: trigger trg_draw_requires_contract ไม่ได้ติดตั้ง/ถูกปิดอยู่';
  END IF;

  -- ลองดึงเครื่องไม่มีสัญญาจริง 1 เครื่อง (ถ้ามี) แล้วย้อนทิ้ง — ต้องโดนปฏิเสธ
  SELECT * INTO u FROM lbs_units
   WHERE status = 'in_stock' AND NULLIF(btrim(COALESCE(contract_no, '')), '') IS NULL LIMIT 1;
  IF u.id IS NOT NULL THEN
    ok := false;
    BEGIN
      UPDATE lbs_units SET status = 'allocated' WHERE id = u.id;
    EXCEPTION WHEN raise_exception THEN
      ok := position('Contract No.' IN SQLERRM) > 0;
    END;
    IF NOT ok THEN
      -- ถ้าหลุดมาถึงนี่ได้ แปลว่า UPDATE ผ่าน — RAISE ทำให้ทั้ง migration ย้อนกลับ แถวนั้นจึงไม่ค้างเป็น allocated
      RAISE EXCEPTION '0084: ดึงเครื่องไม่มีสัญญา (%) ผ่านได้ — trigger ไม่ทำงาน', u.serial_lvb;
    END IF;
  ELSE
    RAISE NOTICE '0084: ไม่มีเครื่องในคลังที่ยังไม่มีสัญญาให้ลอง — ข้ามการทดสอบจริง';
  END IF;

  RAISE NOTICE '0084: OK — ดึง LBS เข้า Job ได้เฉพาะเครื่องที่มี Contract No. · ย้อนการเบิก/สลับ Serial ไม่กระทบ';
END $$;
