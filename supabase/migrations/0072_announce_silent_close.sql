-- =============================================================================
-- 0072 — 🔔 ใบที่ปิดเงียบต้องประกาศให้ Service รู้ (2026-09-16)
--
-- 0063 (มติ 2026-08-28) ย้ายการประกาศ "เบิกครบทั้งใบแล้ว" ออกจาก app_finalize_issue
--   ไปเป็น**หางต่อท้ายข้อความของ action ที่ทำให้ครบ** เพื่อกันกลุ่ม LINE ได้ 2 ใบติดกัน
--   เรื่องเดียวกัน ("🚚 เบิก LBS 2 เครื่อง…" แล้วตามด้วย "🚚 เบิกของครบทั้งใบแล้ว…")
--   ใช้ได้ดีตราบใดที่ตัวปิดใบมีแต่ app_exec_issue_lbs / app_exec_issue_accessory
--
-- แต่ตั้งแต่ 0067/0068/0070 มี action ที่**ปิดใบได้ทั้งที่ไม่ได้ "เบิก" อะไรเลย**:
--   📦 rpc_transfer_job_material_to_stock  → ยิง stock_transfer_in หา **project**
--   ✂️ rpc_write_off_job_material          → **ไม่ยิงอะไรเลย** มีแต่ Audit
--   ✏️ rpc_adjust_po_line                  → ยิง po_line_adjusted หา **project**
-- ทั้งสามไม่มีข้อความถึง Service เลย ⇒ ใบพลิกเป็น Issued เงียบ ๆ
-- ทั้งที่**นาทีนั้นคือนาทีที่งานโผล่เข้าคิวหน้า Service ครั้งแรก** (ยิ่งชัดหลัง 0071
-- ที่ทำให้พาเนล "เบิกแล้ว — รอติดตั้ง" รับงานเข้ามา) — ไม่มีอะไรบอกทีมช่างว่าออกไซต์ได้แล้ว
--
-- วิธีแก้: ไม่แตะ app_finalize_issue (มีผู้เรียก 5 ที่ และ 2 ที่ต้องเงียบต่อไป)
--   เพิ่ม wrapper app_finalize_issue_loud ที่ตรวจ "ใบเพิ่งพลิกเป็น issued ไหม" แล้วประกาศ
--   จากนั้น swap เฉพาะ 3 RPC ข้างบนให้เรียก wrapper แทน — บรรทัดเดียวต่อฟังก์ชัน idempotent
--
-- 🔴 ห้าม swap app_exec_issue_lbs / app_exec_issue_accessory — สองตัวนั้นเติมหาง
--    " · ครบทั้งใบแล้ว" ในข้อความของตัวเองอยู่แล้ว ถ้า swap ด้วยจะกลับไปเป็น 2 ใบซ้ำ
--    ซึ่งคือบั๊กที่ 0063 แก้ไป · มี DO block เฝ้าไว้ท้ายไฟล์
--
-- type ใหม่ `job_ready_to_install` เข้า allowlist LINE (0066) — ปีละไม่กี่ใบ ไม่กินโควตา
--   และเป็นชนิดที่ "บล็อกงานคนอื่นอยู่" ตรงเกณฑ์เดียวกับ lbs_issued_to_service
--
-- ไม่เปลี่ยน signature ของเดิม ⇒ **รันก่อนหรือหลัง push ก็ได้**
-- =============================================================================

