-- =============================================================================
-- 0086 — 📍 จุดติดตั้งรายเครื่อง: สัญญาเดียวกัน แต่ละ set ไปคนละสถานี (2026-10-14)
--
-- ที่มา (ผู้ใช้ขอ 2026-10-14 · ต่อจาก 0085 · เลือกแบบ B):
--   Job มีจุดติดตั้งหลายจุดอยู่แล้ว (0026: จุดที่ 1 = jobs.install_location · จุดที่ 2+ = jobs.install_sites JSONB)
--   แต่ไม่รู้ว่าเครื่องไหนไปจุดไหน ⇒ หลังดึงเข้า Job ทุกเครื่องเห็นจุดที่ 1
--   Location รายเครื่องหายไป + ธง "ต่างจากสัญญา: Location" ขึ้นผิด
--
-- ทางแก้:
--   1) แต่ละจุดใน jobs.install_sites ได้ id ถาวร (uuid ในคีย์ "id") — เครื่องอ้างด้วย id ไม่ใช่ลำดับ
--      ⇒ ลบ/สลับลำดับจุดแล้วเครื่องไม่หลุดจุด · จุดที่ 1 ไม่มี id (= ค่าว่าง)
--      trigger trg_job_install_sites_ids เติม id ให้จุดใหม่ + **กันลบจุดที่ยังมีเครื่องผูกอยู่**
--      ⚠️ ไม่แตะ body ของ rpc_create_job / rpc_update_job — ผ่าน app_swap_guard มาหลายรอบ (0075/0077)
--         ทั้งคู่เก็บ p_install_sites ลงตรง ๆ อยู่แล้ว คีย์ "id" จาก client จึงผ่านไปถึงตารางได้เอง
--   2) lbs_units.install_site_id TEXT — ว่าง = จุดที่ 1
--      trigger trg_unit_site_default: ดึงเข้า Job (in_stock → allocated) → เดาจุดจากสถานที่ของเครื่อง
--        (Location รายเครื่อง) ด้วย app_match_job_site · คืนเข้าคลัง → ล้างทิ้ง
--      ⚠️ ไม่ patch body ของ rpc_draw_lbs / rpc_return_lbs (กติกาเดียวกับ 0084)
--   3) rpc_assign_unit_site — Project ย้ายเครื่องไปจุดอื่นได้จนกว่าจะเบิกให้ Service
--      (เครื่องที่เบิกแล้วถูก trg_block_issued_edit ล็อกทั้งแถวอยู่แล้ว)
--
-- demo sync: src/data/logic.ts (jobSites / unitJobSite / matchJobSite / assignUnitSite / drawLbs /
--   updateJob / normalizeInstallSites / unitCustomerInfo) · รันหลัง 0085 · idempotent
-- **รันก่อน push** (หน้า Job เรียก rpc_assign_unit_site · ฟอร์มแก้ Job ส่ง id ของจุดกลับไป)
-- =============================================================================

-- ---------- 1) คอลัมน์จุดติดตั้งของเครื่อง ----------
ALTER TABLE lbs_units ADD COLUMN IF NOT EXISTS install_site_id TEXT;
COMMENT ON COLUMN lbs_units.install_site_id IS
  '0086 — id ของจุดใน jobs.install_sites ที่เครื่องนี้ไปติดตั้ง · NULL = จุดที่ 1 (install_location ของ Job)';

-- ---------- 2) id ถาวรของจุดติดตั้ง ----------
CREATE OR REPLACE FUNCTION app_install_sites_with_ids(p JSONB) RETURNS JSONB
LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'array' THEN p
    ELSE COALESCE((
      SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' AND NULLIF(e->>'id', '') IS NULL
                            THEN e || jsonb_build_object('id', gen_random_uuid()::TEXT) ELSE e END ORDER BY ord)
        FROM jsonb_array_elements(p) WITH ORDINALITY t(e, ord)), '[]'::JSONB)
  END
$$;

-- backfill จุดเดิมที่ยังไม่มี id (ตาราง jobs ไม่มี trigger ล็อก — แก้ใบที่เบิกแล้วได้)
UPDATE jobs SET install_sites = app_install_sites_with_ids(install_sites)
 WHERE jsonb_typeof(install_sites) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(install_sites) e
                WHERE jsonb_typeof(e) = 'object' AND NULLIF(e->>'id', '') IS NULL);

