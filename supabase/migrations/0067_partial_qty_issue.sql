-- =============================================================================
-- 0067 — เบิกให้ Service ทีละจำนวน + ของที่เหลือค้างที่ Job แล้วโอนคืนคลังได้ (2026-09-11)
--
-- โจทย์: วัสดุ 1 บรรทัดมี 100 ชิ้น แต่หน้างานรอบนี้เอาไปแค่ 20 — เดิมเบิกได้แบบ
--   all-or-nothing (ธง issued_to_service_at รายบรรทัด) ⇒ ต้องกดเบิกทั้ง 100 ทั้งที่ของจริง
--   ยังอยู่ในคลัง Job อีก 80 ⇒ ตัวเลข "เบิกให้ Service แล้ว" เชื่อไม่ได้ และของ 80 ชิ้นนั้น
--   ไม่มีที่ยืนในระบบ: จะโอนคืนคลังคงเหลือให้ Job อื่นใช้ก็ไม่ได้ เพราะบรรทัดถูกปิดไปแล้ว
--
-- โมเดลใหม่ — บัญชี 3 ช่องต่อบรรทัด ผลรวมต้องเท่ากับ qty_requested เสมอ:
--   qty_transferred         โอนคืนคลังคงเหลือแล้ว  (ตัดต้นทุนออกจาก Job)
--   qty_issued_to_service   เบิกออกไปหน้างานแล้ว    (ต้นทุนยังอยู่กับ Job) ← คอลัมน์ใหม่ของไฟล์นี้
--   ที่เหลือ                 ค้างอยู่ที่ Job          (เบิกเพิ่มได้ / โอนคืนได้)
--
-- 🔴 มติผู้ใช้ 2026-09-11 (2 ข้อ ที่เปลี่ยนกติกาธุรกิจ):
--   1) บรรทัด "จบ" เมื่อ **ทุกชิ้นมีที่ไปครบ** (เบิกออกหน้างาน + โอนคืนคลัง = qty_requested)
--      ⇒ เบิก 20 จาก 100 แล้ว Job **ยังไม่ปิด** เป็น issued จนกว่า 80 ที่เหลือจะถูกเบิกหรือโอนคืน
--      ⇒ ต้นทุน Job ตรงกับของจริงเสมอ ไม่มีของหายเงียบ
--   2) โอนคืนคลังคงเหลือได้ **จนถึงหลังติดตั้งเสร็จ** (ปิดเฉพาะ cancelled)
--      เพราะของเหลือมักรู้ตอนช่างกลับจากหน้างาน = ตอนที่ Job เป็น installed ไปแล้ว
--      ⇒ การโอนรับเคส "ช่างส่งของที่เบิกไปแล้วคืนกลับคลัง" ด้วย: ส่วนที่เกินของที่ค้างอยู่ที่ Job
--        จะถูกหักออกจาก qty_issued_to_service (ไม่งั้นบัญชี 3 ช่องรวมเกิน qty_requested)
--
-- ⚠️ ห้ามใช้ issued_to_service_at เป็นธง "เบิกครบแล้ว" อีก — ตั้งแต่ไฟล์นี้ ธงขึ้นตั้งแต่เบิกรอบแรก
--    ความหมายใหม่ = "รอบล่าสุดที่เบิก" · ตัวที่ตอบว่าจบคือจำนวนคงค้าง (app_acc_issue_block)
--
-- ⚠️ **เปลี่ยน signature 2 ตัว ⇒ DROP ตัวเก่าก่อน** (§9 ข้อ 8 — 2 overload = PGRST203)
--      rpc_issue_job_accessory (UUID,UUID[],DATE,DATE,TEXT,TEXT) → + NUMERIC[]
--      app_exec_issue_accessory(profiles,UUID,UUID[],DATE,DATE,TEXT,TEXT) → + NUMERIC[]
--    **ต้องรันไฟล์นี้ก่อน push frontend** ไม่งั้นกดยืนยันการเบิกได้ PGRST202
--
-- ⚠️ body ของ app_exec_issue_accessory ที่อยู่ใน DB ตอนนี้เป็นของ 0063 (ยุบข้อความแจ้งเตือน
--    + ตัด Location ออกจาก noti แต่คง Location ใน audit) — ไฟล์นี้ recreate ทั้งก้อน
--    จึงมี PREFLIGHT ตรวจก่อนว่าที่อยู่ใน DB เป็น body ของ 0063 จริง (ถ้ามีใครแก้มือจะ RAISE
--    ไม่ทับเงียบ ๆ) และมี DO block ท้ายไฟล์ตรวจว่าคุณสมบัติของ 0063 ยังอยู่ครบหลังทับ
-- =============================================================================

