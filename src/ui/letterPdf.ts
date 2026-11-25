// =============================================================================
// เอกสารพิมพ์ Service Letter — ยกแม่แบบจาก ServiceMS (smLetter / warrantyLetter / Official Letter ใน buildPdf)
//   LBS ไม่มี Edge Function ⇒ สร้าง HTML ฝั่งเบราว์เซอร์ แล้วเปิดแท็บพิมพ์ (ผู้ใช้กด "บันทึกเป็น PDF")
//   ⚠️ ยังไม่ผูกเข้าเมนู — ดู docs/service-letter-integration.md · เทสต์: letterPdf.test.ts
//
//   ความปลอดภัย: แท็บพิมพ์เปิดด้วย window.open('') = origin เดียวกับแอป (อ่าน session ของแอปได้)
//   ⇒ ข้อความผู้ใช้ escape ทุกช่อง (รวม " ') · รูป (ลายเซ็น/โลโก้) รับเฉพาะ data URL รูป หรือ https ที่ไม่มีอักขระพิเศษ
// =============================================================================
import { safeSigImage, parseTechList, type ServiceLetter } from '../data/letters'

export interface LetterOrg {
  name: string                  // ชื่อบริษัท (หัวกระดาษ)
  addressLines: string[]        // ที่อยู่ขวาบน (SM / WARRANTY)
  tagline: string               // บรรทัดใต้ชื่อ (Official Letter)
  section: string               // ท้ายกระดาษ: ชื่อแผนก
  email: string
  logoUrl?: string              // โลโก้ (data URL / https) — ว่าง = ไม่วาด
  bannerUrl?: string            // แถบสีท้ายกระดาษ (SM / WARRANTY) — ว่าง = ไม่วาด
  // ไม่มีลายเซ็นเริ่มต้น (คำตอบผู้ใช้ข้อ 4) — เซ็นอิเล็กทรอนิกส์ต่อฉบับ หรือเว้นที่เซ็นมือ
}

// ⚠️ template: ค่าหัว/ท้ายกระดาษจากชุดต้นแบบ ServiceMS — ยืนยันกับผู้ใช้ก่อนเปิดใช้จริง
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
const dmy = (s?: string, sep = '/') => {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}${sep}${m[2]}${sep}${m[1]}` : esc(s || '—')
}
/** รูปที่วางใน src ได้: data URL รูป หรือ http(s) ที่ไม่มีอักขระที่หลุด attribute ได้ (http = dev localhost) */
function safeImgUrl(u?: string): string {
  const v = String(u ?? '')
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) return v
  if (/^https?:\/\/[^\s"'<>`]+$/.test(v)) return v
  return ''
}

/**
 * หัวกระดาษของ LBS — คำตอบผู้ใช้ข้อ 3: ข้อมูลตามแม่แบบ + โลโก้ LBS เดิม (public/logo.jpg)
 *   ต้องเป็น URL เต็ม: แท็บพิมพ์ (about:blank) ใช้ path แบบ /logo.jpg ไม่ได้ทุกเบราว์เซอร์
 *   หน้าเรียกด้วย lbsLetterOrg(window.location.origin)
 */
export function lbsLetterOrg(origin: string): LetterOrg {
  return { ...LETTER_ORG_DEFAULT, logoUrl: `${origin.replace(/\/+$/, '')}/logo.jpg` }
}

const PRINT_PAGE = (head: string, foot: string) => `
  @media print{
    @page{size:A4;margin:0}
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .ph{position:fixed;top:0}
    .pf{position:fixed;bottom:0}
    thead .hsp{height:${head}}
    tfoot .fsp{height:${foot}}
    tr,td{break-inside:avoid}
  }`

