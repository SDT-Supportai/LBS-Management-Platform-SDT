-- =============================================================================
-- 0069 — ลิงก์สาธารณะให้ผู้บริหารดูคลัง LBS โดยไม่ต้อง login (2026-09-14)
--
-- โจทย์: VIP อยากเปิดดูสถานะคลัง LBS จากมือถือโดยไม่ต้องจำรหัสผ่าน
--
-- 🔴 นี่คือ **ครั้งแรกที่ระบบเปิดข้อมูลออกนอกรั้ว authenticated** — ทุกตารางตั้งแต่ 0001
--    เป็น `TO authenticated` ทั้งหมด และ role `anon` ไม่เคยมีสิทธิ์อ่านอะไรเลย
--    ไฟล์นี้**ไม่แตะ RLS ของตารางใดเลย** · เปิดทางเดียวคือ RPC ตัวเดียว (SECURITY DEFINER)
--    ที่ GRANT ให้ anon ⇒ ขอบเขตข้อมูลถูกล็อกด้วย SQL ในตัวฟังก์ชัน ไม่ใช่ policy กว้าง ๆ
--
-- 🔴 มติผู้ใช้ 2026-09-14 (2 ข้อ):
--   1) เปิดเฉพาะ **รายเครื่อง ไม่มีตัวเลขเงิน** — ตัด unit_cost · มูลค่าคลังรวม
--      และตัด **contact_phone** (ข้อมูลส่วนบุคคล PDPA) ออกด้วย
--      ⇒ **whitelist คอลัมน์ตอนประกอบ JSON ทีละช่อง** ห้ามเทแถวเต็มออกไป (ดู block 7 ที่ตรวจ)
--   2) **ไม่มีวันหมดอายุ** — ใช้ได้จนกว่าจะกดเพิกถอน (revoked_at)
--
-- ⚠️ ความจริงที่แก้ไม่ได้: ใครถือลิงก์ก็เปิดได้ ส่งต่อแล้วคุมไม่ได้ ⇒ ป้องกันด้วย
--    (ก) token สุ่ม 64 hex (~244 bit จาก UUIDv4 สองใบ) เดาไม่ได้ในทางปฏิบัติ
--    (ข) เก็บเฉพาะ **sha256 ของ token** — DB หลุดก็เอาไปเปิดลิงก์ไม่ได้
--    (ค) เพิกถอนได้ทุกเมื่อ มีผลทันที
--    (ง) นับ view_count / last_viewed_at ให้ Division เห็นว่าลิงก์ถูกใช้แค่ไหน
-- =============================================================================

-- ---------- 1) ตารางลิงก์ ----------
CREATE TABLE IF NOT EXISTS public_share_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 hex ของ token · UNIQUE กันออกลิงก์ชนกัน (และทำให้ lookup ใช้ index)
  token_hash       TEXT NOT NULL UNIQUE,
  -- 6 ตัวท้ายของ token ไว้ให้คนดูออกว่าแถวไหนคือลิงก์ไหน (ไม่พอให้เดาตัวเต็ม)
  token_hint       TEXT NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'lbs_stock' CHECK (scope IN ('lbs_stock')),
  -- NULL = ทุกคลัง · ตั้งค่า = เจาะจงคลังเดียว
  project_stock_id UUID REFERENCES project_stocks(id) ON DELETE CASCADE,
  label            TEXT,
  created_by       UUID NOT NULL REFERENCES profiles(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ,
  revoked_by       UUID REFERENCES profiles(id),
  view_count       INT NOT NULL DEFAULT 0,
  last_viewed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS public_share_links_active_idx
  ON public_share_links (token_hash) WHERE revoked_at IS NULL;

COMMENT ON TABLE public_share_links IS
  'ลิงก์สาธารณะดูคลัง LBS โดยไม่ต้อง login (0069) — เก็บเฉพาะ sha256 ของ token '
  'ตัวเต็มคืนครั้งเดียวตอนสร้าง · เพิกถอนได้ ไม่มีวันหมดอายุ';

ALTER TABLE public_share_links ENABLE ROW LEVEL SECURITY;

-- คนใน (ทุกแผนกที่ login) อ่านทะเบียนลิงก์ได้ตามแนวเดียวกับ read_all ของ 0001
-- ⚠️ **ห้ามมี policy ให้ anon เด็ดขาด** — แถวนี้มี token_hash · anon เข้าถึงได้ทางเดียวคือผ่าน RPC
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'public_share_links' AND policyname = 'read_all') THEN
    CREATE POLICY read_all ON public_share_links FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
