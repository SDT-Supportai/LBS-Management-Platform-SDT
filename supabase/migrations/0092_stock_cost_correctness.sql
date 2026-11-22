-- =============================================================================
-- 0092 — 🧮 ความถูกต้องคลัง/ต้นทุน (เฟส 1 · ผลตรวจ Workflow 2026-11-18 + มติผู้ใช้ 2026-11-22)
--
-- ทดสอบก่อนแก้บน Postgres จำลอง (PGlite รัน 0001→0091) — บั๊กเกิดจริงทุกข้อ:
--   ① ประวัติคลัง (stock_movements) บันทึกซ้ำ 2 แถว ทุกครั้งที่ INSERT … ON CONFLICT DO UPDATE ชนแถวเดิม
--      (ปรับยอด · Import ตรวจนับ · รับของคืน · ยกเลิก Job) — trigger เดิมเป็น BEFORE INSERT OR UPDATE
--      Postgres ยิง BEFORE INSERT ก่อนเสมอแม้สุดท้ายจะกลายเป็น UPDATE ⇒ แถวผี "+ยอดที่เสนอ" 1 แถว
--      แล้วล้างบริบททิ้ง ⇒ แถวจริงกลายเป็น 'adjust' ไม่มีต้นทุน/Lot · ต้นทุนเฉลี่ยกับ Lot ไม่ถูกใช้
--      ทดสอบ: ปรับ 10→12 ได้ ledger 2 แถว (+12, +2) ผลรวม ledger ไม่ตรงยอดคลัง
--   ② ยกเลิก Job คืนวัสดุเข้าคลังเกิน — ไม่หักที่โอนคืน/ตัดจำหน่ายไปแล้ว
--      ทดสอบ: เบิก 10 ตัดจำหน่าย 4 → คืน 10 (ควร 6) · PO รับ 10 โอนคืนแล้ว 3 → คืน 10 (ควร 7)
--   ③ Q4: เบิกคลังกลาง ระบบจริงบันทึกราคาที่ผู้ใช้พิมพ์ (เว้นว่าง = ต้นทุน 0) ทั้งที่หน้าจอบอก "ต้นทุนถัวเฉลี่ย"
--   ④ Q3: แก้งวดเงิน (แม้แค่ Pack ID) คิดยอดใหม่ตามราคาขายปัจจุบันทุกครั้ง ⇒ ยอดที่รับเงินแล้วเปลี่ยนเงียบ ๆ
--
-- สิ่งที่ทำ:
--   ① แยก trigger: BEFORE = คำนวณต้นทุนเฉลี่ย/Lot (ไม่บันทึก ไม่ล้างบริบท)
--                  AFTER  = บันทึก ledger + ล้างบริบท — AFTER ยิงเฉพาะคำสั่งที่เกิดขึ้นจริง (INSERT หรือ UPDATE)
--   ② app_exec_cancel_job: คืนเฉพาะ "ที่ยังอยู่ที่ Job" (ได้มา − โอนคืน − ออกหน้างาน − ตัดจำหน่าย)
--      + คำขอคืนคลังที่ค้างของ Job นั้นปิดอัตโนมัติ (cancelled) + ledger เป็น job_cancelled อ้างบรรทัดได้
--   ③ rpc_add_accessory_request: เบิกคลังกลางใช้ต้นทุนถัวเฉลี่ย · ถัวเฉลี่ยเป็น 0 เท่านั้นที่ต้องกรอกราคา
--   ④ rpc_update_job_payment (signature ใหม่: + p_edit_reason, p_recalc)
--      ยอดเดิมคงไว้ถ้า % ไม่เปลี่ยน · คิดใหม่เมื่อเปลี่ยน % หรือสั่ง p_recalc · งวดที่รับเงินแล้วต้องมีหมายเหตุการแก้
--
-- ⚠️ ข้อมูลเก่า: แถว ledger ซ้ำที่เกิดไปแล้ว **ไม่ถูกแก้อัตโนมัติ** (เป็นหลักฐาน — แก้ต้องตัดสินใจก่อน)
--    ท้ายไฟล์แจ้งจำนวนวัสดุที่ผลรวม ledger ไม่ตรงยอดคลัง (NOTICE) · ยอดคลัง qty_on_hand เองถูกต้องอยู่แล้ว
-- demo sync: src/data/logic.ts (cancelJob · addAccessoryRequest · updateJobPayment)
-- **รันก่อน push** (หน้าเว็บส่ง p_edit_reason / p_recalc) · idempotent
-- =============================================================================

