# HANDOFF — 115kV LBS Project Management Platform

เอกสารส่งมอบ/สรุปสถานะระบบ (อัปเดต 2026-07-14) — อ่านไฟล์นี้ก่อนดูแลระบบต่อ
ประกอบกับ [README.md](README.md) (ภาพรวม), [SETUP.md](SETUP.md) (คู่มือ deploy), และ
`../lbs-stock-project-instructions (1).md` (business rules = source of truth ห้ามเปลี่ยนโดยไม่ยืนยัน)

---

## 1. ระบบนี้คืออะไร

ระบบจัดการ 115kV LBS (Load Break Switch) แบบครบวงจร 4 แผนก:
**Sales → Project → Purchasing → Service** ตั้งแต่รับ LBS เข้าคลังกลาง จนติดตั้งหน้างานเสร็จ
ทุกเครื่อง track ด้วย Serial No. รายเครื่อง มี audit log + แจ้งเตือนข้ามแผนกทุก transaction

## 2. สถานะปัจจุบัน — 🟢 LIVE บน production

| ส่วน | ค่า / สถานะ |
|---|---|
| Hosting | **Cloudflare Pages — LIVE แล้ว** https://lbs-platform-sdt.pages.dev (ย้ายจาก Netlify 2026-07-15, auto-deploy จาก `main`) |
| GitHub repo | https://github.com/SDT-Supportai/LBS-Management-Platform-SDT (root = โฟลเดอร์นี้) |
| Supabase project ref | `mrdnxajwnvkgvfyaclwv` (region: ตามที่สร้าง) |
| Migrations ที่รันแล้ว | **0001–0010 ครบ** (ยืนยันด้วย query เช็ค column/function 2026-07-15) |
| E2E บน DB จริง | ✅ ผ่านทั้ง flow + ฟีเจอร์เพิ่มผู้ใช้ |
| Admin จริง | `siradanai.s@precise.co.th` (department = admin, แสดงเป็น "Manager") |

## 3. Tech stack + หลักการออกแบบ

- **Frontend**: React 18 + TypeScript + Vite, React Router (HashRouter), CSS ล้วน (ไม่มี framework)
- **Backend/DB**: Supabase (PostgreSQL + Auth + Realtime)
- **Hosting**: **Cloudflare Pages** (static + Pages Functions) — ย้ายมาจาก Netlify (เครดิตหมด)
- **Dual-mode** (โค้ดชุดเดียว เลือกโหมดด้วย env):
  - **ไม่ตั้ง env** → โหมด **Demo** (localStorage, business logic ฝั่ง client ที่ `src/data/logic.ts`, login จำลอง)
  - **ตั้ง env** → โหมด **LIVE** (Supabase, business logic ฝั่ง server ที่ `supabase/migrations/0002_rpc.sql`)
  - สลับอัตโนมัติที่ `src/lib/supabase.ts` (มี `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` = LIVE)
- **หลักความปลอดภัย**: business rules ทั้งหมดอยู่ใน **PostgreSQL RPC (SECURITY DEFINER)** — ตรวจสิทธิ์แผนกจาก JWT (`app_assert_dept`) และกัน race ด้วย atomic UPDATE → ต่อให้ยิง API ตรงก็ข้าม rule ไม่ได้ ปุ่มใน UI เป็นแค่ convenience

## 4. โครงสร้างโปรเจกต์

