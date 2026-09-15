-- =============================================================================
-- 0070 — ✏️ แก้จำนวนสั่งใน PO / ตัดรายการที่สั่งเกินออก (2026-09-15)
--
-- โจทย์จากหน้างาน: กรอกจำนวนตอนออก PR/PO ผิด (สั่ง 10 ทั้งที่ใช้จริง 8) หรือใส่ item เกินมาทั้งบรรทัด
--   ⇒ ของจริงไม่มีวันมาครบ qty_requested
--   ⇒ บรรทัดค้าง po_ordered ตลอดไป → PO ค้าง issued → **Job เบิกให้ Service ไม่ได้ทั้งใบ**
--      (app_acc_issue_block บังคับว่า PO ทั้งใบต้องเป็น received ถึงจะเบิกของในใบนั้นได้)
--   ⇒ งบ actual ก็ค้างที่จำนวนผิดด้วย เพราะต้นทุนคิดจาก qty_requested × unit_price
--
-- ของเดิมมีทางออกทางเดียวคือ rpc_cancel_po ซึ่งบล็อกไว้ถ้ารับของเข้ามาแล้วแม้แต่หน่วยเดียว
--   ⇒ เคส "รับมา 8 จาก 10 แล้วรู้ว่าสั่งเกิน" ตันสนิท ต้องไปแก้ที่ DB มือเปล่า
--
-- กติกา — **ลดได้อย่างเดียว และลดต่ำกว่าของที่รับมาแล้วไม่ได้**:
--   p_qty < qty_requested  เสมอ — อยากเพิ่มให้ออก PR/PO ใบใหม่ (จัดซื้อเพิ่มตาม 0037)
--                                  ไม่งั้นเลขในระบบจะต่างจากใบ PO จริงที่ส่งซัพไปแล้ว
--   p_qty >= qty_received  — ของอยู่ในมือจริงแล้ว ลบทิ้งไม่ได้ ไม่งั้นบัญชีไม่ตรงกับของ
--   p_qty = 0              → บรรทัดเป็น cancelled  = เคส "กรอก item เกินมา"
--   p_qty = qty_received   → บรรทัดเป็น received   = เคส "ปิดรับเท่าที่ได้"
--
-- ปิดบรรทัดสุดท้ายของใบแล้ว PO/PR ปิดตามเองเหมือนตอนรับของครบ (ตรรกะเดียวกับ rpc_receive_po_items)
-- 🔴 ยกเว้นข้อเดียว: PO ที่ทุกบรรทัดถูกตัดทิ้งและ**ไม่เคยรับของเลย** ปิดเป็น 'cancelled' ไม่ใช่
--    'received' — ไม่มีของเข้าจริงสักชิ้น ปิดเป็น "รับของครบ" จะโกหกทั้งรายงานและ Audit
--
-- ต้นทุน: ไม่ต้องแตะอะไรเพิ่ม — poCostSummary / งบ actual คิดจาก qty_requested อยู่แล้ว
-- ไม่แตะ accessory_stock / stock_movements: ของที่ "ไม่ได้สั่ง" ไม่เคยเข้าคลัง (ของที่รับมาจริง
--   ยังนับเท่าเดิมทุกหน่วย — เราลดแค่ "จำนวนที่สั่ง" ไม่ได้ลด "จำนวนที่รับ")
--
-- สิทธิ์: purchasing (+admin) กดเองได้ (มติ 2026-09-15) — บังคับกรอกเหตุผล ลง Audit + แจ้ง Project
--   ไม่เข้าคิว LINE (ไม่อยู่ใน allowlist ของ 0066) — เป็นงานแก้เอกสารประจำวัน ไม่ใช่เรื่องต้องปลุกกลุ่ม
--
-- ไม่เปลี่ยน signature ของเดิมเลย · เพิ่ม RPC ใหม่ 1 ตัว ⇒ **รันก่อนหรือหลัง push ก็ได้**
-- (ปุ่ม ✏️ แก้จำนวน จะได้ PGRST202 จนกว่าจะรัน SQL — ไม่กระทบฟีเจอร์อื่น)
-- =============================================================================