-- ---------- ① ledger: แยก BEFORE (ต้นทุน/Lot) กับ AFTER (บันทึก) ----------
CREATE OR REPLACE FUNCTION fn_stock_cost_lot() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d NUMERIC; old_qty NUMERIC; old_avg NUMERIC; old_lot TEXT; uc NUMERIC; v_lot TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_qty := COALESCE(OLD.qty_on_hand, 0); old_avg := COALESCE(OLD.avg_unit_cost, 0); old_lot := OLD.lot_no;
  ELSE
    old_qty := 0; old_avg := 0; old_lot := NULL;
  END IF;
  d := NEW.qty_on_hand - old_qty;
  IF d = 0 THEN RETURN NEW; END IF;
  IF NEW.qty_on_hand < 0 THEN RAISE EXCEPTION 'ยอดคลังคงเหลือติดลบไม่ได้'; END IF;

  uc := NULLIF(current_setting('app.stock_cost', true), '')::NUMERIC;
  v_lot := NULLIF(current_setting('app.stock_lot', true), '');

  -- ต้นทุนถัวเฉลี่ย (สูตรเดิม 0038)
  IF d > 0 AND uc IS NOT NULL AND uc >= 0 THEN
    NEW.avg_unit_cost := CASE WHEN NEW.qty_on_hand > 0
      THEN (old_qty * old_avg + d * uc) / NEW.qty_on_hand ELSE uc END;
  ELSE
    NEW.avg_unit_cost := old_avg;
  END IF;
  IF NEW.qty_on_hand = 0 THEN NEW.avg_unit_cost := 0; END IF;

  -- Lot (กติกาเดิม 0055): ทับเฉพาะของเข้าที่ระบุล็อต · ไม่ล้างเป็น NULL ที่นี่
  IF v_lot IS NOT NULL AND d > 0 THEN
    NEW.lot_no := v_lot;
  ELSE
    NEW.lot_no := COALESCE(old_lot, NEW.lot_no);
  END IF;
  -- ⚠️ ไม่บันทึก ledger และไม่ล้างบริบทที่นี่ — INSERT…ON CONFLICT จะยิง BEFORE UPDATE ต่ออีกรอบและต้องเห็นบริบทเดิม
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fn_log_stock_movement() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d NUMERIC; old_qty NUMERIC; old_avg NUMERIC; old_lot TEXT; uc NUMERIC; t TEXT; actor_id UUID; v_lot TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_qty := COALESCE(OLD.qty_on_hand, 0); old_avg := COALESCE(OLD.avg_unit_cost, 0); old_lot := OLD.lot_no;
  ELSE
    old_qty := 0; old_avg := 0; old_lot := NULL;
  END IF;
  d := NEW.qty_on_hand - old_qty;
  IF d = 0 THEN RETURN NULL; END IF;

  uc := NULLIF(current_setting('app.stock_cost', true), '')::NUMERIC;
  t  := COALESCE(NULLIF(current_setting('app.stock_type', true), ''), 'adjust');
  v_lot := NULLIF(current_setting('app.stock_lot', true), '');
  BEGIN actor_id := auth.uid(); EXCEPTION WHEN OTHERS THEN actor_id := NULL; END;

  INSERT INTO stock_movements (item_id, qty, unit_cost, balance_after, movement_type,
    ref_job_id, ref_request_id, note, performed_by, lot_no)
  VALUES (NEW.item_id, d,
    CASE WHEN d > 0 THEN uc ELSE NULLIF(old_avg, 0) END,
    NEW.qty_on_hand, t,
    NULLIF(current_setting('app.stock_job', true), '')::UUID,
    NULLIF(current_setting('app.stock_req', true), '')::UUID,
    NULLIF(current_setting('app.stock_note', true), ''),
    actor_id,
    COALESCE(v_lot, old_lot));

  -- ล้างบริบท กันรั่วไปรายการถัดไปใน transaction เดียวกัน (ย้ายมาจาก BEFORE)
  PERFORM app_set_stock_ctx(NULL, NULL, NULL, NULL, NULL);
  PERFORM app_set_stock_lot(NULL);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_log_stock_movement ON accessory_stock;
