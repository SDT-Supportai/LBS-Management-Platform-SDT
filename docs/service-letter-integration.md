# Service Letter → LBS Platform: แผนการรวม

เตรียมไว้เมื่อ 2026-11-25 · ต้นแบบมาจาก ServiceMS Instance 1 (`D:\Claude Code.md\15. DIGITAL & AI AUTOMATION TALENT Service MS\docs\templates\service-letter`)

**สถานะ (2026-11-25):** ผูกระบบครบทั้ง 8 ขั้นแล้ว (ดู HANDOFF 11.11) หน้า `/letters` ใช้ได้ในโหมดเดโม
✅ รัน `supabase/migrations/0100_service_letters.sql` บน Supabase จริงแล้ว (2026-11-25 · ตรวจด้วย anon key: ตาราง + RPC มีครบ และ anon เข้าไม่ได้)
⚠️ เหลือ: ให้ Manage เพิ่มผู้ลงนามอย่างน้อย 1 คน (ยังไม่มีผู้ลงนาม = ออกจดหมายไม่ได้) แล้วลองออก/พิมพ์/แนบ/ลบ 1 รอบบน LIVE

รอบผูกระบบแก้เพิ่ม 2 จุด (PGlite 59/59):
- ไม่รับไฟล์แนบ SVG
- ลบฉบับล่าสุดแล้ว เลขที่ไม่ถูกนำกลับมาใช้ ใช้ตาราง `letter_no_counters` เพราะฉบับที่ลบอาจส่งถึงผู้รับไปแล้ว

## คำตอบผู้ใช้ (2026-11-25)

| ข้อ | เรื่อง | ตัดสินใจ | อยู่ในไฟล์ |
|---|---|---|---|
| 1 | ใครออกจดหมายได้ | Service + Project + Manage · ลบได้เฉพาะ Manage | `LETTER_PERMS` · `app_assert_letter()` · storage policy |
| 2 | เลขที่ | `PSP-LBS-YYYY-NNN` แยกจาก ServiceMS (ไม่นับเลข `PSP Service-…`) | `LETTER_PREFIX` · `rpc_create_service_letter` |
| 3 | หัวกระดาษ | ข้อมูลตามแม่แบบถูกต้อง · ใช้โลโก้ LBS เดิม (`public/logo.jpg`) · ไม่มีแถบท้ายกระดาษ | `lbsLetterOrg(window.location.origin)` |
| 4 | ลายเซ็น | ผู้ลงนามเลือกจาก **dropdown รายชื่อที่ Manage ตั้ง** · ลายเซ็นมี 2 แบบ: **เซ็นอิเล็กทรอนิกส์**ต่อฉบับ หรือ**เว้นที่ให้เซ็นมือ** · ไม่มีลายเซ็นเก็บในระบบ | ตาราง `letter_signers` · `signerId` · `.sig-space` |
| 5 | แจ้งเตือน | กระดิ่งในเว็บ ไม่ส่ง LINE · อ้าง Job → แจ้ง Project ของงานนั้น · ไม่อ้าง Job → ไม่แจ้ง (มี Audit) | `LetterNotify` · `app_notify('letter_issued', …)` |
| 6 | Warranty Letter | ใส่ปุ่ม "ออก Warranty Letter" ในหน้า Service (Warranty) และเติมข้อมูลประกันให้ | `warrantyLetterPrefill(job, warranties)` |

หมายเหตุข้อ 4: ชื่อและตำแหน่งผู้ลงนามจะ snapshot ลงจดหมาย ณ วันที่ออก ถ้าภายหลังแก้รายชื่อ จดหมายเก่าไม่เปลี่ยน ผู้ลงนามที่ไม่ใช้แล้วให้ "ปิดใช้งาน" แทนการลบ

หมายเหตุข้อ 5: `letter_issued` ไม่อยู่ในรายการประเภทที่ `app_notify` (0083) ส่งเข้า LINE อยู่แล้ว จึงไม่ต้องแก้ฟังก์ชันนั้น

## ไฟล์ที่เตรียมไว้

