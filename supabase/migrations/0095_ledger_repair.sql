-- =============================================================================
-- 0095 — 🧹 เครื่องมือซ่อมประวัติคลังที่บันทึกซ้ำจากบั๊กก่อน 0092 (2026-11-23)
--
-- ⚠️ ไฟล์นี้ "ไม่แก้ข้อมูล" — สร้างแค่ตารางสำรอง + ฟังก์ชัน 3 ตัว ให้เรียกเองทีละขั้น:
--     ① ดูก่อน (อ่านอย่างเดียว):  SELECT * FROM app_ledger_repair_preview();
--     ② ซ่อมจริง (หลังตรวจ ①):    SELECT app_ledger_repair_apply();
--     ③ ย้อนการซ่อม (ถ้าต้องการ): SELECT app_ledger_repair_undo();
--   ทั้ง 3 ตัวเรียกได้จาก SQL Editor (postgres) เท่านั้น — ผู้ใช้ในแอปเรียกไม่ได้
--
-- ที่มา: หลังรัน 0092 พบวัสดุ 100+ รายการที่ผลรวมประวัติ (stock_movements) ≠ ยอดคลัง
--   ยอดคลังจริง (accessory_stock.qty_on_hand) ถูกต้อง — ที่ผิดคือประวัติมีแถว "ผี" เกิน
--
-- กลไกบั๊กเดิม: trigger BEFORE INSERT OR UPDATE + INSERT … ON CONFLICT DO UPDATE
--   PostgreSQL ยิง BEFORE INSERT กับ "แถวที่เสนอ" ก่อนรู้ว่าชน → trigger มองว่าคลังเดิม = 0
--   ⇒ แถวผี: qty = balance_after = ยอดในแถวที่เสนอ · ได้บริบท (ประเภท/Job/บรรทัด/หมายเหตุ/ต้นทุน/Lot) ที่ถูก
--      แล้วล้างบริบททิ้ง → แถวจริง (จาก UPDATE) กลายเป็น 'adjust' ไม่มีหมายเหตุ/อ้างอิง/ต้นทุน
--   2 แบบ ตามคำสั่ง upsert:
--     • แบบตั้งยอด (ปรับยอด / Import ตรวจนับ): แถวผี +ยอดใหม่ทั้งก้อน · balance_after เท่ากับแถวจริง
--     • แบบบวกเพิ่ม (รับของคืน / โอนเข้าคลัง / ยกเลิก Job / ตัดจำหน่ายคืนคลัง): แถวผี +ส่วนต่าง
--       qty เท่ากับแถวจริง แต่ balance_after = ส่วนต่าง (ต่ำกว่าแถวจริง)
--   ทั้งคู่เกิดใน transaction เดียวกัน ⇒ performed_at เท่ากันเป๊ะ (now() = เวลาเริ่ม transaction)
--
-- วิธีจับคู่ (app_ledger_phantoms): ในกลุ่ม วัสดุ+เวลาเดียวกัน
--   แถวผี  = qty = balance_after > 0
--   แถวจริง = 'adjust' ไม่มีหมายเหตุ/อ้างอิง (ถูกล้างบริบท) และ balance_after เท่ากัน
--             หรือ qty เท่ากันแต่ balance_after สูงกว่า · จับคู่ 1:1 (กลุ่มมีหลายคู่ก็ไม่ซ้อน)
--   แถวผีเดี่ยว = ไม่มีคู่ และยอดก่อนหน้า = balance_after (ยอดไม่เปลี่ยนจริง)
--
-- การซ่อม (apply) — เฉพาะวัสดุที่ "ตัดแถวผีแล้วผลรวม = ยอดคลังพอดี" (ที่เหลือไม่แตะ ให้ตรวจเอง):
--   1) สำรองทุกแถวที่จะลบ/แก้ ลง stock_movements_repair_0095
--   2) แถวจริงรับข้อมูลที่ถูกจากแถวผี: ประเภท · Job/บรรทัด · หมายเหตุ · ต้นทุน (ขาเข้า) · Lot
--   3) การย้อนรายการ (reversal_of) ที่ชี้แถวผี → ชี้แถวจริง (ปุ่ม "ย้อน" ใช้ต่อได้)
--   4) ลบแถวผี  5) ตรวจผล ไม่ตรงแม้แต่ตัวเดียว = RAISE ยกเลิกทั้งหมด
-- ไม่แตะ: ยอดคลัง · ต้นทุนเฉลี่ยปัจจุบัน · Lot ปัจจุบันของคลัง
--   (ต้นทุนเฉลี่ยในอดีตที่บั๊กไม่ได้นำต้นทุนของคืนมาเฉลี่ย ย้อนคำนวณไม่ได้ — ใช้ Import ตรวจนับตั้งต้นทุนใหม่ถ้าต้องการ)
-- รันไฟล์นี้ซ้ำได้ · apply ซ้ำได้ (รอบสองไม่มีอะไรให้ซ่อม) · ต้องรันหลัง 0092
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_movements_repair_0095 (
  LIKE stock_movements,
  repair_action TEXT NOT NULL,     -- deleted_phantom | merged_partner | repointed_reversal (ค่าก่อนแก้)
  phantom_id    UUID,              -- แถวผีที่เกี่ยวข้อง
  repaired_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE stock_movements_repair_0095 ENABLE ROW LEVEL SECURITY;   -- ไม่มี policy = ผู้ใช้ในแอปอ่าน/เขียนไม่ได้
REVOKE ALL ON stock_movements_repair_0095 FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE stock_movements_repair_0095 IS
  'สำรองก่อนซ่อมประวัติคลังซ้ำ (0095) — ย้อนได้ด้วย SELECT app_ledger_repair_undo()';

-- ---------- 1) หาแถวผี (อ่านอย่างเดียว) ----------
CREATE OR REPLACE FUNCTION app_ledger_phantoms()
RETURNS TABLE (phantom_id UUID, partner_id UUID, item UUID)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE g RECORD; p RECORD; v_partner UUID; v_used UUID[]; v_prev NUMERIC;
BEGIN
  FOR g IN
    SELECT m.item_id AS iid, m.performed_at AS ts
      FROM stock_movements m
     WHERE m.qty = m.balance_after AND m.qty > 0
     GROUP BY m.item_id, m.performed_at
  LOOP
    v_used := ARRAY[]::UUID[];
    -- แถวที่มีบริบทมาก (ประเภทจริง/อ้างอิง/หมายเหตุ) ได้เป็น "แถวผี" ก่อน — แถวผีคือแถวที่ได้บริบทไป
    FOR p IN
      SELECT m.* FROM stock_movements m
       WHERE m.item_id = g.iid AND m.performed_at = g.ts AND m.qty = m.balance_after AND m.qty > 0
       ORDER BY (m.movement_type <> 'adjust')::int + (m.ref_request_id IS NOT NULL)::int
                + (m.ref_job_id IS NOT NULL)::int + (m.note IS NOT NULL)::int DESC, m.id
    LOOP
      CONTINUE WHEN p.id = ANY (v_used);
      SELECT x.id INTO v_partner FROM stock_movements x
       WHERE x.item_id = g.iid AND x.performed_at = g.ts AND x.id <> p.id AND NOT (x.id = ANY (v_used))
         AND x.movement_type = 'adjust' AND x.note IS NULL
         AND x.ref_job_id IS NULL AND x.ref_request_id IS NULL
         AND (x.balance_after = p.balance_after OR (x.qty = p.qty AND x.balance_after > p.balance_after))
       ORDER BY (x.balance_after = p.balance_after) DESC, x.id
       LIMIT 1;
      IF v_partner IS NOT NULL THEN
        v_used := v_used || p.id || v_partner;
        phantom_id := p.id; partner_id := v_partner; item := g.iid; RETURN NEXT;
      ELSE
        SELECT x.balance_after INTO v_prev FROM stock_movements x
         WHERE x.item_id = g.iid AND x.performed_at < g.ts
         ORDER BY x.performed_at DESC, x.balance_after DESC LIMIT 1;
        IF v_prev = p.balance_after THEN
          v_used := v_used || p.id;
          phantom_id := p.id; partner_id := NULL; item := g.iid; RETURN NEXT;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ---------- 2) ดูก่อนซ่อม (อ่านอย่างเดียว) ----------