-- ---------- 0) PREFLIGHT — ยืนยันว่าของใน DB เป็น body ที่เราคาด ----------
DO $$
DECLARE src TEXT;
BEGIN
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_exec_issue_accessory';
  IF src IS NULL THEN
    RAISE EXCEPTION '0067: ไม่พบ app_exec_issue_accessory — ต้องรัน 0059 และ 0063 ก่อน';
  END IF;
  -- marker ของ 0063: ตัวแปร tail (หาง "ครบทั้งใบแล้ว") + ไม่มี Location ในข้อความ noti
  IF position('tail' IN src) = 0 THEN
    RAISE EXCEPTION '0067: app_exec_issue_accessory ใน DB ไม่ใช่ body ของ 0063 (ไม่เจอตัวแปร tail) — ตรวจก่อนทับ';
  END IF;
END $$;

-- ---------- 1) คอลัมน์ใหม่ + backfill ----------
ALTER TABLE job_accessory_requests
  ADD COLUMN IF NOT EXISTS qty_issued_to_service NUMERIC(14, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN job_accessory_requests.qty_issued_to_service IS
  'จำนวนที่เบิกออกไปให้ Service แล้วรวมทุกรอบ (0067) — ไม่กระทบต้นทุน Job '
  '(ต้นทุนตัดตาม qty_requested − qty_transferred) · ของที่ค้างที่ Job = qty_requested − qty_transferred − ตัวนี้';

-- แถวที่เบิกไปแล้วก่อนมีไฟล์นี้ = เบิกครบทั้งบรรทัดตามกติกา all-or-nothing เดิม
-- เช็ค = 0 ด้วย เพื่อให้รันซ้ำได้โดยไม่เขียนทับค่าที่เกิดขึ้นหลังไฟล์นี้ถูกรันแล้ว
UPDATE job_accessory_requests
   SET qty_issued_to_service = GREATEST(qty_requested - COALESCE(qty_transferred, 0), 0)
 WHERE issued_to_service_at IS NOT NULL
   AND COALESCE(qty_issued_to_service, 0) = 0
   AND status NOT IN ('cancelled', 'returned');

-- กันข้อมูลเพี้ยนระดับฐานข้อมูล — บัญชี 3 ช่องห้ามรวมเกินจำนวนที่ขอ และห้ามติดลบ
-- (ตัว NOT VALID ไม่ตรวจแถวเก่าย้อนหลัง เพื่อไม่ให้ migration ล้มเพราะข้อมูลเดิมที่แก้มือมา
--  แถวใหม่/แถวที่ถูก UPDATE ต่อจากนี้ถูกบังคับครบ)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jar_qty_split_ck') THEN
    ALTER TABLE job_accessory_requests
      ADD CONSTRAINT jar_qty_split_ck CHECK (
        qty_issued_to_service >= 0
        AND COALESCE(qty_transferred, 0) >= 0
        AND qty_issued_to_service + COALESCE(qty_transferred, 0) <= qty_requested
      ) NOT VALID;
  END IF;
END $$;

-- ---------- 2) "เบิกได้ไหม" — วัดด้วยจำนวนคงค้าง ไม่ใช่ธง ----------
CREATE OR REPLACE FUNCTION app_acc_pending_qty(r job_accessory_requests) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(r.qty_requested - COALESCE(r.qty_transferred, 0) - COALESCE(r.qty_issued_to_service, 0), 0)
$$;