const BASE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{margin:0;background:#fff}
  body{font-family:'Sarabun','TH Sarabun New','IBM Plex Sans Thai','Segoe UI',sans-serif;color:#1a2026;font-size:15.5px;line-height:1.85}
  .ph,.pf{left:0;right:0;background:#fff}
  .sheet{width:100%;border-collapse:collapse}
  .hsp{height:0}.fsp{height:0}`

/** หัว/ท้าย + ส่วนลงนาม ร่วมกันของ SM และ WARRANTY (ต้นฉบับซ้ำโค้ดกัน 2 ชุด) */
function serviceShell(lt: ServiceLetter, org: LetterOrg, accent: string, middle: string, extraCss: string): string {
  const sig = safeSigImage(lt.sigImage)
  const logo = safeImgUrl(org.logoUrl)
  const banner = safeImgUrl(org.bannerUrl)
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>${esc(lt.letterNo)}</title>
<style>${BASE_CSS}
  .ph{padding:18px 54px 8px}
  .ph .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
  .ph img.logo{height:52px;object-fit:contain}
  .addr{text-align:right;font-size:11.5px;line-height:1.5}
  .addr b{font-size:12.5px;color:#16233f}
  .pf .contact{text-align:center;font-size:12px;color:#16233f;padding:8px 40px 4px;line-height:1.45}
  .pf .contact .en{font-weight:700}
  .pf .banner{display:block;width:100%;height:7mm;object-fit:cover}
  .sheet>tbody>tr>td{padding:0 54px}
  .norow{display:flex;justify-content:space-between;align-items:baseline;margin-top:6px;font-weight:700;color:${accent};font-size:16px}
  .recip{margin-top:14px;line-height:1.7}
  .frow{display:flex;gap:10px;margin-top:6px}
  .frow .k{font-weight:700;min-width:62px;flex:0 0 auto}
  .frow .v{flex:1}
  .para{margin-top:14px;text-indent:48px;text-align:justify}
  .ack{margin-top:16px;text-indent:48px}
  .close{margin-top:14px;text-align:center}
  .close .ty{margin-bottom:2px}
  .close img.sig{height:66px;object-fit:contain;display:block;margin:2px auto}
  .close .sig-space{height:66px;width:220px;margin:2px auto;border-bottom:1px dotted #94a3b8}
  .close .signer{font-weight:700}${extraCss}${PRINT_PAGE('34mm', '20mm')}
</style></head><body>
  <div class="ph"><div class="top">${logo ? `<img class="logo" src="${logo}" alt="">` : '<span></span>'}<div class="addr"><b>${esc(org.name)}</b><br>${org.addressLines.map(esc).join('<br>')}</div></div></div>
  <table class="sheet">
    <thead><tr><td><div class="hsp"></div></td></tr></thead>
    <tbody><tr><td>
      <div class="norow"><span class="no">No. ${esc(lt.letterNo)}</span><span class="dt">${dmy(lt.letterDate, '-')}</span></div>
      <div class="recip">${escBr(lt.recipient)}</div>
      <div class="frow"><div class="k">เรื่อง</div><div class="v">${esc(lt.subject)}${lt.site ? '<br>' + esc(lt.site) : ''}</div></div>
      <div class="frow"><div class="k">เรียน</div><div class="v">${esc(lt.attention || '—')}</div></div>
      ${lt.reference ? `<div class="frow"><div class="k">อ้างถึง</div><div class="v">${esc(lt.reference)}</div></div>` : ''}
      <div class="para">${esc(lt.body)}</div>
      ${lt.body2 ? `<div class="para">${esc(lt.body2)}</div>` : ''}
      ${middle}
      <div class="ack">จึงเรียนมาเพื่อโปรดทราบ</div>
      <div class="close">
        <div class="ty">ขอแสดงความนับถือ</div>
        ${sig ? `<img class="sig" src="${sig}" alt="">` : '<div class="sig-space"></div>'}<!-- ไม่มีลายเซ็นอิเล็กทรอนิกส์ = เว้นที่ให้เซ็นมือ (คำตอบผู้ใช้ข้อ 4) -->
        <div class="signer">( ${esc(lt.signerName || '—')} )</div>
        <div class="dept">${esc(lt.signerPosition || '')}</div>
      </div>
    </td></tr></tbody>
    <tfoot><tr><td><div class="fsp"></div></td></tr></tfoot>
  </table>
  <div class="pf"><div class="contact"><span class="en">${esc(org.section)}</span>, ${esc(org.name)}, Email: ${esc(org.email)}</div>${banner ? `<img class="banner" src="${banner}" alt="">` : ''}</div>
</body></html>`
}

function smLetter(lt: ServiceLetter, org: LetterOrg): string {
  const techs = parseTechList(lt.techList).map((t, i) =>
    `<div class="tech"><div class="nm">${i + 1}. ${esc(t.name)}</div><div class="tph">${t.phone ? 'เบอร์ ' + esc(t.phone) : ''}</div></div>`).join('')
  return serviceShell(lt, org, '#c0392b', `<div class="techs">${techs}</div>`, `
  .techs{margin-top:8px}
  .tech{display:flex;gap:14px;margin:2px 0 2px 48px}
  .tech .nm{min-width:320px}`)
}

function warrantyLetter(lt: ServiceLetter, org: LetterOrg): string {
  const period = (lt.warrantyStart || lt.warrantyEnd)
    ? `${lt.warrantyStart ? dmy(lt.warrantyStart, '-') : '-'} ถึง ${lt.warrantyEnd ? dmy(lt.warrantyEnd, '-') : '-'}` : '-'
  return serviceShell(lt, org, '#1a4d8f', `<div class="wbox">
        <div class="wrow"><span class="wk">ประเภทการรับประกัน</span><span class="wv">${esc(lt.warrantyType || '-')}</span></div>
        <div class="wrow"><span class="wk">ระยะเวลารับประกัน</span><span class="wv">${period}</span></div>
        ${lt.warrantyDetail ? `<div class="wdetail">${escBr(lt.warrantyDetail)}</div>` : ''}
      </div>`, `
  .wbox{margin-top:16px;border:1px solid #d7e0ea;border-radius:8px;padding:12px 16px;background:#f7fafd}
  .wrow{display:flex;gap:10px;margin:3px 0}
  .wrow .wk{font-weight:700;min-width:150px;color:#16233f}
  .wrow .wv{flex:1}
  .wdetail{margin-top:8px;text-align:justify;border-top:1px dashed #cbd5e1;padding-top:8px}`)
}

function officialLetter(lt: ServiceLetter, org: LetterOrg, jobNo?: string): string {
  const row = (k: string, v?: string) => v ? `<div class="lrow"><div class="lk">${k}</div><div class="lc">:</div><div class="lv">${esc(v)}</div></div>` : ''
  const typeLabel = lt.letterType === 'INTERNAL' ? 'หนังสือภายใน / Internal Memo' : 'หนังสือภายนอก / Official Letter'
  const logo = safeImgUrl(org.logoUrl)
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>Letter ${esc(lt.letterNo)}</title>
<style>${BASE_CSS}
  body{color:#16202e;font-size:15px;line-height:1.75}
  .topbar{height:6px;background:linear-gradient(90deg,#1a4d8f,#16233f)}
  .lh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #16233f;margin:0 46px;padding:12px 0}
  .co{display:flex;gap:13px;align-items:center}
  .lg{width:54px;height:54px;border-radius:11px;overflow:hidden;background:#fff;border:1px solid #e2e8f0;flex:0 0 auto}
  .lg img{width:100%;height:100%;object-fit:contain}
  .cn{font-weight:700;font-size:18px;color:#16233f;letter-spacing:.3px}
  .ca{font-size:11.5px;color:#64748b;margin-top:2px}
  .ltype{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#1a4d8f;font-weight:700;margin-top:4px}
  .meta{text-align:right;font-size:13.5px;min-width:185px}
  .meta .mrow{margin-bottom:3px}
  .meta b{color:#16233f}
  .meta .no{font-family:'Courier New',monospace;font-weight:700;font-size:15px;color:#1a4d8f}
  .pf .foot{text-align:center;font-size:12px;color:#16233f;border-top:1px solid #eef2f7;padding:7px 40px;line-height:1.45}
  .pf .foot .en{font-weight:700}
  .sheet>tbody>tr>td{padding:0 46px}
  .subj{margin:6px 0;font-weight:700;font-size:15.5px}
  .lrow{display:flex;gap:6px;margin:5px 0}
  .lk{font-weight:700;min-width:96px}.lc{width:8px}.lv{flex:1}
  .body{margin:20px 0;white-space:pre-wrap;text-align:justify;text-indent:48px}
  .close{margin-top:30px;margin-left:auto;width:300px;text-align:center}
  .close .ty{margin-bottom:60px}
  .close .nm{font-weight:700}
  .close .ps{font-size:13.5px;color:#475569}
  .cc{margin-top:34px;font-size:13px;color:#475569;border-top:1px dashed #cbd5e1;padding-top:8px}${PRINT_PAGE('28mm', '15mm')}
</style></head><body>
  <div class="ph"><div class="topbar"></div><div class="lh"><div class="co">${logo ? `<div class="lg"><img src="${logo}" alt=""></div>` : ''}<div><div class="cn">${esc(org.name)}</div><div class="ca">${esc(org.tagline)}</div><div class="ltype">${typeLabel}</div></div></div><div class="meta"><div class="mrow"><b>เลขที่</b> <span class="no">${esc(lt.letterNo)}</span></div><div class="mrow"><b>วันที่</b> ${dmy(lt.letterDate)}</div></div></div></div>
  <table class="sheet">
    <thead><tr><td><div class="hsp"></div></td></tr></thead>
    <tbody><tr><td>
      <div class="subj">เรื่อง&nbsp;&nbsp;&nbsp;${esc(lt.subject)}</div>
      ${row('เรียน', lt.recipient + (lt.recipientOrg ? `  (${lt.recipientOrg})` : ''))}
      ${row('อ้างถึง', lt.reference)}
      ${row('สิ่งที่ส่งมาด้วย', lt.enclosure)}
      ${row('อ้างอิงโครงการ', jobNo)}
      <div class="body">${esc(lt.body)}</div>
      <div class="close">
        <div class="ty">ขอแสดงความนับถือ</div>
        <div class="nm">${esc(lt.signerName || '')}</div>
        <div class="ps">${esc(lt.signerPosition || '')}</div>
      </div>
      ${lt.cc ? `<div class="cc"><b>สำเนาเรียน</b> ${esc(lt.cc)}</div>` : ''}
    </td></tr></tbody>
    <tfoot><tr><td><div class="fsp"></div></td></tr></tfoot>
  </table>
  <div class="pf"><div class="foot"><span class="en">${esc(org.section)}</span>, ${esc(org.name)}, Email: ${esc(org.email)}</div></div>
</body></html>`
}

/** HTML เอกสารพร้อมพิมพ์ตามประเภทจดหมาย · jobNo = เลข Job ที่อ้างถึง (หน้าเรียกหาเองจาก lt.jobId) */
export function buildLetterHtml(lt: ServiceLetter, org: LetterOrg = LETTER_ORG_DEFAULT, jobNo?: string): string {
  if (lt.category === 'SM') return smLetter(lt, org)
  if (lt.category === 'WARRANTY') return warrantyLetter(lt, org)
  return officialLetter(lt, org, jobNo)
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
