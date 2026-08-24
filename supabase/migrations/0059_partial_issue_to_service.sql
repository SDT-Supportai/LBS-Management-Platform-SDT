-- =====================================================================
-- 0059: เบิกให้ Service แบบแยกส่วน — LBS / Accessory ตาม PO (2026-08-23)
--
--  โจทย์จากผู้ใช้ (Project ID ข้อ 1–3):
--    1) ปุ่ม "เบิกทั้งหมดให้ Service" ต้องแยกเบิก LBS กับ Accessory ตาม PO ได้ + ถาม popup ก่อน
--    2) รายการไหน Ready = เบิกได้ · รายการไหน Not Ready = เบิกไม่ได้
--    3) Accessory: PO ที่ "รับของ" แล้วเลือกเบิกตาม PO ได้ · PO ที่ "รอรับของ" ยังเบิกไม่ได้
--
--  ── ทำไมต้องแก้โครง ──
--  เดิมการเบิกเป็น all-or-nothing: app_exec_issue_job กดครั้งเดียวพลิก lbs_units ทุกเครื่อง
--  เป็น issued + jobs.terminal_status = 'issued' (terminal) · จึงเบิกบางส่วนไม่ได้เลย
--  ผลจริง: LBS ถึงคลังแล้วแต่ Accessory ยังรอ PO อีก 2 ใบ → ทีม Service เข้าไซต์ไม่ได้ทั้งงาน
--
--  ── โมเดลใหม่ ──
--    LBS       : lbs_units.status  allocated → issued  (รายเครื่อง มีอยู่แล้ว)
--    Accessory : job_accessory_requests.issued_to_service_at (คอลัมน์ใหม่ · รายบรรทัด)
--                ⚠️ คนละเรื่องกับ status = 'issued' ที่หมายถึง "เบิกจากคลังคงเหลือเข้า Job แล้ว"
--    Job       : terminal_status = 'issued' ต่อเมื่อ **ครบทั้งใบ** — app_finalize_issue ตั้งให้เอง
--                ระหว่างทาง v_job_status คืนสถานะใหม่ 'partially_issued'
--
--  ── สิทธิ์ (มติ 2026-08-23) ──
--    เบิก LBS       : Project ขออนุมัติ Division (approval type 'issue_job' — ความหมายแคบลงเป็น
--                     "เบิก LBS" · คงค่า enum เดิม ไม่แก้ CHECK เพื่อไม่ให้ประวัติคำขอเก่าเสีย)
--                     Manage ทำตรงผ่าน rpc_issue_job_lbs
--    เบิก Accessory : Project เจ้าของงานกดได้เอง (rpc_issue_job_accessory) — ของรับเข้ามาแล้ว
--                     การส่งต่อให้ Service เป็นงานประจำวัน ไม่ใช่การตัดสินใจเชิงมูลค่า
--
--  ── ล็อกเฉพาะของที่ออกไปแล้ว ──
--    fn_block_issued_job_edit เพิ่มเงื่อนไข "เครื่องที่ status = 'issued' ห้ามแก้"
--      → เดิมล็อกที่ระดับใบ (terminal_status) ซึ่งช่วง partially_issued ยังว่างอยู่
--    app_exec_cancel_job ปิดทั้งใบเมื่อมีของออกไปแล้ว (ระบบคืนของจากมือ Service เองไม่ได้)
--    rpc_return_lbs / app_exec_swap_lbs กรอง status = 'allocated' อยู่แล้ว → ไม่ต้องแก้
--
--  ── วิธีแก้ฟังก์ชันเดิม (§9.5/§9.6) ──
--    app_exec_issue_job   : patch แบบต่อท้ายบรรทัดเดียว + เช็ค marker (0031 ย่อข้อความไว้ · 0052 แทรก guard)
--    app_exec_cancel_job  : patch แบบเดียวกัน (0031 ย่อข้อความไว้)
--    app_exec_approve     : recreate ได้ — 0041 เป็นเจ้าของ body ล่าสุด ไม่มี patch หลังจากนั้น
--    rpc_request_approval : recreate **พร้อม pre-check** — สะสม patch มา 5 ชั้น (0031/0037/0041/0052)
--                           บล็อกตรวจก่อนจะ RAISE ถ้า marker ของชั้นใดชั้นหนึ่งหายไป
--                           (กันเคส §9.5 "recreate แล้ว revert ของเก่าเงียบ ๆ")
--
--  demo sync: src/data/logic.ts — jobIssuePlan / unitIssueBlockReason / accIssueBlockReason /
--             issueJobLbs / issueJobAccessory / finalizeIssue + เทสต์ใน logic.test.ts
--  รันหลัง 0058 · idempotent ทั้งไฟล์
-- =====================================================================

-- ---------- 1) คอลัมน์ใหม่ ----------
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS lbs_issued_at TIMESTAMPTZ;
COMMENT ON COLUMN jobs.lbs_issued_at IS
  '0059: เบิก LBS ล็อตแรกเมื่อ — คนละตัวกับ issued_at ที่หมายถึงเบิกครบทั้งใบ';

ALTER TABLE job_accessory_requests
  ADD COLUMN IF NOT EXISTS issued_to_service_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issued_to_service_by UUID REFERENCES profiles(id);
COMMENT ON COLUMN job_accessory_requests.issued_to_service_at IS
  '0059: เบิกให้ Service แล้วเมื่อ (ว่าง = ของยังอยู่กับ Job) — ไม่ใช่ status = issued ที่หมายถึงเบิกจากคลังคงเหลือ';

