-- =====================================================================
-- 0022: 1 PR → หลาย PO (2026-07-20)
--  เดิม 1 PR = 1 PO (ทั้ง PR). ใหม่: PO อ้าง "รายการวัสดุ" (line items) ที่เลือก
--  → 1 PR แตกออกเป็นหลาย PO ได้ (คนละ supplier/คนละชุด), ออก PO เพิ่มเรื่อยๆ จน
--    รายการใน PR ถูกสั่งครบ
--  โครง: job_accessory_requests.po_id (line ผูกกับ PO ใบไหน) — pr_id ยังบอกว่าอยู่ PR ไหน
--    - rpc_create_po(p_pr_id, p_po_no, p_supplier, p_expected_date, p_request_ids[])
--      สั่งเฉพาะ line ที่เลือก (status pr_sent) → po_ordered + po_id; PR → po_issued
--    - rpc_receive_po_items: match line ด้วย po_id; PO เสร็จเมื่อ line ของ PO ครบ,
--      PR เสร็จเมื่อ "ทุก line ของ PR" ครบ
--    - rpc_cancel_po: คืน line ของ PO (po_ordered→pr_sent, po_id=NULL); PR กลับ pending
--      ถ้าไม่เหลือ line po_ordered เลย, ไม่งั้นคง po_issued
--  demo sync ที่ src/data/logic.ts · รันหลัง 0021 (idempotent)
-- =====================================================================

ALTER TABLE job_accessory_requests ADD COLUMN IF NOT EXISTS po_id UUID REFERENCES purchase_orders(id);

-- backfill: line ที่สั่ง/รับแล้ว ผูกกับ PO ของ PR นั้น (เดิม 1 PR = 1 PO)
UPDATE job_accessory_requests r
SET po_id = (SELECT po.id FROM purchase_orders po WHERE po.pr_id = r.pr_id ORDER BY po.created_at LIMIT 1)
WHERE r.po_id IS NULL AND r.status IN ('po_ordered', 'received') AND r.pr_id IS NOT NULL;

-- ---------- rpc_create_po: เลือก line + ออก PO ได้หลายใบต่อ PR ----------
DROP FUNCTION IF EXISTS rpc_create_po(UUID, TEXT, TEXT, DATE);
CREATE OR REPLACE FUNCTION rpc_create_po(p_pr_id UUID, p_po_no TEXT, p_supplier TEXT, p_expected_date DATE, p_request_ids UUID[] DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; pr purchase_requisitions; j jobs; poid UUID; pono TEXT; ids UUID[]; ordered INT; cnt INT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO pr FROM purchase_requisitions WHERE id = p_pr_id FOR UPDATE;
  IF pr.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PR'; END IF;
  IF pr.status NOT IN ('pending', 'po_issued') THEN RAISE EXCEPTION '% ถูกตีกลับหรือปิดไปแล้ว', pr.pr_no; END IF;
  pono := trim(p_po_no);
  IF pono = '' THEN RAISE EXCEPTION 'กรุณาระบุ PO No.'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_orders WHERE lower(po_no) = lower(pono)) THEN
    RAISE EXCEPTION 'PO No. "%" มีอยู่แล้ว', pono;
  END IF;
  IF trim(p_supplier) = '' THEN RAISE EXCEPTION 'กรุณาระบุ Supplier'; END IF;

  -- ถ้าไม่ระบุ line = เอาทุก line ที่ยังไม่ได้สั่ง (pr_sent) ของ PR นี้
  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    SELECT array_agg(id) INTO ids FROM job_accessory_requests WHERE pr_id = p_pr_id AND status = 'pr_sent';
  ELSE
    ids := p_request_ids;
  END IF;
  IF ids IS NULL OR array_length(ids, 1) IS NULL THEN RAISE EXCEPTION 'ไม่มีรายการที่จะออก PO (เลือกรายการที่ยังไม่ได้สั่ง)'; END IF;
  SELECT count(*) INTO cnt FROM job_accessory_requests WHERE id = ANY(ids) AND pr_id = p_pr_id AND status = 'pr_sent';
  IF cnt <> array_length(ids, 1) THEN RAISE EXCEPTION 'เลือกได้เฉพาะรายการใน PR นี้ที่ยังไม่ได้ออก PO'; END IF;

  SELECT * INTO j FROM jobs WHERE id = pr.job_id;
  INSERT INTO purchase_orders (po_no, pr_id, job_id, supplier_name, expected_date, created_by)
  VALUES (pono, p_pr_id, pr.job_id, trim(p_supplier), p_expected_date, actor.id) RETURNING id INTO poid;
  UPDATE job_accessory_requests SET status = 'po_ordered', po_id = poid, updated_at = now() WHERE id = ANY(ids);
  GET DIAGNOSTICS ordered = ROW_COUNT;
  UPDATE purchase_requisitions SET status = 'po_issued' WHERE id = p_pr_id;

  PERFORM app_notify('po_created',
    '🛒 ' || pono || ' ออกแล้วจาก ' || pr.pr_no || ' (' || j.job_no || ') ' || ordered || ' รายการ · Supplier: '
    || trim(p_supplier) || ' กำหนดส่ง ' || COALESCE(p_expected_date::TEXT, 'ไม่ระบุ'),
    'project', pr.job_id);
  PERFORM app_audit('purchase_order', poid, 'create_po', actor.id,
    'ออก ' || pono || ' จาก ' || pr.pr_no || ' (' || j.job_no || ') ' || ordered || ' รายการ · Supplier: ' || trim(p_supplier));
  RETURN poid;