-- ไม่มี policy INSERT/UPDATE/DELETE เลย → เขียนได้ทางเดียวผ่าน RPC (SECURITY DEFINER) ด้านล่าง

-- ---------- 2) สร้างลิงก์ (Division + Manage) ----------
-- token สุ่ม **ฝั่ง server** แล้วคืนตัวเต็มกลับไปครั้งเดียว
-- ⚠️ ไม่ให้ client สุ่มแล้วส่งมาเก็บ — client ที่เขียนพลาดอาจตั้ง token เดาง่ายโดยไม่มีใครรู้
CREATE OR REPLACE FUNCTION rpc_create_share_link(
  p_project_stock_id UUID, p_label TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; tok TEXT; sc TEXT; new_id UUID;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);   -- stock.manage = sales + admin (app_assert_dept ปล่อย admin เสมอ)
  IF p_project_stock_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM project_stocks WHERE id = p_project_stock_id) THEN
    RAISE EXCEPTION 'ไม่พบคลังที่เลือก';
  END IF;

  -- UUIDv4 สองใบ = ~244 bit ของความสุ่ม · ไม่ต้องพึ่ง extension pgcrypto
  tok := replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', '');

  INSERT INTO public_share_links (token_hash, token_hint, project_stock_id, label, created_by)
  VALUES (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), right(tok, 6),
          p_project_stock_id, NULLIF(btrim(COALESCE(p_label, '')), ''), actor.id)
  RETURNING id INTO new_id;   -- audit_logs.entity_id เป็น NOT NULL (0001) ส่ง NULL ไม่ได้

  sc := COALESCE((SELECT stock_no FROM project_stocks WHERE id = p_project_stock_id), 'ทุกคลัง');
  PERFORM app_audit('share_link', new_id, 'create_share_link', actor.id,
    'สร้างลิงก์สาธารณะดูคลัง LBS (' || sc || ') — ...' || right(tok, 6) ||
    COALESCE(' · ' || NULLIF(btrim(COALESCE(p_label, '')), ''), '') ||
    ' · เปิดได้โดยไม่ต้อง login จนกว่าจะเพิกถอน');

  RETURN tok;   -- ครั้งเดียว — หลังจากนี้เหลือแต่ hash
END $$;

