-- =====================================================================
-- 0038: คลังคงเหลือ — Stock Movement ledger + ต้นทุนถัวเฉลี่ย + โอนวัสดุจาก Job (เฟส S1) (2026-07-30)
--  ปัญหาเดิม:
--   1) accessory_stock เก็บแค่ "ยอดสุทธิ" ไม่มีประวัติว่าเข้า/ออกเพราะอะไร → ตรวจยอดย้อนหลังไม่ได้
--   2) วัสดุเหลือจาก Job อื่น เอาเข้าคลังไม่ได้ ยกเว้นยกเลิก Job ทั้งใบ หรือปรับยอดมือ
--      (ปรับยอดมือ = ของงอกจากอากาศ · ต้นทุนค้างที่ Job เดิม)
--   3) เบิกจากคลังเข้า Job ใช้ราคาที่คนกรอก ไม่ผูกกับต้นทุนจริงของของในคลัง
--
--  วิธีที่เลือก — TRIGGER ไม่ใช่การ patch ทุก RPC:
--   accessory_stock ถูกเขียนจาก 6 RPC (add_accessory_request, return_accessory, cancel_job,
--   create_item, update_item, adjust_stock) กระจายใน 0002/0006/0015/0016/0017
--   การ patch ทุกจุดด้วย string replace เสี่ยงพลาดสูง →
--   ใช้ BEFORE trigger บน accessory_stock แทน: ยอดเปลี่ยนที่ไหนก็ลง ledger เสมอ **bypass ไม่ได้**
--   + คำนวณ moving average ให้ในตัว
--   ส่วน "บริบท" (ประเภท/Job/หมายเหตุ) ใช้ transaction-local config ที่ RPC ตั้งก่อน UPDATE
--   ถ้าไม่ได้ตั้ง → บันทึกเป็น 'adjust' (ยังได้ยอดครบ ไม่มีรูรั่ว)
--
--  demo sync ที่ src/data/logic.ts (applyStockMovement / transferJobMaterialToStock / effectiveQty)
--  รันหลัง 0037 · idempotent
-- =====================================================================

