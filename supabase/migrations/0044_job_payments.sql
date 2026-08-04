-- =====================================================================
-- 0044: Payment ต่อ Job — Advance / Progress or Delivery / PAC or Retention (2026-08-04)
--  ที่มา: ต้องบันทึกใบแจ้งหนี้แต่ละงวด (Invoice No. / Date / % → ยอดเงิน) บนหน้า Job
--    วางเป็นพาเนลพับ "ก่อน" รายละเอียดต้นทุน 7 หมวด ในการ์ด Project Budget เดิม
--  มติ (2026-08-04):
--    - **หลายงวดต่อประเภทได้** (Progress 1, 2, 3…) → ตารางแยก ไม่ใช่คอลัมน์บน jobs
--    - สิทธิ์: **Project (เจ้าของงาน ตาม 0042) + Manage**
--  หลักการเก็บเงิน (สำคัญ):
--    1) เก็บ **ทั้ง percent และ amount** — amount freeze ณ เวลาบันทึก พร้อม base_sale_price
--       ถ้าเก็บแค่ % ยอดในใบแจ้งหนี้ที่ออกไปแล้วจะขยับเองเมื่อมีคนแก้ราคาขาย (0023 ให้ Manage
--       แก้ย้อนหลังได้แม้ Job ล็อก) = เลขไม่ตรงกับเอกสารจริง · UI เตือนถ้า base เปลี่ยน
--    2) guard = **app_assert_job_cost_editable** ไม่ใช่ app_assert_job_editable
--       เพราะ PAC/Retention เกิด "หลัง" ปิดงานติดตั้งเสมอ — ถ้าใช้ guard ตัวปกติจะบันทึก
--       งวดสุดท้ายไม่ได้เลย (เหตุผลเดียวกับที่ 0037 แยก guard ตัวนี้ไว้แก้ราคาจริงย้อนหลัง)
--       และ guard ตัวนี้เรียก app_assert_job_owner (0042) ให้อยู่แล้ว = ได้สิทธิ์เจ้าของงานฟรี
--    3) ไม่ยิง app_notify — การออกใบแจ้งหนี้เกิดถี่และเข้ากลุ่ม LINE รวม (ถ้าต้องการแจ้ง Division
--       เพิ่ม app_notify('payment_recorded', …, 'sales', job_id) บรรทัดเดียวได้ทีหลัง)
--  ไม่บล็อกกรณี Σ งวด > ราคาขาย (variation order/งานเพิ่มมีจริง) — UI เตือนเป็นสีแทน
--  demo sync ที่ src/data/logic.ts (addJobPayment/updateJobPayment/deleteJobPayment)
--  รันหลัง 0043 · idempotent
-- =====================================================================

-- ---------- 1) schema ----------
CREATE TABLE IF NOT EXISTS job_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id),
  pay_type        VARCHAR(20) NOT NULL CHECK (pay_type IN ('advance', 'progress', 'retention')),
  seq             INT NOT NULL DEFAULT 1,          -- งวดที่ในประเภทนั้น (Progress 1, 2, 3…)
  invoice_no      VARCHAR(50),
  invoice_date    DATE,
  percent         NUMERIC,                          -- % ของราคาขาย (NULL = กรอกยอดเงินตรงๆ)
  amount          NUMERIC NOT NULL CHECK (amount >= 0),   -- ยอดเงิน freeze ณ เวลาบันทึก
  base_sale_price NUMERIC,                          -- ราคาขาย ณ เวลาบันทึก (ตรวจว่าเปลี่ยนภายหลังไหม)
  paid_at         DATE,                             -- รับเงินแล้วเมื่อ (NULL = รอรับเงิน)
  note            TEXT,
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_payments_job ON job_payments(job_id);

