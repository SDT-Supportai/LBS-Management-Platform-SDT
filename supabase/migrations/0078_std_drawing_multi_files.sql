-- =============================================================================
-- 0078 — 📐 Standard Drawing แนบ PDF ได้หลายไฟล์ (2026-09-23)
--
-- ที่มา (ผู้ใช้ขอ 2026-09-23): โมดัล "เพิ่ม Standard Drawing" รับได้ไฟล์เดียว
--   แบบมาตรฐาน 1 ชุดมักมีหลายแผ่น (SLD · Layout · Foundation · Catalog อุปกรณ์) ⇒ ต้องแนบได้หลายไฟล์
--
-- โครง: คอลัมน์ `files JSONB` = array ของ {url, name, size} ในแถว std_drawings เดิม
--   🔴 ทำไมไม่แยกตารางลูกแบบ 0074/0076: ไฟล์ Drawing อยู่ใน bucket **public** install-photos (0045)
--      เก็บเป็น URL ตรง ไม่ต้องขอ signed URL · ไม่มีกติกาต่อไฟล์ (note/สิทธิ์แยก) ·
--      และโมดัลบันทึก "หัวข้อ + รายการไฟล์ทั้งชุด" ในคลิกเดียว ⇒ JSONB + RPC ตัวเดียว = atomic
--      (ตารางลูก = create แล้วค่อย add ไฟล์ทีละตัว · พังกลางทาง = Drawing ครึ่ง ๆ กลาง ๆ)
--
-- RPC ใหม่ `rpc_save_std_drawing` (p_id ว่าง = เพิ่มใหม่ · มี = แก้) รับ **รายการไฟล์ทั้งชุด**
--   ที่ต้องเหลือหลังบันทึก → เพิ่ม/ลบไฟล์รายตัวได้ในโมดัลเดียว · คืน id
--   ⚠️ ไม่แตะ rpc_create/update_std_drawing ของ 0045 (client รุ่นเก่าช่วงรอ push ยังเรียกได้)
--
-- คอลัมน์เดิม file_url / file_name **คงไว้เป็นกระจก = ไฟล์แรกของ files**
--   → client รุ่นเก่ายังเห็นไฟล์แรก · client ใหม่ถ้า files ว่างแต่มี file_url (แถวที่ client เก่า
--     สร้างหลังรัน SQL นี้แต่ก่อน push) จะอ่าน file_url เป็นไฟล์เดียวแทน (remote.ts mapStdDrawing)
--
-- ไฟล์ที่เอาออกจากรายการ **ไม่ถูกลบจาก Storage** (มติ 0045) · audit เก็บชื่อ + URL ไว้ย้อนดู
--
-- demo sync ที่ src/data/logic.ts (createStdDrawing / updateStdDrawing / stdDrawingFiles)
-- รันหลัง 0077 · idempotent · **ต้องรันก่อน push** (โมดัลใหม่เรียก rpc_save_std_drawing)
-- =============================================================================

-- ---------- 1) คอลัมน์ + ย้ายไฟล์เดิมเข้า files ----------
ALTER TABLE std_drawings ADD COLUMN IF NOT EXISTS files JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN std_drawings.files IS
  '0078 — PDF หลายไฟล์ [{url, name, size}] · file_url/file_name = กระจกของไฟล์แรก (compat client เก่า)';

UPDATE std_drawings
   SET files = jsonb_build_array(jsonb_build_object(
         'url', file_url, 'name', COALESCE(file_name, 'drawing.pdf')))
 WHERE file_url IS NOT NULL AND files = '[]'::jsonb;

