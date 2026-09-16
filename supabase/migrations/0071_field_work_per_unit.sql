-- =============================================================================
-- 0071 — 🔧 ด่านงานหน้าไซต์เป็น "รายเครื่อง" ไม่ใช่ "รายใบ" (2026-09-16)
--
-- โจทย์: 0059 แยกการเบิกออกเป็นรายชิ้นแล้ว แต่ทุกด่านปลายน้ำยังล็อกที่ terminal_status = 'issued'
--   ⇒ Project ส่ง LBS 2 จาก 5 เครื่องให้ช่างได้ แต่ช่าง **ยืนยันติดตั้งไม่ได้ · มอบหมายทีมไม่ได้ ·
--     บันทึกออกหน้างานไม่ได้** และงานไม่โผล่ในหน้า Service เลยสักพาเนล
--     (หลุดจาก "รอ Project เบิกให้" เพราะไม่ใช่ ready_to_issue แล้ว · ยังไม่เข้า "เบิกแล้ว" เพราะใบยังไม่ครบ)
--   ⇒ ย้อนแย้งกับโจทย์ตั้งต้นของ 0059 เอง ("ของพร้อมแล้วแต่ทีม Service เข้าไซต์ไม่ได้")
--
-- รากของปัญหา: terminal_status = 'issued' ถูกใช้ 2 ความหมายพร้อมกัน
--   (1) "ใบงานจบการเบิกแล้ว" — เชิงบัญชี/ล็อก   (2) "ของถึงมือ Service แล้ว เริ่มงานได้" — เชิงปฏิบัติการ
-- ไฟล์นี้แยก (2) ออกมาเป็นด่านของตัวเอง โดยวัดจาก **ของที่ออกจากคลังจริง**:
--   ยืนยัน/บล็อกติดตั้งรายเครื่อง → เครื่องนั้นต้อง lbs_units.status = 'issued'
--   มอบหมายทีม · บันทึกออกหน้างาน · นับคิวงานของช่าง → Job ต้องมีเครื่องที่ issued อย่างน้อย 1
--
-- 🔴 สิ่งที่ **ห้ามเปลี่ยน และมี DO block เฝ้าไว้ท้ายไฟล์**:
--   rpc_close_job_install ยังต้องบังคับ terminal_status = 'issued' เหมือนเดิม
--   ⇒ ปิดงานทั้งที่ของยังออกไม่ครบ Scope ยังทำไม่ได้ · ไฟล์นี้ปลดแค่ "ทำงานหน้างานได้"
--     ไม่ได้ปลด "ปิดงานได้" · ถ้าใครเผลอปลดด่านนั้นด้วย ใบจะปิดได้ทั้งที่ LBS ยังอยู่ในคลัง
--
-- 🔴 ด่านใหม่ต้องกัน 2 สถานะที่ด่านเดิมกันให้ฟรีมาก่อน: งานที่ปิดแล้ว (installed) และยกเลิก (cancelled)
--   เดิมเช็ค "= issued" ตัวเดียวจึงกันครบโดยบังเอิญ · พอเปลี่ยนมาเช็คที่ตัวเครื่อง ต้องเขียนกันเอง
--   ไม่งั้นจะแก้ผลติดตั้งย้อนหลังบนงานที่ปิดไปแล้วได้
--
-- วิธีแก้ใช้ app_swap_guard (0037) แทนการพิมพ์ body ใหม่ — ฟังก์ชันพวกนี้ยาวและถูกแก้มาหลายรอบ
-- (0035 → 0036 → 0040) พิมพ์ใหม่ = เสี่ยงย้อนของเก่าทับ · swap เป็น idempotent รันซ้ำได้
--
-- ไม่เปลี่ยน signature ของ RPC ใด ⇒ **รันก่อนหรือหลัง push ก็ได้**
-- (รัน SQL ก่อน: ช่างกดยืนยันได้เลยแม้หน้าเว็บยังไม่อัปเดต · push ก่อน: งานโผล่ในหน้า Service
--  แต่กดยืนยันแล้วยังติด error เดิมจนกว่าจะรัน SQL)
-- =============================================================================

-- ---------- 1) helper ใหม่ ----------

/** Job นี้มีของอยู่กับ Service แล้วหรือยัง และยังทำงานหน้างานได้อยู่ไหม */
CREATE OR REPLACE FUNCTION app_job_field_active(jid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM jobs j WHERE j.id = jid
                  AND j.terminal_status IS DISTINCT FROM 'installed'
                  AND j.terminal_status IS DISTINCT FROM 'cancelled')
     AND EXISTS (SELECT 1 FROM lbs_units u WHERE u.job_id = jid AND u.status = 'issued')
