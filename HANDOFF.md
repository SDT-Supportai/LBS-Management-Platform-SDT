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
| เว็บใช้งานจริง | https://lbs-platform-sdt.netlify.app |
| Netlify project | `lbs-platform-sdt` (auto-deploy จาก GitHub branch `main`) |
| GitHub repo | https://github.com/SDT-Supportai/LBS-Management-Platform-SDT |
| Supabase project ref | `mrdnxajwnvkgvfyaclwv` (region: ตามที่สร้าง) |
| Migrations ที่รันแล้ว | 0001, 0002, 0003, 0004, 0005 (ครบ) |
| E2E บน DB จริง | ✅ ผ่านทั้ง flow + ฟีเจอร์เพิ่มผู้ใช้ |
| Admin จริง | `siradanai.s@precise.co.th` (department = admin) |

## 3. Tech stack + หลักการออกแบบ

- **Frontend**: React 18 + TypeScript + Vite, React Router (HashRouter), CSS ล้วน (ไม่มี framework)
- **Backend/DB**: Supabase (PostgreSQL + Auth + Realtime)
- **Hosting**: Netlify (static + Serverless Functions)
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
  netlify/functions/
    line-notify.mjs          push แจ้งเตือนเข้ากลุ่ม LINE
    line-webhook.mjs          bot ตอบลูกค้า + คำสั่ง "id" ดู Group ID
    admin-users.mjs          สร้าง user / เปลี่ยนรหัสผ่าน (service role)
  supabase/
    migrations/0001..0005    schema, RPC, seed, bug fixes
    cleanup_e2e.sql          ล้างข้อมูลทดสอบก่อนใช้จริง
  .env.example               รายการ env (คัดลอกเป็น .env สำหรับ local LIVE)
  netlify.toml               build config
```

## 5. Migrations (รันเรียงใน Supabase SQL Editor ตอน setup DB ใหม่)

| ไฟล์ | ทำอะไร |
|---|---|
| `0001_schema.sql` | ตารางทั้งหมด + RLS policies (สิทธิ์ตามแผนก) + view `v_job_status` |
| `0002_rpc.sql` | business logic (RPC 26 ตัว) + trigger + realtime publication + trigger สร้าง profile อัตโนมัติ (user คนแรก = admin) |
| `0003_seed.sql` | master items (LBS + accessory) + คลังตัวอย่าง 40 เครื่อง |
| `0004_fix_issue_job.sql` | **bug fix**: rpc_issue_job update units ก่อนตั้ง job=issued |
| `0005_fix_notification_rls.sql` | **bug fix**: เพิ่ม RLS policy ให้ notifications อ่านได้ |
| `0006_serial_budget_epicor.sql` | **ฟีเจอร์ใหม่ (2026-07-14)**: LBS serial คู่ (serial_lvb + serial_om), jobs.budget_sale_price/budget_cost, job_accessory_requests.unit_price, items.epicor_code + ปรับ RPC (create/add stock รับ jsonb units, create/update job + budget, add accessory + unit_price, create/update item + epicor) + `rpc_update_accessory_request_price` ใหม่ |

> DB ใหม่บนโปรเจกต์เปล่า: รัน 0001→0006 เรียงกันได้เลย (0004/0005 ผสานเข้า 0001/0002 ต้นทางแล้ว แต่ยังเก็บไฟล์แยกไว้เป็นประวัติ)
> ⚠️ **production ที่รัน 0001–0005 ไปแล้ว ต้องรัน `0006` เพิ่มใน Supabase SQL Editor** (rename serial_no → serial_lvb + backfill serial_om, เพิ่มคอลัมน์ budget/unit_price/epicor, drop+recreate RPC ที่เปลี่ยน signature) — frontend build ใหม่จะเรียก RPC signature ใหม่ ต้องรัน 0006 ก่อน deploy

## 6. Environment variables (ตั้งใน Netlify → Site configuration → Environment variables)

| Key | ใช้ที่ไหน | หมายเหตุ |
|---|---|---|
| `VITE_SUPABASE_URL` | frontend | `https://mrdnxajwnvkgvfyaclwv.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | frontend | anon/publishable key (เปิดเผยได้) |
| `SUPABASE_URL` | functions | เท่ากับ VITE_SUPABASE_URL |
| `SUPABASE_SERVICE_ROLE_KEY` | functions | **ความลับ** — admin-users function เท่านั้น |
| `LINE_CHANNEL_ACCESS_TOKEN` | functions | (optional) แจ้งเตือน LINE |
| `LINE_GROUP_ID` | functions | (optional) กลุ่มปลายทาง |
| `LINE_CHANNEL_SECRET` | functions | (optional) ตรวจ signature webhook |

