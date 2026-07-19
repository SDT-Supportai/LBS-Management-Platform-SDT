-- =====================================================================
-- ลบ/ปิดบัญชีทดสอบ E2E อย่างปลอดภัย (2026-07-19)
-- ต่างจาก cleanup_e2e.sql (ที่ลบ transaction ทั้งหมด — ใช้ได้เฉพาะตอนยังไม่มีข้อมูลจริง):
-- สคริปต์นี้แตะเฉพาะ "บัญชี" — รันได้แม้ production มีข้อมูลจริงแล้ว
-- =====================================================================

-- A) ตรวจก่อน: ดูว่ามีข้อมูลอะไรในระบบ + บัญชีทดสอบไหนยังอยู่
SELECT 'jobs' AS what, count(*)::TEXT AS n, string_agg(job_no, ', ') AS detail FROM jobs
UNION ALL SELECT 'project_stocks', count(*)::TEXT, string_agg(stock_no, ', ') FROM project_stocks
UNION ALL SELECT 'บัญชีทดสอบที่ยังอยู่', count(*)::TEXT, string_agg(email || ' (' || department || CASE WHEN is_active THEN ', เปิดใช้' ELSE ', ปิดแล้ว' END || ')', ' · ')
  FROM profiles WHERE email IN
  ('e2e-runner@example.org', 'e2e.tester.lbs@gmail.com', 'e2e-admin@example.com', 'fn-test-sales@example.org');

-- B) ปิดใช้งานบัญชีทดสอบทันที (ปลอดภัยเสมอ — login ไม่ได้ + RPC ปฏิเสธผ่าน app_assert_dept)
UPDATE profiles SET is_active = false, department = 'service'
WHERE email IN
  ('e2e-runner@example.org', 'e2e.tester.lbs@gmail.com', 'e2e-admin@example.com', 'fn-test-sales@example.org');

-- C) พยายามลบทีละบัญชี — ตัวที่ยังถูกอ้างถึงในข้อมูล (audit_logs/jobs/allocations)
--    จะลบไม่ได้และถูกข้าม (คงสถานะ "ปิดใช้งาน" จากข้อ B ไว้ ไม่กระทบข้อมูล)
--    ลบพวกนั้นได้ภายหลังเมื่อรัน cleanup_e2e.sql (ตอนพร้อมล้าง transaction ทดสอบทั้งหมด)
DO $$
DECLARE u RECORD;
BEGIN
  FOR u IN SELECT p.id, p.email FROM profiles p WHERE p.email IN
    ('e2e-runner@example.org', 'e2e.tester.lbs@gmail.com', 'e2e-admin@example.com', 'fn-test-sales@example.org')
  LOOP
    BEGIN
      DELETE FROM auth.users WHERE id = u.id;   -- cascade → profiles/notification_reads
      RAISE NOTICE 'ลบ % สำเร็จ', u.email;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE '%: ยังถูกอ้างถึงใน audit/jobs — ปิดใช้งานแทน (ลบได้หลังล้างข้อมูลทดสอบ)', u.email;
    END;
  END LOOP;
END $$;

-- D) ตรวจผล: ควรเหลือ 0 แถว หรือเหลือเฉพาะตัวที่ is_active = false
SELECT email, department, is_active FROM profiles
WHERE email IN
  ('e2e-runner@example.org', 'e2e.tester.lbs@gmail.com', 'e2e-admin@example.com', 'fn-test-sales@example.org');
