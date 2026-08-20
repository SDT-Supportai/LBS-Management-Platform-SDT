# HANDOFF — 115kV LBS Project Management Platform

เอกสารส่งมอบ/สรุปสถานะระบบ (อัปเดต 2026-08-14) — อ่านไฟล์นี้ก่อนดูแลระบบต่อ
ประกอบกับ [README.md](README.md) (ภาพรวม), [SETUP.md](SETUP.md) (คู่มือ deploy),
[VIDEO-SCRIPT.md](VIDEO-SCRIPT.md) (prompt + บทวีดีโอแนะนำระบบ), และ
`../lbs-stock-project-instructions (1).md` (business rules = source of truth ห้ามเปลี่ยนโดยไม่ยืนยัน)

---

## 1. ระบบนี้คืออะไร

ระบบจัดการ 115kV LBS (Load Break Switch) แบบครบวงจร 4 แผนก:
**Sales → Project → Purchasing → Service** ตั้งแต่รับ LBS เข้าคลังกลาง จนติดตั้งหน้างานเสร็จ
ทุกเครื่อง track ด้วย Serial คู่ (LVB + OM) รายเครื่อง มี audit log + แจ้งเตือนข้ามแผนกทุก transaction

**แผนที่เมนู UI ปัจจุบัน** (เรียงตาม sidebar · ชื่อไฟล์ใน `src/pages/` ยังเป็นชื่อเดิม เช่น JobsPage/ServicePage):
- **Project Stock (LBS)** (`StocksPage`) — **ตารางรายเครื่องมี Plan PO receipt / Plan Delivery (กดปฏิทิน) + Actual Delivery (auto จากวันยืนยันติดตั้งรายเครื่อง) + สถานะละเอียดตาม flow Service · Division/Manage กด "แก้ข้อมูล" ต่อแถวเพื่อกรอกต้นทุน/ลูกค้า(แผน)/วันแผน ได้ก่อนเบิก (0043) · **Import Excel อัพเดทช่องพวกนี้เป็นชุดได้ (0048 — ช่องว่าง = คงค่าเดิม · เครื่องที่มี Job ข้ามช่องลูกค้า · เครื่องที่เบิกแล้วข้ามทั้งแถว)** · คลัง LBS + ดูรายเครื่อง (ข้อมูลลูกค้า ref จาก Job) + Export/Import Excel ต่อคลัง · **ต้นทุนตัว LBS ต่อเครื่อง** กรอกตอนสร้าง/รับเข้า/Import (คอลัมน์ "ต้นทุน/เครื่อง") → badge "มูลค่าคลัง" = Σ ต้นทุน (0024) · **Import เจอ Serial ซ้ำ (คู่ตรงในคลังนี้) → ถามว่าอัพเดทต้นทุน/ข้าม** ส่วนที่ชนคลังอื่นหรือคู่ไม่ตรงเป็น error (0025) · ตอนสร้าง/แก้คลังมีช่อง **PO No.** + **Remark** (ว่างได้ · แก้ภายหลังได้, 0029)
- **Project ID (Jobs)** (`JobsPage`/`JobDetailPage`) — **Payment รายงวด (Advance / Progress-Delivery / PAC-Retention · Invoice No./Date/% → ยอดเงิน · รับเงินแล้วเมื่อ) เป็นพาเนลพับก่อนตาราง 7 หมวด (0044)** · เปิด Job, **Project Budget ต้นทุน 7 หมวด** (การ์ดแก้ได้/ตาราง Raw Material→Finance ซ่อนได้ · **Manage แก้งบได้แม้ Job ล็อก** 0023), ดึง-คืน LBS, ขอวัสดุ, ออก PR — ปุ่มออก PR/เบิก/ยกเลิกของ project เป็น "ขออนุมัติ" (Manage ทำตรง) · Purchase Orders มีปุ่ม **⬇ Export Excel** + คอลัมน์ Phase Budget โชว์ Phase ที่กรอกในงบ · **ดึง LBS เข้า Job → ต้นทุนเครื่องบวกเข้า actual หมวด Raw Material** (0024) · **หลายจุดติดตั้งต่อ Job เมื่อ LBS>1** (จุดที่ 1 = ฟิลด์เดิม + จุดที่ 2+ = install_sites, 0026) · ปุ่ม **🖨️ ปริ้นสรุปโครงการ (PDF)** · **ตาราง Purchase Orders เริ่มต้นซ่อน (2026-08-14)** — ปุ่ม `แสดงรายการ (n)` / `ซ่อนรายการ` · **ปุ่มทำรายการ (Export / เพิ่มวัสดุ / ออก PR) ยังอยู่ครบตอนซ่อน** ไม่ต้องกางก่อนถึงจะกดได้
- **Purchasing (PR/PO)** (`PurchasingPage`) — **แก้เลข PR ได้ (0047 · เฉพาะใบที่ยังไม่ออก PO — หน้า Project เห็นเลขใหม่เองทันที)** · จัดกลุ่มตาม Job, **1 PR → หลาย PO** (เลือกอุปกรณ์เข้าแต่ละ PO), ยกเลิก PO, ตีกลับ PR, รับของ partial · **รายการรอออก PO แสดงครบ** (Epicor, ชื่อ, จำนวน, ราคา/หน่วย, มูลค่า, Phase Budget) · popup ออก PO เป็น Modal กว้าง · สรุปประวัติ PR/PO ต่อ Job (ซ่อนได้) · **ตาราง PR และ PO เริ่มต้นซ่อน แยกปุ่มคนละตัวต่อ Job (2026-08-14)** — `แสดง PR รอออก PO (n)` / `แสดง PO (n)` · ป้ายบนหัวการ์ด ("มีรายการรอออก PO" / "PO รอรับของ n") บอกอยู่แล้วว่างานไหนต้องลงมือ จึงกางเฉพาะใบที่จะทำ · **⬇ Export PR รอออก PO → Excel template ขอราคา (2026-08-14)** 2 ระดับ: ปุ่มรวมทุกงานบนหัวหน้า (รวบยอดสั่งของประจำวัน) + ปุ่มต่อ Job ในการ์ด · 12 คอลัมน์ระบบเติมให้ + **5 คอลัมน์เว้นว่างให้ซัพพลายเออร์กรอก** (ราคาที่เสนอ/หน่วย · มูลค่าที่เสนอ · ยี่ห้อ-รุ่นที่เสนอ · กำหนดส่งได้ · หมายเหตุ) + ชีต "วิธีใช้" + autofilter · **export อย่างเดียว ไม่มี import กลับ** (ราคาจริงบันทึกที่ปุ่ม 💰 ราคาจริง หลังออก PO)
- **Service (Installation)** (`ServicePage`) — **ยืนยันติดตั้งรายเครื่อง** (per serial): แต่ละเครื่องบังคับ วันที่ + Check-in GPS + รูป + เลือกช่างผู้ติดตั้ง (0035/0036) · เครื่องที่ติดตั้งไม่ได้ระบุเหตุผลรายเครื่องได้ · **เลื่อนนัด/ติดปัญหาหน้างาน** (0034 — เลื่อนแล้ววันนัดของ Job ขยับเอง) · **มอบหมายทีมช่าง + หัวหน้าทีม** (0036) · **ปิดงานเป็นขั้นแยก** ต้องได้ข้อสรุปทุกเครื่อง + สำเร็จ ≥1 และ **บังคับสรุปปัญหา (มี/ไม่มี) + แนบไฟล์** ก่อนปิด (0040) · พาเนล **⚠️ ปัญหางานบริการ** รวมปัญหาจาก 3 แหล่ง (0041)
- **Service & Scheduling** (`ServiceSchedulingPage`) — **ทะเบียนทีมช่าง** (ชื่อ/สกุล/เบอร์/ตำแหน่ง · ผูกบัญชี login ได้ถ้ามี) + **ตารางงานรายบุคคล** (งานที่รับ + วันนัด + บทบาท + คืบหน้า) + เตือนงานที่เบิกแล้วยังไม่มอบหมายทีม (0036)
- **Material Database** (`MasterDataPage`) — **แยก 2 พาเนลชัดเจน**: (1) **ฐานข้อมูลวัสดุ** = รายการที่ใช้ออก PR/PO (รหัส Epicor/ชื่อ/หน่วย/การจัดหา) ไม่มียอด (2) **คลังคงเหลือ** = ของที่มีจริง (**Lot No.**/คงเหลือ/ต้นทุนถัวเฉลี่ย/มูลค่า) + ปรับยอด + **📜 ประวัติการเคลื่อนไหว** (ledger 0038) — ทั้ง 2 พาเนลซ่อนได้/เริ่มซ่อน · **ใช้ "รหัส Epicor" เป็นตัวระบุหลัก** (เบื้องหลัง client set `code`=Epicor คง schema เดิม) · Export/Import Excel **round-trip ครบ 6 คอลัมน์** (รวม การจัดหา + คลังคงเหลือ + Lot No. — เปลี่ยนยอดต้องใส่เหตุผล → ลง ledger) · **Lot No. รายวัสดุ (0055 · 2026-08-14)** — กรอกได้ 4 ทาง: โมดัล **ปรับยอด** (ช่องล็อตใช้เฉพาะขาเข้า เหมือนช่องต้นทุน) · โมดัล **+ เพิ่ม Accessory** · ปุ่ม **🏷 Lot** (แก้ล็อตอย่างเดียว ไม่แตะยอด ไม่ลง ledger) · **Import Excel** (ช่องว่าง = คงค่าเดิม · ล้างล็อตต้องใช้ปุ่ม 🏷 Lot) · ประวัติการเคลื่อนไหวมีคอลัมน์ Lot No. — **ขาเข้า = ล็อตที่กรอก · ขาออก = ล็อตที่อยู่ในคลังขณะนั้น** (ตอบได้ว่าของที่เบิกไป Job เมื่อไหร่เป็นล็อตไหน)
- **Standard Drawing & BOM** (`StandardsPage`) — **เอกสารมาตรฐานของ LBS (0045)**: แท็บ **Standard Drawing** (หัวข้อ/เลขแบบ + แนบ PDF ให้ทุกแผนกโหลด · แก้ไขแล้ว stamp วันที่/ผู้แก้ไข/หมายเหตุ) และแท็บ **Standard BOM List** (หัวข้อ BOM + รายการ Epicor/ชื่อ/จำนวน/หน่วย/ต้นทุนประมาณการ + มูลค่ารวม + **Export / Import Excel** — Import มี preview + เลือกเพิ่มต่อท้าย/แทนที่ทั้งหมด, 0046) · **ทุกแผนกดู/ดาวน์โหลดได้ · เพิ่ม/แก้ได้เฉพาะ Project/Division/Manage**
- **Awaiting Approval** (`ApprovalsPage`) — คิวคำขอจาก project ให้ Division ตัดสิน + ประวัติแยกตาม Job (ซ่อนได้) · badge จำนวนค้าง · **อยู่ล่าง Material Database**
- **Dev Settings** (`DevSettingsPage`) — เฉพาะ Manage: ผู้ใช้งาน (เพิ่ม/แก้ชื่อ-อีเมล-รหัส-แผนก), สวิตช์ LINE (global), backup — **Audit Log** ปุ่มล่าง sidebar

## 2. สถานะปัจจุบัน — 🟢 LIVE บน production

