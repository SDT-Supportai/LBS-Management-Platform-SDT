-- =============================================================================
-- 0088 — 💳 งวดเงิน: เพิ่ม Order Num + Pack ID (กรอกก่อน Invoice No.) (2026-11-05)
--
-- ที่มา (ผู้ใช้ขอ 2026-11-05): ฟอร์ม "เพิ่มงวด" (Advance → Progress/Delivery → PAC/Retention)
--   ต้องมีช่อง Order Num และ Pack ID อยู่ก่อน Invoice No. — ลำดับเอกสารจริง: สั่งขาย → ส่งของ → แจ้งหนี้
--   ไม่บังคับกรอก (งวด Advance มักยังไม่มีการส่งของ)
--
-- signature เปลี่ยน ⇒ DROP ตัวเดิมก่อน (ไม่งั้น PostgREST เจอ 2 overload แล้วเลือกไม่ถูก)
--   พารามิเตอร์ใหม่อยู่ท้ายสุดและ DEFAULT NULL ⇒ client เก่าที่ยังไม่ส่งสองช่องนี้ก็ยังเรียกได้
--   rpc_add_job_payment: body จาก 0076 (คืน id) · rpc_update_job_payment: body จาก 0044 (ไม่มีใครแก้หลังจากนั้น)
--
-- demo sync: src/data/logic.ts (PaymentInput / addJobPayment / updateJobPayment)
-- **รันก่อน push** (หน้าจอใหม่ส่ง p_order_num / p_pack_id มา) · idempotent
-- =============================================================================

ALTER TABLE job_payments ADD COLUMN IF NOT EXISTS order_num TEXT;
ALTER TABLE job_payments ADD COLUMN IF NOT EXISTS pack_id TEXT;
COMMENT ON COLUMN job_payments.order_num IS '0088 — Order Num (เลขที่ใบสั่งขาย) · กรอกก่อน Invoice No. · ไม่บังคับ';
COMMENT ON COLUMN job_payments.pack_id IS '0088 — Pack ID (เลขที่ใบส่งของ / packing slip) · ไม่บังคับ';

-- ---------- rpc_add_job_payment (+ order_num, pack_id) ----------
DROP FUNCTION IF EXISTS rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT);
CREATE OR REPLACE FUNCTION rpc_add_job_payment(
  p_job_id      UUID,
  p_type        TEXT,
  p_invoice_no  TEXT DEFAULT NULL,
  p_invoice_date DATE DEFAULT NULL,
  p_percent     NUMERIC DEFAULT NULL,
  p_amount      NUMERIC DEFAULT NULL,
  p_paid_at     DATE DEFAULT NULL,
  p_note        TEXT DEFAULT NULL,
  p_order_num   TEXT DEFAULT NULL,         -- 0088
  p_pack_id     TEXT DEFAULT NULL          -- 0088
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; amt NUMERIC; nextseq INT; new_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY['project']);           -- Project + Manage
  j := app_assert_job_cost_editable(p_job_id);          -- ล็อกแถว + ไม่ใช่ Job ที่ยกเลิก + เจ้าของงาน (0042)
  IF p_type NOT IN ('advance', 'progress', 'retention') THEN
    RAISE EXCEPTION 'ประเภทงวดเงินไม่ถูกต้อง';
  END IF;
  amt := app_payment_amount(j, p_percent, p_amount);

  SELECT COALESCE(MAX(seq), 0) + 1 INTO nextseq
    FROM job_payments WHERE job_id = p_job_id AND pay_type = p_type;

  INSERT INTO job_payments (job_id, pay_type, seq, order_num, pack_id, invoice_no, invoice_date,
                            percent, amount, base_sale_price, paid_at, note, created_by)
  VALUES (p_job_id, p_type, nextseq,
          NULLIF(btrim(COALESCE(p_order_num, '')), ''), NULLIF(btrim(COALESCE(p_pack_id, '')), ''),
          NULLIF(btrim(COALESCE(p_invoice_no, '')), ''), p_invoice_date,
          p_percent, amt, j.budget_sale_price, p_paid_at,
          NULLIF(btrim(COALESCE(p_note, '')), ''), actor.id)
  RETURNING id INTO new_id;

  PERFORM app_audit('job_payment', p_job_id, 'add_job_payment', actor.id,
    j.job_no || ' บันทึกงวด ' || p_type || ' #' || nextseq ||
    ' · Order ' || COALESCE(NULLIF(btrim(COALESCE(p_order_num, '')), ''), '-') ||
    ' · Pack ' || COALESCE(NULLIF(btrim(COALESCE(p_pack_id, '')), ''), '-') ||
    ' · Invoice ' || COALESCE(p_invoice_no, '-') ||
    ' · ' || COALESCE(p_percent::TEXT || '%', 'ยอดกรอกเอง') || ' = ' || round(amt, 2) || ' ฿');

  RETURN new_id;
