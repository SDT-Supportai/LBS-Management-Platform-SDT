# HANDOFF — 115kV LBS Project Management Platform

เอกสารส่งมอบ/สรุปสถานะระบบ (อัปเดต 2026-07-22) — อ่านไฟล์นี้ก่อนดูแลระบบต่อ
ประกอบกับ [README.md](README.md) (ภาพรวม), [SETUP.md](SETUP.md) (คู่มือ deploy), และ
`../lbs-stock-project-instructions (1).md` (business rules = source of truth ห้ามเปลี่ยนโดยไม่ยืนยัน)

---

## 1. ระบบนี้คืออะไร

ระบบจัดการ 115kV LBS (Load Break Switch) แบบครบวงจร 4 แผนก:
**Sales → Project → Purchasing → Service** ตั้งแต่รับ LBS เข้าคลังกลาง จนติดตั้งหน้างานเสร็จ
ทุกเครื่อง track ด้วย Serial คู่ (LVB + OM) รายเครื่อง มี audit log + แจ้งเตือนข้ามแผนกทุก transaction

**แผนที่เมนู UI ปัจจุบัน** (เรียงตาม sidebar · ชื่อไฟล์ใน `src/pages/` ยังเป็นชื่อเดิม เช่น JobsPage/ServicePage):
- **Project Stock (LBS)** (`StocksPage`) — คลัง LBS + ดูรายเครื่อง (ข้อมูลลูกค้า ref จาก Job) + Export/Import Excel ต่อคลัง · **ต้นทุนตัว LBS ต่อเครื่อง** กรอกตอนสร้าง/รับเข้า/Import (คอลัมน์ "ต้นทุน/เครื่อง") → badge "มูลค่าคลัง" = Σ ต้นทุน (0024) · **Import เจอ Serial ซ้ำ (คู่ตรงในคลังนี้) → ถามว่าอัพเดทต้นทุน/ข้าม** ส่วนที่ชนคลังอื่นหรือคู่ไม่ตรงเป็น error (0025)
- **Project ID (Jobs)** (`JobsPage`/`JobDetailPage`) — เปิด Job, **Project Budget ต้นทุน 7 หมวด** (การ์ดแก้ได้/ตาราง Raw Material→Finance ซ่อนได้ · **Manage แก้งบได้แม้ Job ล็อก** 0023), ดึง-คืน LBS, ขอวัสดุ, ออก PR — ปุ่มออก PR/เบิก/ยกเลิกของ project เป็น "ขออนุมัติ" (Manage ทำตรง) · Purchase Orders มีปุ่ม **⬇ Export Excel** + คอลัมน์ Phase Budget โชว์ Phase ที่กรอกในงบ · **ดึง LBS เข้า Job → ต้นทุนเครื่องบวกเข้า actual หมวด Raw Material** (0024) · **หลายจุดติดตั้งต่อ Job เมื่อ LBS>1** (จุดที่ 1 = ฟิลด์เดิม + จุดที่ 2+ = install_sites, 0026) · ปุ่ม **🖨️ ปริ้นสรุปโครงการ (PDF)**
- **Purchasing (PR/PO)** (`PurchasingPage`) — จัดกลุ่มตาม Job, **1 PR → หลาย PO** (เลือกอุปกรณ์เข้าแต่ละ PO), ยกเลิก PO, ตีกลับ PR, รับของ partial · **รายการรอออก PO แสดงครบ** (Epicor, ชื่อ, จำนวน, ราคา/หน่วย, มูลค่า, Phase Budget) · popup ออก PO เป็น Modal กว้าง · สรุปประวัติ PR/PO ต่อ Job (ซ่อนได้)
- **Service (Installation)** (`ServicePage`) — ยืนยันติดตั้ง **บังคับ Check-in GPS + แนบรูป**
- **Material Database** (`MasterDataPage`) — ฐานข้อมูลวัสดุ + Export/Import Excel · **ใช้ "รหัส Epicor" เป็นตัวระบุหลัก** (ตัดช่อง "รหัส" ภายในออกจาก UI ทั้งหมด — เบื้องหลัง client set `code`=Epicor คง schema เดิม, Import match/เช็คซ้ำด้วย Epicor)
- **Awaiting Approval** (`ApprovalsPage`) — คิวคำขอจาก project ให้ Division ตัดสิน + ประวัติแยกตาม Job (ซ่อนได้) · badge จำนวนค้าง · **อยู่ล่าง Material Database**
- **Dev Settings** (`DevSettingsPage`) — เฉพาะ Manage: ผู้ใช้งาน (เพิ่ม/แก้ชื่อ-อีเมล-รหัส-แผนก), สวิตช์ LINE (global), backup — **Audit Log** ปุ่มล่าง sidebar