CREATE OR REPLACE FUNCTION app_acc_issue_block(r job_accessory_requests) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE po purchase_orders; left_qty NUMERIC;
BEGIN
  IF r.status IN ('cancelled', 'returned') THEN RETURN 'รายการถูกยกเลิก/คืนคลังไปแล้ว'; END IF;
  IF (r.qty_requested - COALESCE(r.qty_transferred, 0)) <= 0 THEN
    RETURN 'โอนคืนคลังหมดแล้ว — ไม่มีของค้างอยู่ที่ Job';
  END IF;
  -- 0067: เบิกครบทั้งบรรทัดแล้ว (เบิกบางส่วนต้องเบิกต่อได้ จึงเช็คจำนวน ไม่ใช่ issued_to_service_at)
  left_qty := app_acc_pending_qty(r);
  IF left_qty <= 0 THEN
    RETURN 'เบิกครบแล้ว ' || trim(to_char(COALESCE(r.qty_issued_to_service, 0), 'FM999999990.99')) ||
           ' จาก ' || trim(to_char(r.qty_requested - COALESCE(r.qty_transferred, 0), 'FM999999990.99'));
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
  -- ต้องรับของครบ "ทั้งใบ PO" ไม่ใช่ครบแค่บรรทัดนี้ (ข้อ 3 ของ 0059)
  IF po.status <> 'received' THEN RETURN po.po_no || ' ยังรับของไม่ครบ (รอรับของ)'; END IF;
  RETURN NULL;
END $$;

-- จำนวนบรรทัดที่ยังมีของค้างอยู่ที่ Job = เงื่อนไขที่ app_finalize_issue รอให้ว่างก่อนปิดใบ
-- (ไม่ต้องแก้ app_finalize_issue เลย — มันเรียกฟังก์ชันนี้อยู่แล้ว ⇒ กติกาข้อ 1 ของมติมีผลทันที)
CREATE OR REPLACE FUNCTION app_job_pending_issue_acc(jid UUID) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*)::INT FROM job_accessory_requests r
   WHERE r.job_id = jid
     AND r.status NOT IN ('cancelled', 'returned')
     AND app_acc_pending_qty(r) > 0
$$;

-- ---------- 3) เบิกทีละจำนวน — signature ใหม่ (DROP ก่อน) ----------
DROP FUNCTION IF EXISTS rpc_issue_job_accessory(UUID, UUID[], DATE, DATE, TEXT, TEXT);
DROP FUNCTION IF EXISTS app_exec_issue_accessory(profiles, UUID, UUID[], DATE, DATE, TEXT, TEXT);