```
lbs-platform/
  src/
    lib/supabase.ts          เลือกโหมด demo/LIVE
    data/
      logic.ts               business logic (demo mode, pure functions)
      seed.ts                ข้อมูล demo
      remote.ts              Supabase adapter (โหลดข้อมูล + เรียก RPC)
      StoreContext.tsx       state + auth + สลับ DemoProvider/SupabaseProvider
    pages/                   Dashboard/Stocks/Jobs/JobDetail/Purchasing/Service/
                             Notifications/MasterData/DevSettings/Audit/Login
    ui/                      components.tsx (Modal/Toast), format.ts (labels)
    types.ts                 type ทั้งระบบ
    styles.css               ธีม + Aurora + sidebar
  functions/                 Cloudflare Pages Functions (route = ชื่อไฟล์)
    admin-users.js           POST /admin-users — สร้าง user/เปลี่ยนรหัส (service role)
    line-notify.js           POST /line-notify — push แจ้งเตือนเข้ากลุ่ม LINE
    line-webhook.js          POST /line-webhook — bot ตอบลูกค้า + คำสั่ง "id" ดู Group ID
  public/
    _redirects               SPA fallback (/* → /index.html 200)
  supabase/
    migrations/0001..0009    schema, RPC, seed, bug fixes, ฟีเจอร์
    cleanup_e2e.sql          ล้างข้อมูลทดสอบก่อนใช้จริง
  .env.example               รายการ env (คัดลอกเป็น .env สำหรับ local LIVE)
```

## 5. Migrations (รันเรียงใน Supabase SQL Editor ตอน setup DB ใหม่)

| ไฟล์ | ทำอะไร |
|---|---|
| `0001_schema.sql` | ตารางทั้งหมด + RLS policies (สิทธิ์ตามแผนก) + view `v_job_status` |
| `0002_rpc.sql` | business logic (RPC 26 ตัว) + trigger + realtime publication + trigger สร้าง profile อัตโนมัติ (user คนแรก = admin) |
| `0003_seed.sql` | master items (LBS + accessory) + คลังตัวอย่าง 40 เครื่อง |
| `0004_fix_issue_job.sql` | **bug fix**: rpc_issue_job update units ก่อนตั้ง job=issued |
| `0005_fix_notification_rls.sql` | **bug fix**: เพิ่ม RLS policy ให้ notifications อ่านได้ |
| `0006_serial_budget_epicor.sql` | **ฟีเจอร์ (2026-07-14)**: LBS serial คู่ (serial_lvb + serial_om), jobs.budget_sale_price/budget_cost, job_accessory_requests.unit_price, items.epicor_code + ปรับ RPC (create/add stock รับ jsonb units, create/update job + budget, add accessory + unit_price, create/update item + epicor) + `rpc_update_accessory_request_price` ใหม่ · backfill serial_om ต้อง disable trigger `trg_block_issued_edit` ชั่วคราว |
| `0007_manual_no_install_schedule.sql` | **ฟีเจอร์ (2026-07-14)**: Job No./PO No. กรอกเอง (unique, Job No. แก้ได้ก่อนเบิก), cap ดึง LBS ≤ lbs_qty_required, jobs.install_start_date/install_end_date/issue_location (นัดติดตั้งจริงตอนเบิก) — drop+recreate rpc_create_job/rpc_update_job/rpc_create_po/rpc_issue_job/rpc_draw_lbs (เปลี่ยน signature) |
| `0008_review_fixes_phase_budget.sql` | **fix จาก code review + ฟีเจอร์ (2026-07-14)**: (1) rpc_update_job ห้ามลด Scope ต่ำกว่า LBS ที่ถืออยู่ (กัน cap bypass) (2) rpc_draw_lbs lock แถว job FOR UPDATE กัน race (3) ห้าม Serial.LVB = Serial.OM ในเครื่องเดียวกัน (4) job_accessory_requests.phase_budget + rpc_add_accessory_request รับ p_phase_budget (เปลี่ยน signature) |
| `0009_delete_project_stock.sql` | **ฟีเจอร์ (2026-07-14)**: `rpc_delete_project_stock` — ลบ Project Stock ได้เฉพาะคลัง "เปล่า" (ทุกเครื่อง in_stock + ไม่เคยมีประวัติดึง/คืน) คลังที่ใช้แล้วให้ "ปิดคลัง" แทน |
| `0010_edit_lbs_serials.sql` | **ฟีเจอร์ (2026-07-15)**: `rpc_update_lbs_serials` — แก้ Serial.LVB/OM ได้เฉพาะเครื่องที่ยัง in_stock (unique, lvb≠om) กัน snapshot serial ใน allocation/audit เพี้ยน |
| `0011_cancel_po.sql` | **ฟีเจอร์ (2026-07-15)**: `rpc_cancel_po` — ยกเลิก PO เดี่ยว (เฉพาะยังไม่รับของเลย): PO → cancelled, PR คืน pending ให้ออก PO ใหม่, รายการวัสดุกลับ pr_sent |
| `0012_stock_customer_info.sql` | **ฟีเจอร์ (2026-07-16)**: project_stocks + customer_name/contact_phone/install_location (optional, แก้ภายหลังได้) — drop+recreate rpc_create_project_stock/rpc_update_project_stock (เปลี่ยน signature) |
| `0013_unit_customer_info.sql` | **ฟีเจอร์ (2026-07-16)**: lbs_units + customer_name/contact_phone/install_location **รายเครื่อง** (เว้นว่าง = fallback ค่าของคลัง) — `rpc_update_unit_info` แทน rpc_update_lbs_serials (Serial แก้ได้เฉพาะ in_stock, ลูกค้าแก้ได้จนกว่า issued), create/add stock อ่าน field เพิ่มจาก jsonb (Excel import ต่อคลัง) |

