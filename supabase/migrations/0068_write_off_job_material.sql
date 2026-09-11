-- =============================================================================
-- 0068 — ✂️ ตัดจำหน่ายของเหลือที่ Job (2026-09-11)
--
-- โจทย์: 0067 ทำให้บรรทัด "จบ" เมื่อทุกชิ้นมีที่ไปครบ ⇒ ของเหลือเศษ ๆ ที่ไม่คุ้มจะโอนคืนคลัง
--   (น็อต 3 ตัว · สายเหลือ 2 เมตร) จะค้างขวางการปิด Job ไปตลอด เพราะไม่มีใครอยากไปทำรายการโอน
--
-- ทางออก: ช่องที่ 4 ของบัญชีต่อบรรทัด — ผลรวมยังต้องเท่ากับ qty_requested เสมอ
--   qty_transferred        โอนคืนคลังคงเหลือแล้ว  (**ตัดต้นทุนออกจาก Job** — ของกลับไปให้งานอื่นใช้)
--   qty_issued_to_service  เบิกออกไปหน้างานแล้ว    (ต้นทุนยังอยู่กับ Job)
--   **qty_written_off**    ตัดจำหน่ายของเหลือ      (ต้นทุนยังอยู่กับ Job) ← คอลัมน์ใหม่ของไฟล์นี้
--   ที่เหลือ                ค้างอยู่ที่ Job
--
-- 🔴 2 ข้อที่ต่างจากการโอนคืนคลัง และห้ามทำสลับกัน:
--   1) **ต้นทุนยังอยู่กับ Job** — ห้ามไปบวก qty_transferred เด็ดขาด ไม่งั้นงบงานลดลงทั้งที่ไม่มีของกลับมา
--      (ของถือว่าสูญไปกับงานนี้จริง ไม่ใช่การคืนของ)
--   2) **ไม่ลง stock_movements** — ของไม่เคยอยู่ในคลังกลาง (ถูกตัดออกตอนเบิกเข้า Job หรือซื้อตรงผ่าน PO)
--      ถ้าลงแถวในบัญชีเดินสะพัด: รายงานผู้บริหาร Material Database ที่ sum qty เป็น
--      "ปริมาณเข้าคลัง / ปริมาณออกจากคลัง" จะ**นับซ้ำ** และ balance_after จะอ่านไม่ตรงกับยอดจริง
--      ⇒ หลักฐานอยู่ที่ **Audit Log + 4 ฟิลด์บนบรรทัด** (หน้าเว็บโชว์เป็นตารางแยกในป๊อปอัป
--        ประวัติการเคลื่อนไหว พร้อมกำกับว่า "ไม่กระทบยอดคลัง")
--      กติกาเดียวกับ rpc_set_stock_lot ที่ตั้งใจไม่ลง ledger เพราะของไม่ได้เคลื่อนไหว
--
-- ตัดได้เฉพาะ "ของที่ยังค้างอยู่ที่ Job" — ของที่เบิกออกหน้างานไปแล้วถือว่าใช้ไปกับงานแล้ว
-- ไม่ต้องมารายการตัดจำหน่ายอีก · ไม่มี RPC ยกเลิกการตัดจำหน่าย (แก้ผิดให้ Manage จัดการเป็นเคส)
--
-- ไม่เปลี่ยน signature ของเดิมเลย · เพิ่ม RPC ใหม่ 1 ตัว ⇒ **รันก่อนหรือหลัง push ก็ได้**
-- (ปุ่ม ✂️ จะได้ PGRST202 จนกว่าจะรัน SQL — ไม่กระทบฟีเจอร์อื่น)
-- =============================================================================

-- ---------- 1) คอลัมน์ใหม่ ----------
ALTER TABLE job_accessory_requests
  ADD COLUMN IF NOT EXISTS qty_written_off  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS write_off_reason TEXT,
  ADD COLUMN IF NOT EXISTS written_off_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS written_off_by   UUID REFERENCES profiles(id);

COMMENT ON COLUMN job_accessory_requests.qty_written_off IS
  'ตัดจำหน่ายของเหลือที่ Job (0068) — ไม่เข้าคลังคงเหลือ ไม่ลง stock_movements '
  'และ **ไม่ลดต้นทุน Job** (ต่างจาก qty_transferred) · หลักฐานอยู่ที่ Audit Log';

-- ไม่ต้อง backfill — ก่อนไฟล์นี้ยังไม่มีการตัดจำหน่ายในระบบ (DEFAULT 0 ถูกต้องแล้ว)

-- constraint ของ 0067 ยังไม่รู้จักช่องที่ 4 ⇒ ต้องเปลี่ยนสูตร (DROP แล้วสร้างใหม่)
ALTER TABLE job_accessory_requests DROP CONSTRAINT IF EXISTS jar_qty_split_ck;
ALTER TABLE job_accessory_requests
  ADD CONSTRAINT jar_qty_split_ck CHECK (
    qty_issued_to_service >= 0
    AND COALESCE(qty_transferred, 0) >= 0
    AND qty_written_off >= 0
    AND qty_issued_to_service + COALESCE(qty_transferred, 0) + qty_written_off <= qty_requested
  ) NOT VALID;

