-- =============================================================================
-- 0080 — 📦 คืนคลัง / โอนเข้าคลัง ต้องผ่าน Purchasing ตรวจรับ + ย้อนการโอน + ตรวจนับคลัง (2026-09-29)
--
-- ที่มา (ผู้ใช้รายงาน 2026-09-29 จากหน้า Purchase Orders ของ Job จริง):
--   1) วัสดุที่เบิกออกหน้างานหมดแล้ว (คงเหลือที่ Job = 0) ยังมีปุ่ม "โอนเข้าคลัง"
--   2) วัสดุจากคลังคงเหลือที่ออกหน้างานแล้ว ยังมีปุ่ม "คืนคลัง" + "โอนเข้าคลัง"
--      🔴 บั๊กจริง: rpc_return_accessory คืน **ทั้งบรรทัด** (qty_requested − qty_transferred) รวมของที่
--         อยู่หน้างานแล้ว แล้วตั้ง status = returned ⇒ คลังงอกของที่ไม่มีอยู่จริง + ยอดหน้างานหายเงียบ
--   3) กดผิดไปแล้วไม่มีทางย้อน   4) "คืนคลัง" ไม่มี popup ยืนยัน — กดทีเดียวยอดเปลี่ยนเลย
--   ⇒ รากเดียวกัน: การคืนของเข้าคลังเป็น action ขั้นเดียว **ไม่มีคนนับของจริง**
--
-- มติผู้ใช้ 2026-09-29:
--   (ก) คืนคลัง/โอนเข้าคลัง = **คำขอ** รอ Purchasing ตรวจรับ → "รับเข้าคลัง" / "ตีกลับ Job"
--       ยอดคลังยังไม่เพิ่ม · ต้นทุน Job ยังไม่ลด จนกว่า Purchasing รับจริง
--   (ข) ปุ่มคืน/โอน ขึ้นเฉพาะตอนมีของค้างที่ Job · ของที่ออกหน้างานแล้วใช้ปุ่มแยก "📥 ช่างคืนของเหลือ"
--       (แทนพฤติกรรม 0067 ที่ให้ "โอนเกินของค้าง" = ดึงของหน้างานกลับแบบเงียบ ๆ)
--   (ค) Purchasing **รับบางส่วนได้** — ส่วนที่ขาดตีกลับ Job อัตโนมัติ (ยังค้างที่เดิม ไม่หายไปไหน)
--   (ง) ย้อนการโอนที่ทำไปแล้ว (รวมของเก่าก่อน 0080) — Project เจ้าของงาน + Manage
--   (จ) Import ตรวจนับคลัง: ยอดนับจริง + ต้นทุน/หน่วย (Division / Purchasing / Manage)
--   (ฉ) ปิดงานติดตั้ง: Project **ทุกคน** + Service + Manage
--
-- 🔴 ของที่รอตรวจรับ = "จองไว้" — ยังนับอยู่ที่ Job (app_acc_pending_qty ไม่เปลี่ยน) ⇒ บรรทัดยังไม่ "จบ"
--    ⇒ ใบไม่พลิกเป็น Issued ก่อนของเข้าคลังจริง · แต่ **เบิก/ตัดจำหน่ายส่วนที่จองไม่ได้**
--    (app_exec_issue_accessory / rpc_write_off_job_material หัก app_acc_reserved_qty)
--
-- 🔴 rpc_return_accessory + rpc_transfer_job_material_to_stock **ปิดใช้** (RAISE) — ทางเดียวคือขอคืน
--    ไม่ปิด = client รุ่นเก่า/คนยิง RPC ตรงยังเข้าคลังข้ามการตรวจรับได้
--
-- demo sync ที่ src/data/logic.ts · รันหลัง 0079 · idempotent · **ต้องรันก่อน push**
-- =============================================================================

