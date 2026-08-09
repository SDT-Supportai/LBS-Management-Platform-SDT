-- =====================================================================
-- 0052: แก้ตาม code review (2026-08-08)
--   1) Import: ช่องระยะขนส่งที่เว้นว่าง = **คงค่าเดิม** (เดิม 0051 ล้างเป็นค่ามาตรฐาน 60)
--      → ตรงกับกติกาข้อ 1 ที่เขียนไว้ในชีต "วิธีกรอก" และตรงกับ demo (logic.ts) แล้ว
--   2) ระยะขนส่งบังคับ 45–60 วัน (เดิมยอมรับ 1–365) + CHECK ที่ DB
--   3) **ห้ามเบิกให้ Service ถ้า Job ถือ LBS ที่ของยังไม่ถึงคลัง** (Status = Pending)
--
--  ⚠️ ข้อ 1 มีกับดัก: 0051 ให้ app_unit_lead() คืน NULL เมื่อค่า = 60 (ยุบเป็น "ค่ามาตรฐาน")
--     พอรวมกับกฎ "NULL = คงค่าเดิม" จะกลายเป็นว่า **กรอก 60 เพื่อรีเซ็ตกลับค่ามาตรฐานไม่ได้**
--     (ล็อตที่ตั้ง 45 ไว้จะติดอยู่ที่ 45 ตลอด) → 0052 แยก 2 ความหมายออกจากกัน:
--       app_unit_lead()  = ค่าที่ไฟล์กรอกมาจริง (NULL = ไม่ได้กรอก)
--       NULLIF(x, 60)    = แปลงเป็นค่าที่เก็บ ตอนเขียนลงคอลัมน์เท่านั้น
--
--  ⚠️ ข้อ 3 แก้ app_exec_issue_job / rpc_request_approval ด้วย **app_swap_guard (patch บรรทัดเดียว)**
--     ห้าม CREATE OR REPLACE ทั้งก้อน — 0031 patch ข้อความแจ้งเตือนใน app_exec_issue_job ไว้
--     (บทเรียน §9.5: recreate ด้วย body เก่า = revert 0031 เงียบๆ) และ 0041 patch rpc_request_approval
--
--  รันหลัง 0051 · idempotent
-- =====================================================================

-- ---------- 1) ระยะขนส่งบังคับ 45–60 ----------
-- ค่าที่หลุดช่วง (import เก่ายอมรับ 1–365) ตั้งกลับเป็น NULL = ใช้ค่ามาตรฐาน 60
DO $$
DECLARE fixed INT;
BEGIN
  UPDATE lbs_units SET eta_lead_days = NULL
   WHERE eta_lead_days IS NOT NULL AND eta_lead_days NOT BETWEEN 45 AND 60;
  GET DIAGNOSTICS fixed = ROW_COUNT;
  IF fixed > 0 THEN
    RAISE NOTICE '0052: ตั้ง eta_lead_days = NULL (ค่ามาตรฐาน 60) ให้ % เครื่องที่ค่าหลุดช่วง 45–60', fixed;
  END IF;
END $$;

ALTER TABLE lbs_units DROP CONSTRAINT IF EXISTS lbs_units_eta_lead_days_check;
ALTER TABLE lbs_units ADD CONSTRAINT lbs_units_eta_lead_days_check
  CHECK (eta_lead_days IS NULL OR (eta_lead_days BETWEEN 45 AND 60));

-- app_unit_lead: คืน "ค่าที่กรอกมา" ตามจริง (ไม่ยุบ 60) เพื่อให้แยก "ไม่ได้กรอก" ออกจาก "กรอก 60"
CREATE OR REPLACE FUNCTION app_unit_lead(u JSONB) RETURNS INT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v INT;
BEGIN
  v := NULLIF(btrim(COALESCE(u->>'lead_days', '')), '')::INT;
  IF v IS NULL THEN RETURN NULL; END IF;                      -- ไม่ได้กรอก
  IF v < 45 OR v > 60 THEN
    RAISE EXCEPTION 'ระยะขนส่ง (วัน) ต้องอยู่ระหว่าง 45–60 (ได้รับ %)', v;
  END IF;
  RETURN v;