DROP TRIGGER IF EXISTS trg_stock_cost_lot ON accessory_stock;
CREATE TRIGGER trg_stock_cost_lot
BEFORE INSERT OR UPDATE OF qty_on_hand ON accessory_stock
FOR EACH ROW EXECUTE FUNCTION fn_stock_cost_lot();
CREATE TRIGGER trg_log_stock_movement
AFTER INSERT OR UPDATE OF qty_on_hand ON accessory_stock
FOR EACH ROW EXECUTE FUNCTION fn_log_stock_movement();

-- ---------- ② ยกเลิก Job: คืนเฉพาะที่ยังอยู่ที่ Job (body ตัวจริงหลัง patch 0016→0066 ทั้งดุ้น) ----------
CREATE OR REPLACE FUNCTION app_exec_cancel_job(actor profiles, p_job_id UUID, p_reason TEXT, p_received_to_central BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; returned INT := 0; partial_cnt INT := 0; stock RECORD; r RECORD;
        v_back NUMERIC; v_note TEXT; n_ret INT := 0;
BEGIN
  j := app_assert_job_editable(p_job_id);
  IF trim(p_reason) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการยกเลิก'; END IF; PERFORM app_assert_no_issued_out(p_job_id);

  FOR stock IN
    SELECT project_stock_id, array_agg(serial_lvb) AS serials, count(*) AS cnt
    FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated'
    GROUP BY project_stock_id
  LOOP
    INSERT INTO stock_allocations (job_id, project_stock_id, txn_type, serial_nos, performed_by, reference_note)
    VALUES (p_job_id, stock.project_stock_id, 'return', stock.serials, actor.id, 'auto-return จากการยกเลิก Job');
    returned := returned + stock.cnt;
  END LOOP;
  UPDATE lbs_units SET status = 'in_stock', job_id = NULL, updated_at = now()
  WHERE job_id = p_job_id AND status = 'allocated';

  -- 0092: คำขอคืนคลังที่ค้าง → ปิดอัตโนมัติ (ของยังอยู่ที่ Job จึงนับคืนรวมด้านล่าง)
  UPDATE stock_return_requests
     SET status = 'cancelled', decided_by = actor.id, decided_at = now(),
         decision_note = 'ยกเลิกอัตโนมัติ: ' || j.job_no || ' ถูกยกเลิก'
   WHERE job_id = p_job_id AND status = 'pending';
  GET DIAGNOSTICS n_ret = ROW_COUNT;

  v_note := 'ยกเลิก ' || j.job_no || ' — นำของเข้าคลัง';
  FOR r IN SELECT * FROM job_accessory_requests WHERE job_id = p_job_id FOR UPDATE LOOP
    IF r.source = 'central_stock' AND r.status = 'issued' THEN
      -- 0092: คืนเฉพาะที่ยังอยู่ที่ Job (เดิมคืน qty_requested ทั้งก้อน)
      v_back := GREATEST(r.qty_requested - COALESCE(r.qty_transferred, 0)
                - COALESCE(r.qty_issued_to_service, 0) - COALESCE(r.qty_written_off, 0), 0);
      IF v_back > 0 THEN
        PERFORM app_set_stock_ctx('job_cancelled', p_job_id, r.id, v_note, r.unit_price);
        INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, v_back)
        ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
      END IF;
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    ELSIF r.status = 'po_ordered' AND COALESCE(r.qty_received, 0) > 0 THEN
      IF p_received_to_central THEN
        v_back := GREATEST(r.qty_received - COALESCE(r.qty_transferred, 0)
                  - COALESCE(r.qty_issued_to_service, 0) - COALESCE(r.qty_written_off, 0), 0);
        IF v_back > 0 THEN
          PERFORM app_set_stock_ctx('job_cancelled', p_job_id, r.id, v_note, r.unit_price);
          INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, v_back)
          ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
          UPDATE items SET is_stockable_centrally = true WHERE id = r.item_id AND NOT is_stockable_centrally;
        END IF;
        UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
      ELSE
        UPDATE job_accessory_requests SET status = 'received', updated_at = now() WHERE id = r.id;
      END IF;
      partial_cnt := partial_cnt + 1;
    ELSIF r.status IN ('pending', 'pr_sent', 'po_ordered') THEN
      UPDATE job_accessory_requests SET status = 'cancelled', updated_at = now() WHERE id = r.id;
    ELSIF r.status = 'received' AND p_received_to_central THEN
      v_back := GREATEST(COALESCE(NULLIF(r.qty_received, 0), r.qty_requested) - COALESCE(r.qty_transferred, 0)
                - COALESCE(r.qty_issued_to_service, 0) - COALESCE(r.qty_written_off, 0), 0);
      IF v_back > 0 THEN
        PERFORM app_set_stock_ctx('job_cancelled', p_job_id, r.id, v_note, r.unit_price);
        INSERT INTO accessory_stock (item_id, qty_on_hand) VALUES (r.item_id, v_back)
        ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
        UPDATE items SET is_stockable_centrally = true WHERE id = r.item_id AND NOT is_stockable_centrally;
      END IF;
      UPDATE job_accessory_requests SET status = 'returned', updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  UPDATE purchase_requisitions SET status = 'cancelled' WHERE job_id = p_job_id AND status IN ('pending', 'po_issued');
  UPDATE purchase_orders SET status = 'cancelled' WHERE job_id = p_job_id AND status = 'issued';

  UPDATE jobs SET terminal_status = 'cancelled', cancelled_at = now(), cancelled_by = actor.id,
    cancel_reason = trim(p_reason), updated_at = now()
  WHERE id = p_job_id;

  PERFORM app_notify('job_cancelled',
    '❌ ยกเลิก ' || j.job_no || ': ' || trim(p_reason)
    || CASE WHEN partial_cnt > 0
         THEN ' (วัสดุรับบางส่วน ' || partial_cnt || ' รายการ'
              || CASE WHEN p_received_to_central THEN ' คืนเข้าสต็อกกลางแล้ว)' ELSE ' คงไว้กับ Job พิจารณาเป็นเคส)' END
         ELSE '' END,
    'all', p_job_id);
  PERFORM app_audit('job', p_job_id, 'cancel_job', actor.id,
    'ยกเลิก ' || j.job_no || ' (' || trim(p_reason) || ') — คืน LBS ' || returned || ' เครื่องกลับสต็อกเดิม'
    || CASE WHEN partial_cnt > 0
         THEN ' + วัสดุรับบางส่วน ' || partial_cnt || ' รายการ'
              || CASE WHEN p_received_to_central THEN ' คืนเข้าสต็อกกลาง' ELSE ' (คงไว้กับ Job พิจารณาเป็นเคส)' END
         ELSE '' END
    || CASE WHEN n_ret > 0 THEN ' · ปิดคำขอคืนคลังที่ค้าง ' || n_ret || ' ใบ' ELSE '' END);
