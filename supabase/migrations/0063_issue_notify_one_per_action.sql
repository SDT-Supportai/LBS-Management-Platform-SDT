-- =====================================================================
-- 0063: เบิกให้ Service — 1 การกระทำ = 1 ข้อความ · ตัด Location ออก (2026-08-28)
--
--  ที่มา: อนุมัติคำขอเบิก LBS 1 ครั้ง ยิงเข้ากลุ่ม LINE 3 ข้อความรวด
--      ✅ อนุมัติเบิก LBS ให้ Service · JOB-2026-0003 · โดย …
--      🚚 JOB-2026-0003 เบิก LBS 2 เครื่องให้ Service · ติดตั้ง <สถานที่ยาว ๆ> · <ช่วงวัน>
--      🚚 JOB-2026-0003 เบิกของครบทั้งใบแล้ว · ติดตั้ง <สถานที่ยาว ๆ> · <ช่วงวัน>
--    2 ใบหลังใช้อีโมจิเดียวกันและพูดเรื่องเดียวกันติดกัน — ในกลุ่มอ่านแล้วนึกว่าส่งซ้ำ
--
--  แก้ 2 อย่าง (มติผู้ใช้ 2026-08-28):
--    1) **ยุบใบ "ครบทั้งใบแล้ว" เข้าไปเป็นหางของข้อความที่ทำให้ครบ**
--       app_finalize_issue ไม่ยิง app_notify('job_issued') อีกแล้ว — ยังตั้ง terminal_status
--       และลง audit เหมือนเดิม (audit เป็นบันทึกเหตุการณ์ ไม่ใช่ข้อความหาคน จึงไม่ยุบ)
--       ⇒ ก้าวที่ทำให้ใบครบจะได้ข้อความเดียวลงท้ายด้วย " · ครบทั้งใบแล้ว"
--    2) **ตัด Location ออกจากข้อความแจ้งเตือนทั้งหมด** — สถานที่ติดตั้งของจริงยาวมาก
--       ("สถานีไฟฟ้าแรงสูง… จ.ฉะเชิงเทรา") ดันข้อความในกลุ่มตกบรรทัดจนกลบส่วนที่ต้องอ่านจริง
--       คือ Job No. + จำนวน + ช่วงวันติดตั้ง · ทีมช่างดูสถานที่จากใบงาน/หน้าเว็บอยู่แล้ว
--       ⚠️ **audit ยังเก็บ Location ครบ** — ตรงนั้นคือหลักฐาน ต้องตอบได้ว่าส่งไปที่ไหน
--
--  ⚠️ ที่ **ไม่ได้** ทำ (มติผู้ใช้): เบิก LBS + วัสดุพร้อมกันในการกดครั้งเดียว ยังได้ 2 ข้อความ
--     เพราะ UI ยิง 2 คำสั่งแยก transaction (วัสดุก่อน → LBS) การยุบเป็นใบเดียวต้องทำ RPC รวม
--     ซึ่งไม่คุ้มกับการไปแตะ flow เบิกของ · และเคสนี้เกิดเฉพาะ Manage — ฝั่ง Project ต้องผ่าน
--     อนุมัติอยู่แล้ว วัสดุกับ LBS จึงแยกเวลากันเสมอโดยธรรมชาติ (= "แจ้งตามการเบิก" ตามมติข้อ 2)
--
--  วิธีแก้: **recreate 3 ฟังก์ชัน** (ไม่ใช่ patch บรรทัด) เพราะต้องสลับลำดับ
--  "แจ้งเตือน ↔ ปิดใบ" ซึ่งเป็นการแก้ข้ามบรรทัด — app_swap_guard ทำได้เฉพาะบรรทัดเดียว (§9.6)
--  ปลอดภัยตาม §9.5(ข): ทั้ง 3 ตัวเกิดที่ 0059 · 0031 (ที่ patch ข้อความด้วย replace) มาก่อน 0059
--  จึงไม่เคยแตะ · grep 0060–0062 แล้วไม่มีใคร patch ตามหลัง
--  และมี PREFLIGHT ตรวจ marker ของ 0059 ก่อนทับ — ถ้ามีใครแก้มือบน LIVE จะ RAISE ไม่ทับเงียบ ๆ
--
--  ✅ ไม่เปลี่ยน signature · ไม่แตะสิทธิ์/เงื่อนไขการเบิก · เปลี่ยนเฉพาะ "ข้อความ + ลำดับการแจ้ง"
--     รันก่อนหรือหลัง push frontend ก็ได้
--  demo sync: src/data/logic.ts (finalizeIssue / jobBecameComplete / issueJobLbs /
--             issueJobAccessory) + 3 เคสใน logic.test.ts
--  รันหลัง 0062 · idempotent (CREATE OR REPLACE)
-- =====================================================================