-- ---------- 1) schema ----------
ALTER TABLE accessory_stock ADD COLUMN IF NOT EXISTS avg_unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE job_accessory_requests ADD COLUMN IF NOT EXISTS qty_transferred NUMERIC(14,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS stock_movements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty            NUMERIC(14,2) NOT NULL CHECK (qty <> 0),   -- + เข้า / − ออก
  unit_cost      NUMERIC(14,2),
  balance_after  NUMERIC(14,2) NOT NULL,
  movement_type  TEXT NOT NULL CHECK (movement_type IN
                   ('initial','adjust','import_adjust','issue_to_job','return_from_job',
                    'transfer_from_job','job_cancelled')),
  ref_job_id     UUID REFERENCES jobs(id) ON DELETE SET NULL,
  ref_request_id UUID REFERENCES job_accessory_requests(id) ON DELETE SET NULL,
  note           TEXT,
  performed_by   UUID REFERENCES profiles(id),
  performed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_item_idx ON stock_movements (item_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_job_idx  ON stock_movements (ref_job_id);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON stock_movements;
CREATE POLICY read_all ON stock_movements FOR SELECT TO authenticated USING (true);

-- ---------- 2) บริบทของการเคลื่อนไหว (transaction-local) ----------
-- RPC เรียกก่อน UPDATE accessory_stock เพื่อบอก trigger ว่าเป็นการเคลื่อนไหวประเภทใด
CREATE OR REPLACE FUNCTION app_set_stock_ctx(
  p_type TEXT, p_job_id UUID, p_request_id UUID, p_note TEXT, p_unit_cost NUMERIC
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.stock_type', COALESCE(p_type, ''), true);
  PERFORM set_config('app.stock_job',  COALESCE(p_job_id::TEXT, ''), true);
  PERFORM set_config('app.stock_req',  COALESCE(p_request_id::TEXT, ''), true);
  PERFORM set_config('app.stock_note', COALESCE(p_note, ''), true);
  PERFORM set_config('app.stock_cost', COALESCE(p_unit_cost::TEXT, ''), true);
END $$;

-- ---------- 3) trigger: ลง ledger + คิดต้นทุนถัวเฉลี่ย ----------
-- moving average ขยับเฉพาะขาเข้าที่มี unit_cost · ขาออกไม่กระทบ · ของหมด → รีเซ็ตเป็น 0
CREATE OR REPLACE FUNCTION fn_log_stock_movement() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d NUMERIC; old_qty NUMERIC; old_avg NUMERIC; uc NUMERIC; t TEXT; actor_id UUID;
BEGIN
  old_qty := COALESCE(OLD.qty_on_hand, 0);
  old_avg := COALESCE(OLD.avg_unit_cost, 0);
  d := NEW.qty_on_hand - old_qty;
  IF d = 0 THEN RETURN NEW; END IF;
  IF NEW.qty_on_hand < 0 THEN RAISE EXCEPTION 'ยอดคลังคงเหลือติดลบไม่ได้'; END IF;

  uc := NULLIF(current_setting('app.stock_cost', true), '')::NUMERIC;
  t  := NULLIF(current_setting('app.stock_type', true), '');
  IF t IS NULL THEN t := 'adjust'; END IF;   -- ไม่ได้ตั้งบริบท = ปรับยอด (ยังได้ยอดครบ)

  -- ต้นทุนถัวเฉลี่ย
  IF d > 0 AND uc IS NOT NULL AND uc >= 0 THEN
    NEW.avg_unit_cost := CASE WHEN NEW.qty_on_hand > 0
      THEN (old_qty * old_avg + d * uc) / NEW.qty_on_hand ELSE uc END;
  ELSE
    NEW.avg_unit_cost := old_avg;
  END IF;
  IF NEW.qty_on_hand = 0 THEN NEW.avg_unit_cost := 0; END IF;

  BEGIN actor_id := auth.uid(); EXCEPTION WHEN OTHERS THEN actor_id := NULL; END;

  INSERT INTO stock_movements (item_id, qty, unit_cost, balance_after, movement_type,
    ref_job_id, ref_request_id, note, performed_by)
  VALUES (NEW.item_id, d,
    CASE WHEN d > 0 THEN uc ELSE NULLIF(old_avg, 0) END,
    NEW.qty_on_hand, t,
    NULLIF(current_setting('app.stock_job', true), '')::UUID,
    NULLIF(current_setting('app.stock_req', true), '')::UUID,
    NULLIF(current_setting('app.stock_note', true), ''),
    actor_id);

  -- ล้างบริบท กันรั่วไปรายการถัดไปใน transaction เดียวกัน
  PERFORM app_set_stock_ctx(NULL, NULL, NULL, NULL, NULL);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_log_stock_movement ON accessory_stock;
CREATE TRIGGER trg_log_stock_movement
BEFORE INSERT OR UPDATE OF qty_on_hand ON accessory_stock
FOR EACH ROW EXECUTE FUNCTION fn_log_stock_movement();

-- ---------- 4) โอนวัสดุเหลือจาก Job เข้าคลังคงเหลือ ----------
CREATE OR REPLACE FUNCTION rpc_transfer_job_material_to_stock(
  p_request_id UUID, p_qty NUMERIC, p_note TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; it items; j jobs; remain NUMERIC; val NUMERIC; nt TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  SELECT * INTO j FROM jobs WHERE id = r.job_id FOR UPDATE;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว — ของถูกคืนเข้าคลังตอนยกเลิกอยู่แล้ว', j.job_no;
  END IF;
  IF r.status NOT IN ('issued', 'received') THEN
    RAISE EXCEPTION 'โอนเข้าคลังได้เฉพาะวัสดุที่เบิกจากคลังแล้ว หรือรับของจาก PO ครบแล้ว';
  END IF;

  remain := r.qty_requested - COALESCE(r.qty_transferred, 0);
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'จำนวนที่โอนต้องมากกว่า 0'; END IF;
  IF p_qty > remain THEN RAISE EXCEPTION 'โอนได้ไม่เกิน % % (คงอยู่ที่ Job)', remain, it.uom; END IF;

  UPDATE job_accessory_requests
     SET qty_transferred = COALESCE(qty_transferred, 0) + p_qty, updated_at = now()
   WHERE id = p_request_id;

  -- ของมาอยู่ในคลังจริงแล้ว เปิดเก็บสต็อกกลางให้อัตโนมัติ
  UPDATE items SET is_stockable_centrally = true
   WHERE id = r.item_id AND is_stockable_centrally = false;

  nt := COALESCE(NULLIF(btrim(p_note), ''), 'โอนวัสดุเหลือจาก ' || j.job_no);
  PERFORM app_set_stock_ctx('transfer_from_job', r.job_id, r.id, nt, r.unit_price);
  INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost)
  VALUES (r.item_id, p_qty, COALESCE(r.unit_price, 0))
  ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand,
                                      updated_at = now();

  val := COALESCE(r.unit_price, 0) * p_qty;
  PERFORM app_notify('stock_transfer_in',
    '📦 ' || j.job_no || ' โอน ' || it.name || ' ' || p_qty || ' ' || it.uom ||
    ' เข้าคลังคงเหลือ (ตัดต้นทุนออก ' || round(val, 2) || ' ฿)', 'project', r.job_id);
  PERFORM app_audit('accessory_stock', r.item_id, 'transfer_to_stock', actor.id,
    j.job_no || ' โอน ' || it.name || ' ' || p_qty || ' ' || it.uom || ' เข้าคลังคงเหลือ (ต้นทุนที่ตัดออกจาก Job ' ||
    round(val, 2) || ' บาท)' || COALESCE(' — ' || NULLIF(btrim(p_note), ''), ''));