END $$;

-- ---------- 2) rpc_update_unit_plan: ช่วง 45–60 ----------
CREATE OR REPLACE FUNCTION rpc_update_unit_plan(
  p_unit_id         UUID,
  p_unit_cost       NUMERIC DEFAULT NULL,
  p_customer_name   TEXT    DEFAULT NULL,
  p_contact_phone   TEXT    DEFAULT NULL,
  p_install_location TEXT   DEFAULT NULL,
  p_plan_po_receipt DATE    DEFAULT NULL,
  p_plan_delivery   DATE    DEFAULT NULL,
  p_fob_date        DATE    DEFAULT NULL,
  p_lead_days       INT     DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; u lbs_units; s project_stocks; v_eta DATE; v_lead INT;
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
  IF p_lead_days IS NOT NULL AND (p_lead_days < 45 OR p_lead_days > 60) THEN
    RAISE EXCEPTION 'ระยะขนส่ง (วัน) ต้องอยู่ระหว่าง 45–60';
  END IF;

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;
  -- ระยะขนส่งมีความหมายเฉพาะเมื่อมี FOB · เท่าค่ามาตรฐาน = เก็บ NULL
  v_lead := CASE WHEN p_fob_date IS NULL THEN NULL ELSE NULLIF(p_lead_days, 60) END;
  v_eta := CASE WHEN p_fob_date IS NOT NULL THEN p_fob_date + COALESCE(v_lead, 60) ELSE p_plan_po_receipt END;

  UPDATE lbs_units SET
    unit_cost             = p_unit_cost,
    plan_customer_name    = NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
    plan_contact_phone    = NULLIF(btrim(COALESCE(p_contact_phone, '')), ''),
    plan_install_location = NULLIF(btrim(COALESCE(p_install_location, '')), ''),
    fob_date              = p_fob_date,
    eta_lead_days         = v_lead,
    plan_po_receipt_date  = CASE WHEN p_fob_date IS NOT NULL THEN NULL ELSE p_plan_po_receipt END,
    plan_delivery_date    = p_plan_delivery,
    updated_at            = now()
  WHERE id = p_unit_id;

  PERFORM app_audit('lbs_unit', p_unit_id, 'update_unit_plan', actor.id,
    COALESCE(s.stock_no, '') || ' · ' || u.serial_lvb || '/' || COALESCE(u.serial_om, '-') ||
    ' → ต้นทุน ' || COALESCE(round(p_unit_cost, 2)::TEXT, '-') ||
    ' ฿ · ลูกค้า(แผน) ' || COALESCE(p_customer_name, '-') ||
    ' · FOB ' || COALESCE(p_fob_date::TEXT, '-') || ' +' || COALESCE(v_lead, 60) || ' วัน' ||
    ' · ETA to WH ' || COALESCE(v_eta::TEXT, '-') ||
    ' · Plan Delivery ' || COALESCE(p_plan_delivery::TEXT, '-'));
END $$;

REVOKE ALL ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE, INT) TO authenticated;