-- ย้อนหลัง: งานที่เบิกครบไปแล้วก่อน 0059 ต้องถือว่าวัสดุออกไปกับงานแล้ว
-- ไม่งั้นหน้าจอจะโชว์ "ยังมีวัสดุค้างรอเบิก" ของงานที่ปิดไปหลายเดือน
UPDATE job_accessory_requests r
   SET issued_to_service_at = j.issued_at
  FROM jobs j
 WHERE j.id = r.job_id
   AND r.issued_to_service_at IS NULL
   AND j.terminal_status IN ('issued', 'installed')
   AND j.issued_at IS NOT NULL
   AND r.status NOT IN ('cancelled', 'returned');

UPDATE jobs SET lbs_issued_at = issued_at
 WHERE lbs_issued_at IS NULL AND issued_at IS NOT NULL
   AND terminal_status IN ('issued', 'installed');

-- ---------- 2) v_job_status — นับเครื่องที่เบิกแล้วด้วย + สถานะ partially_issued ----------
-- ⚠️ CREATE OR REPLACE VIEW ต้องคงชื่อ/ชนิด/ลำดับคอลัมน์เดิมทั้ง 5 ตัว
--    เดิม alloc นับเฉพาะ status = 'allocated' ซึ่งใช้ได้ตอนที่เบิกเป็น all-or-nothing
--    (เบิกแล้ว = terminal_status พาไป) · พอเบิกแยกส่วนได้ เครื่องที่ออกไปแล้วจะหลุดจากการนับ
--    → งานตกกลับเป็น 'draft' ทั้งที่ของอยู่ในมือ Service แล้ว (บั๊กเดียวกับ §9.7 คนละทาง)
CREATE OR REPLACE VIEW v_job_status AS
SELECT
  j.id AS job_id,
  j.job_no,
  CASE
    WHEN j.terminal_status IS NOT NULL THEN j.terminal_status
    -- ออกไปแล้วบางส่วน — ครบทั้งใบเมื่อไหร่ app_finalize_issue ตั้ง terminal_status ให้เอง
    WHEN COALESCE(onjob.issued, 0) > 0 OR COALESCE(accout.cnt, 0) > 0 THEN 'partially_issued'
    WHEN j.lbs_qty_required > 0 AND COALESCE(onjob.cnt, 0) >= j.lbs_qty_required
         AND COALESCE(pend.cnt, 0) = 0 THEN 'ready_to_issue'
    WHEN COALESCE(onjob.cnt, 0) > 0 AND COALESCE(pend.cnt, 0) > 0 THEN 'procuring_accessory'
    WHEN COALESCE(onjob.cnt, 0) > 0 THEN 'allocated'
    ELSE 'draft'
  END AS status,
  COALESCE(onjob.cnt, 0) AS lbs_allocated,
  j.lbs_qty_required
FROM jobs j
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS cnt, COUNT(*) FILTER (WHERE u.status = 'issued') AS issued
    FROM lbs_units u
   WHERE u.job_id = j.id AND u.status IN ('allocated', 'issued')
) onjob ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS cnt FROM job_accessory_requests r
   WHERE r.job_id = j.id AND r.status NOT IN ('issued', 'received', 'cancelled', 'returned')
) pend ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS cnt FROM job_accessory_requests r
   WHERE r.job_id = j.id AND r.issued_to_service_at IS NOT NULL
     AND r.status NOT IN ('cancelled', 'returned')
) accout ON true;

-- ---------- 3) helper: Ready / Not Ready ----------
-- ETA to WH รายเครื่อง (mirror unitEta ใน logic.ts) — ไม่มีคอลัมน์ ETA ใน DB ต้องคำนวณทุกครั้ง
CREATE OR REPLACE FUNCTION app_unit_eta_date(p_fob DATE, p_lead INT, p_plan DATE) RETURNS DATE
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_fob IS NOT NULL THEN p_fob + COALESCE(p_lead, 60) ELSE p_plan END
$$;

-- เหตุผลที่เครื่องนี้ยังเบิกไม่ได้ — NULL = Ready
-- ⚠️ ETA ว่าง ('?') ไม่บล็อก — ตรงกับ app_assert_job_eta_ready ของ 0052 ("ไม่รู้" ≠ "รู้ว่ายังไม่มา")
CREATE OR REPLACE FUNCTION app_unit_issue_block(u lbs_units) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE eta DATE;
BEGIN
  IF u.status = 'issued' THEN RETURN 'เบิกให้ Service ไปแล้ว'; END IF;
  IF u.status <> 'allocated' THEN RETURN 'ไม่ได้ถูกดึงเข้า Job นี้'; END IF;
  eta := app_unit_eta_date(u.fob_date, u.eta_lead_days, u.plan_po_receipt_date);
  IF eta IS NOT NULL AND eta > CURRENT_DATE THEN
    RETURN 'ของยังไม่ถึงคลัง — ETA to WH ' || eta::TEXT;
  END IF;
  RETURN NULL;
END $$;

-- เหตุผลที่วัสดุบรรทัดนี้ยังเบิกไม่ได้ — NULL = Ready (mirror accIssueBlockReason)
CREATE OR REPLACE FUNCTION app_acc_issue_block(r job_accessory_requests) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE po purchase_orders;
BEGIN
  IF r.issued_to_service_at IS NOT NULL THEN RETURN 'เบิกให้ Service ไปแล้ว'; END IF;
  IF r.status IN ('cancelled', 'returned') THEN RETURN 'รายการถูกยกเลิก/คืนคลังไปแล้ว'; END IF;
  IF (r.qty_requested - COALESCE(r.qty_transferred, 0)) <= 0 THEN
    RETURN 'โอนคืนคลังหมดแล้ว — ไม่มีของค้างอยู่ที่ Job';
  END IF;
  IF r.source = 'central_stock' THEN
    RETURN CASE WHEN r.status = 'issued' THEN NULL ELSE 'ยังไม่ได้เบิกจากคลังคงเหลือ' END;
  END IF;
  IF r.status <> 'received' THEN
    RETURN CASE r.status
             WHEN 'pending'    THEN 'ยังไม่ออก PR'
             WHEN 'pr_sent'    THEN 'ส่ง PR แล้ว รอ Purchasing ออก PO'
             WHEN 'po_ordered' THEN 'ออก PO แล้ว รอรับของ'
             ELSE 'ยังไม่ได้รับของ' END;
  END IF;
  IF r.po_id IS NULL THEN RETURN NULL; END IF;      -- ข้อมูลเก่าที่ไม่ผูก PO — ของรับแล้ว
  SELECT * INTO po FROM purchase_orders WHERE id = r.po_id;
  IF po.id IS NULL THEN RETURN NULL; END IF;
  IF po.status = 'cancelled' THEN RETURN po.po_no || ' ถูกยกเลิก'; END IF;
  -- ข้อ 3 ของโจทย์: ต้องรับของครบ "ทั้งใบ PO" ไม่ใช่ครบแค่บรรทัดนี้
  IF po.status <> 'received' THEN RETURN po.po_no || ' ยังรับของไม่ครบ (รอรับของ)'; END IF;
  RETURN NULL;