-- ---------- 2) RPC บันทึกหัวข้อ + รายการไฟล์ทั้งชุด ----------
CREATE OR REPLACE FUNCTION rpc_save_std_drawing(
  p_id UUID, p_title TEXT, p_drawing_no TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_files JSONB DEFAULT '[]'::jsonb, p_rev_note TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor profiles; d std_drawings; v_id UUID; v_files JSONB := '[]'::jsonb; f JSONB;
  v_url TEXT; v_name TEXT; v_no TEXT; added TEXT; removed TEXT;
BEGIN
  actor := app_assert_standards();
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'กรุณาระบุหัวข้อ/ชื่อ Drawing'; END IF;
  IF p_files IS NOT NULL AND jsonb_typeof(p_files) <> 'array' THEN
    RAISE EXCEPTION 'รูปแบบรายการไฟล์ไม่ถูกต้อง';
  END IF;
  IF jsonb_array_length(COALESCE(p_files, '[]'::jsonb)) > 30 THEN
    RAISE EXCEPTION 'แนบได้ไม่เกิน 30 ไฟล์ต่อ Drawing';
  END IF;

  -- เก็บเฉพาะ key ที่รู้จัก · url + name ต้องไม่ว่าง
  FOR f IN SELECT * FROM jsonb_array_elements(COALESCE(p_files, '[]'::jsonb)) LOOP
    v_url  := NULLIF(btrim(COALESCE(f->>'url', '')), '');
    v_name := NULLIF(btrim(COALESCE(f->>'name', '')), '');
    IF v_url IS NULL OR v_name IS NULL THEN RAISE EXCEPTION 'ไฟล์แนบต้องมีทั้งชื่อและที่อยู่ไฟล์'; END IF;
    v_files := v_files || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object('url', v_url, 'name', v_name,
        'size', CASE WHEN jsonb_typeof(f->'size') = 'number' THEN f->'size' END)));
  END LOOP;

  v_no := NULLIF(btrim(COALESCE(p_drawing_no, '')), '');

  IF p_id IS NULL THEN
    INSERT INTO std_drawings (title, drawing_no, description, files, file_url, file_name, created_by, updated_by)
    VALUES (btrim(p_title), v_no, NULLIF(btrim(COALESCE(p_description, '')), ''),
            v_files, v_files->0->>'url', v_files->0->>'name', actor.id, actor.id)
    RETURNING id INTO v_id;
    PERFORM app_audit('std_drawing', v_id, 'create_std_drawing', actor.id,
      'เพิ่ม Standard Drawing "' || btrim(p_title) || '"' ||
      CASE WHEN jsonb_array_length(v_files) > 0
        THEN ' · ไฟล์ ' || (SELECT string_agg(x->>'name', ', ') FROM jsonb_array_elements(v_files) x)
        ELSE ' · ยังไม่แนบไฟล์' END);
    RETURN v_id;
  END IF;

  SELECT * INTO d FROM std_drawings WHERE id = p_id FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Drawing นี้'; END IF;

  -- diff ตาม URL · ไฟล์ที่เอาออกเก็บ URL ไว้ใน audit (ไม่ลบ object ใน Storage ตามมติ 0045)
  SELECT string_agg(n->>'name', ', ') INTO added FROM jsonb_array_elements(v_files) n
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.files) o WHERE o->>'url' = n->>'url');
  SELECT string_agg((o->>'name') || ' [' || (o->>'url') || ']', ', ') INTO removed
    FROM jsonb_array_elements(d.files) o
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_files) n WHERE n->>'url' = o->>'url');

  UPDATE std_drawings SET
    title       = btrim(p_title),
    drawing_no  = v_no,
    description = NULLIF(btrim(COALESCE(p_description, '')), ''),
    files       = v_files,
    file_url    = v_files->0->>'url',
    file_name   = v_files->0->>'name',
    rev_note    = NULLIF(btrim(COALESCE(p_rev_note, '')), ''),
    updated_by  = actor.id,
    updated_at  = now()
  WHERE id = p_id;

  PERFORM app_audit('std_drawing', p_id, 'update_std_drawing', actor.id,
    'แก้ Standard Drawing "' || d.title || '" → "' || btrim(p_title) || '"' ||
    CASE WHEN added IS NULL AND removed IS NULL THEN ' · ไฟล์เดิม' ELSE '' END ||
    CASE WHEN added   IS NOT NULL THEN ' · เพิ่มไฟล์: ' || added ELSE '' END ||
    CASE WHEN removed IS NOT NULL THEN ' · เอาไฟล์ออก: ' || removed ELSE '' END ||
    CASE WHEN NULLIF(btrim(COALESCE(p_rev_note, '')), '') IS NOT NULL
      THEN ' · หมายเหตุ: ' || btrim(p_rev_note) ELSE '' END);
  RETURN p_id;
END $$;

-- ลบทั้ง Drawing — ข้อความ audit นับไฟล์จาก files (เดิมอ่าน file_name ตัวเดียว)
CREATE OR REPLACE FUNCTION rpc_delete_std_drawing(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor profiles; d std_drawings;
BEGIN
  actor := app_assert_standards();
  SELECT * INTO d FROM std_drawings WHERE id = p_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'ไม่พบ Drawing นี้'; END IF;
  DELETE FROM std_drawings WHERE id = p_id;
  PERFORM app_audit('std_drawing', p_id, 'delete_std_drawing', actor.id,
    'ลบ Standard Drawing "' || d.title || '" (ไฟล์ ' ||
    COALESCE((SELECT string_agg(x->>'name', ', ') FROM jsonb_array_elements(d.files) x), '-') ||
    ' ยังอยู่ใน Storage)');
END $$;

REVOKE ALL ON FUNCTION public.rpc_save_std_drawing(UUID, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_save_std_drawing(UUID, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;

-- ---------- 3) ตรวจผล ----------
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'std_drawings' AND column_name = 'files';
  IF n <> 1 THEN RAISE EXCEPTION '0078: ไม่มีคอลัมน์ std_drawings.files'; END IF;

  -- แถวที่มีไฟล์เดิมต้องย้ายเข้า files ครบ ไม่งั้นโมดัลแก้ไขจะไม่เห็นไฟล์เดิม แล้วบันทึกทับเป็นว่าง
  SELECT count(*) INTO n FROM std_drawings WHERE file_url IS NOT NULL AND files = '[]'::jsonb;
  IF n > 0 THEN RAISE EXCEPTION '0078: ยังมี % แถวที่ไฟล์เดิมไม่ได้ย้ายเข้า files', n; END IF;

  IF NOT has_function_privilege('authenticated',
        'public.rpc_save_std_drawing(UUID, TEXT, TEXT, TEXT, JSONB, TEXT)', 'EXECUTE') THEN
    RAISE EXCEPTION '0078: authenticated เรียก rpc_save_std_drawing ไม่ได้';
  END IF;

  RAISE NOTICE '0078: OK — Standard Drawing แนบ PDF ได้หลายไฟล์';
END $$;