-- ---------- 3) rpc_set_stock_fob: ช่วง 45–60 ----------
CREATE OR REPLACE FUNCTION rpc_set_stock_fob(
  p_stock_id UUID, p_fob_date DATE, p_lead_days INT DEFAULT NULL, p_overwrite BOOLEAN DEFAULT FALSE
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; cnt INT; v_lead INT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF p_fob_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุ FOB date'; END IF;
  IF p_lead_days IS NOT NULL AND (p_lead_days < 45 OR p_lead_days > 60) THEN
    RAISE EXCEPTION 'ระยะขนส่ง (วัน) ต้องอยู่ระหว่าง 45–60';
  END IF;
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  v_lead := NULLIF(p_lead_days, 60);

  UPDATE lbs_units SET
    fob_date             = p_fob_date,
    eta_lead_days        = v_lead,
    plan_po_receipt_date = NULL,
    updated_at           = now()
  WHERE project_stock_id = p_stock_id
    AND status <> 'issued'
    AND (COALESCE(p_overwrite, FALSE) OR fob_date IS NULL)
    AND (fob_date IS DISTINCT FROM p_fob_date OR eta_lead_days IS DISTINCT FROM v_lead);
  GET DIAGNOSTICS cnt = ROW_COUNT;

  IF cnt = 0 THEN
    RAISE EXCEPTION 'ไม่มีเครื่องที่ต้องอัพเดท (ทุกเครื่องมีค่านี้อยู่แล้ว หรือถูกเบิกไปหมดแล้ว)';
  END IF;

  PERFORM app_audit('project_stock', p_stock_id, 'set_stock_fob', actor.id,
    'ตั้ง FOB date ' || p_fob_date::TEXT || ' +' || COALESCE(v_lead, 60) || ' วัน ให้ ' || s.stock_no ||
    ' จำนวน ' || cnt || ' เครื่อง (ETA to WH = ' || (p_fob_date + COALESCE(v_lead, 60))::TEXT || ')' ||
    CASE WHEN COALESCE(p_overwrite, FALSE) THEN ' · ทับค่าเดิม' ELSE ' · เฉพาะเครื่องที่ยังว่าง' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_set_stock_fob(UUID, DATE, INT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_stock_fob(UUID, DATE, INT, BOOLEAN) TO authenticated;

-- ---------- 4) Import: เว้นว่าง = คงค่าเดิม (patch 2 บรรทัดในฟังก์ชันเดิม) ----------
-- 0051 สร้าง rpc_import_units_to_stock ขึ้นใหม่ทั้งก้อน (ไม่ได้ถูก 0031 patch ต่อ) จึง replace ได้ปลอดภัย
DO $$
DECLARE def TEXT; foid OID;
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid) INTO foid, def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rpc_import_units_to_stock';
  IF foid IS NULL THEN RAISE EXCEPTION '0052: ไม่พบ rpc_import_units_to_stock — ต้องรัน 0051 ก่อน'; END IF;

  -- ขา UPDATE: NULL (ไม่ได้กรอก) = คงค่าเดิม · กรอกมา = ใช้ค่าใหม่ (60 → NULL = ค่ามาตรฐาน)
  IF position('eta_lead_days        = CASE WHEN v_fob IS NOT NULL THEN v_lead ELSE eta_lead_days END,' IN def) > 0 THEN
    def := replace(def,
      'eta_lead_days        = CASE WHEN v_fob IS NOT NULL THEN v_lead ELSE eta_lead_days END,',
      'eta_lead_days        = CASE WHEN v_fob IS NULL OR v_lead IS NULL THEN eta_lead_days ELSE NULLIF(v_lead, 60) END,');
  END IF;
  -- ขา INSERT: เครื่องใหม่ไม่มีค่าเดิมให้คง — แค่ยุบ 60 → NULL
  IF position('CASE WHEN v_fob IS NOT NULL THEN app_unit_lead(u) ELSE NULL END,' IN def) > 0 THEN
    def := replace(def,
      'CASE WHEN v_fob IS NOT NULL THEN app_unit_lead(u) ELSE NULL END,',
      'CASE WHEN v_fob IS NOT NULL THEN NULLIF(app_unit_lead(u), 60) ELSE NULL END,');
  END IF;
  EXECUTE def;
END $$;

-- ---------- 5) ห้ามเบิกเมื่อของยังไม่ถึงคลัง ----------
-- นับเฉพาะเครื่องที่ "ยืนยันได้ว่ายังไม่ถึง" (มี ETA และ ETA > วันนี้)
-- ⚠️ เครื่องที่ยังไม่ระบุ ETA ('?') ไม่บล็อก — "ไม่รู้" ไม่ใช่ "รู้ว่ายังไม่มา"
--    ถ้าบล็อกด้วยจะเบิกงานเดิมทั้งระบบไม่ได้เลย (ของเก่ายังไม่มีใครกรอก FOB)
CREATE OR REPLACE FUNCTION app_assert_job_eta_ready(p_job_id UUID) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE cnt INT; worst DATE; sample TEXT; jno TEXT;
BEGIN
  SELECT count(*), max(eta), string_agg(serial_lvb, ', ' ORDER BY eta) INTO cnt, worst, sample
  FROM (
    SELECT serial_lvb,
           CASE WHEN fob_date IS NOT NULL THEN fob_date + COALESCE(eta_lead_days, 60)
                ELSE plan_po_receipt_date END AS eta
      FROM lbs_units
     WHERE job_id = p_job_id AND status = 'allocated'
  ) x
  WHERE eta IS NOT NULL AND eta > CURRENT_DATE;

  IF COALESCE(cnt, 0) = 0 THEN RETURN; END IF;
  SELECT job_no INTO jno FROM jobs WHERE id = p_job_id;
  RAISE EXCEPTION '%: ยังเบิกให้ Service ไม่ได้ — มี LBS % เครื่องที่ของยังไม่เข้าคลัง (Status = Pending · ETA ล่าสุด %) เช่น %',
    COALESCE(jno, '-'), cnt, worst, left(sample, 120);