CREATE OR REPLACE FUNCTION app_ledger_repair_preview()
RETURNS TABLE (status TEXT, item_code TEXT, item_name TEXT, qty_on_hand NUMERIC,
               ledger_sum NUMERIC, phantom_rows INT, ledger_after_repair NUMERIC)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH ph AS (SELECT * FROM app_ledger_phantoms()),
  s AS (
    SELECT st.item_id, st.qty_on_hand,
           COALESCE((SELECT sum(m.qty) FROM stock_movements m WHERE m.item_id = st.item_id), 0) AS ledger_sum,
           COALESCE((SELECT sum(m.qty) FROM stock_movements m JOIN ph ON ph.phantom_id = m.id
                      WHERE m.item_id = st.item_id), 0) AS phantom_sum,
           (SELECT count(*)::int FROM ph WHERE ph.item = st.item_id) AS n_ph
      FROM accessory_stock st
  )
  SELECT CASE WHEN s.ledger_sum - s.phantom_sum = s.qty_on_hand THEN 'ซ่อมได้' ELSE 'ต้องตรวจเอง' END,
         i.code::text, i.name::text, s.qty_on_hand, s.ledger_sum, s.n_ph, s.ledger_sum - s.phantom_sum
    FROM s JOIN items i ON i.id = s.item_id
   WHERE s.ledger_sum <> s.qty_on_hand
   ORDER BY (s.ledger_sum - s.phantom_sum = s.qty_on_hand) DESC, abs(s.ledger_sum - s.qty_on_hand) DESC, i.code
