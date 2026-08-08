-- =====================================================================
-- 0051: ระยะขนส่งเลือกได้ 45–60 วัน + ความเห็นผู้บริหารเรื่องคลัง LBS (2026-08-08)
--
--  1) **ETA to WH เลือกระยะขนส่งได้ 45–60 วัน** (เดิม 0049 ตรึงไว้ที่ 60)
--     `lbs_units.eta_lead_days` — NULL = ใช้ค่ามาตรฐาน 60 (ข้อมูลเดิมไม่ต้อง backfill)
--     ETA to WH = fob_date + COALESCE(eta_lead_days, 60) · ยังเป็น "ค่าคำนวณ ไม่เก็บคอลัมน์" ตามเดิม
--     ตั้งได้ 3 ทาง: modal แก้ข้อมูลรายเครื่อง · ปุ่ม 🚢 ตั้ง FOB ทั้งคลัง · คอลัมน์ "ระยะขนส่ง (วัน)" ใน Excel
--     ⚠️ DB ยอมรับ 1–365 (กันค่าเพี้ยน) — UI จำกัด 45–60 ตามที่ตกลง ถ้าเส้นทางใหม่ต้องใช้ค่าอื่นแก้แค่ฝั่ง UI
--
--  2) **ความเห็นผู้บริหารเรื่องคลัง LBS** — ต่อยอด approval_comments ของ 0050
--     เพิ่ม `scope` ('approval' | 'stock') · `request_id` กลายเป็น NULL ได้เมื่อ scope = 'stock'
--     scope='stock' = ความเห็น "ภาพรวมคลัง" (ไม่ผูกคลังใดคลังหนึ่ง) แสดงท้ายหน้า Project Stock
--     ใต้พาเนล "วัสดุตาม Job (Ref.PO)" ตามที่ขอ
--     ⚠️ ใช้ตารางเดิมไม่สร้างตารางใหม่: เป็น thread ชนิดเดียวกัน (VIP ↔ Division) แค่คนละบริบท
--        → หน้า UI ใช้โค้ดชุดเดียว · แจ้งเตือนชุดเดียว · ถ้าจะเพิ่ม scope ใหม่ (เช่น 'job') ก็ต่อได้เลย
--
--  รันหลัง 0050 · idempotent (รันซ้ำได้ · ปลอดภัยแม้ 0050 เพิ่งรันไปหมาดๆ)
-- =====================================================================

-- ---------- 1) ระยะขนส่งต่อเครื่อง ----------
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS eta_lead_days INT;
ALTER TABLE lbs_units DROP CONSTRAINT IF EXISTS lbs_units_eta_lead_days_check;
ALTER TABLE lbs_units ADD CONSTRAINT lbs_units_eta_lead_days_check
  CHECK (eta_lead_days IS NULL OR (eta_lead_days BETWEEN 1 AND 365));
COMMENT ON COLUMN lbs_units.eta_lead_days IS
  'ระยะขนส่ง FOB → คลัง (วัน) · NULL = ค่ามาตรฐาน 60 · ETA to WH = fob_date + COALESCE(eta_lead_days, 60)';

-- helper: อ่าน lead days จาก payload import (คู่กับ app_unit_cost ของ 0024)
CREATE OR REPLACE FUNCTION app_unit_lead(u JSONB) RETURNS INT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v INT;
BEGIN
  v := NULLIF(btrim(COALESCE(u->>'lead_days', '')), '')::INT;
  IF v IS NULL THEN RETURN NULL; END IF;
  IF v < 1 OR v > 365 THEN RAISE EXCEPTION 'ระยะขนส่ง (วัน) ต้องอยู่ระหว่าง 1–365 (ได้รับ %)', v; END IF;
  IF v = 60 THEN RETURN NULL; END IF;      -- เท่าค่ามาตรฐาน = ไม่ต้องเก็บ
  RETURN v;
END $$;