END $$;

-- ---------- 5) ใส่บริบทให้ RPC เดิม (best-effort — ถ้าไม่ตรงก็ไม่ล้ม เพราะ trigger รับประกันยอดอยู่แล้ว) ----------
DO $$
BEGIN
  BEGIN
    PERFORM app_swap_guard('rpc_add_accessory_request',
      '    UPDATE accessory_stock SET qty_on_hand = qty_on_hand - p_qty, updated_at = now()',
      '    PERFORM app_set_stock_ctx(''issue_to_job'', p_job_id, NULL, ''เบิกเข้า '' || j.job_no, NULL);' || E'\n' ||
      '    UPDATE accessory_stock SET qty_on_hand = qty_on_hand - p_qty, updated_at = now()');
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'ข้าม ctx rpc_add_accessory_request: %', SQLERRM; END;

  BEGIN
    PERFORM app_swap_guard('rpc_return_accessory',
      '  UPDATE accessory_stock SET qty_on_hand = qty_on_hand + r.qty_requested, updated_at = now() WHERE item_id = r.item_id;',
      '  PERFORM app_set_stock_ctx(''return_from_job'', r.job_id, r.id, ''คืนจาก '' || j.job_no, r.unit_price);' || E'\n' ||
      '  UPDATE accessory_stock SET qty_on_hand = qty_on_hand + (r.qty_requested - COALESCE(r.qty_transferred,0)), updated_at = now() WHERE item_id = r.item_id;');
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'ข้าม ctx rpc_return_accessory: %', SQLERRM; END;
END $$;

-- ---------- 6) backfill: ยอดตั้งต้นให้ ledger ตรงกับยอดปัจจุบัน ----------
INSERT INTO stock_movements (item_id, qty, balance_after, movement_type, note, performed_at)
SELECT s.item_id, s.qty_on_hand, s.qty_on_hand, 'initial',
       'backfill 0038: ยอดตั้งต้นก่อนเริ่มใช้ ledger', now()
FROM accessory_stock s
WHERE s.qty_on_hand > 0
  AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.item_id = s.item_id);

-- ---------- 7) สิทธิ์ + Realtime ----------
GRANT EXECUTE ON FUNCTION public.rpc_transfer_job_material_to_stock(UUID, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_set_stock_ctx(TEXT, UUID, UUID, TEXT, NUMERIC) TO authenticated;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE stock_movements;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN RAISE NOTICE '0038 OK — stock ledger + moving average + โอนวัสดุจาก Job พร้อมใช้งาน'; END $$;