$$;

COMMENT ON FUNCTION app_job_field_active(UUID) IS
  '0071 — งานที่ทีมช่างทำงานกับมันได้: มี LBS ออกจากคลังแล้วอย่างน้อย 1 เครื่อง และยังไม่ปิด/ยกเลิก '
  '· ใช้แทนเงื่อนไข terminal_status = ''issued'' ในงานฝั่ง Service (ยกเว้น rpc_close_job_install)';

/** ด่านรายเครื่อง — วัดที่ "เครื่องนี้ออกจากคลังไปแล้วหรือยัง" ไม่ใช่ "ใบนี้เบิกครบหรือยัง" */
CREATE OR REPLACE FUNCTION app_assert_unit_issued_out(p_unit_id UUID)
RETURNS lbs_units LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u lbs_units; j jobs;
BEGIN
  SELECT * INTO u FROM lbs_units WHERE id = p_unit_id;
  IF u.id IS NULL THEN RAISE EXCEPTION 'ไม่พบเครื่อง LBS'; END IF;
  IF u.job_id IS NULL THEN RAISE EXCEPTION 'เครื่องนี้ยังไม่ได้ผูกกับ Job'; END IF;
  SELECT * INTO j FROM jobs WHERE id = u.job_id FOR UPDATE;
  IF j.terminal_status = 'installed' THEN
    RAISE EXCEPTION '% ปิดงานติดตั้งแล้ว — แก้ผลติดตั้งไม่ได้', j.job_no;
  END IF;
  IF j.terminal_status = 'cancelled' THEN
    RAISE EXCEPTION '% ถูกยกเลิกไปแล้ว', j.job_no;
  END IF;
  IF u.status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION '% ยังไม่ถูกเบิกให้ Service — ให้ Project เบิกเครื่องนี้ก่อน', u.serial_lvb;
  END IF;
  RETURN u;
END $$;

-- ---------- 2) ย้ายด่านของ RPC ที่มีอยู่ ----------
DO $$
BEGIN
  -- 2.1 ยืนยัน / บล็อกติดตั้งรายเครื่อง (0035 · 0036 นิยาม confirm ทับด้วย p_installed_by)
  PERFORM app_swap_guard('rpc_confirm_unit_install',
    'app_assert_unit_on_issued_job(p_unit_id)', 'app_assert_unit_issued_out(p_unit_id)');
  PERFORM app_swap_guard('rpc_block_unit_install',
    'app_assert_unit_on_issued_job(p_unit_id)', 'app_assert_unit_issued_out(p_unit_id)');

  -- 2.2 บันทึกออกหน้างาน / เลื่อนนัด (0034) — ไปหน้างานรอบแรกตั้งแต่ของยังไม่ครบใบเกิดขึ้นจริง
  PERFORM app_swap_guard('rpc_log_site_visit',
    'j.terminal_status <> ''issued'' THEN RAISE EXCEPTION ''%: บันทึกได้เฉพาะงานที่เบิกแล้ว (Issued)'', j.job_no;',
    'NOT app_job_field_active(j.id) THEN RAISE EXCEPTION ''%: บันทึกออกหน้างานได้เมื่อมี LBS ที่เบิกให้ Service แล้วอย่างน้อย 1 เครื่อง'', j.job_no;');

  -- 2.3 มอบหมายทีม (0036) — ทีมต้องรู้ล่วงหน้าว่าใครไป ไม่ใช่รอจนใบครบ
  --     แยก 2 swap: เงื่อนไข กับ ข้อความ (ตัวฟังก์ชันเขียนคร่อม 3 บรรทัด จับทั้งก้อนเปราะกว่า)
  PERFORM app_swap_guard('rpc_assign_job_team',
    'j.terminal_status IS DISTINCT FROM ''issued'' THEN', 'NOT app_job_field_active(j.id) THEN');
  PERFORM app_swap_guard('rpc_assign_job_team',
    '''มอบหมายทีมได้เฉพาะงานที่เบิกแล้ว (Issued) — % อยู่สถานะอื่น''',
    '''มอบหมายทีมได้เมื่อมี LBS ที่เบิกให้ Service แล้ว — % ยังไม่มีของออกจากคลัง''');

  -- 2.4 ปิดใช้งานช่าง (0036) — งานที่เบิกบางส่วนก็เป็น "งานรอติดตั้ง" ที่ต้องย้ายมอบหมายก่อน
  --     ไม่แก้ตรงนี้ = ปิดช่างที่ยังมีคิวงานค้างได้ คิวงานหายเงียบ
  PERFORM app_swap_guard('rpc_update_team_member',
    'AND j.terminal_status = ''issued'';', 'AND app_job_field_active(j.id);');