END $$;

-- ---------- ③ เบิกคลังกลาง = ต้นทุนถัวเฉลี่ย (body ตัวจริงหลัง patch 0017→0038 ทั้งดุ้น) ----------
CREATE OR REPLACE FUNCTION rpc_add_accessory_request(p_job_id UUID, p_item_id UUID, p_qty NUMERIC, p_source TEXT,
                                                     p_unit_price NUMERIC DEFAULT NULL, p_phase_budget TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; it items; onhand NUMERIC; rid UUID; ph TEXT; before_status TEXT; remaining NUMERIC;
        v_avg NUMERIC; v_cost NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_procurable(p_job_id);
  SELECT * INTO it FROM items WHERE id = p_item_id;
  IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Accessory'; END IF;
  IF p_qty IS NULL OR p_qty < 1 THEN RAISE EXCEPTION 'จำนวนต้องอย่างน้อย 1'; END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN RAISE EXCEPTION 'ราคาต่อหน่วยติดลบไม่ได้'; END IF;
  ph := NULLIF(trim(COALESCE(p_phase_budget, '')), '');
  before_status := app_job_status(p_job_id);

  IF p_source = 'central_stock' THEN
    IF NOT it.is_stockable_centrally THEN
      RAISE EXCEPTION '% ไม่มีในสต็อกกลาง ต้องสั่งซื้อผ่าน Purchasing', it.name;
    END IF;
    -- 0092 (Q4): ต้นทุน = ถัวเฉลี่ยของคลัง ณ ก่อนตัดยอด (ตัดจนเหลือ 0 แล้ว trigger รีเซ็ตเป็น 0)
    SELECT avg_unit_cost INTO v_avg FROM accessory_stock WHERE item_id = p_item_id FOR UPDATE;
    v_cost := CASE WHEN COALESCE(v_avg, 0) > 0 THEN v_avg ELSE p_unit_price END;
    IF v_cost IS NULL THEN
      RAISE EXCEPTION '% ยังไม่มีต้นทุนในคลัง — กรุณากรอกราคาต่อหน่วย', it.name;
    END IF;
    PERFORM app_set_stock_ctx('issue_to_job', p_job_id, NULL, 'เบิกเข้า ' || j.job_no, NULL);
    UPDATE accessory_stock SET qty_on_hand = qty_on_hand - p_qty, updated_at = now()
    WHERE item_id = p_item_id AND qty_on_hand >= p_qty
    RETURNING qty_on_hand INTO remaining;
    IF NOT FOUND THEN
      PERFORM app_set_stock_ctx(NULL, NULL, NULL, NULL, NULL);
      SELECT COALESCE(qty_on_hand, 0) INTO onhand FROM accessory_stock WHERE item_id = p_item_id;
      RAISE EXCEPTION 'สต็อกกลาง % คงเหลือ % % ไม่พอ (ขอ %) — เปลี่ยนเป็นสั่งซื้อผ่าน Purchasing ได้',
        it.name, COALESCE(onhand, 0), it.uom, p_qty;
    END IF;
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, phase_budget, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, v_cost, ph, 'central_stock', 'issued', actor.id) RETURNING id INTO rid;
    PERFORM app_notify('accessory_issued',
      '📤 ' || j.job_no || ' เบิก ' || it.name || ' ' || p_qty || ' ' || it.uom
      || ' (คลังเหลือ ' || remaining || ')', 'sales', p_job_id);
    PERFORM app_notify_if_ready(p_job_id, before_status);
    PERFORM app_audit('job_accessory_request', rid, 'issue_accessory_from_stock', actor.id,
      j.job_no || ' เบิก ' || it.name || ' ' || p_qty || ' ' || it.uom || ' จากสต็อกกลาง @' || round(v_cost, 2) || ' ฿'
      || CASE WHEN COALESCE(v_avg, 0) > 0 THEN ' (ต้นทุนถัวเฉลี่ย)' ELSE ' (กรอกเอง — คลังยังไม่มีต้นทุน)' END);
  ELSE
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, phase_budget, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, p_unit_price, ph, 'purchasing', 'pending', actor.id) RETURNING id INTO rid;
    PERFORM app_audit('job_accessory_request', rid, 'request_accessory_purchase', actor.id,
      j.job_no || ' ขอซื้อ ' || it.name || ' ' || p_qty || ' ' || it.uom || ' (รอออก PR)');
  END IF;