-- ---------- 2) ของค้างที่ Job ต้องหักของที่ตัดจำหน่ายแล้วด้วย ----------
-- ตัวนี้เป็นหัวใจ: app_acc_issue_block · app_job_pending_issue_acc (⇒ เงื่อนไขปิด Job) และ
-- rpc_transfer_job_material_to_stock เรียกใช้อยู่แล้ว ⇒ แก้ที่เดียวมีผลทั้งสาย
CREATE OR REPLACE FUNCTION app_acc_pending_qty(r job_accessory_requests) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(
    r.qty_requested
      - COALESCE(r.qty_transferred, 0)
      - COALESCE(r.qty_issued_to_service, 0)
      - COALESCE(r.qty_written_off, 0), 0)
$$;

-- ---------- 3) โอนคืนคลัง: เพดานต้องหักของที่ตัดจำหน่ายแล้ว ----------
-- ของที่ถูกตัดจำหน่ายไม่มีตัวตนให้โอนคืน · ไม่หักออกจากเพดานจะโอนเกินของที่มีจริง
-- และดัน qty_issued_to_service ติดลบ (ชน constraint)
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

  -- 0068: หัก qty_written_off ออกจากเพดานด้วย (ของที่ตัดจำหน่ายแล้วไม่มีให้โอน)
  remain  := r.qty_requested - COALESCE(r.qty_transferred, 0) - COALESCE(r.qty_written_off, 0);
  at_job  := app_acc_pending_qty(r);
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'จำนวนที่โอนต้องมากกว่า 0'; END IF;
  IF p_qty > remain THEN RAISE EXCEPTION 'โอนได้ไม่เกิน % % (คงอยู่ที่ Job)', remain, it.uom; END IF;
  from_site := GREATEST(p_qty - at_job, 0);   -- ส่วนที่ช่างส่งคืนจากหน้างาน (0067)

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
    CASE WHEN from_site > 0
         THEN ' [รวมของที่เบิกออกหน้างานแล้ว ' || trim(to_char(from_site, 'FM999999990.99')) ||
              ' ' || it.uom || ' — ส่งคืนกลับคลัง]'
         ELSE '' END ||
    COALESCE(' — ' || NULLIF(btrim(p_note), ''), ''));

  -- 🔴 บั๊กที่ 0067 ทิ้งไว้: ตั้งแต่ 0067 บรรทัด "จบ" ได้ด้วยการ **โอนคืนคลัง** ไม่ใช่การเบิกเท่านั้น
  --   แต่ RPC นี้ (เขียนไว้ตั้งแต่ 0038) ไม่เคยเรียก app_finalize_issue ⇒ ถ้าการโอนคืนเป็นชิ้นสุดท้าย
  --   ที่ทำให้ทุกบรรทัดจบ Job จะค้าง partially_issued ไปจนกว่าจะมี action เบิกอย่างอื่นมากระตุ้น
  --   (no-op ถ้าใบปิดแล้ว หรือยังมีของค้าง — เรียกซ้ำปลอดภัยตามที่ 0059 ออกแบบไว้)
  PERFORM app_finalize_issue(actor, r.job_id);
END $$;

