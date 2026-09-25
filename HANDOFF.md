# HANDOFF — 115kV LBS Project Management Platform

เอกสารส่งมอบ/สรุปสถานะระบบ (อัปเดต 2026-08-22) — อ่านไฟล์นี้ก่อนดูแลระบบต่อ
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

> ✅ **(2026-09-25) `0079` 🏁 ปิดงาน = เอกสารรับมอบ + Warranty · เมนูใหม่ Service (Warranty) เฟส 1 — รัน SQL บน production แล้ว (ผู้ใช้ยืนยัน) และ push ขึ้น `main` แล้ว**
> ลำดับถูก: รัน SQL ก่อน push (`rpc_close_job_install` เปลี่ยน signature)
> เฟส 2 (Repair Requests · S.O.) / เฟส 3 (Service Reports · S.R.) — รอผู้ใช้ยืนยัน Template ใบ S.O./S.R.
>
> ✅ **(2026-09-23) `0078` Standard Drawing แนบ PDF หลายไฟล์ — รัน SQL บน production แล้ว (ผู้ใช้ยืนยัน) และ push ขึ้น `main` แล้ว** · commit `9617f15` (0078) + `5dd47bc` (LINE: แสดง error จริง + นับโควตาต่อสมาชิกกลุ่ม · ไม่มี SQL)
>
> ✅ **(2026-09-24) แก้ป้ายสถานะ Jobs ขัดกับกำหนดส่ง — frontend อย่างเดียว ไม่มี SQL · push ขึ้น `main` แล้ว**
> (1) ใบ Issued ที่ติดตั้งครบ คอลัมน์สถานะเคยขึ้น "Issued (รอติดตั้ง)" → ตอนนี้ขึ้นช่วงย่อยจาก `jobStatusPhase()`
> (2) ใบ Partially Issued ที่ติดตั้ง LBS ครบแต่วัสดุค้างเบิก เคยขึ้น "รอปิดงาน" + ปุ่ม 🏁 ปิดงานกดได้แล้ว error
>     → state ใหม่ `awaiting_issue_rest` ("ติดตั้งครบ · รอเบิกของที่เหลือ") · `jobInstallSummary.canClose` = `unitsDone && terminalStatus === issued`
>
> ✅ **ไม่มี SQL / frontend ค้าง (2026-09-19)** — 0070–0077 รันบน production แล้วทุกไฟล์
> และ push ขึ้น `main` ครบ · ล่าสุด **`8691850`** (0077 Project แก้งบประมาณหลังใบล็อกได้)
>
> รอบ 2026-09-15 → 09-17 ทำไป 5 ก้อน · **ทุกก้อนรัน SQL ก่อน push** ตามกติกา §9:
>
> | migration | เรื่อง | commit |
> |---|---|---|
> | `0070` | ✏️ แก้จำนวนสั่งใน PO / ตัด item ที่สั่งเกิน — ปลด PO ที่รับของไม่ครบแล้วค้างตลอดไป | `583c174` |
> | `0071` | 🔧 ด่านงานหน้าไซต์เป็นรายเครื่อง — ช่างทำงานได้ตั้งแต่เบิกบางส่วน | `d7a2936` |
> | `0072` | 🔔 ใบที่ปิดเงียบ (โอนคืนคลัง/ตัดจำหน่าย/แก้จำนวน) ประกาศให้ Service | `b0a3a9b` |
> | `0073` | 📄 Contract No. รายเครื่อง — ข้อมูลลูกค้าเลิกเป็น "แผน" เมื่อมีสัญญา | `e48f0b0` |
> | `0074` | 📎 เอกสารแนบรายเครื่อง (PDF/รูป หลายไฟล์ · private bucket) | `8cdb9a6` |
>
> รอบ 2026-09-17 (ชุดที่ 2) — **รัน SQL ก่อน push ตามกติกา §9 แล้ว**:
>
> | migration | เรื่อง | commit |
> |---|---|---|
> | `0075` | 📅 ขยาย/แก้กำหนดส่ง (EOT) + สถานะกำหนดส่งแบบใหม่ (แก้บั๊ก "เลยกำหนด" ทั้งที่กำลังติดตั้งอยู่) | `2875868` |
> | `0076` | 📎 เอกสารแนบรายงวดเงิน + `rpc_add_job_payment` คืน id | `2875868` |
>
> รอบ 2026-09-18/19 (ชุดที่ 3) — **รัน SQL ก่อน push ตามกติกา §9 แล้ว**:
>
> | migration | เรื่อง | commit |
> |---|---|---|
> | — | 🔧 แยก "นัดติดตั้ง" ออกจาก "กำหนดส่ง" (frontend อย่างเดียว ไม่มี SQL) | `bc244eb` |
> | `0077` | 💰 Project เจ้าของงานแก้งบประมาณได้แม้ใบล็อกแล้ว + ปุ่มที่กดไม่ได้ต้องบอกเหตุผล | `8691850` |
>
> ⏳ **ยังไม่ได้ทดสอบบน production: การอัปโหลดไฟล์จริงของ 0074 และ 0076** — เส้นทาง
> `uploadUnitDoc / uploadPaymentDoc → signed URL` ต้องลองแนบ 1 ไฟล์บนของจริงสักครั้ง
> (ถ้า bucket ไม่ได้ถูกสร้าง จะ error ตอนอัปโหลด ไม่ใช่ตอนกดปุ่ม)
> บนเดโมยืนยันครบแล้วทั้ง 2 ตัว โดยยัดไฟล์เข้า `<input type=file>` ด้วย `DataTransfer` ผ่าน
> `javascript_tool` (เดโมเก็บไฟล์เป็น data URL ⇒ ทดสอบ flow ได้จริงยกเว้นตัว Storage)
>
> ---
>
> ### เดิม (2026-08-20)
>
> ✅ 0055 + 0056 รันบน production แล้ว และ code review รอบ 2
> (#2 #3 #4) push ขึ้น `main` แล้วที่ commit **`4d11d75`** · **ลำดับถูก: รัน SQL ก่อน push** (ต่างจากรอบ 0055)
>
> 🟠 **ต้องทำด้วยคน 1 อย่าง — งานที่เคยสลับ LBS ก่อน 0056** ต้นทุน/ETA ยังผูกผิดอยู่ (0056 แก้เฉพาะการสลับครั้งต่อไป ไม่ย้อนหลัง)
> `SELECT created_at, detail FROM audit_logs WHERE action = 'swap_lbs_serial' ORDER BY created_at DESC;`
> → ไม่มีแถว = จบ · มีแถว = ให้ Division เทียบ `unit_cost` รายเครื่องกับ Serial จริงหน้างาน แล้วแก้ผ่าน "แก้ข้อมูล" ในหน้า Project Stock
> (เครื่องที่ยังไม่เบิกแก้ได้ · เครื่องที่ `issued` แล้ว `trg_block_issued_edit` ล็อก — ต้องแก้ที่งบ Job ตรงๆ)
>
> ---
>
> ### 🔒 code review รอบ 3 (2026-08-22) — ปิดช่องความปลอดภัยแล้ว 3 ก้อน
>
> รีวิวทั้งระบบอีกรอบ (frontend + Functions + RLS + grant + git history) **เจอของใหม่ 11 ข้อ นอกเหนือจาก #5–#10 เดิม**
> เรียกว่า **F1–F11** (รายละเอียดครบใน §10) · ที่ทำไปแล้ว 3 ก้อน — **ไม่มี SQL / frontend ค้าง**:
>
> | commit | ก้อน | ปิดข้อ | ต้องรัน SQL |
> |---|---|---|---|
> | `e996a42` | A — notifications + LINE dispatch | **F2** | ไม่ต้อง |
> | `54a48ed` | C — LINE endpoints fail-closed | **#5 · F4 · F9** | ไม่ต้อง |
> | `10a5b04` | B — ปิดประตูเขียนตารางตรง | **F1 (critical) · F6** | ✅ `0057` รันแล้ว 2026-08-22 |
> | `b24f262` + `ddcbd70` | D — ปิดบัญชีแล้วต้องอ่านไม่ได้ | **F3** | ✅ `0058` รันแล้ว 2026-08-22 |
>
> **F2 คือของที่พังอยู่จริงบน production มาหลายสัปดาห์** — `loadAll` ดึง notifications แบบ `asc:true limit 300`
> = "เก่าสุด 300 แถว" ⇒ เกิน 300 แถวแล้วกระดิ่งค้างอยู่ที่ข้อมูลเดือน ก.ค. และ **LINE หยุดส่งทั้งระบบเงียบ ๆ**
> (`dispatchLine` เช็ค `pending` จาก slice นั้น) · ดู §9 ข้อ 17
>
> **F1 คือช่องที่อยู่มาตั้งแต่ 0001** — ดู §9 ข้อ 18 · §3 ที่เคยเขียนว่า "ยิง API ตรงก็ข้าม rule ไม่ได้" **ไม่จริงจนกระทั่ง 0057**
>
> 🔴 **สิ่งที่ 0058 ปิดไป กว้างกว่าที่ประเมินไว้ตอนแรก — เคยรั่วถึงระดับ `anon`**
> ตอนรีวิวคิดว่า view เป็นช่องให้ "บัญชีที่ถูกปิด" อ่านข้อมูลได้ · **ผิด — เปิดถึงคนที่ไม่ได้ login เลยด้วยซ้ำ**
> view รันด้วยสิทธิ์ owner (ไม่ใช่ `security_invoker`) จึง bypass RLS ของตารางข้างใต้ทั้งหมด
> และ `anon` มี `SELECT` grant มาโดย default (0057 ตัดแค่ INSERT/UPDATE/DELETE)
> ⇒ **ใครก็ตามที่มี anon key ยิง `/rest/v1/v_job_status` ได้ Job No. + ชื่อลูกค้า + สถานะทุกงาน โดยไม่ต้องมีบัญชี**
> และ anon key อยู่ใน bundle ที่โหลดได้จากเว็บสาธารณะ · ปิดแล้วที่ 0058 (ยืนยัน: `permission denied for view`)
> 🔎 **อยากรู้ว่าเคยมีใครใช้ช่องนี้จริงไหม** — Supabase → Logs → API/PostgREST ย้อนหลัง กรอง path `v_job_status`
>
> ⏳ **ต้องทดสอบด้วยบัญชีจริง (ยังไม่ได้ทำ)** — `0058` เพิ่ม restrictive policy บน 28 ตาราง
> DO block ตรวจได้แค่ว่า policy ถูกสร้างและเป็น RESTRICTIVE จริง **ตรวจไม่ได้ว่าคนใช้งานยังเห็นข้อมูล**
> → login ด้วย Project / Purchasing / Service / VIP อย่างละ 1 บัญชี ต้องเห็นข้อมูลครบทุกหน้า
> จอว่าง/แบนเนอร์ "โหลดข้อมูลไม่สำเร็จ" = rollback ทันที (สคริปต์ท้ายไฟล์ `0058`)
>
> ---
>
> ### 🧭 จัดโครงเมนู + เทสต์ชุดแรก (2026-08-22 · ต่อจากชุดความปลอดภัย)
>
> | commit | ทำอะไร | ต้องรัน SQL |
> |---|---|---|
> | `9c33c25` | **เมนู 10 รายการชั้นเดียว → 6 Module** (§13) + **แก้ deep link ในการ์ด LINE ที่พังมาตั้งแต่ 0033** (§9 ข้อ 21) | ไม่ต้อง |
> | `b758b22` | **Vitest + 46 เคส** บนสูตรเงิน/สถานะ — เทสต์ชุดแรกของโปรเจกต์ (§11.1) | ไม่ต้อง |
>
> **`npm test` ต้องเขียวก่อน commit ทุกครั้ง** (~1.5 วินาที ไม่ต้องต่อ DB)
>
> 🔵 **ชุดถัดไป**: #6–#10 + F5, F7, F8, F10, F11 = **ค้างได้** ทุกข้อมีเงื่อนไข "เมื่อไรจะกลายเป็นต้องแก้" กำกับไว้ใน §10
> · งานที่คุ้มที่สุดที่เหลือคือ **parity suite** (พิสูจน์ว่า `logic.ts` กับ SQL ให้ผลตรงกัน) — เทสต์ที่เพิ่งทำ
> พิสูจน์ได้แค่ฝั่ง demo · ดู §10 🟢 พัฒนาต่อ และ §11.1

| ส่วน | ค่า / สถานะ |
|---|---|
| Hosting | **Cloudflare Pages — LIVE แล้ว** https://lbs-platform-sdt.pages.dev (ย้ายจาก Netlify 2026-07-15, auto-deploy จาก `main`) |
| GitHub repo | https://github.com/SDT-Supportai/LBS-Management-Platform-SDT (root = โฟลเดอร์นี้) |
| Supabase project ref | `mrdnxajwnvkgvfyaclwv` (region: ตามที่สร้าง) |
| Migrations ที่รันแล้ว | **0001–0058 รันครบ** (0042–0048 รัน 2026-08-07 · 0049–0054 รัน 2026-08-08 · 0055–0056 รัน 2026-08-20 · **0057–0058 รัน 2026-08-22**) · ถ้า LINE ไม่ส่ง เช็คตาราง `app_settings` (0017) · อัปโหลดรูป/ไฟล์แนบไม่ได้ เช็ค bucket `install-photos` (0019 — ไฟล์แนบปัญหา prefix `job-issues/` · Drawing `standard-drawings/` · Price list `standard-prices/`) |
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
- **หลักความปลอดภัย**: business rules ทั้งหมดอยู่ใน **PostgreSQL RPC (SECURITY DEFINER)** — ตรวจสิทธิ์แผนกจาก JWT (`app_assert_dept`) และกัน race ด้วย atomic UPDATE · ปุ่มใน UI เป็นแค่ convenience
  - **ที่ทำให้ "ยิง API ตรงก็ข้าม rule ไม่ได้" เป็นจริง คือ `0057` ไม่ใช่ตัว RPC เอง** (แก้ 2026-08-22)
    ⚠️ ประโยคเดิมตรงนี้เขียนว่า RPC ทำให้ข้ามไม่ได้ **ซึ่งผิด** — "ทุก write ของ*เรา*ผ่าน RPC" เป็นเรื่องของโค้ดฝั่งเรา
    ไม่ได้แปลว่า client เขียนตารางตรงไม่ได้ · Supabase ให้ role `authenticated` มี INSERT/UPDATE/DELETE
    ครบทุกตารางใน `public` เป็น **default grant** ⇒ RLS เป็นประตูเดียว และ 0001 ดันเปิดประตูนั้นไว้
    (policy ฝั่งเขียน **19 ตัว** แบบ `FOR ALL/INSERT/UPDATE TO authenticated` — 16 ตัวเขียนตรง + 3 ตัวจาก `format()` loop ใน 0045)
    · `0057` ตัด grant ทิ้ง ตอนนี้ประโยคข้างบนถึงเป็นจริง
    **กติกาต่อจากนี้: เพิ่มตารางใหม่แล้วอย่า `GRANT` DML ให้ `authenticated`/`anon` เด็ดขาด** —
    `ALTER DEFAULT PRIVILEGES` ใน 0057 กันให้แล้ว แต่ `GRANT` ตรง ๆ ยังทับได้ · ดู §9 ข้อ 18

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
      xlsxReport.ts          **โครงไฟล์ "รายงานผู้บริหาร" (Excel) — แหล่งความจริงเดียวของทุกหน้า (รายงานผู้บริหาร · 2026-09-09)**
                             summarySheet (ชีตสรุป: หัวรายงาน/KPI/ตารางแบ่งกลุ่ม/คำเตือน/หมายเหตุ) ·
                             dataSheet (ชีตข้อมูล: หัวตารางแถว 1 + autofilter + รูปแบบตัวเลข + แถวรวมถ้าสั่ง) ·
                             guideSheet (ชีตคำอธิบายคอลัมน์) · dataSheetName (หาชีตข้อมูลตอน Import) ·
                             buildWorkbook / saveReport / stampMeta / orDash
      xlsxReport.test.ts     13 เทสต์คุมสัญญา round-trip + แถวรวมไม่อยู่ใน autofilter
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
    migrations/0001..0079    schema, RPC, seed, bug fixes, ฟีเจอร์ (ดูตารางหัวข้อ 5)
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
| `0023_edit_budget_when_locked.sql` | **ฟีเจอร์ (2026-07-22)**: Manage แก้งบประมาณได้แม้ Job ล็อก (issued/installed/cancelled) — `rpc_update_job_budget` (เฉพาะ admin, ไม่ผ่าน `app_assert_job_editable`, แก้เฉพาะ sale_price + budget_costs ไม่แตะ scope/allocation) · demo sync `logic.ts updateJobBudget` · UI: ปุ่ม "✏️ แก้ไขงบประมาณ" โชว์ตอนล็อกเฉพาะ Manage, save route ไป updateJobBudget เมื่อ locked · ⚠️ **ข้อจำกัด "Manage เท่านั้น" ถูกยกเลิกแล้วที่ 0077** (Project เจ้าของงานแก้ได้ด้วย เพราะต้นทุนจริง 5 หมวดที่กรอกมือเกิดหลังเบิกเป็นส่วนใหญ่) |
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
| `0058_read_requires_active.sql` | **ความปลอดภัย (2026-08-22 · F3 ขั้น 2)**: **ปิดบัญชีแล้วต้องอ่านข้อมูลไม่ได้** — คู่กับขั้น 1 (`b24f262`) ที่ ban ที่ระดับ auth · ขั้น 1 ตัด "การออก token ใหม่" แต่ access token ที่ถืออยู่แล้วยังใช้ได้จนหมดอายุ (default 1 ชม.) ไฟล์นี้คือชั้นที่สอง · **ใช้ `AS RESTRICTIVE` policy ชื่อ `require_active` ไม่ recreate `read_all`** — restrictive ถูก **AND** เข้ากับ permissive ที่มีอยู่ = "เพิ่มเงื่อนไข" ไม่แตะ policy เดิมสักตัว (ถ้า DROP+CREATE 25+ ตัว พลาดตัวเดียว = แผนกนั้นมองไม่เห็นข้อมูลทั้งตาราง และต้องไล่ทดสอบ 25 รอบ) · rollback = DROP เฉพาะ `require_active` · **ข้อยกเว้นเดียว `profiles`**: เปิดให้อ่าน**แถวของตัวเอง**ได้เสมอ (`my_is_active() OR id = auth.uid()`) เพราะ `StoreContext.login` อ่าน profiles ตัวเองทันทีหลัง `signInWithPassword` เพื่อเช็ค `is_active` — ถ้า restrict ตรงไปตรงมา แถวตัวเองหายไปด้วย → `.single()` error → โค้ดข้าม `signOut` → ผู้ใช้เจอแอปว่างเปล่าแทนข้อความ "บัญชีนี้ถูกปิดการใช้งาน" · **+ ตัดสิทธิ์ view (ข้อ 3b) — ขาดไม่ได้** ไม่งั้นข้อ 3 แทบไม่มีความหมาย เพราะ view รันด้วยสิทธิ์ owner ⇒ bypass RLS ทั้งหมด (ดู §9 ข้อ 19 — ของจริงที่รั่วถึง `anon`) · **รายละเอียดที่พลาดง่าย**: `is_active` เป็น `BOOLEAN DEFAULT true` ที่ **nullable** ⇒ ต้อง `COALESCE(is_active, true)` ไม่งั้นบัญชีที่ค่าเป็น NULL มองไม่เห็นอะไรเลยทั้งที่ยังใช้งานอยู่ · `my_is_active()` ต้อง **STABLE** (ไม่งั้น query profiles ทุกแถว) **+ SECURITY DEFINER** (ไม่งั้นตัวมันเองติด policy ที่เพิ่งสร้าง = recursive) · วนจาก `pg_class` ไม่ hardcode รายชื่อ → ครอบ `std_drawings`/`std_boms`/`std_bom_lines` ที่ 0045 สร้างผ่าน `format()` loop ด้วย · **⚠️ รันครั้งแรกล้ม** `42P01 relation "public.pg_stat_statements_info" does not exist` เพราะไม่ได้กรอง view ของ extension — แก้ที่ `ddcbd70` (กรอง `pg_depend deptype='e'` ครบ 4 ที่ + `to_regclass` guard + เพิ่มข้อ 0 PREFLIGHT) ดู §9 ข้อ 20 · มี DO block ตรวจผล 4 ข้อ (ทุกตาราง RLS มี `require_active` · policy เป็น RESTRICTIVE จริง · helper STABLE+SECDEF · ไม่มี view ที่ยังอ่านได้) **แต่ตรวจได้แค่โครงสร้าง ไม่ได้ตรวจว่าคนใช้งานจริงยังเห็นข้อมูล — ต้องทดสอบด้วยตา** |
| `0057_lock_direct_writes.sql` | **ความปลอดภัย (2026-08-22 · F1 critical + F6)**: **ปิดประตูเขียนตารางตรง** — `REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` จาก **`authenticated` + `anon`** และ `ALTER DEFAULT PRIVILEGES ... REVOKE` (ข้อหลังสำคัญเท่ากัน: ไม่ทำ ตารางใหม่ใน 0058+ จะได้สิทธิ์คืนเงียบ ๆ จาก default ของ Supabase) · **`SELECT` ไม่แตะเลย** — policy `read_all` คงเดิมทั้งหมด หน้าจอทำงานเหมือนเดิม 100% · **ต้นเหตุ**: Supabase ให้ `authenticated` มี DML ครบทุกตารางเป็น default grant (ไม่มี `GRANT` บนตารางในไฟล์ migration ไหนเลย) ⇒ RLS เป็นประตูเดียว แต่มี policy ฝั่งเขียน **19 ตัว** แบบ `FOR ALL/INSERT/UPDATE TO authenticated` (0001 เป็นหลัก + `standards_write` ที่ 0045/0054) = ประตูเปิด · **ทำได้จริงจาก DevTools ด้วย JWT ตัวเอง**: Project ยิง `PATCH /rest/v1/jobs {"terminal_status":"issued"}` → งานเป็น Issued ทันที ไม่ผ่าน Division ไม่มี audit ไม่มี notification ข้าม guard ETA ของ 0052 (`v_job_status` อ่านคอลัมน์นี้ตรง ๆ · ทั้งระบบมี trigger 4 ตัว ไม่มีตัวไหนคุม `jobs`) · `PATCH /rest/v1/accessory_stock {"qty_on_hand":9999}` → ยอดเปลี่ยนโดยไม่มีแถวใน `stock_movements` ⇒ ledger 0038 กระทบยอดไม่ได้อีก · `POST /rest/v1/audit_logs` ได้จากทุกบัญชี = ปลอมหลักฐาน · **ยืนยันว่าไม่กระทบการใช้งาน 4 ข้อ**: (1) frontend ไม่เขียนตารางตรงสักจุด (`grep '.from(' src/` เจอแต่ `.select()` + `storage.from('install-photos')` ซึ่งคนละ schema) (2) RPC ที่เขียนตารางทุกตัวเป็น SECURITY DEFINER = bypass ทั้ง RLS และ grant อยู่แล้ว — ตัวที่ไม่ใช่ DEFINER 5 ตัวเป็น pure helper ไม่แตะตาราง (`app_next_no`/`app_sum_budget_costs`/`app_unit_cost`/`app_unit_lead`/`app_payment_amount`) + trigger `fn_block_issued_job_edit` ที่ SELECT อย่างเดียว (3) Pages Functions ทั้ง 4 ใช้ `service_role` (4) `LoginPage` ไม่อ่านตารางก่อน login ⇒ revoke จาก `anon` ปลอดภัย · **ยังไม่ DROP policy 19 ตัวนั้น** (ไม่มีผลแล้วเมื่อ grant หาย) เพื่อให้ rollback ด้วยคำสั่งเดียว → ลบใน `0058` · **+ F6**: `FOR UPDATE` ใน `rpc_receive_po_items` ผ่าน `app_swap_guard` (§9.5 ห้าม recreate ทั้งก้อน — 0031 patch ข้อความ `app_notify` ของฟังก์ชันนี้ไว้ · §9.6 patch บรรทัดเดียว) — เดิม `SELECT INTO` ไม่ล็อกแถวแล้ว UPDATE เขียนค่าสัมบูรณ์ ⇒ Purchasing 2 คนรับ line เดียวกันใส่ 5 ทั้งคู่ ได้ 5 ไม่ใช่ 10 ทั้งคู่เห็น toast สำเร็จ · **ไม่เปลี่ยน signature** → ไม่มีเรื่อง `PGRST202` · **ไม่ต้อง demo sync** (logic.ts เป็น single-user localStorage ไม่มี concurrency/grant) · มี DO block ตรวจผล 3 ข้อท้ายไฟล์ + สคริปต์ rollback 4 บรรทัด |
| `0026_job_install_sites.sql` | **ฟีเจอร์ (2026-07-23)**: หลายจุดติดตั้งต่อ Job — `jobs.install_sites` JSONB (array `{location, requiredDate}` = จุดที่ 2+; จุดที่ 1 ยังใช้ install_location/required_date เดิม) · drop+recreate `rpc_create_job`/`rpc_update_job` (+`p_install_sites`) · ข้อมูลวางแผนอย่างเดียว ไม่ผูก Serial/ไม่แตะ flow issue/confirm · UI: เปิด/แก้ Job โชว์ "เพิ่มจุดติดตั้ง" เมื่อ LBS>1 (≤ จำนวน LBS), JobDetail แผง "จุดติดตั้ง", list badge "+N จุด" · demo sync `logic.ts` (normalizeInstallSites) |

| `0059_partial_issue_to_service.sql` | **ฟีเจอร์ (2026-08-23)**: **เบิกให้ Service แบบแยกส่วน — LBS / Accessory ตาม PO** · เดิมเบิกเป็น all-or-nothing (`app_exec_issue_job` พลิก `lbs_units` ทุกเครื่อง + `terminal_status='issued'` ในคำสั่งเดียว) ⇒ LBS ถึงคลังแล้วแต่ Accessory ยังรอ PO อีก 2 ใบ = เข้าไซต์ไม่ได้ทั้งงาน · **โมเดลใหม่**: LBS ใช้ `lbs_units.status` รายเครื่องตามเดิม · Accessory ใช้คอลัมน์ใหม่ `job_accessory_requests.issued_to_service_at` (⚠️ **คนละเรื่องกับ `status='issued'`** ที่หมายถึง "เบิกจากคลังคงเหลือเข้า Job แล้ว") · `jobs.terminal_status='issued'` ตั้งเมื่อ **ครบทั้งใบ** เท่านั้น โดย `app_finalize_issue` เรียกท้ายทุก action ที่เบิกของออกไป — ระหว่างทาง `v_job_status` คืนสถานะใหม่ **`partially_issued`** · **เกณฑ์ Ready/Not Ready**: LBS = allocated + ETA to WH ผ่านแล้ว ('?' ไม่บล็อก ตามกฎเดียวกับ 0052) · Accessory = คลังคงเหลือ ต้อง `status='issued'` · สั่งซื้อ ต้องรับของครบทั้งบรรทัด **และ PO ใบนั้น `status='received'`** (PO ที่ยัง "รอรับของ" เบิกไม่ได้แม้บางบรรทัดครบแล้ว) · **สิทธิ์**: เบิก LBS ผ่าน Division (approval `issue_job` ความหมายแคบลงเป็น "เบิก LBS" — **คงค่า enum เดิม ไม่แก้ CHECK** เพื่อไม่ให้ประวัติคำขอเก่าเสีย) · Manage ตรงผ่าน `rpc_issue_job_lbs` · เบิก Accessory ที่รับของแล้ว = Project เจ้าของงานกดเอง (`rpc_issue_job_accessory`) ไม่ผ่าน Division · **⚠️ `v_job_status` เดิมนับเฉพาะ `status='allocated'`** ซึ่งใช้ได้ตอนเบิกเป็น all-or-nothing (terminal_status พาไป) — พอเบิกแยกส่วนได้ เครื่องที่ออกไปแล้วหลุดจากการนับ ⇒ งานตกกลับเป็น `draft` ทั้งที่ของอยู่ในมือ Service (บั๊กเดียวกับ §9 ข้อ 7 คนละทาง) จึงเปลี่ยนเป็นนับ `IN ('allocated','issued')` · **ล็อกรายเครื่อง**: `fn_block_issued_job_edit` เพิ่มเงื่อนไข "`OLD.status='issued'` ห้ามแก้" เพราะช่วง `partially_issued` ค่า `terminal_status` ยังว่าง ล็อกระดับใบจึงไม่ทำงาน · `app_exec_cancel_job` เพิ่ม `app_assert_no_issued_out` — ของอยู่ในมือ Service ระบบคืนเข้าคลังเองไม่ได้ · **วิธีแก้ฟังก์ชันเดิม (§9.5/§9.6)**: `app_exec_issue_job` + `app_exec_cancel_job` patch แบบต่อท้ายบรรทัดเดียว + เช็ค marker (ทั้งคู่โดน 0031 ย่อข้อความ · ตัวแรกโดน 0052 แทรก guard) · `app_exec_approve` recreate ได้ (0041 เป็นเจ้าของ body ล่าสุด grep แล้วไม่มี patch ตามหลัง) · `rpc_request_approval` **recreate พร้อม pre-check** ที่ RAISE ถ้า marker ของ 0031/0037/0041/0052 หายไปแม้ชั้นเดียว (สะสม patch มา 5 ชั้น — ตรวจก่อนทับ ไม่ใช่ทับแล้วค่อยรู้) · **backfill**: งานที่เบิกครบก่อน 0059 ตั้ง `issued_to_service_at = issued_at` ให้ ไม่งั้นหน้าจอโชว์ "ยังมีวัสดุค้างรอเบิก" ของงานที่ปิดไปหลายเดือน · demo sync `logic.ts`: `jobIssuePlan` / `unitIssueBlockReason` / `accIssueBlockReason` / `issueJobLbs` / `issueJobAccessory` / `finalizeIssue` + 17 เคสใน `logic.test.ts` · **+ แก้บั๊กที่เจอระหว่างทาง**: `mapAccReq` ใน `remote.ts` **ไม่เคย map `qty_transferred`** (ตกมาตั้งแต่ 0038) ⇒ `effectiveQty()` บนโหมด LIVE คืนยอดเต็มทั้งที่โอนคืนคลังไปแล้ว ต้นทุนที่ตัดเข้า Job และยอด "ของค้างที่ Job" เกินจริง (demo ถูกอยู่แล้ว จึงไม่มีใครเห็น) |

| `0060_plan_install_coords.sql` | **ฟีเจอร์ (2026-08-23)**: **พิกัดจุดติดตั้ง "ตามแผน"** — หน้า Map Tracking (7e7ce89) วางหมุดจาก **การ Check-in จริง** เท่านั้น ⇒ เห็นแต่งานที่ติดตั้งเสร็จ · งานที่รอติดตั้งไม่มีหมุดเลย ใช้วางแผนเส้นทางทีมช่างไม่ได้ · เก็บพิกัดตั้งแต่เปิดงาน: **จุดที่ 1** → คอลัมน์ใหม่ `jobs.plan_lat/plan_lng` NUMERIC(9,6) (ทศนิยม 6 ตำแหน่ง ≈ 0.11 ม. และรับ longitude 3 หลักหน้าจุดได้) · **จุดที่ 2+** → คีย์ `lat`/`lng` ใน `jobs.install_sites` JSONB เดิมจาก 0026 (ไม่ต้องเพิ่มคอลัมน์) · **⚠️⚠️ อย่าสับสน 2 ชุดพิกัดบน `jobs`**: `plan_lat/plan_lng` = **แผน** (กรอกตอนเปิดงาน แก้ได้) · `install_checkin_lat/_lng` (0019) = **หลักฐาน** (เกิดตอน Service ยืนยันหน้างาน) — หน้าแผนที่แยกสีให้ชัด ตามแผน = โปร่งเส้นประ · ติดตั้งแล้ว = ทึบเขียว · ติดตั้งไม่ได้ = แดง · **ตรวจพิกัดที่ DB ด้วย** `app_th_coord_ok` + `app_assert_th_coord` + `app_assert_sites_coord` (guard `jsonb_typeof` ก่อนวน array ไม่งั้น error อ่านไม่รู้เรื่อง) — เคสที่เจอบ่อยสุดคือ **สลับ lat/lng** ซึ่งทั้ง client (`parseLatLng`) และ DB ตรวจแล้ว**บอกค่าที่ถูกให้เลย** ไม่ใช่แค่ "ค่าไม่ถูก" · ถ้าไม่ตรวจ หมุดจะไปโผล่กลางทะเลจีนใต้แล้วหน้าแผนที่กรองทิ้งเงียบ ๆ (ข้อมูลหายโดยไม่มีใครรู้) · **UI กรอกช่องเดียวรับ "lat, lng"** เพราะของจริงคนคลิกขวาใน Google Maps → คัดลอก ได้คู่มาก้อนเดียว (บังคับแยก 2 ช่อง = เพิ่มงาน + เพิ่มโอกาสสลับค่า) · **⚠️ เปลี่ยน signature `rpc_create_job`/`rpc_update_job` (+2 args) ⇒ DROP+recreate (§9.8) และต้องรัน SQL ก่อน push** (บทเรียน 0055 · body ล่าสุดของทั้งคู่เป็นของ 0026 grep 0027–0059 แล้วไม่มี patch ตามหลัง ไม่มี `app_notify` จึงไม่โดน 0031 → recreate ปลอดภัย) · **+ แก้บั๊กจาก 0059**: `rpc_update_job` นับ "LBS ที่ถืออยู่" จาก `status = 'allocated'` เท่านั้น หลัง 0059 เครื่องที่เบิกออกไปเป็น `issued` ⇒ หลุดการนับ ⇒ Project ลด `lbs_qty_required` ต่ำกว่าจำนวนเครื่องที่**ส่งไปมือ Service แล้ว**ได้ (demo แก้ที่ `logic.ts` ไปแล้วตอน 0059 ฝั่ง SQL ค้าง) · demo sync `logic.ts`: `TH_BOUNDS`/`inThailand`/`parseLatLng`/`fmtLatLng`/`normalizePlanCoord`/`normalizeInstallSites` + 12 เคสใน `logic.test.ts` |

| `0061_purchasing_material_db.sql` | **สิทธิ์ (2026-08-28)**: **เปิด Material Database ให้แผนก Purchasing** — ฐานข้อมูลวัสดุคือ "แคตตาล็อกของที่ใช้ตอนออก PR/PO" คนที่รู้ของจริง (รหัส Epicor · หน่วย · ชิ้นนี้สั่งซื้อหรือเก็บสต็อก) คือ Purchasing แต่เดิม `rpc_create_item`/`rpc_update_item`/`rpc_delete_item` เป็น admin-only ⇒ มีวัสดุใหม่ทีต้องรอ Manage · **เปิดเพิ่ม 5 RPC**: catalog 3 ตัว `ARRAY[]::TEXT[]` → `ARRAY['purchasing']` · ยอดคลังคงเหลือ `rpc_adjust_accessory_stock` + `rpc_set_stock_lot` `ARRAY['sales']` → `ARRAY['sales','purchasing']` (**จำเป็น** เพราะไฟล์ Import Excel มีคอลัมน์ "คลังคงเหลือ" + "Lot No." อยู่ในไฟล์เดียวกัน ถ้าไม่เปิด การนำเข้าจะล้มครึ่งทาง — มติผู้ใช้ 2026-08-28) · **⚠️ ที่ตั้งใจไม่เปิด**: Project Stock / LBS รายเครื่อง (`rpc_create_project_stock`/`rpc_add_units_to_stock`/`rpc_update_unit_info`/`rpc_set_stock_fob` …) ยังเป็น `sales` ล้วน ⇒ **ฝั่ง frontend ต้องแยก perm ใหม่ `accessoryStock.manage` ออกจาก `stock.manage`** ไม่ใช่เติม `purchasing` เข้า `stock.manage` (ไม่งั้น Purchasing แก้คลัง LBS ได้ไปด้วย) และแยก `material.manage` ออกจาก `master.manage` เพราะ `master.manage` ยังครอบ "ข้ามขั้นอนุมัติ" (`createPR`/`issueJob`/`cancelJob`) + จัดการผู้ใช้ · **patch เฉพาะบรรทัด `app_assert_dept` ด้วย `app_swap_guard` (§9.5/§9.6)** ไม่ recreate body ทั้งก้อน · **ไม่เปลี่ยน signature เลย** ⇒ ไม่มี PGRST202/PGRST203 และรัน SQL ก่อน/หลัง push ก็ได้ (ก่อนดีกว่า — push แล้วเห็นปุ่มแต่ SQL ยังไม่รัน จะกดแล้วเจอ "แผนกของคุณไม่มีสิทธิ์ทำรายการนี้" จาก server) · DO block ตรวจผล 3 ข้อ รวมข้อ 4.3 ที่ยืนยันว่า **ไม่หลุด**ไปเปิดสิทธิ์คลัง LBS ให้ purchasing · rollback อยู่ท้ายไฟล์ (comment ไว้) · demo sync: `StoreContext.tsx` เท่านั้น (`logic.ts` ไม่เช็คสิทธิ์เอง ด่านเดียวคือ `run(perm, ...)`) |

| `0062_fix_issue_job_label.sql` | **แก้ข้อความ (2026-08-28)**: **ป้าย `issue_job` ที่ตกค้างใน `rpc_add_approval_comment`** — 0059 เปลี่ยนความหมายคำขอ `issue_job` ให้แคบลงเป็น "เบิก **LBS** ให้ Service" และแก้ป้ายไว้ 3 ที่ (`rpc_request_approval` · `app_exec_approve` · `rpc_reject_request`) แต่ตกหล่นตัวที่ 4 ซึ่งป้ายอยู่ใน `CASE` ของ 0051 ⇒ บน LIVE ความเห็นของ VIP/Division แจ้งเตือนว่า "ให้ความเห็นคำขอ**เบิกให้ Service**" ขณะที่ตัวคำขอในหน้าเดียวกันเขียน "เบิก **LBS** ให้ Service" · **⚠️⚠️ ป้ายชุดนี้ถูกก็อปไว้ 4 ที่ แก้ที่เดียวไม่พอ**: (1) `src/data/logic.ts APPROVAL_TYPE_LABEL` → LINE + Audit ของโหมด demo (2) `src/ui/format.ts APPROVAL_TYPE_LABEL` → หน้าเว็บ (3) `functions/line-approval-push.js TYPE_LABEL` → การ์ด Flex ในแชท 1:1 ผู้อนุมัติ (4) SQL 4 ฟังก์ชัน · รอบ 0059 แก้แค่ (2) + SQL 3 ตัว ⇒ **กลุ่ม LINE ขึ้น "อนุมัติเบิกให้ Service" ส่วนการ์ดในมือถือก็ขึ้นป้ายเก่า** ทั้งที่หน้าเว็บเขียนอีกอย่าง (เจอตอนไล่ตรวจข้อความแจ้งเตือน 2026-08-28) · (1) และ (3) แก้มาพร้อม commit เดียวกับไฟล์นี้ · **patch เฉพาะบรรทัดด้วย `app_swap_guard`** (มี fallback เผื่อช่องว่างใน `CASE` ต่างจากไฟล์ 0051) · **ไม่เปลี่ยน signature · ไม่แตะ logic/สิทธิ์** รันก่อนหรือหลัง push ก็ได้ · DO block ตรวจว่าไม่เหลือป้ายเก่าในฟังก์ชันสาย approval ทั้ง 4 ตัว |

| `0063_issue_notify_one_per_action.sql` | **ข้อความแจ้งเตือน (2026-08-28)**: **เบิกให้ Service — 1 การกระทำ = 1 ข้อความ · ตัด Location ออก** — อนุมัติคำขอเบิก LBS 1 ครั้งเคยยิงเข้ากลุ่ม LINE 3 ใบรวด (`approval_approved` + `lbs_issued_to_service` + `job_issued`) โดย 2 ใบหลังใช้ 🚚 เหมือนกันและพูดเรื่องเดียวกันติดกัน อ่านแล้วนึกว่าส่งซ้ำ · **(1) ยุบใบ "ครบทั้งใบแล้ว" เข้าเป็นหางของข้อความที่ทำให้ครบ** — `app_finalize_issue` ไม่ยิง `app_notify('job_issued')` อีกแล้ว (ยังตั้ง `terminal_status` + ลง audit เหมือนเดิม) ผู้เรียกเติม `" · ครบทั้งใบแล้ว"` เอง โดยเทียบ `terminal_status` ก่อน/หลังเรียก `app_finalize_issue` · **(2) ตัด Location ออกจากข้อความแจ้งเตือนทั้งหมด** — สถานที่ติดตั้งจริงยาวจนดันข้อความในกลุ่มตกบรรทัด กลบ Job No./จำนวน/ช่วงวันที่ซึ่งเป็นส่วนที่ต้องอ่าน · **⚠️ audit ยังเก็บ Location ครบ** (เป็นหลักฐาน ต้องตอบได้ว่าส่งไปไหน) — มี DO block ตรวจข้อนี้โดยเฉพาะ · **⚠️ ที่ตั้งใจไม่ทำ (มติผู้ใช้)**: เบิก LBS + วัสดุพร้อมกันในการกดครั้งเดียวยังได้ 2 ข้อความ เพราะ UI ยิง 2 คำสั่งแยก transaction (วัสดุก่อน → LBS) การยุบเป็นใบเดียวต้องทำ RPC รวมซึ่งไม่คุ้มกับการไปแตะ flow เบิกของ · เคสนี้เกิดเฉพาะ Manage — ฝั่ง Project ผ่านอนุมัติอยู่แล้ว วัสดุกับ LBS จึงแยกเวลากันเสมอ · **วิธีแก้: recreate 3 ฟังก์ชัน ไม่ใช่ patch บรรทัด** เพราะต้องสลับลำดับ "แจ้งเตือน ↔ ปิดใบ" ซึ่งข้ามบรรทัด (§9.6 patch ได้บรรทัดเดียว) — ปลอดภัยตาม §9.5(ข) เพราะทั้ง 3 ตัวเกิดที่ 0059 · 0031 มาก่อน 0059 จึงไม่เคยแตะ · grep 0060–0062 แล้วไม่มีใคร patch ตามหลัง · มี **PREFLIGHT ตรวจ marker ของ 0059 ก่อนทับ** ถ้ามีใครแก้มือบน LIVE จะ RAISE ไม่ทับเงียบ ๆ · **ไม่เปลี่ยน signature ไม่แตะสิทธิ์/เงื่อนไขการเบิก** รันก่อนหรือหลัง push ก็ได้ · **⚠️⚠️ บทเรียน: `pg_get_functiondef` คืนคอมเมนต์ที่อยู่ในตัวฟังก์ชันมาด้วย** — DO block ตรวจผลที่เทียบสตริงดิบ ๆ จึง false positive ได้ถ้าคอมเมนต์บังเอิญพูดถึงชื่อ event (รันจริงบน LIVE รอบแรกล้มด้วย `0063: app_finalize_issue ยังยิง job_issued อยู่` ทั้งที่โค้ดไม่มีการยิงแล้ว) ⇒ **ตัดคอมเมนต์ด้วย `regexp_replace(def, '--[^\n]*', '', 'g')` ก่อนเทียบเสมอ และเช็คที่ "การเรียกจริง" (`app_notify`) ไม่ใช่ชื่อ event** — ใช้กติกานี้กับ DO block ตรวจผลของ migration ถัดไปด้วย · **บทเรียนที่ 2 (ล้มบน LIVE อีกรอบ)**: อย่าเหมาว่าฟังก์ชันกลุ่มเดียวกันเก็บ audit เหมือนกัน — `app_exec_issue_accessory` ไม่เคยเก็บนัดหมาย/สถานที่ใน audit มาตั้งแต่ 0059 (บันทึกเลข PO + รายการของแทน) เงื่อนไขที่วนเช็คทุกตัวจึง RAISE ผิด ⇒ **อ่าน body ของ migration ต้นทางให้ครบก่อนเขียนเงื่อนไขตรวจผล อย่าเดาจากชื่อฟังก์ชัน** · demo sync `logic.ts` (`finalizeIssue`/`jobBecameComplete`/`issueJobLbs`/`issueJobAccessory`) + 3 เคสใน `logic.test.ts` |

| `0064_epicor_issue_flag.sql` | **ฟีเจอร์ (2026-09-01)**: **ทำเบิก-Epicor — ธงกระทบยอดรายบรรทัดกับ ERP** · ของถึงมือ Job แล้ว (`status = issued` เบิกคลัง · `received` รับของครบ) แต่ Epicor ยังไม่รู้จนกว่าจะมีคนไปตัดใบเบิกใน ERP ⇒ ยอดคงคลังใน Epicor ค้างสูงเกินจริง และไม่มีใครตอบได้ว่าบรรทัดไหนตัดไปแล้ว · เพิ่มคอลัมน์ **"ทำเบิก-Epicor"** ในตาราง Purchase Orders หน้า Job — ปุ่ม **Done** ขึ้นเฉพาะ 2 สถานะนั้น กดแล้วกรอก **เลขที่เอกสาร Epicor** ได้ (เว้นว่างได้) → ขึ้น ✅ + เลขเอกสาร + วันที่/คนกด · กดผิดยกเลิกได้แต่ต้องระบุเหตุผล (ลง audit) · **ไฟล์ Export Excel ของหน้าเดียวกันมี 3 ช่องนี้ติดไปด้วย** (ไฟล์นั้นคือตัวที่เอาไปกระทบยอดจริง) · **⚠️⚠️ เป็นธงล้วน ๆ ไม่ใช่สถานะของ** (มติผู้ใช้ 2026-09-01) — ไม่แตะ `status` ไม่แตะ `issued_to_service_at` และ **ไม่บล็อกการเบิกให้ Service** เด็ดขาด เพราะถ้าบล็อก ของถึงหน้างานแล้วแต่ทีมช่างออกไม่ได้เพราะรอ Purchasing กดปุ่ม = งานหน้างานหยุดเพราะงานเอกสาร · ยังกดได้แม้บรรทัดนั้นเบิกให้ Service ไปแล้ว เพราะเอกสารมักตามหลังของจริง · มี DO block ตรวจว่า RPC ไม่ไปแตะ `issued_to_service_at` · **สิทธิ์** `epicor.issue` = `purchasing` + `admin` (คนที่ตัดใบเบิกใน Epicor จริงคือ Purchasing) · Project เห็นสถานะได้แต่กดไม่ได้ · **⚠️ RPC ใหม่ 2 ตัว ⇒ ต้องรัน SQL ก่อน push frontend** ไม่งั้นปุ่ม Done ได้ PGRST202 · ไม่มี trigger บน `job_accessory_requests` (ตรวจแล้ว — `trg_block_issued_edit` อยู่บน `lbs_units` เท่านั้น) จึง UPDATE ตรงได้ · demo sync: `types.ts` · `logic.ts` (`markEpicorIssued`/`undoEpicorIssued`) · `StoreContext` · `remote.ts` · `JobDetailPage` + 7 เคสใน `logic.test.ts` |

| `0065_epicor_txn_type.sql` | **ฟีเจอร์ (2026-09-02)**: **เลือกประเภท transaction ตอนกด Done ที่คอลัมน์ ทำเบิก-Epicor** — 0064 เก็บแค่ "ทำแล้ว + เลขเอกสาร" แต่ Epicor ตัดยอดได้ 2 ทางที่ไป**คนละฝั่งบัญชี** ⇒ รู้ว่าทำแล้วยังไม่พอ: `cust_ship` **Cust-Ship** = ของที่ส่งลูกค้าแล้วออก Invoice (ฝั่งรายได้) · `issue_mis` **Issue-Mis** = ของที่เบิกออกไปใช้ ไม่ออก Invoice (ฝั่งต้นทุน) · **บังคับเลือก ไม่ preselect** (มติผู้ใช้ 2026-09-02) เพื่อกันกดรวด ๆ แล้วได้ค่าแรกติดไปทั้งแผงโดยไม่ตั้งใจ — ปล่อยว่างได้เมื่อไหร่จะมีแถวที่ระบุไม่ครบค้างแล้วคนกระทบยอดต้องมาไล่ถามทีหลัง · คอลัมน์แสดง badge ประเภท (Cust-Ship ฟ้า / Issue-Mis เหลือง) · ไฟล์ Export Excel เพิ่มช่อง "ประเภท Epicor" · **⚠️ แถวที่กด Done ไว้ตั้งแต่ 0064 → `epicor_txn_type = NULL` ไม่ backfill** (เดาแทนคนทำไม่ได้ว่าตัดฝั่งไหน) หน้าจอขึ้น "ไม่ระบุประเภท" ให้เห็นชัด · แก้ได้โดยกดยกเลิกแล้ว Done ใหม่ · **⚠️⚠️ เปลี่ยน signature `rpc_mark_epicor_issued` (UUID,TEXT) → (UUID,TEXT,TEXT) ⇒ DROP ตัวเก่าก่อน** ไม่งั้น 2 overload = PGRST203 (§9 ข้อ 8) **และต้องรัน SQL ก่อน push** ไม่งั้นปุ่ม Done ยิงหา signature ใหม่ที่ยังไม่มี = PGRST202 · `rpc_undo_epicor_issued` signature เดิม แต่เพิ่มการล้าง `epicor_txn_type` (ไม่งั้นกด Done ใหม่แล้วประเภทเก่าค้าง — DO block ตรวจข้อนี้) · **ป้าย Cust-Ship/Issue-Mis มีแหล่งเดียวคือ `EPICOR_TXN_LABEL` ใน `logic.ts`** · `format.ts` อ้างต่อ (บทเรียนจาก 0062 ที่ป้ายถูกก็อป 4 ที่แล้วเพี้ยนกัน) · **+ เพิ่ม field type `select` ให้ `usePrompt`** ใน `components.tsx` (ของกลาง ใช้ซ้ำได้) |

| `0066_line_quota_allowlist.sql` | **โควตา LINE (2026-09-02)**: **allowlist — เหลือ 9 ชนิดที่ยิงเข้า LINE** · LINE Messaging API ของบัญชีนี้มีโควตา push แค่ **300 ข้อความ/เดือน** แต่ระบบยิงอยู่ 24 ชนิด และหลายตัวยิง**ต่อบรรทัด/ต่อเครื่อง** ไม่ใช่ต่อเหตุการณ์ — `accessory_issued` ยิงต่อบรรทัดวัสดุ (Job มีวัสดุ 10 รายการ = 10 ข้อความ) · `po_received` ยิงทุกครั้งที่กดรับของ · `unit_install_blocked` ยิงต่อเครื่อง · **การ์ดอนุมัติ 1:1 คิดรายคน** (ผู้อนุมัติ 2 คน = 3 ข้อความต่อการขอ 1 ครั้ง) ⇒ 1 Job กิน ~20 ข้อความ · ที่ 15 Job/เดือน = เต็มโควตาพอดี · **เกณฑ์ตัด: "ถ้าไม่รู้ตอนนี้ มีใครทำงานต่อไม่ได้ไหม"** ถ้าไม่มีใครถูกบล็อกให้ไปดูในเว็บหรือถามบอท (**reply ของบอทไม่กินโควตา** — เป็นเลเวอเรจฟรีที่ควรใช้) · เก็บไว้ 9: `pr_created` `pr_rejected` `approval_requested` `approval_rejected` `po_received` (เฉพาะรับครบ) `lbs_issued_to_service` `accessory_issued_to_service` `install_failed` `job_cancelled` · **⚠️⚠️ ชนิดที่ตัดออกยังถูกบันทึกลง `notifications` ครบเหมือนเดิม** (ขึ้นหน้า Notifications + Audit ตามปกติ) เปลี่ยนแค่ `line_status` เป็น `off` ตั้งแต่ตอน insert — **ห้ามแก้เป็น "ไม่ insert เลย" เด็ดขาด** ไม่งั้นหน้า Notifications กับการไล่ประวัติจะโหว่โดยไม่มีใครรู้ · **แก้ที่ `app_notify` ที่เดียว** RPC 20 กว่าตัวที่เรียกมันไม่ต้องแตะ · แยก type `po_received_partial` ออกจาก `po_received` (รับบางส่วนยังเบิกไม่ได้อยู่ดี ไม่ต้องรบกวนกลุ่ม) · patch ข้อความ 3 ใบให้กระชับ: ขออนุมัติตัด "· โดย {ชื่อ}" (การ์ด 1:1 มีชื่ออยู่แล้ว) · รับของครบเป็น "ของครบ — เบิกให้ Service ได้แล้ว" (เดิมไม่บอกว่าทำอะไรต่อ) · ยกเลิก Job ตัดท้าย "คืน LBS n + Accessory เข้าคลัง" · **มี UPDATE เคลียร์คิวเก่าที่ค้าง** ไม่งั้นเปิดเว็บครั้งถัดไปคิวเก่าจะถูกส่งกินโควตาทั้งก้อน · หลังตัด ~10 ข้อความ/Job ⇒ ~150/เดือน เหลือเผื่อ ~150 · **รายการต้องตรงกับ `LINE_PUSH_TYPES` ใน `logic.ts` เสมอ** (คนละ runtime กติกาเดียวกัน) + 3 เคสใน `logic.test.ts` |

| `0067_partial_qty_issue.sql` | **ฟีเจอร์ (2026-09-11)**: **เบิกให้ Service ทีละจำนวน + ของเหลือค้างที่ Job แล้วโอนคืนคลังได้** · 0059 ทำให้เบิกแยก "รายบรรทัด" ได้ แต่ยัง all-or-nothing ใน 1 บรรทัด ⇒ วัสดุ 100 ชิ้นที่หน้างานเอาไปแค่ 20 ต้องกดเบิกทั้ง 100 ตัวเลข "เบิกแล้ว" จึงเชื่อไม่ได้ และของ 80 ชิ้นไม่มีที่ยืน (โอนคืนคลังให้ Job อื่นใช้ไม่ได้เพราะบรรทัดปิดแล้ว) · **โมเดลใหม่ = บัญชี 3 ช่องต่อบรรทัด ผลรวม = `qty_requested` เสมอ**: `qty_transferred` (โอนคืนคลัง — ตัดต้นทุนออกจาก Job) · **`qty_issued_to_service`** (คอลัมน์ใหม่ · เบิกออกหน้างานแล้ว — **ต้นทุนยังอยู่กับ Job**) · ที่เหลือ = ค้างอยู่ที่ Job · มี CHECK `jar_qty_split_ck` (NOT VALID) กันรวมเกิน/ติดลบระดับ DB · **🔴 มติผู้ใช้ 2 ข้อ**: (1) **บรรทัด "จบ" เมื่อทุกชิ้นมีที่ไปครบ** ⇒ เบิก 20/100 แล้ว Job **ยังไม่ปิด** เป็น issued จนกว่า 80 ที่เหลือจะถูกเบิกหรือโอนคืน (ทำโดยแก้ `app_job_pending_issue_acc` ให้นับจากจำนวนคงค้าง — **ไม่ต้องแตะ `app_finalize_issue` เลย** เพราะมันเรียกฟังก์ชันนี้อยู่แล้ว) (2) **โอนคืนคลังได้จนถึงหลังติดตั้งเสร็จ** (ปิดเฉพาะ cancelled) เพราะของเหลือมักรู้ตอนช่างกลับจากหน้างาน ⇒ การโอนรับเคส "ช่างส่งของที่เบิกไปแล้วคืนกลับคลัง": ส่วนที่เกินของที่ค้างอยู่ที่ Job **หัก `qty_issued_to_service` ลง** + เขียนกำกับใน audit (`[รวมของที่เบิกออกหน้างานแล้ว n — ส่งคืนกลับคลัง]`) ไม่งั้นยอดลดลงเงียบ ๆ · **⚠️⚠️ เลิกใช้ `issued_to_service_at` เป็นธง "เบิกครบแล้ว"** — ตั้งแต่ไฟล์นี้ธงขึ้นตั้งแต่เบิกรอบแรก ความหมายใหม่ = "รอบล่าสุดที่เบิก" ⇒ ต้องแก้ทุกที่ที่เคยเช็คธง: `app_acc_issue_block` · `app_job_pending_issue_acc` · `app_assert_no_issued_out` (ไม่งั้น Job ที่คืนของครบแล้วยกเลิกไม่ได้ตลอดไป) · `v_job_status.accout` (ไม่งั้นค้างโชว์ `partially_issued` ทั้งที่ไม่มีของอยู่ข้างนอก) · **⚠️⚠️ เปลี่ยน signature 2 ตัว ⇒ DROP ก่อน** (§9 ข้อ 8): `rpc_issue_job_accessory` + `app_exec_issue_accessory` เพิ่ม `p_qtys NUMERIC[]` (เรียงตำแหน่งตรงกับ `p_request_ids` · NULL = เบิกที่ค้างทั้งหมด) **ต้องรัน SQL ก่อน push frontend** ไม่งั้นกดยืนยันการเบิกได้ PGRST202 · **มี PREFLIGHT ตรวจว่า body ใน DB เป็นของ 0063 จริงก่อนทับ** + DO block ตรวจ 8 ข้อท้ายไฟล์ · ⚠️ **audit ของ `app_exec_issue_accessory` ยังต้องไม่มี Location** (§9 บทเรียนที่ 2 — ฟังก์ชันนี้เก็บเลข PO + รายการของแทน เคยเช็คผิดด้านนี้แล้ว migration ล้มบน LIVE) · demo sync `types.ts` · `logic.ts` (`qtyPendingIssue`/`accSettled`/`issueJobAccessory`/`transferJobMaterialToStock`) · `remote.ts` · `format.ts` (ป้าย "เบิกบางส่วน n · ค้าง m") + **11 เคสใน `logic.test.ts` (ผ่าน mutation check แล้ว)** |

| `0068_write_off_job_material.sql` | **ฟีเจอร์ (2026-09-11)**: **✂️ ตัดจำหน่ายของเหลือที่ Job** · 0067 ทำให้บรรทัด "จบ" เมื่อทุกชิ้นมีที่ไปครบ ⇒ **ของเหลือเศษ ๆ ที่ไม่คุ้มจะโอนคืนคลัง (น็อต 3 ตัว · สายเหลือ 2 เมตร) ค้างขวางการปิด Job ไปตลอด** เพราะไม่มีใครอยากไปทำรายการโอน · เพิ่มช่องที่ 4 `qty_written_off` (+ `write_off_reason` บังคับกรอก · `written_off_at/by`) ⇒ บัญชีต่อบรรทัดเป็น **4 ช่อง** ผลรวมยังเท่ากับ `qty_requested` เสมอ · `jar_qty_split_ck` ของ 0067 ต้อง DROP แล้วสร้างใหม่ให้นับช่องที่ 4 · **🔴 2 ข้อที่ต่างจากการโอนคืนคลัง ห้ามทำสลับกัน**: (1) **ต้นทุนยังอยู่กับ Job** — ห้ามไปบวก `qty_transferred` เด็ดขาด ไม่งั้นงบงานลดลงทั้งที่ไม่มีของกลับมา (ของสูญไปกับงานนี้จริง ไม่ใช่คืนของ) (2) **ไม่ลง `stock_movements`** — ของไม่เคยอยู่ในคลังกลาง (ถูกตัดออกตอนเบิกเข้า Job หรือซื้อตรงผ่าน PO) ถ้าลงแถวบัญชีเดินสะพัด **รายงานผู้บริหาร Material Database ที่ sum `qty` เป็น "ปริมาณเข้า/ออกคลัง" จะนับซ้ำ** และ `balance_after` อ่านไม่ตรงยอดจริง ⇒ หลักฐานอยู่ที่ **Audit Log + 4 ฟิลด์บนบรรทัด** · หน้าเว็บโชว์เป็น**ตารางแยก**ในป๊อปอัปประวัติการเคลื่อนไหว (อ่านจาก `accessoryRequests` ไม่ใช่ ledger) กำกับว่า "ไม่กระทบยอดคลังด้านบน" · กติกาเดียวกับ `rpc_set_stock_lot` ที่ตั้งใจไม่ลง ledger เพราะของไม่ได้เคลื่อนไหว · **ตัดได้เฉพาะของที่ยังค้างอยู่ที่ Job** (ของที่ออกหน้างานแล้วถือว่าใช้ไปกับงานแล้ว) · เพดานการโอนคืนคลังต้องหัก `qty_written_off` ด้วย ไม่งั้นโอนเกินของที่มีจริงแล้วดัน `qty_issued_to_service` ติดลบ (ชน constraint) · **ไม่มี RPC ยกเลิกการตัดจำหน่าย** — แก้ผิดให้ Manage จัดการเป็นเคส · **ไม่เปลี่ยน signature ของเดิม เพิ่ม RPC ใหม่ 1 ตัว** แต่ **ต้องรันก่อน push** ไม่งั้นปุ่ม ✂️ โผล่แล้วกดได้ PGRST202 · **🔴 + แก้บั๊กที่ 0067 ทิ้งไว้**: ตั้งแต่ 0067 บรรทัดจบได้ด้วยการ**โอนคืนคลัง/ตัดจำหน่าย** ไม่ใช่แค่การเบิก แต่ `rpc_transfer_job_material_to_stock` (เขียนไว้ตั้งแต่ 0038) **ไม่เคยเรียก `app_finalize_issue`** ⇒ ถ้าการโอนคืนเป็นชิ้นสุดท้าย Job ค้าง `partially_issued` จนกว่าจะมี action เบิกอื่นมากระตุ้น — เติมให้ทั้ง 2 RPC แล้ว (มี DO block ตรวจ) · demo sync `types.ts` · `logic.ts` (`writeOffJobMaterial`/`qtyWrittenOff`/`qtyPendingIssue`) · `remote.ts` · `StoreContext` · `format.ts` + **5 เคสใน `logic.test.ts` (ผ่าน mutation check)** |

| `0069_public_share_link.sql` | **ฟีเจอร์ (2026-09-14)**: **ลิงก์สาธารณะให้ผู้บริหารดูคลัง LBS โดยไม่ต้อง login** · 🔴 **ครั้งแรกที่ระบบเปิดข้อมูลออกนอกรั้ว `authenticated`** — ทุกตารางตั้งแต่ 0001 เป็น `TO authenticated` และ role `anon` ไม่เคยมีสิทธิ์อ่านอะไรเลย · **ไฟล์นี้ไม่แตะ RLS ของตารางใดเลย** เปิดทางเดียวคือ RPC ตัวเดียว (`rpc_public_lbs_stock`, SECURITY DEFINER) ที่ GRANT ให้ `anon` ⇒ ขอบเขตข้อมูลถูกล็อกด้วย SQL ในตัวฟังก์ชัน ไม่ใช่ policy กว้าง ๆ · **🔴 มติผู้ใช้ 2 ข้อ**: (1) เปิดเฉพาะ **รายเครื่อง ไม่มีตัวเลขเงิน** — ตัด `unit_cost` · มูลค่าคลังรวม · และตัด **`contact_phone`** (PDPA) ด้วย (2) **ไม่มีวันหมดอายุ** ใช้ได้จนกว่าจะกดเพิกถอน · ตาราง `public_share_links` เก็บเฉพาะ **sha256 ของ token** (+`token_hint` 6 ตัวท้ายไว้ระบุแถว) ⇒ **DB หลุดก็เอาไปเปิดลิงก์ไม่ได้** · token สุ่มฝั่ง server จาก UUIDv4 สองใบ (~244 bit, ไม่ต้องพึ่ง pgcrypto) **คืนตัวเต็มครั้งเดียวตอนสร้าง** ลืมแล้วต้องเพิกถอนแล้วออกใหม่ · นับ `view_count`/`last_viewed_at` ให้ Division เห็นว่าลิงก์ถูกใช้แค่ไหน · สิทธิ์สร้าง/เพิกถอน = `stock.manage` (Division + Manage) · **⚠️⚠️ ห้ามใช้ `SELECT *` หรือ `to_jsonb(แถวเต็ม)` ใน `rpc_public_lbs_stock` เด็ดขาด** — เพิ่มคอลัมน์ใหม่บน `lbs_units`/`jobs` วันหลังจะหลุดออกลิงก์สาธารณะทันทีโดยไม่มีใครรู้ · มี DO block ตรวจ 6 ข้อ: ไม่มี policy ใดให้สิทธิ์ `anon` · `anon` อ่าน `public_share_links`/`lbs_units` ตรง ๆ ไม่ได้ · `anon` เรียก RPC อ่านได้แต่เรียกตัวสร้าง/เพิกถอนไม่ได้ · body ต้องไม่มี `unit_cost`/`contact_phone`/`budget_` และต้องไม่มี `SELECT *`/`to_jsonb` · **ไม่เปลี่ยน signature ของเดิม เพิ่มตาราง+RPC ใหม่ 3 ตัว แต่ต้องรันก่อน push** ไม่งั้นแผงสร้างลิงก์กดแล้วได้ PGRST202 · demo sync `types.ts` (`PublicShareLink`/`PublicStockView`) · `logic.ts` (`createShareLink`/`revokeShareLink`/`publicStockView`/`touchShareLink`) · `remote.ts` · `StoreContext` · หน้าใหม่ `PublicStockPage.tsx` + **6 เคสใน `logic.test.ts` (ผ่าน mutation check — ใส่ `unitCost`/`contactPhone` กลับเข้า payload แล้วต้องแดง)** |

| `0070_adjust_po_line.sql` | **ฟีเจอร์ (2026-09-15)**: **✏️ แก้จำนวนสั่งใน PO / ตัด item ที่สั่งเกินออก** · โจทย์จากหน้างาน: กรอกจำนวนตอนออก PR/PO ผิด (สั่ง 10 ทั้งที่ใช้จริง 8) หรือใส่ item เกินมาทั้งบรรทัด ⇒ ของจริงไม่มีวันมาครบ `qty_requested` ⇒ บรรทัดค้าง `po_ordered` → PO ค้าง `issued` → **Job เบิกให้ Service ไม่ได้ทั้งใบ** (`app_acc_issue_block` บังคับ PO ทั้งใบต้องเป็น `received`) และงบ actual ค้างที่จำนวนผิดด้วย · ของเดิมมีทางออกทางเดียวคือ `rpc_cancel_po` ที่บล็อกไว้ถ้ารับของแล้วแม้แต่หน่วยเดียว ⇒ เคส "รับมา 8 จาก 10 แล้วรู้ว่าสั่งเกิน" **ตันสนิท** · **กติกา = ลดได้อย่างเดียว และลดต่ำกว่าของที่รับมาแล้วไม่ได้**: `p_qty < qty_requested` เสมอ (อยากเพิ่มให้ออก PR/PO ใบใหม่ตาม 0037 — ไม่งั้นเลขในระบบต่างจากใบ PO จริงที่ส่งซัพไปแล้ว) · `p_qty >= qty_received` (ของอยู่ในมือจริง) · `p_qty = 0` → บรรทัด `cancelled` = เคส "ใส่ item เกิน" · `p_qty = qty_received` → บรรทัด `received` = "ปิดรับเท่าที่ได้" · ปิดบรรทัดสุดท้ายแล้ว PO/PR ปิดตามเองด้วยเงื่อนไขเดียวกับ `rpc_receive_po_items` · **🔴 ยกเว้นข้อเดียว: PO ที่ทุกบรรทัดถูกตัดทิ้งและไม่เคยรับของเลย ปิดเป็น `cancelled` ไม่ใช่ `received`** (ไม่มีของเข้าจริงสักชิ้น ปิดเป็น "รับของครบ" จะโกหกทั้งรายงานและ Audit) · **ต้อง DROP CHECK `qty_requested > 0` ของ 0001** แล้วสร้างใหม่เป็น `jar_qty_requested_ck` (`qty_requested > 0 OR status = 'cancelled'`) ไม่งั้นการตัด item เกินชน constraint — ไม่ผ่อนเป็น `>= 0` ลอย ๆ เพราะบรรทัดที่ยังมีชีวิตห้ามมีจำนวน 0 · **ไม่แตะ `qty_received` / คลัง / `stock_movements`** (ลดแค่ "จำนวนที่สั่ง" ไม่ได้ลด "จำนวนที่รับ") · ต้นทุนถูกเองเพราะ `poCostSummary`/งบ actual คิดจาก `qty_requested` อยู่แล้ว · เรียก `app_finalize_issue` ท้ายสุดตามกติกา §9 (ตัดบรรทัดที่ค้างทิ้ง = ใบงานอาจครบพอดี) · สิทธิ์ `purchasing` (+admin) กดเองได้ (มติ 2026-09-15) บังคับกรอกเหตุผล → Audit + แจ้ง Project · notify type `po_line_adjusted` **ไม่อยู่ใน LINE allowlist ของ 0066** (งานแก้เอกสารประจำวัน ไม่ต้องปลุกกลุ่ม) · **ไม่เปลี่ยน signature ของเดิม เพิ่ม RPC ใหม่ 1 ตัว ⇒ รันก่อนหรือหลัง push ก็ได้** (ปุ่ม ✏️ แก้จำนวน จะได้ PGRST202 จนกว่าจะรัน SQL) · มี DO block ตรวจ 7 ข้อ · demo sync `logic.ts` (`adjustPoLine`) · `remote.ts` · `StoreContext` · `PurchasingPage.tsx` (ปุ่มในโมดัลรับของ + ป้าย "ตัดออกจาก PO" ในตาราง PO) + **11 เคสใน `logic.test.ts`** · **UI**: โมดัลรับของขยายเป็น `size="xl"` (1180px · หัว/ปุ่มค้าง ตารางเลื่อนเอง) และเปลี่ยนจาก field เรียงซ้อนเป็นตาราง สั่ง/รับแล้ว/ค้างรับ ในบรรทัดเดียว |

| `0071_field_work_per_unit.sql` | **ฟีเจอร์ (2026-09-16)**: **🔧 ด่านงานหน้าไซต์เป็น "รายเครื่อง" ไม่ใช่ "รายใบ"** · 0059 แยกการเบิกเป็นรายชิ้นแล้ว แต่**ทุกด่านปลายน้ำยังล็อกที่ `terminal_status = 'issued'`** ⇒ Project ส่ง LBS 2 จาก 5 เครื่องให้ช่างได้ แต่ช่าง **ยืนยันติดตั้งไม่ได้ · มอบหมายทีมไม่ได้ · บันทึกออกหน้างานไม่ได้** และงาน**หายไปจากหน้า Service ทั้งใบ** (หลุดจาก "รอ Project เบิกให้" เพราะไม่ใช่ `ready_to_issue` แล้ว · ยังไม่เข้า "เบิกแล้ว" เพราะ `finalizeIssue` ตั้ง terminal ให้ต่อเมื่อครบทั้งใบ) — ย้อนแย้งกับโจทย์ตั้งต้นของ 0059 เอง · **รากของปัญหา: `terminal_status = 'issued'` ถูกใช้ 2 ความหมายพร้อมกัน** (1) "ใบงานจบการเบิกแล้ว" เชิงบัญชี/ล็อก (2) "ของถึงมือ Service แล้ว เริ่มงานได้" เชิงปฏิบัติการ ⇒ ไฟล์นี้แยก (2) ออกมาเป็นด่านของตัวเอง วัดจาก**ของที่ออกจากคลังจริง**: ยืนยัน/บล็อกติดตั้งรายเครื่อง → เครื่องนั้นต้อง `lbs_units.status = 'issued'` (`app_assert_unit_issued_out`) · มอบหมายทีม · บันทึกออกหน้างาน · นับคิวงานของช่าง → Job ต้องมีเครื่องที่ issued ≥ 1 (`app_job_field_active`) · **🔴 ห้ามแตะ `rpc_close_job_install`** — ยังบังคับ `terminal_status = 'issued'` + ทุกเครื่องบนใบต้องได้ข้อสรุป ⇒ **ปิดงานทั้งที่ของยังออกไม่ครบ Scope ยังทำไม่ได้** (ไฟล์นี้ปลดแค่ "ทำงานหน้างานได้" ไม่ได้ปลด "ปิดงานได้") · มี DO block เฝ้าไว้ ถ้าใครปลดด่านนั้นจะ RAISE · **🔴 ด่านใหม่ต้องกัน `installed`/`cancelled` เอง** — ด่านเดิมเช็ค "= issued" ตัวเดียวจึงกันให้ฟรีโดยบังเอิญ ไม่เขียนกันจะแก้ผลติดตั้งย้อนหลังบนงานที่ปิดแล้วได้ (มี DO block ตรวจ) · **ใช้ `app_swap_guard` (0037) แทนการพิมพ์ body ใหม่** เพราะ 5 RPC นี้ถูกแก้มาหลายรอบ (0034/0035/0036/0040) พิมพ์ใหม่เสี่ยงย้อนของเก่าทับ — swap เป็น idempotent · RPC ที่ย้ายด่าน: `rpc_confirm_unit_install` (ทั้ง 2 overload) · `rpc_block_unit_install` · `rpc_log_site_visit` · `rpc_assign_job_team` · **`rpc_update_team_member`** (งานที่เบิกบางส่วนก็เป็น "งานรอติดตั้ง" ที่ต้องย้ายมอบหมายก่อนปิดช่าง ไม่แก้ = คิวงานหายเงียบ) · DROP `app_assert_unit_on_issued_job` ทิ้ง (ชื่อโกหกด่านที่ใช้จริง) · **ไม่เปลี่ยน signature ใด ⇒ รันก่อนหรือหลัง push ก็ได้** · demo sync `logic.ts` (`jobHasIssuedUnits`/`jobIsFieldActive`/`assertUnitIssuedOut`/`assertJobFieldActive`/`memberSchedule`) · `jobInstallSummary` เพิ่ม `outTotal/outInstalled/outBlocked/outPending/waiting` = ความคืบหน้า**เฉพาะของที่อยู่กับช่าง** แยกจากภาพรวมทั้งใบที่ยังคุมเงื่อนไขปิดงานเหมือนเดิม · `ServicePage.tsx` (พาเนล "เบิกแล้ว" รับงาน partially_issued + ป้าย "เบิกบางส่วน n/N · ค้างอีก m" · คอลัมน์ "ของที่เบิก" นับเฉพาะเครื่องที่ออกจากคลังจริง ไม่งั้นช่างออกไปหาของที่ไม่มี · โมดัลยืนยันรายเครื่องซ่อนเครื่องที่ยังอยู่คลัง · `เบิก` ใช้ `lbsIssuedAt` เมื่อใบยังไม่ปิด) · **วัสดุที่เบิกบางส่วน**: คอลัมน์ "ของที่เบิก" เคยโชว์ `qtyRequested` เต็มจำนวนเสมอ ⇒ ตั้งแต่ 0067 ที่เบิกทีละบางส่วนได้ ช่างจะอ่านว่าได้ของครบทั้งที่จริงได้มาแค่บางส่วน (คลาสเดียวกับ Serial LBS ที่เคยโชว์เกิน) ⇒ เพิ่ม `qtyOutToField()` ใน `logic.ts` = จำนวนที่ถึงมือช่างจริง **พร้อม fallback แถวก่อน 0067** (`issuedToServiceAt` มี แต่ไม่มีคอลัมน์จำนวน = เบิกครบทั้งบรรทัด) — ⚠️ กติกาตรงกับ backfill ของ 0067 เป๊ะ (`WHERE issued_to_service_at IS NOT NULL`) แก้ที่นี่ต้องเทียบไฟล์นั้นเสมอ ไม่งั้นเดโมกับ LIVE นับของหน้างานไม่เท่ากัน · หน้า Service แสดง `ชื่อ × จำนวนที่ส่งแล้ว (จาก y · ตามมาอีก z)` และแยกบรรทัด "ยังไม่ได้ส่งอีก n รายการ (อยู่กับ Project)" สำหรับของที่รับมาแล้วแต่ยังไม่ส่งต่อ · `ServiceSchedulingPage.tsx` · **รอบตรวจบั๊กหลังทำเสร็จ เจอจุดที่ยังยึด "ใบครบ" อีก 5 จุด แก้ครบแล้ว**: (1) `qtyOutToField` ลืมกัน `cancelled/returned` ทั้งที่คอมเมนต์อ้างว่าตรงกับ backfill 0067 — backfill มี `AND status NOT IN (...)` ด้วย (2)(3) หน้า Job ซ่อนแผง "เบิกให้ Service แล้ว" **และ** ตาราง "การติดตั้งรายเครื่อง" ทั้งคู่เมื่อ `terminalStatus !== issued` ⇒ ระหว่างเบิกบางส่วน Project ตามงานที่ตัวเองส่งออกไปไม่ได้เลย · ตารางรายเครื่องเพิ่มป้าย **"ยังไม่เบิก — อยู่คลัง"** แยกจาก "รอติดตั้ง" (คนละคนต้องไปทำ) (4) การ์ด Dashboard + badge ใน sidebar (`awaitingInstall`/`unassignedJobs`) นับแต่ใบที่ครบ ⇒ ตัวเลขขัดกับหน้า Service/Scheduling ที่นับไปแล้ว · เปลี่ยนเป็น `jobIsFieldActive` + นับเครื่องจาก `outTotal/outInstalled` (งานที่เบิกครบ `outTotal === total` จึงไม่เปลี่ยนตัวเลขเดิม) (5) ข้อความบนแผง 0059 เขียนว่า **"Service ยืนยันติดตั้งได้เมื่อเบิกครบทั้งใบ"** ซึ่งกลายเป็นคำอธิบายที่โกหกทันทีที่ด่านย้าย — แก้คู่กันเสมอ · แผงใหม่ตัดส่วนที่ซ้ำกับแผง 0059 (เบิกเมื่อ/นัดติดตั้ง) เหลือเฉพาะความคืบหน้าติดตั้ง + ทีมช่าง + **13 เคสใน `logic.test.ts`** (รวมเคสล็อกว่าปิดงานยังต้องเบิกครบ) · ⚠️ `confirmInstall` (ยืนยันทั้งใบ ก่อน 0035) ยังใช้ด่านเดิม — ไม่มีหน้าไหนเรียกแล้ว จงใจไม่แตะ |

| `0072_announce_silent_close.sql` | **ฟีเจอร์ (2026-09-16)**: **🔔 ใบที่ปิดเงียบต้องประกาศให้ Service รู้** · 0063 (มติ 2026-08-28) ย้ายการประกาศ "เบิกครบทั้งใบแล้ว" ออกจาก `app_finalize_issue` ไปเป็น**หางต่อท้ายข้อความของ action ที่ทำให้ครบ** เพื่อกันกลุ่ม LINE ได้ 2 ใบติดกันเรื่องเดียวกัน — ใช้ได้ดีตราบใดที่ตัวปิดใบมีแต่ `app_exec_issue_lbs`/`app_exec_issue_accessory` · **แต่ตั้งแต่ 0067/0068/0070 มี action ที่ปิดใบได้ทั้งที่ไม่ได้ "เบิก" อะไรเลย**: 📦 `rpc_transfer_job_material_to_stock` (ยิง `stock_transfer_in` หา **project**) · ✂️ `rpc_write_off_job_material` (**ไม่ยิงอะไรเลย** มีแต่ Audit) · ✏️ `rpc_adjust_po_line` (ยิง `po_line_adjusted` หา **project**) ⇒ **ใบพลิกเป็น Issued เงียบ ๆ** ทั้งที่นาทีนั้นคือนาทีที่งานโผล่เข้าคิวหน้า Service ครั้งแรก (ยิ่งชัดหลัง 0071) ไม่มีอะไรบอกทีมช่างว่าออกไซต์ได้แล้ว · **วิธีแก้: ไม่แตะ `app_finalize_issue`** (มีผู้เรียก 5 ที่ และ 2 ที่ต้องเงียบต่อไป) เพิ่ม wrapper **`app_finalize_issue_loud`** ที่ตรวจ "ใบเพิ่งพลิกเป็น issued ไหม" จาก**สถานะก่อน/หลัง** (ไม่เขียนเงื่อนไขปิดใบซ้ำ ไม่งั้นหลุดกันทันทีที่กติกาเปลี่ยน) แล้ว `app_swap_guard` เฉพาะ 3 RPC ข้างบน — บรรทัดเดียวต่อฟังก์ชัน idempotent · **🔴 ห้าม swap `app_exec_issue_*`** เพราะเติมหาง `· ครบทั้งใบแล้ว` เองอยู่แล้ว ถ้า swap ด้วยจะกลับไปเป็น 2 ใบซ้ำ = บั๊กที่ 0063 แก้ไป (มี DO block เฝ้า) · type ใหม่ `job_ready_to_install` เข้า allowlist LINE ของ 0066 (ปีละไม่กี่ใบ ไม่กินโควตา · ตรงเกณฑ์ "บล็อกงานคนอื่นอยู่" เหมือน `lbs_issued_to_service`) — ต้อง recreate `app_notify` ⇒ DO block ตรวจว่า 9 ชนิดเดิมยังครบ กันพิมพ์ใหม่แล้วตกหล่น · **🔴 `REVOKE ALL ... FROM PUBLIC, authenticated, anon` บน wrapper** — Postgres ให้ EXECUTE กับ PUBLIC เป็น default ของฟังก์ชันใหม่ ถ้าไม่ถอน ใครที่ login อยู่ยิงตรงพร้อมแถว `profiles` ของใครก็ได้แล้ว**บังคับปิดใบข้าม RLS** (กติกาเดียวกับ `app_line_bind` ใน 0033) · DO block ตรวจด้วย `has_function_privilege` · **ไม่เปลี่ยน signature ของเดิม ⇒ รันก่อนหรือหลัง push ก็ได้** · demo sync `logic.ts` (`finalizeIssue(.., announce)` + `LINE_PUSH_TYPES`) + **5 เคสใน `logic.test.ts`** รวม 2 เคสลบที่สำคัญที่สุด: ปิดใบไม่ได้ต้องไม่ยิง · การเบิกต้องไม่ยิงตัวนี้ |

| `0073_unit_contract_no.sql` | **ฟีเจอร์ (2026-09-16)**: **📄 Contract No. รายเครื่อง + "แผน" เลิกเป็นแผนเมื่อมีสัญญา** · 0014 ตัดคอลัมน์ลูกค้าออกจาก `lbs_units` ทิ้งไปรอบหนึ่งแล้ว ให้ Job เป็น source of truth เดียว · 0043 คืนมาเป็น "ข้อมูลแผน" ⇒ มี 2 สถานะ (ยังไม่ผูก Job = แผน · ผูกแล้ว = ค่าจาก Job) · ไฟล์นี้แทรก**สถานะกลาง**: พอมีเลขสัญญาแล้วข้อมูลลูกค้าไม่ใช่การเดาอีกต่อไป ⇒ **ลำดับความจริง 3 ชั้น `job > contract > plan`** รวมไว้ที่ helper เดียว `unitCustomerInfo()` ทุกหน้าเรียกใช้ร่วมกัน · **🔴 มติผู้ใช้ 2026-09-16: ถูกดึงเข้า Job แล้ว Contract No. เป็นข้อมูล Ref.** — Job ยังชนะเรื่อง customer/contact/location ตาม 0014 ไม่แย่งกัน · ถ้า 2 ฝั่งไม่ตรงหน้าเว็บขึ้นธง `⚠️ ต่างจากสัญญา: …` ให้คนไปตรวจ (ไม่บล็อก ไม่กลืนเงียบ — มักแปลว่าดึงเครื่องผิดใบหรือกรอกสัญญาผิด) · **🔴 `contract_no` เขียนได้ทุกเครื่องรวมที่ผูก Job แล้ว** ต่างจาก customer/location ที่ถูกข้ามเมื่อมี Job (กฎ 0014) เพราะเลขสัญญาเป็นข้อเท็จจริงฝั่งขาย**คนละชั้นกับ Job** (Job ไม่ได้เป็นเจ้าของ จึงไม่มีอะไรให้ทับ) — DO block ตรวจว่าไม่มี `contract_no = CASE WHEN job_id` โผล่ในตัว import · **CHECK `lbs_units_contract_needs_info_ck`**: มีเลขสัญญาต้องมี Customer + Location ครบ **ยกเว้นเครื่องที่ผูก Job แล้ว** (ไม่ยกเว้นจะกรอกเลขสัญญาให้เครื่องที่มี Job ไม่ได้เลย ซึ่งเป็นเคสที่เจอบ่อยสุด) · เบอร์ติดต่อไม่บังคับ (ตอนเซ็นสัญญามักยังไม่รู้ว่าใครประสานงานหน้างาน) · กติกาเดียวกันซ้ำที่ RPC + `logic.ts` เพื่อให้ error อ่านรู้เรื่องและบอกว่าเครื่องไหน แทนที่จะเด้ง CHECK ดิบ ๆ · **⚠️ เปลี่ยน signature `rpc_update_unit_plan` ⇒ DROP ก่อน** (§9 ข้อ 8 — PostgREST กำกวมถ้ามี 2 overload) และ **ต้องรัน SQL ก่อน push** ไม่งั้นกดบันทึกได้ PGRST202 · patch `rpc_import_units_to_stock` ด้วย anchor บรรทัดเดียวแบบ 0053 — **🔴 ขา UPDATE กับขา INSERT ต้องใช้คนละ anchor** (`a_upd` มี `=` · `a_cols` เป็นรายชื่อคอลัมน์ล้วน) ถ้าใช้ตัวเดียวกัน `replace()` จะยัด `contract_no = COALESCE(...)` ลงในรายชื่อคอลัมน์ของ INSERT → syntax error ตอน EXECUTE · **🔴 ค่าในขา INSERT ต้องอ่านจาก `u` ตรง ๆ ห้ามใช้ `v_contract`** เพราะตัวแปรถูกเซ็ตในลูป UPDATE เท่านั้น ลูป INSERT จะได้ค่าค้างจากรอบก่อนติดไปกับเครื่องใหม่ · **🔴 ห้ามใส่ `contract_no` ลง `rpc_public_lbs_stock`** (0069) — DO block ตรวจให้แล้ว · demo sync `types.ts` · `logic.ts` (`unitCustomerInfo`/`assertContractInfo`/`updateUnitPlan`/`importUnitsToStock`) · `remote.ts` · `StocksPage.tsx` (คอลัมน์ใหม่ · ช่องในฟอร์ม · ป้าย "(แผน)" หาย/โผล่ตามที่พิมพ์แบบ live · คอลัมน์ Excel + import preview) + **8 เคสใน `logic.test.ts`** |

| `0074_unit_files.sql` | **ฟีเจอร์ (2026-09-17)**: **📎 เอกสารแนบรายเครื่อง** (สัญญา · ใบส่งของ · รูปสภาพเครื่องตอนส่งมอบ) หลายไฟล์ต่อเครื่อง · ตาราง `lbs_unit_files` (unit_id → ON DELETE CASCADE · file_name/file_path/mime_type/size_bytes/note/uploaded_by/at) · **🔴 bucket `unit-docs` ต้องเป็น private** ต่างจาก `install-photos` (0019) ที่ตั้ง `public = true` — เอกสารสัญญาเป็นข้อมูลเชิงพาณิชย์ + PDPA และ URL ของ Supabase เดาได้จาก path ⇒ public bucket = เปิดสาธารณะจริง ๆ · **DB เก็บ `file_path` ไม่ใช่ URL** ฝั่ง client ขอ signed URL อายุ 5 นาทีทุกครั้งที่จะเปิด (`signedUnitDocUrl`) · **🔴 policy `unit_docs_read` ต้องเป็น `TO authenticated` ห้าม `TO public`** แบบ `install_photos_read` ไม่งั้น bucket ที่ตั้ง private ก็ทะลุผ่าน policy อยู่ดี — DO block ตรวจทั้ง `storage.buckets.public = false` และว่าไม่มี public/anon ใน policy roles · **กติกาชนิด/ขนาดไฟล์อยู่ 3 ชั้น** เพราะแต่ละชั้นกันคนละทาง: `<input accept>` (แค่ตัวกรองหน้าต่างเลือกไฟล์ ลากไฟล์ใส่ก็ผ่าน) → RPC + `logic.ts` (กติกาตัวจริง) → CHECK ใน DB (กันคนยิง SQL ตรง) · รับเฉพาะ **PDF + รูปภาพ ≤ 10 MB** · **⚠️ ไม่บล็อกเครื่องที่เบิกให้ Service แล้ว** ต่างจาก `rpc_update_unit_plan` — ใบส่งของ/รูปสภาพเครื่องมาถึงหลังของออกจากคลังเสมอ ล็อกไว้ = แนบหลักฐานไม่ได้เลย · **⚠️ โหมด demo เก็บไฟล์เป็น data URL ใน localStorage ซึ่งมีโควตา ~5–10MB ทั้งแอป** PDF ใบเดียวก็กินหมดได้ ⇒ เพดานคนละค่า (`DEMO_MAX_UNIT_FILE_MB = 1` vs `MAX_UNIT_FILE_MB = 10`) และเขียนเหตุผลไว้ในโมดัลให้คนเทสต์ไม่เข้าใจผิดว่าระบบจริงก็จำกัดแค่นี้ · ลบ: ลบแถวผ่าน RPC ก่อน **แล้วค่อย** `removeUnitDoc` ไฟล์จริง — ลบไฟล์ไม่สำเร็จไม่ throw (เหลือไฟล์กำพร้าที่ไม่มีใครอ้างถึง ดีกว่าให้ผู้ใช้เห็น error ทั้งที่ลบสำเร็จไปครึ่งทาง) · `unitFiles()` เรียงใหม่สุดก่อนโดยมี **ลำดับ append เป็นตัวตัดสินที่ 2** — แนบหลายไฟล์รวดเดียวได้ `uploadedAt` เท่ากันระดับมิลลิวินาที ไม่มีตัวตัดสินแล้วลำดับสลับทุก re-render · แยกโมดัลจาก "แก้ข้อมูล" เพราะอัปโหลดเกิดผลทันทีทีละไฟล์ ส่วนฟอร์มแก้ข้อมูลบันทึกทีเดียว ปนกันแล้วผู้ใช้ไม่รู้ว่ากด "ยกเลิก" แล้วไฟล์ที่เพิ่งอัปหายด้วยไหม · สิทธิ์ `stock.manage` (Division + Manage) · **ไม่เปลี่ยน signature ของเดิม เพิ่มตาราง + RPC ใหม่ 2 ตัว แต่ต้องรันก่อน push** · demo sync `types.ts` (`LbsUnitFile` + `DB.lbsUnitFiles`) · `logic.ts` · `remote.ts` (`uploadUnitDoc`/`signedUnitDocUrl`/`removeUnitDoc`) · `StoreContext` · `StocksPage.tsx` (ปุ่ม 📎 พร้อมตัวนับ + โมดัล) + **7 เคสใน `logic.test.ts`** |
| `0075_job_due_extension.sql` | **ฟีเจอร์ (2026-09-17)**: **📅 ขยาย/แก้กำหนดส่ง (EOT) + สถานะกำหนดส่งแบบใหม่** · 🔴 **ต้นเรื่อง**: Dashboard ขึ้น "เลยกำหนด" (แดง) กับงานที่ช่าง**กำลังติดตั้งอยู่หน้างาน** เพราะทุกหน้าตัดสินด้วย `daysLeft < 0` อย่างเดียว ไม่เคยดูว่าของออกจากคลังไปแล้วหรือยัง ⇒ ใบที่เดินอยู่จริงกับใบที่ไม่มีใครแตะเป็นสีเดียวกัน **คนอ่านเลิกเชื่อสีแดง = ตัวเตือนตายทั้งระบบ** · **ตาราง `job_due_extensions` (ประวัติ · แถวล่าสุดชนะ เหมือน `unit_installations` 0035)** ไม่ใช่คอลัมน์ `revised_due_date` บน `jobs` — "เลื่อนกี่ครั้ง เพราะอะไร" คือหลักฐานตอนเคลมค่าปรับ/ต่อสัญญา ทับคอลัมน์เดียว = เลื่อนรอบ 2 ลบเหตุผลรอบ 1 ทิ้ง · 🔴 **`jobs.required_date` ไม่ถูกแก้เลย** = กำหนดตามสัญญาเดิม ทุกหน้าโชว์คู่กับกำหนดที่มีผลเสมอ · RPC `rpc_extend_job_due` (บังคับเหตุผล · ห้ามเลื่อนเป็นวันเดิม) + `rpc_delete_job_due_extension` (**ได้เฉพาะแถวล่าสุด** — ลบแถวกลางแล้ว `prev_due_date` ของแถวถัดไปชี้ไปค่าที่ไม่มีจริง) · helper `app_job_contract_due` / `app_job_effective_due` · guard = `app_assert_job_procurable` (0037) = เลื่อนได้ถึง issued ปิดเมื่อ installed/cancelled + ได้สิทธิ์เจ้าของงาน (0042) ฟรี · ⚠️ ชนิด `job_due_extended` **ไม่อยู่ใน allowlist 0066** ⇒ บันทึกลง notifications ครบ แต่ `line_status='off'` ไม่กินโควตา 300/เดือน (มี DO block ตรวจว่าไม่หลุดเข้า allowlist) · **demo sync** `logic.ts` (`jobDelivery` / `jobEffectiveDue` / `jobDueExtension(s)` / `extendJobDue` / `deleteJobDueExtension`) · `types.ts` (`JobDueExtension`) · `remote.ts` · `StoreContext` · UI: `DeliveryBadge` (components.tsx) ใช้ร่วมกัน **5 หน้า** (Dashboard · Jobs · Job Detail · Service · Scheduling) + พาเนล "📅 สถานะกำหนดส่ง" บนหน้า Job + `line-webhook.js` ตอบกำหนดที่มีผล · **13 เคสใน `logic.test.ts`** · **ไม่เปลี่ยน signature ของเดิม แต่ต้องรันก่อน push** (ปุ่มขยายกำหนดส่งจะได้ PGRST202) |
| `0076_payment_files.sql` | **ฟีเจอร์ (2026-09-17)**: **📎 เอกสารแนบรายงวดเงิน** (ใบแจ้งหนี้ · ใบเสร็จ/ใบกำกับภาษี · PAC · สำเนาโอนเงิน) แนบได้จากโมดัล "เพิ่ม/แก้งวด" โดยตรง · ตาราง `job_payment_files` + bucket **private** `payment-docs` (กติกาเดียวกับ `unit-docs` 0074: DB เก็บ **path** ไม่ใช่ URL · เปิดผ่าน signed URL 5 นาที · policy อ่านเป็น `authenticated` เท่านั้น) · 🔴 **แยก bucket จาก unit-docs โดยตั้งใจ** — เอกสารการเงินกับเอกสารรายเครื่องมีคนละกลุ่มผู้อ่านในอนาคต แยกตั้งแต่ต้น = แก้ policy ที่เดียวจบ รวมแล้วมาแยกทีหลังต้องย้ายไฟล์จริงทั้งหมด · guard = `app_assert_job_cost_editable` (เหมือน 0044 ทั้งชุด) ⇒ **แนบได้แม้ปิดงานติดตั้งแล้ว** เพราะ PAC/Retention มาหลังปิดงานเสมอ · 🔴 **`rpc_add_job_payment` เปลี่ยนเป็น `RETURNS UUID`** (DROP + recreate — เปลี่ยน return type ด้วย `CREATE OR REPLACE` ไม่ได้ · body คัดจาก 0044 ทั้งดุ้น ตรวจแล้วว่าไม่มี migration ไหน patch มันหลัง 0044 · **ต้อง GRANT ใหม่** เพราะ DROP ทิ้ง grant เดิม) เพราะโมดัลให้เลือกไฟล์ก่อนกดบันทึก ⇒ ตอนบันทึกต้องรู้ id ทันทีเพื่อผูกไฟล์ต่อ · ⚠️ ลบงวด → แถวไฟล์หายตาม `ON DELETE CASCADE` แต่ **ไฟล์จริงใน storage ไม่หายเอง** ⇒ UI เก็บ path ไว้ก่อนลบแล้วค่อยเก็บกวาด (กติกาเดียวกับ 0074) · **demo sync** `logic.ts` (`paymentFiles` / `paymentFileCount` / `addPaymentFile` / `deletePaymentFile` + `deleteJobPayment` ลบไฟล์ตาม) · `types.ts` (`JobPaymentFile`) · `remote.ts` (`addJobPaymentRemote` คืน id + helper storage ที่รับ bucket เป็นพารามิเตอร์) · `StoreContext` (override `act.addJobPayment` ทั้ง 2 โหมดให้คืน id เหมือน `createShareLink`) · **6 เคสใน `logic.test.ts`** · **ต้องรันก่อน push** |
| `0077_project_edit_budget_after_issue.sql` | **แก้กติกา (2026-09-18)**: **Project เจ้าของงานแก้งบประมาณได้แม้ใบล็อกแล้ว** — ยกเลิกข้อจำกัด "Manage เท่านั้น" ของ 0023 · 🔴 **ที่มา**: ผู้ใช้เปิดใบที่เบิกให้ Service แล้วด้วยบัญชี Project → **ปุ่ม "แก้ไขงบประมาณ" หายไปทั้งปุ่มโดยไม่บอกเหตุผล** · 🔴 **ทำไมกติกาเดิมพังจริง ไม่ใช่แค่ไม่สะดวก**: ต้นทุนจริงของงานนี้เกิด "หลังเบิก" เป็นส่วนใหญ่ (ค่าขนส่งเข้าไซต์ · ค่าแรงหน้างาน · ค่า PM ระหว่างติดตั้ง · ค่าธรรมเนียมช่วงท้ายงาน) — หมวด `raw_mat`/`outsourcing` มี PR/PO ตัดเข้าให้อัตโนมัติ (และ 0037 เปิดให้ซื้อเพิ่มหลังเบิกแล้ว) แต่อีก **5 หมวดกรอกมือ** (`trans`/`eng`/`ove`/`pm`/`fin`) พอล็อกไว้ที่ Manage คนที่รู้ตัวเลขจริงบันทึกไม่ได้ ⇒ **รายงานต้นทุนต่ำกว่าความจริงอย่างเป็นระบบ** · guard ใหม่ = `app_assert_job_cost_editable` (0037) ให้ครบ 3 อย่างในตัวเดียว: ล็อกแถว `FOR UPDATE` + กันใบที่ยกเลิก + เช็คเจ้าของงาน (0042) · 🔴 **ผลข้างเคียงที่ตั้งใจ: ใบที่ยกเลิกแล้วแก้งบไม่ได้อีกแม้แต่ Manage** (เดิมแก้ได้เพราะ 0023 ไม่เช็ค `terminal_status` เลย) — ตรงกับกติกาของ `rpc_add/update_job_payment` (0044) ว่าตัวเลขเงินของใบที่ยกเลิกต้องไม่ขยับ · ⚠️ **มติผู้ใช้ 2026-09-18 — แก้ได้ทั้งก้อน รวม "ราคาขาย"**: ผู้ใช้รับทราบแล้วว่ายอดงวดที่ออกใบไปแล้ว **freeze ไว้ ไม่ขยับตามราคาขายใหม่** (0044) · UI จึงเตือน 2 ชั้น: ป้าย "ราคาขายถูกแก้หลังออกใบวางบิล" ในตาราง Payment (ของเดิม) + **คำเตือนในโมดัลแก้งบตอนที่งานนั้นมีงวดคิดเป็น % อยู่** (ของใหม่) · audit บันทึกเพิ่มว่าแก้ย้อนหลังตอนใบล็อกแล้วหรือไม่ · ไม่เปลี่ยน signature (`CREATE OR REPLACE` ได้ — ตรวจแล้วว่าไม่มี migration ไหนหลัง 0023 patch ฟังก์ชันนี้ · 0031 ไม่แตะเพราะตัวนี้ไม่ยิง `app_notify`) · demo sync `logic.ts` (`updateJobBudget` เปลี่ยน guard) + `StoreContext` (`run('job.manage')` แทน `master.manage`) · **6 เคสใน `logic.test.ts`** · **ต้องรันก่อน push** |
| `0078_std_drawing_multi_files.sql` | **ฟีเจอร์ (2026-09-23)**: **📐 Standard Drawing แนบ PDF ได้หลายไฟล์** (ผู้ใช้ขอ — แบบ 1 ชุดมีหลายแผ่น) · คอลัมน์ `std_drawings.files JSONB` = `[{url, name, size}]` + backfill จาก `file_url`/`file_name` เดิม · 🔴 **ไม่แยกตารางลูกแบบ 0074/0076 โดยตั้งใจ** — ไฟล์ Drawing อยู่ใน bucket public `install-photos` (0045) เก็บ URL ตรง ไม่มีข้อมูลต่อไฟล์ และโมดัลบันทึกหัวข้อ+ไฟล์ทั้งชุดในคลิกเดียว ⇒ JSONB + RPC ตัวเดียว = atomic · RPC ใหม่ `rpc_save_std_drawing(p_id NULL=เพิ่ม, …, p_files, p_rev_note) RETURNS UUID` รับ **รายการไฟล์ทั้งชุดที่ต้องเหลือ** (เพิ่ม/เอาออกรายตัวในโมดัลเดียว · เพดาน 30 ไฟล์) · audit บันทึกไฟล์ที่เพิ่ม + ไฟล์ที่เอาออกพร้อม URL (ไม่ลบ object ใน Storage ตามมติ 0045) · `file_url`/`file_name` **คงไว้เป็นกระจกของไฟล์แรก** ให้ client รุ่นเก่า · `rpc_create/update_std_drawing` ของ 0045 ไม่แตะ · `rpc_delete_std_drawing` แก้แค่ข้อความ audit · **demo sync** `logic.ts` (`stdDrawingFiles` fallback แถวเก่า · `MAX_STD_DRAWING_FILES` · create/update รับ `files`) · `types.ts` (`StdDrawingFile`) · `remote.ts` · UI `StandardsPage` (`<input multiple>` + รายการไฟล์ เอาออก/ยกเลิกรายตัว) · Price list ยังไฟล์เดียวเหมือนเดิม · **5 เคสใน `logic.test.ts`** · **ต้องรันก่อน push** |
| `0079_job_closeout_warranty.sql` | **ฟีเจอร์ (2026-09-25)**: **🏁 ปิดงานติดตั้ง = เอกสารรับมอบ + Warranty** (เฟส 1 ของเมนู Service (Warranty)) · มติผู้ใช้: (1) บังคับเลือก **PAC / AC / COD / Handover** 1 ประเภท + **ไฟล์ตอนปิดเท่านั้น** (ผู้ใช้เลือกเองแม้รู้ว่า PAC มาหลังปิดงาน — ทางออกคือปิดด้วย Handover/COD แล้วแนบ PAC เพิ่มที่แท็บ Warranty) (2) Warranty **บันทึกทั้ง 2 แบบคู่กัน**: `installation` ระดับ Job (default เริ่ม = วันรับมอบ) + `lbs` ระดับเครื่อง **ทุกเครื่องที่ติดตั้งสำเร็จ** (default เริ่ม = **วันติดตั้งจริงรายเครื่อง**) · ทุกประเภทต้องมีไฟล์ ≥ 1 · ตาราง `job_warranties` (unique installation/job · lbs/unit) + `job_closeout_files` + คอลัมน์ `jobs.acceptance_type/doc_no/date` · bucket **private** `service-docs` (เฟส 2–3 ใช้ต่อ) · 🔴 **`rpc_close_job_install` เปลี่ยน signature ⇒ DROP + recreate** (body คัดจาก 0040 · คงข้อความ "ปิดงานได้เฉพาะงานที่เบิกแล้ว" ที่ DO block ของ 0071 ค้นหา · GRANT ใหม่) · helper `app_save_job_closeout` ใช้ร่วมกับ `rpc_set_job_closeout` (**บันทึกย้อนหลัง/แก้ไข** ใบที่ปิดก่อน 0079 · Service+Project) + `rpc_add/delete_closeout_file` (ห้ามลบไฟล์สุดท้ายของประเภท) · helper `app_*` REVOKE จาก authenticated · ตารางใหม่มี `require_active` (0058) — 0074/0076 ไม่มี (ช่องโหว่เดิม ยังไม่แก้) · **demo sync** `logic.ts` (`applyCloseout`/`setJobCloseout`/`addCloseoutFile`/`deleteCloseoutFile`/`warrantyStatus`/`warrantyEndFor`) · `remote.ts` (`qOptional` — ตารางใหม่ยังไม่มี = [] ไม่ทำทั้งแอปพัง) · UI `ui/CloseoutForm.tsx` (ใช้ร่วม 2 ที่) · `ServicePage` (โมดัลปิดงาน `size="xl"` + รายการสิ่งที่ยังขาด) · หน้าใหม่ `WarrantyPage` `/warranty` (แท็บ Warranty Period เรียงวันเริ่มนับ · ป้ายใกล้หมด ≤ 90 วัน · เอกสาร · บันทึกย้อนหลัง) · **รอบตรวจบั๊ก (2026-09-25)**: (1) `app_add_closeout_file` เช็ค `kind IS NULL` (เดิม `NOT IN` กับ NULL = ข้ามด่าน แล้วไปเด้ง NOT NULL ดิบ) (2) บันทึก Warranty LBS ลบแถวค้างของเครื่องเดียวกันจาก Job อื่นด้วย (ไม่งั้นชน `uq_job_warranties_lbs` ปิดงานไม่ได้) (3) **`doc_type` ต่อไฟล์รับมอบ** + ต้องมีไฟล์ **ประเภทเดียวกับที่เลือก** (เดิมเลือก PAC แต่มีแค่ไฟล์ Handover ก็ผ่าน · PAC ที่แนบตามมาแยกไม่ออกจาก Handover) + ห้ามลบไฟล์ประเภทที่ใช้ปิดงานตัวสุดท้าย (4) ใบที่ไม่มีผลติดตั้งรายเครื่อง (flow ก่อน 0035) ไม่บังคับไฟล์ Warranty LBS · storage `service-docs` เขียน/ลบได้เฉพาะ Service/Project/Manage · Job Detail แสดงสรุปเอกสารรับมอบ + Warranty · **15 เคสใน `logic.test.ts`** · ทดสอบบนเดโมครบ flow ปิดงาน→Warranty→แนบ PAC ตามมาแล้ว · **ต้องรันก่อน push** |

> DB ใหม่บนโปรเจกต์เปล่า: รัน **0001→0079** เรียงกันได้เลย (0004/0005 ผสานเข้า 0001/0002 ต้นทางแล้ว แต่ยังเก็บไฟล์แยกไว้เป็นประวัติ · 0012/0013 ถูก 0014 ยกเลิกแต่ต้องรันเรียงเพราะ 0014 อ้างถึงของที่มันสร้าง — ทุกไฟล์ idempotent รันซ้ำได้)
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
  - 🔒 **fail-closed ตั้งแต่ `54a48ed` (2026-08-22)**: ไม่มี `LINE_CHANNEL_SECRET` = ตอบ **503 ทุก request** (เดิมปล่อยผ่าน = #5)
    · เทียบ signature ด้วย `timingSafeEqual` ที่เขียนเอง (Workers ไม่มี `crypto.timingSafeEqual`) · body ไม่ใช่ JSON = 400 ไม่ใช่ 500
    · ⚠️ **ตั้ง env ให้ครบก่อน deploy เสมอ** — ตอนนี้ถ้า env หาย LINE จะตายทันที ไม่ใช่ทำงานต่อแบบไม่ปลอดภัยอีกแล้ว
  - ⚠️ **กลุ่ม = แจ้งเตือนเท่านั้น (มติ 2026-08-05)** — บอท**ไม่ตอบข้อความใดๆ ในกลุ่ม/ห้องแชท**
    (เดิมมี fallback ตอบทุกข้อความ → บอทแทรกทุกบทสนทนาในกลุ่มทีม) · การแจ้งเตือนใช้ **push** ผ่าน `/line-notify` คนละทางกับ webhook จึงไม่กระทบ
    · **ต้องปิดฝั่ง LINE ด้วย**: LINE Official Account Manager → Response settings → `Chat = ปิด · Webhook = เปิด · Auto-response = ปิด · Greeting message = ปิด` (ไม่งั้น LINE ตอบเองแม้โค้ดไม่ตอบ)
    · หา Group ID ของกลุ่มใหม่: พิมพ์ `id` ในกลุ่ม → บอทไม่ตอบในแชท แต่ log ค่าไว้ที่ **Cloudflare → Functions → Real-time logs** · หรือตั้ง env `LINE_BOT_REPLY_IN_GROUP=1` ชั่วคราวให้ตอบในกลุ่มได้
  - **แชท 1:1 ยังตอบตามเดิม** (จำเป็นกับ flow อนุมัติ 0033): พิมพ์ **โค้ด 6 หลัก** → ผูกบัญชี LINE · ปุ่ม ✅ อนุมัติ (postback) · ข้อความอื่นตอบข้อความช่วยเหลือสั้นๆ
  - คำสั่ง `สถานะ <Job No.>` (สถานะจริงจาก Supabase + คืบหน้ารายเครื่อง + ทีม) **ยังอยู่ในโค้ดแต่ใช้ไม่ได้แล้ว** เพราะถูกจำกัดให้ตอบเฉพาะในกลุ่ม `LINE_GROUP_ID` ซึ่งตอนนี้เงียบ — เปิดคืนได้ด้วย env `LINE_BOT_REPLY_IN_GROUP=1`
  - รับ **postback** จากปุ่ม ✅ อนุมัติ ในการ์ด Flex → `rpc_line_approve` (map `line_user_id` → user → เช็ค role sales/admin)
- `POST /line-approval-push` — `{requestId}` หรือ `{jobId, type}` → ดันการ์ด **Flex (ปุ่ม ✅ อนุมัติ + 🔎 ตรวจสอบ)** เข้าแชท 1:1 ของผู้อนุมัติที่ผูก LINE แล้ว · StoreContext ยิงหลัง `requestApproval` สำเร็จ (LIVE + เปิดสวิตช์ LINE)
  - 🔒 **`54a48ed`**: ต้องมี JWT **แบบ fail-closed** (ไม่มี `VITE_SUPABASE_ANON_KEY` = 503 · เดิมปล่อยผ่าน) **+ ด่านแผนก `['project','admin']`**
    ให้ตรงกับ `rpc_request_approval` → `app_assert_dept(ARRAY['project'])` · เดิมเช็คแค่ "login แล้ว" ⇒ VIP (อ่านอย่างเดียว)/Service ก็ดันการ์ดปุ่ม ✅ ได้ (F4)
    · Division เป็นฝ่าย**รับ**การ์ด ไม่ใช่ฝ่ายส่ง จึงไม่อยู่ในรายการ
- `GET /line-quota` — โควตา push ของ Messaging API (ปุ่ม 📊 ใน Dev Settings)
- `POST /admin-users` — ต้องมี JWT admin; ใช้ service role · action: `create` (สร้าง user + auto-confirm email) · `set_email` · `set_password` · **`set_active`**
  - 🔒 **`set_active` (`b24f262`, F3 ขั้น 1)** — `updateUserById(id, { ban_duration })` · ban 100 ปีตอนปิด / `'none'` ตอนเปิดคืน
    `remote.updateUser` เรียกให้อัตโนมัติทุกครั้งที่บันทึกผู้ใช้ (idempotent + re-sync ถ้า ban กับ `profiles.is_active` หลุดจากกัน)
    · **ทำไมแค่ `is_active` ไม่พอ**: มันบังคับที่ `app_assert_dept` (ฝั่งเขียน) และหน้า login เท่านั้น —
    คนที่ถูกปิดบัญชียังยิง `/auth/v1/token` ตรงไปที่ Supabase ได้ JWT แล้วอ่านข้อมูลผ่าน PostgREST
    · ban ตัด "การออก token ใหม่" (password grant + refresh) · **access token ที่ถืออยู่แล้วยังใช้ได้จนหมดอายุ (default 1 ชม.)**
    ⇒ จึงต้องมี `0058` เป็นชั้นที่สองคู่กันเสมอ
- รูปแบบ: `export async function onRequestPost({ request, env })` · อ่าน env ผ่าน `env.XXX` (ไม่ใช่ `process.env`)
- ทดสอบ functions ในเครื่อง: `npx wrangler pages dev dist` (build ก่อน) — Vite `npm run dev` ไม่รัน functions

## 8. แผนก + สิทธิ์ (RLS + app_assert_dept) — อัปเดต 2026-08-28 (Purchasing ได้ Material Database · 0061)

ชื่อแสดงผลเปลี่ยน (มติ 2026-07-19): `sales` → **"Division"**, `admin` → **"Manage"** (ค่าใน DB คงเดิม — แก้ที่ `DEPT_LABEL` ใน format.ts)

| แผนก (DB) | แสดงผล | ทำอะไรได้ |
|---|---|---|
| `sales` | **Division** | สร้าง/แก้/ลบ Project Stock, รับ LBS เข้า, **แก้ข้อมูลรายเครื่อง — รวม Serial + ต้นทุน + ลูกค้าแผน + FOB date + ETA to WH + Plan Delivery ในฟอร์มเดียว (0043/0049)**, **ตั้ง FOB ทั้งคลัง (0049)**, ปรับยอดคลังสินค้า accessory + **ตั้ง/แก้ Lot No. คลังคงเหลือ (0055 — ปุ่ม 🏷 Lot + ช่องในโมดัลปรับยอด)** + **อนุมัติ/ตีกลับคำขอจาก project** (หน้า "รออนุมัติ") + ตอบกลับความเห็น VIP (0050) |
| `project` | Project | เปิด/แก้/ลบ Job, ดึง-คืน LBS, ขอวัสดุ (+Phase Budget), **บันทึกงวดเงิน Payment (0044 — ทำได้แม้ปิดงานแล้ว)** — ส่วน **ออก PR / เบิกให้ Service / ยกเลิก Job ต้องส่งคำขอให้ Division อนุมัติ** (`rpc_request_approval`) · **⚠️ ทำรายการได้เฉพาะ Job ที่อีเมลตัวเองเปิด (0042) — Job ของคนอื่นดูได้อย่างเดียว** |
| `purchasing` | Purchasing | ออก PO / ยกเลิก PO (ยังไม่รับของ) / ตีกลับ PR / รับของ (partial ได้) / **แก้เลข PR ให้ตรงเอกสารจริง — เฉพาะใบที่ยังไม่ออก PO (0047)** · **ทำเบิก-Epicor รายบรรทัด (0064)** · **Material Database (0061)** — เพิ่ม/แก้/ลบ Accessory + Export/Import Excel + ปรับยอดคลังคงเหลือ + Lot No. · **⚠️ ไม่รวมคลัง LBS / Project Stock** ซึ่งยังเป็นของ Division เท่านั้น |
| `service` | Service | ยืนยันติดตั้งเสร็จ (+วันที่จริง) |
| `admin` | **Manage** | ทำได้ทุกอย่าง + **ข้ามขั้นอนุมัติ** (เรียก rpc_create_pr/issue/cancel ตรงได้) + อนุมัติแทน Division ได้ + Material Database + ผู้ใช้งาน + **Dev Settings (แผนกเดียวที่เห็น** — เมนูซ่อน + route redirect สำหรับแผนกอื่น) |
| `vip` | **VIP** | **ผู้บริหารสูงสุด (0050)** — ดูได้ทุกหน้าแบบ **อ่านอย่างเดียว** (RLS `read_all` ครอบให้อยู่แล้ว) · เขียนได้อย่างเดียวคือ **ความเห็นบนคำขออนุมัติ** (`rpc_add_approval_comment`) → แจ้ง Division ทันที · **ไม่อยู่ใน `app_assert_dept` ของ RPC ตัวอื่นเลย** = ยิง RPC เขียนข้อมูลอื่นไม่ผ่าน server (ไม่ใช่แค่ซ่อนปุ่ม) |

**สิทธิ์ระดับแถว (0042)**: Project แต่ละอีเมลดำเนินการได้เฉพาะ Job ที่ตัวเองเปิด (`jobs.opened_by`) — Job อื่นเห็นข้อมูลครบแต่ทำรายการไม่ได้ · **บังคับเฉพาะแผนก `project`** เท่านั้น (Purchasing/Service/Division/Manage ทำงานข้าม Job ได้ตามหน้าที่) · งานเก่าที่ `opened_by` ว่าง = ไม่ล็อก · **ไม่มีปุ่มโอนเจ้าของ — คนลาออก/ลาพักร้อนให้ Manage เข้าไปทำแทน**

**Approval flow (0016)**: project ขอ → แจ้งเตือน Division → division/admin อนุมัติที่หน้า "รออนุมัติ" = **execute ทันทีใน transaction เดียว** (fail = rollback ทั้งคำขอ) หรือตีกลับพร้อมเหตุผล (แจ้งกลับ project) · คำขอ pending ซ้ำ type เดียวกันต่อ Job ไม่ได้ (unique partial index) · `rpc_create_pr`/`rpc_issue_job`/`rpc_cancel_job` เช็ค admin-only แล้ว — project ยิง RPC ตรงจะโดนปฏิเสธ

**Standard Price list / Drawing / BOM (0045 + 0054)**: perm `standards.manage` = `project` + `sales` + `admin` — เพิ่ม/แก้/ลบ/อัปโหลด PDF ทั้ง 3 แท็บ · **ทุกแผนกที่ login อ่านและดาวน์โหลดได้** (เป็นมาตรฐานที่ทุกคนต้องใช้) · Price list ใช้กติกาเดียวกับ Drawing เป๊ะ (แก้ = ทับข้อมูลเดิม + stamp ผู้แก้/เวลา · ลบ = ลบทะเบียน ไฟล์ยังอยู่ใน Storage)

**Material Database (0061)**: perm `material.manage` = `purchasing` + `admin` (เพิ่ม/แก้/ลบ Accessory + Import Excel) · perm `accessoryStock.manage` = `sales` + `purchasing` + `admin` (ปรับยอดคลังคงเหลือ + Lot No.) · Export Excel ต้องมี `report.exec` (2026-09-09) ซึ่งตอนนี้ = ทุกแผนกที่ login

**รายงานผู้บริหาร — Export Excel ทั้ง 4 จุด (2026-09-09 · frontend ล้วน ไม่มี migration)**: perm **`report.exec`** = `sales` + `purchasing` + `project` + `service` + `admin` + `vip` = **ทุกแผนก**
· **ปุ่ม `⬇ Export` หายทั้งปุ่มถ้าไม่มีสิทธิ์** (มติ: ไม่ทำแบบ "ออกไฟล์แล้วตัดคอลัมน์เงินทิ้ง" — ไฟล์ที่ตัดคอลัมน์แล้วดูเหมือนไฟล์เต็ม คนรับต่อแยกไม่ออกว่าเลขครบหรือไม่)
· **`service` เพิ่มเข้ามา 2026-09-09 (ผู้ใช้ยืนยัน)** — เดิมตัดออกด้วยเหตุผลว่าหน้างานติดตั้งไม่ใช้ตัวเลขต้นทุน แต่ Service ต้องส่งไฟล์ให้หัวหน้างาน/ลูกค้าเองอยู่แล้ว
  · ⚠️ perm นี้จึงครบทุกแผนกและเหลือความหมายเป็น "ต้อง login ก่อน" — **ยังไม่ลบทิ้ง** เพราะเป็นจุดเดียวที่ปิดปุ่ม Export ทั้งระบบได้ทีเดียวถ้าภายหลังต้องจำกัดรายแผนกอีก (ตรวจแล้วบน demo: login Service เห็นและกดได้ทั้ง 4 จุด)
· ⚠️ **`project` ต้องอยู่ในรายชื่อ** — Project เห็นงบ 7 หมวด + ราคา/หน่วยบนจอของงานตัวเองอยู่แล้ว ตัดปุ่มออกคือถอยฟีเจอร์เดิม (เคยมีปุ่ม Export ที่แผง Purchase Orders มาก่อนชุดนี้)
· ⚠️ เป็น **gate ฝั่ง UI เท่านั้น** (ไฟล์สร้างจากข้อมูลที่ RLS `read_all` ให้อ่านได้อยู่แล้ว) — ถ้าต้องการ gate จริงระดับ server ต้องตัดสิทธิ์ SELECT ไม่ใช่แก้ที่ปุ่มนี้

**4 จุดที่เป็นรายงานผู้บริหาร** (ใช้ปุ่มเดิมทุกจุด ไม่มีปุ่มใหม่ · โครงชีตเหมือนกันหมดจาก `ui/xlsxReport.ts`):

| หน้า | ปุ่ม | ชีตในไฟล์ | Import กลับ |
|---|---|---|---|
| Project Stock → คลัง LBS (ต่อคลัง) | `⬇ Export` | สรุปผู้บริหาร · `<stockNo>` · วิธีกรอก | ✅ ชีต `<stockNo>` |
| Project Stock → วัสดุตาม Job (Ref.PO) | `⬇ Export Excel` | สรุปผู้บริหาร · วัสดุตาม Job · คำอธิบาย | ❌ อ่านอย่างเดียว |
| Project ID (Jobs) → Job → Purchase Orders | `⬇ Export Excel` | สรุปผู้บริหาร · Purchase Orders · คำอธิบาย | ❌ อ่านอย่างเดียว |
| Material Database | `⬇ Export Excel` | สรุปผู้บริหาร · ฐานข้อมูลวัสดุ · คลังคงเหลือ · คำอธิบาย ×2 | ✅ ชีต `ฐานข้อมูลวัสดุ` |

**ทั้ง 4 จุดออกไฟล์ "ตามที่กรองอยู่บนจอ" เหมือนกันหมด (2026-09-09 รอบที่ 2)** — คลัง LBS กรองตามคลังที่กดปุ่ม · อีก 3 จุดกรองตามคำค้น/Job ที่เปิดอยู่ · ทุกไฟล์ที่ถูกกรองต้องเขียน scope + ⚠️ คำเตือนไว้บนสุดของชีตสรุป **เพิ่มจุด export ใหม่ต้องทำตามกติกานี้**

🔴 **กับดักที่ชุดนี้เกือบทำพัง — ชีตข้อมูลไม่ใช่ชีตแรกอีกแล้ว**
ตัวอ่าน Import เดิมอ่าน `wb.SheetNames[0]` (Material Database) และ `find(n => n !== 'วิธีกรอก')` (Project Stock)
พอเติมชีต "สรุปผู้บริหาร" ไว้หน้าสุด ทั้งสองจุดจะได้ชีตสรุปแล้วขึ้น **"ไฟล์ไม่มีข้อมูล" ทั้งที่ไฟล์ถูกต้อง**
→ ทั้งสองจุดเปลี่ยนไปใช้ `dataSheetName(wb, [ชื่อที่คาด...])` ซึ่งลองชื่อที่คาดก่อน แล้ว fallback ชีตแรกที่ไม่ใช่คู่มือ/สรุป
→ ชีตข้อมูลของ Material Database **เปลี่ยนชื่อ** `Accessory Catalog` → `ฐานข้อมูลวัสดุ` · **ชื่อเก่ายังอยู่ในรายชื่อที่ยอมรับ** ไฟล์ที่ export ไปก่อนหน้านี้จึงยัง import ได้
→ **ห้ามใส่แถวรวมในชีตที่ import กลับได้** — `sheet_to_json` จะอ่านแถวรวมเป็นวัสดุ/เครื่องอีกรายการ (ชีต read-only ใส่ได้ และ autofilter ตั้งให้ไม่คลุมแถวรวม กรองแล้วยอดรวมไม่หาย)
→ เทสต์ `src/ui/xlsxReport.test.ts` คุมทั้ง 3 ข้อนี้ไว้แล้ว (13 เทสต์) · **ทดสอบจริงบน demo แล้ว**: export ไฟล์ Material Database → ป้อนกลับเข้า Import → preview ขึ้น "ไม่เปลี่ยน" ทุกแถว (ใหม่ 0 · อัปเดต 0)

⚠️ **SheetJS รุ่น community เขียนสไตล์ลงไฟล์ไม่ได้** — ตัวหนา/สีพื้น/เส้นขอบ/freeze pane ใส่ไปก็ไม่มีผล
ที่ใช้ได้จริงและชุดนี้ใช้ทั้งหมด: `!cols` (ความกว้าง) · `!merges` (หัวข้อคั่นเต็มแถว) · `!autofilter` · `cell.z` (รูปแบบตัวเลข `#,##0` / `#,##0.00` / `0.0"%"`)
**ถ้าจะทำหัวตารางเป็นตัวหนา/มีสี ต้องเปลี่ยนไปใช้ ExcelJS หรือ SheetJS Pro — ไม่ใช่แก้โค้ดเพิ่ม**

**ค้นหาวัสดุ หน้า Material Database (2026-09-09 · แก้ขอบเขตเป็นระดับหน้าในรอบที่ 2 วันเดียวกัน)**: ค้น **ชื่ออุปกรณ์ / รหัส Epicor / Lot No.**
· ช่องค้นหาอยู่ใน **พาเนลของตัวเองเหนือทั้ง 2 พาเนล** — **กรองทั้ง `ฐานข้อมูลวัสดุ` และ `คลังคงเหลือ`** · พิมพ์แล้ว**ตารางกางเองทั้งคู่** (ไม่ต้องกด "แสดงรายการ" อีกที) · หัวพาเนลทั้งสองโชว์ `n/ทั้งหมด` + มูลค่าที่ตรงคำค้นคู่กับมูลค่าทั้งคลัง
· ⚠️ **ห้ามย้ายช่องค้นหาไปไว้ในหัวพาเนลใดพาเนลหนึ่ง** — วางในหัวพาเนลไหน คนจะอ่านว่ากรองแค่พาเนลนั้น (เป็นเหตุผลที่รอบที่ 2 ต้องย้ายออกมา)

**ไฟล์ Export ตามคำค้น — กติกาเดียวกันทุกจุดแล้ว (2026-09-09 รอบที่ 2 · ผู้ใช้ยืนยัน)**
เดิมหน้า Material Database ครอบทั้งระบบเสมอ (ต่างจากแท็บ "วัสดุตาม Job" ที่ตามที่กรอง) ⇒ ค้นแล้วกด Export ได้ไฟล์ที่ไม่เกี่ยวกับสิ่งที่ค้น
เหตุผลเดิมคือชีต `ฐานข้อมูลวัสดุ` import กลับได้ แล้วไฟล์ที่กรองจะดู "เหมือนของหาย" — แต่นั่นเป็นปัญหา**การอ่านไฟล์** ไม่ใช่ข้อมูลหายจริง:
🔑 **Import เป็น upsert ล้วน ไม่มีทางลบ** (`runImport` มีแต่ `createItem`/`updateItem` — ไม่มี `deleteItem` · ลบวัสดุทำได้บนหน้าเว็บทางเดียว)
⇒ แก้ที่การอ่านไฟล์แทน · ตอนนี้ไฟล์ Material Database ที่กรองแล้วมี **ทุกอย่างตามขอบเขตคำค้น**: ทั้ง 2 ชีตข้อมูล · KPI (พร้อม note บอกยอดทั้งระบบ) · Top 10 (% หารด้วยมูลค่าในขอบเขต) · ตารางเคลื่อนไหว 30 วัน
พร้อมสัญญาณ 4 ชั้นกันเอาไปอ้างเป็นยอดรวมองค์กร: **ชื่อไฟล์** (`…-กรอง-<คำค้น>-<วันที่>.xlsx`) · **ป้ายปุ่ม** `⬇ Export Excel (n+m)` · **บรรทัด scope + ⚠️ 2 ข้อบนสุดของชีตสรุป** (ข้อที่ 2 บอกตรง ๆ ว่า import ไม่ลบรายการอื่น) · **หัวชีตคำอธิบาย**
· ปุ่มเป็น `disabled` เมื่อคำค้นไม่ตรงอะไรเลย (ท่าเดียวกับแท็บวัสดุตาม Job) — ไม่ปล่อยให้ออกไฟล์เปล่า
· ✅ **ทดสอบ round-trip บน demo แล้ว**: ค้น "Transformer" (1/4 · 1/2) → Export → อัปไฟล์นั้นกลับเข้า Import → preview "ไม่เปลี่ยน" 1 แถว · ยืนยันนำเข้า → ฐานข้อมูลวัสดุยังครบ **4 รายการ** (อีก 3 รายการไม่ถูกแตะ)
**⚠️ ทำไมต้องเป็น perm ใหม่ 2 ตัว ไม่ใช่เติมแผนกเข้าของเดิม** — `master.manage` ยังครอบ "ข้ามขั้นอนุมัติ" (`createPR`/`issueJob`/`cancelJob`/`swapLbs`/`reopenJob`) + จัดการผู้ใช้ · `stock.manage` ยังครอบ **Project Stock / LBS รายเครื่อง** ซึ่งเป็นของ Division · เติม `purchasing` เข้า 2 ตัวนั้นตรง ๆ = แจกสิทธิ์เกินที่ขอไปเงียบ ๆ อีกสิบกว่า action · ฝั่ง SQL แยกเหมือนกัน (0061 patch เฉพาะ 5 RPC ที่เกี่ยวข้อง และมี DO block ตรวจว่า RPC คลัง LBS **ไม่มี** คำว่า purchasing)

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

17. **query ที่มี `limit` ต้องเรียง `DESC` เสมอ — และห้ามเอา slice ที่ถูก limit ไปตัดสินใจอะไร (2026-08-22 · F1 ชุด A)**
    `loadAll` ดึง notifications ด้วย `asc:true limit 300` = **"เก่าสุด 300 แถว"** ขณะที่ตารางใหญ่ตัวอื่น
    ในไฟล์เดียวกัน (`audit_logs`, `stock_movements`) ใช้ `asc:false` หมด · ผลจริง 2 ชั้น เมื่อตารางเกิน 300 แถว:
    - **ชั้นที่เห็น**: TopBar + NotificationsPage ทำ `.reverse()` ต่อ ⇒ โชว์ "ใหม่สุดของ 300 แถวเก่าสุด"
      = ค้างอยู่ที่ข้อมูลเดือน ก.ค. ถาวร แถวใหม่ไม่เคยถูกโหลดมาเลย
    - **ชั้นที่ไม่เห็น (หนักกว่า)**: `dispatchLine` เช็ค `some(n => n.lineStatus === 'pending')` **จาก slice นั้น**
      พอ 300 แถวเก่าสุดถูก mark ครบ เงื่อนไขเป็น false ตลอดกาล ⇒ `rpc_claim_line_pending` ไม่ถูกเรียกอีก
      ⇒ **แจ้งเตือน LINE หยุดทั้งบริษัทโดยไม่มี error ที่ไหนเลย** ไม่มีใครสังเกตหลายสัปดาห์
    → แก้: `asc:false` แล้ว `[...notifs].reverse()` ตอน map เพื่อคง shape เก่า→ใหม่ ให้เหมือน demo mode
      (`logic.ts` ต่อท้าย array) ⇒ **ไม่ต้องแตะหน้าจอเลย และ demo/live ไม่แยกทิศทางกัน** ·
      และย้ายตัวตัดสินไปฝั่ง server: เรียก `rpc_claim_line_pending` ตรง (คืน array ว่างเองเมื่อสวิตช์ปิด/ไม่มีคิว)
    ⚠️ **กติกา 2 ข้อ**: (ก) `limit` คู่กับ `DESC` เสมอ ถ้าต้องการ ASC ให้ reverse ทีหลัง ไม่ใช่เปลี่ยนทิศที่ query
    (ข) **ห้าม gate อะไรด้วยข้อมูลที่ถูก `limit` มา** — ตัวตัดสินต้องเป็น server หรือ `count` ไม่ใช่ slice
    **ยังมีเพดานเงียบตัวอื่นรอแก้**: `lbs_units` 5000 · `stock_movements` 1000 · `audit_logs` 500 (#7) ·
    และ `q()` ไม่ใส่ `.limit()` เลยเมื่อไม่ส่ง `order` ⇒ `profiles`/`accessory_stock`/`notification_reads`
    ตกไปใช้ max-rows ของโปรเจกต์ (F5)

18. **RLS policy `FOR ALL TO authenticated` ≠ defense in depth — มันคือประตูที่เปิดอยู่ (2026-08-22 · F1 critical)**
    เข้าใจผิดกันมาตั้งแต่ 0001: คิดว่า "ทุก write ผ่าน RPC ที่ SECURITY DEFINER อยู่แล้ว policy จึงเป็นแค่ชั้นสำรอง"
    **แต่ Supabase ให้ role `authenticated` มี INSERT/UPDATE/DELETE ครบทุกตารางใน `public` เป็น default grant**
    (ไม่มี `GRANT` บนตารางในไฟล์ migration ไหนเลย — มาจาก `ALTER DEFAULT PRIVILEGES` ของ Supabase เอง)
    ⇒ **RLS เป็นประตูเดียว** และ policy ฝั่งเขียน **19 ตัว** (0001/0042 + `standards_write` ที่ 0045/0054) แบบ `FOR ALL/INSERT/UPDATE TO authenticated` = เปิดประตูให้เลย
    ⇒ ใครก็ได้ที่ login เปิด DevTools แล้วยิง PostgREST **เขียนตารางตรง ข้าม RPC / approval / audit / ledger ทั้งหมด**
    ตัวอย่างที่ทำได้จริง: Project `PATCH /rest/v1/jobs {"terminal_status":"issued"}` → งานเป็น Issued ทันที
    (เพราะ `v_job_status` อ่านคอลัมน์นี้ตรง ๆ · ทั้งระบบมี trigger 4 ตัว ไม่มีตัวไหนคุม `jobs`)
    → แก้ที่ `0057` (REVOKE + `ALTER DEFAULT PRIVILEGES`) · `SELECT` ไม่แตะ
    ⚠️ **คอมเมนต์ที่ `0042_job_ownership.sql:135` ("client เขียนตารางตรงไม่ได้อยู่แล้ว") ผิด — อย่าเชื่อ**
       เก็บไฟล์ไว้ตามเดิมเพราะเป็นสิ่งที่รันไปแล้ว แต่รู้ไว้ว่าประโยคนั้นคือต้นเหตุที่ช่องนี้อยู่มา 56 migration
       โดยไม่มีใครไปตรวจซ้ำ · **บทเรียนกว้างกว่านั้น: คอมเมนต์/เอกสารที่ยืนยันความปลอดภัย ต้องมีวิธีพิสูจน์แนบไว้ด้วย**
       (0057 จึงมี DO block ตรวจ `has_table_privilege` และคำสั่งทดสอบใน DevTools เขียนไว้ท้ายไฟล์)
    **ทดสอบ**: `await supabase.from('jobs').update({scope:'x'}).eq('id','<job ตัวเอง>')` — ต้องได้ `42501`
       · หรือจากนอกระบบด้วย anon key: `POST /rest/v1/audit_logs` body `{}` — ข้อความต้องเป็น
       `permission denied for table audit_logs` (ระดับ grant) **ไม่ใช่** `new row violates row-level security policy` (ระดับ RLS)

19. **view ไม่มี RLS และรันด้วยสิทธิ์ owner — เปิด view ใน `public` = เปิดข้อมูลให้ `anon` (2026-08-22 · F3 ขั้น 2)**
    ตอนวางแผน 0058 คิดว่า view เป็นช่องให้ "บัญชีที่ถูกปิด" อ่านข้อมูลได้ · **ประเมินต่ำไป**
    view ที่ไม่ได้ตั้ง `security_invoker` รันด้วยสิทธิ์ของ **owner** (postgres) ⇒ **bypass RLS ของตารางข้างใต้ทั้งหมด**
    และ Supabase ให้ `anon` มี `SELECT` grant มาโดย default (0057 ตัดแค่ INSERT/UPDATE/DELETE)
    ⇒ **ใครก็ตามที่มี anon key ยิง `/rest/v1/v_job_status` ได้ Job No. + ชื่อลูกค้า + สถานะทุกงาน โดยไม่ต้อง login**
    และ anon key อยู่ใน bundle ที่โหลดได้จากเว็บสาธารณะ = เปิดสู่อินเทอร์เน็ตจริง ๆ
    → แก้: `REVOKE ALL ON <view> FROM authenticated, anon` (0058 ข้อ 3b)
      ปลอดภัยเพราะ frontend ไม่ใช้ view เลย (`grep 'v_job_status\|v_unit_install_state' src/` = 0)
      ผู้ใช้จริงมีแค่ `line-webhook` (service_role — ไม่โดน revoke) และ RPC (SECURITY DEFINER รันเป็น owner)
    ⚠️ **กติกา: สร้าง view ใน `public` เมื่อไร ต้องตัดสินใจเรื่องสิทธิ์ทันที** — ไม่มี RLS มาช่วย
       เลือกอย่างใดอย่างหนึ่ง: (ก) `REVOKE` จาก `authenticated`/`anon` ถ้า client ไม่ได้ใช้
       (ข) `ALTER VIEW ... SET (security_invoker = true)` ถ้า client ต้องใช้ (RLS ของตารางข้างใต้จะทำงาน)
    **ทดสอบ**: `GET /rest/v1/<view>` ด้วย **anon key เปล่า ๆ ไม่ต้อง login**
       — ได้ข้อมูลกลับมา = รั่ว · `permission denied for view` = ปิดแล้ว
    **สืบย้อนหลังได้**: Supabase → Logs → API/PostgREST กรอง path ของ view นั้น

20. **migration ที่วนจาก catalog ต้องกรอง object ของ extension และต้องมี preflight (2026-08-22)**
    0058 รอบแรกวน view **ทุกตัว** ใน `public` แล้วล้มบน production ทันที:
    `42P01 relation "public.pg_stat_statements_info" does not exist`
    Supabase ติดตั้ง extension ที่ทิ้ง view ไว้ใน `public` ซึ่ง `has_table_privilege` resolve ไม่ได้
    ⚠️ **ที่สำคัญกว่า error**: ถ้ามันไม่ล้ม ลูปนั้นจะไป `REVOKE` สิทธิ์บน view ของ extension ที่ไม่ใช่ของเรา
       = อาจทำ dashboard/extension ของ Supabase พัง · **เป็นบั๊กจริง ไม่ใช่แค่ error กวนใจ — ดีที่ล้มก่อน**
    → แก้: กรองด้วย `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid
      AND d.classid = 'pg_class'::regclass AND d.deptype = 'e')` = "ไม่ใช่สมาชิกของ extension"
      ใส่ให้ครบ**ทุกที่ที่วน** (ลูปตาราง · ลูป view · บล็อกตรวจทุกอัน) ไม่ใช่เฉพาะที่พัง
      \+ `to_regclass(...) IS NOT NULL` กันชื่อที่ resolve ไม่ได้ทุกกรณี
    ⚠️ **กติกา: migration ที่วนจาก `pg_class`/`pg_tables` ต้องมี "ข้อ 0 PREFLIGHT"** —
       query อ่านอย่างเดียวไว้ดูรายชื่อ object ที่จะโดนก่อนรันจริง พร้อมบอกจำนวนที่คาดไว้
       (0058 คาด table ~28 + view **2 ตัวเท่านั้น**) · เห็นชื่อแปลก = หยุด
    💡 ผลดีของ transaction เดียว: ล้มกลางทาง = rollback ทั้งก้อน DB ไม่เหลือสถานะครึ่ง ๆ กลาง ๆ
       (ใช้ข้อนี้ยืนยันย้อนกลับได้ด้วย — 0057 REVOKE ติด ⇒ DO block ตรวจผลผ่านครบทุกข้อแน่นอน)

21. **ลิงก์กลับเข้าเว็บจากนอกแอปต้องมี `#` เสมอ — HashRouter (2026-08-22)**
    `line-approval-push` สร้างลิงก์ปุ่ม "🔎 ตรวจสอบในระบบ" เป็น `${appUrl}/approvals`
    แต่แอปใช้ **`HashRouter`** (`src/main.tsx`) URL จริงของหน้าคือ `/#/approvals`
    ⇒ Cloudflare เสิร์ฟ `index.html` (SPA fallback) · `location.hash` ว่าง · route ไม่ match
      ตกไปที่ `<Route path="*">` → `Navigate to="/dashboard"`
    ⇒ **ปุ่มนั้นเด้งไป Dashboard ทุกครั้ง ไม่เคยพาไปหน้าที่รออนุมัติเลยตั้งแต่ 0033**
    **ไม่มี error ที่ไหนเลย** — หน้าเว็บเปิดได้ปกติ แค่ผิดหน้า จึงไม่มีใครรายงาน
    → แก้ที่ `9c33c25`: `${appUrl}/#/approvals` + เพิ่มปุ่ม `📄 เปิดงาน` → `/#/jobs/<id>`
    ⚠️ **กติกา: ทุกที่ที่สร้าง URL ของแอปจากนอก React (Functions, ข้อความ LINE, อีเมล, QR)
       ต้องมี `/#/` คั่น** · ตอนนี้มีที่เดียวคือ `line-approval-push.js` — เพิ่มที่ใหม่ให้ตรวจข้อนี้ด้วย
    **ทดสอบ**: เปิดลิงก์นั้นจากมือถือจริง แล้วดูว่า**ลงหน้าไหน** — เช็คแค่ "เปิดได้ไม่ error" ตรวจไม่เจอ
    💡 ถ้าวันหนึ่งย้ายไป `BrowserRouter` ลิงก์แบบ `/#/x` จะยังทำงาน (hash ถูกมองข้าม)
       แต่ต้องตั้ง `_redirects` ให้ครบทุก path ก่อน — เป็นเหตุผลหนึ่งที่ยังไม่ย้าย

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
      ✅ **ตรวจซ้ำ 2026-08-22 — ยืนยันว่า service key ไม่เคยหลุดลง git จริง**: `git log --all -S"sb_secret_"` เจอแค่ HANDOFF ที่พูดถึง *ชื่อ prefix* · `.env.live-backup` ที่เคยเผลอ commit (`9933461`, untrack ที่ `adaf6a8`) มีแค่ `VITE_SUPABASE_URL` + anon key ซึ่งเป็น publishable · **ยังควร rotate อยู่ดีเพราะเคยหลุดนอก repo**
- [x] ~~🟠 **F3 — ปิดบัญชีแล้วยังอ่านข้อมูลทั้งบริษัทได้**~~ — **แก้แล้ว 2 ชั้น (ก้อน D · 2026-08-22)**
      **ชั้น 1 `b24f262`** — `admin-users` action `set_active` → `updateUserById(id, { ban_duration })`
      ban 100 ปีตอนปิด / `'none'` ตอนเปิดคืน · `remote.updateUser` เรียกต่อจาก `rpc_update_profile`
      (ลำดับสำคัญ — RPC มี guard ปิดบัญชีตัวเองไม่ได้ ถ้าโดนปฏิเสธจะไม่ไป ban)
      \+ `StoreContext.login` แยกเคส `user_banned` → "บัญชีนี้ถูกปิดการใช้งาน ติดต่อผู้ดูแลระบบ"
      (ไม่งั้นผู้ใช้เห็น "รหัสผ่านไม่ถูกต้อง" แล้วไปนั่งลองรหัสใหม่ผิดเรื่อง)
      **ชั้น 2 `0058`** — `require_active` restrictive policy 28 ตาราง + ตัดสิทธิ์ view · ดู §5 และ §9 ข้อ 19
- [ ] 🟠 **ทดสอบ 0058 ด้วยบัญชีจริง — ยังไม่ได้ทำ · ทำก่อนอย่างอื่น**
      DO block ใน 0058 ตรวจได้แค่โครงสร้าง (policy ถูกสร้าง + เป็น RESTRICTIVE จริง)
      **ตรวจไม่ได้ว่าคนใช้งานยังเห็นข้อมูล** → ต้อง login ด้วย **Project / Purchasing / Service / VIP**
      อย่างละ 1 บัญชี แล้วเปิดทุกเมนู · เห็นข้อมูลครบ = ผ่าน
      จอว่าง หรือขึ้นแบนเนอร์ "โหลดข้อมูลไม่สำเร็จ" = `my_is_active()` คืน false ผิด → **rollback ทันที**
      (สคริปต์ท้ายไฟล์ `0058` — วนจาก `pg_policies` ลบเฉพาะ `require_active` ที่ไฟล์นั้นสร้าง)
- [ ] 🟠 **ปิด 4 บัญชี e2e ที่ค้าง** — ตอนนี้ปิดผ่านหน้า "ผู้ใช้งาน" ได้เลย ระบบจะ ban ที่ auth ให้เองแล้ว (ชั้น 1)
      ไม่ต้องรัน `cleanup_e2e_accounts.sql` แล้วก็ได้ · `e2e-runner@example.org` เคยเป็น admin และรหัสผ่านเคยเปิดเผย = เร่งสุด

### 🟠 Migrations — ✅ 0070–0077 รันครบ (ยืนยัน 2026-09-15 → 09-19) · ⚠️ 0060–0069 ไม่มีบันทึกยืนยันในเอกสาร

> **อ่านก่อน:** เช็กลิสต์ข้างล่างหยุดอัปเดตไว้ที่ 0060 ระหว่างที่ migration เดินต่อถึง 0074
> — ตัวรายการฉบับสมบูรณ์อยู่ที่ **ตาราง §5** ซึ่งครบทุกไฟล์ · ส่วนนี้เก็บเฉพาะ
> "ไฟล์ไหนรันบน production แล้วบ้าง" ซึ่งเป็นคนละเรื่องกับ "ไฟล์ไหนมีอยู่"
>
> | ช่วง | สถานะบน production |
> |---|---|
> | 0001–0059 | ✅ รันครบ (ยืนยันไว้ในเช็กลิสต์ข้างล่าง) |
> | **0060–0069** | ⚠️ **ไม่มีบันทึกยืนยัน** — เอกสารขาดช่วง ไม่ได้แปลว่ายังไม่รัน · ตรวจด้วยคำสั่งใต้ตาราง |
> | 0070–0077 | ✅ รันครบ · ผู้ใช้ยืนยันรายไฟล์ตอน push แต่ละรอบ (0070 · 0071 · 0072 · 0073 · 0074 · 0075+0076 · 0077) |
> | 0078 | ✅ รันแล้ว 2026-09-23 · ผู้ใช้ยืนยันก่อน push (`9617f15`) |
> | 0079 | ✅ รันแล้ว 2026-09-25 · ผู้ใช้ยืนยันก่อน push |
>
> ตรวจ 0060–0069 ทีเดียวจบ (รันใน SQL Editor — ทุกคอลัมน์ต้องได้ `true`):
> ```sql
> SELECT to_regprocedure('public.rpc_update_job(uuid,text,text,text,text,date,int,numeric,jsonb,jsonb,numeric,numeric)') IS NOT NULL AS m0060,
>        to_regclass('public.std_boms')            IS NOT NULL AS m0061_66,
>        to_regclass('public.stock_movements')     IS NOT NULL AS m0038_67,
>        EXISTS (SELECT 1 FROM information_schema.columns
>                 WHERE table_name = 'job_accessory_requests' AND column_name = 'qty_written_off') AS m0068,
>        to_regclass('public.public_share_links')  IS NOT NULL AS m0069;
> ```
> ได้ `false` ช่องไหน = รันไฟล์ช่วงนั้นซ้ำได้เลย (idempotent ทุกไฟล์)
>
> 🔴 **บทเรียน: เช็กลิสต์นี้ดริฟต์เพราะไม่มีใครติ๊กตอน push** — ตั้งแต่ 0075 เป็นต้นไป
> ให้เติมบรรทัดในตารางด้านบน **ในคอมมิตเดียวกับที่เพิ่มไฟล์ migration** ไม่ใช่ทำทีหลัง
> (เอกสารที่บอกสถานะผิดอันตรายกว่าไม่มีเอกสาร — §9 เจอปัญหานี้มาแล้วกับ policy ของ 0057)

**กติกา: หลัง push ไม่ต้องรัน SQL ใดๆ เว้นแต่มี migration ไฟล์ใหม่ (ผมจะบอกชื่อไฟล์และลำดับ)**
ทุกไฟล์ idempotent — แถวไหนตรวจได้ `false` รันไฟล์นั้นซ้ำได้เลย

- [x] ~~0001–0048~~ รันครบ (0042–0048 รัน 2026-08-07)
- [x] ~~0049–0051~~ FOB/ETA to WH · VIP + ความเห็นผู้บริหาร · ระยะขนส่ง 45–60 + ความเห็นเรื่องคลัง
- [x] ~~0052–0053~~ แก้ตาม code review (import คงค่าเดิม · guard ห้ามเบิกเมื่อของยังไม่ถึงคลัง) · Plan PO receipt
- [x] ~~0054~~ Standard Price list (`std_prices` + RPC 3 ตัว) — ยืนยัน 2026-08-08
- [x] ~~0055~~ Lot No. คลังคงเหลือ — รัน 2026-08-20 (ค้างจาก push `048b35f` · **บทเรียน: commit ที่มี migration
      เปลี่ยน signature ต้องรัน SQL ก่อน push เสมอ** — รอบนั้น push ไปก่อน ปุ่ม 3 จุดเลย 404 `PGRST202` อยู่ 6 วัน)
- [?] **0060** — ⚠️ ช่องนี้ค้างไม่ได้ติ๊กมาตั้งแต่ 2026-08-25 · **ไม่ได้แปลว่ายังไม่รัน**
      งานหลังจากนี้ (0061–0074) ขึ้น production ไปหมดแล้วซึ่งแปลว่า 0060 น่าจะรันไปด้วย
      ⇒ ยืนยันด้วยคำสั่ง `m0060` ในตารางหัวข้อนี้ก่อนค่อยติ๊ก ห้ามติ๊กจากการเดา
      พิกัดจุดติดตั้งตามแผน (หมุด "ตามแผน" บนหน้า Map Tracking) — **ต้องรันก่อน push**
      · เพิ่มคอลัมน์ `jobs.plan_lat` / `plan_lng`
      · **DROP+recreate `rpc_create_job` / `rpc_update_job` (+2 args)** → เปลี่ยน API surface
        ⇒ ถ้า push frontend ก่อนรัน SQL **ปุ่มเปิด/แก้ Job จะ 404 `PGRST202` ทั้งคู่** (บทเรียน 0055)
      · + แก้บั๊กจาก 0059: guard ลด Scope ใน `rpc_update_job` นับเครื่องที่เบิกแล้วด้วย
      · ตรวจว่าลงแล้ว: `SELECT to_regprocedure('public.rpc_update_job(uuid,text,text,text,text,date,integer,numeric,jsonb,text,jsonb,numeric,numeric)') IS NOT NULL;`
      · ⚠️ ไฟล์มี DO block ตรวจผล 6 ข้อ (คอลัมน์ · signature ใหม่ · เหลือ overload เดียวต่อฟังก์ชัน ·
        guard ลด Scope ติด · `app_assert_th_coord` จับพิกัดสลับได้จริง) — ถ้า RAISE **อย่าข้าม** อ่านข้อความก่อน
- [x] ~~**0059**~~ เบิกให้ Service แบบแยกส่วน (LBS / Accessory ตาม PO) — **รันแล้ว 2026-08-23 ก่อน push**
      · เพิ่มคอลัมน์ `jobs.lbs_issued_at` + `job_accessory_requests.issued_to_service_at/by`
      · แก้ view `v_job_status` (สถานะใหม่ `partially_issued`)
      · RPC ใหม่ 2 ตัว `rpc_issue_job_lbs` / `rpc_issue_job_accessory` → **เปลี่ยน API surface**
        ⇒ ตาม §9 บทเรียน 0055 **รัน SQL ก่อน push frontend** ไม่งั้นปุ่มเบิกจะ 404 `PGRST202`
      · ตรวจว่าลงแล้ว: `SELECT to_regprocedure('public.rpc_issue_job_lbs(uuid,uuid[],date,date,text,text)') IS NOT NULL;`
      · ตรวจ view: `SELECT DISTINCT status FROM v_job_status;` (ต้องมี `partially_issued` ได้เมื่อมีงานที่เบิกบางส่วน)
      · ⚠️ ไฟล์มี **pre-check** ที่จะ RAISE ถ้า `rpc_request_approval` บน LIVE ขาด patch ของ 0031/0037/0041/0052
        — ถ้าเจอ error นี้ **อย่าข้าม** ให้ dump `pg_get_functiondef` มาดูก่อนว่าใครแก้ฟังก์ชันนอก migration
- [x] ~~0056~~ สลับ LBS พา `unit_cost` / `fob_date` / `eta_lead_days` / `plan_po_receipt_date` ไปกับคู่ Serial — รัน 2026-08-20
      (เดิม 0028/0032 สลับแค่ serial → `jobLbsCost()` คิดเงินของเครื่องที่ยังอยู่ในคลัง และ Status/ETA ผิดสลับกัน)
      ตรวจว่าลงแล้ว: `SELECT position('unit_cost = a.unit_cost' IN pg_get_functiondef('app_exec_swap_lbs(profiles,uuid,uuid,uuid,text)'::regprocedure)) > 0;`
- [ ] 🟠 **ตรวจงานที่เคยสลับ LBS ก่อน 0056** — `SELECT created_at, detail FROM audit_logs WHERE action='swap_lbs_serial' ORDER BY created_at DESC;`
      ต้นทุน/ETA ของเครื่องเหล่านั้นยังผูกผิด (0056 แก้เฉพาะการสลับ**ครั้งต่อไป** ไม่ย้อนหลัง — เดาเจตนาเดิมไม่ได้) · **รอ Division พิจารณา**
- [x] ~~0057~~ ปิดประตูเขียนตารางตรง (F1 critical) + `FOR UPDATE` ตอนรับของ (F6) — รัน 2026-08-22 แล้ว push (`10a5b04`) · **ลำดับถูก: SQL ก่อน push**
      ตรวจว่าลงแล้ว **โดยไม่ต้องเข้า SQL Editor** — ยิงด้วย anon key ก็พอ (INSERT ว่างไม่มีทางสร้างแถวได้):
      `curl -X POST "$URL/rest/v1/audit_logs" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" --data-binary '@{}'`
      → **`"permission denied for table audit_logs"` = ลงแล้ว** (ระดับ grant) · `"new row violates row-level security policy"` = **ยังไม่ลง** (ระดับ RLS)
      และต้องเช็คคู่กันว่า `GET /rest/v1/jobs?select=id&limit=1` ยังได้ `200 []` — ถ้าได้ permission denied แปลว่า revoke เกินไปโดน SELECT ด้วย ให้ rollback ทันที
      💡 SQL Editor รันทั้งสคริปต์เป็น transaction เดียว ⇒ **REVOKE ติด = DO block ตรวจผลผ่านครบ 3 ข้อ** (รวม `FOR UPDATE` ของ F6) ไม่งั้น rollback ทั้งก้อน
- [x] ~~0058~~ ปิดบัญชีแล้วอ่านข้อมูลไม่ได้ (F3 ขั้น 2) — รัน 2026-08-22 แล้ว push (`ddcbd70`)
      **รอบแรกล้ม** ที่ `pg_stat_statements_info` (ไม่ได้กรอง view ของ extension) → rollback ทั้งก้อน DB ไม่เปลี่ยนอะไร → แก้แล้วรันใหม่ผ่าน · ดู §9 ข้อ 20
      ตรวจว่าลงแล้ว **ด้วย anon key ไม่ต้องเข้า SQL Editor** — และเป็นการทดสอบช่องรั่วจริงไปในตัว:
      `curl "$URL/rest/v1/v_job_status?select=job_no&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"`
      → **`"permission denied for view v_job_status"` = ลงแล้ว** · ได้ข้อมูลกลับมา = **ยังไม่ลง และกำลังรั่วสู่อินเทอร์เน็ต**
      เช็คคู่กัน: `GET /rest/v1/jobs?select=id&limit=1` ต้องยังได้ `200 []` (grant SELECT ของตารางยังอยู่ RLS กรองออก)
      ⏳ **ยังเหลือทดสอบด้วยบัญชีจริง** — ดูรายการใน 🔴 ความปลอดภัย ด้านบน

### 🔵 Code review 2026-08-20 — รอบ 3 (#1–#4 ปิดที่ `4d11d75` · #5 ปิดที่ `54a48ed`)

รีวิวทั้งระบบเจอ 10 ข้อ · **#1 (0055 ไม่ได้รัน) #2 (การ์ด LINE reopen_job) #3 (swap ไม่พาต้นทุน) #4 (ปุ่มราคาจริงหลังเบิก) แก้แล้ว**
ที่เหลือแบ่ง 2 ก้อนตามลักษณะงาน — **3a ไม่ต้องรัน SQL เลย ทำก่อนได้**

**ก้อน 3a — ความปลอดภัย (frontend/Functions ล้วน · push ได้ทันที)**

- [x] ~~🟠 **#5 `line-webhook` ตรวจ signature แบบ fail-open**~~ — **แก้แล้ว `54a48ed` (2026-08-22)** พร้อม F4 + F9
      เดิมห่อด้วย `if (secret)` ⇒ `LINE_CHANNEL_SECRET` หายจาก env = รับ POST จากใครก็ได้ **ทั้งที่ path นั้น execute การอนุมัติจริง**
      (ยิง postback ปลอม `action=approve&req=<uuid>` + `source.userId` ของผู้อนุมัติ → `rpc_line_approve` เชื่อ `p_line_user_id` เป็นตัวตน)
      แก้: ไม่มี secret = **503 fail-closed** + เทียบ signature ด้วย `timingSafeEqual` ที่เขียนเอง (Workers ไม่มี `crypto.timingSafeEqual`)
      ⚠️ **ตรวจ env ก่อนเปลี่ยนเป็น fail-closed เสมอ** — ไม่งั้นถ้า env หายจริง LINE ตายทันทีที่ deploy
      วิธีตรวจโดยไม่ต้อง deploy อะไร (ใช้ตัวบั๊กเองเป็นเครื่องมือ · ไม่มี side effect เพราะส่ง `events: []`):
      `POST /line-webhook` + `x-line-signature` มั่ว → **403 = secret มีจริง** · 200 = fail-open ยืนยันแล้ว
      `POST /line-approval-push` ไม่มี Authorization → **401 = anon key มีจริง** · 400 = fail-open
      และยิง path ที่ไม่มีจริงเป็น control ด้วย (ได้ 405) เพื่อแยก "function ปฏิเสธ" ออกจาก "ไม่มี function"
- [ ] 🟠 **#6 `/line-notify` เป็น relay ข้อความอิสระ** — [`functions/line-notify.js:32`](functions/line-notify.js) push `message` ที่ผู้เรียกส่งมาตรงๆ
      เช็คแค่ว่า "เป็น user ที่ login" ⇒ **VIP (อ่านอย่างเดียว) / Service / session ที่หลุด ส่งข้อความอะไรก็ได้เข้ากลุ่มทีม** แยกจากข้อความระบบไม่ออก
      ต้นเหตุ: **client เป็นคนถือข้อความ** ทั้งที่ server มีอยู่แล้วใน `notifications.message`
      แก้: เปลี่ยน contract เป็น `{}` = ให้ function เรียก `rpc_claim_line_pending` เองด้วย **JWT ของผู้เรียก** (`global.headers.Authorization`)
      แล้ว push ข้อความจาก DB · `{ mode: 'test' }` = admin เท่านั้น ข้อความ fix ฝั่ง server (ให้ปุ่มทดสอบใน Dev Settings ยังใช้ได้)
      ⚠️ แก้ 3 ที่พร้อมกัน: `functions/line-notify.js` + `StoreContext.dispatchLine` (ทั้ง demo + supabase) + `DevSettingsPage` (ปุ่มทดสอบ)
      ผลพลอยได้: ตัด race ที่หลายเครื่อง claim/ส่งซ้ำ

**ก้อน 3b — Audit + Performance (ต้องรัน `0057`/`0058` ก่อน push)**

- [ ] 🟠 **#7 Audit Log เห็นได้แค่ 500 แถวล่าสุด** — [`remote.ts:264`](src/data/remote.ts) `limit: 500` + `AuditPage` filter ฝั่ง client
      ⇒ ค้น Serial/Job No. ของเดือนก่อนได้ "ไม่พบรายการ" **ทั้งที่มีใน DB** — แยกไม่ออกจาก "ไม่เคยบันทึก" · หน้านั้นเขียนว่า "trace ย้อนหลังได้ทั้งหมด" ซึ่งไม่จริง
      แก้: `0057` = `rpc_search_audit(p_q, p_actor, p_from, p_to, p_limit, p_offset)` คืน `total` ด้วย (`count(*) OVER ()`)
      \+ `CREATE EXTENSION pg_trgm` + GIN index บน `detail` (ไม่งั้น `ILIKE '%…%'` seq scan ทั้งตาราง) + index `created_at DESC`
      \+ `AuditPage` query ตรง มีปุ่ม "โหลดเพิ่ม" · `loadAll` เหลือ `limit: 50` ไว้แค่การ์ด "กิจกรรมล่าสุด" · **แก้คำโฆษณาในหน้าให้ตรงความจริง**
      ⚠️ **เพดานเงียบตัวอื่นในไฟล์เดียวกัน**: `lbs_units` 5000 · `stock_movements` 1000 · `notifications` 300
      → ใส่ guard กลางใน `q()` ให้ `console.warn` เมื่อ `data.length >= cap` (ตัดข้อมูลเงียบ = ผู้ใช้เห็นตัวเลขผิดโดยไม่รู้ตัว)
- [ ] 🟡 **#8 `rpc_confirm_install` (เก่า) ยัง grant อยู่แต่ไม่มี UI เรียก** — `ServicePage` ใช้ per-unit ทั้งหมดตั้งแต่ 0035
      เหลือไว้ = ทางลัดปิดงานโดยไม่มีหลักฐานรายเครื่อง ⇒ `jobInstallSummary` อ่านได้ 0/N · `serviceIssues()` มองไม่เห็นงาน ·
      Actual Delivery ว่างทุก Serial · ไม่ได้ตอบสรุปปัญหา (0040)
      แก้: `0058` = **REVOKE ไม่ DROP** (0031 patch ข้อความแจ้งเตือนของฟังก์ชันนี้ไว้ — เก็บ definition เป็นประวัติ)
      \+ ลบ `confirmInstall` ออกจาก `StoreActions` / `remoteActions` / `logic.ts` (dead code ที่ถือสิทธิ์อยู่คือหนี้ ไม่ใช่ทางเลือกสำรอง)
- [ ] 🟡 **#9 realtime reload ทั้ง DB ทุกครั้งที่มีคนเขียน** — [`StoreContext.tsx:546`](src/data/StoreContext.tsx) subscribe ทั้ง schema แล้วเรียก `loadAll` (25 query)
      ⇒ 1 การเขียน = 25 query เต็มชุด **× จำนวนคน online** (5 คน = 125 query) · โตตาม คน × การเขียน × จำนวนแถวรวม ไม่ใช่ตามขนาดที่เปลี่ยน
      แก้แบบลงทุนน้อยได้ผลมากก่อน: แยก HOT (`notifications` / `notification_reads` / `audit_logs` / `approval_comments`) → โหลดเฉพาะตารางนั้น
      ที่เหลือ → reload เต็มตามเดิม · **~80% ของ event คือ HOT** (ทุก RPC เขียน notifications + audit_logs เสมอ)
      การ patch state ต่อ row ค่อยทำเมื่อจำนวนเครื่องเกิน 5,000
- [ ] 🟢 **#10 Import Excel ที่ไม่มีอะไรเปลี่ยน ขึ้นว่าสำเร็จ** — [`logic.ts:390`](src/data/logic.ts) เช็คแค่ payload ว่าง
      re-import ไฟล์ที่ export มาเอง → ทุกแถว `hasAny` = false ⇒ `updatedCount`/`lockedCount` = 0 แต่ guard ไม่ยิง
      toast บอกสำเร็จ + audit เขียน "รับใหม่ 0 เครื่อง" → ผู้ใช้ไม่รู้ว่าเลือกคลัง/ไฟล์ผิด
      แก้ทั้ง `logic.ts` และ `rpc_import_units_to_stock` ให้ error บอกจำนวนแถวที่ตรงกับของเดิมทุกช่อง

### 🟣 Code review 2026-08-22 — F1–F11 (ของใหม่ นอกเหนือจาก #5–#10)

รีวิวทั้งระบบตามที่ deploy จริง: `src/` 13,089 บรรทัด · `functions/` 4 ไฟล์ · migrations 0001–0056 (RLS/RPC/trigger/grant) · git history
**ปิดไปแล้ว 6 ข้อ (F1 F2 F3 F4 F6 F9) · เหลือ 5 ข้อ** — แต่ละข้อที่ค้างมี **"เมื่อไรจะกลายเป็นต้องแก้"** กำกับไว้ เพื่อไม่ให้ต้องมานั่งเดาความเร่งด่วนใหม่ทุกรอบ

| ข้อ | เรื่อง | สถานะ |
|---|---|---|
| **F1** 🔴 | RLS `FOR ALL TO authenticated` + default grant ⇒ client เขียนตารางตรง ข้าม RPC/approval/audit/ledger | ✅ **`0057` + `10a5b04`** · ดู §9 ข้อ 18 |
| **F2** 🟠 | notifications โหลด `asc:true limit 300` = เก่าสุด 300 ⇒ กระดิ่งค้าง + **LINE หยุดส่งทั้งระบบเงียบ ๆ** | ✅ **`e996a42`** · ดู §9 ข้อ 17 |
| **F4** 🟠 | `line-approval-push` fail-open + ไม่เช็คแผนก ⇒ VIP/Service ดันการ์ดปุ่ม ✅ เข้าแชทผู้อนุมัติได้ | ✅ **`54a48ed`** (ด่าน `['project','admin']` ตรงกับ `rpc_request_approval`) |
| **F6** 🟠 | `rpc_receive_po_items` `SELECT INTO` ไม่ล็อกแถว ⇒ รับของพร้อมกัน 2 คน ยอดหายไปเงียบ ๆ | ✅ **`0057`** (`FOR UPDATE`) |
| **F9** 🟡 | `JSON.parse` ใน webhook ไม่มี try/catch ⇒ 500 → LINE retry → webhook ถูกปิด | ✅ **`54a48ed`** |
| **F3** 🔴 | ปิดบัญชีแล้วยังอ่านข้อมูลทั้งบริษัทได้ · **และ view รั่วถึง `anon` ไม่ต้อง login เลย** (พบตอนแก้) | ✅ **`b24f262` + `0058`** (2 ชั้น: ban ที่ auth + restrictive policy/view) · ⏳ **ยังต้องทดสอบด้วยบัญชีจริง** |
| **F5** 🟡 | `q()` ไม่ใส่ `.limit()` เมื่อไม่ส่ง `order` ⇒ `notification_reads` ตกไปใช้ max-rows (default 1000) · เกินแล้ว "อ่านแล้ว" กลับมาเป็นยังไม่อ่านถาวร | ⏳ **แก้เมื่อ** `SELECT count(*) FROM notification_reads;` เข้าใกล้ 1000 · ทำพร้อม **#7** เพราะรากเดียวกัน · แก้ถูกคือ `.eq('user_id', uid)` ไม่โหลดของทุกคน |
| **F7** 🟡 | `xlsx@0.18.5` ติด CVE-2023-30533 (prototype pollution ใน `XLSX.read`) + CVE-2024-22363 · ใช้อ่านไฟล์ที่ผู้ใช้อัปโหลด 3 จุด | ⏳ **แก้เมื่อ** มีเวลาเทสต์ Import ครบ 3 จุด (catalog / แผนรายเครื่อง / BOM) · คำสั่งเดียว: `npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (API เดิม · `npm audit fix` แก้ไม่ได้เพราะ npm ไม่มีเวอร์ชันที่แก้แล้ว) |
| **F8** 🟡 | `admin-users` action `create` ทิ้ง error ของ `profiles.update` + ไม่ validate `department` ⇒ สร้าง user สำเร็จแต่แผนกผิด แล้วตอบ `{ok:true}` | ⏳ **แก้เมื่อ** จะเพิ่มแผนกใหม่ (เคยเกิดจริงตอนเพิ่ม `vip` ใน 0050) · ตอนนี้ UI เป็น `<select>` ผูก type `Department` จึงส่งค่าผิดไม่ได้ในทางปฏิบัติ · **checklist เพิ่มแผนก = แก้ 3 ที่: TS type + `profiles_department_check` + `DEPT_LABEL`** |
| **F10** 🟢 | session 2 ชม. เก็บ deadline ใน localStorage + refresh token ก็อยู่ localStorage ไม่มีเพดาน ⇒ แก้ค่าเองก็ไม่ถูก logout | ⏳ **ไม่ต้องแก้โค้ด** — มันทำงานถูกสำหรับคนใช้ปกติ · ปัญหาคือ**ป้ายชื่อ**: เป็น UX convenience (auto-logout กันลืม) **ไม่ใช่มาตรการความปลอดภัย** อย่าเอาไปอ้างตอนตอบ audit · อยากได้เพดานจริงให้ตั้งที่ Supabase Auth (JWT expiry + refresh token rotation) |
| **F11** 🟢 | ไม่มี `public/_headers` ⇒ **ไม่มี CSP และ `frame-ancestors`** · token อยู่ใน localStorage ⇒ XSS ครั้งเดียวได้ session ครบ · frame แล้ว clickjack ปุ่ม ✅ / ปุ่มลบได้ | ⏳ **ทำได้แบบเสี่ยงศูนย์**: `frame-ancestors 'none'` ใส่ได้เลยไม่มีทางพัง · CSP เริ่มด้วย `Content-Security-Policy-Report-Only` ดู report 1 สัปดาห์ก่อนค่อย enforce (CSP ผิด = บล็อก Supabase/Google Fonts/รูปจาก Storage = แอปพังทั้งใบ) · **หมายเหตุ: Cloudflare ใส่ `x-content-type-options: nosniff` และ `referrer-policy` มาให้แล้ว** (ตรวจ header จริง 2026-08-22) เหลือแค่ 2 อันข้างต้น |

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

> ✅ เสร็จแล้ว (2026-08-28 — **ไม่ต้องรัน SQL**): **ยุบ "สถานะ" + "เบิกให้ Service" เหลือคอลัมน์เดียวในตาราง Purchase Orders**
> · เดิม 2 คอลัมน์นี้อ่านแล้ว**เหมือนบอกเรื่องเดียวกันซ้ำ** — "สถานะ" เล่าขั้นจัดซื้อ · "เบิกให้ Service" เล่าว่าออกหน้างานหรือยัง · ผู้ใช้ต้องประกอบเองว่าตกลงของอยู่ขั้นไหน
> · **ยุบเหลือคอลัมน์ "สถานะ" เดียวที่เดินเป็นสายได้จริง** (ตัดคอลัมน์ "เบิกให้ Service" ออก · 11 → 10 คอลัมน์):
>   ```
>   สั่งซื้อ     : รอออก PR → ส่ง PR แล้ว รอออก PO → ออก PO แล้ว รอรับของ → รับของแล้ว รอนำใช้ → เบิกให้ Service แล้ว
>   คลังคงเหลือ : เบิกคลัง รอนำใช้ → เบิกให้ Service แล้ว
>   ทางแยก      : ยกเลิก · คืนสต็อกแล้ว
>   ```
> · **ป้ายทุกตัวต้องอ่านจบในตัวเอง** — เติม "รออะไรอยู่" เข้าไปในป้าย (`ส่ง PR แล้ว รอออก PO` · `ออก PO แล้ว รอรับของ` · `รับของแล้ว รอนำใช้`) เพราะไม่มีคอลัมน์ที่ 2 มาขยายความแล้ว · **2 ขั้นที่แปลว่า "ของอยู่กับ Job พร้อมส่งออกหน้างาน" ตั้งชื่อคู่ขนานกันตั้งใจ** (`เบิกคลัง รอนำใช้` / `รับของแล้ว รอนำใช้`) — คนกวาดตาเห็นคำว่า "รอนำใช้" ก็รู้ทันทีว่าเบิกให้ Service ได้แล้ว ไม่ต้องดูว่าของมาจากทางไหน
> · **สี 3 ความหมาย**: amber = ยังรออยู่ในสายจัดซื้อ · green = ของอยู่กับ Job พร้อมส่งออก · blue = ออกไปหน้างานแล้ว · neutral = ยกเลิก/คืนคลัง
> · **บรรทัดรองใต้ป้ายเหลือเฉพาะข้อมูลที่ป้ายบอกไม่ได้** (`accBlockNeedsDetail`) — วันที่เบิก · และเหตุผลที่ยังเบิกไม่ได้**ซึ่งไม่ตรงกับขั้นของตัวเอง** เช่น *"รับของแล้ว รอนำใช้"* + *"⏳ PO-2026-0001 ยังรับของไม่ครบ"* (บรรทัดนี้ครบแต่ PO ทั้งใบยังไม่ครบ จึงยังเบิกไม่ได้ — ถ้าไม่บอกตรงนี้จะงงว่าทำไมติ๊กใน popup ไม่ได้) · ขั้น `pending`/`pr_sent`/`po_ordered` **ไม่ย้ำ** เพราะป้ายพูดตรงกันเป๊ะอยู่แล้ว
> · Ready/Not Ready รายรายการยังอยู่ครบใน **popup ตอนกดเบิก** ซึ่งเป็นที่ที่ต้องตัดสินใจจริง — ตารางมีหน้าที่เล่าสถานะ ไม่ใช่ที่ตัดสินใจ
> · ⚠️ ตาราง **"วัสดุตาม Job (Ref.PO)" ที่หน้า Project Stock ยังมีคอลัมน์ "เบิกให้ Service" อยู่** — ที่นั่นไม่มีคอลัมน์ "สถานะ" ให้ยุบเข้าไป คอลัมน์นั้นจึงเป็นตัวเดียวที่บอกสถานะ ถ้าตัดออกข้อมูลจะหายทั้งหมด
>
> ✅ เสร็จแล้ว (2026-08-27 — **ไม่ต้องรัน SQL**): **ป้ายสถานะวัสดุเล่า "ของอยู่ที่ไหนตอนนี้" + เก็บกวาดหน้า Project Stock**
> · **Project Stock** — เอาบรรทัดบอกทาง "ความเห็นผู้บริหารย้ายไป Dashboard" ออก (ย้ายไปตั้งแต่ `c62f04b` ผู้ใช้เห็นแล้ว ป้ายบอกทางหมดหน้าที่)
> · **ป้ายสถานะวัสดุจากคลังคงเหลือ** `ACC_STATUS_LABEL.issued` เปลี่ยน "เบิกจากคลังสินค้าแล้ว" → **"เบิกคลัง รอนำใช้"** · ค่านี้เกิดกับ line ที่ `source = 'central_stock'` เท่านั้น (ฝั่งสั่งซื้อเดิน pending → pr_sent → po_ordered → received ไม่แตะ) และป้ายใช้แค่ 2 ที่คือตาราง Purchase Orders ในหน้า Job กับไฟล์ Excel ที่ export จากหน้าเดียวกัน → เปลี่ยนได้ตรง ๆ ไม่กระทบสายจัดซื้อ
> · **⚠️ ปัญหาที่เจอต่อจากนั้น (มติแบบ B)**: `AccReqStatus` **ไม่ขยับ**ตอนเบิกให้ Service เพราะ 0059 ใช้ฟิลด์ `issuedToServiceAt` แยกอีกตัว ⇒ ป้ายค้างที่ "เบิกคลัง รอนำใช้" ทั้งที่ของไปหน้างานแล้ว **ขัดกับคอลัมน์ "เบิกให้ Service" ที่อยู่ถัดไปในตารางเดียวกัน** (เห็นจริงบนจอ: "เบิกคลัง รอนำใช้" อยู่ข้าง "✅ เบิกแล้ว 27 ส.ค. 2569") · คนอ่านตารางเร็ว ๆ ดูคอลัมน์สถานะก่อน จะเข้าใจผิดว่าของยังอยู่ในมือ Project
> · **แก้ด้วย `accStatusLabel()` + `accStatusBadge()` ใน `format.ts`** — คอลัมน์สถานะตอบคำถาม **"ของอยู่ที่ไหนตอนนี้"** ไม่ใช่ "ของมาจากไหน": เบิกให้ Service แล้ว → **"ส่งให้ Service แล้ว"** (ป้ายฟ้า) · ยังอยู่กับ Job → ป้ายเดิมตาม status (เขียว) · ยกเลิก/คืนคลัง → status เป็นคำตอบสุดท้าย ธงเบิกไม่ทับ (เทา) · **ใช้กับของที่ซื้อผ่าน PO ด้วย** เพราะ "รับของแล้ว" ข้าง "✅ เบิกแล้ว" ขัดกันแบบเดียวกัน · ล็อกกฎด้วย 5 เคสใน `logic.test.ts`
>
> ✅ เสร็จแล้ว (2026-08-23 · รอบ 3 — **0060**): **Export วัสดุตาม Job · หมุด "ตามแผน" บนแผนที่ · แยก chunk หน้าแผนที่**
> · **Export Excel แท็บวัสดุตาม Job (Ref.PO)** — สเปกคอลัมน์รวมศูนย์ `MAT_COLS` (12 คอลัมน์ + ชีต "คำอธิบาย" + autofilter แนวเดียวกับ `SHEET_COLS`/`PR_COLS`) · **export ตามที่กรองอยู่บนจอ** ไม่ใช่ทั้งหมดเสมอ (คนตรวจกรองเฉพาะงานที่สนใจแล้วส่งไฟล์ต่อ — ถ้า export ทั้งหมดเขาต้องไปลบแถวเองใน Excel ซึ่งเป็นจุดที่ตัวเลขเริ่มเพี้ยน) · ปุ่มโชว์จำนวนที่จะออกเมื่อมีตัวกรอง + ชีตคำอธิบายเตือนว่าไฟล์นี้ถูกกรอง · **ไม่มี import กลับ** (เป็นรายงาน ไม่ใช่แบบฟอร์ม)
> · **หมุด "ตามแผน" บนหน้า Map Tracking (0060)** — พิกัดจุดติดตั้งที่กรอกตอนเปิด Job · หมุดโปร่งเส้นประแยกจากของจริงด้วยตาเปล่า · เปิด/ปิดชั้นได้ · tooltip บอก `JOB-xxxx · จุดที่ n (ตามแผน)` · popup บอกสถานะงานปัจจุบัน + กำหนดส่ง · ตารางคู่แผนที่แยกแถวตามแผน/ของจริง · **ช่องกรอกพิกัดช่องเดียวรับ "lat, lng"** (`CoordInput`) วางจาก Google Maps ได้ตรง ๆ + ตรวจสดพร้อมบอกเคสสลับ lat/lng · แผงจุดติดตั้งในหน้า Job เพิ่มคอลัมน์ **พิกัดตามแผน** กดเปิด Google Maps ตรวจได้
> · **แยก chunk หน้าแผนที่** (`React.lazy`) — main chunk **934 → 785 kB** (gzip 266 → 222) · leaflet 161 kB ไปอยู่ chunk ของตัวเอง โหลดเฉพาะตอนเข้าหน้า `/map` · **แก้ความเข้าใจผิดของผมเอง**: `xlsx` (429 kB) **แยก chunk อยู่แล้ว**ตั้งแต่ก่อนหน้านี้ผ่าน `await import('xlsx')` ตอนกดปุ่ม — ไม่ได้ถูกโหลดทุกครั้งอย่างที่ผมเคยรายงานไว้ · `Suspense` fallback มีข้อความ ไม่ใช่จอขาว (เน็ตช้าแล้ว chunk มาช้า คนจะคิดว่าแอปค้าง)
> · **🐛 แก้บั๊กจาก 0059 ฝั่ง SQL** — `rpc_update_job` นับ LBS ที่ถืออยู่จาก `allocated` เท่านั้น ⇒ ลด Scope ต่ำกว่าจำนวนเครื่องที่เบิกไปมือ Service แล้วได้ (demo แก้ไปตอน 0059 ฝั่ง SQL ค้างอยู่)
>
> ✅ เสร็จแล้ว (2026-08-23 · รอบ 2 — **ไม่ต้องรัน SQL**): **แผนที่เต็มจอ · แท็บย่อยหน้า Project Stock · ย้ายความเห็นผู้บริหารไป Dashboard**
> · **Map Tracking — ปุ่ม ⛶ ขยายเต็มจอ** (ออกด้วย Esc หรือปุ่ม ✕) · ⚠️ **ต้องเรียก `map.invalidateSize()` ทุกครั้งที่ย่อ/ขยาย** — Leaflet คำนวณ tile จากขนาดกล่องตอน init ถ้าเปลี่ยนขนาดด้วย CSS แล้วไม่บอกมัน จะได้แผนที่เทาครึ่งจอ (บั๊กคลาสสิก) และต้อง **หน่วง ~1 เฟรม** ให้ browser คำนวณ layout เสร็จก่อน ไม่งั้นมันอ่านขนาดเก่าไปอีก · โหมดเต็มจอ **ล็อก `body.overflow`** ด้วย ไม่ใช่แค่กันจอเลื่อนตอนลากแผนที่ แต่ตัด scrollbar ที่กินขอบขวาไป ~15px ทำให้กล่องไม่เต็มจอจริง · **z-index 45** — เหนือ sidebar (5) และ mobile header (40) แต่ต่ำกว่า modal (50) และ toast (99) เพื่อให้ข้อความแจ้งผลยังเห็นได้ตอนแผนที่กางอยู่ · ทำด้วย CSS class ไม่ใช้ Fullscreen API เพราะ iOS Safari ไม่รองรับกับ element ที่ไม่ใช่ video และจะซ่อนช่องค้นหา/ตัวกรองของเราไปด้วย
> · **Project Stock แยกเป็น 2 แท็บย่อย** (`คลัง LBS` · `วัสดุตาม Job (Ref.PO)`) — เดิมเป็นแผงต่อท้ายกัน ต้องเลื่อนผ่านทุกคลัง (แต่ละคลัง 30–40 เครื่อง) กว่าจะถึงตารางวัสดุ · **ไม่ทำเป็น route แยก** เพราะยังเป็นข้อมูลคลังชุดเดียวกัน และจะเสีย bookmark `/stocks` เดิม
> · **วัสดุตาม Job จัดกลุ่ม 2 ชั้น Job No. → PO** พับได้ **เริ่มต้นพับทุกกลุ่ม** + ปุ่มกาง/พับทั้งหมด + ช่องค้นหา (Job No./PO No./Epicor/ชื่ออุปกรณ์/ซัพพลายเออร์) · หัวกลุ่มสรุป **n PO · n รายการ · มูลค่ารวม** ให้ตรวจปริมาณได้ก่อนกาง · ในตารางเพิ่มคอลัมน์ **"เบิกให้ Service"** (ต่อจาก 0059) · เกณฑ์: Job เป็นชั้นนอกเพราะคนตรวจถามเป็นราย Job ("งานนี้ได้ของครบยัง") ไม่ใช่ราย PO
> · **🐛 แก้บั๊กจับคู่ line กับ PO** — เดิม `receivedLines` กรอง `r.prId === po.prId` แต่ตั้งแต่ **0022 ที่ 1 PR ออกได้หลาย PO** บรรทัดของ PO ใบหนึ่งจะไปโผล่ใต้ PO ใบอื่นที่มาจาก PR เดียวกันด้วย ⇒ **รายการซ้ำและมูลค่าเกินจริง** → เปลี่ยนเป็นจับด้วย `poId` (fallback `prId` เฉพาะข้อมูลเก่าก่อน 0022 ที่ยังไม่มี `poId`)
> · **💬 ความเห็นผู้บริหาร (VIP) ย้ายจากท้ายหน้า Project Stock → Dashboard** วางใต้ Job List เหนือ Transaction ล่าสุด (Audit) · เหตุผล: เป็นข้อสังเกต/ข้อสั่งการ **ภาพรวม** ที่ทุกแผนกควรเห็น แต่เดิมซ่อนท้ายหน้าคลังซึ่งมีแต่ Division เข้าบ่อย · ลำดับ: เห็นสถานะงานก่อน → อ่านความเห็น → Audit (หลักฐานย้อนหลัง ไม่ต้องอ่านทุกวัน) · **⚠️ scope ใน DB ยังเป็น `'stock'` ตาม 0051 ไม่ rename** เพราะต้อง migration แลกกับประโยชน์ศูนย์ — เป็น thread เดียวกัน ความเห็นเก่าอยู่ครบ · ทิ้งบรรทัดบอกทางไว้ที่แท็บคลัง LBS ให้คนที่เคยหาที่เดิม · ตรวจแล้วว่า**ไม่กลับไปเป็นบั๊ก §9.14** (textarea เสีย focus ทุกตัวอักษร) — JSX inline ในหน้า ไม่ได้ประกาศ component ใหม่ตอน render
>
> ✅ เสร็จแล้ว (2026-08-23 — 0059): **เบิกให้ Service แบบแยกส่วน + Map Tracking + ย้าย Notifications/Audit ไปมุมขวาบน**
> · **Project ID (Jobs) — เบิกแยก LBS / Accessory ตาม PO** ปุ่มเดียวเปิด **popup ถามก่อน** ว่ารอบนี้จะส่งอะไรให้ Service · LBS ติ๊กรายเครื่อง (Ready = ETA ผ่านแล้ว) · Accessory จัดกลุ่ม**ตาม PO** ติ๊กทั้งใบหรือรายบรรทัด · **PO ที่ "รอรับของ" ติ๊กไม่ได้ + บอกเหตุผลข้างรายการ** · สถานะใหม่ **Partially Issued** · ครบทั้งใบระบบปิดเป็น Issued เอง · ตาราง LBS และตารางวัสดุมีคอลัมน์ **"เบิกให้ Service"** บอก Ready/Not Ready/เบิกแล้ว รายบรรทัด · แผงสรุปด้านบนบอกว่าอะไรออกไปแล้ว อะไรค้าง
> · **สิทธิ์**: LBS ผ่าน Division ตามเดิม (คำขอเปลี่ยนความหมายเป็น "เบิก LBS") · **Accessory ที่รับของแล้ว Project กดเบิกเองได้** ไม่ต้องรออนุมัติ (ลง audit ทุกครั้ง)
> · **ล็อกเฉพาะของที่ออกไปแล้ว** — เครื่องที่เบิกไปคืน/สลับไม่ได้ · ที่เหลือยังจัดการได้ · **ยกเลิก Job ไม่ได้เมื่อของอยู่ในมือ Service** · **Service ยืนยันติดตั้งได้เมื่อเบิกครบทั้งใบ** (กันทีมออกไซต์แล้วขาดของ — เขียนบอกไว้บนแผงสรุป)
> · **เมนู Map Tracking — ประเทศไทย** (Leaflet + OpenStreetMap ไม่ต้องมี API key) หมุดมาจาก **Check-in ราย Serial** ตอนยืนยันติดตั้ง · **ชี้ที่หมุดเห็น Job No.** คลิกเห็น Serial/ช่าง/รูป · หมุดพิกัดเดียวกันรวมเป็นหมุดเดียวพร้อมตัวเลข · ชั้น "เช็คอินระดับงาน" เปิด/ปิดได้ (งานเก่าก่อน 0035 มีแต่พิกัดระดับงาน) · กรองด้วย Job No./Serial/ลูกค้า + เฉพาะที่ติดตั้งไม่ได้ · มีตารางคู่แผนที่ · seed demo เพิ่ม 1 เช็คอินให้แผนที่ไม่ว่างเปล่า
> · **Job List รีเช็คแล้ว** — `jobAllocatedQty` นับ allocated+issued (เลิก workaround ที่หน้า Jobs/Dashboard ที่แยกเคสตามสถานะเอง) · ตัวกรองสถานะมี Partially Issued · การ์ด Jobs In Progress โชว์จำนวนงานที่เบิกบางส่วน
> · **Material Database — ตอบคำถามจังหวะตัดยอด**: ยอดคลังตัดตอน **"ดึง"** ทันที (`addAccessoryRequest` source=central_stock → `applyStockMovement` type `issue_to_job` ในคำสั่งเดียว) · ขั้น "เบิกให้ Service" **ไม่แตะยอดคลังเลย** · คงพฤติกรรมเดิม (ตรงกับของจริงและ ledger) **แก้แต่ถ้อยคำ** — เขียนบอกที่หัวแผงคลังคงเหลือ + ในโมดัลเพิ่มวัสดุ
> · **แก้บั๊กที่เจอระหว่างทาง**: `remote.ts` ไม่ map `qty_transferred` (ตกมาตั้งแต่ 0038) ⇒ โหมด LIVE คิด `effectiveQty` เกินจริงทุกที่ที่มีการโอนวัสดุคืนคลัง
>
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
npm test          # vitest run — 46 เคสบนสูตรเงิน/สถานะ (ใหม่ 2026-08-22)
npm run test:watch
```

- ทดสอบโหมด LIVE ในเครื่อง: `copy .env.example .env` แล้วกรอก VITE_SUPABASE_URL/ANON_KEY (ทดสอบ Pages Functions: `npm run build` แล้ว `npx wrangler pages dev dist`)
- **Deploy**: `git push origin main` → Cloudflare Pages auto-deploy (~1-2 นาที)
- Business logic แก้ 2 ที่ให้ตรงกันเสมอ: `src/data/logic.ts` (demo) + `supabase/migrations/0002_rpc.sql` (LIVE)

### 11.1 เทสต์ (`src/data/logic.test.ts` — ชุดแรกของโปรเจกต์ 2026-08-22)

**`npm test` ต้องเขียวก่อน commit ทุกครั้ง** — **175 เคส** (`logic.test.ts` 162 + `xlsxReport.test.ts` 13)
รัน ~3 วินาที ไม่ต้องต่อ DB ไม่ต้อง mock · อัปเดตเมื่อ 2026-09-17 (0074)

เลือกเทสต์เฉพาะ **"กฎที่เคยพังจริง"** ไม่ใช่ไล่ให้ครบทุกฟังก์ชัน · ทุก `describe` อ้างถึงบั๊กที่เป็นต้นเรื่อง:

| เทสต์ | ล็อกกฎอะไร | ที่มา |
|---|---|---|
| `poCostSummary` | `ordered` ใช้ `qtyRequested` · `charged` ใช้ `effectiveQty` และ **ต้องต่างกัน** เมื่อมีการโอนคืนคลัง (ไม่ยุบให้เท่ากัน) | §9 ข้อ 13 — เคยต่าง 240,000 ฿ ใต้ป้ายเดียวกัน |
| `deriveJobStatus` | เครื่อง `issued` **ยังนับว่าอยู่บน Job** · เบิกออกไปบางส่วน = `partially_issued` ไม่ใช่ `draft` | §9 ข้อ 7 (บอทรายงาน `LBS: 0/N`) → แก้ทิศใน 0059 |
| `accIssueBlockReason` | **PO ที่ยัง "รอรับของ" เบิกไม่ได้ทั้งใบ** แม้บรรทัดนั้นรับของครบแล้ว · โอนคืนคลังหมด = ไม่ค้างขวางการปิดใบ | 0059 ข้อ 3 ของโจทย์ |
| `unitIssueBlockReason` | ETA ยังไม่ถึง = เบิกไม่ได้ · **ไม่ระบุ ETA ('?') ไม่บล็อก** · เบิกแล้วเบิกซ้ำไม่ได้ | 0052 + 0059 |
| `jobIssuePlan` | จัดกลุ่มวัสดุตาม PO ถูกใบ · แยก Ready/Not Ready ครบ · `lbsShort` บอกจำนวนที่ยังดึงไม่ครบ Scope | 0059 |
| `issueJobLbs` / `issueJobAccessory` | เดินสถานะจนครบแล้ว **ปิดใบเป็น `issued` เอง** · ยกเลิก Job ไม่ได้เมื่อของออกไปแล้ว · ไม่มีนัดติดตั้งต้องเตือน | 0059 |
| `parseLatLng` | รับรูปแบบที่คัดลอกจาก Google Maps ทุกแบบ · **พิกัดสลับต้องบอกค่าที่ถูก** ไม่ใช่แค่ "ค่าไม่ถูก" · ว่าง = `null` ไม่ใช่ error | 0060 |
| `createJob` / `updateJob` (พิกัด) | พิกัดครึ่งคู่ = ไม่เก็บทั้งคู่ · นอกกรอบไทย = **ปฏิเสธตอนบันทึก** ไม่ใช่ปล่อยผ่านแล้วหายบนแผนที่ · ลด Scope ต่ำกว่าเครื่องที่เบิกแล้วไม่ได้ | 0060 |
| `accStatusLabel` / `accStatusBadge` / `accBlockNeedsDetail` | คอลัมน์ "สถานะ" คอลัมน์เดียวเล่าทั้งสาย — ทุก `AccReqStatus` มีป้ายและป้ายไม่ซ้ำกัน · ธง `issuedToServiceAt` ชนะ status เสมอ (ยกเว้นยกเลิก/คืนคลัง) · ขั้นที่ป้ายบอกเหตุผลอยู่ในตัวแล้วห้ามย้ำซ้ำ | เจอบนจอ 2026-08-27 |
| `unitEta` | ไม่มีทั้ง FOB และ planPoReceipt = **`undefined`** ไม่ใช่ "ของถึงแล้ว" | 0049 → มติ 2026-08-08 |
| `normalizeLeadDays` | กรอก 60 ต้องคืน 60 **ไม่ใช่** `undefined` (ยุบตรงนี้ = import รีเซ็ตค่ามาตรฐานไม่ได้) | 0052 |
| `jobLbsCost` / `jobBudgetSummary` | raw_mat actual = ค่าวัสดุ + ต้นทุน LBS · `materialValue` **ไม่รวม** LBS | 0021/0024 |
| `jobDueDate` | หลายจุดติดตั้งใช้กำหนดที่ใกล้ที่สุด · ไม่ระบุ = `undefined` ไปท้ายรายการ | 0026 |

⚠️ **ชุดนี้พิสูจน์ได้แค่ว่า demo mode ถูก — ยังไม่ได้พิสูจน์ว่า SQL ฝั่ง LIVE ตรงกัน**
ตัวที่พิสูจน์เรื่องนั้นคือ **parity suite** (ขั้น 3 ในแผน §10 🟢) ที่รัน scenario ชุดเดียวกัน
ผ่านทั้ง `logic.ts` และ RPC จริงบน Postgres ชั่วคราว แล้ว diff ผลลัพธ์
· เขียนเตือนไว้ในหัวไฟล์เทสต์แล้วเพื่อไม่ให้ใครเข้าใจผิดว่า "มีเทสต์แล้วปลอดภัย"

**กติกาเวลาเพิ่มเทสต์**: เขียนเมื่อ**เจอบั๊กจริง** แล้วล็อกกฎนั้นไว้ พร้อมอ้าง §9 ข้อที่เป็นต้นเรื่อง
ในคอมเมนต์ — ไม่ใช่เขียนเพื่อไล่ coverage · และ **ตรวจว่าเทสต์จับได้จริงด้วย mutation check**
(ใส่บั๊กกลับเข้าไปแล้วดูว่ามันร้องไหม) เพราะเทสต์ที่เขียวแต่ไม่เคยแดงคือเทสต์ที่ไม่ทำงาน

## 12. Gotchas / ข้อควรระวัง


- 🔴 **ปุ่มที่กดไม่ได้ ห้าม "หายไปเฉย ๆ" — ต้องโชว์แบบปิดพร้อมเหตุผล** (2026-09-18)
  ผู้ใช้รายงานว่า "102LB10J3076 ไม่มีปุ่มแก้ไขงบประมาณ" · ของจริงคือปุ่มถูกซ่อนตามกติกา 0023
  (ใบที่เบิกแล้ว = งบแก้ได้เฉพาะ Manage) แต่**ไม่มีอะไรบนจอบอกเลย** ⇒ คนใช้อ่านว่า "ระบบเสีย"
  แล้วเสียเวลาไล่หาว่าปุ่มหายตอนไหน · ตรวจแล้วพบว่ากติกานั้นเองก็ผิด จึงแก้ทั้ง 2 ชั้น (ดู 0077)
  **กติกาที่ใช้ต่อไป** — ปุ่มที่คนกลุ่มนั้น "ควรจะมี" แต่ตอนนี้กดไม่ได้:
  แสดงเป็นปุ่ม `disabled` + `title` + **ข้อความในพาเนลด้วย** (มือถือไม่มี hover ให้เห็น tooltip)
  · เกณฑ์ว่าใครควรเห็น = ดูที่ **ตำแหน่งงาน** ไม่ใช่สถานะของใบ (เช่นงบประมาณ → Project/Manage เห็นปุ่ม
    แม้ใบจะล็อก · Purchasing/Service ไม่ต้องเห็นเลย เพราะไม่ใช่งานของเขาตั้งแต่ต้น)
  · เขียนเหตุผลให้บอก **ใครทำได้แทน** หรือ **ต้องทำอะไรก่อน** เสมอ ไม่ใช่แค่ "ไม่มีสิทธิ์"
  แบบเดียวกับที่ทำไว้แล้วใน `closeBlockedReason` (ปิดงานติดตั้ง) และแบนเนอร์ `readOnlyJob` (0042)

- 🔴 **สถานะกำหนดส่งมี "3 นาฬิกา" ที่ห้ามสับสนกัน — ทุกป้ายต้องมาจาก `jobDelivery()` ที่เดียว** (0075)
  | นาฬิกา | คืออะไร | ใครเลื่อนได้ | ฟิลด์ |
  |---|---|---|---|
  | **กำหนดส่ง** | ข้อผูกพันกับลูกค้า | Project ผ่าน `extendJobDue` (บังคับเหตุผล) | `required_date` + `job_due_extensions` |
  | **นัดติดตั้ง** | ช่วงที่ทีมช่างออกไซต์ | Service ผ่าน `logSiteVisit` (rescheduled) | `install_start_date` / `install_end_date` |
  | **ผลติดตั้งจริง** | หลักฐานรายเครื่อง | Service ยืนยัน/แจ้งติดปัญหา | `unit_installations` |
  ⚠️ **ห้ามใช้คำว่า "แผน" ลอย ๆ ในป้ายสถานะเด็ดขาด** — มันชี้ได้ทั้งกำหนดส่งและนัดติดตั้ง
  ทุกป้ายที่บอกว่าช้าต้องเขียนเต็มว่า **"เลยกำหนดส่ง N วัน"** หรือ **"เลยวันนัดติดตั้ง N วัน"**

  **บั๊ก 2 รอบที่ผู้ใช้จับได้เอง — เทสต์ล็อกไว้แล้วใน `logic.test.ts` ห้ามถอย:**
  1. *(รอบแรก)* ทุกหน้าตัดสินด้วย `daysLeft < 0` อย่างเดียว ⇒ งานที่ช่างกำลังติดตั้งอยู่หน้างาน
     ขึ้นแดง "เลยกำหนด" เหมือนงานที่ไม่มีใครแตะ · พอทุกอย่างแดงหมด คนอ่านก็เลิกมองสีแดง
  2. *(รอบสอง — บั๊กของโมเดลที่แก้รอบแรกเอง)* เอา **"ของออกจากคลังแล้ว" ไปแปลว่า "กำลังติดตั้ง"**
     ⇒ ใบที่นัดติดตั้ง 25 ก.ย. แต่วันนี้ 17 ก.ย. (ยังไม่มีใครไปไซต์) ขึ้นว่ากำลังติดตั้ง ·
     และใบที่อยู่ในช่วงนัด 14–18 ก.ย. ขึ้นว่า "เลยแผน 2 วัน" ซึ่งขัดกับวันนัดที่โชว์อยู่ข้าง ๆ

  **ลำดับตัดสินของ `DeliveryState`** (บนสุดชนะ — เรียงตาม "สิ่งที่ต้องลงมือก่อน" ไม่ใช่ความรุนแรงของวันที่):
  `closed` → `blocked` → `awaiting_close` → [`visit_overdue` → `installing` → `awaiting_visit`]
  → `overdue` → `due_soon` → `on_track` → `no_due`
  · 🔴 **`overdue` (แดง "เลยกำหนดส่ง") เกิดได้เฉพาะตอนของยังไม่ออกจากคลัง** — ของออกไปแล้วให้ใช้
    สถานะฝั่งหน้างาน แล้วเติมคำนำหน้า `เลยกำหนดส่ง N วัน · ` แทน (โทนขยับเป็นส้ม/แดงตามสถานการณ์)
  · `awaiting_visit` = เบิกของแล้วแต่ยังไม่ถึงวันนัด — **ไม่ใช่** กำลังติดตั้ง
  · `installing` = อยู่ในช่วงนัด **หรือ** มีผลยืนยันรายเครื่องแล้ว (ของจริงชนะวันนัดบนกระดาษ)
  · `visit_overdue` = เลยวันนัดสุดท้ายแล้วยังไม่ได้ข้อสรุป ⇒ `atRisk` เสมอ แม้กำหนดส่งยังไม่ถึง
    (มีคนต้องตอบว่าเกิดอะไรขึ้นหน้างาน — ยืนยันผล เลื่อนนัด หรือแจ้งติดปัญหา)
  · `blocked` มาก่อนทุกเรื่องวันที่ · `awaiting_close` มาก่อนเรื่องวันที่ (เหลือแค่กดปิด)
  · ตัวนับ "ต้องเร่ง" ทุกหน้าใช้ `d.atRisk` · "เลยกำหนดส่งแต่งานเดินอยู่" ใช้ `d.isLate && !d.atRisk`
    **ห้ามนับ `daysLeft < 0` เอง** และป้ายบนจอต้องมาจาก `<DeliveryBadge d={...} />` ตัวเดียวเท่านั้น
  · 🔴 **ยอดสรุปรวม (ต่อคน/ต่อกลุ่ม) ต้อง derive จาก `state` เดียวกับป้ายในตาราง** (ผู้ใช้จับได้ 2026-09-22)
    บรรทัดชื่อช่างเคยเขียนว่า "1 งานรอติดตั้ง" ทั้งที่ป้ายของใบนั้นเขียนว่า "ติดตั้งครบ รอปิดงาน"
    — ตัวเลขถูก แต่คำผิด เพราะ `memberSchedule.active` คือ "งานที่ของออกไปแล้วและยังไม่ปิด"
    ไม่ใช่ "งานรอติดตั้ง" · ตอนนี้แยกเป็น `pendingInstall` / `awaitingClose` / `blockedJobs`
    ที่นับจาก `jobDelivery().state` ตรง ๆ + เทสต์บังคับว่า 3 ก้อนรวมกัน = `active.length` เสมอ
  · 🔴 **"เลยกำหนดส่ง" ต้องหยุดนับเมื่อส่งมอบเสร็จ** (ผู้ใช้ทัก 2026-09-21) — `daysLate` วัดกับ
    `deliveredDate` (วันที่เครื่องสุดท้ายได้ข้อสรุป) ไม่ใช่ `today` เมื่องานส่งครบแล้ว
    เดิมวัดกับ today เสมอ ⇒ ใบที่ติดตั้งเสร็จ **ทันกำหนด** แต่ค้างกดปิดงาน 3 วัน ขึ้นว่า
    "เลยกำหนดส่ง 3 วัน" (ผิดข้อเท็จจริง) และใบที่ช้าจริงก็เดินเพิ่มวันละ 1 ทั้งที่ของส่งไปแล้ว
    — ตัวเลขนี้ใช้อ้างค่าปรับได้ จึงต้อง freeze · ใช้ **วันที่ติดตั้งจริง** ไม่ใช่วันที่กดปิดงาน
    (งานเอกสารช้ากว่าของจริงได้เป็นสัปดาห์) · เครื่องที่สรุปว่า blocked นับเป็น "ได้ข้อสรุป" ด้วย
  · **กาลของคำต้องตรงกับสถานะ**: ยังส่งไม่เสร็จ = `เลยกำหนดส่ง N วัน` (ปัจจุบันกาล · นำหน้า
    เพราะเป็นเรื่องที่ค้างอยู่) · ส่งเสร็จแล้ว = `ส่งช้ากว่ากำหนด N วัน` / `ส่งทันกำหนด`
    (อดีตกาล · **ต่อท้าย** เพราะสิ่งที่ค้างจริงคือการกดปิดงาน ไม่ใช่การส่งของ)
  ⚠️ ทุกตารางที่โชว์ป้ายนี้ **ต้องโชว์ "นัดติดตั้ง" กำกับด้วย** — ไม่งั้นผู้บริหารอ่าน "เลยกำหนดส่ง 54 วัน"
  แล้วนึกว่าไม่มีใครทำอะไรเลย ทั้งที่ทีมอยู่หน้างานตามนัดที่ตกลงกันไว้
  ⚠️ `jobs.required_date` ห้ามเขียนทับเวลาขยายกำหนด — เป็นกำหนดตามสัญญาที่ใช้เทียบว่าเลื่อนรวมกี่วัน
  ทุกจุดที่โชว์กำหนดใหม่ต้องมี "เลื่อนจาก &lt;วันเดิม&gt;" กำกับ รวมถึง Excel และข้อความที่บอทตอบใน LINE
- 🔴 **Storage bucket มี 2 แบบ อย่าลอกของเดิมมาใช้โดยไม่ดูว่าไฟล์คืออะไร** (0074)
  `install-photos` (0019) ตั้ง `public = true` + policy `TO public` — เหมาะกับรูปติดตั้งที่
  ส่งต่อให้ลูกค้าดูอยู่แล้ว · แต่ **เอกสารสัญญา/ใบส่งของเป็นข้อมูลเชิงพาณิชย์ + PDPA**
  จึงใช้ `unit-docs` แบบ `public = false` + policy `TO authenticated` และ **DB เก็บ `file_path`
  ไม่ใช่ URL** — ฝั่ง client ขอ signed URL (อายุ 5 นาที) ทุกครั้งที่จะเปิด
  ⚠️ **ตั้ง bucket เป็น private อย่างเดียวไม่พอ** ถ้า policy ยังเป็น `TO public` ก็ทะลุอยู่ดี
  ต้องแก้ทั้งคู่ · 0074 มี DO block ตรวจทั้ง `storage.buckets.public = false`
  และว่าไม่มี `public`/`anon` ใน `pg_policies.roles` ของ policy อ่าน
  ⚠️ URL ของ Supabase Storage **เดาได้จาก path** — public bucket = เปิดสาธารณะจริง ๆ
  ไม่ใช่ "ลับเพราะไม่มีใครรู้ URL"
- 🔴 **`<input accept="...">` ไม่ใช่การป้องกัน** (0074) เป็นแค่ตัวกรองในหน้าต่างเลือกไฟล์ —
  ลากไฟล์ใส่ หรือยิง RPC ตรง ก็ผ่านหมด ⇒ กติกาชนิด/ขนาดไฟล์ต้องอยู่ที่ **RPC + `logic.ts`**
  และมี **CHECK ใน DB** เป็นชั้นสุดท้าย (กันคนเขียนสคริปต์ยิงเอง)
- 🔴 **โหมด demo เก็บไฟล์เป็น data URL ใน `localStorage` ซึ่งมีโควตา ~5–10MB ทั้งแอป** (0074)
  PDF ใบเดียวก็กินหมดได้ แล้วแอปเขียน `localStorage` ไม่ได้ = พังทั้งตัว ไม่ใช่แค่ฟีเจอร์ไฟล์
  ⇒ เพดานขนาดต้องแยกคนละค่ากับ LIVE (`DEMO_MAX_UNIT_FILE_MB` 1 vs `MAX_UNIT_FILE_MB` 10)
  และต้องเขียนเหตุผลไว้บนหน้าจอ ไม่งั้นคนเทสต์จะสรุปว่าระบบจริงก็จำกัดแค่นี้
- 🔴 **`has_table_privilege('anon', ...)` วัดความปลอดภัยของโปรเจกต์นี้ไม่ได้ — ต้องดู RLS**
  Supabase แจก `SELECT` บนสคีมา `public` ให้ `anon`/`authenticated` เป็น**ค่า default ของโปรเจกต์**
  (0057 ถอนไปแค่ `INSERT/UPDATE/DELETE` — ดู rollback note ในไฟล์นั้น) ⇒ `has_table_privilege` คืน
  `true` เสมอ ทั้งที่ `anon` อ่านได้ **0 แถว** เพราะทุกตารางเปิด RLS และทุก policy เป็น `TO authenticated`
  ⚠️ เขียน DO block ตรวจความปลอดภัยให้วัดที่ **`pg_class.relrowsecurity` + ไม่มี policy ที่ roles มี `anon`**
  ไม่ใช่ชั้น GRANT · (0069 รอบแรกวัดผิดชั้น → migration ล้มบน production ทั้งที่ระบบปลอดภัยดีอยู่แล้ว)
  · วิธีพิสูจน์จริงที่ใช้ได้: `SET LOCAL ROLE anon;` แล้วนับแถว — 0069 มี block นี้ต่อท้ายไว้แล้ว
- 🔴 **ลิงก์สาธารณะ (0069) — `anon` มีทางเข้าเดียวคือ `rpc_public_lbs_stock` ห้ามเปิดทางที่ 2**
  ทุกตารางเป็น `TO authenticated` มาตั้งแต่ 0001 · อย่าเผลอเพิ่ม RLS policy ให้ `anon`
  เพื่อความสะดวก — DO block ใน 0069 จะ RAISE ถ้ามี policy ไหนให้สิทธิ์ `anon` ในสคีมา public
  ⚠️ **หน้า `PublicStockPage` ต้อง render เหนือด่าน `!user` ใน `App.tsx`** และรับ token เป็น **prop**
  ไม่ใช่ `useParams()` — หน้านี้อยู่นอก `<Routes>` ของแอป `useParams()` จะคืน `{}` เสมอ
  แล้วลิงก์ขึ้น "เปิดลิงก์นี้ไม่ได้" ทุกครั้ง (เจอตอนทดสอบจริง 2026-09-14)
  ⚠️ **การกรองฟิลด์ต้องทำที่ชั้นข้อมูล** (`rpc_public_lbs_stock` / `publicStockView`) ไม่ใช่ซ่อนที่หน้าจอ
  — ซ่อนที่ UI แปลว่าข้อมูลจริงเดินทางไปถึงเบราว์เซอร์คนนอกแล้ว เปิด DevTools ก็เห็น
- 🔴 **`locked` กับ `procureLocked` ใน `JobDetailPage` ไม่ใช่ตัวเดียวกัน — ห้ามเอา `locked` ไปครอบปุ่มทั้งแถบ**
  `locked = terminal_status !== null` (ปิดตั้งแต่ **issued**) · `procureLocked = installed || cancelled`
  ตั้งแต่ 0037 **จัดซื้อเพิ่มหลังเบิกได้ถึง issued** ⇒ ปุ่มที่เกี่ยวกับ **วัสดุ** ต้องใช้ `procureLocked`
  ให้ตรงกับ guard ฝั่ง RPC (`app_assert_job_procurable`) · ใช้ `locked` เฉพาะปุ่มที่แตะ **LBS / ตัวใบงาน**
  🔴 เคสจริงที่ผู้ใช้แจ้ง 2026-09-11: แถบปุ่มทั้งก้อนครอบด้วย `!locked` ⇒ Job ที่เป็น `Issued` แล้วมี
  "ซื้อเพิ่มหลังเบิก" **ปุ่ม "เบิกให้ Service" หายทั้งปุ่ม** — เพิ่มวัสดุ · ออก PR · รับของได้ครบ
  แต่ไม่มีทางส่งออกหน้างาน ของค้างที่ Job ถาวร · **หลังบ้านอนุญาตอยู่แล้ว ไม่ต้องแก้ RPC เลย**
  · ตอนนี้มี banner เขียวบอกด้วยเมื่อใบปิดแล้วยังมีของซื้อเพิ่มรอเบิก (ไม่งั้นคนไม่รู้ว่าต้องกลับมากด)
  · โมดัลซ่อนพาเนล LBS เมื่อใบปิดแล้ว (LBS ออกครบไปตั้งแต่ตอนปิดใบ ดึงเข้าใหม่ไม่ได้)
  · ล็อกด้วยเทสต์ 2 เคสใน `logic.test.ts` (เบิกเพิ่มตอน issued ได้ · ตอน installed ต้อง throw)
- 🔴 **3 ทางออกของวัสดุที่ Job ต้องแยกให้ขาด — ผลต่อ "ต้นทุนงาน" กับ "ยอดคลัง" ไม่เหมือนกันเลย** (0067/0068)
  | ทางออก | ของไปไหน | ต้นทุน Job | ยอดคลัง | ลง ledger |
  |---|---|---|---|---|
  | เบิกให้ Service (`qty_issued_to_service`) | ออกหน้างาน | **คงเดิม** | ไม่แตะ | ไม่ลง |
  | 📦 โอนเข้าคลัง (`qty_transferred`) | เข้าคลังคงเหลือ | **ตัดออก** | **+เพิ่ม** | **ลง** (`transfer_from_job`) |
  | ✂️ ตัดจำหน่าย (`qty_written_off`) | สูญไปกับงาน | **คงเดิม** | ไม่แตะ | ไม่ลง (Audit เท่านั้น) |
  ⚠️ **ห้ามเอา "ตัดจำหน่าย" ไปบวก `qty_transferred`** เพื่อความสะดวก — งบงานจะลดลงทั้งที่ไม่มีของกลับมา
  ⚠️ **ห้ามเอา "ตัดจำหน่าย" ไปลง `stock_movements`** — รายงาน "ปริมาณออกจากคลัง" จะนับซ้ำ (ของไม่เคยอยู่ในคลังกลาง)
  ⚠️ **ทุก action ที่ทำให้บรรทัดจบต้องเรียก `app_finalize_issue`/`finalizeIssue`** ไม่ใช่แค่ action เบิก
     (บั๊กที่ 0067 ทิ้งไว้ · 0068 เติมให้ครบแล้ว — เพิ่ม action ใหม่ที่ปิดบรรทัดได้ต้องเติมด้วย)
  ⚠️ **ผู้ใช้ขอ "ตัดต้นทุนตามจำนวนที่เบิก" แล้วตกลงไม่เปลี่ยน (มติ 2026-09-16)** — ถ้าเปลี่ยนฐานเป็น
     `qty_issued_to_service` จะได้ 3 ผลข้างเคียง: ของที่ซื้อ/รับแล้วแต่ยังไม่ส่งช่าง → ต้นทุน 0
     (ติดตามงบระหว่างจัดซื้อไม่ได้) · **ของที่ตัดจำหน่าย → ต้นทุน 0 ทั้งที่จ่ายเงินไปจริง** ·
     ผลรวมทุกงาน ≠ ยอดที่ซื้อจริง (กระทบยอดกับ Epicor ไม่ได้) ⇒ แทนที่จะเปลี่ยนฐาน เพิ่มเป็น
     **คอลัมน์แสดงผล "ต้นทุนที่ถึงหน้างานแล้ว"** (`unitPrice × qtyOutToField`) วางคู่กับ "ตัดเข้างาน"
     ทั้งบนหน้า Job และในรายงาน Excel — **ไม่ได้ใช้คิดงบ** · ถ้าวันหลังจะเปลี่ยนฐานจริงต้องเป็นมติ
     ระดับ Division + ฝ่ายบัญชี เพราะกระทบ P&L รายงานผู้บริหาร และการกระทบยอด ERP
- 🔴 **`input { width: 100% }` ใน `styles.css` ต้องมีข้อยกเว้นให้ `checkbox`/`radio` เสมอ — ห้ามลบกฎนั้นทิ้ง**
  กฎกลางเดิมไม่มีข้อยกเว้น ⇒ checkbox ทุกตัวกลายเป็น **กล่องกว้าง** ที่ยืดตามพื้นที่ว่างเมื่ออยู่ใน flex row
  (วัดจากของจริงบนโมดัล "เบิกให้ Service" ได้ **34–577px**) ตัวติ๊กวาดเล็กอยู่ริมซ้ายของกล่อง แต่ข้อความข้าง ๆ
  ถูกดันไปชิดขวาจนดูเหมือนคนละคอลัมน์ — ผู้ใช้เห็นเป็น "layout พัง" ทั้งหน้า (เจอ 2026-09-11)
  ⚠️ **ห้ามแก้ด้วยการใส่ `width` ที่จุดเรียกทีละที่** ปัญหาอยู่ที่กฎกลาง · เพิ่ม checkbox ใหม่ที่ไหนก็โดนหมด
- **ช่องว่างระหว่าง `</td>` กับ `<td>` ที่อยู่บรรทัดเดียวกัน = text node จริงใน `<tr>`** (JSX ตัดช่องว่างให้เฉพาะ
  ที่มี newline) ⇒ React ร้อง `validateDOMNesting` ทุกครั้งที่ render ตาราง · แก้ด้วยการขึ้นบรรทัดใหม่
- 🔴 **ก่อน push ต้อง `git fetch` แล้วเช็คว่า local ตามหลัง `origin/main` ไหม — เครื่องนี้เคยค้างงานไม่ commit ทับของที่ใหม่กว่า**
  เคสจริง 2026-09-09: working tree ถือทั้งงาน "รายงานผู้บริหาร" ที่ยังไม่ commit **และสำเนา 0062–0066 รุ่นเก่า** อยู่ด้วยกัน
  ขณะที่ `origin/main` ไปถึง 0066 แล้ว (ต่างกัน 4 commit) — `git status` ดูเหมือนปกติเพราะทุกไฟล์เป็นแค่ ` M`
  ถ้า commit ทั้งก้อนแล้ว push จะ **ย้อน production**: `epicorTxnType` · `markEpicorIssued`/`undoEpicorIssued`
  ใน `remote.ts` + `StoreActions` และเทสต์ `logic.test.ts` 12 เคส หายทั้งชุด (ปุ่ม Done ของ 0064/0065 พังเงียบ ๆ บน LIVE)
  **ท่าที่ใช้**: commit สแนปช็อตลง branch ชั่วคราว → `git merge origin/main` ให้ git ทำ 3-way → ไฟล์ที่เครื่องนี้
  ไม่มีงานใหม่ของตัวเอง (`logic.ts` · `logic.test.ts` · `types.ts` · migration) เอาฝั่ง `origin/main` ทั้งดุ้น ·
  ไฟล์ที่ทั้ง 2 ฝั่งมีงานจริง (`JobDetailPage`) รวมมือทีละ hunk → ตรวจ `tsc` + เทสต์ + demo แล้วค่อยยกขึ้น main
  ⚠️ **ตรวจสเปกคอลัมน์ Export หลัง merge ด้วย** — `dataSheet()` ใช้ `header:` จาก `*_COLS` ⇒ คีย์ใน rows ที่ merge
  เข้ามาแต่ไม่มีใน `*_COLS` จะ **หายจากไฟล์เงียบ ๆ ไม่ error** (เคสนี้ 4 คอลัมน์ Epicor ของ 0064/0065 เกือบหลุด)
- **เลข 4 หลักในเอกสารนี้ = ชื่อไฟล์ migration เท่านั้น** — งานที่เป็น frontend ล้วน (เช่นรายงานผู้บริหาร 2026-09-09)
  ให้อ้างด้วย **วันที่** ห้ามตั้งเลขชุดใหม่ เพราะเลขจะชนกับ migration ที่หมายถึงเรื่องอื่นแล้วอ่าน §9 ผิดคน
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
- **สลับ LBS (0056) — "ข้อมูลตัวเครื่อง" ต้องย้ายตามคู่ Serial เสมอ**: identity ของเครื่องจริงคือ `serial_lvb + serial_om` ดังนั้น `unit_cost` (เงินที่จ่ายซื้อเครื่องนั้น) + `fob_date` / `eta_lead_days` / `plan_po_receipt_date` (ล็อตเรือ + วันของเข้าคลังของเครื่องนั้น) **ย้ายตาม Serial** · ส่วน `project_stock_id` / `status` / `job_id` (= ตำแหน่ง ซึ่งเป็นสิ่งที่ swap ตั้งใจเปลี่ยน) และ `plan_customer_name` / `plan_contact_phone` / `plan_install_location` / `plan_po_date` / `plan_delivery_date` (= แผนฝั่งขายของ "ช่อง") **อยู่กับที่** · **เพิ่มคอลัมน์ใหม่บน `lbs_units` ต้องตัดสินว่าอยู่ฝั่งไหน แล้วเติมใน `app_exec_swap_lbs` + `machineOf()` ให้ครบ** — ลืมแล้วเงินผูกผิดเครื่องแบบเงียบ (เคสจริง: 0028 ลืม `unit_cost` ⇒ งบ Job คิดเงินของเครื่องที่ยังอยู่ในคลัง)
- **`profiles.id` อ้าง `auth.users`** → ทุก user ต้องมีบัญชี login · คนที่ไม่ต้อง login (ช่างภาคสนาม/outsource) ต้องเก็บใน `team_members` ไม่ใช่ profiles (0036)
- **ทดสอบ UI ด้วย Browser pane**: พิกัดคลิกเพี้ยนสเกล (สัดส่วนต่างกันต่อ tab เช่น ~0.59 หรือ ~0.73 เทียบ CSS pixel) และ screenshot ไม่ render modal overlay → วิธีที่ใช้ได้: อ่าน `getBoundingClientRect()` ผ่าน `javascript_tool` แล้วคูณสเกลก่อนคลิก · อ่านเนื้อ modal จาก `document.querySelector('.modal').innerText` · `form_input` ใช้ได้กับ text/textarea/select แต่ **checkbox/radio ต้องคลิกจริง** (React onChange ไม่รับค่าจากการ set `.checked`)
- `.env`, `.env.*.local`, `.env.live-backup`, `node_modules` อยู่ใน `.gitignore` — อย่า commit
- **ปุ่มแก้ไข/ดึง LBS/ออก PR/เบิก/ยกเลิก/แก้งบ หายหมด** เมื่อ Job **ล็อก** (terminal_status = issued/installed/cancelled) — เช็ค badge สถานะข้างชื่อ Job · และแก้งบ/ออก PR ต้อง login เป็น **Project หรือ Manage** เท่านั้น (badge มุมซ้ายล่าง) · "ออก PR" โผล่เมื่อมีวัสดุ source purchasing รอออก PR (ต้อง `+ เพิ่มวัสดุ` ก่อน)
- **Job ค้างสถานะ อยากลบทิ้งเปิดเลขเดิมใหม่**: รัน `supabase/cleanup_job.sql` (แก้ `v_job_no`) — ลบเฉพาะ Job นั้น + คืน LBS เข้าสต็อก (ไม่ลบเครื่อง). ยกเลิก Job ปกติ (cancel) จะล็อกเลขไว้ (ยังเปิดเลขเดิมซ้ำไม่ได้) จึงต้องลบด้วยสคริปต์นี้
- **รัน demo mode ในเครื่อง** (ทดสอบ UI ไม่ยุ่ง production): `mv .env .env.bak` แล้ว restart dev server (หรือ `npm run dev -- --mode demo` ใช้ `.env.demo.local` ที่ค่าว่าง) — vite bake env ตอน start, เปลี่ยน .env ต้อง restart/stop-start ให้ module cache เคลียร์

---

## 13. โครงเมนู (Information Architecture) — จัดใหม่ 2026-08-22 (`9c33c25`)

เดิมเป็น list ชั้นเดียว 10 รายการที่เอา **ของ 4 ประเภทมาวางระดับเดียวกัน** จึงต้องจำตำแหน่งแทนที่จะเดาได้:
ข้อมูลตั้งต้น (Material/Standards) แทรกกลางสายงานทั้งที่แตะเดือนละครั้ง · `Awaiting Approval` ซึ่ง**ขวางทั้งสาย**
กลับอยู่ล่างสุด · Service มี 2 เมนูชื่อคล้ายกันและแบ่งไม่ตรงเนื้อ · `Notifications`/`Audit Log` ไม่อยู่ในเมนูเลย

**เกณฑ์แบ่ง Module = "หน้านี้ทำอะไรกับสายงาน" ไม่ใช่ "หน้านี้ของแผนกไหน"**
(แผนกปรับโครงสร้างได้ แต่ลำดับที่ของจริงเดินไม่เปลี่ยน)

| Module | คุณสมบัติร่วม | เมนู |
|---|---|---|
| **Overview** | อ่านอย่างเดียว รวมทุกแผนก | Dashboard · Map Tracking — ประเทศไทย |
| **Operations** | ทุกหน้าทำให้ Serial/Job **ขยับสถานะ** · ใช้ทุกวัน · เรียงตามที่ของจริงเดิน | LBS Inventory *(2 แท็บย่อย: คลัง LBS · วัสดุตาม Job)* → Jobs → Purchasing (PR/PO) → Site Installation |
| **Workforce & Scheduling** | จัด **คน + เวลา** ให้งาน · ไม่ทำให้ Job ขยับสถานะเอง | Assignment & Schedule *(รอเฟส 2 เพิ่ม Service Teams)* |
| **Approvals** | **ขวางสายงาน** · cross-cutting ไม่ใช่ของแผนกใด | Approval Queue |
| **Master Data** | ข้อมูลอ้างอิง ตั้งครั้งเดียวใช้ยาว | Material Master · Standards Library |
| **Administration** *(Manage)* | ตั้งค่าตัวระบบ ไม่ใช่ข้อมูลธุรกิจ | Users & System Settings |

**ปรับ 2026-08-23** — `Notifications` + `Audit Log` **ย้ายออกจากเมนูซ้ายไปมุมขวาบน**
เกณฑ์: 2 หน้านั้นเป็น *"เปิดดูตอนสงสัย"* ไม่ใช่ *"ขั้นที่ต้องเดิน"* — อยู่ในเมนูสายงานทำให้เมนูยาวขึ้น
โดยไม่ช่วยให้เดินงานเร็วขึ้น และ Notifications ยัง**ซ้ำกับกระดิ่งมุมขวาบน**ที่มีของเดิมอยู่แล้ว
ตอนนี้มุมขวาบนมี 3 ปุ่มเป็นชุดเดียวกัน = "เครื่องมือประจำหน้าจอ": `↻ Refresh` · `📜 Audit Log` · `🔔 กระดิ่ง`
(ปุ่ม Audit Log ที่กล่องผู้ใช้ท้าย sidebar ถูกถอดออกด้วย — ที่เดียวไม่ซ้ำ)
⚠️ **route ยังอยู่ครบ** (`/notifications` · `/audit`) — bookmark เก่า ลิงก์ "ดูทั้งหมด →" และลิงก์ใน LINE ใช้ได้ปกติ
พร้อมกันนี้เพิ่ม **Map Tracking — ประเทศไทย** (`/map`) ใน Overview เพราะเป็นมุมมองสรุป ไม่ทำให้อะไรขยับสถานะ

**มติที่ตกลงไว้ (อ่านก่อนแก้เมนู)**
- หัวข้อ Module = **หัวข้อคั่นแบบกางตลอด ไม่ใช่ accordion** → ไม่ต้องเก็บสถานะพับ/กาง และไม่ต้องมี badge รวมขึ้นหัว
- **ไม่ซ่อน Module ตามแผนก** (ตรงกับ RLS `read_all` ที่ทุกแผนกอ่านได้อยู่แล้ว) — ยกเว้น Administration = Manage ซึ่งเป็นของเดิม
  · การซ่อนจะทำให้คนหาของไม่เจอและ Service จะมองไม่เห็นงานจัดซื้อที่ตัวเองรออยู่
- **ไม่แตะ route** — ทุก `to` เป็นเส้นทางเดิม (`/dashboard` … `/standards`) bookmark เก่าใช้ได้ · การเปลี่ยนเป็น `/ops/jobs`
  ประเมินแล้วว่า**ไม่คุ้ม** เพราะกระทบลิงก์ใน LINE ทุกจุด แลกกับประโยชน์น้อย

**ตั้งชื่อ**: เมนูเดิมเป็นอังกฤษอยู่แล้ว จึงจัดให้อยู่ระบบคำเดียวกันทั้งชุด — Module = คำนามกว้างของขอบเขตงาน ·
เมนู = คำนามของสิ่งที่อยู่ในหน้านั้น · ไม่มีคำกริยา ไม่มีวงเล็บซ้อน **ไม่มีชื่อขึ้นต้นซ้ำกันแต่คนละเรื่อง**
(เดิม `Project Stock` / `Project ID` ขึ้นต้นเหมือนกันแต่เป็นคลังของ vs ใบงาน) ·
badge เป็นอังกฤษให้เข้าชุดกับ Job status ที่เป็นอังกฤษอยู่แล้ว (`Ready to Issue` / `Awaiting Install` / `Unassigned`)

⚠️ **`.sidebar nav` ต้องมี `min-height: 0` + `overflow-y: auto`** — เจอตอนทดสอบจริง: เมนูยาวขึ้น ~300px
(12 ลิงก์ + 6 หัวข้อ) บนจอสูง 720px กล่องผู้ใช้ท้าย sidebar ถูกดันไป `top: 973` หลุดนอกจอ และ `.sidebar`
เป็น `overflow: visible` จึงตัดทิ้งเฉย ๆ ⇒ **กดปุ่มออกจากระบบไม่ได้เลย** · `min-height: 0` ขาดไม่ได้ —
flex child ไม่ยอมหดต่ำกว่าเนื้อหา ถ้าไม่ใส่ `overflow-y` จะไม่มีผล · **เพิ่มเมนูใหม่ต้องเช็คบน 720px และมือถือทุกครั้ง**

### เฟสที่ยังไม่ทำ
- [ ] **เฟส 2** — แยกทะเบียนทีมช่างออกจาก `ServicePage` (739 บรรทัด) ไป `ServiceSchedulingPage` (238 บรรทัด)
      แล้วแตก Workforce & Scheduling เป็น 2 เมนู (`Service Teams` + `Assignment & Schedule`)
      · เหตุผล: แยกตามจังหวะการใช้จริง (ทะเบียน = เดือนละครั้ง · ยืนยันติดตั้ง = ทุกวัน)
      · **เฟสแรกที่แตะโค้ดหน้าจริง — ให้ทีม Service ลองก่อนใช้**
      · ตอนนี้จึงใส่เมนูเดียวไปก่อน ไม่ใส่ 2 เมนูชี้ route เดียวกัน (กดแล้วได้หน้าเดิมทั้งคู่ = สับสนกว่า)
- [ ] **เฟส 3** — จุดทำเครื่องหมายเมนูหลักของแผนกที่ login · หน้าแรกต่างกันตามแผนก (Purchasing เปิดมาเจอ PR/PO)
- [ ] **เฟส 5** — `Ctrl+K` ค้น Job No. / Serial / เลข PO แล้วกระโดดไปหน้านั้นตรง (**คุ้มที่สุดที่เหลือ**)
- [x] ~~เฟส 4 — เปลี่ยน URL เป็น `/ops/jobs`~~ **ปิดรายการนี้: ตัดสินใจไม่ทำ** (เสี่ยงสูง ได้ประโยชน์น้อย)