CREATE OR REPLACE FUNCTION app_exec_issue_accessory(
  actor profiles, p_job_id UUID, p_request_ids UUID[], p_qtys NUMERIC[],
  p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j jobs; ids UUID[]; cnt INT; remain INT; n_partial INT := 0;
  sd DATE; ed DATE; loc TEXT; rng TEXT;
  r job_accessory_requests; blk TEXT; ponos TEXT; detail TEXT;
  was_term TEXT; now_term TEXT; tail TEXT; ptail TEXT;
  i INT; want NUMERIC; left_qty NUMERIC; takes NUMERIC[] := '{}';
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

  -- 0067: จำนวนที่จะเบิกรอบนี้ต่อบรรทัด — p_qtys เรียงตำแหน่งตรงกับ p_request_ids
  --   NULL ทั้งอาเรย์ หรือ NULL ตำแหน่งนั้น = เบิกที่ค้างทั้งหมดของบรรทัดนั้น (เคสปกติ "เบิกครบ")
  --   ตรวจให้จบก่อนแตะข้อมูล เพื่อให้ error ชี้ชื่อวัสดุได้ตรงตัวและไม่เบิกไปครึ่ง ๆ
  IF p_qtys IS NOT NULL AND array_length(p_qtys, 1) IS NOT NULL
     AND array_length(p_qtys, 1) <> array_length(ids, 1) THEN
    RAISE EXCEPTION '0067: จำนวนที่ส่งมา (%) ไม่เท่ากับจำนวนรายการ (%)',
      array_length(p_qtys, 1), array_length(ids, 1);
  END IF;
  FOR i IN 1 .. array_length(ids, 1) LOOP
    SELECT * INTO r FROM job_accessory_requests WHERE id = ids[i];
    left_qty := app_acc_pending_qty(r);
    want := CASE WHEN p_qtys IS NULL OR array_length(p_qtys, 1) IS NULL THEN left_qty
                 ELSE COALESCE(p_qtys[i], left_qty) END;
    IF want <= 0 THEN
      RAISE EXCEPTION '%: จำนวนที่เบิกต้องมากกว่า 0',
        COALESCE((SELECT name FROM items WHERE id = r.item_id), 'วัสดุ');
    END IF;
    IF want > left_qty THEN
      RAISE EXCEPTION '%: เบิกได้ไม่เกิน % % (ค้างอยู่ที่ Job)',
        COALESCE((SELECT name FROM items WHERE id = r.item_id), 'วัสดุ'),
        trim(to_char(left_qty, 'FM999999990.99')),
        COALESCE((SELECT uom FROM items WHERE id = r.item_id), '');
    END IF;
    takes := takes || want;
    IF want < left_qty THEN n_partial := n_partial + 1; END IF;
  END LOOP;

  sd := COALESCE(p_start_date, j.install_start_date);
  ed := COALESCE(p_end_date, j.install_end_date);
  loc := COALESCE(NULLIF(trim(COALESCE(p_location, '')), ''), NULLIF(j.issue_location, ''));
  IF sd IS NULL OR ed IS NULL THEN RAISE EXCEPTION 'กรุณาระบุกำหนดวันติดตั้ง (Start–End)'; END IF;
  IF ed < sd THEN RAISE EXCEPTION 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มติดตั้ง'; END IF;
  IF loc IS NULL THEN RAISE EXCEPTION 'กรุณาระบุสถานที่ติดตั้ง (Location)'; END IF;
  rng := CASE WHEN sd = ed THEN sd::TEXT ELSE sd::TEXT || ' – ' || ed::TEXT END;

  -- Service ต้องรู้ว่าของ "ชุดไหน" ถึงมือแล้ว → สรุปเป็นเลข PO
  -- เบิกไม่เต็มบรรทัดต้องเห็นเป็น "จำนวนที่เบิก/จำนวนที่ Job ถือ" ไม่งั้นไล่ย้อนไม่ได้ว่าของขาดไปไหน
  SELECT string_agg(DISTINCT COALESCE(po.po_no, 'คลังคงเหลือ'), ', '),
         string_agg(
           i2.name || ' ' || trim(to_char(t.q, 'FM999999990.99')) ||
           CASE WHEN t.q < (x.qty_requested - COALESCE(x.qty_transferred, 0))
                THEN '/' || trim(to_char(x.qty_requested - COALESCE(x.qty_transferred, 0), 'FM999999990.99'))
                ELSE '' END ||
           ' ' || i2.uom, ', ')
    INTO ponos, detail
    FROM unnest(ids, takes) AS t(rid, q)
    JOIN job_accessory_requests x ON x.id = t.rid
    LEFT JOIN purchase_orders po ON po.id = x.po_id
    LEFT JOIN items i2 ON i2.id = x.item_id;

  UPDATE job_accessory_requests x
     SET qty_issued_to_service = COALESCE(x.qty_issued_to_service, 0) + t.q,
         issued_to_service_at = now(),            -- = รอบล่าสุดที่เบิก (ไม่ใช่ธง "ครบแล้ว")
         issued_to_service_by = actor.id,
         updated_at = now()
    FROM unnest(ids, takes) AS t(rid, q)
   WHERE x.id = t.rid;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  UPDATE jobs SET install_start_date = sd, install_end_date = ed, issue_location = loc, updated_at = now()
   WHERE id = p_job_id;
  -- นับของค้างจากสถานะ "หลังบันทึก" — บรรทัดที่เบิกไม่เต็มยังค้างอยู่ ต้องนับด้วย
  remain := app_job_pending_issue_acc(p_job_id);
  ptail := CASE WHEN n_partial > 0 THEN ' (เบิกบางส่วน ' || n_partial || ' รายการ)' ELSE '' END;

  -- ⚠️ audit ของฟังก์ชันนี้ **ไม่เคยเก็บนัดหมาย/สถานที่** มาตั้งแต่ 0059 (เก็บเลข PO + รายการของแทน)
  --    §9 บันทึกไว้ว่าการเหมาว่า "ฟังก์ชันกลุ่มเดียวกันเก็บ audit เหมือนกัน" ทำ migration ล้มบน LIVE
  --    มาแล้ว — ห้ามเติม Location เข้ามาที่นี่
  PERFORM app_audit('job', p_job_id, 'issue_accessory_to_service', actor.id,
    'เบิกวัสดุของ ' || j.job_no || ' ให้ Service ' || cnt || ' รายการ จาก ' || COALESCE(ponos, '-') ||
    ' — ' || COALESCE(detail, '-') || ptail ||
    CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' รายการ)' ELSE '' END);

  PERFORM app_finalize_issue(actor, p_job_id);
  SELECT terminal_status INTO now_term FROM jobs WHERE id = p_job_id;
  tail := CASE WHEN was_term IS NULL AND now_term = 'issued' THEN ' · ครบทั้งใบแล้ว' ELSE '' END;

  -- ไม่ใส่ Location ในข้อความแจ้งเตือน (มติ 2026-08-28 · 0063) — audit ด้านบนเก็บไว้ครบแล้ว
  PERFORM app_notify('accessory_issued_to_service',
    '📦 ' || j.job_no || ' เบิกวัสดุ ' || cnt || ' รายการให้ Service (' || COALESCE(ponos, '-') || ') · ' || rng ||
    ptail || CASE WHEN COALESCE(remain, 0) > 0 THEN ' (ค้างอีก ' || remain || ' รายการ)' ELSE '' END || tail,
    'service', p_job_id);
END $$;

CREATE OR REPLACE FUNCTION rpc_issue_job_accessory(
  p_job_id UUID, p_request_ids UUID[], p_qtys NUMERIC[],
  p_start_date DATE, p_end_date DATE, p_location TEXT, p_note TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  PERFORM app_exec_issue_accessory(actor, p_job_id, p_request_ids, p_qtys,
                                   p_start_date, p_end_date, p_location, p_note);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_issue_job_accessory(UUID, UUID[], NUMERIC[], DATE, DATE, TEXT, TEXT) TO authenticated;

-- ---------- 3.05) v_job_status: 'partially_issued' วัดด้วยจำนวนที่ออกไป ไม่ใช่ธง ----------
-- mirror ของ deriveJobStatus ใน logic.ts · ถ้ายังเช็คธง Job ที่ดึงของคืนคลังครบแล้วจะค้าง
-- แสดง partially_issued ตลอดไปทั้งที่ไม่มีของอยู่ข้างนอกเลย
-- ⚠️ คอลัมน์ต้องเหมือนเดิมเป๊ะ (CREATE OR REPLACE VIEW เปลี่ยนชุดคอลัมน์ไม่ได้) — ก็อปจาก 0059
--    แก้จุดเดียวคือ subquery accout ท้ายสุด
CREATE OR REPLACE VIEW v_job_status AS
SELECT
  j.id AS job_id,
  j.job_no,
  CASE
    WHEN j.terminal_status IS NOT NULL THEN j.terminal_status
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
   WHERE r.job_id = j.id AND COALESCE(r.qty_issued_to_service, 0) > 0
     AND r.status NOT IN ('cancelled', 'returned')
) accout ON true;