$$;

-- ---------- 3) ซ่อมจริง ----------
CREATE OR REPLACE FUNCTION app_ledger_repair_apply()
RETURNS TEXT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n_items INT; n_del INT; n_merge INT; n_rev INT; n_left INT; bad INT; msg TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stock_cost_lot'
                    AND tgrelid = 'accessory_stock'::regclass) THEN
    RAISE EXCEPTION '0095: ต้องรัน 0092 ก่อน (trigger ประวัติคลังยังเป็นแบบเก่า — ซ่อมไปก็เกิดซ้ำ)';
  END IF;
  LOCK TABLE accessory_stock, stock_movements IN SHARE ROW EXCLUSIVE MODE;   -- กันมีรายการคลังแทรกระหว่างซ่อม

  DROP TABLE IF EXISTS _ph_0095;
  CREATE TEMP TABLE _ph_0095 ON COMMIT DROP AS SELECT * FROM app_ledger_phantoms();
  -- ซ่อมเฉพาะวัสดุที่ตัดแถวผีแล้วยอดตรงพอดี
  DELETE FROM _ph_0095 p
   WHERE NOT EXISTS (
     SELECT 1 FROM accessory_stock st
      WHERE st.item_id = p.item
        AND COALESCE((SELECT sum(m.qty) FROM stock_movements m WHERE m.item_id = st.item_id), 0)
          - COALESCE((SELECT sum(m.qty) FROM stock_movements m JOIN _ph_0095 q ON q.phantom_id = m.id
                       WHERE m.item_id = st.item_id), 0) = st.qty_on_hand);

  SELECT count(DISTINCT item), count(*), count(partner_id) INTO n_items, n_del, n_merge FROM _ph_0095;

  -- 1) สำรอง (ค่าก่อนแก้ทุกแถวที่จะโดน)
  INSERT INTO stock_movements_repair_0095
  SELECT sm.*, 'deleted_phantom', p.phantom_id, now() FROM stock_movements sm JOIN _ph_0095 p ON p.phantom_id = sm.id;
  INSERT INTO stock_movements_repair_0095
  SELECT sm.*, 'merged_partner', p.phantom_id, now() FROM stock_movements sm JOIN _ph_0095 p ON p.partner_id = sm.id;
  INSERT INTO stock_movements_repair_0095
  SELECT sm.*, 'repointed_reversal', p.phantom_id, now() FROM stock_movements sm JOIN _ph_0095 p ON sm.reversal_of = p.phantom_id;
  GET DIAGNOSTICS n_rev = ROW_COUNT;

  -- 2) แถวจริงรับข้อมูลที่ถูกจากแถวผี
  UPDATE stock_movements r
     SET movement_type  = ph.movement_type,
         ref_job_id     = ph.ref_job_id,
         ref_request_id = ph.ref_request_id,
         note           = COALESCE(r.note, ph.note),
         -- ขาเข้า: ต้นทุนที่ส่งมากับรายการ (แถวจริงหายไปเพราะบริบทถูกล้าง) · ขาออก: แถวจริงคิดจากเฉลี่ยถูกแล้ว
         unit_cost      = COALESCE(r.unit_cost, CASE WHEN r.qty > 0 THEN ph.unit_cost END),
         -- Lot ที่ระบุมากับของเข้าอยู่ที่แถวผี · ไม่ระบุ = แถวจริงเก็บ Lot เดิมของคลังไว้ถูกแล้ว
         lot_no         = COALESCE(ph.lot_no, r.lot_no)
    FROM _ph_0095 p JOIN stock_movements ph ON ph.id = p.phantom_id
   WHERE r.id = p.partner_id;

  -- 3) การย้อนรายการที่ชี้แถวผี → ชี้แถวจริง
  UPDATE stock_movements x SET reversal_of = p.partner_id
    FROM _ph_0095 p WHERE x.reversal_of = p.phantom_id;

  -- 4) ลบแถวผี
  DELETE FROM stock_movements sm USING _ph_0095 p WHERE sm.id = p.phantom_id;

  -- 5) ตรวจผล
  SELECT count(*) INTO bad FROM accessory_stock st
   WHERE st.item_id IN (SELECT item FROM _ph_0095)
     AND COALESCE((SELECT sum(qty) FROM stock_movements WHERE item_id = st.item_id), 0) <> st.qty_on_hand;
  IF bad > 0 THEN RAISE EXCEPTION '0095: ซ่อมแล้วยังไม่ตรง % รายการ — ยกเลิกทั้งหมด ไม่มีอะไรถูกแก้', bad; END IF;

  SELECT count(*) INTO n_left FROM accessory_stock st
   WHERE COALESCE((SELECT sum(qty) FROM stock_movements WHERE item_id = st.item_id), 0) <> st.qty_on_hand;
  msg := format('0095: ซ่อม %s วัสดุ · ลบแถวซ้ำ %s แถว · ย้ายข้อมูลเข้าแถวจริง %s แถว · ย้ายการย้อนรายการ %s แถว · ยังไม่ตรง (ต้องตรวจเอง) %s รายการ',
                n_items, n_del, n_merge, n_rev, n_left);
  RAISE NOTICE '%', msg;
  RETURN msg;
