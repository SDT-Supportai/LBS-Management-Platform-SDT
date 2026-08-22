-- =====================================================================
-- 0058: ปิดบัญชีแล้วต้องอ่านข้อมูลไม่ได้ (2026-08-22 · F3 ขั้น 2)
--
--  ขั้น 1 (`b24f262`) ตัดที่ระดับ auth ไปแล้ว — ปิดบัญชี = ban ⇒ ขอ token ใหม่ไม่ได้
--  ไฟล์นี้คือชั้นที่สอง: ถึงมี token ที่ยังไม่หมดอายุอยู่ในมือ ก็ต้องอ่านไม่ได้
--    (ban ตัดการ "ออก token ใหม่" · access token ที่ถืออยู่แล้วยังใช้ได้จนหมดอายุ default 1 ชม.)
--
--  ── ทำไมใช้ RESTRICTIVE policy ไม่ recreate read_all ──
--    policy อ่านมี 25+ ตัว (ชื่อ read_all เกือบทั้งหมด) · ถ้า DROP+CREATE ทีละตัว
--    พลาดตัวเดียว = แผนกนั้นมองไม่เห็นข้อมูลทั้งตาราง และต้องไล่ทดสอบ 25 รอบ
--    RESTRICTIVE policy ถูก **AND** เข้ากับ policy permissive ที่มีอยู่ ⇒ เป็นการ "เพิ่มเงื่อนไข"
--    ไม่ได้แตะ policy เดิมแม้แต่ตัวเดียว · rollback = DROP เฉพาะตัวที่ไฟล์นี้สร้าง
--
--  ── ข้อยกเว้นเดียว: profiles ──
--    StoreContext.login อ่าน profiles ของตัวเองทันทีหลัง signInWithPassword เพื่อเช็ค is_active
--    ถ้า restrict แบบตรงไปตรงมา แถวตัวเองจะหายไปด้วย ⇒ .single() error ⇒ โค้ดข้าม signOut
--    ⇒ ผู้ใช้เข้าไปเจอแอปว่างเปล่าแทนข้อความ "บัญชีนี้ถูกปิดการใช้งาน"
--    จึงเปิดให้อ่าน "แถวของตัวเอง" ได้เสมอ — ไม่ได้เปิดอะไรเพิ่ม เพราะเห็นข้อมูลตัวเองอยู่แล้ว
--
--  ⚠️ is_active เป็น BOOLEAN DEFAULT true ที่ **nullable** — ต้อง COALESCE(is_active, true)
--     ไม่งั้นบัญชีที่ค่าเป็น NULL จะมองไม่เห็นข้อมูลอะไรเลยทั้งที่ยังใช้งานอยู่
--     ตรวจก่อนรัน (ควรได้ 0):  SELECT count(*) FROM profiles WHERE is_active IS NULL;
--     ไฟล์นี้ RAISE NOTICE เตือนให้เองถ้าเจอ
--
--  my_is_active() ต้องเป็น STABLE — ไม่งั้น planner เรียกซ้ำทุกแถว (query profiles ต่อแถว)
--  และต้องเป็น SECURITY DEFINER — ไม่งั้นมันเองก็ติด policy ที่เพิ่งสร้าง (recursive)
--
--  ไม่กระทบ service_role (bypass RLS) และไม่กระทบ RPC (SECURITY DEFINER ทั้งหมด)
--  idempotent (DROP POLICY IF EXISTS ก่อน CREATE ทุกตัว) · รันหลัง 0057
-- =====================================================================

-- ---------- 1) helper ----------
CREATE OR REPLACE FUNCTION my_is_active() RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT COALESCE(is_active, true) FROM profiles WHERE id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.my_is_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_is_active() TO authenticated;

-- ---------- 2) เตือนก่อนถ้ามี is_active = NULL ----------
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM profiles WHERE is_active IS NULL;
  IF n > 0 THEN
    RAISE NOTICE '0058: มี % บัญชีที่ is_active เป็น NULL — COALESCE ครอบให้แล้ว (ถือว่ายังใช้งานได้) แต่ควรตั้งค่าให้ชัด', n;
  END IF;
END $$;

-- ---------- 3) ใส่ restrictive policy ให้ทุกตารางที่เปิด RLS ----------
-- วนจาก pg_class จริง ไม่ hardcode รายชื่อ → ตารางที่เพิ่มมาทีหลัง (std_drawings/std_boms/
-- std_bom_lines ที่ 0045 สร้างผ่าน format() loop) ก็ถูกครอบด้วย ไม่ตกหล่น
DO $$
DECLARE t TEXT; n INT := 0;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS require_active ON public.%I', t);
    IF t = 'profiles' THEN
      -- ต้องอ่านแถวตัวเองได้เสมอ ไม่งั้นหน้า login เช็ค is_active ไม่ได้ (ดูหัวไฟล์)
      EXECUTE format($f$CREATE POLICY require_active ON public.%I AS RESTRICTIVE
                        FOR SELECT TO authenticated USING (my_is_active() OR id = auth.uid())$f$, t);
    ELSE
      EXECUTE format($f$CREATE POLICY require_active ON public.%I AS RESTRICTIVE
                        FOR SELECT TO authenticated USING (my_is_active())$f$, t);
    END IF;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0058: ใส่ require_active ให้ % ตาราง', n;