END $$;

-- จำนวนวัสดุที่ยังต้องเบิกให้ Service (mirror jobPendingIssueAccessories)
CREATE OR REPLACE FUNCTION app_job_pending_issue_acc(jid UUID) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*)::INT FROM job_accessory_requests r
   WHERE r.job_id = jid
     AND r.issued_to_service_at IS NULL
     AND r.status NOT IN ('cancelled', 'returned')
     AND (r.qty_requested - COALESCE(r.qty_transferred, 0)) > 0
$$;

-- กันยกเลิก/แก้ใบงานที่ของออกไปให้ Service แล้วบางส่วน
CREATE OR REPLACE FUNCTION app_assert_no_issued_out(p_job_id UUID) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT; jno TEXT;
BEGIN
  SELECT (SELECT COUNT(*) FROM lbs_units WHERE job_id = p_job_id AND status = 'issued')
       + (SELECT COUNT(*) FROM job_accessory_requests
           WHERE job_id = p_job_id AND issued_to_service_at IS NOT NULL) INTO n;
  IF COALESCE(n, 0) = 0 THEN RETURN; END IF;
  SELECT job_no INTO jno FROM jobs WHERE id = p_job_id;
  RAISE EXCEPTION '% เบิกของให้ Service ไปแล้วบางส่วน — ยกเลิกไม่ได้ ให้ Service คืนของเข้าคลังก่อน แล้วให้ Manage จัดการเป็นเคส',
    COALESCE(jno, '-');
END $$;

-- ---------- 4) ปิดใบเมื่อเบิกครบทั้งใบ ----------
-- เรียกท้ายทุก action ที่เบิกของออกไป · no-op ถ้าใบปิดแล้ว → เรียกซ้ำได้ปลอดภัย
CREATE OR REPLACE FUNCTION app_finalize_issue(actor profiles, p_job_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j jobs; onjob INT; still_alloc INT; rng TEXT; loc TEXT;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id;
  IF j.id IS NULL OR j.terminal_status IS NOT NULL THEN RETURN; END IF;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'allocated')
    INTO onjob, still_alloc
    FROM lbs_units WHERE job_id = p_job_id AND status IN ('allocated', 'issued');
  IF COALESCE(onjob, 0) = 0 OR onjob < j.lbs_qty_required OR COALESCE(still_alloc, 0) > 0 THEN RETURN; END IF;
  IF app_job_pending_issue_acc(p_job_id) > 0 THEN RETURN; END IF;

  loc := COALESCE(NULLIF(j.issue_location, ''), NULLIF(j.install_location, ''), '-');
  rng := CASE WHEN j.install_start_date = j.install_end_date
              THEN COALESCE(j.install_start_date::TEXT, '-')
              ELSE COALESCE(j.install_start_date::TEXT, '-') || ' – ' || COALESCE(j.install_end_date::TEXT, '-') END;

  UPDATE jobs SET terminal_status = 'issued', issued_at = now(), updated_at = now() WHERE id = p_job_id;

  PERFORM app_notify('job_issued',
    '🚚 ' || j.job_no || ' เบิกของครบทั้งใบแล้ว · ติดตั้ง ' || loc || ' · ' || rng, 'service', p_job_id);
  PERFORM app_audit('job', p_job_id, 'issue_to_service', actor.id,
    'เบิก ' || j.job_no || ' ให้ Service ครบทั้งใบ (LBS ' || onjob || ' เครื่อง + วัสดุทุกรายการ)' ||
    ' นัดติดตั้ง ' || rng || ' ที่ ' || loc);
END $$;