CREATE OR REPLACE FUNCTION app_job_install_sites_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE orphan TEXT;
BEGIN
  NEW.install_sites := app_install_sites_with_ids(NEW.install_sites);
  IF TG_OP = 'UPDATE' THEN
    -- client เก่าที่ไม่ส่ง id กลับมา ก็ตกด่านนี้เช่นกัน (จุดได้ id ใหม่ → เครื่องหา id เดิมไม่เจอ) — ดีกว่าหลุดจุดเงียบ ๆ
    SELECT string_agg(u.serial_lvb, ', ' ORDER BY u.serial_lvb) INTO orphan
      FROM lbs_units u
     WHERE u.job_id = NEW.id AND u.install_site_id IS NOT NULL
       AND u.install_site_id NOT IN (
         SELECT e->>'id' FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(NEW.install_sites) = 'array' THEN NEW.install_sites ELSE '[]'::JSONB END) e
          WHERE e->>'id' IS NOT NULL);
    IF orphan IS NOT NULL THEN
      RAISE EXCEPTION 'ลบจุดติดตั้งที่ยังมีเครื่องผูกอยู่ไม่ได้ (%) — ย้ายเครื่องไปจุดอื่นที่ตาราง "LBS ที่ดึงเข้า Job" ก่อน', orphan;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_job_install_sites_ids ON jobs;
CREATE TRIGGER trg_job_install_sites_ids
  BEFORE INSERT OR UPDATE OF install_sites ON jobs
  FOR EACH ROW EXECUTE FUNCTION app_job_install_sites_guard();

-- ---------- 3) เดาจุดจากสถานที่ของเครื่อง ----------
-- เทียบแบบไม่สนช่องว่างซ้ำ/ตัวพิมพ์ (กติกาเดียวกับ matchJobSite ใน logic.ts)
-- ตรงจุดที่ 2+ คืน id · ตรงจุดที่ 1 หรือไม่ตรงเลย คืน NULL (= จุดที่ 1)
CREATE OR REPLACE FUNCTION app_match_job_site(p_main TEXT, p_sites JSONB, p_location TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  WITH norm AS (SELECT lower(btrim(regexp_replace(COALESCE(p_location, ''), '\s+', ' ', 'g'))) AS loc)
  SELECT CASE
    WHEN (SELECT loc FROM norm) = '' THEN NULL
    WHEN lower(btrim(regexp_replace(COALESCE(p_main, ''), '\s+', ' ', 'g'))) = (SELECT loc FROM norm) THEN NULL
    ELSE (SELECT e->>'id'
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_sites) = 'array' THEN p_sites ELSE '[]'::JSONB END)
                 WITH ORDINALITY t(e, ord)
           WHERE lower(btrim(regexp_replace(COALESCE(e->>'location', ''), '\s+', ' ', 'g'))) = (SELECT loc FROM norm)
           ORDER BY ord LIMIT 1)
  END
$$;

CREATE OR REPLACE FUNCTION app_unit_site_default() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  IF OLD.status = 'in_stock' AND NEW.status = 'allocated' AND NEW.job_id IS NOT NULL THEN
    SELECT * INTO j FROM jobs WHERE id = NEW.job_id;
    -- ⚠️ อ่านแค่ Location รายเครื่อง — ไม่อ้างตาราง contracts (0087 ยกเลิกทะเบียนสัญญา)
    NEW.install_site_id := app_match_job_site(j.install_location, j.install_sites, NEW.plan_install_location);
  ELSIF NEW.status = 'in_stock' AND OLD.status IS DISTINCT FROM 'in_stock' THEN
    NEW.install_site_id := NULL;          -- คืนเข้าคลัง — จุดของ Job เดิมไม่มีความหมายแล้ว
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_unit_site_default ON lbs_units;
CREATE TRIGGER trg_unit_site_default
  BEFORE UPDATE OF status ON lbs_units
  FOR EACH ROW EXECUTE FUNCTION app_unit_site_default();

