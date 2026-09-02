-- =====================================================================
-- 0064: ทำเบิก-Epicor — ธงกระทบยอดรายบรรทัดกับ ERP (2026-09-01)
--
--  ที่มา: ของถึงมือ Job แล้ว (เบิกจากคลังคงเหลือ = status 'issued' · รับของจาก PO ครบ
--  = status 'received') แต่ **Epicor ยังไม่รู้** จนกว่าจะมีคนไปตัดใบเบิกใน ERP ให้
--  ⇒ ยอดคงคลังใน Epicor ค้างสูงเกินจริง และไม่มีใครตอบได้ว่าบรรทัดไหนตัดไปแล้วบ้าง
--  นอกจากไล่ถามกันเอง
--
--  เพิ่มคอลัมน์ "ทำเบิก-Epicor" ในตาราง Purchase Orders ของหน้า Job:
--    - ปุ่ม Done ขึ้นเฉพาะบรรทัดที่ของอยู่กับ Job แล้ว (status = 'issued' หรือ 'received')
--    - กดแล้วกรอก **เลขที่เอกสาร Epicor** ได้ (เว้นว่างได้) → คอลัมน์ขึ้น ✅ + เลขเอกสาร
--      + วันที่/คนกด · ไฟล์ Export Excel ของหน้าเดียวกันก็มี 3 ช่องนี้ติดไปด้วย
--    - กดผิดยกเลิกได้ แต่ต้องระบุเหตุผล (ลง audit)
--
--  ⚠️ **เป็นธงล้วน ๆ ไม่ใช่สถานะของ** (มติผู้ใช้ 2026-09-01):
--    - ไม่แตะ job_accessory_requests.status · ไม่แตะ issued_to_service_at
--    - **ไม่บล็อกการเบิกให้ Service** — งานหน้าไซต์ไม่ควรรองานเอกสาร
--      (ถ้าบล็อก: ของถึงหน้างานแล้วแต่ทีมช่างออกไม่ได้เพราะ Purchasing ยังไม่ได้กดปุ่ม)
--    - ยังกดได้แม้บรรทัดนั้นเบิกให้ Service ไปแล้ว เพราะเอกสารมักตามหลังของจริง
--
--  สิทธิ์: Purchasing + Manage (คนที่ตัดใบเบิกใน Epicor จริงคือ Purchasing)
--  frontend perm: 'epicor.issue' = ['purchasing', 'admin']
--
--  ✅ เพิ่มคอลัมน์ + RPC ใหม่ 2 ตัว · ไม่แตะฟังก์ชันเดิมสักตัว ไม่เปลี่ยน signature ใคร
--     ⚠️ **RPC ใหม่ ⇒ ต้องรัน SQL ก่อน push frontend** ไม่งั้นปุ่ม Done จะได้ PGRST202
--  ⚠️ ไม่มี trigger บน job_accessory_requests (trg_block_issued_edit อยู่บน lbs_units
--     เท่านั้น — ตรวจแล้ว) จึง UPDATE แถวได้ตรง ๆ ไม่ต้องปิด trigger
--  demo sync: src/types.ts · src/data/logic.ts (markEpicorIssued / undoEpicorIssued)
--             · StoreContext (perm + act) · remote.ts (mapper + rpc) · JobDetailPage (คอลัมน์)
--  รันหลัง 0063 · idempotent
-- =====================================================================

-- ---------- 1) คอลัมน์ ----------
ALTER TABLE job_accessory_requests
  ADD COLUMN IF NOT EXISTS epicor_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS epicor_issued_by UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS epicor_doc_no    TEXT;

COMMENT ON COLUMN job_accessory_requests.epicor_issued_at IS
  '0064: ตัดใบเบิกใน Epicor แล้วเมื่อ (ว่าง = ยังไม่ได้ทำ) — ธงกระทบยอดกับ ERP ไม่ใช่สถานะของ';
COMMENT ON COLUMN job_accessory_requests.epicor_doc_no IS
  '0064: เลขที่เอกสารใบเบิกใน Epicor (เว้นว่างได้) — ใช้ตามกลับไปหาใบเบิกตอนกระทบยอด';