END $$;

-- ด่านเดิมไม่มีใครเรียกแล้ว — ทิ้งไว้จะกลายเป็นชื่อที่โกหก (ชวนให้คนแก้ทีหลังเรียกผิดตัว)
DROP FUNCTION IF EXISTS app_assert_unit_on_issued_job(UUID);

GRANT EXECUTE ON FUNCTION public.app_job_field_active(UUID) TO authenticated;

-- ---------- 3) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE n INT; src TEXT; fn TEXT;
BEGIN
  -- 3.1 helper ใหม่ต้องมีจริง และตัวเก่าต้องหายไป
  IF to_regprocedure('public.app_job_field_active(uuid)') IS NULL THEN
    RAISE EXCEPTION '0071: ไม่มี app_job_field_active';
  END IF;
  IF to_regprocedure('public.app_assert_unit_issued_out(uuid)') IS NULL THEN
    RAISE EXCEPTION '0071: ไม่มี app_assert_unit_issued_out';
  END IF;
  IF to_regprocedure('public.app_assert_unit_on_issued_job(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '0071: app_assert_unit_on_issued_job ยังอยู่ — ชื่อนี้โกหกด่านที่ใช้จริงแล้ว';
  END IF;

  -- 3.2 ด่านเดิมต้องไม่เหลือใน 5 RPC ที่ย้ายแล้ว (ตรวจที่ body จริงใน DB ไม่ใช่ที่ไฟล์)
  FOREACH fn IN ARRAY ARRAY['rpc_confirm_unit_install', 'rpc_block_unit_install',
                            'rpc_log_site_visit', 'rpc_assign_job_team', 'rpc_update_team_member'] LOOP
    SELECT string_agg(regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g'), E'\n') INTO src
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = fn;
    IF src IS NULL THEN RAISE EXCEPTION '0071: ไม่พบฟังก์ชัน %', fn; END IF;
    IF position('app_assert_unit_on_issued_job' IN src) > 0 THEN
      RAISE EXCEPTION '0071: % ยังเรียกด่านเดิม app_assert_unit_on_issued_job', fn;
    END IF;
    IF position('app_job_field_active' IN src) = 0
       AND position('app_assert_unit_issued_out' IN src) = 0 THEN
      RAISE EXCEPTION '0071: % ไม่ได้ใช้ด่านใหม่เลย — swap ไม่ติด', fn;
    END IF;
  END LOOP;

  -- 3.3 🔴 ด่านปิดงานต้องยังอยู่ — นี่คือสิ่งที่ไฟล์นี้สัญญาว่าจะไม่แตะ
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'rpc_close_job_install';
  IF src IS NULL THEN RAISE EXCEPTION '0071: ไม่พบ rpc_close_job_install'; END IF;
  IF position('ปิดงานได้เฉพาะงานที่เบิกแล้ว' IN src) = 0 THEN
    RAISE EXCEPTION '0071: rpc_close_job_install ไม่มีด่าน terminal_status = issued แล้ว — '
                    'ปิดงานได้ทั้งที่ LBS ยังอยู่ในคลัง (ห้ามปลดด่านนี้)';
  END IF;

  -- 3.4 ด่านใหม่ต้องกันงานที่ปิด/ยกเลิกด้วย (ด่านเดิมกันให้ฟรีโดยบังเอิญ)
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_assert_unit_issued_out';
  IF position('installed' IN src) = 0 OR position('cancelled' IN src) = 0 THEN
    RAISE EXCEPTION '0071: app_assert_unit_issued_out ไม่ได้กันงานที่ปิด/ยกเลิก — '
                    'จะแก้ผลติดตั้งย้อนหลังบนงานที่ปิดไปแล้วได้';
  END IF;

  SELECT count(*) INTO n FROM lbs_units WHERE status = 'issued';
  RAISE NOTICE '0071: OK — ด่านงานหน้าไซต์ย้ายมาที่รายเครื่องแล้ว (ตอนนี้มี % เครื่องที่เบิกออกไป)', n;
  RAISE NOTICE '  ปิดงานยังต้องเบิกครบทั้งใบเหมือนเดิม (rpc_close_job_install ไม่ถูกแตะ)';
END $$;