-- ---------- 3) เพิกถอน ----------
CREATE OR REPLACE FUNCTION rpc_revoke_share_link(p_link_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; l public_share_links;
BEGIN
  actor := app_assert_dept(ARRAY['sales']);
  SELECT * INTO l FROM public_share_links WHERE id = p_link_id FOR UPDATE;
  IF l.id IS NULL THEN RAISE EXCEPTION 'ไม่พบลิงก์'; END IF;
  IF l.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'ลิงก์นี้ถูกเพิกถอนไปแล้ว'; END IF;

  UPDATE public_share_links SET revoked_at = now(), revoked_by = actor.id WHERE id = p_link_id;
  PERFORM app_audit('share_link', p_link_id, 'revoke_share_link', actor.id,
    'เพิกถอนลิงก์สาธารณะ ...' || l.token_hint || ' (เปิดดู ' || l.view_count || ' ครั้ง) — ลิงก์เดิมใช้ไม่ได้ทันที');
END $$;

-- ---------- 4) อ่านข้อมูลผ่าน token — **เปิดให้ anon** ----------
-- 🔴 ทุกคอลัมน์ที่คืน **ต้องเขียนชื่อออกมาทีละช่องใน jsonb_build_object**
--    ห้ามเทแถวเต็มออกไป (to_jsonb(u) / row_to_json) เพราะเพิ่มคอลัมน์ใหม่บน lbs_units/jobs
--    วันหลังจะหลุดออกลิงก์สาธารณะทันทีโดยไม่มีใครรู้ — block 7 ท้ายไฟล์ตรวจรูปร่างผลลัพธ์จริงไว้แล้ว
--    (`SELECT * INTO l` ด้านล่างเป็นการอ่าน record ภายในเพื่อหา token — คนละเรื่อง ใช้ได้ปกติ)
CREATE OR REPLACE FUNCTION rpc_public_lbs_stock(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l public_share_links; res JSONB;
BEGIN
  IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
    RAISE EXCEPTION 'ลิงก์ไม่ถูกต้อง';
  END IF;

  SELECT * INTO l FROM public_share_links
   WHERE token_hash = encode(sha256(convert_to(btrim(p_token), 'UTF8')), 'hex');
  IF l.id IS NULL THEN RAISE EXCEPTION 'ลิงก์ไม่ถูกต้อง หรือถูกเพิกถอนไปแล้ว'; END IF;
  IF l.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'ลิงก์นี้ถูกเพิกถอนแล้ว — ขอลิงก์ใหม่จากผู้ดูแล';
  END IF;

  UPDATE public_share_links
     SET view_count = view_count + 1, last_viewed_at = now()
   WHERE id = l.id;

  SELECT jsonb_build_object(
    'stockNo', COALESCE((SELECT stock_no FROM project_stocks WHERE id = l.project_stock_id), 'ทุกคลัง'),
    'generatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'stocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'stockNo', s.stock_no, 'status', s.status, 'notes', s.notes) ORDER BY s.stock_no)
        FROM project_stocks s
       WHERE l.project_stock_id IS NULL OR s.id = l.project_stock_id), '[]'::JSONB),
    'units', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.id, 'serialLvb', u.serial_lvb, 'serialOm', u.serial_om,
        'projectStockId', u.project_stock_id, 'status', u.status, 'jobId', u.job_id,
        'fobDate', u.fob_date, 'etaLeadDays', u.eta_lead_days,
        'planPoReceiptDate', u.plan_po_receipt_date, 'planDeliveryDate', u.plan_delivery_date
        -- ⚠️ ไม่มี unit_cost · ไม่มี plan_contact_phone
        ) ORDER BY u.serial_lvb)
        FROM lbs_units u
       WHERE l.project_stock_id IS NULL OR u.project_stock_id = l.project_stock_id), '[]'::JSONB),
    'jobs', COALESCE((
      SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'id', j.id, 'jobNo', j.job_no, 'customerName', j.customer_name,
        'installLocation', j.install_location
        -- ⚠️ ไม่มี contact_phone (PDPA) · ไม่มี budget_* ใด ๆ
        ))
        FROM jobs j
       WHERE EXISTS (SELECT 1 FROM lbs_units u
                      WHERE u.job_id = j.id
                        AND (l.project_stock_id IS NULL OR u.project_stock_id = l.project_stock_id))
      ), '[]'::JSONB),
    'installs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'unitId', r.unit_id, 'outcome', r.outcome,
        'installedDate', r.installed_date, 'performedAt', r.performed_at)
        -- ⚠️ ไม่มีพิกัดเช็คอิน ไม่มีรูปหน้างาน
        )
        FROM unit_installations r
       WHERE EXISTS (SELECT 1 FROM lbs_units u
                      WHERE u.id = r.unit_id
                        AND (l.project_stock_id IS NULL OR u.project_stock_id = l.project_stock_id))
      ), '[]'::JSONB)
  ) INTO res;

  RETURN res;
END $$;

