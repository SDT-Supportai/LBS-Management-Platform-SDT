-- =====================================================================
-- 115kV LBS Project Stock & Job Workflow — Supabase schema (Phase 2)
-- ปรับจาก lbs_stock_schema.sql เดิม: track LBS รายเครื่อง (Serial No.)
-- + เพิ่ม Purchase Requisition (PR) เป็น entity แยก + RLS ตามแผนก
-- =====================================================================

-- ---------- Profiles (ผูกกับ Supabase auth.users) ----------
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       VARCHAR(255) UNIQUE NOT NULL,
  full_name   VARCHAR(255) NOT NULL,
  department  VARCHAR(30) NOT NULL CHECK (department IN ('sales','project','purchasing','service','admin')),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(100) UNIQUE NOT NULL,
  name          VARCHAR(255) NOT NULL,
  item_type     VARCHAR(20) NOT NULL CHECK (item_type IN ('main_equipment','accessory')),
  uom           VARCHAR(20) DEFAULT 'set',
  spec          TEXT,
  is_stockable_centrally BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE suppliers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(50) UNIQUE NOT NULL,
  name          VARCHAR(255) NOT NULL,
  contact_name  VARCHAR(255),
  phone         VARCHAR(50),
  email         VARCHAR(255),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- Project Stock + LBS รายเครื่อง ----------