-- ---------- 1) allowlist LINE + type ใหม่ ----------
-- ⚠️ รายชื่อนี้ต้องตรงกับ LINE_PUSH_TYPES ใน src/data/logic.ts เสมอ (คนละ runtime กติกาเดียวกัน)
CREATE OR REPLACE FUNCTION app_notify(ntype TEXT, msg TEXT, ndept TEXT, jid UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (type, message, dept, job_id, line_status)
  VALUES (ntype, msg, ndept, jid,
    CASE WHEN ntype IN (
      'pr_created',                  -- Purchasing ต้องออก PO ต่อ
      'pr_rejected',                 -- Project ต้องแก้แล้วส่งใหม่
      'approval_requested',          -- Division ต้องตัดสิน งานค้างทั้งสายจนกว่าจะกด
      'approval_rejected',           -- Project ต้องแก้แล้วขอใหม่
      'po_received',                 -- เฉพาะรับครบ · รับบางส่วนใช้ type po_received_partial
      'lbs_issued_to_service',       -- ทีมช่างต้องเตรียมออกหน้างาน
      'accessory_issued_to_service', -- ของชุดไหนถึงมือทีมช่างแล้ว
      'install_failed',              -- Project ต้องเข้าไปแก้ให้ทีมเดินต่อได้
      'job_cancelled',               -- ทุกแผนกต้องหยุดทำงานกับใบนี้ทันที
      'job_ready_to_install'         -- 0072 — ใบครบเพราะโอนคืน/ตัดจำหน่าย/แก้จำนวน ไม่ใช่เพราะการเบิก
    ) THEN 'pending' ELSE 'off' END);
$$;

-- ---------- 2) wrapper: ปิดใบแล้วประกาศ ----------
-- ตรวจที่ "สถานะก่อน/หลัง" ไม่ใช่เดาจากเงื่อนไขซ้ำ — app_finalize_issue เป็นคนตัดสินคนเดียว
-- ว่าปิดได้ไหม เขียนเงื่อนไขซ้ำที่นี่จะหลุดกันทันทีที่ตัวนั้นเปลี่ยนกติกา
CREATE OR REPLACE FUNCTION app_finalize_issue_loud(actor profiles, p_job_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE before_st TEXT; j jobs; rng TEXT;
BEGIN
  SELECT terminal_status INTO before_st FROM jobs WHERE id = p_job_id;
  PERFORM app_finalize_issue(actor, p_job_id);
  SELECT * INTO j FROM jobs WHERE id = p_job_id;
  IF before_st IS DISTINCT FROM 'issued' AND j.terminal_status = 'issued' THEN
    rng := CASE WHEN j.install_start_date = j.install_end_date
                THEN COALESCE(j.install_start_date::TEXT, '-')
                ELSE COALESCE(j.install_start_date::TEXT, '-') || ' – ' || COALESCE(j.install_end_date::TEXT, '-') END;
    PERFORM app_notify('job_ready_to_install',
      '🔧 ' || j.job_no || ' ของครบทั้งใบแล้ว — เข้าติดตั้งได้ · ' || rng,
      'service', p_job_id);
  END IF;
END $$;

COMMENT ON FUNCTION app_finalize_issue_loud(profiles, UUID) IS
  '0072 — ใช้แทน app_finalize_issue เฉพาะผู้เรียกที่ไม่มีข้อความแจ้งเตือนของตัวเองถึง Service '
  '(โอนคืนคลัง · ตัดจำหน่าย · แก้จำนวนใน PO) · ห้ามใช้กับ app_exec_issue_* ซึ่งเติมหางเองอยู่แล้ว';

-- ---------- 3) ย้าย 3 RPC ที่ปิดใบเงียบมาใช้ wrapper ----------
DO $$
BEGIN
  PERFORM app_swap_guard('rpc_transfer_job_material_to_stock',
    'PERFORM app_finalize_issue(actor, r.job_id);', 'PERFORM app_finalize_issue_loud(actor, r.job_id);');
  PERFORM app_swap_guard('rpc_write_off_job_material',
    'PERFORM app_finalize_issue(actor, r.job_id);', 'PERFORM app_finalize_issue_loud(actor, r.job_id);');
  PERFORM app_swap_guard('rpc_adjust_po_line',
    'PERFORM app_finalize_issue(actor, r.job_id);', 'PERFORM app_finalize_issue_loud(actor, r.job_id);');
END $$;

