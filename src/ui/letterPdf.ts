// =============================================================================
// เอกสารพิมพ์ Service Letter — ยกแม่แบบจาก ServiceMS (smLetter / warrantyLetter / Official Letter ใน buildPdf)
//   LBS ไม่มี Edge Function ⇒ สร้าง HTML ฝั่งเบราว์เซอร์ แล้วเปิดแท็บพิมพ์ (ผู้ใช้กด "บันทึกเป็น PDF")
//   หน้าเรียก: pages/LettersPage.tsx (📄) · ui/LetterForm.tsx (👁️ ดูตัวอย่าง) · เทสต์: letterPdf.test.ts
//
//   [ปรับ 2026-11-25 ตามไฟล์แนบของผู้ใช้]
//   • หัว/ท้ายกระดาษเดียวกันทั้ง 3 แบบ: โลโก้ PRECISE ซ้าย + ที่อยู่บริษัทขวา · ท้าย = ชื่อแผนก/อีเมล + แถบสี
//     (รูปจาก ServiceMS deploy-new-org/public/assets → public/letter-logo.png · letter-banner.png)
//   • ฟอนต์ TH SarabunPSK ขนาด 16 (ต้องมีฟอนต์ในเครื่องที่พิมพ์ — ไม่มีจะใช้ TH Sarabun New / Sarabun แทน)
//   • การอ้างอิง: Official ภายนอก = Contract No. · Official ภายใน = Job No. · SM / Warranty = 1. Contract No. 2. โครงการ Job No.
//
//   ความปลอดภัย: แท็บพิมพ์เปิดด้วย window.open('') = origin เดียวกับแอป (อ่าน session ของแอปได้)
//   ⇒ ข้อความผู้ใช้ escape ทุกช่อง (รวม " ') · รูป (ลายเซ็น/โลโก้) รับเฉพาะ data URL รูป หรือ https ที่ไม่มีอักขระพิเศษ
// =============================================================================
import { safeSigImage, parseTechList, thaiDateFull, type ServiceLetter } from '../data/letters'
import { bodyToHtml, resolveLetterImages } from '../data/letterRich'

export interface LetterOrg {
  name: string                  // ชื่อบริษัท (หัวกระดาษขวาบน + ท้ายกระดาษ)
  addressLines: string[]        // ที่อยู่ขวาบน
  tagline: string               // (ไม่ได้ใช้แล้วในหัวกระดาษ — คงไว้ให้ค่าเดิมเข้ากันได้)
  section: string               // ท้ายกระดาษ: ชื่อแผนก
  email: string
  logoUrl?: string              // โลโก้ (data URL / https) — ว่าง = ไม่วาด
  bannerUrl?: string            // แถบสีท้ายกระดาษ — ว่าง = ไม่วาด
  // ไม่มีลายเซ็นเริ่มต้น (คำตอบผู้ใช้ข้อ 4) — เซ็นอิเล็กทรอนิกส์ต่อฉบับ หรือเว้นที่เซ็นมือ
}