## 2. สถานะปัจจุบัน — 🟢 LIVE บน production

| ส่วน | ค่า / สถานะ |
|---|---|
| Hosting | **Cloudflare Pages — LIVE แล้ว** https://lbs-platform-sdt.pages.dev (ย้ายจาก Netlify 2026-07-15, auto-deploy จาก `main`) |
| GitHub repo | https://github.com/SDT-Supportai/LBS-Management-Platform-SDT (root = โฟลเดอร์นี้) |
| Supabase project ref | `mrdnxajwnvkgvfyaclwv` (region: ตามที่สร้าง) |
| Migrations ที่รันแล้ว | **0001–0026** (0023/0024 รัน 2026-07-22 · 0025/0026 รัน 2026-07-23) · ⚠️ **0027 เป็นไฟล์ใหม่ (2026-07-24) ยังไม่รันบน production — ต้องรันก่อน/พร้อม push frontend** ไม่งั้นปุ่ม "ลบรายการที่ยกเลิกออกจากการ์ด" จะ error (`rpc_delete_accessory_request` ไม่มี) · ถ้า LINE ไม่ส่ง เช็คตาราง `app_settings` (0017) · อัปโหลดรูปไม่ได้ เช็ค bucket `install-photos` (0019) |
| E2E บน DB จริง | ✅ ผ่านทั้ง flow · demo E2E: approval, LINE dispatch, budget 7 หมวด, 1 PR→N PO (12/12), check-in/photo |
| Admin จริง | `siradanai.s@precise.co.th` (department = admin, แสดงเป็น "Manage") |

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
                             Approvals/Notifications/MasterData/DevSettings/Audit/Login
    ui/                      components.tsx (Modal/Toast/BudgetFields), format.ts (labels + COST_CATEGORIES)
    types.ts                 type ทั้งระบบ
    styles.css               ธีม + Aurora + sidebar + @media print
  functions/                 Cloudflare Pages Functions (route = ชื่อไฟล์)
    admin-users.js           POST /admin-users — สร้าง user/เปลี่ยนรหัส/อีเมล (service role)
    line-notify.js           POST /line-notify — push แจ้งเตือนเข้ากลุ่ม LINE (บังคับ JWT)
    line-webhook.js          POST /line-webhook — bot ตอบลูกค้า + คำสั่ง "id" ดู Group ID
  public/
    _redirects               SPA fallback (/* → /index.html 200)
    logo.png                 โลโก้จริง (crop ขอบขาว) — ใช้ทั้ง login/sidebar/favicon
  supabase/
    migrations/0001..0027    schema, RPC, seed, bug fixes, ฟีเจอร์
    cleanup_e2e.sql          ⛔ ล้าง transaction ทั้งหมด (มีสลักนิรภัย) — ห้ามรันถ้ามีข้อมูลจริง
    cleanup_e2e_accounts.sql ปิด/ลบบัญชีทดสอบ e2e (ปลอดภัยแม้มีข้อมูลจริง)
    cleanup_job.sql          ล้าง Job เดียวเพื่อเปิด Job No. เดิมใหม่ (คืน LBS เข้าสต็อก) — แก้ v_job_no ก่อนรัน
  .env.example               รายการ env (คัดลอกเป็น .env สำหรับ local LIVE)
  .env.demo.local            (gitignored) รัน demo local: npm run dev -- --mode demo หรือ mv .env ออก
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
| `0013_unit_customer_info.sql` | ~~ฟีเจอร์ (2026-07-16)~~ **ถูกแทนด้วย 0014** — ยังต้องรันเรียงลำดับอยู่ |
| `0014_customer_ref_from_job.sql` | **refactor (2026-07-16)**: ข้อมูลลูกค้า = **ref จาก Job เท่านั้น** (single source of truth) — jobs + `contact_phone` (rpc_create/update_job เปลี่ยน signature), drop คอลัมน์ลูกค้าที่ project_stocks/lbs_units (0012/0013), revert stock RPC, `rpc_update_unit_info` เหลือแก้ Serial (in_stock) |
| `0015_cancel_job_fixes.sql` | **bug fix จาก code review (2026-07-17)**: (1) rpc_cancel_job อ้าง `serial_no` ที่ถูก rename ใน 0006 → ยกเลิก Job บน LIVE error ทุกครั้ง (2) วัสดุรับจาก PO บางส่วน (po_ordered + qty_received > 0) เดิมถูก cancel เงียบๆ ของหาย → ปฏิบัติเหมือน received (คืนสต็อกกลาง/ปิดยอดตามจริง) (3) `app_assert_job_editable` ล็อกแถว job FOR UPDATE — serialize ทุก transition กัน race issue↔เพิ่มวัสดุ/คืน LBS · demo sync ที่ `logic.ts` cancelJob |
| `0016_division_approval.sql` | **ฟีเจอร์ (2026-07-19)**: Division approval flow — project ออก PR / เบิก / ยกเลิก Job ต้องให้ Division (dept `sales`) อนุมัติก่อน: ตาราง `approval_requests` + แยก core เป็น `app_exec_create_pr/issue_job/cancel_job` + `rpc_create_pr/rpc_issue_job/rpc_cancel_job` เหลือ **admin เท่านั้น** (กันยิงตรงข้ามขั้นอนุมัติ) + `rpc_request_approval` (project) / `rpc_approve_request`+`rpc_reject_request` (sales+admin, อนุมัติ = execute ใน txn เดียว) · demo sync ครบที่ `logic.ts` + หน้า "รออนุมัติ" ใหม่ |
| `0017_line_global_switch.sql` | **fix จาก review flow แจ้งเตือน (2026-07-19)**: (1) สวิตช์ LINE เป็น global ใน DB (ตาราง `app_settings` + `rpc_set_line_enabled` admin) — เดิมอยู่ localStorage ต่อเครื่อง เครื่องที่ปิด (default) mark pending เป็น off ฆ่าข้อความทั้งระบบ (2) `rpc_claim_line_pending` atomic claim กันหลายเครื่องส่งซ้ำ (3) เบิกสต็อกกลาง → แจ้ง Division (`accessory_issued`) · คู่กับ `/line-notify` ที่บังคับ JWT แล้ว (เดิมเปิดสาธารณะ) |
| `0018_notify_add_units.sql` | **bug fix (2026-07-19) 2 จุด**: (1) **Import Serial/รับเพิ่มเข้าคลังเดิม error `column customer_name ... does not exist`** — 0013 ทำให้ rpc_add_units_to_stock insert คอลัมน์ลูกค้า แต่ 0014 ลบคอลัมน์นั้นโดยลืม recreate ฟังก์ชันนี้ → recreate ให้ insert แค่ serial (2) เดิมไม่มี app_notify → เพิ่ม `stock_received` (dept project) · **อิสระจาก 0017 รันเดี่ยวได้** · demo sync ที่ `logic.ts` |
| `0019_install_checkin_photo.sql` | **ฟีเจอร์ (2026-07-19)**: Service ยืนยันติดตั้ง **บังคับ Check-in GPS + แนบรูปทุกครั้ง** — jobs + install_checkin_lat/lng + install_photo_url, **Storage bucket `install-photos`** (public read + authenticated upload), recreate `rpc_confirm_install` (signature ใหม่ +p_lat/p_lng/p_photo_url บังคับครบ) + LINE deep link ในคำขออนุมัติ (`rpc_request_approval` แนบลิงก์ /#/approvals) · demo: รูปเก็บเป็น data URL · **⚠️ ถ้า bucket สร้างผ่าน SQL ไม่ได้ (สิทธิ์) ให้สร้างชื่อ `install-photos` public ใน Dashboard→Storage เอง** |
| `0020_draw_notify.sql` | **มติ (2026-07-19)**: เลิกแจ้ง `job_ready` (`app_notify_if_ready` → no-op ทุก caller) → ใช้แจ้ง `lbs_drawn` ตอนดึง LBS แทน (rpc_draw_lbs agg serial_lvb+serial_om + Stock No., dept `all` เข้า LINE+ทุกแผนก) · demo sync `logic.ts` (drawLbs + notifyIfBecameReady no-op) |
| `0021_budget_7_categories.sql` | **ฟีเจอร์ (2026-07-20)**: Project Budget ต้นทุนแยก 7 หมวด — `jobs.budget_costs` JSONB (Raw mat/Outsourcing/Trans/Eng/Ove/PM/Fin, แต่ละหมวด {budget,phase,actual}), backfill budget_cost→raw_mat, budget_cost=ต้นทุนรวม(server คำนวณ); drop+recreate rpc_create/update_job (p_cost→p_costs JSONB) + `app_sum_budget_costs` · raw_mat/outsourcing actual จาก PR/PO ที่ตัดเข้าหมวด · demo sync |
| `0022_pr_multi_po.sql` | **ฟีเจอร์ (2026-07-20)**: 1 PR → หลาย PO — `job_accessory_requests.po_id` (PO อ้าง line items), drop+recreate `rpc_create_po` (+p_request_ids เลือก line; PR pending/po_issued ออก PO เพิ่มได้), `rpc_receive_po_items` (match po_id; PR เสร็จเมื่อทุก line ครบ), `rpc_cancel_po` (คืน line ของ PO) · demo sync · UI: PurchasingPage เลือกอุปกรณ์เข้า PO, JobDetail Budget card แก้ได้ + ตาราง 7 หมวดซ่อนได้ |
| `0023_edit_budget_when_locked.sql` | **ฟีเจอร์ (2026-07-22)**: Manage แก้งบประมาณได้แม้ Job ล็อก (issued/installed/cancelled) — `rpc_update_job_budget` (เฉพาะ admin, ไม่ผ่าน `app_assert_job_editable`, แก้เฉพาะ sale_price + budget_costs ไม่แตะ scope/allocation) · demo sync `logic.ts updateJobBudget` · UI: ปุ่ม "✏️ แก้ไขงบประมาณ" โชว์ตอนล็อกเฉพาะ Manage, save route ไป updateJobBudget เมื่อ locked |
| `0024_lbs_unit_cost.sql` | **ฟีเจอร์ (2026-07-22)**: ต้นทุนตัว LBS ต่อเครื่อง — `lbs_units.unit_cost` + `app_unit_cost` (อ่าน `cost` จาก unit JSONB, validate ≥0), drop+recreate `rpc_create_project_stock`/`rpc_add_units_to_stock` (คงพฤติกรรมเดิม + insert unit_cost) · ดึง LBS เข้า Job → บวก actual หมวด raw_mat (คิดฝั่ง client `jobBudgetSummary`+`jobLbsCost` ไม่ต้องแก้ RPC ดึง/คืน) · demo sync · UI: StocksPage คอลัมน์ "ต้นทุน/เครื่อง" (ฟอร์ม/ตาราง/Export·Import Excel) + badge มูลค่าคลัง, Modal สร้าง/รับเข้า = wide |
| `0025_import_units_upsert.sql` | **ฟีเจอร์ (2026-07-23)**: Import Serial แบบ upsert — `rpc_import_units_to_stock(p_new_units, p_update_units)`: รับเครื่องใหม่ (validation เดียวกับ add_units) + อัพเดท `unit_cost` เครื่องที่ match คู่ Serial (lvb+om) เฉพาะในคลังนี้ (cost ว่าง = คงเดิม) · UI แยก new/dup/conflict ใน import preview → ซ้ำในคลัง (คู่ตรง) ให้เลือก **อัพเดทต้นทุน / ข้าม(กรอกซ้ำผิด)**, ชนคลังอื่น·คู่ไม่ตรง = error · demo sync `logic.ts importUnitsToStock` · ใช้ `app_unit_cost` (0024) |
| `0027_delete_cancelled_accessory.sql` | **ฟีเจอร์ (2026-07-24)**: ลบรายการวัสดุที่ยกเลิกออกจากการ์ด — `rpc_delete_accessory_request` (Project/Division/Manage = dept project+sales+admin) ลบ job_accessory_requests ที่ `status='cancelled'` **และ** pr_id/po_id NULL (กัน PR/PO อ้างรายการที่หาย) · audit การยกเลิกยังอยู่ใน audit_logs · perm ใหม่ `accessory.cleanup` ฝั่ง client · demo sync `logic.ts deleteAccessoryRequest` |
| `0026_job_install_sites.sql` | **ฟีเจอร์ (2026-07-23)**: หลายจุดติดตั้งต่อ Job — `jobs.install_sites` JSONB (array `{location, requiredDate}` = จุดที่ 2+; จุดที่ 1 ยังใช้ install_location/required_date เดิม) · drop+recreate `rpc_create_job`/`rpc_update_job` (+`p_install_sites`) · ข้อมูลวางแผนอย่างเดียว ไม่ผูก Serial/ไม่แตะ flow issue/confirm · UI: เปิด/แก้ Job โชว์ "เพิ่มจุดติดตั้ง" เมื่อ LBS>1 (≤ จำนวน LBS), JobDetail แผง "จุดติดตั้ง", list badge "+N จุด" · demo sync `logic.ts` (normalizeInstallSites) |

> DB ใหม่บนโปรเจกต์เปล่า: รัน 0001→0027 เรียงกันได้เลย (0004/0005 ผสานเข้า 0001/0002 ต้นทางแล้ว แต่ยังเก็บไฟล์แยกไว้เป็นประวัติ · 0012/0013 ถูก 0014 ยกเลิกแต่ต้องรันเรียงเพราะ 0014 อ้างถึงของที่มันสร้าง — ทุกไฟล์ idempotent รันซ้ำได้)
> ⚠️ **production: รันเฉพาะ migration "ไฟล์ใหม่ที่ยังไม่เคยรัน" ก่อน push frontend** — ไม่ต้องรันไฟล์เก่าซ้ำทุกรอบ (ไฟล์ migration idempotent รันซ้ำได้ก็จริง แต่ไม่จำเป็น) และ **ห้ามรัน `cleanup_e2e.sql` ซ้ำเด็ดขาด** — มันลบ transaction ทั้งหมด (Jobs/LBS/audit) ใช้ครั้งเดียวตอนล้างระบบก่อนเปิดใช้จริงเท่านั้น มีสลักนิรภัยกันรันติดมือแล้ว (2026-07-19)

## 6. Environment variables (ตั้งใน Cloudflare Pages → Settings → Environment variables · Production)

| Key | ใช้ที่ไหน | หมายเหตุ |
|---|---|---|
| `VITE_SUPABASE_URL` | build (baked เข้า bundle) | `https://mrdnxajwnvkgvfyaclwv.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | build + functions | anon/publishable key (เปิดเผยได้) — functions ใช้ตรวจ token ด้วย |
| `SUPABASE_URL` | functions | เท่ากับ VITE_SUPABASE_URL |
| `SUPABASE_SERVICE_ROLE_KEY` | functions | **ความลับ** — admin-users function เท่านั้น |
| `LINE_CHANNEL_ACCESS_TOKEN` | functions | (optional) แจ้งเตือน LINE — จาก LINE Developers → Messaging API |
| `LINE_GROUP_ID` | functions | (optional) กลุ่มปลายทาง — กลุ่มทีมจริง = `C30dde10e5b1d4ce984a85016b79204cd` (ได้จากพิมพ์ `id` ในกลุ่ม 2026-07-16) |
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

## 8. แผนก + สิทธิ์ (RLS + app_assert_dept) — อัปเดต 2026-07-19

ชื่อแสดงผลเปลี่ยน (มติ 2026-07-19): `sales` → **"Division"**, `admin` → **"Manage"** (ค่าใน DB คงเดิม — แก้ที่ `DEPT_LABEL` ใน format.ts)

| แผนก (DB) | แสดงผล | ทำอะไรได้ |
|---|---|---|
| `sales` | **Division** | สร้าง/แก้/ลบ Project Stock, รับ LBS เข้า, แก้ Serial, ปรับยอดคลังสินค้า accessory + **อนุมัติ/ตีกลับคำขอจาก project** (หน้า "รออนุมัติ") |
| `project` | Project | เปิด/แก้/ลบ Job, ดึง-คืน LBS, ขอวัสดุ (+Phase Budget) — ส่วน **ออก PR / เบิกให้ Service / ยกเลิก Job ต้องส่งคำขอให้ Division อนุมัติ** (`rpc_request_approval`) |
| `purchasing` | Purchasing | ออก PO / ยกเลิก PO (ยังไม่รับของ) / ตีกลับ PR / รับของ (partial ได้) |
| `service` | Service | ยืนยันติดตั้งเสร็จ (+วันที่จริง) |
| `admin` | **Manage** | ทำได้ทุกอย่าง + **ข้ามขั้นอนุมัติ** (เรียก rpc_create_pr/issue/cancel ตรงได้) + อนุมัติแทน Division ได้ + Material Database + ผู้ใช้งาน + **Dev Settings (แผนกเดียวที่เห็น** — เมนูซ่อน + route redirect สำหรับแผนกอื่น) |

**Approval flow (0016)**: project ขอ → แจ้งเตือน Division → division/admin อนุมัติที่หน้า "รออนุมัติ" = **execute ทันทีใน transaction เดียว** (fail = rollback ทั้งคำขอ) หรือตีกลับพร้อมเหตุผล (แจ้งกลับ project) · คำขอ pending ซ้ำ type เดียวกันต่อ Job ไม่ได้ (unique partial index) · `rpc_create_pr`/`rpc_issue_job`/`rpc_cancel_job` เช็ค admin-only แล้ว — project ยิง RPC ตรงจะโดนปฏิเสธ

Job status (auto ทั้งหมด): `Draft → Allocated → Procuring Accessory → Ready to Issue → Issued → Installed` (+ `Cancelled` ได้ทุกสถานะก่อน Issued)

## 9. บั๊กที่เจอจาก E2E บน DB จริง + วิธีแก้ (institutional knowledge)

1. **rpc_issue_job บล็อกตัวเอง** — ตั้ง job=issued ก่อน update units → trigger `trg_block_issued_edit` กันแก้ allocation ของ job ที่ issued แล้ว → แก้: update units ก่อน แล้วค่อยตั้ง job (0004)
2. **notifications อ่านไม่เห็น** — ลืมใส่ RLS SELECT policy → app_notify insert ลงแต่ role authenticated อ่านไม่ได้ → แก้: เพิ่ม policy (0005)
3. **admin-users token invalid** — Supabase secret key แบบใหม่ (`sb_secret_`) ถูกจำกัดบน GoTrue auth endpoint → validate token ของผู้เรียกด้วย **anon key** แทน service key (commit `ab6e8e6`)
4. **rpc_cancel_job พังเงียบหลัง rename คอลัมน์** — 0006 rename `serial_no` → `serial_lvb` แต่ plpgsql ไม่ validate คอลัมน์ตอน CREATE FUNCTION → rpc_cancel_job (สร้างใน 0002) ยังอ้าง serial_no แล้วมา error ตอน "รัน" เท่านั้น (แก้: 0015) — **บทเรียน: rename คอลัมน์ต้อง grep หาทุก RPC ที่อ้างถึง แล้ว recreate ให้ครบ** (พังแบบเงียบ ไม่โผล่ตอนรัน migration)

> demo mode ไม่มี trigger/RLS/functions/plpgsql จึงไม่เจอบั๊กพวกนี้ — ต้องทดสอบบน DB จริงเท่านั้น

## 10. งานค้าง (TODO)

### 🔴 ความปลอดภัย (ทำก่อนใช้จริงจัง)
- [ ] **ลบ/ปิดบัญชีทดสอบ** — รัน **`supabase/cleanup_e2e_accounts.sql`** ใน SQL Editor (ปลอดภัยแม้มีข้อมูลจริงแล้ว:
      ปิดใช้งานทุกบัญชีทดสอบทันที + ลบตัวที่ลบได้ ตัวที่ยังถูกอ้างใน audit/jobs จะถูกข้าม)
      บัญชี: `e2e-runner@example.org` (เคยเป็น admin, รหัสผ่านเคยเปิดเผย), `e2e.tester.lbs@gmail.com`, `e2e-admin@example.com`, `fn-test-sales@example.org`
- [x] ~~รัน `supabase/cleanup_e2e.sql`~~ — **❌ ปิดรายการนี้ถาวร ห้ามรันอีก (2026-07-19)**: ระบบมีข้อมูลจริงแล้ว
      การรันซ้ำหลัง push ทำให้ LBS ที่รับเข้าคลังจริงถูกลบหมด (เหตุการณ์จริง 2026-07-19 — จำนวนเครื่องใน Project Stock หาย)
      ไฟล์ถูกใส่สลักนิรภัย (DO-block RAISE EXCEPTION) กันรันติดมือแล้ว · **หลัง push ไม่ต้องรัน SQL ใดๆ เว้นแต่มี migration ไฟล์ใหม่**
- [ ] ตรวจว่า **service_role key ถูก rotate แล้ว** (ระหว่าง setup key เก่าเคยเปิดเผย — ตรวจ repo แล้ว 2026-07-19: **key ไม่เคยหลุดลง git** หลุดเฉพาะนอก repo) — Dashboard → Settings → API → สร้าง/roll secret key ใหม่ → อัปเดต `SUPABASE_SERVICE_ROLE_KEY` บน Cloudflare Pages env → Retry deployment

### 🟠 Migrations — ✅ 0001–0026 รันครบ (0026 รัน 2026-07-23) · ⏳ 0027 รอรัน (2026-07-24)
- [x] ~~0011–0026~~ รันครบ · **กติกา: หลัง push ไม่ต้องรัน SQL ใดๆ เว้นแต่มี migration ไฟล์ใหม่ (ผมจะบอกชื่อไฟล์)**
- [ ] **รัน `0027_delete_cancelled_accessory.sql`** บน Supabase SQL Editor ก่อน/พร้อม push frontend — idempotent · เพิ่ม `rpc_delete_accessory_request` · ยังไม่รัน = ปุ่มลบรายการยกเลิกจะ error
- [ ] ยืนยัน bucket **`install-photos`** (public) มีจริง — ถ้า Service อัปโหลดรูปตอนยืนยันติดตั้งไม่ได้ ให้สร้างที่ Dashboard→Storage (0019 อาจสร้างผ่าน SQL ไม่ได้เรื่องสิทธิ์)

### 🟡 ฟีเจอร์เสริม (ตั้งค่าค้างอยู่)
- [ ] **เปิดสวิตช์ LINE** — env + code + migration 0017 พร้อมหมด · เหลือ: login **Manage** → Dev Settings → เปิดสวิตช์แจ้งเตือน LINE (global มีผลทุกเครื่อง) → "ส่งข้อความทดสอบ" · bot `สถานะ <Job No.>` ใช้ได้แล้ว
- [ ] **Custom domain** — `lbs.precise.co.th` (ขอ IT เพิ่ม CNAME → `lbs-platform-sdt.pages.dev`) แล้ว Add ใน Cloudflare Pages → Custom domains
- [ ] **service_role key rotate** (ดูหัวข้อ 🔴) — ยังไม่ยืนยันว่า rotate แล้ว

### 🟢 พัฒนาต่อ (ไอเดีย)
- หน้า forgot-password / เปลี่ยนรหัสตัวเอง (ตอนนี้ Manage reset ให้ที่ Dev Settings)
- รายงาน/analytics (stock movement, lead time ต่อ Job)

> ✅ เสร็จแล้ว (2026-07-24): Jobs Purchase Orders — ค้นหาวัสดุในโมดัลเพิ่มวัสดุ (พิมพ์กรอง) · โมดัลเพิ่มวัสดุ = wide · ลบรายการที่ยกเลิก(ยังไม่ผูก PR/PO)ออกจากการ์ด โดย Project/Division/Manage (0027)
> ✅ เสร็จแล้ว (2026-07-23): Material Database ใช้ "รหัส Epicor" เป็น key (ตัดช่อง "รหัส" ภายในทุกหน้า, client set code=Epicor — ไม่ต้อง migration) · fix null byte ใน logic.ts (ตัวคั่น costByKey เป็น `|`) · adjustStock validate ตัวเลข · Material Import เช็ค Epicor ซ้ำในไฟล์
> ✅ เสร็จแล้ว (2026-07-23): หลายจุดติดตั้งต่อ Job เมื่อ LBS>1 — install_sites JSONB, ฟอร์มเปิด/แก้ Job + แผงจุดติดตั้ง (0026) · เปิด Job Modal = wide
> ✅ เสร็จแล้ว (2026-07-23): Import Serial upsert — ซ้ำในคลัง (คู่ตรง) ให้เลือกอัพเดทต้นทุน/ข้าม, ชนคลังอื่นเป็น error (0025)
> ✅ เสร็จแล้ว (2026-07-22): Manage แก้งบได้แม้ Job ล็อก (0023) · ต้นทุนตัว LBS ต่อเครื่อง + มูลค่าคลัง + บวกเข้า raw_mat actual ตอนดึงเข้า Job (0024) · Purchase Orders (Jobs) Export Excel + Phase Budget โชว์ Phase ที่กรอก · Purchasing รายการรอออก PO แสดงครบคอลัมน์ + popup ออก PO กว้าง · Modal มี size variant `wide`
> ✅ เสร็จแล้ว (2026-07-19→20): Division approval flow (0016) + หน้า Awaiting Approval · LINE global switch + กันส่งซ้ำ + auth /line-notify (0017) · แก้ import customer_name + แจ้งรับเข้าคลัง (0018) · Service Check-in GPS + รูป (0019, Supabase Storage) · แจ้ง `lbs_drawn` แทน job_ready (0020) · **Project Budget ต้นทุน 7 หมวด** (0021) · **1 PR → หลาย PO** (0022) · ปริ้น PDF สรุปโครงการ · Manage แก้อีเมลผู้ใช้ (`set_email`) · rename เมนู (Project ID/Service (Installation)/Awaiting Approval) + Division/Manage · logo จริง + login gradient + topbar gradient · IBM Plex Sans Thai · responsive (mobile drawer)

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
- แก้ business rule ต้องอัปเดตทั้ง demo (`logic.ts`) และ LIVE (RPC ตัวล่าสุด — grep หา `CREATE OR REPLACE FUNCTION <ชื่อ>` ในทุก migration แล้วดูไฟล์ที่ใหม่สุด ไม่ใช่แค่ 0002)
- `.env`, `.env.*.local`, `.env.live-backup`, `node_modules` อยู่ใน `.gitignore` — อย่า commit
- **ปุ่มแก้ไข/ดึง LBS/ออก PR/เบิก/ยกเลิก/แก้งบ หายหมด** เมื่อ Job **ล็อก** (terminal_status = issued/installed/cancelled) — เช็ค badge สถานะข้างชื่อ Job · และแก้งบ/ออก PR ต้อง login เป็น **Project หรือ Manage** เท่านั้น (badge มุมซ้ายล่าง) · "ออก PR" โผล่เมื่อมีวัสดุ source purchasing รอออก PR (ต้อง `+ เพิ่มวัสดุ` ก่อน)
- **Job ค้างสถานะ อยากลบทิ้งเปิดเลขเดิมใหม่**: รัน `supabase/cleanup_job.sql` (แก้ `v_job_no`) — ลบเฉพาะ Job นั้น + คืน LBS เข้าสต็อก (ไม่ลบเครื่อง). ยกเลิก Job ปกติ (cancel) จะล็อกเลขไว้ (ยังเปิดเลขเดิมซ้ำไม่ได้) จึงต้องลบด้วยสคริปต์นี้
- **รัน demo mode ในเครื่อง** (ทดสอบ UI ไม่ยุ่ง production): `mv .env .env.bak` แล้ว restart dev server (หรือ `npm run dev -- --mode demo` ใช้ `.env.demo.local` ที่ค่าว่าง) — vite bake env ตอน start, เปลี่ยน .env ต้อง restart/stop-start ให้ module cache เคลียร์