> DB ใหม่บนโปรเจกต์เปล่า: รัน 0001→0009 เรียงกันได้เลย (0004/0005 ผสานเข้า 0001/0002 ต้นทางแล้ว แต่ยังเก็บไฟล์แยกไว้เป็นประวัติ)
> ⚠️ **production ต้องรัน migration ล่าสุดใน Supabase SQL Editor ก่อน push frontend เสมอ** — frontend build ใหม่เรียก RPC signature ใหม่ ถ้ายังไม่รัน migration หน้าเว็บจะ error (ล่าสุด: `0008` — rpc_add_accessory_request เปลี่ยน signature)

## 6. Environment variables (ตั้งใน Cloudflare Pages → Settings → Environment variables · Production)

| Key | ใช้ที่ไหน | หมายเหตุ |
|---|---|---|
| `VITE_SUPABASE_URL` | build (baked เข้า bundle) | `https://mrdnxajwnvkgvfyaclwv.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | build + functions | anon/publishable key (เปิดเผยได้) — functions ใช้ตรวจ token ด้วย |
| `SUPABASE_URL` | functions | เท่ากับ VITE_SUPABASE_URL |
| `SUPABASE_SERVICE_ROLE_KEY` | functions | **ความลับ** — admin-users function เท่านั้น |
| `LINE_CHANNEL_ACCESS_TOKEN` | functions | (optional) แจ้งเตือน LINE |
| `LINE_GROUP_ID` | functions | (optional) กลุ่มปลายทาง |
| `LINE_CHANNEL_SECRET` | functions | (optional) ตรวจ signature webhook |

⚠️ Cloudflare Pages ทำ env ทั้งหมดให้ทั้งตอน **build** (VITE_* baked เข้า bundle) และให้ **Functions** ตอน runtime (`context.env`)
⚠️ **เปลี่ยน env แล้วต้อง redeploy** (Deployments → ... → Retry deployment) ค่าถึงจะมีผล

### 6.1 ขั้นตอนย้าย/ตั้งค่า Cloudflare Pages (ครั้งแรก)

1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git** → เลือก repo `SDT-Supportai/LBS-Management-Platform-SDT`
2. **Build settings**: Framework preset = `Vite` (หรือ None) · Build command = `npm run build` · Build output directory = `dist` · Root directory = `/` (repo root คือโฟลเดอร์ lbs-platform อยู่แล้ว)
3. ใส่ Environment variables ตามตารางหัวข้อ 6 (ทั้ง build + functions ใช้ที่เดียวกันบน Cloudflare)
4. **Save and Deploy** → ได้ URL `https://<project>.pages.dev`
5. (ถ้า `admin-users` error ตอน runtime) เปิด **Settings → Functions → Compatibility flags** เพิ่ม `nodejs_compat` แล้ว redeploy (ปกติ supabase-js ทำงานได้โดยไม่ต้องเปิด)
6. **Custom domain** (แนะนำ): Settings → Custom domains → เพิ่ม `lbs.precise.co.th` (ขอ IT เพิ่ม CNAME → `<project>.pages.dev`) ออก SSL อัตโนมัติ
7. ปิด auto-deploy ฝั่ง **Netlify** (Netlify → Site → Build & deploy → Stop builds / unlink repo) กันสับสน 2 hosting
8. ถ้าใช้ LINE: อัปเดต Webhook URL ใน LINE Developers → `https://<project>.pages.dev/line-webhook`