END $$;

-- ---------- 4) ย้อนการซ่อม (คืนทุกแถวจากตารางสำรอง) ----------
CREATE OR REPLACE FUNCTION app_ledger_repair_undo()
RETURNS TEXT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n_ins INT; n_upd INT; n_rev INT;
BEGIN
  LOCK TABLE accessory_stock, stock_movements IN SHARE ROW EXCLUSIVE MODE;
  -- ใส่แถวผีคืนก่อน (การย้อนรายการจะชี้กลับไปหาได้)
  INSERT INTO stock_movements (id, item_id, qty, unit_cost, balance_after, movement_type, ref_job_id,
                               ref_request_id, note, performed_by, performed_at, lot_no, reversal_of)
  SELECT b.id, b.item_id, b.qty, b.unit_cost, b.balance_after, b.movement_type, b.ref_job_id,
         b.ref_request_id, b.note, b.performed_by, b.performed_at, b.lot_no, b.reversal_of
    FROM stock_movements_repair_0095 b
   WHERE b.repair_action = 'deleted_phantom'
     AND NOT EXISTS (SELECT 1 FROM stock_movements x WHERE x.id = b.id);
  GET DIAGNOSTICS n_ins = ROW_COUNT;

  UPDATE stock_movements r
     SET movement_type = b.movement_type, ref_job_id = b.ref_job_id, ref_request_id = b.ref_request_id,
         note = b.note, unit_cost = b.unit_cost, lot_no = b.lot_no
    FROM stock_movements_repair_0095 b
   WHERE b.repair_action = 'merged_partner' AND r.id = b.id;
  GET DIAGNOSTICS n_upd = ROW_COUNT;

  UPDATE stock_movements r SET reversal_of = b.reversal_of
    FROM stock_movements_repair_0095 b
   WHERE b.repair_action = 'repointed_reversal' AND r.id = b.id;
  GET DIAGNOSTICS n_rev = ROW_COUNT;

  DELETE FROM stock_movements_repair_0095;
  RETURN format('0095 undo: ใส่แถวคืน %s · คืนค่าแถวจริง %s · คืนการย้อนรายการ %s', n_ins, n_upd, n_rev);
END $$;

REVOKE ALL ON FUNCTION app_ledger_phantoms(), app_ledger_repair_preview(),
                       app_ledger_repair_apply(), app_ledger_repair_undo()
  FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  RAISE NOTICE '0095 OK — ยังไม่แก้ข้อมูล · ดูก่อน: SELECT * FROM app_ledger_repair_preview();';
END $$;