-- ---------- 3.1) ยกเลิก Job: วัดของที่ออกไปแล้วด้วยจำนวน ไม่ใช่ธง ----------
-- ธง issued_to_service_at ค้างอยู่แม้ของถูกดึงคืนคลังครบแล้ว ⇒ ถ้ายังเช็คธง จะยกเลิก Job
-- ที่คืนของครบแล้วไม่ได้ตลอดไป (mirror ของ logic.ts ที่เปลี่ยนไปใช้ qtyIssuedToService)
CREATE OR REPLACE FUNCTION app_assert_no_issued_out(p_job_id UUID) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT; jno TEXT;
BEGIN
  SELECT (SELECT COUNT(*) FROM lbs_units WHERE job_id = p_job_id AND status = 'issued')
       + (SELECT COUNT(*) FROM job_accessory_requests
           WHERE job_id = p_job_id AND COALESCE(qty_issued_to_service, 0) > 0) INTO n;
  IF COALESCE(n, 0) = 0 THEN RETURN; END IF;
  SELECT job_no INTO jno FROM jobs WHERE id = p_job_id;
  RAISE EXCEPTION '% เบิกของให้ Service ไปแล้วบางส่วน — ยกเลิกไม่ได้ ให้ Service คืนของเข้าคลังก่อน แล้วให้ Manage จัดการเป็นเคส',
    COALESCE(jno, '-');