-- ---------- 2) rpc_update_unit_plan: + p_lead_days ----------
-- ⚠️ DROP signature ของ 0049 (8 args) ก่อน recreate เป็น 9 args — กัน PGRST203 ambiguous (§9.8)
DROP FUNCTION IF EXISTS rpc_update_unit_plan(UUID, NUMERIC, TEXT, TEXT, TEXT, DATE, DATE, DATE);

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
  IF p_lead_days IS NOT NULL AND (p_lead_days < 1 OR p_lead_days > 365) THEN
    RAISE EXCEPTION 'ระยะขนส่ง (วัน) ต้องอยู่ระหว่าง 1–365';
  END IF;

  SELECT * INTO s FROM project_stocks WHERE id = u.project_stock_id;
  -- ระยะขนส่งมีความหมายเฉพาะเมื่อมี FOB · เท่าค่ามาตรฐาน = เก็บ NULL
  v_lead := CASE WHEN p_fob_date IS NULL OR p_lead_days = 60 THEN NULL ELSE p_lead_days END;
  -- มี FOB → ETA เป็นค่าคำนวณ (ไม่เก็บซ้ำ) · ไม่มี FOB → ETA คือค่าที่กรอกเอง
  v_eta := CASE WHEN p_fob_date IS NOT NULL THEN p_fob_date + COALESCE(v_lead, 60) ELSE p_plan_po_receipt END;

  UPDATE lbs_units SET
    unit_cost             = p_unit_cost,
    plan_customer_name    = NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
    plan_contact_phone    = NULLIF(btrim(COALESCE(p_contact_phone, '')), ''),
    plan_install_location = NULLIF(btrim(COALESCE(p_install_location, '')), ''),
    fob_date              = p_fob_date,
    eta_lead_days         = v_lead,
    -- มี FOB แล้วต้องล้างค่ากรอกมือทิ้ง ไม่งั้นเหลือ 2 แหล่งความจริงของ ETA
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

-- ---------- 3) rpc_set_stock_fob: + p_lead_days ----------
DROP FUNCTION IF EXISTS rpc_set_stock_fob(UUID, DATE, BOOLEAN);