| ไฟล์ | หน้าที่ | ทดสอบแล้ว |
|---|---|---|
| `src/data/letters.ts` | ชนิดข้อมูล `ServiceLetter` / `LetterSigner` / `ServiceLetterFile`, `nextLetterNo`, `cleanLetterInput`, `safeSigImage`, `parseTechList`, `canLetter`, `activeSigners`, `warrantyLetterPrefill`, โหมดเดโม `createLetterDemo` / `deleteLetterDemo` / `upsertSignerDemo` | `letters.test.ts` 24 ตัว |
| `src/ui/letterPdf.ts` | แม่แบบเอกสารพิมพ์ 3 แบบ (Official / Service Official / Warranty), `lbsLetterOrg`, `openPrintWindow` / `writePrintWindow` | `letterPdf.test.ts` 9 ตัว |
| `supabase/migrations/0100_service_letters.sql` | ตาราง 3 ตาราง (`letter_signers`, `service_letters`, `service_letter_files`) + ตัวนับเลข `letter_no_counters`, RLS, bucket `letter-docs` (private), RPC 5 ตัว, ตรวจผลท้ายไฟล์ | PGlite (Postgres 16.4) 59/59 · `supabase/tests/test_0100_pglite.mjs` · ยังไม่ได้รันบน Supabase จริง |
| `src/data/logic.ts` (ท้ายไฟล์) · `remote.ts` · `StoreContext.tsx` | action โหมดเดโม + LIVE · โหลด 3 ตาราง | `lettersStore.test.ts` 23 ตัว |
| `src/pages/LettersPage.tsx` · `src/ui/LetterForm.tsx` · `SignaturePad.tsx` · `LetterSignersPanel.tsx` | หน้า Letters · ฟอร์ม 3 แบบ · แผ่นเซ็น · รายชื่อผู้ลงนาม | ตรวจในเดโม (lbs-demo) |

## ServiceMS เทียบกับ LBS

| เรื่อง | ServiceMS | LBS (ที่เตรียมไว้) |
|---|---|---|
| Login / สิทธิ์ | ตาราง `sessions` ของตัวเอง + `ROLE_REQUIRED` ใน Edge Function | Supabase Auth + `profiles` + `app_assert_dept` ใน RPC |
| หลังบ้าน | Edge Function `api` ถือ service-role key | RPC แบบ SECURITY DEFINER (แบบเดียวกับทุกฟีเจอร์ของ LBS) |
| เลขที่ | `PSP Service-YYYY-NNN` ใช้ insert แล้ว retry เมื่อชน 23505 | `PSP-LBS-YYYY-NNN` ออกใน RPC ใต้ `pg_advisory_xact_lock` + UNIQUE · ปีตามเวลาไทย |
| รับข้อมูล | spread ทั้งก้อนลงตาราง | รับเฉพาะคอลัมน์ที่อนุญาต · `created_by = auth.uid()` |
| ผู้ลงนาม | พิมพ์ชื่อ/ตำแหน่งเองทุกครั้ง | เลือกจาก `letter_signers` · ชื่อ/ตำแหน่งเอาจากตาราง ไม่รับที่ส่งมา |
| ลายเซ็น | ข้อความอะไรก็ได้ แล้วไปอยู่ใน `<img src>` (stored XSS) · มีลายเซ็นเริ่มต้นฝังในโค้ด | เซ็นอิเล็กทรอนิกส์ (CHECK เป็น data URL รูป PNG/JPEG ล้วน) หรือเว้นที่เซ็นมือ · ไม่มีลายเซ็นเก็บในระบบ |
| ไฟล์แนบ | สตริง `name::url||…` ในคอลัมน์เดียว | ตาราง `service_letter_files` + bucket private, เก็บ path แล้วขอ signed URL ตอนเปิด (แบบ 0076/0079) |
| อ้างอิงโครงการ | ข้อความ `ref_job` จากตาราง handovers | `job_id` (FK ไป `jobs`) |
| PDF | Edge Function สร้าง HTML | สร้าง HTML ฝั่งเบราว์เซอร์ (`buildLetterHtml`) |
| แจ้งเตือน | ลงกระดิ่งในเว็บ (ไม่ส่ง LINE) | กระดิ่งถึง Project เมื่ออ้าง Job (ไม่ส่ง LINE) |
| ลบ | manager | Manage (`admin`) · คืน path ให้หน้าเว็บลบไฟล์ใน bucket ต่อ |

## ขั้นตอนผูกระบบ

1. **ฐานข้อมูล**
   - ✅ ย้ายไป `supabase/migrations/0100_service_letters.sql` แล้ว (0100 เป็นเลขถัดไปจริง)
   - ทดสอบบน PGlite แล้วรันใน SQL Editor
   - เพิ่มผู้ลงนามอย่างน้อย 1 คนก่อนเปิดใช้ (ไม่มีผู้ลงนาม = ออกจดหมายไม่ได้)
   - บันทึกผลใน HANDOFF
