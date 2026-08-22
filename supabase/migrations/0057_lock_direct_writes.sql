-- =====================================================================
-- 0057: ปิดประตูเขียนตารางตรง + ล็อกแถวตอนรับของ (2026-08-22)
--
--  มาจาก code review รอบ 3 — 2 เรื่องที่ไม่อยู่ในรายการ #5–#10 เดิม
--
--  ── เรื่องที่ 1 (critical): client เขียนตารางตรงผ่าน PostgREST ได้ ──
--    Supabase ให้ role `authenticated` มี INSERT/UPDATE/DELETE ครบทุกตารางใน public
--    เป็น default grant อยู่แล้ว (ไม่มี GRANT ในไฟล์ migration ไหนเลย — grep แล้ว)
--    ⇒ RLS เป็นประตูเดียว · แต่ 0001 สร้าง policy ฝั่งเขียนไว้ 10 ตัวแบบ FOR ALL TO authenticated
--       (sales_write · project_jobs · project_units_update · project_alloc · project_acc ·
--        project_acc_stock · project_pr · purchasing_po · purchasing_pr_update ·
--        purchasing_acc_update · audit_insert · sales_insert_units)
--       = ประตูเปิดอยู่ ไม่ใช่ "defense in depth" อย่างที่คอมเมนต์ที่ 0042 บรรทัด 135 เข้าใจ
--
--    ผลจริงที่ทำได้จาก DevTools ด้วย JWT ของตัวเอง:
--      • Project:    PATCH /rest/v1/jobs?id=eq.<job ตัวเอง>  {"terminal_status":"issued"}
--                    → v_job_status อ่าน terminal_status ตรง ๆ (0001:205) งานเป็น Issued ทันที
--                      ไม่ผ่าน Division · ไม่มี audit_logs · ไม่มี notification
--                      ข้าม guard ETA ของ 0052 · ทั้งระบบมี trigger 4 ตัว ไม่มีตัวไหนคุม jobs
--      • Project:    PATCH /rest/v1/accessory_stock  {"qty_on_hand":9999}
--                    → ยอดคลังเปลี่ยนโดยไม่มีแถวใน stock_movements ⇒ ledger 0038 กระทบยอดไม่ได้อีก
--      • ทุกบัญชี:   POST  /rest/v1/audit_logs  → ปลอมหลักฐานได้ (audit_insert WITH CHECK (true))
--
--    ⚠️ ทำไม REVOKE แล้วไม่พัง — ตรวจแล้ว 3 ข้อ:
--      1) frontend ไม่เขียนตารางตรงเลยสักจุด · `grep '\.from(' src/` เจอแต่ .select()
--         (remote.ts q(), app_settings, profiles) กับ storage.from('install-photos') ซึ่งคนละ schema
--      2) RPC ที่เขียนตารางทุกตัวเป็น SECURITY DEFINER ⇒ รันด้วยสิทธิ์ owner, bypass ทั้ง RLS และ grant
--         (ตัวที่ไม่ใช่ DEFINER มี 5 ตัวเป็น pure helper ที่ไม่แตะตาราง: app_next_no ·
--          app_sum_budget_costs · app_unit_cost · app_unit_lead · app_payment_amount
--          + trigger fn_block_issued_job_edit ที่ SELECT อย่างเดียว)
--      3) Cloudflare Pages Functions ทั้ง 4 ตัวใช้ service_role ⇒ ไม่เกี่ยวกับ grant ของ authenticated
--
--  ── เรื่องที่ 2 (medium): rpc_receive_po_items รับของพร้อมกันแล้วยอดหาย ──
--    SELECT * INTO r ... ไม่มี FOR UPDATE แล้ว UPDATE เขียนค่าสัมบูรณ์ (SET qty_received = newqty)
--    ที่คำนวณจากค่าที่อ่านมาก่อนหน้า · Purchasing 2 คนรับของ line เดียวกันพร้อมกัน ใส่ 5 ทั้งคู่
--    → ทั้งคู่อ่าน qty_received=0 ได้ newqty=5 → ตัวที่สองรอ lock แล้วเขียนทับด้วย 5
--    → รับเข้าระบบจริง 5 ไม่ใช่ 10 · ทั้งสองคนเห็น toast สำเร็จ · ไม่มี error ใน audit
--    ที่อื่นในระบบเขียนถูกอยู่แล้ว (0017:90 ใช้ UPDATE แบบสัมพัทธ์ + WHERE qty >= p_qty + NOT FOUND)
--
--    §9.5 ห้าม CREATE OR REPLACE ทั้งก้อน: 0031 patch ข้อความ app_notify ของฟังก์ชันนี้ไว้
--    (app_shorten_notify → definition บน LIVE ≠ body ในไฟล์ 0022)
--    §9.6 patch ได้เฉพาะข้อความในบรรทัดเดียว (body ใน DB เป็น CRLF) → ใช้ app_swap_guard
--
--  ไม่เปลี่ยน signature ของ RPC ใด → PostgREST ไม่กระทบ ไม่มีเรื่อง PGRST202
--  ไม่ต้อง demo sync — logic.ts เป็น single-user localStorage ไม่มี concurrency และไม่มี grant
--  idempotent ทั้งไฟล์ (REVOKE ซ้ำได้ · app_swap_guard เช็ค "แก้ไปแล้ว" ให้เอง)
--  รันหลัง 0056
-- =====================================================================