CREATE OR REPLACE FUNCTION rpc_set_stock_fob(
  p_stock_id UUID, p_fob_date DATE, p_lead_days INT DEFAULT NULL, p_overwrite BOOLEAN DEFAULT FALSE
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; s project_stocks; cnt INT; v_lead INT;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  IF p_fob_date IS NULL THEN RAISE EXCEPTION 'กรุณาระบุ FOB date'; END IF;
  IF p_lead_days IS NOT NULL AND (p_lead_days < 1 OR p_lead_days > 365) THEN
    RAISE EXCEPTION 'ระยะขนส่ง (วัน) ต้องอยู่ระหว่าง 1–365';
  END IF;
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;
  v_lead := CASE WHEN p_lead_days = 60 THEN NULL ELSE p_lead_days END;   -- เท่าค่ามาตรฐาน = เก็บ NULL

  UPDATE lbs_units SET
    fob_date             = p_fob_date,
    eta_lead_days        = v_lead,
    plan_po_receipt_date = NULL,       -- ETA กลายเป็นค่าคำนวณ → ล้างค่ากรอกมือ (แหล่งความจริงเดียว)
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

-- ---------- 4) Import Excel: รับคอลัมน์ "ระยะขนส่ง (วัน)" ----------
-- signature เดิม (jsonb) — เติม key 'lead_days' เข้า payload ได้เลย (แนวเดียวกับ 0048/0049)
CREATE OR REPLACE FUNCTION rpc_import_units_to_stock(p_stock_id UUID, p_new_units JSONB, p_update_units JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; s project_stocks; u JSONB; lvb TEXT; om TEXT; c NUMERIC;
  v_cust TEXT; v_phone TEXT; v_loc TEXT; v_por DATE; v_del DATE; v_fob DATE; v_lead INT;
  newcnt INT := 0; updcnt INT := 0; lockedcnt INT := 0;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO s FROM project_stocks WHERE id = p_stock_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Project Stock'; END IF;

  -- ---------- อัพเดทเครื่องเดิม: match คู่ Serial (lvb+om) เฉพาะในคลังนี้ ----------
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_update_units, '[]'::jsonb)) LOOP
    lvb := btrim(COALESCE(u->>'lvb', '')); om := btrim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' OR om = '';

    c       := app_unit_cost(u);                                        -- validate ≥0 ในตัว (0024)
    v_cust  := NULLIF(btrim(COALESCE(u->>'customer', '')), '');
    v_phone := NULLIF(btrim(COALESCE(u->>'phone', '')), '');
    v_loc   := NULLIF(btrim(COALESCE(u->>'location', '')), '');
    v_fob   := NULLIF(btrim(COALESCE(u->>'fob', '')), '')::DATE;
    v_lead  := app_unit_lead(u);                                        -- validate 1–365 ในตัว (0051)
    v_por   := NULLIF(btrim(COALESCE(u->>'plan_po_receipt', '')), '')::DATE;
    v_del   := NULLIF(btrim(COALESCE(u->>'plan_delivery', '')), '')::DATE;

    -- ไฟล์ไม่ได้กรอกอะไรให้แถวนี้เลย → ข้าม (ไม่นับเป็นอัพเดท)
    CONTINUE WHEN c IS NULL AND v_cust IS NULL AND v_phone IS NULL AND v_loc IS NULL
             AND v_fob IS NULL AND v_lead IS NULL AND v_por IS NULL AND v_del IS NULL;

    -- เครื่องที่เบิกแล้วแก้ไม่ได้ (trigger ล็อก) → นับไว้บอกผู้ใช้ ไม่ทำให้ทั้งไฟล์ล้ม
    IF EXISTS (
      SELECT 1 FROM lbs_units
       WHERE project_stock_id = p_stock_id AND serial_lvb = lvb AND serial_om = om AND status = 'issued'
    ) THEN
      lockedcnt := lockedcnt + 1;
      CONTINUE;
    END IF;

    UPDATE lbs_units SET
      unit_cost            = COALESCE(c, unit_cost),
      fob_date             = COALESCE(v_fob, fob_date),
      -- ระยะขนส่งมีความหมายเฉพาะเมื่อไฟล์ให้ FOB มาด้วย (ETA คำนวณจากคู่นี้เสมอ)
      eta_lead_days        = CASE WHEN v_fob IS NOT NULL THEN v_lead ELSE eta_lead_days END,
      -- มี FOB ในไฟล์ → ETA เป็นค่าคำนวณ ล้างค่ากรอกมือทิ้ง · ไม่มี FOB → รับค่า ETA ที่ไฟล์ส่งมา
      plan_po_receipt_date = CASE WHEN v_fob IS NOT NULL THEN NULL
                                  ELSE COALESCE(v_por, plan_po_receipt_date) END,
      plan_delivery_date   = COALESCE(v_del, plan_delivery_date),
      -- ลูกค้า/เบอร์/สถานที่: เขียนได้เฉพาะเครื่องที่ยังไม่ผูก Job (กฎ 0014)
      plan_customer_name    = CASE WHEN job_id IS NULL THEN COALESCE(v_cust, plan_customer_name)  ELSE plan_customer_name    END,
      plan_contact_phone    = CASE WHEN job_id IS NULL THEN COALESCE(v_phone, plan_contact_phone) ELSE plan_contact_phone    END,
      plan_install_location = CASE WHEN job_id IS NULL THEN COALESCE(v_loc, plan_install_location) ELSE plan_install_location END,
      updated_at           = now()
    WHERE project_stock_id = p_stock_id AND serial_lvb = lvb AND serial_om = om AND status <> 'issued';
    IF FOUND THEN updcnt := updcnt + 1; END IF;
  END LOOP;

  -- ---------- รับเครื่องใหม่ (validation เดียวกับ rpc_add_units_to_stock) ----------
  FOR u IN SELECT * FROM jsonb_array_elements(COALESCE(p_new_units, '[]'::jsonb)) LOOP
    lvb := btrim(COALESCE(u->>'lvb', '')); om := btrim(COALESCE(u->>'om', ''));
    CONTINUE WHEN lvb = '' AND om = '';
    IF lvb = '' OR om = '' THEN RAISE EXCEPTION 'ต้องกรอกทั้ง Serial.LVB และ Serial.OM ให้ครบทุกเครื่อง'; END IF;
    IF lvb = om THEN RAISE EXCEPTION 'Serial.LVB และ Serial.OM ห้ามเป็นเลขเดียวกัน ("%")', lvb; END IF;
    IF EXISTS (SELECT 1 FROM lbs_units WHERE serial_lvb IN (lvb, om) OR serial_om IN (lvb, om)) THEN
      RAISE EXCEPTION 'Serial No. "%" / "%" มีอยู่ในระบบแล้ว', lvb, om;
    END IF;
    v_fob := NULLIF(btrim(COALESCE(u->>'fob', '')), '')::DATE;
    -- เครื่องใหม่ยังไม่มี Job แน่นอน → ใส่ข้อมูลแผนได้ทุกช่อง
    INSERT INTO lbs_units (serial_lvb, serial_om, project_stock_id, unit_cost,
                           plan_customer_name, plan_contact_phone, plan_install_location,
                           fob_date, eta_lead_days, plan_po_receipt_date, plan_delivery_date)
    VALUES (lvb, om, p_stock_id, app_unit_cost(u),
            NULLIF(btrim(COALESCE(u->>'customer', '')), ''),
            NULLIF(btrim(COALESCE(u->>'phone', '')), ''),
            NULLIF(btrim(COALESCE(u->>'location', '')), ''),
            v_fob,
            CASE WHEN v_fob IS NOT NULL THEN app_unit_lead(u) ELSE NULL END,
            CASE WHEN v_fob IS NOT NULL THEN NULL
                 ELSE NULLIF(btrim(COALESCE(u->>'plan_po_receipt', '')), '')::DATE END,
            NULLIF(btrim(COALESCE(u->>'plan_delivery', '')), '')::DATE);
    newcnt := newcnt + 1;
  END LOOP;

  IF newcnt = 0 AND updcnt = 0 THEN
    IF lockedcnt > 0 THEN
      RAISE EXCEPTION 'ทุกเครื่องในไฟล์ถูกเบิกให้ Service แล้ว (% เครื่อง) แก้ข้อมูลไม่ได้', lockedcnt;
    END IF;
    RAISE EXCEPTION 'ไม่มีรายการให้นำเข้า';
  END IF;

  IF newcnt > 0 THEN
    PERFORM app_notify('stock_received',
      '📦 เพิ่ม LBS เข้า ' || s.stock_no || ' +' || newcnt || ' เครื่อง (พร้อมดึงเข้า Job)',
      'project', NULL);
  END IF;
  PERFORM app_audit('project_stock', p_stock_id, 'import_units', actor.id,
    'Import เข้า ' || s.stock_no || ': รับใหม่ ' || newcnt || ' เครื่อง'
    || CASE WHEN updcnt > 0 THEN ' · อัพเดทข้อมูลเครื่องเดิม ' || updcnt || ' เครื่อง' ELSE '' END
    || CASE WHEN lockedcnt > 0 THEN ' · ข้ามเครื่องที่เบิกแล้ว ' || lockedcnt || ' เครื่อง' ELSE '' END);