⚠️ **เปลี่ยน env แล้วต้อง redeploy** (Deploys → Trigger deploy → Deploy site) ค่าถึงจะมีผล

## 7. Netlify Functions

- `/.netlify/functions/line-notify` — POST `{message}` → push เข้ากลุ่ม LINE (frontend เรียกอัตโนมัติเมื่อเปิดสวิตช์ใน Dev Settings)
- `/.netlify/functions/line-webhook` — ตั้งเป็น Webhook URL ใน LINE Developers; พิมพ์ `id` ในกลุ่มเพื่อดู Group ID
- `/.netlify/functions/admin-users` — POST (ต้องมี JWT admin) action `create`/`set_password`; ใช้ service role สร้าง user + auto-confirm email

## 8. แผนก + สิทธิ์ (RLS + app_assert_dept)

| แผนก | ทำอะไรได้ |
|---|---|
| `sales` | สร้าง/แก้ Project Stock, รับ LBS เข้า, ปรับยอดสต็อกกลาง accessory |
| `project` | เปิด/แก้/ลบ Job, ดึง-คืน LBS, ขอ accessory, ออก PR, เบิกให้ Service, ยกเลิก Job |
| `purchasing` | ออก PO / ตีกลับ PR / รับของ (partial ได้) |
| `service` | ยืนยันติดตั้งเสร็จ (+วันที่จริง) |
| `admin` | ทำได้ทุกอย่าง + จัดการ Master Data (items/users) |

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
- [ ] ตรวจว่า **service_role key ถูก rotate แล้ว** (ระหว่าง setup key เก่าเคยเปิดเผย — ถ้ายังไม่ rotate ให้ทำ แล้วอัปเดต Netlify env + redeploy)

### 🟡 ฟีเจอร์เสริม (ยังไม่ตั้งค่า)
- [ ] **LINE แจ้งเตือน** — โค้ด+deploy พร้อม เหลือตั้ง LINE Developers channel + Netlify env (`LINE_*`) ดูขั้นตอนใน SETUP.md ขั้นที่ 4 / แชท handoff
- [ ] **Custom domain** — แนะนำ subdomain บริษัท `lbs.precise.co.th` (ฟรี, ขอ IT เพิ่ม CNAME → `lbs-platform-sdt.netlify.app`) แล้ว Add domain ใน Netlify (ออก SSL อัตโนมัติ)

### 🟢 พัฒนาต่อ (ไอเดีย)
- หน้า forgot-password / เปลี่ยนรหัสตัวเอง (ตอนนี้ต้องให้ admin reset ที่ Master Data)
- LINE bot ตอบสถานะ Job จริง (ต่อ Supabase ใน `line-webhook.mjs` — ตอนนี้เป็น placeholder)
- รายงาน/analytics (stock movement, lead time ต่อ Job)

## 11. Workflow การพัฒนา

**Local (Windows) — เครื่องนี้ไม่มี Node.js ใน PATH** ติดตั้ง portable ไว้ที่:
`C:\Users\siradanai.s\AppData\Local\node-portable\node-v20.18.1-win-x64\`

```bash
# prepend PATH ก่อน (PowerShell): $env:Path = "$env:LOCALAPPDATA\node-portable\node-v20.18.1-win-x64;$env:Path"
npm install
npm run dev       # โหมด demo ถ้าไม่มี .env / โหมด LIVE ถ้ามี .env
npm run build     # tsc + vite build -> dist/
```

- ทดสอบโหมด LIVE ในเครื่อง: `copy .env.example .env` แล้วกรอก VITE_SUPABASE_URL/ANON_KEY (netlify functions ต้องใช้ `npx netlify-cli dev`)
- **Deploy**: `git push origin main` → Netlify auto-deploy (~1-2 นาที)
- Business logic แก้ 2 ที่ให้ตรงกันเสมอ: `src/data/logic.ts` (demo) + `supabase/migrations/0002_rpc.sql` (LIVE)

## 12. Gotchas / ข้อควรระวัง

- Supabase **secret key (`sb_secret_`) ใช้นอก server ไม่ได้** — Supabase บล็อกเองถ้ายิงจาก browser/PowerShell; ใช้ได้เฉพาะใน Netlify Functions
- ตัวอักษรไทยใน `curl -d` บน Git Bash (Windows) โดน mangle → JSON พัง; ถ้าต้องยิง API ที่มีค่าไทย ใช้ในแอป/PowerShell ที่ตั้ง UTF-8
- แก้ business rule ต้องอัปเดตทั้ง demo (`logic.ts`) และ LIVE (`0002_rpc.sql`)
- `.env` และ `node_modules` อยู่ใน `.gitignore` แล้ว — อย่า commit ขึ้น git
