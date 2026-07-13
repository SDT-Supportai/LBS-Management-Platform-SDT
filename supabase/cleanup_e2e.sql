-- =====================================================================
-- ล้างข้อมูลทดสอบ E2E ทั้งหมด → เริ่มใช้งานจริงด้วยฐานข้อมูลสะอาด
-- รันตอน "ก่อนเปิดใช้งานจริง" ครั้งเดียว (ลบ transaction ทุกอย่าง เก็บ master data ไว้)
-- ลำดับ delete เรียงตาม FK แล้ว ห้ามสลับ
-- =====================================================================

-- 1) transaction ทั้งหมด (ตอนนี้มีแต่ข้อมูลทดสอบ)
DELETE FROM notification_reads;
DELETE FROM notifications;
DELETE FROM stock_allocations;
DELETE FROM job_accessory_requests;
DELETE FROM purchase_orders;
DELETE FROM purchase_requisitions;
DELETE FROM lbs_units;      -- ลบ LBS ทดสอบ (E2E-xxxx) — ของจริงให้ Sales รับเข้าผ่านแอป
DELETE FROM jobs;
DELETE FROM audit_logs;

-- 2) คืนยอดสต็อกกลาง accessory เป็นค่าตั้งต้น + ลบ row ที่เกิดจากการทดสอบ
UPDATE accessory_stock SET qty_on_hand = 20
 WHERE item_id = (SELECT id FROM items WHERE code = 'ACC-CT-01');
UPDATE accessory_stock SET qty_on_hand = 15
 WHERE item_id = (SELECT id FROM items WHERE code = 'ACC-BRK-01');
DELETE FROM accessory_stock
 WHERE item_id NOT IN (SELECT id FROM items WHERE code IN ('ACC-CT-01', 'ACC-BRK-01'));

-- 3) จัดการบัญชีทดสอบ (ทำหลังจากสร้างบัญชี admin จริงของคุณแล้วเท่านั้น!)
--    3.1 สร้างบัญชีจริง: Authentication → Add user (Auto Confirm) แล้วรัน:
--        UPDATE profiles SET department = 'admin', full_name = 'ชื่อจริงของคุณ'
--        WHERE email = 'your-real@email.com';
--    3.2 ปิดบัญชีทดสอบที่เคยเป็น admin (รหัสผ่านของมันเปิดเผยในแชท — ต้องปิด):
--        UPDATE profiles SET department = 'service', is_active = false
--        WHERE email = 'e2e-runner@example.org';
--    3.3 ลบ user ทดสอบที่ค้าง (ไม่มี profile ผูก job ใดๆ):
--        DELETE FROM auth.users WHERE email IN
--          ('e2e.tester.lbs@gmail.com', 'e2e-admin@example.com', 'e2e-runner@example.org');
--        (ลบ e2e-runner ได้เมื่อรัน cleanup ข้อ 1 แล้ว เพราะ audit/jobs ที่อ้างถึงถูกลบหมด)

-- 4) (ถ้าต้องการ) เริ่มเลข Stock ใหม่: ลบคลังตัวอย่างแล้วให้ Sales สร้างเอง
-- DELETE FROM project_stocks;