2. **ชนิดข้อมูลและเดโม**
   - เพิ่ม `serviceLetters`, `serviceLetterFiles`, `letterSigners` ใน `DB` (`src/types.ts`)
   - เพิ่มข้อมูลตัวอย่างใน `seed.ts` (ผู้ลงนาม 2 คน, จดหมาย 2 ฉบับ)
   - โหมดเดโม: เพิ่ม `notify` ที่ `createLetterDemo` คืนมาลง `db.notifications`
3. **สิทธิ์:** ย้าย `LETTER_PERMS` ใน `letters.ts` ไปเป็น `'letter.manage'` / `'letter.delete'` / `'letter.signers'` ใน `permissions.ts` และ `PERM_LABEL`
4. **Audit:** เพิ่ม `service_letter: 'จดหมาย'` และ `letter_signer: 'ผู้ลงนามจดหมาย'` ใน `AUDIT_ENTITY_LABEL` (`src/data/audit.ts`), สีใน `tone.ts` และลิงก์ใน `auditLink`
5. **StoreContext / remote**
   - โหลด `letter_signers`, `service_letters`, `service_letter_files` + realtime
   - `act.createLetter` เรียก `rpc_create_service_letter` (แปลง camelCase เป็น snake_case) และในโหมดเดโมเรียก `createLetterDemo`
   - `act.deleteLetter` เรียก `rpc_delete_service_letter` แล้ว `removeDoc` ไฟล์ที่ได้คืน
   - `act.upsertSigner` เรียก `rpc_upsert_letter_signer` / `upsertSignerDemo`
   - แนบไฟล์: `uploadDoc(sb, 'letter-docs', 'letters/<id>', file)` แล้ว `rpc_add_service_letter_file` ส่วนเปิดไฟล์ใช้ `signedDocUrl`
6. **หน้าเว็บ**
   - สร้าง `src/pages/LettersPage.tsx` เป็น React ไม่ยก HTML string เดิมมา
   - ตาราง + ปุ่ม 📎 📄 🗑, ฟอร์ม Official / Service Official / Warranty (Modal ของ LBS)
   - ผู้ลงนาม: dropdown จาก `activeSigners(db.letterSigners)` แสดงตำแหน่งข้างชื่อ
   - ลายเซ็น: ตัวเลือก 2 ปุ่ม "เซ็นอิเล็กทรอนิกส์" (แผ่นวาด, component ใหม่ ยกตรรกะจาก `initSigPad`) / "เว้นที่ให้เซ็นมือ"
   - ปุ่ม 📄: เรียก `openPrintWindow()` ตอนคลิก แล้วตามด้วย `writePrintWindow(w, buildLetterHtml(letter, lbsLetterOrg(location.origin), jobNo))`
   - หน้า Users & System Settings: เพิ่มแผง "รายชื่อผู้ลงนามจดหมาย" (Manage เพิ่ม/แก้/ปิดใช้งาน)
   - หน้า Service (Warranty): ปุ่ม "✉️ ออก Warranty Letter" ต่อแถว → เปิดฟอร์มประเภท WARRANTY ที่เติมด้วย `warrantyLetterPrefill(job, db.jobWarranties)` (แสดงเฉพาะผู้ที่ `canLetter(user, 'manage')`)
7. **Route / เมนู:** `/letters` ในกลุ่ม Service ของ sidebar (`App.tsx`)
8. **ตรวจ:** vitest, tsc, build, และเดโมด้วยบัญชี Service / Project / Manage (ออกได้) และ Division / Purchasing / VIP (ต้องไม่เห็นปุ่มออกจดหมาย)

## ไม่ได้ยกมา (ตั้งใจ)

- Edge Function / ตาราง `sessions` / `users` ของ ServiceMS: LBS มีระบบ login ของตัวเองแล้ว
- `gsr()` / `showLoading` / popup guard แบบ vanilla JS: LBS มี `useTryAction` / `Modal` (Esc ไม่ปิด, กล่องสั่น) อยู่แล้ว
- ลายเซ็นจริง ลายเซ็นเริ่มต้น โลโก้ base64 และค่าตัวอย่างที่เป็นข้อมูลบุคคลจริง