-- ---------- 0) PREFLIGHT — ต้องเป็น body ของ 0059 จริงก่อนทับ ----------
DO $$
DECLARE d TEXT;
BEGIN
  FOR d IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'app_finalize_issue'
  LOOP
    IF position('app_job_pending_issue_acc' IN d) = 0 THEN
      RAISE EXCEPTION '0063: app_finalize_issue ไม่ใช่ body ของ 0059 — หยุดก่อน อย่าทับทับ';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'app_exec_issue_lbs'
                    AND position('app_unit_issue_block' IN pg_get_functiondef(p.oid)) > 0) THEN
    RAISE EXCEPTION '0063: app_exec_issue_lbs ไม่ใช่ body ของ 0059 — หยุดก่อน';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'app_exec_issue_accessory'
                    AND position('app_acc_issue_block' IN pg_get_functiondef(p.oid)) > 0) THEN
    RAISE EXCEPTION '0063: app_exec_issue_accessory ไม่ใช่ body ของ 0059 — หยุดก่อน';
  END IF;
END $$;

-- ---------- 1) app_finalize_issue — ปิดใบ + audit แต่ "ไม่แจ้งเตือน" ----------
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

  -- 0063: ไม่ยิงแจ้งเตือน "เบิกครบทั้งใบ" ที่นี่แล้ว — ผู้เรียก (app_exec_issue_*) จะเติมหาง
  -- " · ครบทั้งใบแล้ว" ลงในข้อความของตัวเองแทน เพื่อไม่ให้กลุ่มได้ 2 ใบติดกันเรื่องเดียวกัน
  -- audit ยังลงแยกเหมือนเดิม (พร้อม Location) เพราะเป็นหลักฐาน ไม่ใช่ข้อความหาคน
  PERFORM app_audit('job', p_job_id, 'issue_to_service', actor.id,
    'เบิก ' || j.job_no || ' ให้ Service ครบทั้งใบ (LBS ' || onjob || ' เครื่อง + วัสดุทุกรายการ)' ||
    ' นัดติดตั้ง ' || rng || ' ที่ ' || loc);
END $$;

