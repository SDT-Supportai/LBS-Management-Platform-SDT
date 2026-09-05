-- =====================================================================
-- 0065: ทำเบิก-Epicor — เลือกประเภท transaction ตอนกด Done (2026-09-02)
--
--  ที่มา: 0064 เก็บแค่ "ทำเบิกแล้ว + เลขเอกสาร" แต่ Epicor ตัดยอดได้ 2 ทางที่ไป
--  คนละฝั่งบัญชี ⇒ รู้ว่าทำแล้วยังไม่พอ ต้องรู้ว่าทำด้วย transaction ไหน:
--      Cust-Ship  = ของที่ส่งลูกค้าแล้วออก Invoice   → ฝั่ง **รายได้**
--      Issue-Mis  = ของที่เบิกออกไปใช้ ไม่ออก Invoice → ฝั่ง **ต้นทุน**
--
--  กด Done → dropdown ให้เลือก 1 ใน 2 (**บังคับเลือก** · ไม่ preselect เพื่อกันกดรวด ๆ
--  แล้วได้ค่าแรกติดไปทั้งแผงโดยไม่ได้ตั้งใจ) · เลขเอกสารยังเว้นว่างได้เหมือนเดิม
--  คอลัมน์แสดง badge ประเภท · ไฟล์ Export Excel มีช่อง "ประเภท Epicor" เพิ่มมาด้วย
--
--  ⚠️ แถวที่กด Done ไว้ตั้งแต่ 0064 (ก่อนมี dropdown) → epicor_txn_type = NULL
--     **ไม่ backfill** (มติผู้ใช้ 2026-09-02) เพราะเดาแทนคนทำไม่ได้ว่าตัดฝั่งไหน
--     หน้าจอขึ้น "ไม่ระบุประเภท" ให้เห็นชัดว่าแถวไหนยังขาดข้อมูล · ถ้าอยากแก้ ใช้
--     ปุ่มยกเลิกแล้วกด Done ใหม่ (ยกเลิกต้องระบุเหตุผล ลง audit ตามเดิม)
--
--  ⚠️⚠️ **เปลี่ยน signature ของ rpc_mark_epicor_issued** (UUID, TEXT) → (UUID, TEXT, TEXT)
--     ⇒ ต้อง DROP ตัวเก่าก่อน ไม่งั้นเหลือ 2 overload แล้ว PostgREST error
--        ambiguous (PGRST203 · §9 ข้อ 8) · และ **ต้องรัน SQL ก่อน push frontend**
--        ไม่งั้นปุ่ม Done ยิงไปหา signature ใหม่ที่ยังไม่มี → PGRST202
--     rpc_undo_epicor_issued ไม่เปลี่ยน signature (แค่ล้างคอลัมน์เพิ่ม 1 ช่อง)
--
--  demo sync: src/types.ts (EpicorTxnType) · logic.ts (EPICOR_TXN_LABEL + guard)
--             · format.ts (EPICOR_TXN) · components.tsx (PromptField type 'select')
--             · remote.ts · JobDetailPage + 2 เคสใน logic.test.ts
--  รันหลัง 0064 · idempotent
-- =====================================================================

-- ---------- 1) คอลัมน์ ----------
-- CHECK รับ NULL ได้ (แถวเก่าจาก 0064) แต่ถ้ามีค่า ต้องเป็น 1 ใน 2 ตัวนี้เท่านั้น
ALTER TABLE job_accessory_requests
  ADD COLUMN IF NOT EXISTS epicor_txn_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_acc_req_epicor_txn_type_check') THEN
    ALTER TABLE job_accessory_requests
      ADD CONSTRAINT job_acc_req_epicor_txn_type_check
      CHECK (epicor_txn_type IS NULL OR epicor_txn_type IN ('cust_ship', 'issue_mis'));
  END IF;
END $$;

COMMENT ON COLUMN job_accessory_requests.epicor_txn_type IS
  '0065: ประเภท transaction ที่ใช้ตัดใน Epicor — cust_ship (ออก Invoice · ฝั่งรายได้) / issue_mis (เบิกออกใช้ · ฝั่งต้นทุน) · NULL = แถวที่กด Done ไว้ตั้งแต่ 0064 ก่อนมี dropdown';