-- ---------- 1) คำขอคืนของเข้าคลัง ----------
CREATE TABLE IF NOT EXISTS stock_return_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES job_accessory_requests(id) ON DELETE CASCADE,
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES items(id),
  kind          TEXT NOT NULL,
  qty           NUMERIC(14,2) NOT NULL,
  unit_cost     NUMERIC(14,2),               -- snapshot ราคา/หน่วยของบรรทัดตอนขอ (ใช้ตีต้นทุนเข้าคลัง)
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  received_qty  NUMERIC(14,2),               -- Purchasing นับได้จริง (≤ qty) · ส่วนต่างตีกลับ Job
  decision_note TEXT,
  requested_by  UUID REFERENCES profiles(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    UUID REFERENCES profiles(id),
  decided_at    TIMESTAMPTZ,
  -- return = คืนของที่เบิกจากคลังคงเหลือ · transfer = โอนของที่ซื้อผ่าน PO · field_return = ช่างคืนของเหลือจากหน้างาน
  CONSTRAINT srr_kind_ck   CHECK (kind IN ('return', 'transfer', 'field_return')),
  CONSTRAINT srr_status_ck CHECK (status IN ('pending', 'received', 'rejected', 'cancelled')),
  CONSTRAINT srr_qty_ck    CHECK (qty > 0),
  CONSTRAINT srr_recv_ck   CHECK (received_qty IS NULL OR (received_qty > 0 AND received_qty <= qty)),
  CONSTRAINT srr_recv_status_ck CHECK ((status = 'received') = (received_qty IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_srr_pending ON stock_return_requests(status, requested_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_srr_request ON stock_return_requests(request_id);

ALTER TABLE stock_return_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON stock_return_requests;
CREATE POLICY read_all ON stock_return_requests FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS require_active ON stock_return_requests;
CREATE POLICY require_active ON stock_return_requests AS RESTRICTIVE FOR SELECT TO authenticated USING (my_is_active());
REVOKE INSERT, UPDATE, DELETE ON stock_return_requests FROM authenticated, anon;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE stock_return_requests;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- ---------- 2) ledger: ประเภท "ย้อนการโอน" + ผูกแถวที่ถูกย้อน (กันย้อนซ้ำ) ----------
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN
  ('initial', 'adjust', 'import_adjust', 'issue_to_job', 'return_from_job',
   'transfer_from_job', 'job_cancelled', 'reverse_to_job'));
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reversal_of UUID REFERENCES stock_movements(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_reversal ON stock_movements(reversal_of) WHERE reversal_of IS NOT NULL;

-- ---------- 3) ของที่ถูกจองไว้รอตรวจรับ ----------
-- p_field = false → จองจาก "ค้างที่ Job" (return/transfer) · true → จองจาก "ออกหน้างานแล้ว" (field_return)
CREATE OR REPLACE FUNCTION app_acc_reserved_qty(p_request_id UUID, p_field BOOLEAN)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(qty), 0) FROM stock_return_requests
   WHERE request_id = p_request_id AND status = 'pending' AND (kind = 'field_return') = p_field
$$;

-- เบิก / ตัดจำหน่าย ห้ามแตะของที่จองไว้ (ไม่งั้นรับเข้าคลังแล้วบัญชี 4 ช่องเกินจำนวนที่ขอ)
DO $$
BEGIN
  PERFORM app_swap_guard('app_exec_issue_accessory',
    'left_qty := app_acc_pending_qty(r);',
    'left_qty := app_acc_pending_qty(r) - app_acc_reserved_qty(r.id, false);');
  PERFORM app_swap_guard('rpc_write_off_job_material',
    'at_job := app_acc_pending_qty(r);',
    'at_job := app_acc_pending_qty(r) - app_acc_reserved_qty(r.id, false);');
  -- (ฉ) ปิดงานติดตั้ง: Project ทุกคน + Service (+ Manage อัตโนมัติ)
  PERFORM app_swap_guard('rpc_close_job_install',
    'actor := app_assert_dept(ARRAY[''service'']);',
    'actor := app_assert_dept(ARRAY[''service'', ''project'']);');
END $$;

-- ---------- 4) ปิดทางเข้าคลังแบบขั้นเดียว ----------
CREATE OR REPLACE FUNCTION rpc_return_accessory(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'การคืนคลังต้องผ่าน Purchasing ตรวจรับแล้ว (0080) — รีเฟรชหน้าแล้วกด "คืนคลัง" ใหม่';
END $$;
CREATE OR REPLACE FUNCTION rpc_transfer_job_material_to_stock(p_request_id UUID, p_qty NUMERIC, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'การโอนเข้าคลังต้องผ่าน Purchasing ตรวจรับแล้ว (0080) — รีเฟรชหน้าแล้วกด "โอนเข้าคลัง" ใหม่';
END $$;

-- ---------- 5) Project ขอคืน ----------
CREATE OR REPLACE FUNCTION rpc_request_stock_return(
  p_request_id UUID, p_kind TEXT, p_qty NUMERIC, p_note TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; it items; j jobs; avail NUMERIC; nt TEXT; new_id UUID; lbl TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  SELECT * INTO j FROM jobs WHERE id = r.job_id FOR UPDATE;
  PERFORM app_assert_job_owner(j);   -- 0042: จัดการของใน Job ได้เฉพาะเจ้าของงาน (+ Manage)
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว — ของถูกคืนเข้าคลังตอนยกเลิกอยู่แล้ว', j.job_no;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('return', 'transfer', 'field_return') THEN
    RAISE EXCEPTION 'ประเภทคำขอไม่ถูกต้อง';
  END IF;
  IF p_kind = 'return' AND (r.source <> 'central_stock' OR r.status <> 'issued') THEN
    RAISE EXCEPTION 'คืนคลังได้เฉพาะวัสดุที่เบิกจากคลังคงเหลือแล้ว';
  END IF;
  IF p_kind = 'transfer' AND r.status <> 'received' THEN
    RAISE EXCEPTION 'โอนเข้าคลังได้เฉพาะวัสดุที่รับของจาก PO แล้ว';
  END IF;
  IF p_kind = 'field_return' AND r.status NOT IN ('issued', 'received') THEN
    RAISE EXCEPTION 'รายการนี้ยังไม่มีของออกหน้างาน';
  END IF;

  avail := CASE WHEN p_kind = 'field_return'
    THEN COALESCE(r.qty_issued_to_service, 0) - app_acc_reserved_qty(r.id, true)
    ELSE app_acc_pending_qty(r) - app_acc_reserved_qty(r.id, false) END;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'จำนวนต้องมากกว่า 0'; END IF;
  IF p_qty > avail THEN
    RAISE EXCEPTION '% ได้ไม่เกิน % % (%)',
      CASE p_kind WHEN 'field_return' THEN 'ช่างคืนของ' WHEN 'return' THEN 'คืนคลัง' ELSE 'โอนเข้าคลัง' END,
      trim(to_char(GREATEST(avail, 0), 'FM999999990.99')), it.uom,
      CASE WHEN p_kind = 'field_return' THEN 'ของที่ออกหน้างานแล้ว หักที่รอตรวจรับอยู่'
           ELSE 'ของที่ค้างอยู่ที่ Job หักที่รอตรวจรับอยู่' END;
  END IF;
  nt := NULLIF(btrim(COALESCE(p_note, '')), '');
  IF p_kind = 'field_return' AND nt IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุรายละเอียดของที่ช่างคืน (เช่น เหลือจากจุดติดตั้งไหน)';
  END IF;

  INSERT INTO stock_return_requests (request_id, job_id, item_id, kind, qty, unit_cost, note, requested_by)
  VALUES (r.id, r.job_id, r.item_id, p_kind, p_qty, r.unit_price, nt, actor.id)
  RETURNING id INTO new_id;

  lbl := CASE p_kind WHEN 'field_return' THEN 'ช่างคืนของเหลือ' WHEN 'return' THEN 'ขอคืนคลัง' ELSE 'ขอโอนเข้าคลัง' END;
  PERFORM app_notify('stock_return_requested',
    '📦 ' || j.job_no || ' ' || lbl || ' ' || it.name || ' ' || p_qty || ' ' || it.uom ||
    ' — รอ Purchasing ตรวจรับเข้าคลัง', 'purchasing', r.job_id);
  PERFORM app_audit('accessory_stock', r.item_id, 'request_stock_return', actor.id,
    j.job_no || ' ' || lbl || ' ' || it.name || ' ' || p_qty || ' ' || it.uom || ' (รอตรวจรับ)' ||
    COALESCE(' — ' || nt, ''));
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION rpc_cancel_stock_return(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s stock_return_requests; j jobs; it items;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO s FROM stock_return_requests WHERE id = p_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ Purchasing ดำเนินการไปแล้ว — ยกเลิกไม่ได้'; END IF;
  SELECT * INTO j FROM jobs WHERE id = s.job_id;
  PERFORM app_assert_job_owner(j);
  SELECT * INTO it FROM items WHERE id = s.item_id;
  UPDATE stock_return_requests SET status = 'cancelled', decided_by = actor.id, decided_at = now() WHERE id = p_id;
  PERFORM app_audit('accessory_stock', s.item_id, 'cancel_stock_return', actor.id,
    j.job_no || ' ยกเลิกคำขอคืน ' || it.name || ' ' || s.qty || ' ' || it.uom);
END $$;

-- ---------- 6) Purchasing ตรวจรับ / ตีกลับ ----------
CREATE OR REPLACE FUNCTION rpc_receive_stock_return(p_id UUID, p_received_qty NUMERIC, p_note TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s stock_return_requests; r job_accessory_requests; it items; j jobs;
        short NUMERIC; nt TEXT; val NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);   -- Purchasing + Manage (ผู้ถือคลังตัวจริง)
  SELECT * INTO s FROM stock_return_requests WHERE id = p_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ดำเนินการไปแล้ว'; END IF;
  SELECT * INTO r FROM job_accessory_requests WHERE id = s.request_id FOR UPDATE;
  SELECT * INTO it FROM items WHERE id = s.item_id;
  SELECT * INTO j FROM jobs WHERE id = s.job_id FOR UPDATE;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว (ของคืนคลังตอนยกเลิกแล้ว) — กด "ตีกลับ Job" เพื่อปิดคำขอนี้', j.job_no;
  END IF;
  IF p_received_qty IS NULL OR p_received_qty <= 0 THEN
    RAISE EXCEPTION 'จำนวนที่รับเข้าคลังต้องมากกว่า 0 — ถ้าไม่ได้รับของเลยให้กด "ตีกลับ Job"';
  END IF;
  IF p_received_qty > s.qty THEN
    RAISE EXCEPTION 'รับได้ไม่เกินจำนวนที่แจ้งคืน (% %)', s.qty, it.uom;
  END IF;

  -- ของยังต้องอยู่ที่เดิมจริง (กันกรณีบัญชีขยับระหว่างรอตรวจรับ)
  IF s.kind = 'field_return' THEN
    IF COALESCE(r.qty_issued_to_service, 0) < p_received_qty THEN
      RAISE EXCEPTION 'ยอดที่ออกหน้างานเหลือ % % — น้อยกว่าที่จะรับ', COALESCE(r.qty_issued_to_service, 0), it.uom;
    END IF;
  ELSIF app_acc_pending_qty(r) < p_received_qty THEN
    RAISE EXCEPTION 'ยอดที่ค้างอยู่ที่ Job เหลือ % % — น้อยกว่าที่จะรับ', app_acc_pending_qty(r), it.uom;
  END IF;

  UPDATE job_accessory_requests
     SET qty_transferred = COALESCE(qty_transferred, 0) + p_received_qty,
         qty_issued_to_service = COALESCE(qty_issued_to_service, 0)
                                 - CASE WHEN s.kind = 'field_return' THEN p_received_qty ELSE 0 END,
         updated_at = now()
   WHERE id = r.id;
  UPDATE items SET is_stockable_centrally = true WHERE id = s.item_id AND is_stockable_centrally = false;

  nt := NULLIF(btrim(COALESCE(p_note, '')), '');
  PERFORM app_set_stock_ctx(CASE WHEN s.kind = 'return' THEN 'return_from_job' ELSE 'transfer_from_job' END,
    s.job_id, r.id,
    CASE s.kind WHEN 'field_return' THEN 'ช่างคืนของเหลือจาก ' WHEN 'return' THEN 'คืนจาก ' ELSE 'โอนวัสดุเหลือจาก ' END ||
      j.job_no || ' (ตรวจรับแล้ว)' || COALESCE(' — ' || nt, ''),
    COALESCE(s.unit_cost, r.unit_price));
  INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost)
  VALUES (s.item_id, p_received_qty, COALESCE(s.unit_cost, r.unit_price, 0))
  ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand,
                                      updated_at = now();

  short := s.qty - p_received_qty;
  UPDATE stock_return_requests SET status = 'received', received_qty = p_received_qty,
    decision_note = nt, decided_by = actor.id, decided_at = now() WHERE id = p_id;

  val := COALESCE(s.unit_cost, r.unit_price, 0) * p_received_qty;
  PERFORM app_notify('stock_return_received',
    '✅ ' || j.job_no || ' Purchasing รับ ' || it.name || ' ' || p_received_qty || ' ' || it.uom ||
    ' เข้าคลังแล้ว (ตัดต้นทุนออก ' || round(val, 2) || ' ฿)' ||
    CASE WHEN short > 0 THEN ' · ⚠️ ขาด ' || short || ' ' || it.uom || ' ตีกลับ Job' ELSE '' END,
    'project', s.job_id);
  PERFORM app_audit('accessory_stock', s.item_id, 'receive_stock_return', actor.id,
    j.job_no || ' ตรวจรับ ' || it.name || ' ' || p_received_qty || '/' || s.qty || ' ' || it.uom ||
    ' เข้าคลังคงเหลือ (ต้นทุนที่ตัดออกจาก Job ' || round(val, 2) || ' บาท)' ||
    CASE WHEN short > 0 THEN ' · ส่วนที่ขาด ' || short || ' ' || it.uom || ' ตีกลับ Job' ELSE '' END ||
    COALESCE(' — ' || nt, ''));

  -- การรับคืนอาจเป็นชิ้นสุดท้ายที่ทำให้ทุกบรรทัดจบ (เหมือน 0068/0072)
  PERFORM app_finalize_issue_loud(actor, s.job_id);
END $$;

CREATE OR REPLACE FUNCTION rpc_reject_stock_return(p_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s stock_return_requests; it items; j jobs; rsn TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO s FROM stock_return_requests WHERE id = p_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  IF s.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ดำเนินการไปแล้ว'; END IF;
  rsn := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF rsn IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ตีกลับ'; END IF;
  SELECT * INTO it FROM items WHERE id = s.item_id;
  SELECT * INTO j FROM jobs WHERE id = s.job_id;
  UPDATE stock_return_requests SET status = 'rejected', decision_note = rsn,
    decided_by = actor.id, decided_at = now() WHERE id = p_id;
  PERFORM app_notify('stock_return_rejected',
    '↩️ ' || j.job_no || ' Purchasing ตีกลับคำขอคืน ' || it.name || ' ' || s.qty || ' ' || it.uom || ' — ' || rsn,
    'project', s.job_id);
  PERFORM app_audit('accessory_stock', s.item_id, 'reject_stock_return', actor.id,
    j.job_no || ' ตีกลับคำขอคืน ' || it.name || ' ' || s.qty || ' ' || it.uom || ' — ' || rsn);
END $$;

-- ---------- 7) ย้อนการโอน/คืนที่เข้าคลังไปแล้ว ----------
-- p_destination: 'field' = ของอยู่หน้างานจริง (กลับไปนับเป็นเบิกออกหน้างาน) · 'job' = ค้างที่ Job
-- แถวเก่าก่อน 0067 ที่ "คืนทั้งบรรทัด" (status returned) → คืนสถานะ issued ให้ (ยอดเดิมยังอยู่ครบ)
CREATE OR REPLACE FUNCTION rpc_reverse_stock_movement(p_movement_id UUID, p_destination TEXT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; m stock_movements; r job_accessory_requests; it items; j jobs;
        on_hand NUMERIC; rsn TEXT; legacy BOOLEAN; rev_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO m FROM stock_movements WHERE id = p_movement_id FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการเคลื่อนไหวคลัง'; END IF;
  IF m.movement_type NOT IN ('transfer_from_job', 'return_from_job') OR m.qty <= 0 OR m.ref_request_id IS NULL THEN
    RAISE EXCEPTION 'ย้อนได้เฉพาะรายการคืนคลัง/โอนเข้าคลังจาก Job';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reversal_of = m.id) THEN
    RAISE EXCEPTION 'รายการนี้ถูกย้อนไปแล้ว';
  END IF;
  rsn := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF rsn IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ย้อน'; END IF;
  IF p_destination IS NULL OR p_destination NOT IN ('field', 'job') THEN
    RAISE EXCEPTION 'กรุณาเลือกว่าของอยู่ที่ไหนจริง (หน้างาน / ค้างที่ Job)';
  END IF;

  SELECT * INTO r FROM job_accessory_requests WHERE id = m.ref_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุต้นทางของรายการนี้'; END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  SELECT * INTO j FROM jobs WHERE id = r.job_id FOR UPDATE;
  PERFORM app_assert_job_owner(j);
  IF j.terminal_status = 'cancelled' THEN RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว', j.job_no; END IF;

  SELECT qty_on_hand INTO on_hand FROM accessory_stock WHERE item_id = r.item_id FOR UPDATE;
  IF COALESCE(on_hand, 0) < m.qty THEN
    RAISE EXCEPTION 'คลังคงเหลือ % เหลือ % % — น้อยกว่าที่จะย้อน % % (ของถูกเบิกไปใช้ที่ Job อื่นแล้ว ต้องปรับยอดเป็นเคส)',
      it.name, COALESCE(on_hand, 0), it.uom, m.qty, it.uom;
  END IF;

  legacy := r.status = 'returned';
  IF legacy THEN
    UPDATE job_accessory_requests SET status = 'issued', updated_at = now() WHERE id = r.id;
  ELSE
    IF COALESCE(r.qty_transferred, 0) < m.qty THEN
      RAISE EXCEPTION 'ยอดโอนคืนของบรรทัดนี้เหลือ % % — ย้อน % ไม่ได้', COALESCE(r.qty_transferred, 0), it.uom, m.qty;
    END IF;
    -- ใบที่เบิกครบ/ปิดแล้ว ห้ามมีของค้างที่ Job (บัญชีจะขัดกับสถานะใบ) ⇒ ต้องกลับไปเป็นของหน้างาน
    IF p_destination = 'job' AND j.terminal_status IS NOT NULL THEN
      RAISE EXCEPTION '% เบิกครบ/ปิดงานแล้ว — ของที่ย้อนต้องกลับไปเป็น "ออกหน้างานแล้ว"', j.job_no;
    END IF;
    UPDATE job_accessory_requests
       SET qty_transferred = qty_transferred - m.qty,
           qty_issued_to_service = COALESCE(qty_issued_to_service, 0)
                                   + CASE WHEN p_destination = 'field' THEN m.qty ELSE 0 END,
           updated_at = now()
     WHERE id = r.id;
  END IF;

  PERFORM app_set_stock_ctx('reverse_to_job', r.job_id, r.id,
    'ย้อนการคืน/โอนเข้าคลังของ ' || j.job_no || ' — ' || rsn, NULL);
  UPDATE accessory_stock SET qty_on_hand = qty_on_hand - m.qty, updated_at = now() WHERE item_id = r.item_id;
  SELECT id INTO rev_id FROM stock_movements
   WHERE ref_request_id = r.id AND movement_type = 'reverse_to_job' AND reversal_of IS NULL
   ORDER BY performed_at DESC LIMIT 1;
  UPDATE stock_movements SET reversal_of = m.id WHERE id = rev_id;

  PERFORM app_notify('stock_return_reversed',
    '↩️ ' || j.job_no || ' ย้อนการคืนคลัง ' || it.name || ' ' || m.qty || ' ' || it.uom ||
    ' — ของออกจากคลังคงเหลือ · ' || rsn, 'purchasing', r.job_id);
  PERFORM app_audit('accessory_stock', r.item_id, 'reverse_stock_return', actor.id,
    j.job_no || ' ย้อนการคืน/โอนเข้าคลัง ' || it.name || ' ' || m.qty || ' ' || it.uom ||
    CASE WHEN legacy THEN ' (รายการคืนทั้งบรรทัดแบบเก่า → กลับเป็นเบิกแล้ว)'
         WHEN p_destination = 'field' THEN ' → กลับเป็นของที่ออกหน้างานแล้ว'
         ELSE ' → กลับไปค้างที่ Job' END ||
    ' (ต้นทุนกลับเข้างาน ' || round(COALESCE(m.unit_cost, r.unit_price, 0) * m.qty, 2) || ' บาท) — ' || rsn);
END $$;

-- ---------- 8) Import ตรวจนับคลัง (ยอดนับจริง + ต้นทุน/หน่วย) ----------
-- p_rows = [{item_id, qty?, unit_cost?}] · qty = ยอดที่ต้องการให้เป็น (ไม่ใช่ยอดบวกเพิ่ม) · null = ไม่แตะ
CREATE OR REPLACE FUNCTION rpc_import_stock_count(p_rows JSONB, p_reason TEXT)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; e JSONB; it items; s accessory_stock; v_qty NUMERIC; v_cost NUMERIC;
        cur_qty NUMERIC; cur_cost NUMERIC; rsn TEXT; n INT := 0; parts TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['sales', 'purchasing']);   -- Division + Purchasing + Manage (สิทธิ์เดียวกับปรับยอดคลัง)
  rsn := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF rsn IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผล/รอบการตรวจนับ'; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'ไม่มีรายการที่จะนำเข้า';
  END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    SELECT * INTO it FROM items WHERE id = NULLIF(e->>'item_id', '')::UUID;
    IF it.id IS NULL THEN RAISE EXCEPTION 'ไม่พบวัสดุ %', COALESCE(e->>'item_id', '-'); END IF;
    v_qty  := NULLIF(e->>'qty', '')::NUMERIC;
    v_cost := NULLIF(e->>'unit_cost', '')::NUMERIC;
    IF v_qty IS NOT NULL AND v_qty < 0 THEN RAISE EXCEPTION '%: ยอดติดลบไม่ได้', it.name; END IF;
    IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION '%: ต้นทุนติดลบไม่ได้', it.name; END IF;

    SELECT * INTO s FROM accessory_stock WHERE item_id = it.id FOR UPDATE;
    cur_qty := COALESCE(s.qty_on_hand, 0);
    cur_cost := COALESCE(s.avg_unit_cost, 0);
    parts := '';

    IF v_qty IS NOT NULL AND v_qty <> cur_qty THEN
      IF v_qty > 0 THEN
        UPDATE items SET is_stockable_centrally = true WHERE id = it.id AND is_stockable_centrally = false;
      END IF;
      -- ต้นทุนไม่ส่งเข้า ctx — ต้นทุนแยกจัดการข้างล่าง (ยอดนับไม่ควรขยับค่าเฉลี่ยเอง)
      PERFORM app_set_stock_ctx('import_adjust', NULL, NULL, 'ตรวจนับคลัง — ' || rsn, NULL);
      INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost)
      VALUES (it.id, v_qty, COALESCE(v_cost, 0))
      ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand, updated_at = now();
      parts := parts || ' ยอด ' || cur_qty || ' → ' || v_qty || ' ' || it.uom;
    END IF;

    -- ต้นทุนถัวเฉลี่ยตั้งได้เฉพาะตอนมีของในคลัง (ของหมด = trigger รีเซ็ตเป็น 0 เสมอ)
    IF v_cost IS NOT NULL AND COALESCE(v_qty, cur_qty) > 0 AND v_cost <> cur_cost THEN
      UPDATE accessory_stock SET avg_unit_cost = v_cost, updated_at = now() WHERE item_id = it.id;
      parts := parts || ' ต้นทุน/หน่วย ' || round(cur_cost, 2) || ' → ' || v_cost || ' บาท';
    END IF;

    IF parts <> '' THEN
      n := n + 1;
      PERFORM app_audit('accessory_stock', it.id, 'import_stock_count', actor.id,
        'ตรวจนับคลัง ' || it.name || ':' || parts || ' (' || rsn || ')');
    END IF;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'ไม่มีรายการที่เปลี่ยนแปลง — ยอดและต้นทุนตรงกับระบบทั้งหมด'; END IF;
  RETURN n;