export const LETTER_ORG_DEFAULT: LetterOrg = {
  name: 'Precise System and Project Co., Ltd.',
  addressLines: ['1/333 Moo 9, Chaengwattana Road', 'Bangpood, Pakkred', 'Nonthaburi 1120 Thailand',
    'T : +66(0)2 584 2367', 'F : +66(0)2 584 2339'],
  tagline: 'PSP102 Service Maintenance & Support',
  section: 'Service & Maintenance Section',
  email: 'psp102.service@precise.co.th',
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const escBr = (s: unknown) => esc(s).replace(/\n/g, '<br>')
/** รูปที่วางใน src ได้: data URL รูป หรือ http(s) ที่ไม่มีอักขระที่หลุด attribute ได้ (http = dev localhost) */
function safeImgUrl(u?: string): string {
  const v = String(u ?? '')
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) return v
  if (/^https?:\/\/[^\s"'<>`]+$/.test(v)) return v
  return ''
}

/**
 * หัว/ท้ายกระดาษของ LBS — [ปรับ 2026-11-25] โลโก้ PRECISE + แถบสีตามไฟล์แนบ (public/letter-logo.png · letter-banner.png)
 *   ต้องเป็น URL เต็ม: แท็บพิมพ์ (about:blank) ใช้ path แบบ /letter-logo.png ไม่ได้ทุกเบราว์เซอร์
 *   หน้าเรียกด้วย lbsLetterOrg(window.location.origin)
 */
export function lbsLetterOrg(origin: string): LetterOrg {
  const o = origin.replace(/\/+$/, '')
  return { ...LETTER_ORG_DEFAULT, logoUrl: `${o}/letter-logo.png`, bannerUrl: `${o}/letter-banner.png` }
}

/**
 * [Word 2026-11-26] รูปแบบเนื้อความ HTML — ใช้ร่วมกันทั้งแท็บพิมพ์และหน้ากระดาษในตัวแก้ไข (เห็นเหมือนกัน)
 *   ย่อหน้าบรรทัดแรก 15 มม. · ชิดขอบสองด้าน · ตารางมีเส้น · รูปไม่ล้นหน้ากระดาษ
 */
export const LETTER_RICH_CSS = `
  .rich{margin-top:5mm;text-align:justify}
  .rich p{margin:0 0 2mm;text-indent:15mm}
  .rich li p,.rich td p,.rich th p{text-indent:0;margin:0}
  .rich ul,.rich ol{margin:0 0 2mm 15mm;padding-left:6mm}
  .rich blockquote{margin:0 0 2mm 15mm}
  .rich table{border-collapse:collapse;width:100%;margin:2mm 0 3mm}
  .rich td,.rich th{border:1px solid #475569;padding:1mm 2mm;vertical-align:top;text-indent:0;text-align:left}
  .rich th{background:#f1f5f9;font-weight:700}
  .rich img{max-width:100%;height:auto}`

// A4 ขอบ 0 · หัว/ท้ายกระดาษ fixed ซ้ำทุกหน้า · thead/tfoot เว้นที่ให้เนื้อหาไม่ทับ
const PRINT_PAGE = `
  @media print{
    @page{size:A4;margin:0}
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .ph{position:fixed;top:0}
    .pf{position:fixed;bottom:0}
    thead .hsp{height:44mm}
    tfoot .fsp{height:24mm}
    tr,td{break-inside:avoid}
  }`

// [ปรับ 2026-11-25] TH SarabunPSK ขนาด 16 (ผู้ใช้กำหนด) — หัว/ท้ายกระดาษตัวเล็กกว่าเนื้อความตามแบบ
const BASE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{margin:0;background:#fff}
  body{font-family:'TH SarabunPSK','TH Sarabun New','Sarabun',sans-serif;color:#1a2026;font-size:16pt;line-height:1.35}
  .ph,.pf{left:0;right:0;background:#fff}
  .sheet{width:100%;border-collapse:collapse}
  .hsp{height:0}.fsp{height:0}
  .ph{padding:9mm 15mm 3mm}
  .ph .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
  .ph img.logo{height:15mm;max-width:75mm;object-fit:contain;margin-top:3mm}
  .addr{text-align:right;font-size:12pt;line-height:1.3;color:#1a2026}
  .addr b{font-size:13pt;color:#16233f}
  .pf .contact{text-align:center;font-size:12pt;color:#16233f;padding:2mm 15mm 1.5mm;line-height:1.2}
  .pf .contact .en{font-weight:700}
  .pf .banner{display:block;width:100%;height:8mm;object-fit:cover}
  .sheet>tbody>tr>td{padding:0 15mm}
  .norow{display:flex;justify-content:space-between;align-items:baseline;margin-top:4mm}
  .ltype{font-size:12pt;letter-spacing:.5px;margin-top:1mm}
  .recip{margin-top:5mm}
  .frow{display:flex;gap:4mm;margin-top:3mm}
  .frow .k{font-weight:700;min-width:25mm;flex:0 0 auto}
  .frow .v{flex:1}
  .para{margin-top:5mm;text-indent:15mm;text-align:justify;white-space:pre-wrap}
  ${LETTER_RICH_CSS}
  .ack{margin-top:6mm;text-indent:15mm}
  .close{margin-top:6mm;text-align:center}
  .close img.sig{height:20mm;object-fit:contain;display:block;margin:2mm auto}
  .close .sig-space{height:20mm;width:60mm;margin:2mm auto;border-bottom:1px dotted #94a3b8}
  .close .signer{font-weight:700}
  .cc{margin-top:8mm;font-size:14pt;border-top:1px dashed #cbd5e1;padding-top:2mm}`

const ACCENT = { GENERAL: '#1a4d8f', SM: '#c0392b', WARRANTY: '#1a4d8f' } as const

const frow = (k: string, vHtml: string) => `<div class="frow"><div class="k">${k}</div><div class="v">${vHtml}</div></div>`

/** หน้ากระดาษร่วมทั้ง 3 แบบ: หัว (โลโก้ + ที่อยู่) · เลขที่/วันที่ · เนื้อหา · ลงนาม · ท้าย (แผนก/อีเมล + แถบสี) */
function pageShell(lt: ServiceLetter, org: LetterOrg, inner: string, extraCss = '', after = ''): string {
  const sig = safeSigImage(lt.sigImage)
  const logo = safeImgUrl(org.logoUrl)
  const banner = safeImgUrl(org.bannerUrl)
  const accent = ACCENT[lt.category] ?? ACCENT.GENERAL
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>${esc(lt.letterNo)}</title>
<style>${BASE_CSS}
  .norow{color:${accent}}${extraCss}${PRINT_PAGE}
</style></head><body>
  <div class="ph"><div class="top">${logo ? `<img class="logo" src="${logo}" alt="">` : '<span></span>'}<div class="addr"><b>${esc(org.name)}</b><br>${org.addressLines.map(esc).join('<br>')}</div></div></div>
  <table class="sheet">
    <thead><tr><td><div class="hsp"></div></td></tr></thead>
    <tbody><tr><td>
      <div class="norow"><span class="no">No. ${esc(lt.letterNo)}</span><span class="dt">${esc(thaiDateFull(lt.letterDate))}</span></div>
      ${inner}
      <div class="ack">จึงเรียนมาเพื่อโปรดทราบ</div>
      <div class="close">
        <div class="ty">ขอแสดงความนับถือ</div>
        ${sig ? `<img class="sig" src="${sig}" alt="">` : '<div class="sig-space"></div>'}<!-- ไม่มีลายเซ็นอิเล็กทรอนิกส์ = เว้นที่ให้เซ็นมือ (คำตอบผู้ใช้ข้อ 4) -->
        <div class="signer">( ${esc(lt.signerName || '—')} )</div>
        <div class="dept">${esc(lt.signerPosition || '')}</div>
      </div>
      ${after}
    </td></tr></tbody>
    <tfoot><tr><td><div class="fsp"></div></td></tr></tfoot>
  </table>
  <div class="pf"><div class="contact"><span class="en">${esc(org.section)}</span>, ${esc(org.name)}, Email: ${esc(org.email)}</div>${banner ? `<img class="banner" src="${banner}" alt="">` : ''}</div>
</body></html>`
}

/** SM / Warranty: อ้างอิง 1. Contract No. 2. โครงการ Job No. (ไม่มีทั้งคู่ = ไม่แสดง) */
function serviceRefs(lt: ServiceLetter, jobNo?: string): string {
  if (!lt.contractNo && !jobNo) return ''
  return frow('อ้างอิง', `1. Contract No. ${esc(lt.contractNo || '-')}<br>2. โครงการ Job No. ${esc(jobNo || '-')}`)
}

/** ส่วนบนของ SM / WARRANTY: ผู้รับ · เรื่อง (+สถานที่) · เรียน · อ้างอิง · อ้างถึง · ย่อหน้า */
function serviceHead(lt: ServiceLetter, rich: string, jobNo?: string): string {
  return `<div class="recip">${escBr(lt.recipient)}</div>
      ${frow('เรื่อง', `${esc(lt.subject)}${lt.site ? '<br>' + esc(lt.site) : ''}`)}
      ${frow('เรียน', esc(lt.attention || '—'))}
      ${serviceRefs(lt, jobNo)}
      ${lt.reference ? frow('อ้างถึง', esc(lt.reference)) : ''}
      <div class="rich">${rich}</div>
      ${lt.body2 ? `<div class="para">${esc(lt.body2)}</div>` : ''}`
}

function smLetter(lt: ServiceLetter, org: LetterOrg, rich: string, jobNo?: string): string {
  const techs = parseTechList(lt.techList).map((t, i) =>
    `<div class="tech"><div class="nm">${i + 1}. ${esc(t.name)}</div><div class="tph">${t.phone ? 'เบอร์ ' + esc(t.phone) : ''}</div></div>`).join('')
  return pageShell(lt, org, `${serviceHead(lt, rich, jobNo)}
      <div class="techs">${techs}</div>`, `
  .techs{margin-top:2mm}
  .tech{display:flex;gap:5mm;margin:1mm 0 1mm 15mm}
  .tech .nm{min-width:90mm}`)
}

function warrantyLetter(lt: ServiceLetter, org: LetterOrg, rich: string, jobNo?: string): string {
  const period = (lt.warrantyStart || lt.warrantyEnd)
    ? `${esc(thaiDateFull(lt.warrantyStart))} ถึง ${esc(thaiDateFull(lt.warrantyEnd))}` : '-'
  return pageShell(lt, org, `${serviceHead(lt, rich, jobNo)}
      <div class="wbox">
        <div class="wrow"><span class="wk">ประเภทการรับประกัน</span><span class="wv">${esc(lt.warrantyType || '-')}</span></div>
        <div class="wrow"><span class="wk">ระยะเวลารับประกัน</span><span class="wv">${period}</span></div>
        ${lt.warrantyDetail ? `<div class="wdetail">${escBr(lt.warrantyDetail)}</div>` : ''}
      </div>`, `
  .wbox{margin-top:5mm;border:1px solid #d7e0ea;border-radius:2mm;padding:3mm 5mm;background:#f7fafd}
  .wrow{display:flex;gap:4mm;margin:1mm 0}
  .wrow .wk{font-weight:700;min-width:45mm;color:#16233f}
  .wrow .wv{flex:1}
  .wdetail{margin-top:2mm;text-align:justify;border-top:1px dashed #cbd5e1;padding-top:2mm}`)
}

/** Official Letter — ภายนอกอ้างอิง Contract No. · ภายในอ้างอิง Job No. */
function officialLetter(lt: ServiceLetter, org: LetterOrg, rich: string, jobNo?: string): string {
  const internal = lt.letterType === 'INTERNAL'
  const typeLabel = internal ? 'หนังสือภายใน / Internal Memo' : 'หนังสือภายนอก / Official Letter'
  const ref = internal
    ? (jobNo ? frow('อ้างอิง', `โครงการ Job No. ${esc(jobNo)}`) : '')
    : (lt.contractNo ? frow('อ้างอิง', `Contract No. ${esc(lt.contractNo)}`) : '')
  return pageShell(lt, org, `<div class="ltype" style="color:${ACCENT.GENERAL}">${typeLabel}</div>
      ${frow('เรื่อง', esc(lt.subject))}
      ${frow('เรียน', esc(lt.recipient) + (lt.recipientOrg ? ` (${esc(lt.recipientOrg)})` : ''))}
      ${ref}
      ${lt.reference ? frow('อ้างถึง', esc(lt.reference)) : ''}
      ${lt.enclosure ? frow('สิ่งที่ส่งมาด้วย', esc(lt.enclosure)) : ''}
      <div class="rich">${rich}</div>`, '',
  lt.cc ? `<div class="cc"><b>สำเนาเรียน</b> ${esc(lt.cc)}</div>` : '')
}

/** HTML เอกสารพร้อมพิมพ์ตามประเภทจดหมาย · jobNo = เลข Job ที่อ้างถึง (หน้าเรียกหาเองจาก lt.jobId) */
export function buildLetterHtml(lt: ServiceLetter, org: LetterOrg = LETTER_ORG_DEFAULT, jobNo?: string,
  /** [Word 2026-11-26] token รูป → signed URL (LIVE) · ไม่ส่ง = รูปของระบบไม่ถูกวาด (data URL เดโมวาดได้เลย) */
  imgUrls: Record<string, string> = {}): string {
  // เนื้อความ: HTML ผ่าน sanitizer ทุกครั้ง (แท็บพิมพ์ = origin เดียวกับแอป) · จดหมายเก่าที่เป็นข้อความล้วน = ย่อหน้าละบรรทัด
  const rich = resolveLetterImages(bodyToHtml(lt.body), imgUrls)
  if (lt.category === 'SM') return smLetter(lt, org, rich, jobNo)
  if (lt.category === 'WARRANTY') return warrantyLetter(lt, org, rich, jobNo)
  return officialLetter(lt, org, rich, jobNo)
}

// ---------- เปิดแท็บพิมพ์ (ยกจาก ServiceMS openPrintWindow / writePrintWindow) ----------
// ต้องเปิดแท็บ "ตอนคลิก" (ก่อน await ใด ๆ) ไม่งั้น popup blocker บล็อก
export function openPrintWindow(): Window | null {
  const w = window.open('', '_blank')
  if (!w) { alert('กรุณาอนุญาต Pop-up ของเบราว์เซอร์ เพื่อเปิด/บันทึกเอกสาร PDF'); return null }
  try { w.document.write('<!doctype html><meta charset="utf-8"><title>กำลังเตรียมเอกสาร…</title><body style="font-family:sans-serif;color:#555;text-align:center;padding:48px">กำลังเตรียมเอกสาร…</body>') } catch { /* ignore */ }
  return w
}
/** เขียนเอกสาร + แถบปุ่ม "พิมพ์ / บันทึก PDF" (ซ่อนตอนพิมพ์) · เดสก์ท็อปสั่งพิมพ์อัตโนมัติ */
export function writePrintWindow(w: Window | null, html: string): void {
  if (!w) return
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  const bar = '<div class="__pbar" style="position:sticky;top:0;z-index:2147483647;display:flex;gap:10px;justify-content:center;padding:10px;background:#14224f">'
    + '<button type="button" onclick="window.print()" style="padding:11px 20px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;font-size:15px;cursor:pointer">🖨️ พิมพ์ / บันทึก PDF</button>'
    + '<button type="button" onclick="window.close()" style="padding:11px 18px;border:none;border-radius:8px;background:#fff;color:#14224f;font-weight:600;font-size:15px;cursor:pointer">ปิด</button>'
    + '</div><style>@media print{.__pbar{display:none!important}}</style>'
  let out = /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1${bar}`) : bar + html
  if (!isMobile) {
    const ap = '<scr' + 'ipt>window.addEventListener("load",function(){setTimeout(function(){try{window.focus();window.print()}catch(e){}},350)})</scr' + 'ipt>'
    out = out.replace(/<\/body>/i, `${ap}</body>`)
  }
  try { w.document.open(); w.document.write(out); w.document.close() } catch { /* ignore */ }
}
