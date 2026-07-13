# คู่มือ Deploy จริง — Netlify + Supabase (ทำครั้งเดียว ~20 นาที)

แอปนี้มี 2 โหมดอัตโนมัติ: **ไม่ตั้ง env = Demo (localStorage)** / **ตั้ง env = LIVE (Supabase)**

---

## ขั้นที่ 1 — สร้าง Supabase project (~5 นาที)

1. ไปที่ [supabase.com](https://supabase.com) → **New project** (ฟรี tier พอสำหรับเริ่มต้น)
   - เลือก region `Southeast Asia (Singapore)` เพื่อ latency ต่ำจากไทย
   - ตั้ง Database password แล้วเก็บไว้ให้ดี
2. รอ project สร้างเสร็จ → ไปที่ **SQL Editor** แล้วรันไฟล์ตามลำดับ (copy เนื้อหาไฟล์ → Run):
   1. `supabase/migrations/0001_schema.sql` — ตาราง + RLS
   2. `supabase/migrations/0002_rpc.sql` — business rules ทั้งหมด (RPC) + realtime
   3. `supabase/migrations/0003_seed.sql` — master data + คลังตัวอย่าง (แก้/ตัด block คลังตัวอย่างได้)
3. เก็บค่า 2 ตัวจาก **Project Settings → API**:
   - `Project URL` → ใช้เป็น `VITE_SUPABASE_URL` และ `SUPABASE_URL` (เช่น `https://xxxxxxxx.supabase.co`)
   - `anon public` key → ใช้เป็น `VITE_SUPABASE_ANON_KEY` (ขึ้นต้น `sb_publishable_...` หรือ `eyJ...`)
   - `service_role` key → ใช้เป็น `SUPABASE_SERVICE_ROLE_KEY` (**ความลับ — ใส่เฉพาะใน Netlify env เท่านั้น ห้ามวางในไฟล์/แชท/git**)

## ขั้นที่ 2 — สร้างผู้ใช้คนแรก (admin)

1. **Authentication → Users → Add user** → กรอกอีเมล + รหัสผ่าน (เลือก Auto confirm)
2. ระบบสร้างแถวใน `profiles` ให้อัตโนมัติ (แผนกเริ่มต้น = service) → ตั้งเป็น admin ด้วย SQL:
   ```sql
   UPDATE profiles SET department = 'admin', full_name = 'ผู้ดูแลระบบ'
   WHERE email = 'you@yourco.com';
   ```
3. ผู้ใช้คนถัดไปทั้งหมด สร้างจากในแอปได้เลย: เมนู **ข้อมูลหลัก → + เพิ่มผู้ใช้** (ผ่าน admin function)

## ขั้นที่ 3 — Deploy ขึ้น Netlify (~5 นาที)

แนะนำผูก git repo (แก้โค้ดแล้ว auto deploy):

1. push โฟลเดอร์ `lbs-platform/` ขึ้น GitHub
2. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → เลือก repo
   - Build command: `npm run build` · Publish directory: `dist` (อ่านจาก `netlify.toml` ให้อยู่แล้ว)
3. **Site settings → Environment variables** เพิ่ม:

   | Key | Value | ใช้ทำอะไร |
   |---|---|---|
   | `VITE_SUPABASE_URL` | Project URL | frontend เชื่อม Supabase |
   | `VITE_SUPABASE_ANON_KEY` | anon key | frontend เชื่อม Supabase |
   | `SUPABASE_URL` | Project URL | admin function |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key | admin function (สร้าง user/เปลี่ยนรหัสผ่าน) |
   | `LINE_CHANNEL_ACCESS_TOKEN` | จาก LINE Developers | แจ้งเตือนเข้ากลุ่ม (optional) |
   | `LINE_GROUP_ID` | group id | แจ้งเตือนเข้ากลุ่ม (optional) |
   | `LINE_CHANNEL_SECRET` | จาก LINE Developers | webhook ตอบลูกค้า (optional) |

4. **Deploy** → เปิดเว็บ → login ด้วยบัญชี admin จากขั้นที่ 2 → มุมล่างซ้ายต้องขึ้น badge **LIVE**

## ขั้นที่ 4 — LINE (optional)

1. [developers.line.biz](https://developers.line.biz) → สร้าง **Messaging API channel** (ผูกกับ LINE OA)
2. เชิญ OA เข้ากลุ่มทีม → หา `groupId`: ตั้ง Webhook URL เป็น
   `https://<site>.netlify.app/.netlify/functions/line-webhook` → เปิด Use webhook →
   ส่งข้อความในกลุ่ม แล้วดู log ของ function ใน Netlify (event `source.groupId`)
3. ใส่ env `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_GROUP_ID` → redeploy
4. ในแอป: **⚙️ Dev Settings** → เปิดสวิตช์ LINE → กด "ส่งข้อความทดสอบ"

## รันแบบ local กับ Supabase จริง

```bash
cd lbs-platform
copy .env.example .env    # แล้วกรอกค่า VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev               # โหมด LIVE แต่ยังเรียก netlify functions ไม่ได้
# ถ้าต้องทดสอบ functions ด้วย: npx netlify-cli dev
```

## สถาปัตยกรรมที่ควรรู้

- **Business rules อยู่ฝั่ง server ทั้งหมด** (`0002_rpc.sql`) — ห้ามดึงเกินสต็อก, ล็อกหลัง issue,
  auto-return ตอนยกเลิก, partial receive ฯลฯ กัน race condition ด้วย atomic UPDATE
- ทุก RPC ตรวจแผนกผู้เรียกจาก JWT (`app_assert_dept`) — ปุ่มใน UI เป็นแค่ convenience,
  ต่อให้ยิง API ตรงก็ข้าม rule ไม่ได้
- Frontend โหลดข้อมูลทั้งชุด + subscribe Realtime → แผนกอื่นทำรายการแล้วหน้าจออัพเดทเองใน ~1 วินาที
- โหมด Demo (localStorage) ยังอยู่ครบ — เปิดโปรเจกต์โดยไม่ตั้ง env เพื่อ dev/สาธิตได้เสมอ