## 7. Cloudflare Pages Functions (route = ชื่อไฟล์ใน `functions/`)

- `POST /line-notify` — `{message}` → push เข้ากลุ่ม LINE (frontend เรียกอัตโนมัติเมื่อเปิดสวิตช์ใน Dev Settings)
- `POST /line-webhook` — ตั้งเป็น Webhook URL ใน LINE Developers; พิมพ์ `id` ในกลุ่มเพื่อดู Group ID, พิมพ์ `สถานะ <Job No.>` เพื่อดูสถานะงานจริงจาก Supabase (ตอบเฉพาะกลุ่มที่ตรง LINE_GROUP_ID; ตรวจ signature ด้วย Web Crypto)
- `POST /admin-users` — ต้องมี JWT admin, action `create`/`set_password`; ใช้ service role สร้าง user + auto-confirm email
- รูปแบบ: `export async function onRequestPost({ request, env })` · อ่าน env ผ่าน `env.XXX` (ไม่ใช่ `process.env`)
- ทดสอบ functions ในเครื่อง: `npx wrangler pages dev dist` (build ก่อน) — Vite `npm run dev` ไม่รัน functions

## 8. แผนก + สิทธิ์ (RLS + app_assert_dept)

| แผนก | ทำอะไรได้ |
|---|---|
| `sales` | สร้าง/แก้ Project Stock, รับ LBS เข้า, ปรับยอดสต็อกกลาง accessory |
| `project` | เปิด/แก้/ลบ Job, ดึง-คืน LBS, ขอ accessory, ออก PR, เบิกให้ Service, ยกเลิก Job |
| `purchasing` | ออก PO / ตีกลับ PR / รับของ (partial ได้) |
| `service` | ยืนยันติดตั้งเสร็จ (+วันที่จริง) |
| `admin` | แสดงชื่อเป็น **"Manager"** ใน UI (ค่าใน DB ยังเป็น `admin`) — ทำได้ทุกอย่าง + จัดการ Master Data (items/users) + Import/Export Excel |

Job status (auto ทั้งหมด): `Draft → Allocated → Procuring Accessory → Ready to Issue → Issued → Installed` (+ `Cancelled` ได้ทุกสถานะก่อน Issued)

## 9. บั๊กที่เจอจาก E2E บน DB จริง + วิธีแก้ (institutional knowledge)

1. **rpc_issue_job บล็อกตัวเอง** — ตั้ง job=issued ก่อน update units → trigger `trg_block_issued_edit` กันแก้ allocation ของ job ที่ issued แล้ว → แก้: update units ก่อน แล้วค่อยตั้ง job (0004)
2. **notifications อ่านไม่เห็น** — ลืมใส่ RLS SELECT policy → app_notify insert ลงแต่ role authenticated อ่านไม่ได้ → แก้: เพิ่ม policy (0005)
3. **admin-users token invalid** — Supabase secret key แบบใหม่ (`sb_secret_`) ถูกจำกัดบน GoTrue auth endpoint → validate token ของผู้เรียกด้วย **anon key** แทน service key (commit `ab6e8e6`)

> demo mode ไม่มี trigger/RLS/functions จึงไม่เจอ 3 บั๊กนี้ — ต้องทดสอบบน DB จริงเท่านั้น

## 10. งานค้าง (TODO)