END $$;

REVOKE ALL ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_import_units_to_stock(UUID, JSONB, JSONB) TO authenticated;

-- ---------- 5) ความเห็นเรื่องคลัง LBS: ขยาย approval_comments ด้วย scope ----------
ALTER TABLE approval_comments ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'approval';
ALTER TABLE approval_comments ALTER COLUMN request_id DROP NOT NULL;

ALTER TABLE approval_comments DROP CONSTRAINT IF EXISTS approval_comments_scope_check;
ALTER TABLE approval_comments ADD CONSTRAINT approval_comments_scope_check
  CHECK (scope IN ('approval', 'stock'));
-- scope='approval' ต้องมีคำขอ · scope='stock' เป็นความเห็นภาพรวมคลัง (ไม่ผูกคำขอ)
ALTER TABLE approval_comments DROP CONSTRAINT IF EXISTS approval_comments_scope_target_check;
ALTER TABLE approval_comments ADD CONSTRAINT approval_comments_scope_target_check
  CHECK ((scope = 'approval' AND request_id IS NOT NULL)
      OR (scope = 'stock'    AND request_id IS NULL));

CREATE INDEX IF NOT EXISTS approval_comments_scope_idx ON approval_comments (scope, created_at);
COMMENT ON TABLE approval_comments IS
  'ความเห็นผู้บริหาร (VIP) ↔ Division · scope=approval ผูกคำขออนุมัติ · scope=stock = ภาพรวมคลัง LBS (0051)';