END $$;

-- ---------- rpc_receive_po_items: match line ด้วย po_id ----------
CREATE OR REPLACE FUNCTION rpc_receive_po_items(p_po_id UUID, p_receipts JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; po purchase_orders; j jobs; rec JSONB; r job_accessory_requests; it items;
  qty NUMERIC; newqty NUMERIC; parts TEXT := ''; po_complete BOOLEAN; pr_complete BOOLEAN; got_any BOOLEAN := false;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id;
  IF po.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PO'; END IF;
  IF po.status <> 'issued' THEN RAISE EXCEPTION '% รับของครบแล้วหรือถูกยกเลิก', po.po_no; END IF;
  SELECT * INTO j FROM jobs WHERE id = po.job_id;

  FOR rec IN SELECT * FROM jsonb_array_elements(p_receipts) LOOP
    qty := (rec->>'qty')::NUMERIC;
    CONTINUE WHEN qty IS NULL OR qty <= 0;
    SELECT * INTO r FROM job_accessory_requests WHERE id = (rec->>'request_id')::UUID AND po_id = p_po_id;
    IF r.id IS NULL THEN RAISE EXCEPTION 'มีรายการที่ไม่อยู่ใน PO นี้'; END IF;
    SELECT * INTO it FROM items WHERE id = r.item_id;
    IF qty > r.qty_requested - r.qty_received THEN
      RAISE EXCEPTION '% ค้างรับแค่ % % (กรอก %)', it.name, r.qty_requested - r.qty_received, it.uom, qty;
    END IF;
    newqty := r.qty_received + qty;
    UPDATE job_accessory_requests
       SET qty_received = newqty,
           status = CASE WHEN newqty >= qty_requested THEN 'received' ELSE 'po_ordered' END,
           updated_at = now()
     WHERE id = r.id;
    parts := parts || CASE WHEN parts = '' THEN '' ELSE ', ' END
      || it.name || ' ' || qty || ' ' || it.uom
      || CASE WHEN newqty >= r.qty_requested THEN ' (ครบ)' ELSE ' (รวม ' || newqty || '/' || r.qty_requested || ')' END;
    got_any := true;
  END LOOP;
  IF NOT got_any THEN RAISE EXCEPTION 'กรุณาระบุจำนวนที่รับอย่างน้อย 1 รายการ'; END IF;

  -- PO เสร็จเมื่อ line ของ PO นี้ครบ
  SELECT NOT EXISTS (SELECT 1 FROM job_accessory_requests WHERE po_id = p_po_id AND status NOT IN ('received', 'cancelled', 'returned')) INTO po_complete;
  IF po_complete THEN
    UPDATE purchase_orders SET status = 'received', received_at = now() WHERE id = p_po_id;
  END IF;
  -- PR เสร็จเมื่อทุก line ของ PR ครบ
  SELECT NOT EXISTS (SELECT 1 FROM job_accessory_requests WHERE pr_id = po.pr_id AND status NOT IN ('received', 'cancelled', 'returned')) INTO pr_complete;
  IF pr_complete THEN
    UPDATE purchase_requisitions SET status = 'received' WHERE id = po.pr_id;
  END IF;

  PERFORM app_notify('po_received',
    '📬 ' || po.po_no || ' (' || j.job_no || ') รับของ' || CASE WHEN po_complete THEN 'ครบทุกรายการแล้ว' ELSE 'บางส่วน: ' || parts END,
    'project', po.job_id);
  PERFORM app_audit('purchase_order', p_po_id,
    CASE WHEN po_complete THEN 'receive_po_complete' ELSE 'receive_po_partial' END, actor.id,
    po.po_no || ' (' || j.job_no || ') รับของ' || CASE WHEN po_complete THEN 'ครบ' ELSE 'บางส่วน' END || ': ' || parts);
END $$;

-- ---------- rpc_cancel_po: คืน line ของ PO ----------
CREATE OR REPLACE FUNCTION rpc_cancel_po(p_po_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; po purchase_orders; pr purchase_requisitions; j jobs; got NUMERIC; still_ordered INT;
BEGIN
  actor := app_assert_dept(ARRAY['purchasing']);
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id;
  IF po.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ PO'; END IF;
  IF po.status <> 'issued' THEN RAISE EXCEPTION '% รับของครบแล้วหรือถูกยกเลิกไปแล้ว', po.po_no; END IF;
  IF trim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ยกเลิก PO'; END IF;

  SELECT COALESCE(sum(qty_received), 0) INTO got FROM job_accessory_requests WHERE po_id = p_po_id;
  IF got > 0 THEN
    RAISE EXCEPTION '% รับของเข้าระบบแล้ว % หน่วย ยกเลิกไม่ได้ — รับส่วนที่เหลือให้จบ หรือติดต่อ Manager', po.po_no, got;
  END IF;

  SELECT * INTO pr FROM purchase_requisitions WHERE id = po.pr_id;
  SELECT * INTO j FROM jobs WHERE id = po.job_id;

  UPDATE purchase_orders SET status = 'cancelled' WHERE id = p_po_id;
  UPDATE job_accessory_requests SET status = 'pr_sent', po_id = NULL, updated_at = now()
  WHERE po_id = p_po_id AND status = 'po_ordered';

  -- PR กลับ pending ถ้าไม่เหลือ line po_ordered เลย
  SELECT count(*) INTO still_ordered FROM job_accessory_requests WHERE pr_id = po.pr_id AND status = 'po_ordered';
  IF still_ordered = 0 THEN
    UPDATE purchase_requisitions SET status = 'pending' WHERE id = po.pr_id;
  END IF;

  PERFORM app_notify('po_cancelled',
    '🗑️ ยกเลิก ' || po.po_no || ' (' || j.job_no || ') เหตุผล: ' || trim(p_reason) || ' — รายการกลับมารอออก PO ใหม่',
    'project', po.job_id);
  PERFORM app_audit('purchase_order', p_po_id, 'cancel_po', actor.id,
    'ยกเลิก ' || po.po_no || ' (' || j.job_no || ') เหตุผล: ' || trim(p_reason));
END $$;