END $$;

-- ---------- rpc_update_job_payment (+ order_num, pack_id) ----------
DROP FUNCTION IF EXISTS rpc_update_job_payment(UUID, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT);
CREATE OR REPLACE FUNCTION rpc_update_job_payment(
  p_payment_id  UUID,
  p_invoice_no  TEXT DEFAULT NULL,
  p_invoice_date DATE DEFAULT NULL,
  p_percent     NUMERIC DEFAULT NULL,
  p_amount      NUMERIC DEFAULT NULL,
  p_paid_at     DATE DEFAULT NULL,
  p_note        TEXT DEFAULT NULL,
  p_order_num   TEXT DEFAULT NULL,         -- 0088
  p_pack_id     TEXT DEFAULT NULL          -- 0088
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pm job_payments; j jobs; amt NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO pm FROM job_payments WHERE id = p_payment_id FOR UPDATE;
  IF pm.id IS NULL THEN RAISE EXCEPTION 'ไม่พบงวดเงินนี้'; END IF;
  j := app_assert_job_cost_editable(pm.job_id);
  amt := app_payment_amount(j, p_percent, p_amount);

  UPDATE job_payments SET
    order_num       = NULLIF(btrim(COALESCE(p_order_num, '')), ''),
    pack_id         = NULLIF(btrim(COALESCE(p_pack_id, '')), ''),
    invoice_no      = NULLIF(btrim(COALESCE(p_invoice_no, '')), ''),
    invoice_date    = p_invoice_date,
    percent         = p_percent,
    amount          = amt,
    base_sale_price = j.budget_sale_price,   -- คิดใหม่จากราคาขายปัจจุบัน = ยืนยันยอดใหม่
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
    CASE WHEN p_paid_at IS NOT NULL THEN ' · รับเงิน ' || p_paid_at ELSE ' · ยังไม่รับเงิน' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_update_job_payment(UUID, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_job_payment(UUID, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT, TEXT, TEXT) TO authenticated;

-- ---------- ตรวจผล ----------
DO $$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'job_payments' AND column_name = 'order_num')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'job_payments' AND column_name = 'pack_id') THEN
    RAISE EXCEPTION '0088: ไม่มีคอลัมน์ order_num / pack_id';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname IN ('rpc_add_job_payment', 'rpc_update_job_payment');
  IF n <> 2 THEN RAISE EXCEPTION '0088: rpc งวดเงินมี % ตัว (ต้อง 2 — signature เก่าค้างจะทำให้ PostgREST เลือกไม่ถูก)', n; END IF;
  IF (SELECT prorettype::regtype::TEXT FROM pg_proc WHERE proname = 'rpc_add_job_payment') <> 'uuid' THEN
    RAISE EXCEPTION '0088: rpc_add_job_payment ต้องคืน uuid (0076) — โมดัลแนบไฟล์ตอนสร้างงวดใหม่ต้องใช้';
  END IF;
  RAISE NOTICE '0088: OK — งวดเงินมีช่อง Order Num + Pack ID แล้ว';
END $$;