CREATE TABLE project_stocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_no    VARCHAR(50) UNIQUE NOT NULL,
  item_id     UUID REFERENCES items(id),
  status      VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes       TEXT,
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- แต่ละเครื่องมี Serial No. → trace ได้ว่าเครื่องไหนอยู่ Job/ไซต์ไหน
CREATE TABLE lbs_units (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_no        VARCHAR(100) UNIQUE NOT NULL,
  project_stock_id UUID NOT NULL REFERENCES project_stocks(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'in_stock'
                     CHECK (status IN ('in_stock','allocated','issued')),
  job_id           UUID,   -- FK ใส่หลังสร้างตาราง jobs
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- Jobs ----------
CREATE TABLE jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_no           VARCHAR(50) UNIQUE NOT NULL,
  customer_name    VARCHAR(255) NOT NULL,
  scope            TEXT,
  install_location TEXT,
  required_date    DATE,
  lbs_qty_required INT NOT NULL CHECK (lbs_qty_required > 0),
  -- lifecycle marker; สถานะระหว่างทาง derive จาก view ด้านล่าง
  -- issued = เบิกแล้วรอติดตั้ง (ล็อก allocation), installed = Service ยืนยันแล้ว (terminal)
  terminal_status  VARCHAR(30) CHECK (terminal_status IN ('issued','installed','cancelled')),
  opened_by        UUID REFERENCES profiles(id),
  issued_at        TIMESTAMPTZ,
  issued_note      TEXT,
  installed_at     DATE,
  install_note     TEXT,
  install_confirmed_by UUID REFERENCES profiles(id),
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     UUID REFERENCES profiles(id),
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE lbs_units
  ADD CONSTRAINT fk_lbs_units_job FOREIGN KEY (job_id) REFERENCES jobs(id);

-- ประวัติดึง/คืน (return: ผู้ใช้เลือก stock ปลายทางเอง ไม่ auto FIFO)
CREATE TABLE stock_allocations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID NOT NULL REFERENCES jobs(id),
  project_stock_id UUID NOT NULL REFERENCES project_stocks(id),
  txn_type         VARCHAR(10) NOT NULL CHECK (txn_type IN ('draw','return')),
  serial_nos       TEXT[] NOT NULL,
  performed_by     UUID REFERENCES profiles(id),
  performed_at     TIMESTAMPTZ DEFAULT NOW(),
  reference_note   TEXT
);

-- ---------- PR / PO ----------
CREATE TABLE purchase_requisitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_no         VARCHAR(50) UNIQUE NOT NULL,
  job_id        UUID NOT NULL REFERENCES jobs(id),
  status        VARCHAR(30) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','po_issued','received','rejected','cancelled')),
  reject_reason TEXT,
  rejected_at   TIMESTAMPTZ,
  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE purchase_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no         VARCHAR(50) UNIQUE NOT NULL,
  pr_id         UUID NOT NULL REFERENCES purchase_requisitions(id),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  supplier_id   UUID REFERENCES suppliers(id),
  supplier_name VARCHAR(255),
  status        VARCHAR(30) NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','received','cancelled')),
  order_date    DATE DEFAULT CURRENT_DATE,
  expected_date DATE,
  received_at   TIMESTAMPTZ,
  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- Accessory ----------
CREATE TABLE accessory_stock (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID UNIQUE NOT NULL REFERENCES items(id),
  qty_on_hand DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE job_accessory_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  item_id       UUID NOT NULL REFERENCES items(id),
  qty_requested DECIMAL(10,2) NOT NULL CHECK (qty_requested > 0),
  qty_received  DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),  -- partial receive
  source        VARCHAR(20) NOT NULL CHECK (source IN ('central_stock','purchasing')),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','issued','pr_sent','po_ordered','received','returned','cancelled')),
  pr_id         UUID REFERENCES purchase_requisitions(id),
  requested_by  UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- Audit ----------
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(50) NOT NULL,
  entity_id   UUID NOT NULL,
  action      VARCHAR(100) NOT NULL,
  actor_id    UUID REFERENCES profiles(id),
  detail      TEXT,
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- Notifications (ข้ามแผนก + คิวส่ง LINE) ----------
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        VARCHAR(50) NOT NULL,
  message     TEXT NOT NULL,
  dept        VARCHAR(30) NOT NULL,            -- sales/project/purchasing/service/admin/all
  job_id      UUID REFERENCES jobs(id),
  line_status VARCHAR(10) NOT NULL DEFAULT 'off' CHECK (line_status IN ('off','pending','sent','failed')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE notification_reads (
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES profiles(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

-- ---------- Guard: ห้ามแก้ unit ของ Job ที่ issued แล้ว ----------
CREATE OR REPLACE FUNCTION fn_block_issued_job_edit() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.job_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM jobs WHERE id = OLD.job_id AND terminal_status IN ('issued','installed')) THEN
      RAISE EXCEPTION 'Job % is issued/installed — allocation is locked', OLD.job_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_issued_edit
BEFORE UPDATE ON lbs_units
FOR EACH ROW EXECUTE FUNCTION fn_block_issued_job_edit();

-- ---------- View: derive job status อัตโนมัติ ----------
CREATE VIEW v_job_status AS
SELECT
  j.id AS job_id,
  j.job_no,
  CASE
    WHEN j.terminal_status IS NOT NULL THEN j.terminal_status
    WHEN alloc.cnt >= j.lbs_qty_required AND COALESCE(pend.cnt, 0) = 0 THEN 'ready_to_issue'
    WHEN alloc.cnt > 0 AND COALESCE(pend.cnt, 0) > 0 THEN 'procuring_accessory'
    WHEN alloc.cnt > 0 THEN 'allocated'
    ELSE 'draft'
  END AS status,
  COALESCE(alloc.cnt, 0) AS lbs_allocated,
  j.lbs_qty_required
FROM jobs j
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS cnt FROM lbs_units u
  WHERE u.job_id = j.id AND u.status = 'allocated'
) alloc ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS cnt FROM job_accessory_requests r
  WHERE r.job_id = j.id AND r.status NOT IN ('issued','received','cancelled','returned')
) pend ON true;

-- ---------- Indexes ----------
CREATE INDEX idx_lbs_units_stock   ON lbs_units(project_stock_id);
CREATE INDEX idx_lbs_units_job     ON lbs_units(job_id);
CREATE INDEX idx_lbs_units_status  ON lbs_units(status);
CREATE INDEX idx_alloc_job         ON stock_allocations(job_id);
CREATE INDEX idx_acc_req_job       ON job_accessory_requests(job_id);
CREATE INDEX idx_pr_status         ON purchase_requisitions(status);
CREATE INDEX idx_po_status         ON purchase_orders(status);
CREATE INDEX idx_audit_entity      ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_created     ON audit_logs(created_at DESC);

-- ---------- RLS (สิทธิ์ตามแผนก — mirror จาก PERMISSIONS ใน frontend) ----------
ALTER TABLE profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE items                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_stocks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lbs_units              ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_allocations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requisitions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE accessory_stock        ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_accessory_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads     ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION my_department() RETURNS TEXT AS $$
  SELECT department FROM profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ทุกแผนกอ่านได้ (ระบบภายใน) — เขียนได้ตามหน้าที่
CREATE POLICY read_all ON profiles               FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON items                  FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON suppliers              FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON project_stocks         FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON lbs_units              FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON jobs                   FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON stock_allocations      FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON purchase_requisitions  FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON purchase_orders        FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON accessory_stock        FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON job_accessory_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON audit_logs             FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON notifications          FOR SELECT TO authenticated USING (true);
CREATE POLICY read_all ON notification_reads     FOR SELECT TO authenticated USING (true);

-- Sales: จัดการ Project Stock + รับ LBS เข้า
CREATE POLICY sales_write ON project_stocks FOR ALL TO authenticated
  USING (my_department() IN ('sales','admin')) WITH CHECK (my_department() IN ('sales','admin'));
CREATE POLICY sales_insert_units ON lbs_units FOR INSERT TO authenticated
  WITH CHECK (my_department() IN ('sales','admin'));

-- Project: จัดการ Job / ดึง-คืน / Accessory request / PR
CREATE POLICY project_jobs ON jobs FOR ALL TO authenticated
  USING (my_department() IN ('project','admin')) WITH CHECK (my_department() IN ('project','admin'));
CREATE POLICY project_units_update ON lbs_units FOR UPDATE TO authenticated
  USING (my_department() IN ('project','admin'));
CREATE POLICY project_alloc ON stock_allocations FOR INSERT TO authenticated
  WITH CHECK (my_department() IN ('project','admin'));
CREATE POLICY project_acc ON job_accessory_requests FOR ALL TO authenticated
  USING (my_department() IN ('project','admin')) WITH CHECK (my_department() IN ('project','admin'));
CREATE POLICY project_acc_stock ON accessory_stock FOR UPDATE TO authenticated
  USING (my_department() IN ('project','admin'));
CREATE POLICY project_pr ON purchase_requisitions FOR ALL TO authenticated
  USING (my_department() IN ('project','admin')) WITH CHECK (my_department() IN ('project','admin'));

-- Purchasing: จัดการ PO + อัพเดทสถานะ PR/รับของ
CREATE POLICY purchasing_po ON purchase_orders FOR ALL TO authenticated
  USING (my_department() IN ('purchasing','admin')) WITH CHECK (my_department() IN ('purchasing','admin'));
CREATE POLICY purchasing_pr_update ON purchase_requisitions FOR UPDATE TO authenticated
  USING (my_department() IN ('purchasing','admin'));
CREATE POLICY purchasing_acc_update ON job_accessory_requests FOR UPDATE TO authenticated
  USING (my_department() IN ('purchasing','admin'));

-- Audit: ทุกคน insert ได้ แต่ห้ามแก้/ลบ (ไม่มี UPDATE/DELETE policy)
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO authenticated WITH CHECK (true);

-- Notifications: ทุกคนที่ login อ่าน/insert ได้ (mark-read insert เฉพาะของตัวเอง)
CREATE POLICY notif_insert ON notifications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY reads_insert ON notification_reads FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
