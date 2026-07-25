-- =====================================================================
-- 0031: ปรับข้อความแจ้งเตือน (LINE) ให้กระชับ (2026-07-25)
--  เปลี่ยนเฉพาะ "ข้อความ" ใน app_notify ของทุก workflow ให้สั้นลง (ตัดชื่อลูกค้า/
--  filler ในส่วนใหญ่ · ตัดลิสต์ serial ตอนดึง · ตัดพิกัด GPS ตอนติดตั้งเสร็จ)
--  วิธี: pg_get_functiondef + replace() เปลี่ยนเฉพาะสตริง — คง body เดิม 100%
--  ไม่ recreate ทั้งฟังก์ชัน → ไม่มีทาง regress logic · idempotent (ข้ามถ้าแก้ไปแล้ว)
--  demo sync ที่ src/data/logic.ts · รันหลัง 0030
-- =====================================================================

-- helper: หาฟังก์ชันตามชื่อ (สถานะปัจจุบันแต่ละชื่อมี signature เดียว), replace ข้อความ, recreate
CREATE OR REPLACE FUNCTION app_shorten_notify(p_fnname TEXT, p_old TEXT, p_new TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE def TEXT; foid OID;
BEGIN
  SELECT p.oid INTO foid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fnname;
  IF foid IS NULL THEN RAISE EXCEPTION 'ไม่พบฟังก์ชัน %', p_fnname; END IF;
  def := pg_get_functiondef(foid);
  IF position(p_old IN def) = 0 THEN
    IF position(p_new IN def) > 0 THEN RETURN;   -- แก้ไปแล้ว (รันซ้ำได้)
    END IF;
    RAISE EXCEPTION 'ไม่พบข้อความเดิมใน % — % ', p_fnname, p_old;
  END IF;
  EXECUTE replace(def, p_old, p_new);
END $$;

DO $$
BEGIN
  -- 1) stock_created (rpc_create_project_stock)
  PERFORM app_shorten_notify('rpc_create_project_stock',
    '''📦 Sales รับ LBS เข้า '' || trim(p_stock_no) || '' จำนวน '' || cnt || '' เครื่อง — พร้อมให้ดึงเข้า Job''',
    '''📦 รับ LBS เข้า '' || trim(p_stock_no) || '' +'' || cnt || '' เครื่อง (พร้อมดึงเข้า Job)''');

  -- 2) stock_received (rpc_add_units_to_stock)
  PERFORM app_shorten_notify('rpc_add_units_to_stock',
    '''📦 Division รับ LBS เพิ่มเข้า '' || s.stock_no || '' จำนวน '' || cnt || '' เครื่อง — พร้อมให้ดึงเข้า Job''',
    '''📦 เพิ่ม LBS เข้า '' || s.stock_no || '' +'' || cnt || '' เครื่อง (พร้อมดึงเข้า Job)''');

  -- 3) stock_received (rpc_import_units_to_stock — ตัวแปร newcnt)
  PERFORM app_shorten_notify('rpc_import_units_to_stock',
    '''📦 Division รับ LBS เพิ่มเข้า '' || s.stock_no || '' จำนวน '' || newcnt || '' เครื่อง — พร้อมให้ดึงเข้า Job''',
    '''📦 เพิ่ม LBS เข้า '' || s.stock_no || '' +'' || newcnt || '' เครื่อง (พร้อมดึงเข้า Job)''');

  -- 4) lbs_drawn (rpc_draw_lbs) — ตัดชื่อลูกค้า + ลิสต์ serial
  PERFORM app_shorten_notify('rpc_draw_lbs',
    ''' ('' || j.customer_name || '') ดึง LBS ''', ''' ดึง LBS ''');
  PERFORM app_shorten_notify('rpc_draw_lbs',
    '|| '' — Serial.LVB: '' || array_to_string(serials, '', '') || '' · Serial.OM: '' || array_to_string(serials_om, '', '')', '');

  -- 5) accessory_issued (rpc_add_accessory_request)
  PERFORM app_shorten_notify('rpc_add_accessory_request',
    ''' จากสต็อกกลาง (คงเหลือ ''', ''' (คลังเหลือ ''');
  PERFORM app_shorten_notify('rpc_add_accessory_request',
    '|| remaining || '' '' || it.uom || '')''', '|| remaining || '')''');

  -- 6) pr_created (app_exec_create_pr)
  PERFORM app_shorten_notify('app_exec_create_pr',
    '''📄 '' || prno || '' จาก '' || j.job_no || '' ('' || j.customer_name || '') รอออก PO — '' || updated || '' รายการ''',
    '''📄 '' || prno || '' ('' || j.job_no || '') รอออก PO · '' || updated || '' รายการ''');

  -- 7) pr_rejected (rpc_reject_pr)
  PERFORM app_shorten_notify('rpc_reject_pr',
    '''⛔ Purchasing ตีกลับ '' || pr.pr_no || '' ('' || j.job_no || '') เหตุผล: '' || trim(p_reason) || '' — รายการเด้งกลับให้แก้ไข/ออก PR ใหม่''',
    '''⛔ ตีกลับ '' || pr.pr_no || '' ('' || j.job_no || ''): '' || trim(p_reason)');

  -- 8) po_created (rpc_create_po)
  PERFORM app_shorten_notify('rpc_create_po',
    '''🛒 '' || pono || '' ออกแล้วจาก '' || pr.pr_no || '' ('' || j.job_no || '') '' || ordered || '' รายการ · Supplier: ''',
    '''🛒 ออก '' || pono || '' ('' || j.job_no || '') · '' || ordered || '' รายการ · ''');
  PERFORM app_shorten_notify('rpc_create_po',
    '|| trim(p_supplier) || '' กำหนดส่ง ''', '|| trim(p_supplier) || '' · ส่ง ''');

  -- 9) po_received (rpc_receive_po_items)
  PERFORM app_shorten_notify('rpc_receive_po_items',
    'รับของ'' || CASE WHEN po_complete THEN ''ครบทุกรายการแล้ว''',
    'รับ'' || CASE WHEN po_complete THEN ''ของครบแล้ว''');

  -- 10) po_cancelled (rpc_cancel_po)
  PERFORM app_shorten_notify('rpc_cancel_po',
    '''🗑️ ยกเลิก '' || po.po_no || '' ('' || j.job_no || '') เหตุผล: '' || trim(p_reason) || '' — รายการกลับมารอออก PO ใหม่''',
    '''🗑️ ยกเลิก '' || po.po_no || '' ('' || j.job_no || ''): '' || trim(p_reason)');

  -- 11) job_issued (app_exec_issue_job)
  PERFORM app_shorten_notify('app_exec_issue_job',
    '''🚚 '' || j.job_no || '' ('' || j.customer_name || '') เบิกของครบแล้ว — Service เข้าติดตั้งที่ '' || trim(p_location) || '' กำหนด '' || range',
    '''🚚 '' || j.job_no || '' เบิกให้ Service · ติดตั้ง '' || trim(p_location) || '' · '' || range');

  -- 12) job_installed (rpc_confirm_install) — ตัดชื่อลูกค้า + พิกัด GPS
  PERFORM app_shorten_notify('rpc_confirm_install',
    ''' ('' || j.customer_name || '') ติดตั้งเสร็จเมื่อ ''', ''' ติดตั้งเสร็จ ''');
  PERFORM app_shorten_notify('rpc_confirm_install',
    '|| '' — ยืนยันโดย '' || actor.full_name || '' 📍 พิกัด '' || round(p_lat, 5) || '', '' || round(p_lng, 5)',
    '|| '' · โดย '' || actor.full_name');

  -- 13) job_cancelled (app_exec_cancel_job) — คง CASE ท้ายไว้
  PERFORM app_shorten_notify('app_exec_cancel_job',
    ''' ('' || j.customer_name || '') เหตุผล: ''', ''': ''');
  PERFORM app_shorten_notify('app_exec_cancel_job',
    ''' — คืน LBS '' || returned || '' เครื่อง + Accessory กลับสต็อกอัตโนมัติ''',
    ''' · คืน LBS '' || returned || '' + Accessory เข้าคลัง''');

  -- 14) approval_requested (rpc_request_approval)
  PERFORM app_shorten_notify('rpc_request_approval',
    '''🔔 '' || j.job_no || '' ('' || j.customer_name || '') ขออนุมัติ'' || type_label || '' โดย '' || actor.full_name',
    '''🔔 '' || j.job_no || '' ขออนุมัติ'' || type_label || '' · โดย '' || actor.full_name');

  -- 15) approval_approved (rpc_approve_request)
  PERFORM app_shorten_notify('rpc_approve_request',
    '''✅ Division อนุมัติ'' || type_label || '' ของ '' || j.job_no || '' แล้ว (โดย '' || actor.full_name || '')''',
    '''✅ อนุมัติ'' || type_label || '' · '' || j.job_no || '' · โดย '' || actor.full_name');

  -- 16) approval_rejected (rpc_reject_request)
  PERFORM app_shorten_notify('rpc_reject_request',
    '''⛔ Division ตีกลับคำขอ'' || type_label || '' ของ '' || j.job_no || '' — เหตุผล: '' || trim(p_reason)',
    '''⛔ ตีกลับ'' || type_label || '' · '' || j.job_no || '': '' || trim(p_reason)');
END $$;

DROP FUNCTION app_shorten_notify(TEXT, TEXT, TEXT);
