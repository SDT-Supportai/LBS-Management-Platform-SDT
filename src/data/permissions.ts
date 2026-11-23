// สิทธิ์ตามแผนก + สิทธิ์ระดับแถว — แยกจาก StoreContext (เฟส 2, 2026-11-23)
//   เพื่อให้ logic ล้วน (flow.ts) และเทสต์ใช้ได้โดยไม่ต้องลาก React/Supabase มาด้วย
//   StoreContext re-export ทั้งหมด — หน้าเดิมที่ import จาก StoreContext ใช้ต่อได้ไม่ต้องแก้
import type { User, Department } from '../types'

// สิทธิ์ตามแผนก — ฝั่ง UI ใช้ซ่อน/แสดงปุ่ม; โหมด Supabase ตัวจริงคือ RPC ฝั่ง server
// (ชื่อแสดงผล: sales = "Division", admin = "Manage" — ค่าใน DB คงเดิม)
export const PERMISSIONS: Record<string, Department[]> = {
  'stock.manage': ['sales', 'admin'],
  'job.manage': ['project', 'admin'],
  'purchasing.manage': ['purchasing', 'admin'],
  'service.confirm': ['service', 'admin'],
  // เอกสารรับมอบ/Warranty ย้อนหลัง + แนบเพิ่ม (0079) — Service ปิดงาน · Project ถือเอกสารสัญญา/PAC ที่มาทีหลัง
  'closeout.manage': ['service', 'project', 'admin'],
  // 0080 — ปิดงานติดตั้ง: Project ทุกคน + Service + Manage (มติผู้ใช้ 2026-09-29)
  'job.closeInstall': ['service', 'project', 'admin'],
  // 0080 — ตรวจรับของที่ Job ขอคืนเข้าคลัง (รับเข้าคลัง / ตีกลับ Job) — Purchasing ถือคลังตัวจริง
  'stockReturn.receive': ['purchasing', 'admin'],
  'master.manage': ['admin'],
  // Material Database (0061) — Purchasing เป็นเจ้าของฐานข้อมูลวัสดุ: เพิ่ม/แก้/ลบ Accessory + Import Excel
  // แยกจาก master.manage เพราะ master.manage ยังครอบ "ข้ามขั้นอนุมัติ" (createPR/issueJob/cancelJob) + จัดการผู้ใช้
  'material.manage': ['purchasing', 'admin'],
  // ยอดคลังคงเหลือ accessory (ปรับยอด · Lot No. · แถวใน Import Excel ที่แก้ยอด) — Division + Purchasing
  // แยกจาก stock.manage ที่ครอบ Project Stock / LBS รายเครื่อง ซึ่งยังเป็นของ Division เท่านั้น
  'accessoryStock.manage': ['sales', 'purchasing', 'admin'],
  // ทำเบิก-Epicor (0064) — ธงกระทบยอดกับ ERP · คนที่ตัดใบเบิกใน Epicor จริงคือ Purchasing
  'epicor.issue': ['purchasing', 'admin'],
  'approval.decide': ['sales', 'admin'],   // Division อนุมัติ/ตีกลับคำขอจาก project
  // 0090 — ขอยกเลิกผลติดตั้งที่บันทึกผิด: Service (คนกดยืนยัน) + Project (เจ้าของงาน) · อนุมัติ = approval.decide
  'install.revertRequest': ['service', 'project', 'admin'],
  // ความเห็นบนคำขออนุมัติ (0050) — VIP (ผู้บริหาร) ฝากความเห็นให้ Division · Division ตอบกลับได้
  // VIP ไม่มีสิทธิ์อื่นเลย = ดูได้ทุกหน้า แต่แก้ข้อมูลไม่ได้ (ปุ่มทุกปุ่มซ่อนเองผ่าน can())
  'approval.comment': ['vip', 'sales', 'admin'],
  'accessory.cleanup': ['project', 'sales', 'admin'],   // ลบรายการวัสดุที่ยกเลิกออกจากการ์ด (Project/Division/Manage)
  // Standard Drawing / BOM (0045) — แก้ได้ Project/Division/Manage · ดู+ดาวน์โหลดได้ทุกแผนก
  'standards.manage': ['project', 'sales', 'admin'],
  // ดาวน์โหลด "รายงานผู้บริหาร" (Excel) จากหน้า Project Stock / Job / Material Database (2026-09-09)
  //   ไฟล์พาต้นทุน · ราคาต่อหน่วย · มูลค่าคลัง · กำไร/มาร์จิ้น ออกไปนอกระบบ (ส่งต่อทางเมลได้ ยึดคืนไม่ได้)
  //   ⇒ ปุ่ม Export **หายทั้งปุ่ม** ถ้าไม่มีสิทธิ์นี้ (มติ 2026-09-09) ไม่ใช่ออกไฟล์แบบตัดคอลัมน์เงินทิ้ง
  //   ⚠️ แผนกที่เห็นตัวเลขเงิน "บนจอ" อยู่แล้วต้องอยู่ในรายชื่อนี้ ไม่งั้นเป็นการถอยฟีเจอร์เดิม
  //      (Project เห็นงบ 7 หมวด + ราคา/หน่วยในแผง Purchase Orders ของงานตัวเองอยู่แล้ว)
  //   **ทุกแผนกที่ login ได้สิทธิ์นี้ (ผู้ใช้ยืนยัน 2026-09-09)** — เดิมตัด `service` ออกด้วยเหตุผลว่า
  //   หน้างานติดตั้งไม่ใช้ตัวเลขต้นทุน แต่ Service ต้องส่งไฟล์ให้หัวหน้างาน/ลูกค้าเองอยู่แล้ว
  //   ⇒ perm นี้ตอนนี้ครบทุกแผนก จึงเหลือความหมายเป็น "ต้อง login ก่อน" · **ยังไม่ลบทิ้ง**
  //     เพราะเป็นจุดเดียวที่ปิดปุ่ม Export ทั้งระบบได้ทีเดียวถ้าภายหลังต้องจำกัดรายแผนกอีก
  'report.exec': ['sales', 'purchasing', 'project', 'service', 'admin', 'vip'],
}

export function can(user: User | null, perm: keyof typeof PERMISSIONS): boolean {
  if (!user) return false
  return PERMISSIONS[perm].includes(user.department)
}

// สิทธิ์ระดับแถว (0042) — Project ดำเนินการได้เฉพาะ Job ที่อีเมลตัวเองเปิด · Job อื่นดูได้อย่างเดียว
// แผนกอื่น (Division/Purchasing/Service) + Manage ไม่ถูกจำกัด (งานข้าม Job เป็นหน้าที่ปกติ)
// openedBy ว่าง = งานเก่าก่อน 0042 → ไม่ล็อก (grandfather) · ตัวจริงคือ app_assert_job_owner ฝั่ง DB
export function ownsJob(user: User | null, job?: { openedBy?: string } | null): boolean {
  if (!user || !job) return false
  if (user.department !== 'project') return true
  if (!job.openedBy) return true
  return job.openedBy === user.id
}

export function canEditJob(user: User | null, job?: { openedBy?: string } | null): boolean {
  return can(user, 'job.manage') && ownsJob(user, job)
}