-- ---------- 1) ปลดล็อก qty_requested = 0 เฉพาะบรรทัดที่ถูกตัดทิ้ง ----------
-- 0001 ตั้ง CHECK (qty_requested > 0) ไว้ ⇒ ตัด item เกินออกด้วยการตั้ง 0 จะชน constraint
-- ไม่ผ่อนเป็น >= 0 ลอย ๆ เพราะบรรทัดที่ยัง "มีชีวิต" ห้ามมีจำนวน 0 (ขอของ 0 หน่วยไม่มีความหมาย)
-- ⇒ ผูกเงื่อนไขกับสถานะแทน: 0 ได้เฉพาะบรรทัดที่ status = 'cancelled'
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'job_accessory_requests'::regclass AND contype = 'c'
       AND conname <> 'jar_qty_split_ck'
       AND pg_get_constraintdef(oid) ILIKE '%qty_requested > %'
  LOOP
    EXECUTE format('ALTER TABLE job_accessory_requests DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE job_accessory_requests DROP CONSTRAINT IF EXISTS jar_qty_requested_ck;
ALTER TABLE job_accessory_requests
  ADD CONSTRAINT jar_qty_requested_ck CHECK (qty_requested > 0 OR status = 'cancelled');

-- ---------- 2) RPC แก้จำนวน ----------
CREATE OR REPLACE FUNCTION rpc_adjust_po_line(
  p_request_id UUID, p_qty NUMERIC, p_reason TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; r job_accessory_requests; po purchase_orders; j jobs; it items;
  rsn TEXT; new_status TEXT; po_complete BOOLEAN; pr_complete BOOLEAN; any_received BOOLEAN;
  po_end TEXT; what TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);

  -- ล็อกแถวตั้งแต่ต้น (กติกาเดียวกับ 0057) — กันชนกับการรับของที่อาจกดพร้อมกันอยู่
  SELECT * INTO r FROM job_accessory_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการวัสดุ'; END IF;
  IF r.po_id IS NULL OR r.status <> 'po_ordered' THEN
    RAISE EXCEPTION 'แก้จำนวนได้เฉพาะรายการที่ออก PO แล้วและยังรับของไม่ครบ';
  END IF;

  SELECT * INTO po FROM purchase_orders WHERE id = r.po_id FOR UPDATE;
  IF po.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PO'; END IF;
  IF po.status <> 'issued' THEN RAISE EXCEPTION '% ปิดใบไปแล้ว แก้จำนวนไม่ได้', po.po_no; END IF;

  rsn := btrim(COALESCE(p_reason, ''));
  IF rsn = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่แก้จำนวน'; END IF;

  SELECT * INTO it FROM items WHERE id = r.item_id;
  SELECT * INTO j  FROM jobs  WHERE id = r.job_id FOR UPDATE;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว แก้ไขไม่ได้', j.job_no;
  END IF;

  IF p_qty IS NULL OR p_qty < 0 OR p_qty <> trunc(p_qty) THEN
    RAISE EXCEPTION 'จำนวนใหม่ต้องเป็นจำนวนเต็มไม่ติดลบ';
  END IF;
  IF p_qty >= r.qty_requested THEN
    RAISE EXCEPTION '% ลดจำนวนได้อย่างเดียว (ตอนนี้สั่ง % %) — ต้องการเพิ่มให้ออก PR/PO ใบใหม่',
      it.name, r.qty_requested, it.uom;
  END IF;
  IF p_qty < r.qty_received THEN
    RAISE EXCEPTION '% รับของเข้ามาแล้ว % % — ลดต่ำกว่านี้ไม่ได้', it.name, r.qty_received, it.uom;
  END IF;

  new_status := CASE WHEN p_qty = 0 THEN 'cancelled'
                     WHEN p_qty = r.qty_received THEN 'received'
                     ELSE 'po_ordered' END;

  what := CASE WHEN p_qty = 0
    THEN 'ตัด ' || it.name || ' ออกจาก ' || po.po_no || ' (เดิมสั่ง ' || r.qty_requested || ' ' || it.uom || ')'
    ELSE 'แก้จำนวน ' || it.name || ' ใน ' || po.po_no || ': ' || r.qty_requested || ' → ' || p_qty || ' ' || it.uom
         || CASE WHEN p_qty = r.qty_received THEN ' (ปิดรับเท่าที่ได้)' ELSE '' END
  END;

  UPDATE job_accessory_requests
     SET qty_requested = p_qty, status = new_status, updated_at = now()
   WHERE id = p_request_id;

  -- PO/PR ปิดตามเองเมื่อทุกบรรทัดจบ — เงื่อนไขเดียวกับ rpc_receive_po_items
  SELECT NOT EXISTS (SELECT 1 FROM job_accessory_requests
                      WHERE po_id = po.id AND status NOT IN ('received', 'cancelled', 'returned'))
    INTO po_complete;
  IF po_complete THEN
    SELECT EXISTS (SELECT 1 FROM job_accessory_requests WHERE po_id = po.id AND qty_received > 0)
      INTO any_received;
    po_end := CASE WHEN any_received THEN 'received' ELSE 'cancelled' END;
    UPDATE purchase_orders
       SET status = po_end,
           received_at = CASE WHEN po_end = 'received' THEN now() ELSE received_at END
     WHERE id = po.id;
  END IF;
  SELECT NOT EXISTS (SELECT 1 FROM job_accessory_requests
                      WHERE pr_id = po.pr_id AND status NOT IN ('received', 'cancelled', 'returned'))
    INTO pr_complete;
  IF pr_complete THEN
    UPDATE purchase_requisitions SET status = 'received' WHERE id = po.pr_id;
  END IF;

  PERFORM app_notify('po_line_adjusted',
    '✏️ ' || po.po_no || ' (' || j.job_no || ') ' || what || ' · เหตุผล: ' || rsn,
    'project', po.job_id);
  PERFORM app_audit('purchase_order', po.id, 'adjust_po_line', actor.id,
    j.job_no || ' ' || what || ' · เหตุผล: ' || rsn
    || CASE WHEN po_complete THEN ' · ' || po.po_no || ' ปิดใบ ('
              || CASE WHEN po_end = 'received' THEN 'รับของครบ' ELSE 'ยกเลิก' END || ')'
            ELSE '' END);

  -- ตัดบรรทัดที่ค้างทิ้งไป = ใบงานอาจครบพอดี (เหตุผลเดียวกับ 0068) — no-op ถ้ายังมีของค้าง/ปิดใบแล้ว
  PERFORM app_finalize_issue(actor, r.job_id);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_adjust_po_line(UUID, NUMERIC, TEXT) TO authenticated;