END $$;

-- ---------- ④ งวดเงิน: ยอดไม่เปลี่ยนเอง + หมายเหตุการแก้ (signature ใหม่ ⇒ DROP + CREATE + GRANT) ----------
DROP FUNCTION IF EXISTS rpc_update_job_payment(UUID, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION rpc_update_job_payment(
  p_payment_id UUID, p_invoice_no TEXT DEFAULT NULL, p_invoice_date DATE DEFAULT NULL,
  p_percent NUMERIC DEFAULT NULL, p_amount NUMERIC DEFAULT NULL, p_paid_at DATE DEFAULT NULL,
  p_note TEXT DEFAULT NULL, p_order_num TEXT DEFAULT NULL, p_pack_id TEXT DEFAULT NULL,
  p_edit_reason TEXT DEFAULT NULL, p_recalc BOOLEAN DEFAULT false
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pm job_payments; j jobs; amt NUMERIC; v_base NUMERIC; v_reason TEXT; keep_frozen BOOLEAN;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO pm FROM job_payments WHERE id = p_payment_id FOR UPDATE;
  IF pm.id IS NULL THEN RAISE EXCEPTION 'ไม่พบงวดเงินนี้'; END IF;
  j := app_assert_job_cost_editable(pm.job_id);

  -- Q3: แก้ได้เสมอ แต่งวดที่รับเงินแล้วต้องมีหมายเหตุการแก้ (ยอดที่ลูกค้าจ่ายจริงไปแล้ว)
  v_reason := NULLIF(btrim(COALESCE(p_edit_reason, '')), '');
  IF pm.paid_at IS NOT NULL AND v_reason IS NULL THEN
    RAISE EXCEPTION 'งวดนี้รับเงินแล้ว (%) — กรุณาระบุหมายเหตุการแก้ไข', pm.paid_at;
  END IF;

  -- ยอดตรึงไว้ตามใบแจ้งหนี้: คิดใหม่เฉพาะเปลี่ยน % / เปลี่ยนจากยอดกรอกเองเป็น % / สั่ง p_recalc
  keep_frozen := p_percent IS NOT NULL AND pm.percent IS NOT NULL AND p_percent = pm.percent AND NOT COALESCE(p_recalc, false);
  IF keep_frozen THEN
    amt := pm.amount; v_base := pm.base_sale_price;
  ELSE
    amt := app_payment_amount(j, p_percent, p_amount); v_base := j.budget_sale_price;
  END IF;

  UPDATE job_payments SET
    order_num       = NULLIF(btrim(COALESCE(p_order_num, '')), ''),
    pack_id         = NULLIF(btrim(COALESCE(p_pack_id, '')), ''),
    invoice_no      = NULLIF(btrim(COALESCE(p_invoice_no, '')), ''),
    invoice_date    = p_invoice_date,
    percent         = p_percent,
    amount          = amt,
    base_sale_price = v_base,
    paid_at         = p_paid_at,
    note            = NULLIF(btrim(COALESCE(p_note, '')), ''),
    updated_at      = now()
  WHERE id = p_payment_id;

  PERFORM app_audit('job_payment', pm.job_id, 'update_job_payment', actor.id,
    j.job_no || ' แก้งวด ' || pm.pay_type || ' #' || pm.seq ||
    ' · Order ' || COALESCE(NULLIF(btrim(COALESCE(p_order_num, '')), ''), '-') ||
    ' · Pack ' || COALESCE(NULLIF(btrim(COALESCE(p_pack_id, '')), ''), '-') ||
    ' · Invoice ' || COALESCE(p_invoice_no, '-') || ' · ' ||
    round(pm.amount, 2) || ' → ' || round(amt, 2) || ' ฿' ||
    CASE WHEN p_paid_at IS NOT NULL THEN ' · รับเงิน ' || p_paid_at ELSE ' · ยังไม่รับเงิน' END ||
    CASE WHEN v_reason IS NOT NULL THEN ' · เหตุผลที่แก้: ' || v_reason ELSE '' END);
END $$;
REVOKE ALL ON FUNCTION public.rpc_update_job_payment(UUID, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_job_payment(UUID, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ---------- ตรวจผล ----------
DO $$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stock_cost_lot' AND tgrelid = 'accessory_stock'::regclass AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_log_stock_movement' AND tgrelid = 'accessory_stock'::regclass
                     AND NOT tgisinternal AND (tgtype & 2) = 0) THEN          -- bit 2 = BEFORE → ต้องเป็น AFTER
    RAISE EXCEPTION '0092: trigger ledger ไม่ได้ติดตั้งแบบ BEFORE + AFTER';
  END IF;
  IF to_regprocedure('public.rpc_update_job_payment(uuid,text,date,numeric,numeric,date,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION '0092: rpc_update_job_payment signature เดิมยังค้าง';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_update_job_payment(uuid,text,date,numeric,numeric,date,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_update_job_payment(uuid,text,date,numeric,numeric,date,text,text,text,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '0092: สิทธิ์ rpc_update_job_payment ไม่ถูกต้อง';
  END IF;
  IF position('v_back' IN pg_get_functiondef('public.app_exec_cancel_job(profiles,uuid,text,boolean)'::regprocedure)) = 0
     OR position('v_avg' IN pg_get_functiondef('public.rpc_add_accessory_request(uuid,uuid,numeric,text,numeric,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0092: body ใหม่ไม่ได้ติดตั้ง';
  END IF;

  -- ข้อมูลเก่า: วัสดุที่ผลรวม ledger ไม่ตรงยอดคลัง (เกิดจากบั๊ก ① ก่อนหน้านี้) — แจ้งอย่างเดียว ไม่แก้
  SELECT count(*) INTO n FROM (
    SELECT s.item_id FROM accessory_stock s LEFT JOIN stock_movements m USING (item_id)
     GROUP BY s.item_id, s.qty_on_hand HAVING COALESCE(sum(m.qty), 0) <> s.qty_on_hand) x;
  RAISE NOTICE '0092: ตรวจผ่าน · วัสดุที่ประวัติคลังไม่ตรงยอด (ข้อมูลเก่า ยังไม่แก้) = % รายการ', n;
END $$;