-- ---------- 5) execute: เบิก LBS ----------
CREATE OR REPLACE FUNCTION app_exec_issue_lbs(
  actor profiles, p_job_id UUID, p_unit_ids UUID[],
  p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jobs; ids UUID[]; cnt INT; onjob INT; short INT; remain INT;
  sd DATE; ed DATE; loc TEXT; rng TEXT; sns TEXT; bad_sn TEXT; bad_blk TEXT;
BEGIN
  j := app_assert_job_editable(p_job_id);

  SELECT COUNT(*) INTO onjob FROM lbs_units
   WHERE job_id = p_job_id AND status IN ('allocated', 'issued');
  short := GREATEST(0, j.lbs_qty_required - COALESCE(onjob, 0));
  IF short > 0 THEN
    RAISE EXCEPTION '% ดึง LBS ยังไม่ครบ Scope — ขาดอีก % เครื่อง', j.job_no, short;
  END IF;

  IF p_unit_ids IS NULL OR array_length(p_unit_ids, 1) IS NULL THEN
    -- ว่าง = เบิกทุกเครื่องที่ Ready
    SELECT array_agg(u.id) INTO ids FROM lbs_units u
     WHERE u.job_id = p_job_id AND app_unit_issue_block(u) IS NULL;
  ELSE
    ids := p_unit_ids;
    SELECT COUNT(*) INTO cnt FROM lbs_units WHERE id = ANY(ids);
    IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'มีเครื่องที่ไม่พบในระบบ'; END IF;
    -- ⚠️ ใช้ตัวแปร scalar ไม่ใช่ RECORD — SELECT INTO ที่ไม่เจอแถวจะเซ็ต NULL ให้ scalar แน่นอน
    SELECT u.serial_lvb, app_unit_issue_block(u) INTO bad_sn, bad_blk
      FROM lbs_units u
     WHERE u.id = ANY(ids) AND (u.job_id IS DISTINCT FROM p_job_id OR app_unit_issue_block(u) IS NOT NULL)
     LIMIT 1;
    IF bad_sn IS NOT NULL THEN
      RAISE EXCEPTION '%: %', bad_sn, COALESCE(bad_blk, 'ไม่ได้ถูกดึงเข้า ' || j.job_no);
    END IF;
  END IF;
  IF ids IS NULL OR array_length(ids, 1) IS NULL THEN
    RAISE EXCEPTION '% ไม่มี LBS ที่เบิกได้ตอนนี้ — เช็ค ETA to WH รายเครื่องที่หน้า LBS Inventory', j.job_no;
  END IF;

  -- นัดติดตั้ง: เว้นว่างได้ถ้าใบนี้มีนัดอยู่แล้ว (เบิกล็อตที่ 2 ไม่ต้องกรอกซ้ำ)
  sd := COALESCE(p_start_date, j.install_start_date);
  ed := COALESCE(p_end_date, j.install_end_date);
  loc := COALESCE(NULLIF(trim(COALESCE(p_location, '')), ''), NULLIF(j.issue_location, ''));
  IF sd IS NULL OR ed IS NULL THEN RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)'; END IF;
  IF ed < sd THEN RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง'; END IF;
  IF loc IS NULL THEN RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)'; END IF;
  rng := CASE WHEN sd = ed THEN sd::TEXT ELSE sd::TEXT || ' – ' || ed::TEXT END;

  SELECT string_agg(serial_lvb, ', ' ORDER BY serial_lvb) INTO sns FROM lbs_units WHERE id = ANY(ids);
  UPDATE lbs_units SET status = 'issued', updated_at = now() WHERE id = ANY(ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;
  UPDATE jobs SET lbs_issued_at = COALESCE(lbs_issued_at, now()),
                  install_start_date = sd, install_end_date = ed, issue_location = loc,
                  issued_note = COALESCE(NULLIF(trim(COALESCE(p_note, '')), ''), issued_note),
                  updated_at = now()
   WHERE id = p_job_id;
  SELECT COUNT(*) INTO remain FROM lbs_units WHERE job_id = p_job_id AND status = 'allocated';

  PERFORM app_notify('lbs_issued_to_service',
    '🚚 ' || j.job_no || ' เบิก LBS ' || cnt || ' เครื่องให้ Service · ติดตั้ง ' || loc || ' · ' || rng ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' เครื่อง)' ELSE '' END,
    'service', p_job_id);
  PERFORM app_audit('job', p_job_id, 'issue_lbs_to_service', actor.id,
    'เบิก LBS ของ ' || j.job_no || ' ให้ Service ' || cnt || ' เครื่อง (SN: ' || COALESCE(sns, '-') || ')' ||
    ' นัดติดตั้ง ' || rng || ' ที่ ' || loc ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' — ค้างอีก ' || remain || ' เครื่อง' ELSE '' END);

  PERFORM app_finalize_issue(actor, p_job_id);
END $$;

-- ---------- 6) execute: เบิก Accessory (ตาม PO / คลังคงเหลือ) ----------
-- guard = app_assert_job_procurable (ไม่ใช่ editable) เพราะของที่ "ซื้อเพิ่มหลังเบิก" (0037)
-- ก็ต้องส่งต่อให้ Service ได้ ทั้งที่ใบงานปิดเป็น issued ไปแล้ว
CREATE OR REPLACE FUNCTION app_exec_issue_accessory(
  actor profiles, p_job_id UUID, p_request_ids UUID[],
  p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jobs; ids UUID[]; cnt INT; remain INT;
  sd DATE; ed DATE; loc TEXT; rng TEXT;
  r job_accessory_requests; blk TEXT; ponos TEXT; detail TEXT;
BEGIN
  j := app_assert_job_procurable(p_job_id);

  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    SELECT array_agg(x.id) INTO ids FROM job_accessory_requests x
     WHERE x.job_id = p_job_id AND app_acc_issue_block(x) IS NULL;
  ELSE
    ids := p_request_ids;
    SELECT COUNT(*) INTO cnt FROM job_accessory_requests WHERE id = ANY(ids);
    IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'มีรายการวัสดุที่ไม่พบในระบบ'; END IF;
    FOR r IN SELECT * FROM job_accessory_requests WHERE id = ANY(ids) FOR UPDATE LOOP
      IF r.job_id <> p_job_id THEN RAISE EXCEPTION 'มีรายการวัสดุที่ไม่ได้อยู่ใน Job นี้'; END IF;
      blk := app_acc_issue_block(r);
      IF blk IS NOT NULL THEN
        RAISE EXCEPTION '%: %', COALESCE((SELECT name FROM items WHERE id = r.item_id), 'วัสดุ'), blk;
      END IF;
    END LOOP;
  END IF;
  IF ids IS NULL OR array_length(ids, 1) IS NULL THEN
    RAISE EXCEPTION '% ไม่มีวัสดุที่เบิกได้ตอนนี้ — PO ที่ยังรอรับของเบิกไม่ได้', j.job_no;
  END IF;

  sd := COALESCE(p_start_date, j.install_start_date);
  ed := COALESCE(p_end_date, j.install_end_date);
  loc := COALESCE(NULLIF(trim(COALESCE(p_location, '')), ''), NULLIF(j.issue_location, ''));
  IF sd IS NULL OR ed IS NULL THEN RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)'; END IF;
  IF ed < sd THEN RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง'; END IF;
  IF loc IS NULL THEN RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)'; END IF;
  rng := CASE WHEN sd = ed THEN sd::TEXT ELSE sd::TEXT || ' – ' || ed::TEXT END;

  -- Service ต้องรู้ว่าของ "ชุดไหน" ถึงมือแล้ว → สรุปเป็นเลข PO
  SELECT string_agg(DISTINCT COALESCE(po.po_no, 'คลังคงเหลือ'), ', '),
         string_agg(i.name || ' ' || (x.qty_requested - COALESCE(x.qty_transferred, 0))::TEXT || ' ' || i.uom, ', ')
    INTO ponos, detail
    FROM job_accessory_requests x
    LEFT JOIN purchase_orders po ON po.id = x.po_id
    LEFT JOIN items i ON i.id = x.item_id
   WHERE x.id = ANY(ids);

  UPDATE job_accessory_requests
     SET issued_to_service_at = now(), issued_to_service_by = actor.id, updated_at = now()
   WHERE id = ANY(ids);
  GET DIAGNOSTICS cnt = ROW_COUNT;
  UPDATE jobs SET install_start_date = sd, install_end_date = ed, issue_location = loc, updated_at = now()
   WHERE id = p_job_id;
  remain := app_job_pending_issue_acc(p_job_id);

  PERFORM app_notify('accessory_issued_to_service',
    '📦 ' || j.job_no || ' เบิกวัสดุ ' || cnt || ' รายการให้ Service (' || COALESCE(ponos, '-') || ')' ||
    ' · ติดตั้ง ' || loc || ' · ' || rng ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' รายการ)' ELSE '' END,
    'service', p_job_id);
  PERFORM app_audit('job', p_job_id, 'issue_accessory_to_service', actor.id,
    'เบิกวัสดุของ ' || j.job_no || ' ให้ Service ' || cnt || ' รายการ จาก ' || COALESCE(ponos, '-') ||
    ' — ' || COALESCE(detail, '-') ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' รายการ)' ELSE '' END);

  PERFORM app_finalize_issue(actor, p_job_id);