END $$;

-- ---------- 4) โอนคืนคลัง: รับของที่เบิกออกหน้างานแล้วกลับเข้ามาได้ ----------
-- guard เดิมบล็อกแค่ cancelled อยู่แล้ว ⇒ มติข้อ 2 (โอนได้จนถึงหลังติดตั้ง) ไม่ต้องแก้ guard
-- ที่ต้องเพิ่มคือ: เมื่อจำนวนที่โอนเกิน "ของที่ค้างอยู่ที่ Job" ให้หัก qty_issued_to_service ลง
CREATE OR REPLACE FUNCTION rpc_transfer_job_material_to_stock(
  p_request_id UUID, p_qty NUMERIC, p_note TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; r job_accessory_requests; it items; j jobs;
  remain NUMERIC; at_job NUMERIC; from_site NUMERIC; val NUMERIC; nt TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  SELECT * INTO it FROM items WHERE id = r.item_id;
  SELECT * INTO j FROM jobs WHERE id = r.job_id FOR UPDATE;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว — ของถูกคืนเข้าคลังตอนยกเลิกอยู่แล้ว', j.job_no;
  END IF;
  IF r.status NOT IN ('issued', 'received') THEN
    RAISE EXCEPTION 'โอนเข้าคลังได้เฉพาะวัสดุที่เบิกจากคลังแล้ว หรือรับของจาก PO ครบแล้ว';
  END IF;

  remain  := r.qty_requested - COALESCE(r.qty_transferred, 0);   -- ที่ Job ถือตามบัญชี
  at_job  := app_acc_pending_qty(r);                             -- ที่ยังไม่ออกหน้างาน
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'จำนวนที่โอนต้องมากกว่า 0'; END IF;
  IF p_qty > remain THEN RAISE EXCEPTION 'โอนได้ไม่เกิน % % (คงอยู่ที่ Job)', remain, it.uom; END IF;
  from_site := GREATEST(p_qty - at_job, 0);                      -- ส่วนที่ช่างส่งคืนจากหน้างาน

  UPDATE job_accessory_requests
     SET qty_transferred = COALESCE(qty_transferred, 0) + p_qty,
         qty_issued_to_service = COALESCE(qty_issued_to_service, 0) - from_site,
         updated_at = now()
   WHERE id = p_request_id;

  -- ของมาอยู่ในคลังจริงแล้ว เปิดเก็บสต็อกกลางให้อัตโนมัติ
  UPDATE items SET is_stockable_centrally = true
   WHERE id = r.item_id AND is_stockable_centrally = false;

  nt := COALESCE(NULLIF(btrim(p_note), ''), 'โอนวัสดุเหลือจาก ' || j.job_no);
  PERFORM app_set_stock_ctx('transfer_from_job', r.job_id, r.id, nt, r.unit_price);
  INSERT INTO accessory_stock (item_id, qty_on_hand, avg_unit_cost)
  VALUES (r.item_id, p_qty, COALESCE(r.unit_price, 0))
  ON CONFLICT (item_id) DO UPDATE SET qty_on_hand = accessory_stock.qty_on_hand + EXCLUDED.qty_on_hand,
                                      updated_at = now();

  val := COALESCE(r.unit_price, 0) * p_qty;
  PERFORM app_notify('stock_transfer_in',
    '📦 ' || j.job_no || ' โอน ' || it.name || ' ' || p_qty || ' ' || it.uom ||
    ' เข้าคลังคงเหลือ (ตัดต้นทุนออก ' || round(val, 2) || ' ฿)', 'project', r.job_id);
  PERFORM app_audit('accessory_stock', r.item_id, 'transfer_to_stock', actor.id,
    j.job_no || ' โอน ' || it.name || ' ' || p_qty || ' ' || it.uom || ' เข้าคลังคงเหลือ (ต้นทุนที่ตัดออกจาก Job ' ||
    round(val, 2) || ' บาท)' ||
    -- ของที่เคยออกหน้างานแล้วถูกดึงกลับ ต้องเขียนไว้ให้ชัด ไม่งั้นยอด "เบิกให้ Service" ลดลงเงียบ ๆ
    CASE WHEN from_site > 0
         THEN ' [รวมของที่เบิกออกหน้างานแล้ว ' || trim(to_char(from_site, 'FM999999990.99')) ||
              ' ' || it.uom || ' — ส่งคืนกลับคลัง]'
         ELSE '' END ||
    COALESCE(' — ' || NULLIF(btrim(p_note), ''), ''));
END $$;

-- ---------- 5) ตรวจผล ----------
-- กติกาเดิมของ 0063 ที่ห้ามหลุดหายไปกับการ recreate + กติกาใหม่ของไฟล์นี้
-- ⚠️ ตัดคอมเมนต์ (--) ก่อนเทียบเสมอ — pg_get_functiondef คืนคอมเมนต์ในตัวฟังก์ชันมาด้วย (§9)
DO $$
DECLARE src TEXT; n INT;
BEGIN
  -- 5.1 คอลัมน์ + constraint
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'job_accessory_requests' AND column_name = 'qty_issued_to_service') THEN
    RAISE EXCEPTION '0067: ไม่พบคอลัมน์ qty_issued_to_service';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jar_qty_split_ck') THEN
    RAISE EXCEPTION '0067: ไม่พบ constraint jar_qty_split_ck';
  END IF;

  -- 5.2 backfill ต้องไม่เหลือแถวที่ "เบิกไปแล้ว" แต่จำนวนเป็น 0 (จะกลายเป็นของค้างปลอมขวางการปิดใบ)
  SELECT COUNT(*) INTO n FROM job_accessory_requests
   WHERE issued_to_service_at IS NOT NULL AND COALESCE(qty_issued_to_service, 0) = 0
     AND status NOT IN ('cancelled', 'returned')
     AND (qty_requested - COALESCE(qty_transferred, 0)) > 0;
  IF n > 0 THEN RAISE EXCEPTION '0067: backfill ไม่ครบ — เหลือ % แถวที่เบิกแล้วแต่จำนวนเป็น 0', n; END IF;

  -- 5.3 ต้องมี rpc/exec signature ใหม่ **ตัวเดียว** (2 overload = PGRST203 · §9 ข้อ 8)
  SELECT COUNT(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_issue_job_accessory';
  IF n <> 1 THEN RAISE EXCEPTION '0067: rpc_issue_job_accessory มี % overload (ต้องเหลือ 1)', n; END IF;
  SELECT COUNT(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_exec_issue_accessory';
  IF n <> 1 THEN RAISE EXCEPTION '0067: app_exec_issue_accessory มี % overload (ต้องเหลือ 1)', n; END IF;

  -- 5.4 app_acc_issue_block ต้องเลิกใช้ธง issued_to_service_at เป็นตัวปิดบรรทัด
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_acc_issue_block';
  IF position('issued_to_service_at' IN src) > 0 THEN
    RAISE EXCEPTION '0067: app_acc_issue_block ยังตัดสินจาก issued_to_service_at อยู่ — ต้องใช้จำนวนคงค้าง';
  END IF;
  IF position('app_acc_pending_qty' IN src) = 0 THEN
    RAISE EXCEPTION '0067: app_acc_issue_block ไม่ได้ใช้ app_acc_pending_qty';
  END IF;

  -- 5.5 คุณสมบัติของ 0063 ต้องยังอยู่ + ของใหม่ของไฟล์นี้ต้องมาครบ
  --   ⚠️ ฟังก์ชันนี้ **ไม่ต้องมี Location ใน audit** (ต่างจาก app_exec_issue_lbs) — §9 บทเรียนที่ 2
  --      เช็คผิดด้านนี้เคยทำ migration ล้มบน LIVE มาแล้ว
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_exec_issue_accessory';
  IF position('app_acc_pending_qty' IN src) = 0 THEN
    RAISE EXCEPTION '0067: app_exec_issue_accessory ไม่ได้คิดเพดานจากจำนวนคงค้าง (app_acc_pending_qty)';
  END IF;
  IF position('qty_issued_to_service' IN src) = 0 THEN
    RAISE EXCEPTION '0067: app_exec_issue_accessory ไม่ได้บวกจำนวนลง qty_issued_to_service';
  END IF;
  IF position('ครบทั้งใบแล้ว' IN src) = 0 THEN
    RAISE EXCEPTION '0067: app_exec_issue_accessory ไม่มีหาง "ครบทั้งใบแล้ว" (0063 ยุบใบ job_issued มารวมที่นี่)';
  END IF;
  IF position('app_notify(''job_issued''' IN src) > 0 THEN
    RAISE EXCEPTION '0067: app_exec_issue_accessory กลับไปยิง job_issued แยกใบ — ขัดกับ 0063';
  END IF;

  -- 5.6 การโอนคืนต้องหัก qty_issued_to_service เมื่อดึงของกลับจากหน้างาน
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_transfer_job_material_to_stock';
  IF position('qty_issued_to_service' IN src) = 0 THEN
    RAISE EXCEPTION '0067: rpc_transfer_job_material_to_stock ไม่ได้หัก qty_issued_to_service';
  END IF;

  -- 5.7 v_job_status + app_assert_no_issued_out ต้องเลิกวัดด้วยธงแล้ว (ไม่งั้น demo/LIVE ตอบไม่ตรงกัน)
  SELECT regexp_replace(pg_get_viewdef('v_job_status'::regclass, true), '--[^\n]*', '', 'g') INTO src;
  IF position('qty_issued_to_service' IN src) = 0 THEN
    RAISE EXCEPTION '0067: v_job_status ยังวัด partially_issued จากธง issued_to_service_at';
  END IF;
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_assert_no_issued_out';
  IF position('qty_issued_to_service' IN src) = 0 THEN
    RAISE EXCEPTION '0067: app_assert_no_issued_out ยังเช็คธง — Job ที่คืนของครบแล้วจะยกเลิกไม่ได้';
  END IF;

  -- 5.8 ยังต้องอ่าน v_job_status ได้ (กัน CREATE OR REPLACE VIEW ที่คอลัมน์เพี้ยน)
  PERFORM count(*) FROM v_job_status;

  RAISE NOTICE '0067: OK — เบิกทีละจำนวน + โอนคืนคลังรับของจากหน้างานได้';
END $$;