-- ---------- 4) RPC ตัดจำหน่าย ----------
-- สิทธิ์เดียวกับการโอนคืนคลัง (Project เจ้าของงาน + Manage) — เป็นการจัดการของในมือ Job
-- ⚠️ ไม่แตะ accessory_stock · ไม่เรียก app_set_stock_ctx · ไม่ INSERT stock_movements (ดูเหตุผลหัวไฟล์)
CREATE OR REPLACE FUNCTION rpc_write_off_job_material(
  p_request_id UUID, p_qty NUMERIC, p_reason TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; r job_accessory_requests; it items; j jobs;
  at_job NUMERIC; val NUMERIC; rsn TEXT;
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
    RAISE EXCEPTION 'ตัดจำหน่ายได้เฉพาะวัสดุที่เบิกจากคลังแล้ว หรือรับของจาก PO ครบแล้ว';
  END IF;

  rsn := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF rsn IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการตัดจำหน่าย'; END IF;

  at_job := app_acc_pending_qty(r);   -- ตัดได้เฉพาะของที่ยังค้างอยู่ที่ Job
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'จำนวนที่ตัดจำหน่ายต้องมากกว่า 0'; END IF;
  IF p_qty > at_job THEN
    RAISE EXCEPTION 'ตัดจำหน่ายได้ไม่เกิน % % (ของที่ยังค้างอยู่ที่ Job)', at_job, it.uom;
  END IF;

  UPDATE job_accessory_requests
     SET qty_written_off = COALESCE(qty_written_off, 0) + p_qty,
         write_off_reason = rsn, written_off_at = now(), written_off_by = actor.id,
         updated_at = now()
   WHERE id = p_request_id;

  val := COALESCE(r.unit_price, 0) * p_qty;
  PERFORM app_audit('accessory_stock', r.item_id, 'write_off_at_job', actor.id,
    j.job_no || ' ตัดจำหน่าย ' || it.name || ' ' || p_qty || ' ' || it.uom || ' ที่ Job (ไม่เข้าคลัง · ต้นทุน ' ||
    round(val, 2) || ' บาท ยังอยู่กับ Job) — ' || rsn);

  -- ตัดจำหน่ายอาจเป็นชิ้นสุดท้ายที่ทำให้ทุกบรรทัดจบ ⇒ ต้องให้โอกาสปิดใบเหมือน action เบิก
  PERFORM app_finalize_issue(actor, r.job_id);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_write_off_job_material(UUID, NUMERIC, TEXT) TO authenticated;

-- ---------- 5) ตรวจผล ----------
DO $$
DECLARE src TEXT; n INT; c TEXT;
BEGIN
  -- 5.1 คอลัมน์ครบ 4 ช่อง
  FOREACH c IN ARRAY ARRAY['qty_written_off', 'write_off_reason', 'written_off_at', 'written_off_by'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'job_accessory_requests' AND column_name = c) THEN
      RAISE EXCEPTION '0068: ไม่พบคอลัมน์ %', c;
    END IF;
  END LOOP;

  -- 5.2 constraint ต้องรู้จักช่องที่ 4 แล้ว (ไม่งั้นตัดจำหน่ายเกินจำนวนที่ขอได้)
  SELECT pg_get_constraintdef(oid) INTO src FROM pg_constraint WHERE conname = 'jar_qty_split_ck';
  IF src IS NULL THEN RAISE EXCEPTION '0068: ไม่พบ constraint jar_qty_split_ck'; END IF;
  IF position('qty_written_off' IN src) = 0 THEN
    RAISE EXCEPTION '0068: jar_qty_split_ck ยังไม่นับ qty_written_off';
  END IF;

  -- 5.3 ของค้างที่ Job ต้องหักของที่ตัดจำหน่ายแล้ว (หัวใจของกติกาปิด Job)
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_acc_pending_qty';
  IF src IS NULL THEN RAISE EXCEPTION '0068: ไม่พบ app_acc_pending_qty — ต้องรัน 0067 ก่อน'; END IF;
  IF position('qty_written_off' IN src) = 0 THEN
    RAISE EXCEPTION '0068: app_acc_pending_qty ไม่ได้หัก qty_written_off';
  END IF;

  -- 5.4 RPC ใหม่ต้องมีตัวเดียว และ **ห้ามแตะคลัง/ledger** (เหตุผลอยู่หัวไฟล์ — กันคนแก้ทีหลังเผลอเติม)
  SELECT COUNT(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_write_off_job_material';
  IF n <> 1 THEN RAISE EXCEPTION '0068: rpc_write_off_job_material มี % overload (ต้องเหลือ 1)', n; END IF;
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_write_off_job_material';
  -- เช็คที่ "การเขียนจริง" ไม่ใช่แค่ชื่อ — app_audit ใช้ 'accessory_stock' เป็น entity_type ได้ตามปกติ
  IF position('UPDATE accessory_stock' IN src) > 0 OR position('INSERT INTO accessory_stock' IN src) > 0
     OR position('app_set_stock_ctx' IN src) > 0 OR position('stock_movements' IN src) > 0 THEN
    RAISE EXCEPTION '0068: rpc_write_off_job_material ไปแตะคลัง/บัญชีเดินสะพัด — ของตัดจำหน่ายไม่เคยอยู่ในคลังกลาง จะทำให้รายงานนับซ้ำ';
  END IF;
  IF position('qty_transferred' IN src) > 0 THEN
    RAISE EXCEPTION '0068: rpc_write_off_job_material ไปแตะ qty_transferred — ต้นทุน Job จะลดลงทั้งที่ไม่มีของกลับมา';
  END IF;
  IF position('app_finalize_issue' IN src) = 0 THEN
    RAISE EXCEPTION '0068: rpc_write_off_job_material ไม่เรียก app_finalize_issue — ตัดชิ้นสุดท้ายแล้ว Job จะไม่ปิดเอง';
  END IF;

  -- 5.5 เพดานการโอนคืนคลังต้องหักของที่ตัดจำหน่ายแล้ว
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_transfer_job_material_to_stock';
  IF position('qty_written_off' IN src) = 0 THEN
    RAISE EXCEPTION '0068: rpc_transfer_job_material_to_stock ไม่ได้หัก qty_written_off ออกจากเพดาน';
  END IF;
  -- 5.6 การโอนคืนคลังต้องปิดใบเองได้ (บั๊กที่ 0067 ทิ้งไว้ — ดูคอมเมนต์ในตัวฟังก์ชัน)
  IF position('app_finalize_issue' IN src) = 0 THEN
    RAISE EXCEPTION '0068: rpc_transfer_job_material_to_stock ไม่เรียก app_finalize_issue — โอนคืนชิ้นสุดท้ายแล้ว Job จะค้าง partially_issued';
  END IF;

  RAISE NOTICE '0068: OK — ตัดจำหน่ายของเหลือที่ Job ได้ (Audit เท่านั้น ไม่แตะคลัง)';
END $$;