END $$;

-- ---------- 7) RPC ที่ client เรียก ----------
-- เบิก LBS ตรง = admin เท่านั้น (Project ต้องผ่าน rpc_request_approval type = issue_job)
CREATE OR REPLACE FUNCTION rpc_issue_job_lbs(
  p_job_id UUID, p_unit_ids UUID[], p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY[]::TEXT[]);
  PERFORM app_exec_issue_lbs(actor, p_job_id, p_unit_ids, p_start_date, p_end_date, p_location, p_note);
END $$;

-- เบิก Accessory = Project เจ้าของงาน + Manage (app_assert_job_procurable เช็ค owner ให้ตาม 0042)
CREATE OR REPLACE FUNCTION rpc_issue_job_accessory(
  p_job_id UUID, p_request_ids UUID[], p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  PERFORM app_exec_issue_accessory(actor, p_job_id, p_request_ids, p_start_date, p_end_date, p_location, p_note);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_issue_job_lbs(UUID, UUID[], DATE, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_issue_job_accessory(UUID, UUID[], DATE, DATE, TEXT, TEXT) TO authenticated;

-- ---------- 8) ล็อกรายเครื่อง: เครื่องที่เบิกออกไปแล้วห้ามแก้ ----------
-- เดิมล็อกที่ระดับใบ (terminal_status) เท่านั้น — ช่วง partially_issued ค่านั้นยังว่าง
-- ⚠️ ฟังก์ชันนี้ไม่เคยถูก patch (0001 เป็นเจ้าของเดียว) → recreate ทั้งก้อนปลอดภัย
CREATE OR REPLACE FUNCTION fn_block_issued_job_edit() RETURNS TRIGGER AS $$
BEGIN
  -- 0059: รายเครื่องมาก่อน — ไม่มี flow ไหนในระบบที่ต้องแก้เครื่องที่เบิกไปแล้ว
  --   (rpc_return_lbs / app_exec_swap_lbs / import ทุกตัวกรอง status = 'allocated' หรือข้าม issued อยู่แล้ว)
  IF OLD.status = 'issued' THEN
    RAISE EXCEPTION 'LBS % เบิกให้ Service แล้ว — ล็อก แก้ไขไม่ได้', OLD.serial_lvb;
  END IF;
  IF OLD.job_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM jobs WHERE id = OLD.job_id AND terminal_status IN ('issued','installed')) THEN
      RAISE EXCEPTION 'Job % is issued/installed — allocation is locked', OLD.job_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- 9) patch app_exec_issue_job (เบิกทั้งใบ) — ให้ stamp วัสดุด้วย ----------
