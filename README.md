# 115kV LBS Project Management Business Platform

ระบบจัดการ 115kV LBS ตั้งแต่ Sales สั่งซื้อเข้าสต็อกกลาง → Project Dept เปิด Job/ดึง LBS/สั่ง Accessory → Purchasing ออก PO → เบิกให้ Service ติดตั้ง

Business rules ทั้งหมดยึดตาม [`../lbs-stock-project-instructions (1).md`](../lbs-stock-project-instructions%20(1).md) เป็น source of truth

## สองโหมดในโค้ดชุดเดียว

| | โหมด Demo | โหมด LIVE (production) |
|---|---|---|
| เปิดใช้ | ไม่ตั้ง env (ค่าเริ่มต้น) | ตั้ง `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` |
| ข้อมูล | localStorage + seed | Supabase Postgres (Realtime sync ข้ามเครื่อง) |
| Auth | บัญชีจำลอง | Supabase Auth (email/password) |
| Business rules | `src/data/logic.ts` (client) | `supabase/migrations/0002_rpc.sql` (server, กัน race) |

**Deploy จริง: อ่าน [SETUP.md](SETUP.md)** — สร้าง Supabase project, รัน migration 3 ไฟล์, ตั้ง env บน Netlify (~20 นาที)

### บัญชีทดลอง (เฉพาะโหมด Demo — รหัสผ่าน `1234` ทุกบัญชี)

| บัญชี | แผนก | ทำอะไรได้ |
|---|---|---|
| `sales@demo.co` | Sales | สร้าง Project Stock, รับ LBS เข้าคลัง (ระบุ Serial No.) |
| `project@demo.co` | Project | เปิด Job, ดึง/คืน LBS รายเครื่อง, ขอ Accessory, ออก PR, เบิกให้ Service, ยกเลิก Job |
| `purchasing@demo.co` | Purchasing | รับ PR → ออก PO, บันทึกรับของ |
| `service@demo.co` | Service | ดูงานที่เบิกแล้ว/รอเบิก (read-only) |
| `admin@demo.co` | Admin | ทุกอย่าง |

## รันในเครื่อง

```bash
npm install
npm run dev     # http://localhost:5173
```

## Deploy ขึ้น Netlify

มี `netlify.toml` พร้อมแล้ว — ลาก folder นี้เข้า Netlify หรือเชื่อม git repo:
build command `npm run build`, publish directory `dist`

## โครงสร้างสำคัญ

```
src/
  data/logic.ts        ← business rules ทั้งหมด (pure functions + validation)
  data/seed.ts         ← ข้อมูล demo (สร้างผ่าน logic เดียวกัน จึงถูก rule เสมอ)
  data/StoreContext.tsx← state + auth + permission ต่อแผนก
  pages/               ← Dashboard / Stocks / Jobs / JobDetail / Purchasing / Service / Audit
supabase/migrations/0001_schema.sql ← schema สำหรับ Phase 2 (Supabase)
```

## Job Status (auto ทั้งหมด ไม่ใช่ manual toggle)

```
Draft → Allocated → Procuring Accessory → Ready to Issue → Issued → Installed
                                                    ↘ Cancelled (ได้ทุกสถานะก่อน Issued)
```

- `Ready to Issue` = LBS ครบตาม Scope **และ** Accessory ครบทุกรายการ (ทั้ง 2 แหล่ง)
- `Issued` = เบิกให้ Service แล้ว (allocation ล็อก) → Service กดยืนยัน "ติดตั้งเสร็จ" พร้อมวันที่จริง → `Installed`
- Purchasing **ตีกลับ PR** พร้อมเหตุผลได้ (รายการเด้งกลับให้ Project) และ**รับของบางส่วน** (partial receive) ได้
- ยกเลิก Job = auto คืน LBS กลับ Stock เดิมตาม allocation record + คืน Accessory สต็อกกลาง

## การแจ้งเตือน + LINE Messaging API

ทุกเหตุการณ์ข้ามแผนก (PR ใหม่/ตีกลับ, PO ออก/รับของ, ของครบ, เบิกแล้ว, ติดตั้งเสร็จ, ยกเลิก)
แจ้งเตือน in-app ที่เมนู 🔔 และส่งเข้า LINE group ได้:

1. สร้าง LINE Official Account + Messaging API channel ที่ [LINE Developers Console](https://developers.line.biz)
2. เชิญ OA เข้ากลุ่ม แล้วหา Group ID (log จาก webhook event `source.groupId`)
3. Deploy ขึ้น Netlify แล้วตั้ง env: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_GROUP_ID` (+ `LINE_CHANNEL_SECRET` สำหรับ webhook)
4. เปิดสวิตช์ที่เมนู ⚙️ Dev Settings → ส่งข้อความทดสอบ

ฟังก์ชันฝั่ง server อยู่ที่ `netlify/functions/line-notify.mjs` (push เข้ากลุ่ม) และ
`netlify/functions/line-webhook.mjs` (bot ตอบโต้ลูกค้า — ตั้ง Webhook URL ชี้มาที่ function นี้)
> ⚠️ ห้ามเอา Channel Access Token ใส่ฝั่ง frontend เด็ดขาด — browser เรียก LINE API ตรงไม่ได้ (CORS) และ token จะรั่ว

## Phase 2: ต่อ Supabase (Netlify + Supabase)

1. สร้าง Supabase project → รัน `supabase/migrations/0001_schema.sql` ใน SQL Editor
2. เปิด Supabase Auth (email/password) แล้วสร้าง users + แถวใน `profiles` ระบุ `department`
3. เพิ่ม `@supabase/supabase-js` แล้วแทนที่ data layer ใน `StoreContext.tsx` ด้วย Supabase queries
   (business logic ใน `logic.ts` ย้ายไปเป็น Postgres RPC/Edge Functions เพื่อกัน race condition)
4. ตั้ง env `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` ใน Netlify

RLS policies ตามแผนกเตรียมไว้ใน migration แล้ว (mirror กับ `PERMISSIONS` ฝั่ง frontend)