-- ---------- 2) app_exec_issue_lbs — ปิดใบก่อน แล้วค่อยแจ้งใบเดียว ----------
CREATE OR REPLACE FUNCTION app_exec_issue_lbs(
  actor profiles, p_job_id UUID, p_unit_ids UUID[],
  p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jobs; ids UUID[]; cnt INT; onjob INT; short INT; remain INT;
  sd DATE; ed DATE; loc TEXT; rng TEXT; sns TEXT; bad_sn TEXT; bad_blk TEXT;
  was_term TEXT; now_term TEXT; tail TEXT;
BEGIN
  j := app_assert_job_editable(p_job_id);
  was_term := j.terminal_status;          -- 0063: สถานะก่อนก้าวนี้ ใช้ตัดสินว่าก้าวนี้ทำให้ครบใบไหม

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

  -- audit ยังเก็บ Location + Serial ครบ (หลักฐาน)
  PERFORM app_audit('job', p_job_id, 'issue_lbs_to_service', actor.id,
    'เบิก LBS ของ ' || j.job_no || ' ให้ Service ' || cnt || ' เครื่อง (SN: ' || COALESCE(sns, '-') || ')' ||
    ' นัดติดตั้ง ' || rng || ' ที่ ' || loc ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' — ค้างอีก ' || remain || ' เครื่อง' ELSE '' END);

  -- 0063: ปิดใบก่อน แล้วค่อยแจ้ง — ข้อความใบเดียวจะได้บอกได้ว่าก้าวนี้ทำให้ครบทั้งใบหรือยัง
  PERFORM app_finalize_issue(actor, p_job_id);
  SELECT terminal_status INTO now_term FROM jobs WHERE id = p_job_id;
  tail := CASE WHEN was_term IS NULL AND now_term = 'issued' THEN ' · ครบทั้งใบแล้ว' ELSE '' END;

  PERFORM app_notify('lbs_issued_to_service',
    '🚚 ' || j.job_no || ' เบิก LBS ' || cnt || ' เครื่องให้ Service · ' || rng ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' เครื่อง)' ELSE '' END || tail,
    'service', p_job_id);
END $$;

-- ---------- 3) app_exec_issue_accessory — เหมือนกัน ----------
CREATE OR REPLACE FUNCTION app_exec_issue_accessory(
  actor profiles, p_job_id UUID, p_request_ids UUID[],
  p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jobs; ids UUID[]; cnt INT; remain INT;
  sd DATE; ed DATE; loc TEXT; rng TEXT;
  r job_accessory_requests; blk TEXT; ponos TEXT; detail TEXT;
  was_term TEXT; now_term TEXT; tail TEXT;
BEGIN
  j := app_assert_job_procurable(p_job_id);
  was_term := j.terminal_status;

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

  PERFORM app_audit('job', p_job_id, 'issue_accessory_to_service', actor.id,
    'เบิกวัสดุของ ' || j.job_no || ' ให้ Service ' || cnt || ' รายการ จาก ' || COALESCE(ponos, '-') ||
    ' — ' || COALESCE(detail, '-') ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' รายการ)' ELSE '' END);

  PERFORM app_finalize_issue(actor, p_job_id);
  SELECT terminal_status INTO now_term FROM jobs WHERE id = p_job_id;
  tail := CASE WHEN was_term IS NULL AND now_term = 'issued' THEN ' · ครบทั้งใบแล้ว' ELSE '' END;

  PERFORM app_notify('accessory_issued_to_service',
    '📦 ' || j.job_no || ' เบิกวัสดุ ' || cnt || ' รายการให้ Service (' || COALESCE(ponos, '-') || ') · ' || rng ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' รายการ)' ELSE '' END || tail,
    'service', p_job_id);
END $$;

-- ---------- 4) ตรวจผล ----------
-- WARN: pg_get_functiondef คืน **คอมเมนต์ที่อยู่ในตัวฟังก์ชัน** มาด้วย
--    เทียบสตริงดิบ ๆ จึงไม่ปลอดภัย — คอมเมนต์ที่บังเอิญพูดถึงชื่อ event ทำให้ตรวจผลเพี้ยน
--    (พลาดมาแล้วรอบแรกของไฟล์นี้: คอมเมนต์ในตัว app_finalize_issue มีชื่อ event อยู่
--     ทำให้ RAISE ว่ายังยิงแจ้งเตือนอยู่ ทั้งที่โค้ดไม่มีการยิงแล้ว)
--    => ตัดคอมเมนต์บรรทัด (--) ทิ้งก่อนเทียบ และเช็คที่ "การเรียกจริง" ไม่ใช่ชื่อ event
DO $$
DECLARE src TEXT; nm TEXT;
BEGIN
  -- 4.1 app_finalize_issue ต้องไม่เหลือการแจ้งเตือนเลย (ปิดใบ + audit อย่างเดียว)
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_finalize_issue';
  IF src IS NULL THEN RAISE EXCEPTION '0063: ไม่พบ app_finalize_issue'; END IF;
  IF position('app_notify' IN src) > 0 THEN
    RAISE EXCEPTION '0063: app_finalize_issue ยังเรียก app_notify อยู่ — ตัวที่รันไม่ใช่ body ของ 0063';
  END IF;
  IF position('นัดติดตั้ง ' IN src) = 0 THEN
    RAISE EXCEPTION '0063: app_finalize_issue เผลอตัด Location ออกจาก audit (ต้องเก็บเป็นหลักฐาน)';
  END IF;

  -- 4.2 สองตัวที่เบิก: ห้ามมี Location ในข้อความ · ต้องมีหาง "ครบทั้งใบแล้ว" · audit ต้องยังมี Location
  FOREACH nm IN ARRAY ARRAY['app_exec_issue_lbs', 'app_exec_issue_accessory'] LOOP
    SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = nm;
    IF src IS NULL THEN RAISE EXCEPTION '0063: ไม่พบ %', nm; END IF;
    IF position('ให้ Service · ติดตั้ง ' IN src) > 0 THEN
      RAISE EXCEPTION '0063: % ยังมี Location ในข้อความแจ้งเตือน', nm;
    END IF;
    IF position('ครบทั้งใบแล้ว' IN src) = 0 THEN
      RAISE EXCEPTION '0063: % ไม่มีหาง ครบทั้งใบแล้ว', nm;
    END IF;
    -- audit ของฝั่ง **วัสดุ** ไม่เคยมีนัดหมาย/สถานที่มาตั้งแต่ 0059 (บันทึกเลข PO + รายการของแทน)
    -- จึงเช็คข้อนี้เฉพาะฝั่ง LBS · Location ของใบงานยังตามได้จาก audit ของ app_finalize_issue
    IF nm = 'app_exec_issue_lbs' AND position('นัดติดตั้ง ' IN src) = 0 THEN
      RAISE EXCEPTION '0063: % เผลอตัด Location ออกจาก audit', nm;
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN RAISE NOTICE '0063 OK — เบิกให้ Service: 1 การกระทำ = 1 ข้อความ · ไม่มี Location ในแจ้งเตือน (audit ยังเก็บ)'; END $$;

-- ---------------------------------------------------------------------
-- rollback: รัน section 4/5/6 ของ 0059_partial_issue_to_service.sql ซ้ำ
--   (app_finalize_issue · app_exec_issue_lbs · app_exec_issue_accessory)
--   ทั้ง 3 ตัวเป็น CREATE OR REPLACE จึงทับกลับได้ตรง ๆ ไม่ต้อง DROP
-- ---------------------------------------------------------------------
