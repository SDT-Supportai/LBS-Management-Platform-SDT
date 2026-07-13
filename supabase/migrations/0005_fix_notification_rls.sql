-- =====================================================================
-- 0005: แก้ bug notifications อ่านไม่เห็น (เจอจาก E2E บน DB จริง)
-- ตอนเพิ่มตาราง notifications / notification_reads เข้า 0001 ทีหลัง
-- ลืมใส่ RLS policy -> app_notify (SECURITY DEFINER) insert ลงได้ แต่
-- role authenticated อ่านไม่เห็น (RLS default deny) -> UI ขึ้น 0 เสมอ
-- แก้: เปิด RLS + ใส่ policy อ่าน/เขียนให้ผู้ใช้ที่ login แล้ว
-- รันซ้ำได้ปลอดภัย (drop policy ก่อน create)
-- =====================================================================

ALTER TABLE notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_all       ON notifications;
DROP POLICY IF EXISTS notif_insert   ON notifications;
DROP POLICY IF EXISTS reads_read_all ON notification_reads;
DROP POLICY IF EXISTS reads_insert   ON notification_reads;

CREATE POLICY read_all       ON notifications      FOR SELECT TO authenticated USING (true);
CREATE POLICY notif_insert   ON notifications      FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY reads_read_all ON notification_reads FOR SELECT TO authenticated USING (true);
CREATE POLICY reads_insert   ON notification_reads FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