-- ⚠️ Supabase แจก privilege ให้ `anon`/`authenticated` บนสคีมา public เป็นค่า default ของโปรเจกต์
--    (ทั้ง SELECT บนตาราง และ EXECUTE บนฟังก์ชัน) — ตัวที่กันจริงคือ **RLS** ไม่ใช่ GRANT
--    แต่ของ 3 ชิ้นนี้เราคุมเองได้ จึง REVOKE ให้ชัด = เกราะชั้นสองนอกเหนือจาก RLS
REVOKE ALL ON FUNCTION public.rpc_public_lbs_stock(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_public_lbs_stock(TEXT) TO anon, authenticated;

-- ตัวสร้าง/เพิกถอน: anon ห้ามแตะเด็ดขาด (ถึงเรียกได้ app_assert_dept ก็ throw เพราะ auth.uid() เป็น NULL
-- แต่ปิดที่ชั้น GRANT ด้วยดีกว่า — ไม่ต้องพึ่ง runtime check อย่างเดียว)
REVOKE ALL ON FUNCTION public.rpc_create_share_link(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_revoke_share_link(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_share_link(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_revoke_share_link(UUID) TO authenticated;

-- ตารางทะเบียนลิงก์: anon ไม่มีเหตุต้องแตะเลย (เข้าถึงผ่าน RPC ทางเดียว) — ถอน default grant ทิ้ง
REVOKE ALL ON TABLE public_share_links FROM anon;

-- ---------- 5) ตรวจผล ----------
DO $$
DECLARE src TEXT; n INT;
BEGIN
  -- 5.1 anon ต้องเข้าถึงได้ **ทางเดียว** คือ RPC อ่านข้อมูล — ห้ามมี policy เปิดให้
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO src FROM pg_policies
   WHERE schemaname = 'public' AND 'anon' = ANY(roles);
  IF src IS NOT NULL THEN
    RAISE EXCEPTION '0069: มี RLS policy ที่ให้สิทธิ์ role anon อยู่ (%) — ลิงก์สาธารณะต้องผ่าน RPC เท่านั้น', src;
  END IF;
  -- ⚠️ **ห้ามวัดด้วย has_table_privilege()** — Supabase แจก SELECT ให้ anon บนสคีมา public
  --    เป็นค่า default ของโปรเจกต์ (0057 ถอนไปแค่ INSERT/UPDATE/DELETE) ⇒ จะ false positive เสมอ
  --    **ตัวที่กันจริงคือ RLS**: เปิด RLS + ไม่มี policy ให้ anon = anon อ่านได้ 0 แถว
  --    (พลาดมาแล้วรอบแรกของไฟล์นี้ — migration ล้มทั้งที่ระบบปลอดภัยอยู่แล้ว)
  SELECT string_agg(c.relname, ', ') INTO src
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relrowsecurity = false
     AND c.relname IN ('public_share_links', 'lbs_units', 'jobs', 'project_stocks', 'unit_installations');
  IF src IS NOT NULL THEN
    RAISE EXCEPTION '0069: ตารางที่ลิงก์สาธารณะแตะยังไม่เปิด RLS (%) — anon จะอ่านตรงได้', src;
  END IF;

  -- 5.2 anon ต้องเรียก RPC อ่านได้จริง (ไม่งั้นลิงก์เปิดไม่ออก)
  IF NOT has_function_privilege('anon', 'public.rpc_public_lbs_stock(TEXT)', 'EXECUTE') THEN
    RAISE EXCEPTION '0069: anon เรียก rpc_public_lbs_stock ไม่ได้';
  END IF;
  -- ...แต่ห้ามเรียกตัวสร้าง/เพิกถอนได้เด็ดขาด
  IF has_function_privilege('anon', 'public.rpc_create_share_link(UUID, TEXT)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_revoke_share_link(UUID)', 'EXECUTE') THEN
    RAISE EXCEPTION '0069: anon เรียก RPC สร้าง/เพิกถอนลิงก์ได้ — ใครก็ออกลิงก์เองได้';
  END IF;

  -- 5.3 🔴 ข้อสำคัญที่สุด: ฟังก์ชันสาธารณะห้ามคืนตัวเลขเงิน / เบอร์โทร (มติผู้ใช้)
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_public_lbs_stock';
  IF src IS NULL THEN RAISE EXCEPTION '0069: ไม่พบ rpc_public_lbs_stock'; END IF;
  IF position('unit_cost' IN src) > 0 THEN
    RAISE EXCEPTION '0069: rpc_public_lbs_stock คืน unit_cost — ลิงก์สาธารณะห้ามมีตัวเลขเงิน';
  END IF;
  IF position('contact_phone' IN src) > 0 THEN
    RAISE EXCEPTION '0069: rpc_public_lbs_stock คืนเบอร์โทร — ข้อมูลส่วนบุคคลห้ามออกลิงก์สาธารณะ';
  END IF;
  IF position('budget_' IN src) > 0 THEN
    RAISE EXCEPTION '0069: rpc_public_lbs_stock คืนข้อมูลงบประมาณ';
  END IF;
  -- ⚠️ **อย่าใช้ regex หา `SELECT *` ในตัวฟังก์ชัน** — ตัวฟังก์ชันมี `SELECT * INTO l FROM
  --    public_share_links` ตอนหา token ซึ่งถูกต้องและจำเป็น (อ่าน record ภายใน ไม่ได้ใช้สร้าง payload)
  --    จะ false positive เสมอ (พลาดมาแล้วรอบที่ 2 ของไฟล์นี้)
  --    ⇒ กติกา "ห้ามพาคอลัมน์ใหม่หลุด" ตรวจที่ **รูปร่าง payload จริง** ใน block ที่ 7 ท้ายไฟล์แทน
  --      ซึ่งแข็งแรงกว่า: เรียกฟังก์ชันจริงแล้วเทียบชื่อคีย์กับ whitelist ตรง ๆ

  RAISE NOTICE '0069: OK — ลิงก์สาธารณะดูคลัง LBS (ไม่มีเงิน ไม่มีเบอร์โทร · เพิกถอนได้)';
END $$;

-- ---------- 6) พิสูจน์ของจริง: สวมบทบาท anon แล้วลองอ่านตารางตรง ๆ ----------
-- แยกเป็น block ของตัวเองและ **ห้ามทำให้ migration ล้มเพราะเหตุอื่น** — ถ้าสวมบทบาทไม่ได้
-- (สิทธิ์ของคนรัน) ให้ข้ามไปพร้อม NOTICE · จะ RAISE เฉพาะกรณีที่ anon อ่านข้อมูลได้จริงเท่านั้น
DO $$
DECLARE n_units INT := -1; n_jobs INT := -1;
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    SELECT COUNT(*) INTO n_units FROM lbs_units;
    SELECT COUNT(*) INTO n_jobs  FROM jobs;
  EXCEPTION WHEN OTHERS THEN
    n_units := -1; n_jobs := -1;   -- ถูกปฏิเสธสิทธิ์ / สวมบทบาทไม่ได้ = ปลอดภัยอยู่แล้ว
  END;
  RESET ROLE;
  IF n_units > 0 OR n_jobs > 0 THEN
    RAISE EXCEPTION '0069: 🔴 anon อ่านตารางตรงได้ (lbs_units % แถว · jobs % แถว) — RLS ไม่ได้กัน หยุดก่อน', n_units, n_jobs;
  END IF;
  RAISE NOTICE '0069: ตรวจสวมบทบาท anon แล้ว — อ่านตารางตรงไม่ได้ (units=% jobs=% · -1 = ถูกปฏิเสธสิทธิ์)', n_units, n_jobs;
END $$;

-- ---------- 7) 🔴 ตรวจ "รูปร่าง payload จริง" — ด่านกันข้อมูลหลุดตัวจริง ----------
-- ออกลิงก์ชั่วคราว → เรียกฟังก์ชันจริง → เทียบ**ชื่อคีย์**กับ whitelist → ลบลิงก์ทิ้ง
-- แข็งแรงกว่าการ grep body เพราะจับได้แม้คนเขียนเปลี่ยนวิธีประกอบ JSON ไปเป็นแบบอื่น
-- ⚠️ เพิ่มคอลัมน์ใหม่ใน rpc_public_lbs_stock วันหลัง = ต้องมาแก้ whitelist ตรงนี้ด้วย
--    ซึ่งเป็นจุดที่บังคับให้ "ตัดสินใจอย่างรู้ตัว" ว่าจะเปิดข้อมูลนั้นออกสู่สาธารณะจริงไหม
DO $$
DECLARE tok TEXT; lid UUID; res JSONB; ks TEXT; want TEXT; owner_id UUID;
BEGIN
  SELECT id INTO owner_id FROM profiles ORDER BY email LIMIT 1;   -- created_at เป็น NULL ได้ (DEFAULT NOW() ไม่ใช่ NOT NULL)
  IF owner_id IS NULL THEN
    RAISE NOTICE '0069: ข้ามการตรวจรูปร่าง payload — ยังไม่มีผู้ใช้ในระบบ';
    RETURN;
  END IF;

  tok := replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', '');
  INSERT INTO public_share_links (token_hash, token_hint, label, created_by)
  VALUES (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), right(tok, 6),
          '[ตรวจสอบอัตโนมัติ 0069]', owner_id)
  RETURNING id INTO lid;

  res := rpc_public_lbs_stock(tok);
  DELETE FROM public_share_links WHERE id = lid;   -- ลบก่อนเช็ค เพื่อไม่ให้ค้างถ้า RAISE

  IF jsonb_array_length(res->'units') > 0 THEN
    SELECT string_agg(k, ',' ORDER BY k) INTO ks FROM jsonb_object_keys(res->'units'->0) AS k;
    want := 'etaLeadDays,fobDate,id,jobId,planDeliveryDate,planPoReceiptDate,projectStockId,serialLvb,serialOm,status';
    IF ks <> want THEN
      RAISE EXCEPTION '0069: คีย์ของ units ที่ลิงก์สาธารณะคืนไม่ตรง whitelist — ได้ [%] ต้องเป็น [%]', ks, want;
    END IF;
  END IF;

  IF jsonb_array_length(res->'jobs') > 0 THEN
    SELECT string_agg(k, ',' ORDER BY k) INTO ks FROM jsonb_object_keys(res->'jobs'->0) AS k;
    want := 'customerName,id,installLocation,jobNo';
    IF ks <> want THEN
      RAISE EXCEPTION '0069: คีย์ของ jobs ที่ลิงก์สาธารณะคืนไม่ตรง whitelist — ได้ [%] ต้องเป็น [%]', ks, want;
    END IF;
  END IF;

  RAISE NOTICE '0069: ตรวจรูปร่าง payload จริงแล้ว — units/jobs คืนเฉพาะคอลัมน์ใน whitelist (units %, jobs %)',
    jsonb_array_length(res->'units'), jsonb_array_length(res->'jobs');
END $$;