-- ทางเดิมยังใช้ได้ (rpc_issue_job ของ Manage) แต่ถ้าไม่ stamp issued_to_service_at
-- หน้าจอจะโชว์ "ยังมีวัสดุค้างรอเบิก" ของงานที่เบิกครบไปแล้ว
-- ⚠️ ห้าม recreate ทั้งก้อน — 0031 ย่อข้อความแจ้งเตือน + 0052 แทรก guard ETA ไว้ (§9.5)
--    p_new มี p_old เป็น substring → ใช้ DO block เช็ค marker เอง ไม่ใช้ app_swap_guard (§0052)
DO $$
DECLARE def TEXT; foid OID;
  anchor CONSTANT TEXT := 'UPDATE lbs_units SET status = ''issued'', updated_at = now() WHERE job_id = p_job_id AND status = ''allocated'';';
  addition CONSTANT TEXT := ' UPDATE job_accessory_requests SET issued_to_service_at = now(), issued_to_service_by = actor.id, updated_at = now() WHERE job_id = p_job_id AND issued_to_service_at IS NULL AND status NOT IN (''cancelled'', ''returned''); UPDATE jobs SET lbs_issued_at = COALESCE(lbs_issued_at, now()) WHERE id = p_job_id;';
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid) INTO foid, def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'app_exec_issue_job';
  IF foid IS NULL THEN RAISE EXCEPTION '0059: ไม่พบ app_exec_issue_job — ต้องรัน 0016 ก่อน'; END IF;
  IF position('issued_to_service_at' IN def) > 0 THEN
    RAISE NOTICE '0059: app_exec_issue_job patch แล้ว ข้าม';
  ELSIF position(anchor IN def) = 0 THEN
    RAISE EXCEPTION '0059: ไม่พบจุดแทรกใน app_exec_issue_job (body ใน DB ต่างจากที่คาด — ตรวจ pg_get_functiondef ก่อน)';
  ELSE
    EXECUTE replace(def, anchor, anchor || addition);
    RAISE NOTICE '0059: patch app_exec_issue_job แล้ว';
  END IF;
END $$;