> ✅ **0055 + 0056 รันบน production แล้ว (2026-08-20)** — Lot No. คลังคงเหลือ · สลับ LBS พาต้นทุน/FOB/ETA ไปกับ Serial
>
> 🟠 **ค้างอยู่ตอนนี้ (2026-08-20)**: ชุดแก้จาก code review รอบ 2 (#2 #3 #4) อยู่ที่ repo แล้ว **ยังไม่ push**
> SQL ลงครบแล้ว → **push ได้เลย** (0056 ไม่เปลี่ยน signature จึงไม่มีเรื่อง `PGRST202`)
> ⚠️ **ต้องทำด้วยคน 1 อย่าง**: งานที่ **เคยสลับ LBS ก่อน 0056** ต้นทุน/ETA ยังผูกผิดอยู่ (0056 ไม่ auto-repair)
> `SELECT created_at, detail FROM audit_logs WHERE action = 'swap_lbs_serial' ORDER BY created_at DESC;`
> → ถ้ามีแถว ให้ Division เทียบ `unit_cost` รายเครื่องกับ Serial จริงหน้างาน แล้วแก้ผ่าน "แก้ข้อมูล" ในหน้า Project Stock
> (เครื่องที่ยังไม่เบิกแก้ได้ · เครื่องที่ `issued` แล้ว `trg_block_issued_edit` ล็อก — ต้องแก้ที่งบ Job ตรงๆ)

| ส่วน | ค่า / สถานะ |
|---|---|
| Hosting | **Cloudflare Pages — LIVE แล้ว** https://lbs-platform-sdt.pages.dev (ย้ายจาก Netlify 2026-07-15, auto-deploy จาก `main`) |
| GitHub repo | https://github.com/SDT-Supportai/LBS-Management-Platform-SDT (root = โฟลเดอร์นี้) |
| Supabase project ref | `mrdnxajwnvkgvfyaclwv` (region: ตามที่สร้าง) |
| Migrations ที่รันแล้ว | **0001–0056 รันครบ** (0042–0048 รัน 2026-08-07 · 0049–0054 รัน 2026-08-08 · **0055–0056 รัน 2026-08-20**) · ถ้า LINE ไม่ส่ง เช็คตาราง `app_settings` (0017) · อัปโหลดรูป/ไฟล์แนบไม่ได้ เช็ค bucket `install-photos` (0019 — ไฟล์แนบปัญหา prefix `job-issues/` · Drawing `standard-drawings/` · Price list `standard-prices/`) |
| E2E บน DB จริง | ✅ ผ่านทั้ง flow · demo E2E: approval, LINE dispatch, budget 7 หมวด, 1 PR→N PO (12/12), check-in/photo, ยืนยันรายเครื่อง, โอนวัสดุเข้าคลัง, Import Excel แก้ยอด, ปิดงาน+สรุปปัญหา, reopen, FOB/ETA + Status flow, VIP comment, guard ห้ามเบิกเมื่อของยังไม่ถึงคลัง |
| ตรวจ LIVE แบบไม่แตะข้อมูล | probe ผ่าน PostgREST ด้วย anon key — **อ่าน §9 ข้อ 12 ก่อนใช้** (มีกับดัก 3 อย่างที่ทำให้ได้ false positive ทั้งชุด) · โดยย่อ: `GET /rest/v1/<table>?select=<col>` → 200 = มี · `42703`/`PGRST205` = ไม่มี · `POST /rest/v1/rpc/<fn>` **ต้องส่งชื่อพารามิเตอร์ให้ตรง signature + ส่ง body ผ่านไฟล์** → `42501 permission denied` = มีจริง · `PGRST202` = ไม่มี signature นั้น |
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
    line-webhook.js          POST /line-webhook — **ในกลุ่มไม่ตอบอะไรเลย (แจ้งเตือนเท่านั้น)** · 1:1 ผูกบัญชี/อนุมัติ
  public/
    _redirects               SPA fallback (/* → /index.html 200)
    logo.jpg                 โลโก้จริง (เสาส่งไฟในวงกลม) — ใช้ทั้ง login/sidebar/favicon (refs = /logo.jpg)
  supabase/
    migrations/0001..0054    schema, RPC, seed, bug fixes, ฟีเจอร์ (ดูตารางหัวข้อ 5)
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
| `0031_shorten_notify_messages.sql` | **ปรับปรุง (2026-07-25)**: ย่อข้อความแจ้งเตือน LINE ทุก workflow (15 ประเภท) — ใช้ `pg_get_functiondef`+`replace()` เปลี่ยนเฉพาะสตริงใน `app_notify` **คง body เดิม 100% (ไม่ regress logic)** · idempotent (ข้ามถ้าแก้ไปแล้ว) · helper `app_shorten_notify` drop ทิ้งท้าย · demo sync `logic.ts` · **หมายเหตุ:** LINE คิดโควตาเป็น *จำนวนข้อความ* ไม่ใช่ความยาว — การย่อช่วยอ่านง่าย ไม่ลดโควตา (ลดโควตาจริงต้องลดจำนวนแจ้ง) |
| `0030_po_actual_price.sql` | **ฟีเจอร์ (2026-07-25)**: Purchasing บันทึกราคาจริงหลังออก PO — `rpc_update_po_line_price` (dept purchasing+admin) แก้ `unit_price` ของรายการที่ po_id ไม่ว่าง + status po_ordered/received + Job ยังไม่ล็อก · ราคาเดียว (จริงทับประมาณการ → กระทบงบ actual ทันที) · demo sync `logic.ts updatePoLinePrice` · UI: ปุ่ม 💰 ราคาจริง ต่อรายการในตาราง PO หน้า Purchasing |
| `0029_project_stock_po_no.sql` | **ฟีเจอร์ (2026-07-24)**: Project Stock + `po_no` (PO No. ว่างได้ · แก้ภายหลังได้) — drop+recreate rpc_create_project_stock/rpc_update_project_stock (+p_po_no) คงพฤติกรรมเดิม · Remark ใช้ notes เดิม (relabel UI) · demo sync `logic.ts` |
| `0028_swap_lbs_approval.sql` | **ฟีเจอร์ (2026-07-24)**: สลับเลข Serial LBS (LVB+OM เป็นคู่) ระหว่างเครื่อง allocated กับเครื่อง in_stock — ผ่าน Division อนุมัติ (Manage ตรง) · approval type ใหม่ `swap_lbs` (ALTER CHECK) + `app_exec_swap_lbs` (แลกคู่เลขผ่านค่าชั่วคราวกันชน unique) + `rpc_swap_lbs` + ต่อ rpc_request_approval/approve/reject · ทำได้หลังดึง LBS จนถึงก่อน issued (assertJobEditable) · เครื่องไม่ย้าย/ไม่แตะ accessory · demo sync `logic.ts swapLbs` |
| `0027_delete_cancelled_accessory.sql` | **ฟีเจอร์ (2026-07-24)**: ลบรายการวัสดุที่ยกเลิกออกจากการ์ด — `rpc_delete_accessory_request` (Project/Division/Manage = dept project+sales+admin) ลบ job_accessory_requests ที่ `status='cancelled'` **และ** pr_id/po_id NULL (กัน PR/PO อ้างรายการที่หาย) · audit การยกเลิกยังอยู่ใน audit_logs · perm ใหม่ `accessory.cleanup` ฝั่ง client · demo sync `logic.ts deleteAccessoryRequest` |
| `0032_swap_lbs_notify.sql` | **fix (2026-07-26)**: `app_exec_swap_lbs` เดิมมีแค่ audit → เติม `app_notify('lbs_swapped', …, 'all')` ให้สลับ LBS มีข้อความ action ชั้น 1 (`🔁`) เหมือนอีก 3 ประเภทที่อนุมัติผ่าน Division · demo sync `logic.ts swapLbs` |
| `0033_line_approval.sql` | **ฟีเจอร์ (2026-07-26)**: **อนุมัติผ่าน LINE แชทส่วนตัว (1:1)** — `profiles.line_user_id` (unique) + ตาราง `line_link_codes` (โค้ด 6 หลัก อายุ 10 นาที) + `rpc_line_gen_code` (authenticated) + `app_line_bind` / `rpc_line_approve` (**service_role เท่านั้น** — กัน user อนุมัติแทนคนอื่น) + refactor แยก `app_exec_approve` ให้เว็บ(JWT) และ LINE ใช้ร่วม · **LINE อนุมัติอย่างเดียว — ตีกลับต้องทำบนเว็บ (ต้องมีเหตุผล)** · คู่กับ `functions/line-approval-push.js` (Flex card ปุ่มอนุมัติ) + `line-webhook` (postback + ผูกโค้ด) · คงแจ้งเตือนกลุ่มเดิมไว้ |
| `0034_site_visit.sql` | **ฟีเจอร์ (2026-07-27) เฟส A**: Service บันทึกออกหน้างานที่ยังไม่จบ — ตาราง `job_site_visits` + `rpc_log_site_visit` (service+admin): `rescheduled` = **อัปเดต install_start/end_date ของ Job ให้เอง** · `failed` = บันทึกปัญหาไว้ (Job ยังเป็น issued ไม่ปิด) · demo sync `logic.ts logSiteVisit` |
| `0035_unit_install.sql` | **ฟีเจอร์ (2026-07-27) เฟส B**: **ยืนยันติดตั้งรายเครื่อง** — ตาราง `unit_installations` (log หลายแถว/เครื่อง → **แถวล่าสุดชนะ**) + view `v_unit_install_state` + `rpc_confirm_unit_install` (บังคับ วันที่+GPS+รูป ต่อเครื่อง) / `rpc_block_unit_install` (เครื่องติดตั้งไม่ได้ → แจ้ง Project) / `rpc_close_job_install` (ปิดงานเป็นขั้นแยก: ทุกเครื่องต้องได้ข้อสรุป + สำเร็จ ≥1) + backfill งานที่ปิดไปแล้ว · **⚠️ เก็บตารางแยกไม่ใช่คอลัมน์บน lbs_units เพราะ trigger `trg_block_issued_edit` (0001) บล็อก UPDATE lbs_units ตอน job = issued** · Job คงสถานะ issued พร้อมตัวเลข x/y จนกดปิดงาน → ไม่ต้องแก้ `v_job_status`/`deriveJobStatus`/`STATUS_TH` ของบอท |
| `0036_service_team.sql` | **ฟีเจอร์ (2026-07-28) เฟส C**: ทะเบียนทีมช่าง + มอบหมายงาน — `team_members` (ชื่อ/สกุล/เบอร์/ตำแหน่ง + `user_id` nullable) + `job_assignments` (หลายคน/งาน + ธงหัวหน้าทีม) + `unit_installations.installed_by_member_id` (**ช่างที่ลงมือติดตั้ง ≠ performed_by ที่เป็น user ผู้บันทึก**) + 4 RPC + `rpc_confirm_unit_install` signature ใหม่ (+p_member_id, drop+recreate) · **แยกจาก profiles เพราะ `profiles.id` อ้าง `auth.users` (ทุก user ต้องมีบัญชี login) และไม่มีฟิลด์เบอร์/ตำแหน่ง → ช่างภาคสนาม/outsource ใส่เป็น user ไม่ได้** · มอบหมายเป็น "แผนงาน" ไม่ใช่ "สิทธิ์" (RPC ยังตรวจ `app_assert_dept` ตามเดิม) |
| `0037_extra_purchase_after_issue.sql` | **ฟีเจอร์ (2026-07-30)**: **จัดซื้อเพิ่มเติมหลังเบิก** — แยก guard เป็น 3 ระดับ: `app_assert_job_editable` (เดิม — scope/allocation/LBS ล็อกตั้งแต่ issued, **ไม่แตะ**) · `app_assert_job_procurable` (เพิ่มวัสดุ/ออก PR → ถึง issued, ปิดเมื่อ installed/cancelled) · `app_assert_job_cost_editable` (แก้ราคาจริงย้อนหลัง → ได้แม้ installed เพราะใบแจ้งหนี้มาช้ากว่าของ) + `app_assert_job_editable_for(jid, req_type)` ให้ `rpc_request_approval` แยกตามประเภท (create_pr ผ่านได้หลังเบิก · issue/cancel/swap ล็อกตามเดิม) · **ใช้ `app_swap_guard` patch เฉพาะบรรทัด guard ทุก overload + verify block ตอนท้าย** |
| `0038_stock_ledger.sql` | **ฟีเจอร์ (2026-07-30) เฟส S1**: **คลังคงเหลือ = ledger + ต้นทุนถัวเฉลี่ย** — ตาราง `stock_movements` (qty +เข้า/−ออก + balance_after + ref job/request) + `accessory_stock.avg_unit_cost` (moving average) + `job_accessory_requests.qty_transferred` + `rpc_transfer_job_material_to_stock` (**โอนวัสดุเหลือจาก Job เข้าคลัง — ของที่ซื้อผ่าน PO ก็โอนได้ · ต้นทุนโอนตามของ**: ตัดมูลค่าออกจาก Job ต้นทางตามจำนวน) + backfill ยอดตั้งต้น · **⚠️ ใช้ BEFORE TRIGGER `trg_log_stock_movement` บน accessory_stock ไม่ใช่การ patch 6 RPC** (accessory_stock ถูกเขียนจาก add_accessory_request/return_accessory/cancel_job/create_item/update_item/adjust_stock กระจาย 0002/0006/0015/0016/0017) → ยอดเปลี่ยนที่ไหนก็ลง ledger เสมอ **bypass ไม่ได้** + คิดค่าเฉลี่ยในตัว · บริบท (ประเภท/Job/หมายเหตุ) ส่งผ่าน `app_set_stock_ctx` (transaction-local) ถ้าไม่ตั้ง = บันทึกเป็น `adjust` |
| `0039_stock_cost_input.sql` | **fix (2026-07-30)**: 0038 คิดค่าเฉลี่ยได้ แต่ **"ขาเข้า" 2 ทางไม่มีที่ให้ใส่ต้นทุน** (ตั้งยอดตอนสร้างวัสดุ / ปรับยอดขึ้น) → คอลัมน์ต้นทุน/มูลค่าขึ้น `-` ตลอด · เพิ่ม `rpc_create_item + p_initial_unit_cost` และ `rpc_adjust_accessory_stock + p_unit_cost` (drop+recreate — **ทั้ง 2 ตัวไม่มี app_notify จึง recreate ได้ ไม่กระทบ 0031**) · ใส่ได้เฉพาะขาเข้า · **พารามิเตอร์ใหม่มี DEFAULT → เรียกแบบเดิมยังได้ (backward compatible)** |
| `0040_close_job_issues.sql` | **ฟีเจอร์ (2026-07-31)**: **บังคับสรุปปัญหาก่อนปิดงานติดตั้ง** — `jobs.close_has_issues` / `close_issue_detail` / `close_issue_file_url` + `rpc_close_job_install` signature ใหม่ (+p_has_issues/p_issue_detail/p_issue_file_url, validate ฝั่ง server ด้วย) · เก็บ**แยกจาก install_note** เพื่อ query/รายงานได้ · ไฟล์แนบใช้ bucket `install-photos` เดิม prefix `job-issues/<job_id>/` (ไม่ต้องสร้าง bucket ใหม่) · งานที่ปิดก่อน 0040 = NULL (ไม่ผิด แค่ไม่มีข้อมูล) |
| `0041_reopen_job.sql` | **ฟีเจอร์ (2026-07-31)**: **เปิดงานใหม่หลังปิดผิด (Reopen) ผ่านการอนุมัติ Division** — approval type ใหม่ `reopen_job` (ALTER CHECK) + `app_assert_job_reopenable` + `app_exec_reopen_job` + `rpc_reopen_job` (admin ตรง) + ต่อ `app_exec_approve` · **unit_installations คงไว้ทั้งหมด** (ปิดใหม่ได้ทันที ไม่ต้องถ่ายรูป/GPS ซ้ำ) แต่**ล้าง** installed_at/install_note/install_confirmed_by/close_* (ถ้าไม่ล้างจะมีงาน issued ที่มีวันปิดงานค้าง = รายงานเพี้ยน) โดยคัดลอกลง audit ก่อน + `jobs.reopen_count` · **Project ขอ (สิทธิ์ job.manage) / Manage ทำตรง — ไม่เปิดให้ Service ขอ เพราะจะพลอยขอ PR/เบิก/ยกเลิกได้** |
| `0042_job_ownership.sql` | **ฟีเจอร์ (2026-08-03)**: **สิทธิ์ระดับแถว — Project ทำรายการได้เฉพาะ Job ที่อีเมลตัวเองเปิด** (`jobs.opened_by` ที่มีอยู่แล้วตั้งแต่ 0001 ไม่ต้อง backfill) · Job อื่น **ดูได้อย่างเดียว** (RLS `read_all` คงเดิม) · `app_assert_job_owner(j jobs)` เสียบเข้า guard chain 4 ตัว (`editable`/`procurable`/`cost_editable`/`reopenable`) = **ครอบ ~12 RPC ในจุดเดียว** + เติมมือที่ `rpc_delete_accessory_request` (recreate ได้ ไม่มี app_notify) และ `rpc_transfer_job_material_to_stock` (**app_swap_guard บรรทัดเดียว** เพราะมี app_notify) · **กติกา 3 ข้อกันพังของเดิม**: บังคับเฉพาะ `department='project'` (Purchasing/Service/Division ข้ามงานได้ตามหน้าที่) · `auth.uid()` ไม่เจอโปรไฟล์ → ข้าม (**ไม่งั้นอนุมัติผ่าน LINE 0033 พังหมด** เพราะรันด้วย service_role) · หลังอนุมัติ `app_exec_*` รันด้วย uid ผู้อนุมัติ → ข้ามเอง · `opened_by IS NULL` = งานเก่า ไม่ล็อก (grandfather) · **ไม่มีปุ่มโอนเจ้าของ (มติ): คนลาออก/ลาพักร้อนให้ Manage ทำแทน** · RLS `project_jobs` รัดเป็น owner-scoped เป็น defense-in-depth · demo sync `logic.ts` (`assertJobOwner`) · UI: JobsPage คอลัมน์ "ผู้รับผิดชอบ" + badge "ของฉัน" + checkbox กรองเฉพาะงานตัวเอง · JobDetail แบนเนอร์ 🔒 โหมดดูอย่างเดียว + ซ่อนปุ่ม action ทั้งหน้า |
| `0043_lbs_unit_plan.sql` | **ฟีเจอร์ (2026-08-04)**: **ข้อมูลแผนรายเครื่องในคลัง LBS + แก้ต้นทุนรายแถว** — `lbs_units` + `plan_customer_name`/`plan_contact_phone`/`plan_install_location`/`plan_po_receipt_date`/`plan_delivery_date` + `rpc_update_unit_plan` (dept sales = Division/Manage) · **ไม่ย้อน 0014**: คอลัมน์ตั้งชื่อ `plan_*` = ข้อมูล**แผน**ก่อนผูก Job (เดิมเครื่องที่ยังไม่มี Job โชว์ `-` ทั้งแถว วางแผนไม่ได้) — ตารางแสดงค่าจาก **Job ชนะ** เมื่อผูกแล้ว ถ้ายังไม่มี Job ใช้ค่าแผน + ป้าย "แผน" · **Actual Delivery + สถานะติดตั้ง = derive จาก `unit_installations` (0035) ไม่เก็บคอลัมน์ซ้ำ** → ไม่ต้อง backfill และ reopen (0041) สะท้อนเอง · ⚠️ **แก้ได้เฉพาะเครื่องที่ยังไม่ถูกเบิก** (`status <> 'issued'`) เพราะ trigger `trg_block_issued_edit` (0001) บล็อก UPDATE lbs_units ทุกคอลัมน์เมื่อ Job = issued/installed · demo sync `logic.ts updateUnitPlan` + helper `unitInstallDate` · UI: StocksPage 3 คอลัมน์ใหม่ (Plan PO receipt / Plan Delivery / Actual Delivery) + ปุ่ม "แก้ข้อมูล" ต่อแถว + สถานะละเอียด (เบิกแล้วรอติดตั้ง/ติดตั้งแล้ว/ติดตั้งไม่ได้) + Export Excel ครบคอลัมน์ใหม่ |
| `0044_job_payments.sql` | **ฟีเจอร์ (2026-08-04)**: **Payment ต่อ Job** (Advance / Progress or Delivery / PAC or Retention) — ตาราง `job_payments` (**หลายงวดต่อประเภทได้** · `seq` นับในประเภทนั้น) + `rpc_add/update/delete_job_payment` + helper `app_payment_amount` (ใส่ % ของราคาขาย → คำนวณยอด หรือกรอกยอดตรงๆ) · **สิทธิ์ Project (เจ้าของงาน ตาม 0042) + Manage** · **เก็บทั้ง `percent` และ `amount` + `base_sale_price`**: amount freeze ณ วันบันทึก เพราะราคาขายแก้ย้อนหลังได้ (0023) ถ้าเก็บแค่ % ยอดในใบแจ้งหนี้ที่ออกไปแล้วจะขยับเองเงียบๆ → UI เตือนเมื่อ base เปลี่ยน · **guard = `app_assert_job_cost_editable`** (แก้ได้แม้ปิดงานแล้ว) ไม่ใช่ `app_assert_job_editable` เพราะ PAC/Retention เกิดหลังติดตั้งเสมอ — และ guard ตัวนี้เรียก `app_assert_job_owner` (0042) ให้อยู่แล้ว · `paid_at` = รับเงินแล้วเมื่อ (ว่าง = รอรับเงิน) · **ลบงวดที่รับเงินแล้วไม่ได้** · ไม่บล็อก Σ งวด > ราคาขาย (variation order มีจริง) UI เตือนสีแดงแทน · **ไม่ยิง app_notify** (ออกใบถี่ + เข้ากลุ่ม LINE รวม) · UI: พาเนลพับ **ก่อน** "รายละเอียดต้นทุน 7 หมวด" ในการ์ด Project Budget สไตล์เดียวกัน + 4 การ์ดสรุป (ออกใบแล้ว/รับเงินแล้ว/รอรับเงิน/ยังไม่ออกใบ) |
| `0045_standards.sql` | **ฟีเจอร์ (2026-08-04)**: **เมนู Standard Drawing and BOM List** (`/standards`) — 3 ตาราง `std_drawings` / `std_boms` / `std_bom_lines` + 9 RPC (create/update/delete ทั้ง 3 ระดับ) + `app_assert_standards()` = dept `project`+`sales` (+admin auto) · **อ่าน/ดาวน์โหลดได้ทุกแผนก** (policy `read_all`) · **Drawing**: 1 แบบ = 1 แถว + PDF · แก้ไข = **ทับข้อมูลเดิม + stamp `updated_at`/`updated_by`/`rev_note`** ไม่เก็บตาราง revision (มติ) — แต่ **path ไฟล์ใหม่ทุกครั้ง ไม่ทับ object เดิมใน Storage** และ audit บันทึก `URL เก่า → ใหม่` ไว้ ถ้าต้องย้อนดูแบบก่อนแก้ · PDF อยู่ bucket เดิม `install-photos` prefix `standard-drawings/` (ไม่ต้องสร้าง bucket ใหม่ · ⚠️ bucket เป็น public read) · **BOM**: หัวข้อ + รายการ (Epicor/ชื่อ/จำนวน/หน่วย/ต้นทุนประมาณการ) · line ผูก `items` เป็นหลัก (เลือกแล้วเติม Epicor/ชื่อ/หน่วยให้เอง) แต่ `item_id` ว่างได้ = free text สำหรับของที่ยังไม่เข้า Material Database (ติดป้ายในตาราง) · **ยังไม่ต่อเข้า flow ขอวัสดุของ Job** (มติ — ถ้าจะต่อ: loop line ที่มี `item_id` → `rpc_add_accessory_request`, ต้นทุนประมาณการ → `p_unit_price`) · Export Excel ต่อ BOM · demo sync `logic.ts` (create/update/delete std* + `stdBomSummary`) · perm ใหม่ `standards.manage` |
| `0046_std_bom_import.sql` | **ฟีเจอร์ (2026-08-04)**: **Import Excel เข้า Standard BOM** — `rpc_import_std_bom_lines(p_bom_id, p_lines JSONB, p_replace BOOLEAN)` **RPC เดียวรับทั้งชุด (atomic)** ไม่ให้ client loop เรียก add ทีละบรรทัด (พังกลางทาง = rollback ทั้งชุด · pattern เดียวกับ `rpc_import_units_to_stock` 0025) · 2 โหมดเลือกในหน้า preview: **เพิ่มต่อท้าย (default)** / **แทนที่ทั้งหมด** (ลบรายการเดิมก่อน — ไฟล์เป็น source of truth · UI เตือนสีแดงว่าจะลบกี่รายการ) · หัวตารางตรงกับไฟล์ที่ Export ออกไป (`รหัส Epicor / ชื่ออุปกรณ์ / จำนวน / หน่วย / ต้นทุนประมาณการ-หน่วย / หมายเหตุ` — คอลัมน์ `#` / มูลค่า / ผูกฐานข้อมูล ถูกข้าม) รับ header อังกฤษด้วย · **ผูก items จาก `epicor_code` แล้วค่อย `code` ให้อัตโนมัติ + เติมชื่อ/หน่วยจาก master ให้ช่องที่ไฟล์เว้นว่าง** · ไม่เจอ = free text · validate ทั้งฝั่ง client (preview บอกเลขแถวที่ผิด + ปิดปุ่มนำเข้า) และฝั่ง server ซ้ำ · **Export ของ BOM ว่างจะออกไฟล์หัวตารางเปล่าเป็นแบบฟอร์ม** ให้กรอกแล้ว Import กลับได้ · demo sync `logic.ts importStdBomLines` |
| `0047_pr_no_edit.sql` | **ฟีเจอร์ (2026-08-05)**: **Purchasing แก้เลข PR ได้** — `rpc_update_pr_no` (dept purchasing +admin) · แก้ได้**เฉพาะใบที่ยังไม่ออก PO** (`status='pending'`) ออก PO แล้วล็อก · unique + ยาว ≤50 · **ไม่แจ้งเตือน ลงแต่ audit** (มติ) เพราะ `pr_no` เก็บที่เดียว หน้า Project (การ์ดวัสดุ/ประวัติ PR/Export) join อ่านจากแถวเดียวกัน → **เห็นเลขใหม่เองทันที ไม่มี snapshot ที่ต้อง sync** · ⚠️ ข้อความแจ้งเตือน/audit เก่าที่เขียนเลข PR ไว้เป็นข้อความ **ไม่แก้ตามโดยเจตนา** = บันทึกประวัติ ณ เวลานั้น · demo sync `logic.ts updatePrNo` · UI: ปุ่ม "✏️ แก้เลข PR" ใต้เลข PR ในตารางรอออก PO |
| `0048_import_unit_plan.sql` | **ฟีเจอร์ (2026-08-05)**: **Import Excel อัพเดทข้อมูลแผนรายเครื่องได้** — recreate `rpc_import_units_to_stock` **โดยไม่เปลี่ยน signature** (payload เป็น jsonb เติม key ใหม่ได้เลย → ไม่มีความเสี่ยง PGRST202 ตาม §9.8 · เรียกแบบเดิมยังได้) รับเพิ่ม `customer`/`phone`/`location`/`plan_po_receipt`/`plan_delivery` ทั้งขา insert และ update · **3 กติกา**: (1) **ช่องว่างในไฟล์ = คงค่าเดิม ไม่ล้างค่า** (ต่างจาก modal แก้รายเครื่องที่ว่าง = ล้าง — ไฟล์กรอกไม่ครบไม่ควรลบข้อมูลคนอื่น) (2) **ลูกค้า/เบอร์/สถานที่ เขียนเฉพาะเครื่องที่ `job_id IS NULL`** เพราะเครื่องที่มี Job ค่าจริงมาจาก Job (กฎ 0014) — ไฟล์ Export เขียนคอลัมน์ลูกค้าจาก Job ถ้า import กลับต้องไม่เขียนย้อนลง unit (3) **ข้ามเครื่องที่เบิกแล้ว (`status='issued'`) + นับรายงาน** เพราะ trigger `trg_block_issued_edit` บล็อก UPDATE ทั้งแถว ถ้าไม่กันไว้เครื่องเดียวทำให้ทั้งไฟล์ error · client อ่าน Excel ด้วย `cellDates: true` + `toIsoDate()` กันเซลล์วันที่กลายเป็น serial number · preview บอกผลรายแถว (อัพเดท / ข้าม (ใช้ค่าจาก Job) / 🔒 เบิกแล้ว ข้าม) · demo sync `logic.ts importUnitsToStock` |
| `0049_fob_eta_to_wh.sql` | **ฟีเจอร์ (2026-08-08)**: **FOB date + ETA to WH + Status (Pending / On Hand) รายเครื่อง** — `lbs_units.fob_date` (คอลัมน์ใหม่ **ตัวเดียว**) · **ETA to WH = FOB + 60 วัน และ Status = คำนวณตอนแสดงผล ไม่เก็บคอลัมน์** (Status ต้องเปลี่ยนเองเมื่อวันผ่านไป — เก็บลง DB เมื่อไหร่ก็ค้าง ต้องมี cron มาไล่อัปเดต · pattern เดียวกับ Actual Delivery ของ 0043 ที่ derive จาก `unit_installations`) · **ไม่เพิ่มคอลัมน์วันที่ตัวที่ 3**: `plan_po_receipt_date` (0043) ความหมายคือ "วันที่ของเข้าคลัง" = ETA อยู่แล้ว → ใช้เป็น **ETA แบบกรอกเอง** สำหรับล็อตที่ไม่รู้ FOB (ข้อมูลเดิมไม่ต้อง migrate) · **ไม่ระบุ ETA = On Hand** (เครื่องที่รับเข้าโดยไม่บันทึกกำหนดเรือ = ของอยู่ในคลังจริง → ข้อมูลเดิมทั้งหมดยังถูกต้อง) · มี FOB แล้วระบบล้าง `plan_po_receipt_date` ทิ้งเสมอ (แหล่งความจริงเดียว) · **DROP** `rpc_update_unit_plan` 7 args แล้ว recreate 8 args (+`p_fob_date`) ตาม §9.8 กัน PGRST203 · `rpc_import_units_to_stock` รับ key `fob` (signature เดิม ไม่เสี่ยง PGRST202) · **`rpc_set_stock_fob` ใหม่** = ตั้ง FOB ทั้งคลังครั้งเดียว (`p_overwrite` false = เติมเฉพาะที่ยังว่าง) · **ไม่แตะ `rpc_create_project_stock`/`rpc_add_units_to_stock`** เพราะ 0031 patch สตริงแจ้งเตือนไว้ (§9.5) · demo sync `logic.ts`: `unitEta` / `unitStockState` / `setStockFob` / `updateUnitPlan` / `importUnitsToStock` |
| `0050_vip_review.sql` | **ฟีเจอร์ (2026-08-08)**: **แผนก VIP (ผู้บริหารสูงสุด) + ความเห็นบนคำขออนุมัติ** — ขยาย CHECK `profiles_department_check` ให้รับ `'vip'` (ใช้ชื่อ constraint เดิมตาม §9.9) · ตาราง `approval_comments` (request_id → approval_requests ON DELETE CASCADE, body ≤1000 ตัวอักษร, author_id) + RLS อ่านได้ทุกแผนก เขียนผ่าน RPC เท่านั้น + เข้า realtime publication · `rpc_add_approval_comment` (`app_assert_dept(['vip','sales'])`) → VIP คอมเมนต์แจ้ง `sales` · Division คอมเมนต์แจ้งกลับ `vip` · **VIP ไม่ถูกใส่ใน `app_assert_dept` ของ RPC ตัวอื่นเลย** = อ่านอย่างเดียวจริงระดับ server · demo sync `logic.ts addApprovalComment` |
| `0051_eta_lead_days_stock_comment.sql` | **ฟีเจอร์ (2026-08-08)**: (1) **ระยะขนส่งเลือกได้ 45–60 วัน** — `lbs_units.eta_lead_days` (NULL = ค่ามาตรฐาน 60 → ข้อมูลเดิมไม่ต้อง backfill) · ETA to WH = `fob_date + COALESCE(eta_lead_days, 60)` ยังเป็นค่าคำนวณตามเดิม · ตั้งได้ 3 ทาง: modal แก้รายเครื่อง / ปุ่ม 🚢 ตั้ง FOB ทั้งคลัง / คอลัมน์ "ระยะขนส่ง (วัน)" ใน Excel · helper `app_unit_lead(jsonb)` validate 1–365 (UI จำกัด 45–60 — เส้นทางใหม่แก้แค่ฝั่ง UI) · **DROP+recreate** `rpc_update_unit_plan` (8→9 args) และ `rpc_set_stock_fob` (+`p_lead_days`) ตาม §9.8 (2) **ความเห็นผู้บริหารเรื่องคลัง LBS** — `approval_comments.scope` ('approval' \| 'stock') + `request_id` เป็น NULL ได้เมื่อ scope='stock' + CHECK คู่ scope/target · `rpc_add_stock_comment` ใหม่ · ใช้ตารางเดิมเพราะเป็น thread ชนิดเดียวกัน (VIP ↔ Division) แค่คนละบริบท → UI/แจ้งเตือนใช้โค้ดชุดเดียว เพิ่ม scope ใหม่ได้ภายหลัง · demo sync `logic.ts`: `unitLeadDays` / `normalizeLeadDays` / `addStockComment` / `stockComments` |
| `0052_lead_range_eta_issue_guard.sql` | **แก้ตาม code review (2026-08-08)**: (1) **Import: ช่องระยะขนส่งที่เว้นว่าง = คงค่าเดิม** — 0051 ล้างเป็นค่ามาตรฐาน 60 ซึ่งขัดกับกติกาข้อ 1 ที่เราเขียนในชีต "วิธีกรอก" เอง และขัดกับ demo · **กับดักที่ต้องรู้**: 0051 ให้ `app_unit_lead()` คืน NULL เมื่อค่า = 60 พอรวมกับกฎ "NULL = คงค่าเดิม" จะทำให้ **กรอก 60 เพื่อรีเซ็ตกลับค่ามาตรฐานไม่ได้** → 0052 แยก 2 ความหมาย: `app_unit_lead()` = ค่าที่กรอกมาจริง (NULL = ไม่ได้กรอก) · `NULLIF(x, 60)` = แปลงตอนเขียนลงคอลัมน์เท่านั้น (2) **ระยะขนส่งบังคับ 45–60** (เดิม 1–365) + CHECK ที่ DB + set NULL ให้แถวที่หลุดช่วงก่อน ADD CONSTRAINT (3) **`app_assert_job_eta_ready` — ห้ามเบิกให้ Service ถ้า Job ถือ LBS ที่ Status = Pending** แทรกเข้า `app_exec_issue_job` + `rpc_request_approval` · ⚠️ **ใช้ DO block ไม่ใช่ `app_swap_guard`** เพราะที่นี่ p_new มี p_old เป็น substring (ต่อท้ายบรรทัดเดิม) → `app_swap_guard` จะ patch ซ้อนทุกครั้งที่รันซ้ำ ไม่ idempotent · DO block เช็ค marker `app_assert_job_eta_ready` ก่อน · **นับเฉพาะ pending ไม่นับ '?'** — "ไม่รู้" ไม่ใช่ "รู้ว่ายังไม่มา" ถ้าบล็อก '?' ด้วยจะเบิกงานเดิมทั้งระบบไม่ได้ · demo sync `logic.ts`: `jobEtaBlockReason` / `leadDaysToStore` |
| `0053_plan_po_date.sql` | **ฟีเจอร์ (2026-08-08)**: **Plan PO receipt รายเครื่อง** — `lbs_units.plan_po_date` = วันที่คาดว่าจะได้รับ PO จากลูกค้า (แผนฝั่งขาย) วางถัดจาก Location / Site · เขียนได้เฉพาะเครื่องที่ยังไม่ผูก Job (กฎ 0014 เดียวกับ Customer/Contact/Location) · **DROP+recreate `rpc_update_unit_plan`** (9→10 args, +`p_plan_po_date`) · patch `rpc_import_units_to_stock` รับ key `plan_po` (patch บรรทัดเดียวทั้งหมด — ห้าม recreate เพราะ 0052 patch ไว้แล้ว) · **⚠️⚠️ อย่าสับสน 2 คอลัมน์**: `plan_po_date` = วันรับ PO จากลูกค้า (ป้าย "Plan PO receipt") · `plan_po_receipt_date` = วันของเข้าคลังแบบกรอกเอง (ป้าย "ETA to WH" ตั้งแต่ 0049) — ฝั่ง UI **ถอด alias `'Plan PO receipt'` ออกจาก ETA to WH แล้ว** ไม่งั้น Import ไฟล์รูปแบบใหม่จะเขียนวันรับ PO ลง ETA ผิดช่อง (ไฟล์ที่ export ก่อน 0049 ต้องแก้หัวคอลัมน์เป็น "ETA to WH" ก่อน import) · เปลี่ยนป้ายคอลัมน์เป็นอังกฤษ: ชื่อลูกค้า→**Customer** · เบอร์ติดต่อ→**Contact Number** · สถานที่ติดตั้ง→**Location / Site** (import รับชื่อไทยเดิมผ่าน alias ไฟล์เก่ายังใช้ได้) |
| `0054_std_price_list.sql` | **ฟีเจอร์ (2026-08-08)**: **Standard Price list** — ตาราง `std_prices` + `rpc_create/update/delete_std_price` · โครงสร้างและกติกาเดียวกับ `std_drawings` เป๊ะ (1 รายการ = 1 แถว + PDF ล่าสุด · แก้ = ทับข้อมูลเดิม + stamp ผู้แก้/เวลา · ลบ = ลบทะเบียน ไฟล์ยังอยู่ใน Storage) · `price_no` UNIQUE (ว่างได้) · RLS/realtime/สิทธิ์ copy จาก 0045 (`app_assert_standards` = project+sales+admin · ทุกแผนกอ่านได้) · ไฟล์ PDF เก็บ bucket `install-photos` prefix **`standard-prices/`** · **แยกตารางจาก std_drawings** เพราะเป็นทะเบียนคนละชุด เลขเอกสารต้อง unique แยกกัน (ยัดตารางเดียวด้วยคอลัมน์ kind จะทำ unique ต่อชนิดยุ่งกว่า) · demo sync `logic.ts createStdPrice/updateStdPrice/deleteStdPrice` |
| `0055_stock_lot_no.sql` | **ฟีเจอร์ (2026-08-14)**: **Lot No. ในคลังคงเหลือ** — `accessory_stock.lot_no` (ล็อตของของที่อยู่ในคลัง**ตอนนี้**) + `stock_movements.lot_no` (ล็อตของ**การเคลื่อนไหวครั้งนั้น**) · **เก็บ 2 ที่โดยตั้งใจ** เพราะตอบคนละคำถาม — ถ้าเก็บแค่แถวคลัง จะตอบไม่ได้ว่าของที่เบิกไป Job เมื่อเดือนที่แล้วเป็นล็อตไหน · วิธีเดียวกับ 0038: **ไม่ patch ทุก RPC** แต่ส่งล็อตผ่านบริบท `app_set_stock_lot(lot)` แล้วให้ trigger `fn_log_stock_movement` หยิบไปเขียนทั้ง 2 ที่ (RPC ที่ไม่ตั้งล็อต — เบิก/คืน/โอน/ยกเลิก Job — ทำงานเหมือนเดิม และ ledger บันทึกล็อตปัจจุบันของคลังให้เอง) · **⚠️ ไม่แตะ signature ของ `app_set_stock_ctx`** เพราะจะได้ overload 2 ตัว → PostgREST ambiguous (§9 ข้อ 8) จึงแยกเป็น setter ตัวใหม่ · recreate `fn_log_stock_movement` ปลอดภัย (ไม่มี `app_notify` จึงไม่โดน 0031 patch — ตรวจแล้วชื่อนี้โผล่เฉพาะใน 0038, §9 ข้อ 5) · **DROP+recreate** `rpc_adjust_accessory_stock` (4→5 args, +`p_lot_no`) และ `rpc_create_item` (7→8 args, +`p_initial_lot`) ตาม §9.8 · **`rpc_set_stock_lot` ใหม่** — แก้ล็อตอย่างเดียวไม่แตะยอด (จำเป็นเพราะ `rpc_adjust_accessory_stock` ปฏิเสธเมื่อยอดใหม่ = ยอดเดิม · ไม่ลง ledger เพราะของไม่ได้เคลื่อนไหว ร่องรอยอยู่ใน audit แทน) · demo sync `logic.ts`: `applyStockMovement(lotNo)` / `adjustAccessoryStock` / `createItem` / `setStockLot` / `stockLotOf` |
| `0056_swap_carries_unit_data.sql` | **แก้บั๊ก (2026-08-20)**: **สลับ LBS ต้องพาข้อมูลตัวเครื่องไปกับ Serial** — 0028/0032 สลับแค่ `serial_lvb`/`serial_om` ⇒ `unit_cost` / `fob_date` / `eta_lead_days` / `plan_po_receipt_date` ค้างอยู่กับ **แถว** ไม่ตามไปกับ **เครื่อง** · ผลจริง: (1) `jobLbsCost()` + actual หมวด Raw Material คิดเงินของเครื่องที่ยังอยู่ในคลัง (2) Status/ETA to WH ของทั้งสอง Serial ผิดสลับกัน · **เกณฑ์แบ่ง**: identity ของเครื่องจริง = คู่ Serial → ย้ายตาม Serial = ต้นทุน + ล็อตเรือ/วันของเข้าคลัง · อยู่กับที่ = `project_stock_id`/`status`/`job_id` (ตำแหน่ง ซึ่งเป็นสิ่งที่ swap ตั้งใจเปลี่ยน) และ `plan_customer_name`/`plan_contact_phone`/`plan_install_location`/`plan_po_date`/`plan_delivery_date` (แผนฝั่งขายของ "ช่อง") · recreate `app_exec_swap_lbs` ทั้งก้อนได้เพราะ body ล่าสุด = ของ 0032 (§9 ข้อ 5 grep แล้ว: 0031 ไม่แตะ · 0033/0041 แค่ `PERFORM`) · **ไม่เปลี่ยน signature** → ไม่มีความเสี่ยง `PGRST202` · audit เพิ่มท้ายข้อความว่าต้นทุนย้ายเท่าไร ↔ เท่าไร · **ไม่ auto-repair ของเก่า** — RAISE NOTICE จำนวนครั้งที่เคยสลับให้ Division ไปตรวจงบเอง · demo sync `logic.ts` (`swapLbs` → `machineOf`) + โมดัลสลับโชว์ต้นทุนที่จะเปลี่ยนก่อนกดยืนยัน |
| `0026_job_install_sites.sql` | **ฟีเจอร์ (2026-07-23)**: หลายจุดติดตั้งต่อ Job — `jobs.install_sites` JSONB (array `{location, requiredDate}` = จุดที่ 2+; จุดที่ 1 ยังใช้ install_location/required_date เดิม) · drop+recreate `rpc_create_job`/`rpc_update_job` (+`p_install_sites`) · ข้อมูลวางแผนอย่างเดียว ไม่ผูก Serial/ไม่แตะ flow issue/confirm · UI: เปิด/แก้ Job โชว์ "เพิ่มจุดติดตั้ง" เมื่อ LBS>1 (≤ จำนวน LBS), JobDetail แผง "จุดติดตั้ง", list badge "+N จุด" · demo sync `logic.ts` (normalizeInstallSites) |

> DB ใหม่บนโปรเจกต์เปล่า: รัน 0001→0041 เรียงกันได้เลย (0004/0005 ผสานเข้า 0001/0002 ต้นทางแล้ว แต่ยังเก็บไฟล์แยกไว้เป็นประวัติ · 0012/0013 ถูก 0014 ยกเลิกแต่ต้องรันเรียงเพราะ 0014 อ้างถึงของที่มันสร้าง — ทุกไฟล์ idempotent รันซ้ำได้)
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
| `LINE_BOT_REPLY_IN_GROUP` | functions | (optional) **ไม่ต้องตั้งในการใช้งานปกติ** — ตั้งเป็น `1` ชั่วคราวเมื่อต้องให้บอทตอบในกลุ่ม (หา Group ID กลุ่มใหม่ / ใช้คำสั่ง `สถานะ <Job No.>`) แล้วลบทิ้งเมื่อเสร็จ |
| `APP_URL` | functions | ลิงก์ "🔎 ตรวจสอบในระบบ" ในการ์ด Flex (0033) — ตั้งเป็น `https://lbs-platform-sdt.pages.dev` หรือ custom domain · ไม่ตั้งก็ fallback เป็น pages.dev |

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

- `POST /line-notify` — `{message}` → push เข้ากลุ่ม LINE (frontend เรียกอัตโนมัติเมื่อเปิดสวิตช์ใน Dev Settings) · ต้องมี JWT
- `POST /line-webhook` — ตั้งเป็น Webhook URL ใน LINE Developers (ต้องเปิด **Use webhook** ด้วย); ตรวจ signature ด้วย Web Crypto
  - ⚠️ **กลุ่ม = แจ้งเตือนเท่านั้น (มติ 2026-08-05)** — บอท**ไม่ตอบข้อความใดๆ ในกลุ่ม/ห้องแชท**
    (เดิมมี fallback ตอบทุกข้อความ → บอทแทรกทุกบทสนทนาในกลุ่มทีม) · การแจ้งเตือนใช้ **push** ผ่าน `/line-notify` คนละทางกับ webhook จึงไม่กระทบ
    · **ต้องปิดฝั่ง LINE ด้วย**: LINE Official Account Manager → Response settings → `Chat = ปิด · Webhook = เปิด · Auto-response = ปิด · Greeting message = ปิด` (ไม่งั้น LINE ตอบเองแม้โค้ดไม่ตอบ)
    · หา Group ID ของกลุ่มใหม่: พิมพ์ `id` ในกลุ่ม → บอทไม่ตอบในแชท แต่ log ค่าไว้ที่ **Cloudflare → Functions → Real-time logs** · หรือตั้ง env `LINE_BOT_REPLY_IN_GROUP=1` ชั่วคราวให้ตอบในกลุ่มได้
  - **แชท 1:1 ยังตอบตามเดิม** (จำเป็นกับ flow อนุมัติ 0033): พิมพ์ **โค้ด 6 หลัก** → ผูกบัญชี LINE · ปุ่ม ✅ อนุมัติ (postback) · ข้อความอื่นตอบข้อความช่วยเหลือสั้นๆ
  - คำสั่ง `สถานะ <Job No.>` (สถานะจริงจาก Supabase + คืบหน้ารายเครื่อง + ทีม) **ยังอยู่ในโค้ดแต่ใช้ไม่ได้แล้ว** เพราะถูกจำกัดให้ตอบเฉพาะในกลุ่ม `LINE_GROUP_ID` ซึ่งตอนนี้เงียบ — เปิดคืนได้ด้วย env `LINE_BOT_REPLY_IN_GROUP=1`
  - รับ **postback** จากปุ่ม ✅ อนุมัติ ในการ์ด Flex → `rpc_line_approve` (map `line_user_id` → user → เช็ค role sales/admin)
- `POST /line-approval-push` — `{requestId}` หรือ `{jobId, type}` → ดันการ์ด **Flex (ปุ่ม ✅ อนุมัติ + 🔎 ตรวจสอบ)** เข้าแชท 1:1 ของผู้อนุมัติที่ผูก LINE แล้ว · StoreContext ยิงหลัง `requestApproval` สำเร็จ (LIVE + เปิดสวิตช์ LINE) · ต้องมี JWT
- `GET /line-quota` — โควตา push ของ Messaging API (ปุ่ม 📊 ใน Dev Settings)
- `POST /admin-users` — ต้องมี JWT admin, action `create`/`set_password`; ใช้ service role สร้าง user + auto-confirm email
- รูปแบบ: `export async function onRequestPost({ request, env })` · อ่าน env ผ่าน `env.XXX` (ไม่ใช่ `process.env`)
- ทดสอบ functions ในเครื่อง: `npx wrangler pages dev dist` (build ก่อน) — Vite `npm run dev` ไม่รัน functions

## 8. แผนก + สิทธิ์ (RLS + app_assert_dept) — อัปเดต 2026-08-08 (เพิ่มแผนก VIP)

ชื่อแสดงผลเปลี่ยน (มติ 2026-07-19): `sales` → **"Division"**, `admin` → **"Manage"** (ค่าใน DB คงเดิม — แก้ที่ `DEPT_LABEL` ใน format.ts)

| แผนก (DB) | แสดงผล | ทำอะไรได้ |
|---|---|---|
| `sales` | **Division** | สร้าง/แก้/ลบ Project Stock, รับ LBS เข้า, **แก้ข้อมูลรายเครื่อง — รวม Serial + ต้นทุน + ลูกค้าแผน + FOB date + ETA to WH + Plan Delivery ในฟอร์มเดียว (0043/0049)**, **ตั้ง FOB ทั้งคลัง (0049)**, ปรับยอดคลังสินค้า accessory + **ตั้ง/แก้ Lot No. คลังคงเหลือ (0055 — ปุ่ม 🏷 Lot + ช่องในโมดัลปรับยอด)** + **อนุมัติ/ตีกลับคำขอจาก project** (หน้า "รออนุมัติ") + ตอบกลับความเห็น VIP (0050) |
| `project` | Project | เปิด/แก้/ลบ Job, ดึง-คืน LBS, ขอวัสดุ (+Phase Budget), **บันทึกงวดเงิน Payment (0044 — ทำได้แม้ปิดงานแล้ว)** — ส่วน **ออก PR / เบิกให้ Service / ยกเลิก Job ต้องส่งคำขอให้ Division อนุมัติ** (`rpc_request_approval`) · **⚠️ ทำรายการได้เฉพาะ Job ที่อีเมลตัวเองเปิด (0042) — Job ของคนอื่นดูได้อย่างเดียว** |
| `purchasing` | Purchasing | ออก PO / ยกเลิก PO (ยังไม่รับของ) / ตีกลับ PR / รับของ (partial ได้) / **แก้เลข PR ให้ตรงเอกสารจริง — เฉพาะใบที่ยังไม่ออก PO (0047)** |
| `service` | Service | ยืนยันติดตั้งเสร็จ (+วันที่จริง) |
| `admin` | **Manage** | ทำได้ทุกอย่าง + **ข้ามขั้นอนุมัติ** (เรียก rpc_create_pr/issue/cancel ตรงได้) + อนุมัติแทน Division ได้ + Material Database + ผู้ใช้งาน + **Dev Settings (แผนกเดียวที่เห็น** — เมนูซ่อน + route redirect สำหรับแผนกอื่น) |
| `vip` | **VIP** | **ผู้บริหารสูงสุด (0050)** — ดูได้ทุกหน้าแบบ **อ่านอย่างเดียว** (RLS `read_all` ครอบให้อยู่แล้ว) · เขียนได้อย่างเดียวคือ **ความเห็นบนคำขออนุมัติ** (`rpc_add_approval_comment`) → แจ้ง Division ทันที · **ไม่อยู่ใน `app_assert_dept` ของ RPC ตัวอื่นเลย** = ยิง RPC เขียนข้อมูลอื่นไม่ผ่าน server (ไม่ใช่แค่ซ่อนปุ่ม) |

**สิทธิ์ระดับแถว (0042)**: Project แต่ละอีเมลดำเนินการได้เฉพาะ Job ที่ตัวเองเปิด (`jobs.opened_by`) — Job อื่นเห็นข้อมูลครบแต่ทำรายการไม่ได้ · **บังคับเฉพาะแผนก `project`** เท่านั้น (Purchasing/Service/Division/Manage ทำงานข้าม Job ได้ตามหน้าที่) · งานเก่าที่ `opened_by` ว่าง = ไม่ล็อก · **ไม่มีปุ่มโอนเจ้าของ — คนลาออก/ลาพักร้อนให้ Manage เข้าไปทำแทน**

**Approval flow (0016)**: project ขอ → แจ้งเตือน Division → division/admin อนุมัติที่หน้า "รออนุมัติ" = **execute ทันทีใน transaction เดียว** (fail = rollback ทั้งคำขอ) หรือตีกลับพร้อมเหตุผล (แจ้งกลับ project) · คำขอ pending ซ้ำ type เดียวกันต่อ Job ไม่ได้ (unique partial index) · `rpc_create_pr`/`rpc_issue_job`/`rpc_cancel_job` เช็ค admin-only แล้ว — project ยิง RPC ตรงจะโดนปฏิเสธ

**Standard Price list / Drawing / BOM (0045 + 0054)**: perm `standards.manage` = `project` + `sales` + `admin` — เพิ่ม/แก้/ลบ/อัปโหลด PDF ทั้ง 3 แท็บ · **ทุกแผนกที่ login อ่านและดาวน์โหลดได้** (เป็นมาตรฐานที่ทุกคนต้องใช้) · Price list ใช้กติกาเดียวกับ Drawing เป๊ะ (แก้ = ทับข้อมูลเดิม + stamp ผู้แก้/เวลา · ลบ = ลบทะเบียน ไฟล์ยังอยู่ใน Storage)

**VIP review (0050)**: perm `approval.comment` = `vip` + `sales` + `admin` · VIP รีวิวคำขอที่หน้า Awaiting Approval แล้วฝากความเห็น → แจ้ง Division · Division ตอบกลับได้ → แจ้ง VIP · ความเห็นแสดงใต้คำขอทั้งตอนรอตัดสินและในประวัติหลังตัดสิน (เป็นหลักฐานประกอบการตัดสิน) · badge เมนูโชว์ `<จำนวนคำขอ> · 💬<จำนวนความเห็น>`
**⚠️ VIP เป็น "ผู้ให้ความเห็น" ไม่ใช่ "ผู้อนุมัติชั้นที่ 2" โดยตั้งใจ** — ถ้าทำเป็นขั้นอนุมัติเพิ่ม ทุกคำขอจะค้างรอผู้บริหาร งานหน้างาน (ออก PR/เบิกของ) หยุดทั้งสายเมื่อผู้บริหารติดประชุม และโมเดล "อนุมัติ = ทำงานทันที" ของ 0016 จะเสียไป · ถ้าภายหลังต้องการ gate จริง ให้ทำเป็นเงื่อนไขตามวงเงิน (ต่อยอดจากตาราง `approval_comments` ได้ ไม่ต้องรื้อ)

Job status (auto ทั้งหมด): `Draft → Allocated → Procuring Accessory → Ready to Issue → Issued → Installed` (+ `Cancelled` ได้ทุกสถานะก่อน Issued)

## 9. บั๊กที่เจอจาก E2E บน DB จริง + วิธีแก้ (institutional knowledge)

1. **rpc_issue_job บล็อกตัวเอง** — ตั้ง job=issued ก่อน update units → trigger `trg_block_issued_edit` กันแก้ allocation ของ job ที่ issued แล้ว → แก้: update units ก่อน แล้วค่อยตั้ง job (0004)
2. **notifications อ่านไม่เห็น** — ลืมใส่ RLS SELECT policy → app_notify insert ลงแต่ role authenticated อ่านไม่ได้ → แก้: เพิ่ม policy (0005)
3. **admin-users token invalid** — Supabase secret key แบบใหม่ (`sb_secret_`) ถูกจำกัดบน GoTrue auth endpoint → validate token ของผู้เรียกด้วย **anon key** แทน service key (commit `ab6e8e6`)
4. **rpc_cancel_job พังเงียบหลัง rename คอลัมน์** — 0006 rename `serial_no` → `serial_lvb` แต่ plpgsql ไม่ validate คอลัมน์ตอน CREATE FUNCTION → rpc_cancel_job (สร้างใน 0002) ยังอ้าง serial_no แล้วมา error ตอน "รัน" เท่านั้น (แก้: 0015) — **บทเรียน: rename คอลัมน์ต้อง grep หาทุก RPC ที่อ้างถึง แล้ว recreate ให้ครบ** (พังแบบเงียบ ไม่โผล่ตอนรัน migration)

5. **`CREATE OR REPLACE` ด้วย body จาก migration เก่า = revert งานของ 0031 เงียบๆ** — 0031 ย่อข้อความแจ้งเตือนด้วย `pg_get_functiondef` + `replace()` (patch เฉพาะสตริง ไม่ recreate) ดังนั้น **definition บน LIVE ≠ ข้อความในไฟล์ migration เก่า** · เคยพลาดจริง: 0033 recreate `app_exec_approve` จาก body ของ 0028 → ข้อความ `approval_approved` กลับไปยาว (ต่างจาก demo) เพิ่งแก้ใน 0041 · **กฎ: จะแก้ RPC เดิม ให้ (ก) `app_swap_guard` patch เฉพาะบรรทัด หรือ (ข) ถ้าจำเป็นต้อง recreate ให้ grep ก่อนว่า 0031 แตะฟังก์ชันนั้นไหม**
6. **`app_swap_guard` patch ได้เฉพาะ "บรรทัดเดียว"** — 0041 ครั้งแรกเขียน match ข้าม 3 บรรทัดด้วย `E'\n'` → รันบน LIVE ไม่ผ่าน (`ไม่พบ guard เดิมใน rpc_request_approval`) เพราะ body ที่เก็บใน DB มี **CRLF** (ไฟล์ repo เป็น CRLF บน Windows) · แก้เป็น patch 2 บรรทัดเดี่ยว แล้วให้บรรทัดนั้นแยกตาม `p_type` ด้วย `CASE` เอง · **ที่ 0031/0037/0038 ผ่านหมดเพราะทุก patch เป็นบรรทัดเดียว**
7. **บอทรายงาน `LBS: 0/N` สำหรับงานที่เบิกแล้ว** — `v_job_status.lbs_allocated` นับเฉพาะ `status='allocated'` แต่หลังเบิก unit เปลี่ยนเป็น `'issued'` → แก้: `line-webhook` นับ `lbs_units` ตาม `job_id` ตรงๆ (2026-07-29)
8. **เปลี่ยน signature RPC = ต้องรัน migration ก่อน push** — PostgREST หา signature ใหม่ไม่เจอจะ 404 ทันที (`PGRST202`) ทำให้ปุ่มนั้นใช้ไม่ได้บน LIVE · ถ้าอยากปลอดภัยกว่า ให้พารามิเตอร์ใหม่มี `DEFAULT` (เรียกแบบเดิมยังได้) แบบที่ 0039/0040/0041 ทำ · **และตรวจว่า signature เก่าถูก DROP แล้ว** — ถ้าเหลือทั้งคู่ PostgREST จะ error ambiguous (`PGRST203`)
9. **ALTER CHECK constraint ต้องใช้ชื่อเดิม** — Postgres ตั้งชื่อ inline CHECK เป็น `<table>_<column>_check` · 0028/0041 จึง `DROP CONSTRAINT IF EXISTS approval_requests_req_type_check` แล้ว ADD ชื่อเดิม — ถ้าใช้ชื่อใหม่จะเหลือ CHECK เก่าค้างและ insert ยังพัง

10. **ความทนทานฝั่ง UI (ชุด A — 2026-08-06)** — 4 จุดที่ทำให้ระบบ "ดูพัง" ทั้งที่ข้อมูลปกติ แก้ที่ส่วนกลาง ไม่ต้องแตะทีละหน้า:
    (1) **โหลดข้อมูลไม่สำเร็จแล้วเงียบ** — เดิม `init()` catch แล้ว `console.error` เฉยๆ → เรนเดอร์ต่อด้วย `EMPTY_DB` ผู้ใช้เห็น "ไม่มี Job / คลังว่าง" เหมือนข้อมูลถูกลบ → ตอนนี้ `reload()` เก็บ `loadError` แล้ว `<ConnectionBanner>` แจ้ง + ปุ่มลองใหม่
    (2) **บันทึกสำเร็จแต่ reload พัง = toast แดงเหมือนบันทึกล้มเหลว** → ผู้ใช้กดซ้ำ ได้ PR/งวดเงินซ้ำ · แก้: `wrap()` แยก `await fn(p)` (ล้มจริง → toast) ออกจาก `reload()` (ล้ม → `stale` แบนเนอร์ "ไม่ต้องกดบันทึกซ้ำ")
    (3) **ไม่มี ErrorBoundary** — render พังที่เดียว = จอขาวทั้งแอป · แก้: ครอบ `<Routes>` + `resetKey={pathname}` ให้เปลี่ยนหน้าแล้วหายเอง · sidebar/topbar ยังใช้ได้ระหว่าง error
    (4) **กดปุ่มซ้ำตอนเน็ตช้า = ข้อมูลซ้ำ** — แก้ที่ `useTryAction` ชั้นเดียว: `runExclusive` ใช้ ref กันซ้ำแบบ synchronous (คลิกที่ 2 ถูกทิ้ง คืน false) + `body.is-busy` ทำให้ปุ่ม `.primary/.danger` กดไม่ได้ + แถบ `.busy-bar` บนสุด — **ไม่ต้องแก้ปุ่มทีละตัว 30 จุด**

11. **`window.prompt` ใช้ไม่ได้บน LINE in-app browser (ชุด B — 2026-08-06)** — ทีมเข้าระบบจากการ์ด Flex ใน LINE เป็นหลัก แต่ **iOS in-app webview บล็อก `prompt()`** → กดปุ่มแล้วไม่มีอะไรเกิดขึ้น ผู้ใช้คิดว่าระบบเสีย · เดิมมี 13 จุดรวม**ช่องกรอกเงิน** (ราคาจริงจาก Supplier, ปรับยอดคลัง) และการปรับยอดคลังถาม `prompt` **ซ้อน 3 ชั้น** กด Cancel กลางทางแล้วหลุดทั้งชุดแบบเงียบ
    → แก้ด้วย `usePrompt()` ใน `ui/components.tsx` (Modal + promise API แทน `prompt()` ได้ตรงๆ: `const v = await ask({...}); if (!v) return`) · รองรับหลายช่องในหน้าเดียว · validation inline (required / ตัวเลข / min / `validate()` ต่อช่อง) · Enter = ยืนยัน · **ไม่เหลือ `window.prompt` ในระบบแล้ว**
    → ตามด้วย `useConfirm()` แทน `window.confirm` อีก 11 จุด (ยืนยันการลบ/รีเซ็ต) · ได้เขียน **"ผลของการลบ" ได้เต็ม** ซึ่ง `confirm()` บรรทัดเดียวทำไม่ได้ เช่น "Serial ทั้ง 30 เครื่องในคลังนี้จะถูกลบไปด้วย" · "รายการวัสดุ 3 รายการในชุดนี้จะถูกลบไปด้วย — ถ้าต้องการเก็บให้ Export ก่อน" · "ไฟล์ PDF ยังอยู่ใน Storage"
    ✅ **ไม่เหลือ native dialog (`prompt`/`confirm`/`alert`) ในระบบแล้ว** — ทดสอบด้วยการ override ให้ throw ทั้ง session แล้วเดินทุกปุ่มลบ ไม่มีจุดไหนทริกเกอร์

12. **ตรวจ migration ผ่าน PostgREST — กับดัก 3 อย่างที่ทำให้ "ยืนยันผิด" (2026-08-08)**
    เคยรายงานว่า "0052/0053 ลงแล้ว" ทั้งที่ยังไม่รู้ผลจริง เพราะตัวตรวจให้ false positive **ทุกตัว**
    - **(ก) body โดน mangle บน PowerShell** — `curl -d '{"a":1}'` quote เพี้ยน ได้ `PGRST102 "Empty or invalid json"`
      ซึ่ง **ไม่ใช่** `PGRST202` → ตัวจำแนกแบบ "ไม่ใช่ 202 = มีอยู่" อ่านว่าผ่านหมด
      ✅ เขียน JSON ลงไฟล์แล้ว `--data-binary "@file"`
    - **(ข) `PGRST202` ≠ ฟังก์ชันหาย** — PostgREST resolve ตาม **ชื่อพารามิเตอร์ที่ส่งไป**
      ยิง `{}` เปล่าๆ ฟังก์ชันที่มีอยู่จริงก็ตอบ 202 (พิสูจน์กับ `rpc_set_stock_fob` ที่รู้ว่าลงแล้ว)
      → ต้องส่งชื่อพารามิเตอร์ให้ตรง signature ที่จะตรวจ · `42501 permission denied` = **มีจริง**
    - **(ค) ต้องมี control case เสมอ** — ยิงชื่อฟังก์ชัน/คอลัมน์ที่รู้ว่าไม่มีจริงคู่กันไปด้วย
      ไม่งั้นแยก "ไม่มี" ออกจาก "เรียกไม่ถูกวิธี" ไม่ได้ · ชื่อไทยใน URL/`-d` ก็โดน mangle ใช้ ASCII ทำ control
    - **(ง) ตรวจคอลัมน์ปลอดภัยกว่าตรวจ RPC** — `GET /rest/v1/<table>?select=<col>` ไม่มี body ให้เพี้ยน
      200 = มี · `42703` = ไม่มีคอลัมน์ · `PGRST205` = ไม่มีตาราง
    > ผลข้างเคียงที่ดี: ถ้าไฟล์ migration สร้างฟังก์ชัน **ก่อน** DO block ที่ patch ของเดิม แล้วฟังก์ชันนั้นมีอยู่จริง
    > ⇒ DO block ผ่านด้วย เพราะ SQL Editor รันทั้งสคริปต์เป็น transaction เดียว (0052 ใช้ข้อนี้ยืนยัน guard)

13. **สูตรต้นทุนกระจายอยู่ 4 ที่ แล้วไม่ตรงกัน (2026-08-08)** — กติกา §12 บอกให้ใช้ `effectiveQty()`
    แต่ยังมีที่ใช้ `qtyRequested` ตรงๆ เหลืออยู่ · เจอ 2 จุดตอน review:
    - หน้า **Purchasing** คิด `unitPrice × qtyRequested` แต่งบ Job หัก `unitPrice × effectiveQty`
      ทดสอบจริง (รับครบ 5 → โอนคืนคลัง 2): **600,000 vs 360,000 ต่าง 240,000 ฿** ใต้ป้าย "มูลค่า" เหมือนกัน
    - หน้า **Job เอง**: จอใช้ `effectiveQty` แต่ **Excel export ใช้ `qtyRequested`** → ไฟล์ไม่ตรงกับจอ
    → แก้แล้ว (0054 รอบ frontend) โดย **ไม่ยุบให้เท่ากัน** เพราะสองมุมถูกทั้งคู่แต่คนละความหมาย:
      `มูลค่าสั่งซื้อ` = ยอดจ่ายซัพ (qtyRequested) · `ตัดเข้างาน` = ยอดหักงบ Job (effectiveQty)
      → แยกป้ายให้ต่างกันชัด + โชว์ทั้งสองยอดเมื่อไม่เท่ากัน · helper กลาง `poCostSummary()`
    **บทเรียน: ตัวเลขเงินที่ป้ายเหมือนกันต้องมาจาก helper ตัวเดียวกัน ห้ามคำนวณ inline ซ้ำในแต่ละหน้า**

14. **ประกาศ component ไว้ใน body ของ component → พิมพ์ในช่องข้อความไม่ได้ (2026-08-08)**
    `ApprovalsPage` ประกาศ `const CommentThread = (...) => ...` ไว้ข้างใน → React ได้ **element type ใหม่ทุก render**
    ⇒ unmount/remount subtree ทุกครั้งที่ state เปลี่ยน ⇒ `textarea` เสีย focus **ทีละตัวอักษร** (พิมพ์ได้ตัวเดียว)
    วัดยืนยันแล้ว: `sameNode=false`, `document.activeElement=BODY` ทุกครั้งที่กดแป้น
    → ย้ายออกไปเป็น component ระดับโมดูล + ส่ง props (pattern เดียวกับ `SerialPicker` ใน JobDetailPage)
    ⚠️ **การทดสอบด้วยการ set `.value` แล้ว dispatch `input` ตรวจไม่เจอบั๊กนี้** — ต้องเช็ค `activeElement`
       และ node identity ระหว่างกดแป้นทีละตัว

15. **เพิ่ม enum ใหม่แล้วลืมที่ map ปลายทาง = การ์ดในมือถือบอกเรื่องผิด (2026-08-20)**
    0041 เพิ่ม approval type `reopen_job` แต่ไม่ได้แก้ `functions/line-approval-push.js`
    → `TYPE_LABEL` ไม่มี key และ `summarize()` ไม่มีสาขา แล้ว **ตกลงมาที่ `return` ท้ายฟังก์ชันซึ่งเป็นข้อความของ `cancel_job`**
    ⇒ ผู้อนุมัติได้การ์ดว่า "**ยกเลิก Job** · เหตุผล: …" แต่กด ✅ แล้วระบบ **เปิดงานใหม่** — อนุมัติผิดเรื่องโดยไม่รู้ตัว
    → แก้: เติมทุก type + **ทำ default เป็น fail-loud** (`คำขอประเภท "x" — การ์ดนี้อธิบายไม่ได้`) และ **ตัดปุ่ม ✅ ออก**
      เมื่อ type ไม่รู้จัก (ปุ่มอนุมัติไม่ควรมีเมื่อการ์ดอธิบายเรื่องที่จะอนุมัติไม่ได้)
    ⚠️ **กติกา: `default`/`else` ท้าย mapping ห้ามคืนค่าของเคสอื่น** — ต้องคืนค่าที่อ่านออกว่า "ไม่รู้จัก"
       ฝั่ง TS ใช้ `Record<ApprovalType, string>` ให้ compiler จับ · ฝั่ง `functions/*.js` (ไม่มี type) ต้องเช็คเอง
    **ทดสอบ: เรียก `summarize()` ตรงทุก type + 1 type ปลอม** — เกณฑ์ผ่าน = type ที่ไม่ใช่ cancel_job ห้ามมีคำว่า "ยกเลิก Job"

16. **ผ่อน guard ฝั่ง SQL แล้วลืมเงื่อนไข UI ที่คู่กัน = ฟีเจอร์ที่ทำไว้ใช้ไม่ได้เลย (2026-08-20)**
    0037 ตั้งใจปลดล็อกให้ **บันทึกราคาจริงย้อนหลังได้แม้ปิดงานแล้ว** (`rpc_update_po_line_price` →
    `app_assert_job_cost_editable` = ปิดเฉพาะ cancelled) เพราะใบแจ้งหนี้มาช้ากว่าของเสมอ
    แต่ `PurchasingPage` ยังเหลือ `!job.terminalStatus` → **ปุ่ม 💰 ราคาจริง หายตั้งแต่ Job = Issued**
    ⇒ raw_mat/outsourcing actual ค้างที่ค่าประมาณการ **ทุกงาน** (งานปกติออก PO ก่อนเบิกเสมอ) → งบ vs ใช้จริงผิดทั้งระบบ
    **อยู่มา 3 สัปดาห์โดยไม่มีใครเห็น เพราะไม่มี error — แค่ปุ่มไม่โผล่**
    ⚠️ **กติกา: migration ที่ผ่อน guard ต้อง grep เงื่อนไข `terminalStatus` / `can*` ในหน้าที่คู่กันด้วย**
       และเขียนใน migration header ว่า UI ตัวไหนต้องแก้ตาม
    **ทดสอบ: ต้องสร้างสถานะจริงแล้วดูปุ่ม** — งานที่ `issued` + มี PO แล้ว (seed ไม่มี ต้องรับของ→เบิก เอง)
       เช็คแค่ "หน้าเปิดได้" ตรวจไม่เจอ

> demo mode ไม่มี trigger/RLS/functions/plpgsql จึงไม่เจอบั๊กพวกนี้ — ต้องทดสอบบน DB จริงเท่านั้น
> กลับกัน **บั๊กสูตรเงิน/สถานะ ทดสอบใน demo mode ได้ดีกว่า** (`npm run dev -- --mode demo`) เพราะเขียนลง
> localStorage อ่านตัวเลขก่อน/หลังได้ตรงๆ และ**ไม่แตะข้อมูลจริง** — `.env` ชี้ production เสมอ ห้ามทดสอบ swap/เบิก/รับของบนนั้น

## 10. งานค้าง (TODO)

### 🔴 ความปลอดภัย (ทำก่อนใช้จริงจัง)
- [ ] **ลบ/ปิดบัญชีทดสอบ** — รัน **`supabase/cleanup_e2e_accounts.sql`** ใน SQL Editor (ปลอดภัยแม้มีข้อมูลจริงแล้ว:
      ปิดใช้งานทุกบัญชีทดสอบทันที + ลบตัวที่ลบได้ ตัวที่ยังถูกอ้างใน audit/jobs จะถูกข้าม)
      บัญชี: `e2e-runner@example.org` (เคยเป็น admin, รหัสผ่านเคยเปิดเผย), `e2e.tester.lbs@gmail.com`, `e2e-admin@example.com`, `fn-test-sales@example.org`
- [x] ~~รัน `supabase/cleanup_e2e.sql`~~ — **❌ ปิดรายการนี้ถาวร ห้ามรันอีก (2026-07-19)**: ระบบมีข้อมูลจริงแล้ว
      การรันซ้ำหลัง push ทำให้ LBS ที่รับเข้าคลังจริงถูกลบหมด (เหตุการณ์จริง 2026-07-19 — จำนวนเครื่องใน Project Stock หาย)
      ไฟล์ถูกใส่สลักนิรภัย (DO-block RAISE EXCEPTION) กันรันติดมือแล้ว · **หลัง push ไม่ต้องรัน SQL ใดๆ เว้นแต่มี migration ไฟล์ใหม่**
- [ ] ตรวจว่า **service_role key ถูก rotate แล้ว** (ระหว่าง setup key เก่าเคยเปิดเผย — ตรวจ repo แล้ว 2026-07-19: **key ไม่เคยหลุดลง git** หลุดเฉพาะนอก repo) — Dashboard → Settings → API → สร้าง/roll secret key ใหม่ → อัปเดต `SUPABASE_SERVICE_ROLE_KEY` บน Cloudflare Pages env → Retry deployment

### 🟠 Migrations — ✅ **0001–0056 รันครบ** (0055 + 0056 รัน 2026-08-20)

**กติกา: หลัง push ไม่ต้องรัน SQL ใดๆ เว้นแต่มี migration ไฟล์ใหม่ (ผมจะบอกชื่อไฟล์และลำดับ)**
ทุกไฟล์ idempotent — แถวไหนตรวจได้ `false` รันไฟล์นั้นซ้ำได้เลย

- [x] ~~0001–0048~~ รันครบ (0042–0048 รัน 2026-08-07)
- [x] ~~0049–0051~~ FOB/ETA to WH · VIP + ความเห็นผู้บริหาร · ระยะขนส่ง 45–60 + ความเห็นเรื่องคลัง
- [x] ~~0052–0053~~ แก้ตาม code review (import คงค่าเดิม · guard ห้ามเบิกเมื่อของยังไม่ถึงคลัง) · Plan PO receipt
- [x] ~~0054~~ Standard Price list (`std_prices` + RPC 3 ตัว) — ยืนยัน 2026-08-08
- [x] ~~0055~~ Lot No. คลังคงเหลือ — รัน 2026-08-20 (ค้างจาก push `048b35f` · **บทเรียน: commit ที่มี migration
      เปลี่ยน signature ต้องรัน SQL ก่อน push เสมอ** — รอบนั้น push ไปก่อน ปุ่ม 3 จุดเลย 404 `PGRST202` อยู่ 6 วัน)
- [x] ~~0056~~ สลับ LBS พา `unit_cost` / `fob_date` / `eta_lead_days` / `plan_po_receipt_date` ไปกับคู่ Serial — รัน 2026-08-20
      (เดิม 0028/0032 สลับแค่ serial → `jobLbsCost()` คิดเงินของเครื่องที่ยังอยู่ในคลัง และ Status/ETA ผิดสลับกัน)
      ตรวจว่าลงแล้ว: `SELECT position('unit_cost = a.unit_cost' IN pg_get_functiondef('app_exec_swap_lbs(profiles,uuid,uuid,uuid,text)'::regprocedure)) > 0;`
- [ ] 🟠 **ตรวจงานที่เคยสลับ LBS ก่อน 0056** — `SELECT created_at, detail FROM audit_logs WHERE action='swap_lbs_serial' ORDER BY created_at DESC;`
      ต้นทุน/ETA ของเครื่องเหล่านั้นยังผูกผิด (0056 แก้เฉพาะการสลับ**ครั้งต่อไป** ไม่ย้อนหลัง — เดาเจตนาเดิมไม่ได้) · **รอ Division พิจารณา**

<details>
<summary><b>SQL ตรวจว่า 0042–0054 ลงครบจริง</b> (รันได้ตลอด ไม่แตะข้อมูล — ต้องได้ <code>true</code> ทุกแถว)</summary>

```sql
with f as (select p.proname,
                  pg_get_function_identity_arguments(p.oid) as args,
                  pg_get_functiondef(p.oid) as def
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'),
     c as (select table_name, column_name from information_schema.columns)
select * from (values
  -- 0042–0048
  ('0042 สิทธิ์ระดับแถว (guard 6 ตัว)', (select count(*) = 6 from f where proname in
      ('app_assert_job_editable','app_assert_job_procurable','app_assert_job_cost_editable',
       'app_assert_job_reopenable','rpc_delete_accessory_request','rpc_transfer_job_material_to_stock')
      and def like '%app_assert_job_owner%')),
  ('0043 คอลัมน์ plan_* (5 ตัว)', (select count(*) = 5 from c where table_name = 'lbs_units'
      and column_name in ('plan_customer_name','plan_contact_phone','plan_install_location',
                          'plan_po_receipt_date','plan_delivery_date'))),
  ('0044 job_payments + RPC', (to_regclass('public.job_payments') is not null
      and exists (select 1 from f where proname = 'rpc_add_job_payment'))),
  ('0045 std_drawings / std_boms / std_bom_lines', (to_regclass('public.std_drawings') is not null
      and to_regclass('public.std_boms') is not null and to_regclass('public.std_bom_lines') is not null
      and exists (select 1 from f where proname = 'rpc_create_std_drawing'))),
  ('0046 import BOM จาก Excel', exists (select 1 from f where proname = 'rpc_import_std_bom_lines')),
  ('0047 แก้เลข PR', exists (select 1 from f where proname = 'rpc_update_pr_no')),
  ('0048 import ข้อมูลแผนรายเครื่อง', exists (select 1 from f
      where proname = 'rpc_import_units_to_stock' and def like '%plan_po_receipt%')),
  -- 0049–0051
  ('0049 lbs_units.fob_date', exists (select 1 from c where table_name='lbs_units' and column_name='fob_date')),
  ('0049 rpc_set_stock_fob = ตัวเดียว + p_lead_days',
      (select count(*) = 1 from f where proname='rpc_set_stock_fob')
      and exists (select 1 from f where proname='rpc_set_stock_fob' and args like '%p_lead_days%')),
  ('0050 profiles รับแผนก vip', (select pg_get_constraintdef(oid) like '%vip%' from pg_constraint
      where conname='profiles_department_check')),
  ('0050 approval_comments + RPC', (to_regclass('public.approval_comments') is not null
      and exists (select 1 from f where proname='rpc_add_approval_comment'))),
  ('0051 lbs_units.eta_lead_days', exists (select 1 from c where table_name='lbs_units' and column_name='eta_lead_days')),
  ('0051 approval_comments.scope + rpc_add_stock_comment',
      exists (select 1 from c where table_name='approval_comments' and column_name='scope')
      and exists (select 1 from f where proname='rpc_add_stock_comment')),
  -- 0052–0053
  ('0052 app_assert_job_eta_ready', exists (select 1 from f where proname='app_assert_job_eta_ready')),
  ('0052 guard เข้า app_exec_issue_job', exists (select 1 from f
      where proname='app_exec_issue_job' and def like '%app_assert_job_eta_ready%')),
  ('0052 guard เข้า rpc_request_approval', exists (select 1 from f
      where proname='rpc_request_approval' and def like '%app_assert_job_eta_ready%')),
  ('0052 import: เว้นว่าง = คงค่าเดิม', exists (select 1 from f
      where proname='rpc_import_units_to_stock' and def like '%v_lead IS NULL THEN eta_lead_days%')),
  ('0052 CHECK ระยะขนส่ง 45-60', (select pg_get_constraintdef(oid) like '%45%' from pg_constraint
      where conname='lbs_units_eta_lead_days_check')),
  ('0053 lbs_units.plan_po_date', exists (select 1 from c where table_name='lbs_units' and column_name='plan_po_date')),
  ('0053 rpc_update_unit_plan = ตัวเดียว 10 args',
      (select count(*) = 1 from f where proname='rpc_update_unit_plan')
      and exists (select 1 from f where proname='rpc_update_unit_plan'
                    and args like '%p_fob_date%' and args like '%p_lead_days%' and args like '%p_plan_po_date%')),
  ('0053 import รับ key plan_po', exists (select 1 from f
      where proname='rpc_import_units_to_stock' and def like '%plan_po_date%')),
  -- 0054
  ('0054 std_prices + RPC 3 ตัว', (to_regclass('public.std_prices') is not null
      and (select count(*) = 3 from f where proname in
           ('rpc_create_std_price','rpc_update_std_price','rpc_delete_std_price')))),
  -- realtime
  ('realtime: ตารางใหม่อยู่ใน publication', (
      select count(*) = 6 from pg_publication_tables where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename in ('job_payments','std_drawings','std_boms','std_bom_lines','approval_comments','std_prices')))
) t(migration, ok) order by 1;
```

**ถ้าแถว guard (0052) เป็น `false`** = body ใน DB ต่างจากที่ 0052 คาด — ตัว migration จะ `RAISE EXCEPTION`
พร้อมชื่อฟังก์ชันให้เอง ไม่ patch มั่ว · ให้ `pg_get_functiondef` ดู body จริงก่อนแก้มือ
</details>

- [ ] ตรวจว่า string patch ของ **0041** ลงจริง (ตรวจผ่าน REST ไม่ได้ — auth gate มาก่อน):
      ```sql
      select p.proname, position('reopen_job' in pg_get_functiondef(p.oid)) > 0 as patched
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('rpc_request_approval','rpc_reject_request');
      ```
      ต้องได้ `patched = true` ทั้ง 2 แถว — ถ้า false รัน `0041` ซ้ำ (idempotent) ·
      อาการถ้าไม่ลง: กด "ขออนุมัติเปิดงานใหม่" แล้ว error `ประเภทคำขอไม่ถูกต้อง`
- [ ] ยืนยัน bucket **`install-photos`** (public) มีจริง — ใช้ทั้งรูปยืนยันติดตั้ง (0019/0035),
      ไฟล์แนบปัญหา prefix `job-issues/` (0040), Standard Drawing prefix `standard-drawings/` (0045)
      และ **Standard Price list prefix `standard-prices/` (0054)** · ถ้าอัปโหลดไม่ได้ให้สร้างที่ Dashboard→Storage

### 🟡 ฟีเจอร์เสริม (ตั้งค่าค้างอยู่)
- [ ] 🆕 **สร้างบัญชี VIP บน production** (0050 — ยังไม่มีบัญชีแผนกนี้เลย)
      login **Manage** → Dev Settings → **+ เพิ่มผู้ใช้** → แผนก **VIP** (dropdown มีคำอธิบายสิทธิ์ให้อ่านใต้ช่อง)
      แล้วทดสอบ: VIP พิมพ์ความเห็นที่ **Awaiting Approval** และท้ายหน้า **Project Stock** → Division ต้องเห็น badge 💬
- [ ] 🆕 **เคลียร์ Status `?` ของของเดิมในคลัง** (0049–0052) — ของทุกเครื่องที่รับเข้าก่อน 0049 ยังไม่มี FOB
      จึงขึ้น `?` (ระบบไม่เดาว่าของถึงคลังแล้ว) · วิธีเร็วสุด: Division → Project Stock → **🚢 ตั้ง FOB ทั้งคลัง**
      ทีละคลัง ใส่วัน FOB จริง + ระยะขนส่ง 45–60 · ล็อตที่ไม่รู้ FOB ย้อนหลัง ให้กรอก **ETA to WH ตรงๆ**
      ที่ปุ่ม "แก้ข้อมูล" รายเครื่อง (เว้น FOB ว่าง) ใส่วันในอดีต → ขึ้น On Hand ทันที
      ⚠️ **สำคัญ**: ถ้าไม่เคลียร์ Dashboard จะโชว์ `On Hand 0` และ dropdown ตอนดึง LBS จะขึ้น "ไม่ระบุ ETA n"
- [ ] 🆕 **ทดสอบอัปโหลด PDF ที่แท็บ Standard Price list** (0054) — จุดเดียวที่ demo แทนไม่ได้
      (demo เก็บ data URL · production ใช้ Supabase Storage prefix `standard-prices/`) ใช้ bucket เดียวกับ Drawing
- [ ] **เปิดสวิตช์ LINE** — env + code + migration 0017 พร้อมหมด · เหลือ: login **Manage** → Dev Settings → เปิดสวิตช์แจ้งเตือน LINE (global มีผลทุกเครื่อง) → "ส่งข้อความทดสอบ"
- [ ] 🆕 **ปิด Auto-response / Greeting ที่ LINE Official Account Manager** (2026-08-05) — โค้ดไม่ตอบในกลุ่มแล้ว แต่ LINE ตอบเองได้จาก Response settings: ตั้ง `Chat = ปิด · Webhook = เปิด · Auto-response = ปิด · Greeting message = ปิด` แล้วทดสอบพิมพ์ในกลุ่มว่าบอทเงียบจริง
- [ ] **เปิดใช้อนุมัติผ่าน LINE 1:1** (0033) — ต้องทำ 3 อย่าง: (1) ตั้ง env `APP_URL` (2) LINE Developers → เปิด **Use webhook** + Webhook URL `https://lbs-platform-sdt.pages.dev/line-webhook` (postback มาที่ URL เดียวกัน ไม่ต้องตั้งแยก) (3) ผู้อนุมัติแต่ละคน: **เพิ่มบอทเป็นเพื่อน** → หน้า Awaiting Approval กด "สร้างโค้ดเชื่อม LINE" → **พิมพ์โค้ด 6 หลักในแชท 1:1** ภายใน 10 นาที (หน้านั้นจะโชว์ badge "✅ เชื่อมต่อแล้ว" เมื่อผูกสำเร็จ)
- [ ] **ตั้งต้นทุนย้อนหลังให้วัสดุที่มีของค้างอยู่ก่อน 0039** — คอลัมน์ต้นทุนถัวเฉลี่ย/มูลค่าจะขึ้น `-` จนกว่าจะมีของเข้าใหม่พร้อมต้นทุน · วิธีชั่วคราว: ปรับยอดขึ้น 1 หน่วยพร้อมใส่ต้นทุน แล้วปรับกลับลง (ledger บันทึกทั้ง 2 รายการพร้อมเหตุผล) — ถ้าต้องทำหลายรายการ ควรทำปุ่ม "ตั้งต้นทุนตั้งต้น" ให้ตรงๆ
- [ ] **Custom domain** — `lbs.precise.co.th` (ขอ IT เพิ่ม CNAME → `lbs-platform-sdt.pages.dev`) แล้ว Add ใน Cloudflare Pages → Custom domains
- [ ] **service_role key rotate** (ดูหัวข้อ 🔴) — ยังไม่ยืนยันว่า rotate แล้ว

### 🟢 พัฒนาต่อ (ไอเดีย)
- หน้า forgot-password / เปลี่ยนรหัสตัวเอง (ตอนนี้ Manage reset ให้ที่ Dev Settings)
- รายงาน/analytics (lead time ต่อ Job · ยอดสั่งซื้อตามซัพพลายเออร์) — **stock movement มี ledger แล้ว (0038)** เหลือทำหน้ารายงาน
- **วงจรชีวิตของปัญหา (open → resolved)** — ตอนนี้ 0040/0041 *บันทึก+รวม*ปัญหาได้แล้ว แต่ยังไม่มีสถานะติดตาม/เจ้าภาพ → เพิ่ม `issueResolvedAt/By/Resolution` แล้วปิดปัญหาแยกจากปิดงาน + การ์ด "งานที่มีปัญหาค้าง" บน Dashboard
- **Supplier Master** — ตาราง `suppliers` มีใน schema ตั้งแต่ 0001 แต่**ไม่ถูกใช้เลย** (PO พิมพ์ชื่อ supplier เอง = free text) → เสี่ยงชื่อไม่ตรงกัน ทำรายงานตามซัพไม่ได้
- **ปิด PO เท่าที่รับ (short-close)** — ตอนนี้ยกเลิก PO ได้เฉพาะยังไม่รับของเลย · ถ้าซัพส่ง 3/5 แล้วส่งที่เหลือไม่ได้ PO จะค้าง `issued` ตลอด
- **Job Detail: ยังไม่มี UI ดูข้อมูลบางส่วน** — ประวัติ ledger ของวัสดุ (ดูได้ที่ Material Database) · ตอนนี้เห็นทีม/คืบหน้า/หลักฐานรายเครื่อง/ประวัติออกหน้างานแล้ว (2026-07-29)

> ✅ เสร็จแล้ว (2026-08-08): **Project Stock — FOB date / ETA to WH (FOB+60 อัตโนมัติ) / Status Pending–On Hand รายเครื่อง (0049)** + ปุ่ม **🚢 ตั้ง FOB ทั้งคลัง** + **ตีเส้นตารางบางๆ** (`table.grid`) + **รวมปุ่ม "แก้ Serial" เข้าไปในปุ่ม "แก้ข้อมูล"** (ฟอร์มเดียว บันทึกทีเดียว) + **ย้ายต้นทุน/เครื่องออกจากตาราง → กดป้าย "มูลค่าคลัง" ดูรายเครื่องแทน** + Export/Import Excel round-trip คอลัมน์ FOB/ETA/Status
> ✅ เสร็จแล้ว (2026-08-08): **Dashboard — LBS Stock Balance แยก On Hand / Pending + แถวรวมทุกคลัง + ป้ายปิดคลัง** · **Job List เรียงตามกำหนดส่ง (ใกล้สุดก่อน) ตัดงานที่ปิด/ยกเลิกออก + 🔴 เลยกำหนด / ⚠️ เหลือ ≤30 วัน + คอลัมน์วันคงเหลือ** (กำหนดส่ง = วันที่ใกล้สุดจาก `requiredDate` + `installSites` ทุกจุด)
> ✅ เสร็จแล้ว (2026-08-08): **แผนก VIP (ผู้บริหารสูงสุด) + ความเห็นบนคำขออนุมัติ (0050)** — VIP อ่านได้ทุกหน้า เขียนได้แค่ความเห็น · ความเห็นแสดงใต้คำขอที่หน้า Awaiting Approval (ทั้งตอนรอตัดสินและในประวัติ) · Division ตอบกลับได้ · badge เมนู `<คำขอ> · 💬<ความเห็น>` · Dev Settings มีคำอธิบายสิทธิ์ต่อแผนกใต้ dropdown
> ✅ เสร็จแล้ว (2026-08-14 — 0055): **ซ่อนตารางเริ่มต้น 3 จุด + Export PR template + Lot No.**
> · **Job Detail — Purchase Orders เริ่มต้นซ่อน** (`poOpen`) ปุ่มทำรายการ (Export / เพิ่มวัสดุ / ออก PR) ยังอยู่ครบตอนซ่อน ไม่ต้องกางก่อนถึงจะกดได้
> · **Purchasing — ตาราง PR และ PO เริ่มต้นซ่อน แยกปุ่มคนละตัวต่อ Job** (`prOpen`/`poOpen` — ⚠️ ชื่อ `openPo` ถูกใช้เป็นฟังก์ชันเปิดโมดัลออก PO อยู่แล้ว) · ป้ายบนหัวการ์ด ("มีรายการรอออก PO" / "PO รอรับของ n") บอกอยู่แล้วว่างานไหนต้องทำอะไร จึงกางเฉพาะใบที่จะลงมือ
> · **Export PR ที่ยังไม่ออก PO → Excel template ขอราคา** — 2 ระดับ: ปุ่มรวมทุกงานบนหัวหน้า (รวบยอดสั่งของประจำวัน) + ปุ่มต่อ Job ในการ์ด · สเปกคอลัมน์รวมศูนย์ที่ `PR_COLS` (แนวเดียวกับ `SHEET_COLS` ของ Project Stock) · 12 คอลัมน์ระบบเติมให้ + **5 คอลัมน์เว้นว่างให้ซัพพลายเออร์กรอก** (ราคาที่เสนอ / มูลค่า / ยี่ห้อ-รุ่น / กำหนดส่ง / หมายเหตุ) — นี่คือสิ่งที่ทำให้เป็น "template" ไม่ใช่แค่ dump ข้อมูล · แนบชีต "วิธีใช้" + autofilter · **นับเฉพาะ line ที่ยัง `pr_sent`** ใบที่ออก PO บางส่วนแล้วได้เฉพาะส่วนที่เหลือ · **export อย่างเดียว ไม่มี import กลับ** (ราคาจริงบันทึกที่ปุ่ม 💰 ราคาจริง หลังออก PO)
> · **Lot No. ในคลังคงเหลือ (0055)** — คอลัมน์ในตาราง + ปุ่ม **🏷 Lot** (แก้ล็อตอย่างเดียว ไม่แตะยอด) + ช่องในโมดัล **ปรับยอด** (ใช้เฉพาะขาเข้า เหมือนช่องต้นทุน) + ช่องในโมดัล **เพิ่ม Accessory** + คอลัมน์ใน **ประวัติการเคลื่อนไหว** + **Export/Import Excel** (ช่องว่าง = คงค่าเดิม · ล้างล็อตต้องใช้ปุ่ม 🏷 Lot) · import เตือน 2 กรณีแทนที่จะรับแล้วเงียบ: กรอกล็อตแต่ไม่มียอดคงเหลือ · กรอกล็อตแต่การจัดหาเป็น Purchasing
>
> ✅ เสร็จแล้ว (2026-08-08 · รอบ 5 — 0054): **ต้นทุนรวมต่อ PO No.** (`poCostSummary` — โชว์ยอดสั่งซื้อ + จำนวนรายการ + เตือนเมื่อกรอกราคาไม่ครบ) · **แก้สูตรต้นทุนไม่ตรงกัน 2 จุด** (หน้า Purchasing ใช้ `qtyRequested` แต่งบ Job หัก `effectiveQty` ต่าง 240,000 ฿ ในเคสทดสอบ · และ Excel export ของหน้า Job ไม่ตรงกับจอเอง) → แยกป้าย `มูลค่าสั่งซื้อ` / `ตัดเข้างาน` ไม่ยุบรวม เพราะสองมุมถูกทั้งคู่ (ดู §9 ข้อ 13) · **Standard Price list** เป็นแท็บที่ 3 (ตาราง `std_prices` + RPC 3 ตัว · หลักการเดียวกับ Standard Drawing เป๊ะ) + เปลี่ยนชื่อหน้า/เมนู
> ✅ เสร็จแล้ว (2026-08-08 · รอบ 4 — 0052/0053): **แก้ตาม code review** — CommentThread เสีย focus ทุกตัวอักษร (§9 ข้อ 14) · dropdown ดึง LBS โชว์ On Hand 0 ทั้งที่มีของ · import ระยะขนส่งเว้นว่างต้องคงค่าเดิม · ระยะขนส่งบังคับ 45–60 · **guard ห้ามเบิกเมื่อของยังไม่ถึงคลัง** (`app_assert_job_eta_ready`) · **Plan PO receipt** รายเครื่อง (`plan_po_date`) + ป้ายคอลัมน์อังกฤษ Customer / Contact Number / Location / Site
> ✅ เสร็จแล้ว (2026-08-08 · รอบ 3 — **ไม่ต้องรัน SQL**): **Status รายเครื่องรวมเป็น flow เดียว** `? → Pending → On Hand → ถูกดึงเข้า Job → เบิกแล้ว รอติดตั้ง → ติดตั้งแล้ว/ติดตั้งไม่ได้` (`unitFlowState` + `UNIT_FLOW` ใน format.ts) — ตัดคอลัมน์ "สถานะเครื่อง" ทิ้ง เอา **Cost/Set** มาแทนที่ · **ไม่ระบุ ETA = "?" ไม่ใช่ On Hand อีกต่อไป** (เดิม 0049 เดาว่าถึงแล้ว — "ไม่รู้" กับ "ของถึงแล้ว" คนละเรื่อง ทำให้วางแผนงานผิดโดยไม่รู้ตัว) → `stockSummary.unknown` + คอลัมน์ `? (ไม่ระบุ ETA)` บน Dashboard · **Export/Import ยกเครื่องเป็น professional**: สเปกคอลัมน์รวมศูนย์ที่ `SHEET_COLS` (แหล่งความจริงเดียวของ Export + Import + ชีตคู่มือ) · เรียงคอลัมน์ **กรอกได้ก่อน → auto ท้ายสุด** · แนบชีต **"วิธีกรอก"** (กรอกได้/อัตโนมัติ · บังคับ · รูปแบบ · คำอธิบาย + กติกา 6 ข้อ + ตาราง Status) · autofilter บนหัวตาราง · **แก้บั๊ก: คลังเปล่า export ออกมาไม่มีหัวตารางเลย** (`json_to_sheet([])` → ใส่ `{header}` แล้วได้แบบฟอร์มกรอกจริง — เจอจาก Project Stock No.21 ที่ผู้ใช้ส่งมา) · import รับหัวตารางชื่อเก่าผ่าน `alias` (ไฟล์ที่ export ไว้ก่อนหน้ายังใช้ได้) + error ใหม่ "กรอกระยะขนส่งแต่ไม่กรอก FOB"
> ✅ เสร็จแล้ว (2026-08-08 · รอบ 2 — 0051): **ระยะขนส่งเลือกได้ 45–60 วัน** (ต่อเครื่อง/ต่อล็อต · ป้ายในตารางโชว์ `+45 วัน` แทน `auto`) · **ความเห็นผู้บริหารเรื่องคลัง LBS** ท้ายหน้า Project Stock ใต้พาเนล "วัสดุตาม Job (Ref.PO)" · **หน้า Project ID (Jobs) เรียงตามกำหนดส่ง + 🔴/⚠️ + คอลัมน์ "เหลือ"** เหมือน Dashboard (งานที่จบแล้วลงล่างสุด ไม่เตือน) · **เตือนตอนดึง LBS ที่ ETA ยังไม่ถึง** — ป้าย `⚠️ ETA <วันที่>` รายเครื่องในตัวเลือก + สรุปจำนวนเหนือรายการ + dropdown คลังโชว์ `On Hand n (รอเข้าคลังอีก m)` · **ยังดึงได้ (จองล่วงหน้า) ไม่บล็อก** ตามมติ 2026-08-08
> ✅ เสร็จแล้ว (2026-07-31): **บังคับสรุปปัญหาก่อนปิดงานติดตั้ง** (มี/ไม่มี + รายละเอียด + ไฟล์แนบ, 0040) · **มุมรวมปัญหางานบริการ** จาก 3 แหล่ง + badge เมนู · **เปิดงานใหม่ (Reopen) ผ่านการอนุมัติ Division** + reopenCount (0041)
> ✅ เสร็จแล้ว (2026-07-30): **จัดซื้อเพิ่มเติมหลังเบิก** ผ่าน Division + แก้ราคาจริงได้แม้ปิดงาน (0037) · **Stock ledger + ต้นทุนถัวเฉลี่ย + โอนวัสดุเหลือจาก Job เข้าคลัง** (0038) · **แยกพาเนล catalog/คลังคงเหลือ + เลือกซื้อ-เบิกฉลาด (เตือนเมื่อมีของในคลัง) + Import Excel round-trip ครบ 5 คอลัมน์** · **ใส่ต้นทุนตอนของเข้าคลัง** (0039)
> ✅ เสร็จแล้ว (2026-07-29): ต่อข้อมูล Service เข้า **Job Detail** (ทีม/คืบหน้า x/y/หลักฐานรายเครื่อง/ประวัติออกหน้างาน) · **Dashboard การ์ด "งานติดตั้ง (Service)"** · **บอท LINE รายงานคืบหน้ารายเครื่อง + ทีม** (+ แก้บั๊ก LBS 0/N)
> ✅ เสร็จแล้ว (2026-07-27→28): Service เฟส A **เลื่อนนัด/ติดปัญหาหน้างาน** (0034) · เฟส B **ยืนยันติดตั้งรายเครื่อง + ปิดงานแยกขั้น** (0035) · เฟส C **ทะเบียนทีมช่าง + มอบหมายงาน + ผู้ติดตั้งรายเครื่อง + หน้า Service & Scheduling** (0036)
> ✅ เสร็จแล้ว (2026-07-26): **อนุมัติผ่าน LINE แชทส่วนตัว** (การ์ด Flex ปุ่มอนุมัติ + ผูกบัญชีด้วยโค้ด 6 หลัก, 0033) · สลับ LBS มีข้อความแจ้งเตือน action (0032) · ปรับคำสถานะรอ Division เป็น "**รอ Division พิจารณา**" ทั้งระบบ + แก้บั๊กป้ายแสดงประเภท swap_lbs ผิด
> ✅ เสร็จแล้ว (2026-07-25): ย่อข้อความแจ้งเตือน LINE ทุก workflow (0031, คง logic) · ปุ่ม 📊 ตรวจโควตา Messaging API + progress bar ใน Dev Settings (`functions/line-quota.js`)
> ✅ เสร็จแล้ว (2026-07-25): Session หมดอายุ 2 ชม. (absolute, ทั้ง demo/Supabase — notice หน้า login) · Purchasing บันทึกราคาจริงหลังออก PO → งบ actual (0030) · ขยายโลโก้ (login 200px · sidebar 52px)
> ✅ เสร็จแล้ว (2026-07-24): Project Stock + PO No. (กรอกตอนสร้าง/แก้ภายหลัง) + Remark (relabel notes) (0029)
> ✅ เสร็จแล้ว (2026-07-24): สลับเลข Serial LBS (allocated ↔ in_stock) ผ่าน Division อนุมัติ + เหตุผล / Manage ตรง — approval type swap_lbs (0028) · ทำก่อน issued
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
- **⚠️ ก่อนแก้ RPC เดิม อ่านหัวข้อ 9 ข้อ 5–6 ก่อน** — `CREATE OR REPLACE` ด้วย body เก่าจะ revert การย่อข้อความของ 0031 · และ `app_swap_guard` patch ได้เฉพาะ **บรรทัดเดียว** (body ใน DB มี CRLF)
- **Lot No. คลังคงเหลือ (0055) — 2 คอลัมน์ที่ห้ามยุบรวม**: `accessory_stock.lot_no` = ล็อตของของที่อยู่ในคลัง **ตอนนี้** · `stock_movements.lot_no` = ล็อตของ **การเคลื่อนไหวครั้งนั้น** (ขาเข้า = ล็อตที่กรอก · ขาออก = ล็อตที่อยู่ในคลังขณะนั้น) · **ล็อตบนแถวคลังทับก็ต่อเมื่อ "ของเข้าพร้อมระบุล็อต" เท่านั้น** — ขาออกและขาเข้าที่ไม่ระบุ (คืน/โอนจาก Job) คงล็อตเดิม และ trigger **ไม่ล้างเป็น NULL เด็ดขาด** · การล้าง/แก้ล็อตทำผ่าน `rpc_set_stock_lot` ทางเดียว (ปุ่ม 🏷 Lot) ซึ่งไม่แตะ `qty_on_hand` จึงไม่ทริกเกอร์ `trg_log_stock_movement` (ผูกกับ `UPDATE OF qty_on_hand`) และไม่ลง ledger — ตั้งใจ เพราะของไม่ได้เคลื่อนไหว
- **ห้ามแก้ `accessory_stock.qty_on_hand` ตรงๆ ในโค้ดใหม่** — ต้องผ่าน `app_apply_stock_movement`-pattern (LIVE: UPDATE แล้วให้ trigger `trg_log_stock_movement` ลง ledger เอง + ตั้งบริบทด้วย `app_set_stock_ctx` ก่อน) · demo: ผ่าน `applyStockMovement` ใน logic.ts เท่านั้น
- **ต้นทุนที่ใช้ตัดงบ = `unitPrice × (qtyRequested − qtyTransferred)`** ไม่ใช่ `qtyRequested` เฉยๆ (0038) — เขียนสูตรงบใหม่ที่ไหนต้องใช้ helper `effectiveQty()` · **ยอดต่อ PO ใช้ `poCostSummary()`** ซึ่งคืนทั้ง `ordered` (จ่ายซัพ) และ `charged` (หักงบ Job) · ⚠️ ป้าย 2 ยอดนี้ต้องต่างกันบนจอเสมอ ห้ามยุบเป็น "มูลค่า" อันเดียว (เคยพลาด — ดู §9 ข้อ 13)
- **Status รายเครื่องใน Project Stock เป็น derive ทั้งหมด** — `unitFlowState()` + `UNIT_FLOW` (format.ts): `? → Pending → On Hand → ถูกดึงเข้า Job → เบิกแล้ว รอติดตั้ง → ติดตั้งแล้ว/ติดตั้งไม่ได้` · **ไม่มีคอลัมน์ status ใน DB สำหรับช่วงต้น** (คำนวณจาก ETA to WH + วันปัจจุบัน) · **ไม่ระบุ ETA = `?` ไม่ใช่ On Hand** — ระบบไม่เดาว่าของถึงคลังแล้ว
- **ETA to WH = `fob_date + COALESCE(eta_lead_days, 60)`** คำนวณตอนแสดงผล ไม่เก็บคอลัมน์ · `plan_po_receipt_date` = ETA แบบกรอกเอง (ใช้เมื่อไม่มี FOB) · ⚠️ **คนละตัวกับ `plan_po_date`** ที่เป็น "Plan PO receipt = วันรับ PO จากลูกค้า" (0053) — สองคอลัมน์นี้ชื่อคล้ายกันมาก อ่าน comment ใน 0053 ก่อนแตะ
- **ห้ามเบิกให้ Service ถ้า Job ถือ LBS ที่ Status = Pending** (0052 `app_assert_job_eta_ready`) — guard อยู่ทั้ง `app_exec_issue_job` และ `rpc_request_approval` · **นับเฉพาะ pending ไม่นับ `?`** ("ไม่รู้" ไม่ใช่ "รู้ว่ายังไม่มา" — ถ้าบล็อก `?` ด้วยจะเบิกงานเดิมทั้งระบบไม่ได้)
- **`profiles.id` อ้าง `auth.users`** → ทุก user ต้องมีบัญชี login · คนที่ไม่ต้อง login (ช่างภาคสนาม/outsource) ต้องเก็บใน `team_members` ไม่ใช่ profiles (0036)
- **ทดสอบ UI ด้วย Browser pane**: พิกัดคลิกเพี้ยนสเกล (สัดส่วนต่างกันต่อ tab เช่น ~0.59 หรือ ~0.73 เทียบ CSS pixel) และ screenshot ไม่ render modal overlay → วิธีที่ใช้ได้: อ่าน `getBoundingClientRect()` ผ่าน `javascript_tool` แล้วคูณสเกลก่อนคลิก · อ่านเนื้อ modal จาก `document.querySelector('.modal').innerText` · `form_input` ใช้ได้กับ text/textarea/select แต่ **checkbox/radio ต้องคลิกจริง** (React onChange ไม่รับค่าจากการ set `.checked`)
- `.env`, `.env.*.local`, `.env.live-backup`, `node_modules` อยู่ใน `.gitignore` — อย่า commit
- **ปุ่มแก้ไข/ดึง LBS/ออก PR/เบิก/ยกเลิก/แก้งบ หายหมด** เมื่อ Job **ล็อก** (terminal_status = issued/installed/cancelled) — เช็ค badge สถานะข้างชื่อ Job · และแก้งบ/ออก PR ต้อง login เป็น **Project หรือ Manage** เท่านั้น (badge มุมซ้ายล่าง) · "ออก PR" โผล่เมื่อมีวัสดุ source purchasing รอออก PR (ต้อง `+ เพิ่มวัสดุ` ก่อน)
- **Job ค้างสถานะ อยากลบทิ้งเปิดเลขเดิมใหม่**: รัน `supabase/cleanup_job.sql` (แก้ `v_job_no`) — ลบเฉพาะ Job นั้น + คืน LBS เข้าสต็อก (ไม่ลบเครื่อง). ยกเลิก Job ปกติ (cancel) จะล็อกเลขไว้ (ยังเปิดเลขเดิมซ้ำไม่ได้) จึงต้องลบด้วยสคริปต์นี้
- **รัน demo mode ในเครื่อง** (ทดสอบ UI ไม่ยุ่ง production): `mv .env .env.bak` แล้ว restart dev server (หรือ `npm run dev -- --mode demo` ใช้ `.env.demo.local` ที่ค่าว่าง) — vite bake env ตอน start, เปลี่ยน .env ต้อง restart/stop-start ให้ module cache เคลียร์