CREATE OR REPLACE FUNCTION rpc_add_stock_comment(p_body TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; cid UUID; v_body TEXT; v_who TEXT; v_to TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['vip', 'sales']);   -- VIP + Division (+admin auto)
  v_body := btrim(COALESCE(p_body, ''));
  IF v_body = '' THEN RAISE EXCEPTION 'กรุณาพิมพ์ความเห็นก่อนส่ง'; END IF;
  IF length(v_body) > 1000 THEN RAISE EXCEPTION 'ความเห็นยาวเกิน 1,000 ตัวอักษร'; END IF;

  INSERT INTO approval_comments (scope, request_id, body, author_id)
  VALUES ('stock', NULL, v_body, actor.id) RETURNING id INTO cid;

  v_who := CASE WHEN actor.department = 'vip' THEN 'VIP' ELSE 'Division' END;
  v_to  := CASE WHEN actor.department = 'vip' THEN 'sales' ELSE 'vip' END;

  PERFORM app_notify('stock_comment',
    '💬 ' || v_who || ' ให้ความเห็นเรื่องคลัง LBS: ' || left(v_body, 120), v_to, NULL);
  PERFORM app_audit('project_stock', cid, 'comment_stock', actor.id,
    v_who || ' ให้ความเห็นเรื่องคลัง LBS: ' || v_body);
  RETURN cid;
END $$;

REVOKE ALL ON FUNCTION public.rpc_add_stock_comment(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_stock_comment(TEXT) TO authenticated;

-- rpc_add_approval_comment ของ 0050 ต้องระบุ scope ให้ชัด (default 'approval' ครอบอยู่แล้ว แต่เขียนตรงๆ ชัดกว่า)
CREATE OR REPLACE FUNCTION rpc_add_approval_comment(p_request_id UUID, p_body TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r approval_requests; j jobs; cid UUID;
        v_body TEXT; v_who TEXT; v_to TEXT; v_type TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['vip', 'sales']);
  v_body := btrim(COALESCE(p_body, ''));
  IF v_body = '' THEN RAISE EXCEPTION 'กรุณาพิมพ์ความเห็นก่อนส่ง'; END IF;
  IF length(v_body) > 1000 THEN RAISE EXCEPTION 'ความเห็นยาวเกิน 1,000 ตัวอักษร'; END IF;

  SELECT * INTO r FROM approval_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  INSERT INTO approval_comments (scope, request_id, body, author_id)
  VALUES ('approval', p_request_id, v_body, actor.id) RETURNING id INTO cid;

  v_type := CASE r.req_type
    WHEN 'create_pr'  THEN 'ออก PR'
    WHEN 'issue_job'  THEN 'เบิกให้ Service'
    WHEN 'cancel_job' THEN 'ยกเลิก Job'
    WHEN 'swap_lbs'   THEN 'สลับ LBS'
    WHEN 'reopen_job' THEN 'เปิดงานใหม่'
    ELSE r.req_type END;
  v_who := CASE WHEN actor.department = 'vip' THEN 'VIP' ELSE 'Division' END;
  v_to  := CASE WHEN actor.department = 'vip' THEN 'sales' ELSE 'vip' END;

  PERFORM app_notify('approval_comment',
    '💬 ' || v_who || ' ให้ความเห็นคำขอ' || v_type || ' · ' || COALESCE(j.job_no, '-') || ': ' || left(v_body, 120),
    v_to, r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'comment_request', actor.id,
    v_who || ' ให้ความเห็นคำขอ' || v_type || ' ของ ' || COALESCE(j.job_no, '-') || ': ' || v_body);
  RETURN cid;
END $$;

REVOKE ALL ON FUNCTION public.rpc_add_approval_comment(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_add_approval_comment(UUID, TEXT) TO authenticated;

DO $$ BEGIN RAISE NOTICE '0051 OK — ระยะขนส่งเลือกได้ 45–60 วัน + ความเห็นผู้บริหารเรื่องคลัง LBS'; END $$;