-- 🔴 helper ภายใน ห้ามเปิดให้ client เรียกตรง — เป็น SECURITY DEFINER ที่ "ปิดใบงาน" ได้
--   Postgres ให้ EXECUTE กับ PUBLIC เป็นค่า default ของฟังก์ชันใหม่ ⇒ ถ้าไม่ถอน ใครที่ login
--   อยู่ก็ยิง RPC นี้ตรง ๆ พร้อมแถว profiles ของใครก็ได้ แล้วบังคับปิดใบข้าม RLS ได้ทันที
--   (กติกาเดียวกับ app_line_bind ใน 0033) · ผู้เรียกจริงเป็น SECURITY DEFINER จึงยังเรียกได้ปกติ
REVOKE ALL ON FUNCTION public.app_finalize_issue_loud(profiles, UUID) FROM PUBLIC, authenticated, anon;

-- ---------- 4) ตรวจผล — ต้องผ่านทุกข้อ ไม่งั้น RAISE ----------
DO $$
DECLARE src TEXT; fn TEXT;
BEGIN
  -- 4.1 type ใหม่ต้องเข้า allowlist จริง
  SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'app_notify';
  IF position('job_ready_to_install' IN src) = 0 THEN
    RAISE EXCEPTION '0072: app_notify ไม่มี job_ready_to_install ใน allowlist — ข้อความจะไม่เข้าคิว LINE';
  END IF;
  -- allowlist เดิมต้องครบเหมือนเดิม (กันพิมพ์ใหม่แล้วตกหล่น)
  FOREACH fn IN ARRAY ARRAY['pr_created', 'pr_rejected', 'approval_requested', 'approval_rejected',
                            'po_received', 'lbs_issued_to_service', 'accessory_issued_to_service',
                            'install_failed', 'job_cancelled'] LOOP
    IF position(fn IN src) = 0 THEN
      RAISE EXCEPTION '0072: app_notify ตกชนิด % ออกจาก allowlist ของ 0066', fn;
    END IF;
  END LOOP;

  -- 4.2 3 RPC ที่ปิดใบเงียบต้องใช้ wrapper แล้ว
  FOREACH fn IN ARRAY ARRAY['rpc_transfer_job_material_to_stock', 'rpc_write_off_job_material',
                            'rpc_adjust_po_line'] LOOP
    SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = fn;
    IF src IS NULL THEN RAISE EXCEPTION '0072: ไม่พบฟังก์ชัน %', fn; END IF;
    IF position('app_finalize_issue_loud' IN src) = 0 THEN
      RAISE EXCEPTION '0072: % ยังปิดใบเงียบอยู่ (ไม่ได้เรียก app_finalize_issue_loud)', fn;
    END IF;
  END LOOP;

  -- 4.3 🔴 ตัวที่เติมหางเองอยู่แล้วต้องไม่ถูกแตะ — ไม่งั้นกลุ่มได้ 2 ใบซ้ำ = บั๊กที่ 0063 แก้ไป
  FOREACH fn IN ARRAY ARRAY['app_exec_issue_lbs', 'app_exec_issue_accessory'] LOOP
    SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') INTO src
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = fn;
    IF src IS NULL THEN RAISE EXCEPTION '0072: ไม่พบฟังก์ชัน %', fn; END IF;
    IF position('app_finalize_issue_loud' IN src) > 0 THEN
      RAISE EXCEPTION '0072: % ไปเรียก wrapper ด้วย — กลุ่มจะได้ 2 ข้อความเรื่องเดียวกัน (0063 แก้ไปแล้ว)', fn;
    END IF;
  END LOOP;

  -- 4.4 wrapper ต้องไม่ถูกเรียกตรงจาก client ได้ (ปิดใบงานข้าม RLS)
  IF has_function_privilege('authenticated', 'public.app_finalize_issue_loud(profiles, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.app_finalize_issue_loud(profiles, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0072: app_finalize_issue_loud ยังเรียกตรงได้ — ใครที่ login อยู่จะบังคับปิดใบงานได้';
  END IF;

  RAISE NOTICE '0072: OK — ใบที่ปิดด้วยการโอนคืน/ตัดจำหน่าย/แก้จำนวน PO ประกาศถึง Service แล้ว';
  RAISE NOTICE '  การเบิก (app_exec_issue_*) ยังเติมหาง " · ครบทั้งใบแล้ว" ในข้อความตัวเองเหมือนเดิม';
END $$;
