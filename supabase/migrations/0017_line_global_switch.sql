-- =====================================================================
-- 0017: LINE notification transport fixes (2026-07-19) — จาก code review flow แจ้งเตือน
--  Fix 1) สวิตช์เปิดแจ้งเตือน LINE เป็น "global ใน DB" (เดิมอยู่ localStorage ต่อเบราว์เซอร์
--         → เครื่องที่สวิตช์ปิด (default) mark pending เป็น 'off' ฆ่าข้อความของทั้งระบบ)
--         ตาราง app_settings + rpc_set_line_enabled (admin เท่านั้น — สวิตช์อยู่ Dev Settings)
--  Fix 2) กันส่งซ้ำ: rpc_claim_line_pending — atomic claim (UPDATE ... RETURNING)
--         client ที่ claim ได้เท่านั้นเป็นคนส่ง / สวิตช์ปิด = server mark 'off' เอง (ที่เดียว)
--  Fix 3) rpc_set_notification_line_status: ยอม 'sent'→'failed' (client mark failed หลัง claim)
--  Feature) เบิกวัสดุจากสต็อกกลาง → แจ้ง Division (ยอดคงเหลือลด) — recreate
--         rpc_add_accessory_request (เนื้อเดิมจาก 0008 + notify, signature เดิม)
--  หมายเหตุ: /line-notify ใส่ auth ฝั่ง Cloudflare function (ไม่ใช่ migration นี้)
--  demo mode แก้คู่กันที่ src/data/logic.ts · รันหลัง 0016 (idempotent)
-- =====================================================================

-- ---------- 1) Global settings ----------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES ('line_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON app_settings;
CREATE POLICY read_all ON app_settings FOR SELECT TO authenticated USING (true);
-- เขียนผ่าน RPC เท่านั้น

CREATE OR REPLACE FUNCTION rpc_set_line_enabled(p_enabled BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);   -- admin (Manage) เท่านั้น — สวิตช์อยู่ใน Dev Settings
  INSERT INTO app_settings (key, value) VALUES ('line_enabled', to_jsonb(COALESCE(p_enabled, false)))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  PERFORM app_audit('app_settings', actor.id, 'set_line_enabled', actor.id,
    (CASE WHEN p_enabled THEN 'เปิด' ELSE 'ปิด' END) || 'การแจ้งเตือนเข้า LINE group (ทั้งระบบ)');
END $$;

-- ---------- 2) Atomic claim — คนเดียวส่ง ไม่ซ้ำ ----------
-- สวิตช์ปิด: server mark pending → 'off' (ตัดสินที่เดียว ไม่มี race ระหว่างเครื่อง)
-- สวิตช์เปิด: claim pending → 'sent' แล้วคืนรายการให้ client เป็นคนยิง /line-notify
--   (ถ้ายิง fail → client mark 'failed' ผ่าน rpc_set_notification_line_status)
CREATE OR REPLACE FUNCTION rpc_claim_line_pending()
RETURNS TABLE(id UUID, message TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE enabled BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบก่อน'; END IF;
  SELECT (value #>> '{}')::BOOLEAN INTO enabled FROM app_settings WHERE key = 'line_enabled';
  IF NOT COALESCE(enabled, false) THEN
    UPDATE notifications SET line_status = 'off' WHERE line_status = 'pending';
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE notifications SET line_status = 'sent'
  WHERE line_status = 'pending'
  RETURNING notifications.id, notifications.message;
END $$;

-- ---------- 3) ยอม mark 'failed' หลัง claim (เดิมแก้ได้เฉพาะ pending) ----------
CREATE OR REPLACE FUNCTION rpc_set_notification_line_status(p_ids UUID[], p_status TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบก่อน'; END IF;
  IF p_status NOT IN ('off', 'sent', 'failed') THEN RAISE EXCEPTION 'สถานะไม่ถูกต้อง'; END IF;
  UPDATE notifications SET line_status = p_status
  WHERE id = ANY(p_ids) AND line_status IN ('pending', 'sent');
END $$;

-- ---------- 4) เบิกสต็อกกลาง → แจ้ง Division (recreate จาก 0008 + notify) ----------
CREATE OR REPLACE FUNCTION rpc_add_accessory_request(p_job_id UUID, p_item_id UUID, p_qty NUMERIC, p_source TEXT,
                                                     p_unit_price NUMERIC DEFAULT NULL, p_phase_budget TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; it items; onhand NUMERIC; rid UUID; ph TEXT; before_status TEXT; remaining NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable(p_job_id);
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
    UPDATE accessory_stock SET qty_on_hand = qty_on_hand - p_qty, updated_at = now()
    WHERE item_id = p_item_id AND qty_on_hand >= p_qty
    RETURNING qty_on_hand INTO remaining;
    IF NOT FOUND THEN
      SELECT COALESCE(qty_on_hand, 0) INTO onhand FROM accessory_stock WHERE item_id = p_item_id;
      RAISE EXCEPTION 'สต็อกกลาง % คงเหลือ % % ไม่พอ (ขอ %) — เปลี่ยนเป็นสั่งซื้อผ่าน Purchasing ได้',
        it.name, COALESCE(onhand, 0), it.uom, p_qty;
    END IF;
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, phase_budget, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, p_unit_price, ph, 'central_stock', 'issued', actor.id) RETURNING id INTO rid;
    -- ใหม่ (0017): แจ้ง Division เจ้าของสต็อก — ยอดคงเหลือลด
    PERFORM app_notify('accessory_issued',
      '📤 ' || j.job_no || ' เบิก ' || it.name || ' ' || p_qty || ' ' || it.uom
      || ' จากสต็อกกลาง (คงเหลือ ' || remaining || ' ' || it.uom || ')', 'sales', p_job_id);
    PERFORM app_notify_if_ready(p_job_id, before_status);
    PERFORM app_audit('job_accessory_request', rid, 'issue_accessory_from_stock', actor.id,
      j.job_no || ' เบิก ' || it.name || ' ' || p_qty || ' ' || it.uom || ' จากสต็อกกลาง');
  ELSE
    INSERT INTO job_accessory_requests (job_id, item_id, qty_requested, unit_price, phase_budget, source, status, requested_by)
    VALUES (p_job_id, p_item_id, p_qty, p_unit_price, ph, 'purchasing', 'pending', actor.id) RETURNING id INTO rid;
    PERFORM app_audit('job_accessory_request', rid, 'request_accessory_purchase', actor.id,
      j.job_no || ' ขอซื้อ ' || it.name || ' ' || p_qty || ' ' || it.uom || ' (รอออก PR)');
  END IF;
END $$;

-- ---------- 5) Realtime ----------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE app_settings;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