-- ---------- 2) rpc_mark_epicor_issued ----------
CREATE OR REPLACE FUNCTION rpc_mark_epicor_issued(p_request_id UUID, p_doc_no TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; r job_accessory_requests; j jobs; it items; v_doc TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  -- ของต้องอยู่กับ Job แล้วเท่านั้น — ยังไม่รับของก็ยังไม่มีอะไรให้ตัดยอดใน Epicor
  IF r.status NOT IN ('issued', 'received') THEN
    RAISE EXCEPTION 'ทำเบิก-Epicor ได้เฉพาะรายการที่ของอยู่กับ Job แล้ว (เบิกคลัง รอนำใช้ / รับของแล้ว รอนำใช้)';
  END IF;
  IF r.epicor_issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'รายการนี้ทำเบิก-Epicor ไปแล้ว';
  END IF;

  v_doc := NULLIF(btrim(COALESCE(p_doc_no, '')), '');
  SELECT * INTO j FROM jobs WHERE id = r.job_id;
  SELECT * INTO it FROM items WHERE id = r.item_id;

  UPDATE job_accessory_requests
     SET epicor_issued_at = now(), epicor_issued_by = actor.id, epicor_doc_no = v_doc,
         updated_at = now()
   WHERE id = p_request_id;

  PERFORM app_audit('accessory_request', p_request_id, 'epicor_issued', actor.id,
    'ทำเบิก-Epicor ' || COALESCE(it.name, '-') || ' ' || r.qty_requested || ' ' || COALESCE(it.uom, '') ||
    ' ของ ' || COALESCE(j.job_no, '-') ||
    CASE WHEN v_doc IS NOT NULL THEN ' · เอกสาร ' || v_doc ELSE ' · ไม่ระบุเลขเอกสาร' END);
END $$;

-- ---------- 3) rpc_undo_epicor_issued ----------
-- กดผิดบรรทัด / เลขเอกสารผิด — ต้องระบุเหตุผลเสมอ เพื่อให้ audit ตอบได้ว่าทำไมธงหาย
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
     SET epicor_issued_at = NULL, epicor_issued_by = NULL, epicor_doc_no = NULL, updated_at = now()
   WHERE id = p_request_id;

  PERFORM app_audit('accessory_request', p_request_id, 'epicor_issued_undo', actor.id,
    'ยกเลิกธงทำเบิก-Epicor ' || COALESCE(it.name, '-') || ' ของ ' || COALESCE(j.job_no, '-') ||
    CASE WHEN r.epicor_doc_no IS NOT NULL THEN ' (เดิม ' || r.epicor_doc_no || ')' ELSE '' END ||
    ': ' || v_reason);
END $$;

-- ---------- 4) สิทธิ์ ----------
GRANT EXECUTE ON FUNCTION public.rpc_mark_epicor_issued(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_undo_epicor_issued(UUID, TEXT) TO authenticated;

-- ---------- 5) ตรวจผล ----------
-- ตัดคอมเมนต์ก่อนเทียบเสมอ (บทเรียนจาก 0063) และเช็คที่ "การเรียกจริง" ไม่ใช่ชื่อ event
DO $$
DECLARE n INT; src TEXT; nm TEXT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'job_accessory_requests'
     AND column_name IN ('epicor_issued_at', 'epicor_issued_by', 'epicor_doc_no');
  IF n <> 3 THEN RAISE EXCEPTION '0064: คอลัมน์ใหม่ไม่ครบ (เจอ %/3)', n; END IF;

  FOREACH nm IN ARRAY ARRAY['rpc_mark_epicor_issued', 'rpc_undo_epicor_issued'] LOOP
    SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = nm;
    IF src IS NULL THEN RAISE EXCEPTION '0064: ไม่พบ %', nm; END IF;
    -- ต้องเป็นสิทธิ์ Purchasing (app_assert_dept อนุญาต admin ในตัวอยู่แล้ว)
    IF position('app_assert_dept(ARRAY[''purchasing''])' IN src) = 0 THEN
      RAISE EXCEPTION '0064: % ไม่ได้จำกัดสิทธิ์เป็น purchasing', nm;
    END IF;
  END LOOP;

  -- ธงนี้ต้องไม่ไปยุ่งกับ status / การเบิกให้ Service ของบรรทัด
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname IN ('rpc_mark_epicor_issued', 'rpc_undo_epicor_issued')
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') LIKE '%issued_to_service_at =%';
  IF n <> 0 THEN RAISE EXCEPTION '0064: RPC ไปแตะ issued_to_service_at ซึ่งไม่ใช่หน้าที่ของธงนี้'; END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '0064 OK — ทำเบิก-Epicor: คอลัมน์ + RPC 2 ตัว (Purchasing/Manage) · ไม่แตะสถานะของ'; END $$;

-- ---------------------------------------------------------------------
-- rollback:
--   DROP FUNCTION IF EXISTS rpc_mark_epicor_issued(UUID, TEXT);
--   DROP FUNCTION IF EXISTS rpc_undo_epicor_issued(UUID, TEXT);
--   ALTER TABLE job_accessory_requests
--     DROP COLUMN IF EXISTS epicor_issued_at,
--     DROP COLUMN IF EXISTS epicor_issued_by,
--     DROP COLUMN IF EXISTS epicor_doc_no;
-- ---------------------------------------------------------------------