-- ---------- 4) ย้ายเครื่องไปจุดอื่น ----------
CREATE OR REPLACE FUNCTION rpc_assign_unit_site(p_job_id UUID, p_unit_ids UUID[], p_site_id TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; j jobs; v_site TEXT; v_no INT; v_loc TEXT; n INT; bad TEXT; serials TEXT;
BEGIN
  actor := app_assert_dept(ARRAY['project']);   -- กติกาเดียวกับดึง LBS (admin ผ่านเสมอ)
  j := app_assert_job_editable(p_job_id);        -- ใบที่เบิกครบ/ยกเลิกแล้ว + เจ้าของงาน (0042)
  n := COALESCE(array_length(p_unit_ids, 1), 0);
  IF n = 0 THEN RAISE EXCEPTION 'กรุณาเลือกเครื่อง'; END IF;

  v_site := NULLIF(btrim(COALESCE(p_site_id, '')), '');
  IF v_site = 'main' THEN v_site := NULL; END IF;
  IF v_site IS NULL THEN
    v_no := 1; v_loc := j.install_location;
  ELSE
    SELECT ord + 1, e->>'location' INTO v_no, v_loc
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.install_sites) = 'array' THEN j.install_sites ELSE '[]'::JSONB END)
           WITH ORDINALITY t(e, ord)
     WHERE e->>'id' = v_site;
    IF v_no IS NULL THEN RAISE EXCEPTION 'ไม่พบจุดติดตั้งนี้ใน % — อาจถูกลบไปแล้ว', j.job_no; END IF;
  END IF;

  SELECT string_agg(serial_lvb, ', ') INTO bad FROM lbs_units WHERE id = ANY(p_unit_ids) AND status = 'issued';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '% เบิกให้ Service แล้ว — เปลี่ยนจุดติดตั้งไม่ได้', bad; END IF;
  IF (SELECT count(*) FROM lbs_units WHERE id = ANY(p_unit_ids) AND job_id = p_job_id) <> n THEN
    RAISE EXCEPTION 'มีเครื่องที่ไม่ได้อยู่ใน %', j.job_no;
  END IF;

  UPDATE lbs_units SET install_site_id = v_site, updated_at = now() WHERE id = ANY(p_unit_ids);
  SELECT string_agg(serial_lvb, ', ' ORDER BY serial_lvb) INTO serials FROM lbs_units WHERE id = ANY(p_unit_ids);
  PERFORM app_audit('job', j.id, 'assign_unit_site', actor.id,
    j.job_no || ' · ' || serials || ' → จุดที่ ' || v_no || ' ' || COALESCE(v_loc, '-'));
END $$;

REVOKE ALL ON FUNCTION public.rpc_assign_unit_site(UUID, UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_assign_unit_site(UUID, UUID[], TEXT) TO authenticated;
-- ⚠️ ห้าม REVOKE app_install_sites_with_ids จาก authenticated — trigger บน jobs เรียกด้วยสิทธิ์ของคนที่ UPDATE
--    (ไม่ใช่ SECURITY DEFINER) ถอนสิทธิ์แล้วการแก้ Job ทางไหนก็ตามที่ไม่ผ่าน RPC จะพังทันที · ฟังก์ชันไม่มีผลข้างเคียง

-- ---------- 5) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'lbs_units' AND column_name = 'install_site_id') THEN
    RAISE EXCEPTION '0086: ไม่มีคอลัมน์ lbs_units.install_site_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_job_install_sites_ids' AND tgrelid = 'jobs'::regclass
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0086: trigger trg_job_install_sites_ids ไม่ได้ติดตั้ง/ถูกปิด';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_unit_site_default' AND tgrelid = 'lbs_units'::regclass
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0086: trigger trg_unit_site_default ไม่ได้ติดตั้ง/ถูกปิด';
  END IF;

  -- ทุกจุดที่ 2+ ต้องมี id แล้ว
  SELECT count(*) INTO n FROM jobs j, jsonb_array_elements(j.install_sites) e
   WHERE jsonb_typeof(j.install_sites) = 'array' AND jsonb_typeof(e) = 'object' AND NULLIF(e->>'id', '') IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '0086: ยังมีจุดติดตั้ง % จุดที่ไม่มี id', n; END IF;

  -- เดาจุด: ตรงจุดที่ 2 (ไม่สนช่องว่าง/ตัวพิมพ์) · ตรงจุดที่ 1 · ไม่ตรงเลย · ว่าง
  IF app_match_job_site('สถานี A', '[{"id":"x2","location":"สถานี  B "},{"id":"x3","location":"สถานี C"}]', ' สถานี b') IS DISTINCT FROM 'x2'
     OR app_match_job_site('สถานี A', '[{"id":"x2","location":"สถานี B"}]', 'สถานี A') IS NOT NULL
     OR app_match_job_site('สถานี A', '[{"id":"x2","location":"สถานี B"}]', 'สถานี Z') IS NOT NULL
     OR app_match_job_site('สถานี A', NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION '0086: app_match_job_site เดาจุดผิด';
  END IF;

  -- id ใหม่ถูกเติม · id เดิมไม่เปลี่ยน
  IF (app_install_sites_with_ids('[{"location":"x"},{"id":"keep","location":"y"}]')->1->>'id') <> 'keep'
     OR (app_install_sites_with_ids('[{"location":"x"}]')->0->>'id') IS NULL THEN
    RAISE EXCEPTION '0086: app_install_sites_with_ids เติม/คง id ไม่ถูก';
  END IF;

  RAISE NOTICE '0086: OK — จุดติดตั้งรายเครื่องพร้อมใช้ · ดึงเข้า Job แล้ววางจุดให้อัตโนมัติ · ย้ายจุดได้ที่หน้า Job';
END $$;