END $$;

GRANT EXECUTE ON FUNCTION public.app_assert_job_eta_ready(UUID) TO authenticated;

-- แทรก guard เข้า 2 ฟังก์ชันเดิมแบบ patch บรรทัดเดียว
--   app_exec_issue_job   : 0031 patch ข้อความแจ้งเตือนไว้ (§9.5) ห้าม recreate ทั้งก้อน
--   rpc_request_approval : 0041 patch reopen_job ไว้ ห้าม recreate เช่นกัน
-- ⚠️ ใช้ DO block แทน app_swap_guard เพราะที่นี่ p_new มี p_old เป็น substring
--    (เราต่อท้ายบรรทัดเดิม) → app_swap_guard จะ patch ซ้อนทุกครั้งที่รันซ้ำ ไม่ idempotent
--    DO block นี้เช็ค marker ก่อน จึงรันกี่รอบก็ได้ผลเดียว และ error ดังถ้าหาจุดแทรกไม่เจอ
DO $$
DECLARE
  def TEXT; foid OID;
  targets CONSTANT TEXT[][] := ARRAY[
    ['app_exec_issue_job',
     'RAISE EXCEPTION ''กรุณาระบุสถานที่ติดตั้ง (Location)''; END IF;'],
    ['rpc_request_approval',
     'type_label := ''เบิกให้ Service'';']
  ];
  i INT;
BEGIN
  FOR i IN 1 .. array_length(targets, 1) LOOP
    SELECT p.oid, pg_get_functiondef(p.oid) INTO foid, def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = targets[i][1];
    IF foid IS NULL THEN
      RAISE EXCEPTION '0052: ไม่พบฟังก์ชัน % — ต้องรัน migration ก่อนหน้าให้ครบ', targets[i][1];
    END IF;
    IF position('app_assert_job_eta_ready' IN def) > 0 THEN
      RAISE NOTICE '0052: % มี guard อยู่แล้ว ข้าม', targets[i][1];
      CONTINUE;
    END IF;
    IF position(targets[i][2] IN def) = 0 THEN
      RAISE EXCEPTION '0052: ไม่พบจุดแทรก guard ใน % (body ใน DB ต่างจากที่คาด — ตรวจด้วย pg_get_functiondef ก่อน)', targets[i][1];
    END IF;
    def := replace(def, targets[i][2],
                   targets[i][2] || ' PERFORM app_assert_job_eta_ready(p_job_id);');
    EXECUTE def;
    RAISE NOTICE '0052: แทรก guard เข้า % แล้ว', targets[i][1];
  END LOOP;
END $$;

DO $$ BEGIN RAISE NOTICE '0052 OK — lead 45–60 + import คงค่าเดิม + กันเบิกเมื่อของยังไม่ถึงคลัง'; END $$;