-- ---------- 10) patch app_exec_cancel_job — ห้ามยกเลิกเมื่อของออกไปแล้วบางส่วน ----------
-- ⚠️ 0031 ย่อข้อความแจ้งเตือนในฟังก์ชันนี้ไว้ → ห้าม recreate (§9.5) · p_new มี p_old เป็น substring
DO $$
DECLARE def TEXT; foid OID;
  anchor CONSTANT TEXT := 'IF trim(p_reason) = '''' THEN RAISE EXCEPTION ''กรุณาระบุเหตุผลการยกเลิก''; END IF;';
  addition CONSTANT TEXT := ' PERFORM app_assert_no_issued_out(p_job_id);';
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid) INTO foid, def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'app_exec_cancel_job';
  IF foid IS NULL THEN RAISE EXCEPTION '0059: ไม่พบ app_exec_cancel_job — ต้องรัน 0016 ก่อน'; END IF;
  IF position('app_assert_no_issued_out' IN def) > 0 THEN
    RAISE NOTICE '0059: app_exec_cancel_job patch แล้ว ข้าม';
  ELSIF position(anchor IN def) = 0 THEN
    RAISE EXCEPTION '0059: ไม่พบจุดแทรก guard ใน app_exec_cancel_job (body ใน DB ต่างจากที่คาด)';
  ELSE
    EXECUTE replace(def, anchor, anchor || addition);
    RAISE NOTICE '0059: patch app_exec_cancel_job แล้ว';
  END IF;
END $$;

-- ---------- 11) rpc_request_approval — issue_job = "เบิก LBS" ----------
-- pre-check: ยืนยันว่า body ใน DB มี patch ทั้ง 4 ชั้นที่เรารู้จักครบ ก่อนจะ recreate
-- (0031 ย่อข้อความ · 0037 guard แยกตามประเภท · 0041 reopen_job · 0052 guard ETA)
-- ถ้าชั้นใดหาย = มีคนแก้ฟังก์ชันนอก migration → หยุดดัง ไม่ recreate ทับเงียบ ๆ (บทเรียน §9.5)
DO $$
DECLARE def TEXT; missing TEXT := '';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rpc_request_approval';
  IF def IS NULL THEN RAISE EXCEPTION '0059: ไม่พบ rpc_request_approval'; END IF;
  IF position('app_assert_job_editable_for' IN def) = 0 THEN missing := missing || ' 0037'; END IF;
  IF position('reopen_job' IN def) = 0                  THEN missing := missing || ' 0041'; END IF;
  IF position('app_assert_job_eta_ready' IN def) = 0    THEN missing := missing || ' 0052'; END IF;
  IF position('· โดย ' IN def) = 0                      THEN missing := missing || ' 0031'; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '0059: rpc_request_approval ขาด patch ของ migration:% — อย่า recreate ทับ ตรวจ pg_get_functiondef ก่อน', missing;
  END IF;
  RAISE NOTICE '0059: rpc_request_approval pre-check ผ่าน (มี patch 0031/0037/0041/0052 ครบ)';
END $$;

CREATE OR REPLACE FUNCTION rpc_request_approval(p_type TEXT, p_job_id UUID, p_payload JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; j jobs; rid UUID; cnt INT; ids UUID[]; type_label TEXT;
  ua lbs_units; ub lbs_units; onjob INT; short INT; bad_sn TEXT; bad_blk TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  j := app_assert_job_editable_for(p_job_id, p_type);                            -- 0037
  IF p_type NOT IN ('create_pr', 'issue_job', 'cancel_job', 'swap_lbs', 'reopen_job') THEN  -- 0041
    RAISE EXCEPTION 'ประเภทคำขอไม่ถูกต้อง';
  END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE job_id = p_job_id AND req_type = p_type AND status = 'pending') THEN
    RAISE EXCEPTION '% มีคำขอประเภทนี้รอ Division พิจารณาอยู่แล้ว', j.job_no;
  END IF;

  IF p_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(COALESCE(p_payload->'request_ids', '[]'::jsonb)) x;
    IF ids IS NULL THEN RAISE EXCEPTION 'กรุณาเลือกรายการที่จะออก PR'; END IF;
    SELECT count(*) INTO cnt FROM job_accessory_requests
     WHERE id = ANY(ids) AND job_id = p_job_id AND source = 'purchasing' AND status = 'pending';
    IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'เลือกได้เฉพาะรายการสั่งซื้อที่ยังไม่ออก PR'; END IF;
    type_label := 'ออก PR (' || array_length(ids, 1) || ' รายการ)';

  ELSIF p_type = 'issue_job' THEN
    -- 0059: คำขอนี้ครอบเฉพาะ **LBS** (Accessory ที่รับของครบ Project เบิกเองได้ ไม่ผ่านที่นี่)
    --   เกณฑ์เปลี่ยนจาก "ทั้งใบต้อง ready_to_issue" → "ดึงครบ Scope + เครื่องที่ขอต้อง Ready รายเครื่อง"
    --   ทำให้ขอเบิก LBS ได้ระหว่างที่ Accessory ยังรอ PO อยู่ (คือทั้งหมดของโจทย์)
    --   ⚠️ ไม่เรียก app_assert_job_eta_ready ของ 0052 แล้ว — guard นั้นบล็อกทั้งใบเมื่อมีเครื่องใด
    --      ETA ยังไม่ถึง · 0059 ตรวจรายเครื่องผ่าน app_unit_issue_block ซึ่งเข้มเท่ากันแต่ไม่เหมารวม
    SELECT COUNT(*) INTO onjob FROM lbs_units
     WHERE job_id = p_job_id AND status IN ('allocated', 'issued');
    short := GREATEST(0, j.lbs_qty_required - COALESCE(onjob, 0));
    IF short > 0 THEN
      RAISE EXCEPTION '% ดึง LBS ยังไม่ครบ Scope — ขาดอีก % เครื่อง', j.job_no, short;
    END IF;
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(COALESCE(p_payload->'unit_ids', '[]'::jsonb)) x;
    IF ids IS NULL THEN
      SELECT array_agg(u.id) INTO ids FROM lbs_units u
       WHERE u.job_id = p_job_id AND app_unit_issue_block(u) IS NULL;
    ELSE
      SELECT u.serial_lvb, app_unit_issue_block(u) INTO bad_sn, bad_blk
        FROM lbs_units u
       WHERE u.id = ANY(ids) AND (u.job_id IS DISTINCT FROM p_job_id OR app_unit_issue_block(u) IS NOT NULL)
       LIMIT 1;
      IF bad_sn IS NOT NULL THEN
        RAISE EXCEPTION '%: %', bad_sn, COALESCE(bad_blk, 'ไม่ได้ถูกดึงเข้า ' || j.job_no);
      END IF;
      SELECT count(*) INTO cnt FROM lbs_units WHERE id = ANY(ids) AND job_id = p_job_id;
      IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'มีเครื่องที่ไม่ได้ถูกดึงเข้า Job นี้'; END IF;
    END IF;
    IF ids IS NULL OR array_length(ids, 1) IS NULL THEN
      RAISE EXCEPTION '% ไม่มี LBS ที่เบิกได้ตอนนี้ — เช็ค ETA to WH รายเครื่องที่หน้า LBS Inventory', j.job_no;
    END IF;
    -- นัดติดตั้ง: เว้นว่างได้ถ้าใบนี้มีนัดอยู่แล้ว (ขอเบิกล็อตที่ 2)
    IF COALESCE((p_payload->>'start_date')::DATE, j.install_start_date) IS NULL
       OR COALESCE((p_payload->>'end_date')::DATE, j.install_end_date) IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)';
    END IF;
    IF COALESCE((p_payload->>'end_date')::DATE, j.install_end_date)
       < COALESCE((p_payload->>'start_date')::DATE, j.install_start_date) THEN
      RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง';
    END IF;
    IF COALESCE(NULLIF(trim(COALESCE(p_payload->>'location', '')), ''), NULLIF(j.issue_location, '')) IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)';
    END IF;
    type_label := 'เบิก LBS ให้ Service (' || array_length(ids, 1) || ' เครื่อง)';

  ELSIF p_type = 'swap_lbs' THEN
    IF trim(COALESCE(p_payload->>'reason', '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการสลับ LBS'; END IF;
    SELECT * INTO ua FROM lbs_units WHERE id = (p_payload->>'swap_allocated_unit_id')::UUID;
    IF ua.id IS NULL OR ua.job_id <> p_job_id OR ua.status <> 'allocated' THEN
      RAISE EXCEPTION 'เครื่องต้นทางต้องเป็น LBS ที่ดึงเข้า Job นี้อยู่ (allocated)';
    END IF;
    SELECT * INTO ub FROM lbs_units WHERE id = (p_payload->>'swap_stock_unit_id')::UUID;
    IF ub.id IS NULL OR ub.status <> 'in_stock' THEN
      RAISE EXCEPTION 'เครื่องที่จะสลับต้องเป็นเครื่องว่างในคลัง (in_stock)';
    END IF;
    type_label := 'สลับ LBS';

  ELSE
    IF trim(COALESCE(p_payload->>'reason', '')) = '' THEN                        -- 0041
      RAISE EXCEPTION '%', CASE WHEN p_type = 'reopen_job'
        THEN 'กรุณาระบุเหตุผลที่ขอเปิดงานใหม่' ELSE 'กรุณาระบุเหตุผลการยกเลิก' END;
    END IF;
    type_label := CASE WHEN p_type = 'reopen_job' THEN 'เปิดงานใหม่' ELSE 'ยกเลิก Job' END;
  END IF;

  INSERT INTO approval_requests (req_type, job_id, payload, requested_by)
  VALUES (p_type, p_job_id, COALESCE(p_payload, '{}'::jsonb), actor.id) RETURNING id INTO rid;

  PERFORM app_notify('approval_requested',                                        -- 0031 (ย่อแล้ว)
    '🔔 ' || j.job_no || ' ขออนุมัติ' || type_label || ' · โดย ' || actor.full_name,
    'sales', p_job_id);
  PERFORM app_audit('approval_request', rid, 'request_approval', actor.id,
    j.job_no || ' ขออนุมัติ' || type_label);
  RETURN rid;
END $$;

-- ---------- 12) app_exec_approve — branch issue_job เรียก app_exec_issue_lbs ----------
-- 0041 เป็นเจ้าของ body ล่าสุด · ไม่มี app_swap_guard/app_shorten_notify ตัวไหนแตะฟังก์ชันนี้
-- (ตรวจแล้วด้วย grep ทั้ง 0001–0058) → recreate ทั้งก้อนปลอดภัย
CREATE OR REPLACE FUNCTION app_exec_approve(actor profiles, p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests; j jobs; type_label TEXT; ids UUID[];
BEGIN
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขออนุมัติ'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกตัดสินไปแล้ว'; END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id;

  UPDATE approval_requests SET status = 'approved', decided_by = actor.id, decided_at = now()
  WHERE id = p_request_id;

  IF r.req_type = 'create_pr' THEN
    SELECT array_agg((x)::UUID) INTO ids FROM jsonb_array_elements_text(r.payload->'request_ids') x;
    PERFORM app_exec_create_pr(actor, r.job_id, ids);
    type_label := 'ออก PR';
  ELSIF r.req_type = 'issue_job' THEN
    -- 0059: อนุมัติแล้วเบิกเฉพาะ LBS ตามรายการที่ขอ (unit_ids ว่าง = ทุกเครื่องที่ Ready ตอนอนุมัติ)
    SELECT array_agg((x)::UUID) INTO ids
      FROM jsonb_array_elements_text(COALESCE(r.payload->'unit_ids', '[]'::jsonb)) x;
    PERFORM app_exec_issue_lbs(actor, r.job_id, ids,
      (r.payload->>'start_date')::DATE, (r.payload->>'end_date')::DATE,
      r.payload->>'location', r.payload->>'note');
    type_label := 'เบิก LBS ให้ Service';
  ELSIF r.req_type = 'swap_lbs' THEN
    PERFORM app_exec_swap_lbs(actor, r.job_id,
      (r.payload->>'swap_allocated_unit_id')::UUID, (r.payload->>'swap_stock_unit_id')::UUID,
      r.payload->>'reason');
    type_label := 'สลับ LBS';
  ELSIF r.req_type = 'reopen_job' THEN
    PERFORM app_exec_reopen_job(actor, r.job_id, r.payload->>'reason');
    type_label := 'เปิดงานใหม่';
  ELSE
    PERFORM app_exec_cancel_job(actor, r.job_id,
      r.payload->>'reason', COALESCE((r.payload->>'received_to_central')::BOOLEAN, true));
    type_label := 'ยกเลิก Job';
  END IF;

  PERFORM app_notify('approval_approved',
    '✅ อนุมัติ' || type_label || ' · ' || j.job_no || ' · โดย ' || actor.full_name,
    'project', r.job_id);
  PERFORM app_audit('approval_request', p_request_id, 'approve_request', actor.id,
    'อนุมัติ' || type_label || ' ของ ' || j.job_no);
END $$;

-- ป้ายตอนตีกลับให้ตรงกับความหมายใหม่
DO $$
BEGIN
  PERFORM app_swap_guard('rpc_reject_request',
    'WHEN ''issue_job'' THEN ''เบิกให้ Service''', 'WHEN ''issue_job'' THEN ''เบิก LBS ให้ Service''');