-- ---------- 3) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE n INT; src TEXT;
BEGIN
  -- constraint ใหม่ต้องลงจริง ไม่งั้นการตัด item เกิน (qty = 0) จะพังตอนกดใช้จริง
  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'job_accessory_requests'::regclass AND conname = 'jar_qty_requested_ck';
  IF n <> 1 THEN RAISE EXCEPTION '0070: ไม่มี jar_qty_requested_ck — ตั้ง qty_requested = 0 จะชน CHECK เดิม'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint
   WHERE conrelid = 'job_accessory_requests'::regclass AND contype = 'c'
     AND conname NOT IN ('jar_qty_split_ck', 'jar_qty_requested_ck')
     AND pg_get_constraintdef(oid) ILIKE '%qty_requested > %';
  IF n > 0 THEN RAISE EXCEPTION '0070: ยังเหลือ CHECK เดิมที่บังคับ qty_requested > 0 อยู่ % ตัว', n; END IF;

  SELECT COUNT(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_adjust_po_line';
  IF n <> 1 THEN RAISE EXCEPTION '0070: rpc_adjust_po_line มี % overload (ต้องเหลือ 1)', n; END IF;

  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_adjust_po_line';

  -- เพิ่มจำนวนต้องทำไม่ได้ (เลขในระบบจะต่างจากใบ PO จริงที่ส่งซัพไปแล้ว)
  IF position('p_qty >= r.qty_requested' IN src) = 0 THEN
    RAISE EXCEPTION '0070: rpc_adjust_po_line ไม่ได้กันการเพิ่มจำนวน — ต้องลดได้อย่างเดียว';
  END IF;
  -- ลดต่ำกว่าของที่รับมาแล้วต้องทำไม่ได้ (ของอยู่ในมือจริง บัญชีจะไม่ตรงกับของ)
  IF position('p_qty < r.qty_received' IN src) = 0 THEN
    RAISE EXCEPTION '0070: rpc_adjust_po_line ไม่ได้กันการลดต่ำกว่า qty_received';
  END IF;
  -- ห้ามแตะจำนวนที่รับมาแล้ว / คลัง / บัญชีเดินสะพัด
  IF position('qty_received =' IN src) > 0 OR position('accessory_stock' IN src) > 0
     OR position('stock_movements' IN src) > 0 OR position('app_set_stock_ctx' IN src) > 0 THEN
    RAISE EXCEPTION '0070: rpc_adjust_po_line ไปแตะจำนวนที่รับ/คลัง — ต้องแก้แค่ qty_requested เท่านั้น';
  END IF;
  -- ใบที่ไม่เคยรับของเลยต้องปิดเป็น cancelled ไม่ใช่ received
  IF position('any_received' IN src) = 0 THEN
    RAISE EXCEPTION '0070: rpc_adjust_po_line ปิด PO เป็น received ทุกกรณี — ใบที่ไม่เคยรับของต้องเป็น cancelled';
  END IF;
  IF position('app_finalize_issue' IN src) = 0 THEN
    RAISE EXCEPTION '0070: rpc_adjust_po_line ไม่เรียก app_finalize_issue — ตัดบรรทัดสุดท้ายแล้ว Job จะค้าง';
  END IF;

  RAISE NOTICE '0070: OK — Purchasing แก้จำนวนสั่ง/ตัด item เกินใน PO ได้แล้ว (ลดได้อย่างเดียว)';
END $$;