### 🔴 ความปลอดภัย (ทำก่อนใช้จริงจัง)
- [ ] **ลบบัญชีทดสอบ** ใน Supabase → Authentication → Users:
      `e2e-runner@example.org` (เคยเป็น admin, รหัสผ่านเคยเปิดเผยระหว่าง setup),
      `e2e.tester.lbs@gmail.com`, `e2e-admin@example.com`, `fn-test-sales@example.org`
- [ ] **รัน `supabase/cleanup_e2e.sql`** — ล้าง job/LBS/notification ทดสอบ + คืนยอดสต็อก
- [ ] ตรวจว่า **service_role key ถูก rotate แล้ว** (ระหว่าง setup key เก่าเคยเปิดเผย — ถ้ายังไม่ rotate ให้ทำ แล้วอัปเดต Cloudflare Pages env + redeploy)

### 🟡 ฟีเจอร์เสริม (ยังไม่ตั้งค่า)
- [ ] **LINE แจ้งเตือน** — โค้ด+deploy พร้อม เหลือตั้ง LINE Developers channel + Cloudflare Pages env (`LINE_*`) → เปิดสวิตช์ใน Dev Settings
- [ ] **Custom domain** — แนะนำ subdomain บริษัท `lbs.precise.co.th` (ฟรี, ขอ IT เพิ่ม CNAME → `<project>.pages.dev`) แล้ว Add ใน Cloudflare Pages → Custom domains (ออก SSL อัตโนมัติ)

### 🟢 พัฒนาต่อ (ไอเดีย)
- หน้า forgot-password / เปลี่ยนรหัสตัวเอง (ตอนนี้ต้องให้ Manager reset ที่ Dev Settings → ผู้ใช้งาน)
- รายงาน/analytics (stock movement, lead time ต่อ Job)

> ✅ ยกเลิก PO เดี่ยวได้แล้ว (0011, 2026-07-15) · จัดการผู้ใช้งานย้ายจาก Material Database → Dev Settings

> ✅ LINE bot ตอบสถานะ Job จริงแล้ว (2026-07-15) — `functions/line-webhook.js` ต่อ Supabase, คำสั่ง `สถานะ <Job No.>`

## 11. Workflow การพัฒนา

**Local (Windows) — เครื่องนี้ไม่มี Node.js ใน PATH** ติดตั้ง portable ไว้ที่:
`C:\Users\siradanai.s\AppData\Local\node-portable\node-v20.18.1-win-x64\`

```bash
# prepend PATH ก่อน (PowerShell): $env:Path = "$env:LOCALAPPDATA\node-portable\node-v20.18.1-win-x64;$env:Path"
npm install
npm run dev       # โหมด demo ถ้าไม่มี .env / โหมด LIVE ถ้ามี .env
npm run build     # tsc + vite build -> dist/
```

- ทดสอบโหมด LIVE ในเครื่อง: `copy .env.example .env` แล้วกรอก VITE_SUPABASE_URL/ANON_KEY (ทดสอบ Pages Functions: `npm run build` แล้ว `npx wrangler pages dev dist`)
- **Deploy**: `git push origin main` → Cloudflare Pages auto-deploy (~1-2 นาที)
- Business logic แก้ 2 ที่ให้ตรงกันเสมอ: `src/data/logic.ts` (demo) + `supabase/migrations/0002_rpc.sql` (LIVE)

## 12. Gotchas / ข้อควรระวัง

- Supabase **secret key (`sb_secret_`) ใช้นอก server ไม่ได้** — Supabase บล็อกเองถ้ายิงจาก browser/PowerShell; ใช้ได้เฉพาะใน Pages Functions
- ตัวอักษรไทยใน `curl -d` บน Git Bash (Windows) โดน mangle → JSON พัง; ถ้าต้องยิง API ที่มีค่าไทย ใช้ในแอป/PowerShell ที่ตั้ง UTF-8
- แก้ business rule ต้องอัปเดตทั้ง demo (`logic.ts`) และ LIVE (`0002_rpc.sql`)
- `.env` และ `node_modules` อยู่ใน `.gitignore` แล้ว — อย่า commit ขึ้น git
