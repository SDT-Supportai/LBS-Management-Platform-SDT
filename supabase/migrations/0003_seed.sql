-- =====================================================================
-- 0003: Seed ข้อมูลตั้งต้น (master items + คลังตัวอย่าง)
-- หมายเหตุ: ผู้ใช้สร้างผ่าน Supabase Auth (Dashboard → Authentication → Add user)
--   แล้ว trigger จะสร้างแถวใน profiles ให้อัตโนมัติ — ตั้งแผนกด้วย:
--   UPDATE profiles SET department = 'sales' WHERE email = 'sales@yourco.com';
-- =====================================================================

INSERT INTO items (code, name, item_type, uom, is_stockable_centrally) VALUES
  ('LBS-115KV',  '115kV Load Break Switch', 'main_equipment', 'set',  false),
  ('ACC-CT-01',  'Current Transformer',     'accessory',      'ชุด',  true),
  ('ACC-BRK-01', 'Mounting Bracket',        'accessory',      'ชุด',  true),
  ('ACC-RLY-01', 'Protection Relay',        'accessory',      'ตัว',  false),
  ('ACC-CBL-01', 'Control Cable 25m',       'accessory',      'ม้วน', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO accessory_stock (item_id, qty_on_hand)
SELECT id, CASE code WHEN 'ACC-CT-01' THEN 20 WHEN 'ACC-BRK-01' THEN 15 END
FROM items WHERE code IN ('ACC-CT-01', 'ACC-BRK-01')
ON CONFLICT (item_id) DO NOTHING;

-- คลังตัวอย่าง 2 คลัง + LBS 40 เครื่อง (ลบ block นี้ได้ถ้าจะเริ่มจากคลังว่าง)
DO $$
DECLARE lbs_id UUID; s1 UUID; s2 UUID; i INT;
BEGIN
  SELECT id INTO lbs_id FROM items WHERE code = 'LBS-115KV';
  IF EXISTS (SELECT 1 FROM project_stocks) THEN RETURN; END IF;

  INSERT INTO project_stocks (stock_no, item_id, notes)
  VALUES ('Project Stock No.1', lbs_id, 'ล็อตสั่งซื้อรอบที่ 1 (30 set)') RETURNING id INTO s1;
  INSERT INTO project_stocks (stock_no, item_id, notes)
  VALUES ('Project Stock No.2', lbs_id, 'ล็อตสั่งซื้อรอบที่ 2 (10 set)') RETURNING id INTO s2;

  FOR i IN 1..30 LOOP
    INSERT INTO lbs_units (serial_no, project_stock_id) VALUES ('LBS24-' || lpad(i::TEXT, 3, '0'), s1);
  END LOOP;
  FOR i IN 1..10 LOOP
    INSERT INTO lbs_units (serial_no, project_stock_id) VALUES ('LBS25-' || lpad(i::TEXT, 3, '0'), s2);
  END LOOP;
END $$;