ALTER TABLE job_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_all ON job_payments;
CREATE POLICY read_all ON job_payments FOR SELECT TO authenticated USING (true);
-- write ตัวจริงอยู่ที่ RPC (SECURITY DEFINER) — policy นี้กันคนยิง PostgREST ตรง
DROP POLICY IF EXISTS project_payments ON job_payments;
CREATE POLICY project_payments ON job_payments FOR ALL TO authenticated
  USING (my_department() IN ('project', 'admin')) WITH CHECK (my_department() IN ('project', 'admin'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'job_payments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE job_payments;
  END IF;
END $$;

-- ---------- 2) helper: % → ยอดเงิน ----------
CREATE OR REPLACE FUNCTION app_payment_amount(j jobs, p_percent NUMERIC, p_amount NUMERIC)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_percent IS NOT NULL THEN
    IF p_percent <= 0 OR p_percent > 100 THEN
      RAISE EXCEPTION 'เปอร์เซ็นต์ต้องอยู่ระหว่าง 0–100 (ได้รับ %)', p_percent;
    END IF;
    IF j.budget_sale_price IS NULL THEN
      RAISE EXCEPTION 'ยังไม่ได้กรอกราคาขายใน Project Budget ของ % — ใส่ %% คำนวณยอดไม่ได้ (กรอกยอดเงินตรงๆ ได้)', j.job_no;
    END IF;
    RETURN round(j.budget_sale_price * p_percent / 100, 2);
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'กรุณาระบุ %% ของราคาขาย หรือยอดเงิน';
  END IF;
  RETURN round(p_amount, 2);
END $$;

-- ---------- 3) บันทึก / แก้ / ลบ งวดเงิน ----------
CREATE OR REPLACE FUNCTION rpc_add_job_payment(
  p_job_id      UUID,
  p_type        TEXT,
  p_invoice_no  TEXT DEFAULT NULL,
  p_invoice_date DATE DEFAULT NULL,
  p_percent     NUMERIC DEFAULT NULL,
  p_amount      NUMERIC DEFAULT NULL,
  p_paid_at     DATE DEFAULT NULL,
  p_note        TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; amt NUMERIC; nextseq INT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);           -- Project + Manage
  j := app_assert_job_cost_editable(p_job_id);          -- ล็อกแถว + ไม่ใช่ Job ที่ยกเลิก + เจ้าของงาน (0042)
  IF p_type NOT IN ('advance', 'progress', 'retention') THEN
    RAISE EXCEPTION 'ประเภทงวดเงินไม่ถูกต้อง';
  END IF;
  amt := app_payment_amount(j, p_percent, p_amount);

  SELECT COALESCE(MAX(seq), 0) + 1 INTO nextseq
    FROM job_payments WHERE job_id = p_job_id AND pay_type = p_type;

  INSERT INTO job_payments (job_id, pay_type, seq, invoice_no, invoice_date,
                            percent, amount, base_sale_price, paid_at, note, created_by)
  VALUES (p_job_id, p_type, nextseq,
          NULLIF(btrim(COALESCE(p_invoice_no, '')), ''), p_invoice_date,
          p_percent, amt, j.budget_sale_price, p_paid_at,
          NULLIF(btrim(COALESCE(p_note, '')), ''), actor.id);

  PERFORM app_audit('job_payment', p_job_id, 'add_job_payment', actor.id,
    j.job_no || ' บันทึกงวด ' || p_type || ' #' || nextseq ||
    ' · Invoice ' || COALESCE(p_invoice_no, '-') ||
    ' · ' || COALESCE(p_percent::TEXT || '%', 'ยอดกรอกเอง') || ' = ' || round(amt, 2) || ' ฿');
END $$;

CREATE OR REPLACE FUNCTION rpc_update_job_payment(
  p_payment_id  UUID,
  p_invoice_no  TEXT DEFAULT NULL,
  p_invoice_date DATE DEFAULT NULL,
  p_percent     NUMERIC DEFAULT NULL,
  p_amount      NUMERIC DEFAULT NULL,
  p_paid_at     DATE DEFAULT NULL,
  p_note        TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pm job_payments; j jobs; amt NUMERIC;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO pm FROM job_payments WHERE id = p_payment_id FOR UPDATE;
  IF pm.id IS NULL THEN RAISE EXCEPTION 'ไม่พบงวดเงินนี้'; END IF;
  j := app_assert_job_cost_editable(pm.job_id);
  amt := app_payment_amount(j, p_percent, p_amount);

  UPDATE job_payments SET
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
    ' · Invoice ' || COALESCE(p_invoice_no, '-') || ' · ' ||
    round(pm.amount, 2) || ' → ' || round(amt, 2) || ' ฿' ||
    CASE WHEN p_paid_at IS NOT NULL THEN ' · รับเงิน ' || p_paid_at ELSE ' · ยังไม่รับเงิน' END);
END $$;

CREATE OR REPLACE FUNCTION rpc_delete_job_payment(p_payment_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pm job_payments; j jobs;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO pm FROM job_payments WHERE id = p_payment_id FOR UPDATE;
  IF pm.id IS NULL THEN RAISE EXCEPTION 'ไม่พบงวดเงินนี้'; END IF;
  j := app_assert_job_cost_editable(pm.job_id);
  IF pm.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'งวดนี้บันทึกว่ารับเงินแล้ว (%) ลบไม่ได้ — ถ้าบันทึกผิดให้แก้ไขแล้วล้างวันที่รับเงินก่อน', pm.paid_at;
  END IF;

  DELETE FROM job_payments WHERE id = p_payment_id;
  PERFORM app_audit('job_payment', pm.job_id, 'delete_job_payment', actor.id,
    j.job_no || ' ลบงวด ' || pm.pay_type || ' #' || pm.seq ||
    ' (Invoice ' || COALESCE(pm.invoice_no, '-') || ' · ' || round(pm.amount, 2) || ' ฿)');
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_add_job_payment(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_job_payment(UUID, TEXT, DATE, NUMERIC, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_job_payment(UUID) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0044 OK — Payment ต่อ Job (Advance/Progress/PAC-Retention หลายงวดต่อประเภท) พร้อมใช้งาน'; END $$;