-- ---------- 1) ตัดสิทธิ์เขียนตารางตรงของ authenticated ----------
-- SELECT ยังเปิดครบตามเดิม (policy read_all ไม่ถูกแตะ) → หน้าจอทุกหน้าทำงานเหมือนเดิม 100%
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM authenticated;

-- anon ไม่เคยต้องเขียนอะไร (ก่อน login ใช้แค่ auth endpoint ซึ่งไม่ผ่าน PostgREST)
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon;

-- ⚠️ ข้อนี้สำคัญไม่แพ้ข้อบน: ไม่ทำ ตารางใหม่ที่สร้างใน 0058 ขึ้นไปจะได้สิทธิ์คืนเงียบ ๆ
--    จาก default privilege ของ Supabase แล้วช่องนี้เปิดใหม่โดยไม่มีใครรู้
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon;

-- หมายเหตุ: policy ฝั่งเขียน 12 ตัวใน 0001/0042 "ไม่มีผลอะไรแล้ว" เมื่อ grant หายไป
--   จงใจยังไม่ DROP ในไฟล์นี้ เพื่อให้ rollback ได้ด้วยคำสั่งเดียว (ดูท้ายไฟล์)
--   → ลบทิ้งใน 0058 หลังใช้งานจริงผ่านไป 1 สัปดาห์ พร้อมแก้ HANDOFF §3
--     (ปล่อยไว้นานกว่านั้นไม่ได้ — มันคือเอกสารที่โกหก ซึ่งเป็นต้นเหตุที่ช่องนี้อยู่มาตั้งแต่ 0001)

-- ---------- 2) ล็อกแถวตอนรับของ (rpc_receive_po_items) ----------
DO $$
BEGIN
  PERFORM app_swap_guard('rpc_receive_po_items',
    'WHERE id = (rec->>''request_id'')::UUID AND po_id = p_po_id;',
    'WHERE id = (rec->>''request_id'')::UUID AND po_id = p_po_id FOR UPDATE;');
END $$;

-- ---------- 3) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE
  writable INT;
  fn_ok    BOOLEAN;
BEGIN
  -- 3.1 ต้องไม่เหลือตารางที่ authenticated/anon เขียนได้
  SELECT count(*) INTO writable
    FROM pg_tables t
   WHERE t.schemaname = 'public'
     AND (has_table_privilege('authenticated', format('public.%I', t.tablename), 'INSERT')
       OR has_table_privilege('authenticated', format('public.%I', t.tablename), 'UPDATE')
       OR has_table_privilege('authenticated', format('public.%I', t.tablename), 'DELETE')
       OR has_table_privilege('anon',          format('public.%I', t.tablename), 'INSERT')
       OR has_table_privilege('anon',          format('public.%I', t.tablename), 'UPDATE')
       OR has_table_privilege('anon',          format('public.%I', t.tablename), 'DELETE'));
  IF writable > 0 THEN
    RAISE EXCEPTION '0057 ไม่สมบูรณ์ — ยังมี % ตารางที่ authenticated/anon เขียนตรงได้', writable;
  END IF;

  -- 3.2 SELECT ต้องยังอ่านได้ (ถ้าข้อนี้พัง = revoke เกินไป ทั้งระบบจะจอว่าง)
  IF NOT has_table_privilege('authenticated', 'public.jobs', 'SELECT') THEN
    RAISE EXCEPTION '0057 อันตราย — authenticated อ่าน jobs ไม่ได้แล้ว ให้ rollback ทันที';
  END IF;

  -- 3.3 patch FOR UPDATE ลงจริง
  SELECT position('AND po_id = p_po_id FOR UPDATE'
                  IN pg_get_functiondef('rpc_receive_po_items(uuid,jsonb)'::regprocedure)) > 0
    INTO fn_ok;
  IF NOT fn_ok THEN
    RAISE EXCEPTION '0057 ไม่สมบูรณ์ — rpc_receive_po_items ยังไม่มี FOR UPDATE';
  END IF;

  RAISE NOTICE '0057 OK — authenticated/anon เขียนตารางตรงไม่ได้แล้ว (SELECT ยังครบ)';
  RAISE NOTICE '  รันโดย role: % · default privilege ของตารางใหม่ถูกตัดแล้วเช่นกัน', current_user;
  RAISE NOTICE '  rpc_receive_po_items ล็อกแถวด้วย FOR UPDATE แล้ว';
END $$;

-- ---------- 4) ทดสอบด้วยตาหลังรัน (ทำใน DevTools ตอน login เป็น Project) ----------
--   await supabase.from('jobs').update({ scope: 'x' }).eq('id', '<job ที่ตัวเองเปิด>')
--     ก่อนรัน 0057 : { error: null }                    ← เขียนได้จริง
--     หลังรัน 0057 : code '42501' permission denied     ← ปิดแล้ว
--   แล้วเช็คว่าหน้าจอยังปกติ: เปิดทุกเมนู · กดบันทึกอะไรสัก 1 อย่าง (ต้องสำเร็จ เพราะไปทาง RPC)

-- ---------- 5) ROLLBACK (ถ้าจำเป็น — รันทั้ง 4 บรรทัด) ----------
--   GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
--   GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO authenticated;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO anon;
--   (ส่วน FOR UPDATE ไม่ต้อง rollback — ไม่เปลี่ยนพฤติกรรมของการรับของทีละคน)