-- ---------- 2) rpc_mark_epicor_issued — เพิ่ม p_txn_type (บังคับ) ----------
-- DROP ตัวเดิมก่อนเสมอ ไม่งั้นเหลือ 2 overload → PGRST203 (§9 ข้อ 8)
DROP FUNCTION IF EXISTS rpc_mark_epicor_issued(UUID, TEXT);
CREATE OR REPLACE FUNCTION rpc_mark_epicor_issued(
  p_request_id UUID, p_txn_type TEXT, p_doc_no TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items; v_doc TEXT; v_type TEXT; v_label TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  IF r.status NOT IN ('issued', 'received') THEN
    RAISE EXCEPTION 'ทำเบิก-Epicor ได้เฉพาะรายการที่ของอยู่กับ Job แล้ว (เบิกคลัง รอนำใช้ / รับของแล้ว รอนำใช้)';
  END IF;
  IF r.epicor_issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'รายการนี้ทำเบิก-Epicor ไปแล้ว';
  END IF;

  -- บังคับเลือกประเภท — ปล่อยว่างได้เมื่อไหร่ จะมีแถวที่ระบุไม่ครบค้างไว้
  -- แล้วคนกระทบยอดต้องมาไล่ถามทีหลังว่าบรรทัดนี้ตัดฝั่งรายได้หรือฝั่งต้นทุน
  v_type := NULLIF(btrim(COALESCE(p_txn_type, '')), '');
  IF v_type IS NULL OR v_type NOT IN ('cust_ship', 'issue_mis') THEN
    RAISE EXCEPTION 'กรุณาเลือกประเภทการตัดใน Epicor (Cust-Ship / Issue-Mis)';
  END IF;
  v_label := CASE v_type WHEN 'cust_ship' THEN 'Cust-Ship' ELSE 'Issue-Mis' END;

  v_doc := NULLIF(btrim(COALESCE(p_doc_no, '')), '');
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  SELECT * INTO it FROM items WHERE id = r.item_id;

  UPDATE job_accessory_requests
     SET epicor_issued_at = now(), epicor_issued_by = actor.id,
         epicor_txn_type = v_type, epicor_doc_no = v_doc, updated_at = now()
   WHERE id = p_request_id;

  PERFORM app_audit('accessory_request', p_request_id, 'epicor_issued', actor.id,
    'ทำเบิก-Epicor (' || v_label || ') ' || COALESCE(it.name, '-') || ' ' || r.qty_requested || ' ' ||
    COALESCE(it.uom, '') || ' ของ ' || COALESCE(j.job_no, '-') ||
    CASE WHEN v_doc IS NOT NULL THEN ' · เอกสาร ' || v_doc ELSE ' · ไม่ระบุเลขเอกสาร' END);
END $$;

-- ---------- 3) rpc_undo_epicor_issued — ล้างประเภทด้วย (signature เดิม) ----------
CREATE OR REPLACE FUNCTION rpc_undo_epicor_issued(p_request_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items; v_reason TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ยกเลิก (เพื่อ audit)'; END IF;

  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  IF r.epicor_issued_at IS NULL THEN RAISE EXCEPTION 'รายการนี้ยังไม่ได้ทำเบิก-Epicor'; END IF;

  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  SELECT * INTO it FROM items WHERE id = r.item_id;

  UPDATE job_accessory_requests
     SET epicor_issued_at = NULL, epicor_issued_by = NULL,
         epicor_txn_type = NULL, epicor_doc_no = NULL, updated_at = now()
   WHERE id = p_request_id;

  PERFORM app_audit('accessory_request', p_request_id, 'epicor_issued_undo', actor.id,
    'ยกเลิกธงทำเบิก-Epicor ' || COALESCE(it.name, '-') || ' ของ ' || COALESCE(j.job_no, '-') ||
    CASE WHEN r.epicor_doc_no IS NOT NULL THEN ' (เดิม ' || r.epicor_doc_no || ')' ELSE '' END ||
    ': ' || v_reason);
END $$;

-- ---------- 4) สิทธิ์ ----------
GRANT EXECUTE ON FUNCTION public.rpc_mark_epicor_issued(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_undo_epicor_issued(UUID, TEXT) TO authenticated;

-- ---------- 5) ตรวจผล ----------
-- ตัดคอมเมนต์ก่อนเทียบเสมอ (บทเรียนจาก 0063) · และเช็คเฉพาะสิ่งที่อ่าน body มาแล้วจริง
DO $$
DECLARE n INT; src TEXT;
BEGIN
  -- คอลัมน์ + CHECK
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'job_accessory_requests'
                    AND column_name = 'epicor_txn_type') THEN
    RAISE EXCEPTION '0065: ไม่พบคอลัมน์ epicor_txn_type';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_acc_req_epicor_txn_type_check') THEN
    RAISE EXCEPTION '0065: ไม่พบ CHECK constraint ของ epicor_txn_type';
  END IF;

  -- ต้องเหลือ rpc_mark_epicor_issued แค่ overload เดียว (ไม่งั้น PostgREST ambiguous)
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_mark_epicor_issued';
  IF n <> 1 THEN RAISE EXCEPTION '0065: rpc_mark_epicor_issued มี % overload (ต้องเหลือ 1 เท่านั้น)', n; END IF;

  -- ตัวใหม่ต้องบังคับประเภทจริง
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_mark_epicor_issued';
  IF position('กรุณาเลือกประเภทการตัดใน Epicor' IN src) = 0 THEN
    RAISE EXCEPTION '0065: rpc_mark_epicor_issued ไม่ได้บังคับเลือกประเภท';
  END IF;
  IF position('app_assert_dept(ARRAY[''purchasing''])' IN src) = 0 THEN
    RAISE EXCEPTION '0065: rpc_mark_epicor_issued ไม่ได้จำกัดสิทธิ์เป็น purchasing';
  END IF;

  -- undo ต้องล้างประเภทด้วย ไม่งั้นกด Done ใหม่แล้วประเภทเก่าค้าง
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_undo_epicor_issued';
  IF position('epicor_txn_type = NULL' IN src) = 0 THEN
    RAISE EXCEPTION '0065: rpc_undo_epicor_issued ไม่ได้ล้าง epicor_txn_type';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '0065 OK — ทำเบิก-Epicor เลือกประเภทได้ (Cust-Ship / Issue-Mis) · บังคับเลือก · แถวเก่าจาก 0064 ปล่อยเป็น NULL'; END $$;

-- ---------------------------------------------------------------------
-- rollback:
--   DROP FUNCTION IF EXISTS rpc_mark_epicor_issued(UUID, TEXT, TEXT);
--   -- แล้วรัน section 2 ของ 0064_epicor_issue_flag.sql ซ้ำ เพื่อเอา signature (UUID, TEXT) กลับมา
--   ALTER TABLE job_accessory_requests DROP CONSTRAINT IF EXISTS job_acc_req_epicor_txn_type_check;
--   ALTER TABLE job_accessory_requests DROP COLUMN IF EXISTS epicor_txn_type;
-- ---------------------------------------------------------------------