END $$;

-- ---------- 9) สิทธิ์เรียก ----------
REVOKE ALL ON FUNCTION public.app_acc_reserved_qty(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_acc_reserved_qty(UUID, BOOLEAN) TO authenticated;
DO $$
DECLARE sig TEXT;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'rpc_request_stock_return(UUID, TEXT, NUMERIC, TEXT)', 'rpc_cancel_stock_return(UUID)',
    'rpc_receive_stock_return(UUID, NUMERIC, TEXT)', 'rpc_reject_stock_return(UUID, TEXT)',
    'rpc_reverse_stock_movement(UUID, TEXT, TEXT)', 'rpc_import_stock_count(JSONB, TEXT)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', sig);
  END LOOP;
END $$;

-- ---------- 10) ตรวจผล ----------
DO $$
DECLARE src TEXT;
BEGIN
  IF to_regclass('public.stock_return_requests') IS NULL THEN RAISE EXCEPTION '0080: ไม่มีตาราง stock_return_requests'; END IF;
  IF has_table_privilege('authenticated', 'public.stock_return_requests', 'INSERT') THEN
    RAISE EXCEPTION '0080: authenticated เขียน stock_return_requests ตรงได้ — ต้องผ่าน RPC เท่านั้น';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_exec_issue_accessory';
  IF position('app_acc_reserved_qty' IN src) = 0 THEN
    RAISE EXCEPTION '0080: app_exec_issue_accessory ยังเบิกของที่จองรอตรวจรับได้';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_write_off_job_material';
  IF position('app_acc_reserved_qty' IN src) = 0 THEN
    RAISE EXCEPTION '0080: rpc_write_off_job_material ยังตัดจำหน่ายของที่จองรอตรวจรับได้';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_close_job_install';
  IF position('''project''' IN src) = 0 THEN RAISE EXCEPTION '0080: rpc_close_job_install ยังไม่เปิดให้ Project'; END IF;
  IF position('app_save_job_closeout' IN src) = 0 THEN RAISE EXCEPTION '0080: rpc_close_job_install หลุดด่านเอกสารรับมอบ (0079)'; END IF;

  -- ทางเข้าคลังขั้นเดียวต้องปิดแล้ว
  SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_transfer_job_material_to_stock';
  IF position('accessory_stock' IN src) > 0 THEN RAISE EXCEPTION '0080: rpc_transfer_job_material_to_stock ยังเข้าคลังได้ตรง'; END IF;
  SELECT pg_get_functiondef(p.oid) INTO src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_return_accessory';
  IF position('accessory_stock' IN src) > 0 THEN RAISE EXCEPTION '0080: rpc_return_accessory ยังเข้าคลังได้ตรง'; END IF;

  RAISE NOTICE '0080: OK — คืน/โอนเข้าคลังผ่าน Purchasing ตรวจรับ · ย้อนการโอนได้ · ตรวจนับคลัง · Project ปิดงานได้';
END $$;