END $$;

-- ---------- 3b) view ไม่มี RLS — ต้องตัด SELECT ทิ้งแทน ----------
-- ⚠️ ถ้าไม่ทำข้อนี้ ข้อ 3 ข้างบนแทบไม่มีความหมาย: view รันด้วยสิทธิ์ของ **owner** (ไม่ใช่ security_invoker)
--    ⇒ RLS ของตารางข้างใต้ถูก bypass ทั้งหมด ⇒ บัญชีที่ถูกปิดยังยิง /rest/v1/v_job_status
--      อ่านสถานะ + Job No. + ลูกค้าได้ ทั้งที่ตาราง jobs ปิดไปแล้ว
-- ปลอดภัยที่จะ revoke: frontend ไม่ได้ใช้ view เลย (grep 'v_job_status\|v_unit_install_state' src/ = 0)
--   ผู้ใช้จริงมีแค่ line-webhook (service_role — ไม่โดน revoke นี้) และ RPC (SECURITY DEFINER รันเป็น owner)
DO $$
DECLARE v TEXT; n INT := 0;
BEGIN
  FOR v IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'v' ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated, anon', v);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0058: ตัดสิทธิ์ authenticated/anon ออกจาก view % ตัว', n;
END $$;

-- ---------- 4) ตรวจผล ----------
DO $$
DECLARE missing TEXT;
BEGIN
  -- 4.1 ต้องไม่มีตารางที่เปิด RLS แล้วไม่มี require_active
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = c.relname
                        AND p.policyname = 'require_active');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0058 ไม่สมบูรณ์ — ตารางที่ยังไม่มี require_active: %', missing;
  END IF;

  -- 4.2 policy ต้องเป็น RESTRICTIVE จริง (ถ้าเป็น PERMISSIVE จะกลายเป็น "หรือ" = เปิดกว้างขึ้น ตรงข้ามกับที่ต้องการ)
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND policyname = 'require_active' AND permissive <> 'RESTRICTIVE') THEN
    RAISE EXCEPTION '0058 อันตราย — มี require_active ที่เป็น PERMISSIVE';
  END IF;

  -- 4.3 helper ต้อง STABLE + SECURITY DEFINER
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'my_is_active' AND provolatile = 's' AND prosecdef) THEN
    RAISE EXCEPTION '0058 ไม่สมบูรณ์ — my_is_active ต้องเป็น STABLE + SECURITY DEFINER';
  END IF;

  -- 4.4 view ต้องอ่านไม่ได้แล้ว (ไม่งั้นข้อ 3 ถูก bypass ทั้งชุด)
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'v'
     AND (has_table_privilege('authenticated', format('public.%I', c.relname), 'SELECT')
       OR has_table_privilege('anon',          format('public.%I', c.relname), 'SELECT'));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0058 ไม่สมบูรณ์ — view ที่ authenticated/anon ยังอ่านได้: %', missing;
  END IF;

  RAISE NOTICE '0058 OK — บัญชีที่ is_active = false อ่านข้อมูลไม่ได้แล้ว (อ่านแถว profiles ของตัวเองได้อย่างเดียว)';
END $$;

-- ---------- 5) ทดสอบด้วยตาหลังรัน (สำคัญ — ข้อ 4 ตรวจโครงสร้าง ไม่ได้ตรวจว่าคนใช้งานยังเห็นข้อมูล) ----------
--   1. login ด้วยบัญชี Project/Purchasing/Service ที่ใช้งานจริง → ต้องเห็นข้อมูลครบทุกหน้าเหมือนเดิม
--      (ถ้าจอว่าง/ขึ้นแบนเนอร์ "โหลดข้อมูลไม่สำเร็จ" = my_is_active() คืน false ผิด → rollback ทันที)
--   2. สร้างบัญชีทดสอบ → ปิดการใช้งาน → login → ต้องได้ "บัญชีนี้ถูกปิดการใช้งาน" (จาก ban ของขั้น 1)
--   3. ถ้าอยากทดสอบชั้นนี้ตรง ๆ: ปิดบัญชีที่ "กำลัง login ค้างอยู่" แล้วกด Refresh ในแอป
--      → ต้องเห็นข้อมูลว่าง/แบนเนอร์ ไม่ใช่ข้อมูลครบ (ยืนยันว่า token เดิมอ่านไม่ได้แล้ว)

-- ---------- 6) ROLLBACK ----------
--   DO $$ DECLARE t TEXT; BEGIN
--     FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
--               WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
--     LOOP EXECUTE format('DROP POLICY IF EXISTS require_active ON public.%I', t); END LOOP;
--   END $$;
--   (ไม่ต้องแตะ my_is_active() — ไม่มีใครเรียกแล้วก็ไม่มีผลอะไร)