EXCEPTION WHEN OTHERS THEN
  -- ป้ายอาจเขียนคนละรูปใน body ที่ผ่าน patch มาหลายชั้น — เป็นแค่ข้อความ ไม่ใช่ logic
  RAISE NOTICE '0059: ข้ามการแก้ป้าย rpc_reject_request (%)', SQLERRM;
END $$;

-- ---------- 13) ตรวจผล — ต้องผ่านทุกข้อ ----------
DO $$
DECLARE n INT;
BEGIN
  -- คอลัมน์
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'jobs' AND column_name = 'lbs_issued_at')
       OR (table_name = 'job_accessory_requests' AND column_name IN ('issued_to_service_at', 'issued_to_service_by')));
  IF n <> 3 THEN RAISE EXCEPTION '0059: คอลัมน์ใหม่ไม่ครบ (เจอ %/3)', n; END IF;

  -- ฟังก์ชันใหม่
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname IN (
     'app_unit_eta_date', 'app_unit_issue_block', 'app_acc_issue_block',
     'app_job_pending_issue_acc', 'app_assert_no_issued_out', 'app_finalize_issue',
     'app_exec_issue_lbs', 'app_exec_issue_accessory', 'rpc_issue_job_lbs', 'rpc_issue_job_accessory');
  IF n < 10 THEN RAISE EXCEPTION '0059: ฟังก์ชันใหม่ไม่ครบ (เจอ %/10)', n; END IF;

  -- patch ติดครบ
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'app_exec_issue_job'
      AND position('issued_to_service_at' IN pg_get_functiondef(p.oid)) > 0) THEN
    RAISE EXCEPTION '0059: app_exec_issue_job ยังไม่ได้ patch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'app_exec_cancel_job'
      AND position('app_assert_no_issued_out' IN pg_get_functiondef(p.oid)) > 0) THEN
    RAISE EXCEPTION '0059: app_exec_cancel_job ยังไม่ได้ patch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'app_exec_approve'
      AND position('app_exec_issue_lbs' IN pg_get_functiondef(p.oid)) > 0) THEN
    RAISE EXCEPTION '0059: app_exec_approve ยังชี้ app_exec_issue_job อยู่';
  END IF;

  -- view คืนสถานะใหม่ได้ (ไม่มีข้อมูลก็ต้อง query ผ่าน)
  PERFORM count(*) FROM v_job_status;

  RAISE NOTICE '0059 OK — เบิกแยกส่วน LBS / Accessory ตาม PO พร้อมใช้งาน';
END $$;
