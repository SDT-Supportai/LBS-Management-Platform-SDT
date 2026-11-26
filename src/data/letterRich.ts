// =============================================================================
// Letters แบบ Word (2026-11-26) — เนื้อความ HTML · รูป · ตรวจคำผิด · จัดรูปแบบอัตโนมัติ
//   ไม่มี dependency ใหม่: sanitizer เขียนเอง (ไม่ใช้ DOM ⇒ เทสต์บน node ได้ · ใช้ได้ทั้งตัวแก้ไขและแท็บพิมพ์)
//   เทสต์: letterRich.test.ts
//
//   🔴 ความปลอดภัย: เนื้อความถูกวางใน contentEditable และในแท็บพิมพ์ (window.open('') = origin เดียวกับแอป)
//      ⇒ "สร้างใหม่" จากรายการแท็ก/attribute/style ที่อนุญาตเท่านั้น — ไม่ส่งต่อ markup เดิมแม้แต่ตัวเดียว
//      ข้อความ escape ใหม่ทั้งหมด · DB (0103) กันชั้นที่ 2: ปฏิเสธ <script / on*= / javascript:
// =============================================================================

/** src ของรูปในเนื้อความ = "lbsimg:" + path ใน bucket letter-docs (ไม่เก็บ signed URL ที่หมดอายุลง DB) */
export const LETTER_IMG_PREFIX = 'lbsimg:letter-img/'
const IMG_TOKEN_RE = /^lbsimg:letter-img\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/
const IMG_DATA_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const IMG_DATA_MAX = 1_500_000
/** path ใน bucket ของ token รูป (lbsimg:letter-img/x.jpg → letter-img/x.jpg) */
export const imgStoragePath = (token: string) => token.replace(/^lbsimg:/, '')

// ---------------- sanitizer ----------------
const VOID = new Set(['br', 'img'])
// แท็กที่อนุญาต → ชื่อแท็กที่เขียนออก (div จาก contentEditable = ย่อหน้า)
const TAGS: Record<string, string> = {
  p: 'p', div: 'p', br: 'br', b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', span: 'span',
  ul: 'ul', ol: 'ol', li: 'li', blockquote: 'blockquote',
  table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', td: 'td', th: 'th', img: 'img',
}
// แท็กที่ตัดทิ้ง "ทั้งเนื้อใน" (ไม่ใช่แค่ตัวแท็ก)
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'textarea', 'template', 'noscript', 'svg', 'math', 'title', 'head'])
const STYLE_TAGS = new Set(['p', 'span', 'li', 'td', 'th', 'table', 'blockquote', 'img'])
const LEN = '(?:\\d{1,3}(?:\\.\\d{1,2})?)(?:px|pt|mm|em|%)'
const STYLE_RULES: Record<string, RegExp> = {
  'text-align': /^(left|center|right|justify)$/,
  'font-size': /^(?:(?:[89]|[1-6]\d|7[0-2])(?:\.\d)?pt|(?:1[0-9]|[2-8]\d|9[0-6])px)$/,   // 8–72pt · 10–96px
  'font-weight': /^(bold|normal|[1-9]00)$/,
  'font-style': /^(italic|normal)$/,
  'text-decoration': /^(underline|none|line-through)$/,
  'text-decoration-line': /^(underline|none|line-through)$/,
  'text-indent': new RegExp(`^${LEN}$`),
  'margin-left': new RegExp(`^${LEN}$`),
  'padding-left': new RegExp(`^${LEN}$`),
  'width': new RegExp(`^${LEN}$`),
  'vertical-align': /^(top|middle|bottom)$/,
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (ENT[k] != null) return ENT[k]
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m
  })
}
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function cleanStyle(raw: string): string {
  const out: string[] = []
  for (const decl of raw.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const val = decl.slice(i + 1).trim().toLowerCase().replace(/\s+/g, ' ')
    const rule = STYLE_RULES[prop]
    if (rule && rule.test(val)) out.push(`${prop}:${val}`)
  }
  return out.join(';')
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
function parseAttrs(s: string): Record<string, string> {
  const a: Record<string, string> = {}
  for (const m of s.matchAll(ATTR_RE)) {
    const k = m[1].toLowerCase()
    if (!(k in a)) a[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return a
}

/** แท็กเปิดที่เขียนออก (null = ทิ้งทั้งแท็ก เช่น รูปที่ src ไม่ผ่าน) */
function buildOpen(tag: string, a: Record<string, string>): string | null {
  const parts: string[] = []
  if (tag === 'img') {
    // data-path = รูปที่ resolve เป็น signed URL ตอนแสดง ⇒ แปลงกลับเป็น token (ไม่เก็บ URL ที่หมดอายุ)
    const src = a['data-path'] != null ? a['data-path'] : a.src ?? ''
    const ok = IMG_TOKEN_RE.test(src) || (src.length <= IMG_DATA_MAX && IMG_DATA_RE.test(src))
    if (!ok) return null
    parts.push(`src="${escText(src)}"`)
  }
  if ((tag === 'td' || tag === 'th')) {
    for (const k of ['colspan', 'rowspan']) {
      const n = Number(a[k])
      if (a[k] != null && Number.isInteger(n) && n >= 1 && n <= 20) parts.push(`${k}="${n}"`)
    }
  }
  if (STYLE_TAGS.has(tag) && a.style) {
    const st = cleanStyle(a.style)
    if (st) parts.push(`style="${escText(st)}"`)
  }
  return `<${tag}${parts.length ? ' ' + parts.join(' ') : ''}>`
}

const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>|[^<]+|</g

/** สร้าง HTML ใหม่จากรายการที่อนุญาต · แท็กเปิดค้าง/ปิดผิดลำดับถูกจัดให้ถูก */
export function sanitizeLetterHtml(html: string): string {
  const src = String(html ?? '')
  const out: string[] = []
  const stack: string[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(src))) {
    const tok = m[0]
    if (tok.startsWith('<!--')) continue
    if (tok === '<' || !m[1]) {                     // ข้อความ (รวม "<" ที่ไม่ใช่แท็ก)
      out.push(escText(decodeEntities(tok)))
      continue
    }
    const name = m[1].toLowerCase()
    const closing = tok.startsWith('</')
    if (!closing && DROP_WITH_CONTENT.has(name)) {   // ข้ามจนถึงแท็กปิด (ไม่มี = ทิ้งที่เหลือทั้งหมด)
      const end = src.toLowerCase().indexOf(`</${name}`, TOKEN_RE.lastIndex)
      if (end < 0) break
      const gt = src.indexOf('>', end)
      TOKEN_RE.lastIndex = gt < 0 ? src.length : gt + 1
      continue
    }
    const tag = TAGS[name]
    if (!tag) continue                              // แท็กไม่รู้จัก: ทิ้งตัวแท็ก เก็บข้อความข้างใน
    if (closing) {
      if (VOID.has(tag)) continue
      const at = stack.lastIndexOf(tag)
      if (at < 0) continue
      while (stack.length > at) out.push(`</${stack.pop()}>`)
      continue
    }
    const open = buildOpen(tag, parseAttrs(m[2] ?? ''))
    if (open == null) continue
    out.push(open)
    if (!VOID.has(tag)) stack.push(tag)
  }
  while (stack.length) out.push(`</${stack.pop()}>`)
  return out.join('').replace(/<p><\/p>/g, '<p><br></p>')
}

// ---------------- เนื้อความเก่า (ข้อความล้วน) / HTML ----------------
const RICH_RE = /^\s*<(p|div|ul|ol|table|blockquote|img|span|b|i|u|strong|em|br)\b/i
export const isRichBody = (s?: string) => RICH_RE.test(String(s ?? ''))

/** เนื้อความ → HTML ที่ปลอดภัย · จดหมายเก่าที่เป็นข้อความล้วน = ย่อหน้าละบรรทัด */
export function bodyToHtml(s?: string): string {
  const v = String(s ?? '')
  if (!v.trim()) return ''
  if (isRichBody(v)) return sanitizeLetterHtml(v)
  return v.split('\n').map(line => line.trim() ? `<p>${escText(line)}</p>` : '<p><br></p>').join('')
}

/** HTML → ข้อความล้วน (ค้นหา · ตรวจคำผิด · ข้อความแจ้งเตือน) */
export function richToPlainText(s?: string): string {
  const v = String(s ?? '')
  if (!isRichBody(v)) return v
  return decodeEntities(v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|blockquote|h\d)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]*>/g, ''))
    .replace(/\t\n/g, '\n').replace(/\n+$/, '')
}

// ---------------- รูป ----------------
/** token รูปของระบบในเนื้อความ (ไม่ซ้ำ) — ใช้ขอ signed URL / ลบไฟล์ที่ไม่ใช้แล้ว */
export function letterImagePaths(html?: string): string[] {
  const out = new Set<string>()
  for (const m of String(html ?? '').matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)) if (IMG_TOKEN_RE.test(m[1])) out.add(m[1])
  return [...out]
}

/**
 * แทน token รูปด้วย URL สำหรับแสดง (signed URL) + data-path ไว้แปลงกลับตอนบันทึก
 *   ไม่มี URL ของรูปนั้น / URL ไม่ปลอดภัย = ตัดรูปทิ้ง (ไม่วาด <img> ที่เปิดไม่ได้)
 */
export function resolveLetterImages(html: string, urls: Record<string, string>): string {
  return sanitizeLetterHtml(html).replace(/<img src="([^"]+)"([^>]*)>/g, (all, src: string, rest: string) => {
    if (!IMG_TOKEN_RE.test(src)) return all                      // data URL (โหมดเดโม) แสดงได้เลย
    const url = urls[src]
    if (!url || !/^https?:\/\/[^\s"'<>`]+$/.test(url)) return ''
    return `<img src="${escText(url)}"${rest} data-path="${src}">`
  })
}

// ---------------- ตรวจคำผิด (พจนานุกรมในระบบ) ----------------
/**
 * คำที่มักเขียนผิด → คำที่ถูก (ราชบัณฑิตยสถาน · คำที่พบบ่อยในจดหมายธุรกิจ)
 *   🔴 ภาษาไทยไม่มีช่องว่างคั่นคำ ⇒ จับคำผิดแบบ "สตริงย่อย" — ทุกคำต้องไม่เป็นส่วนหนึ่งของคำที่ถูก
 *      (เช่น ห้ามใส่ "กฏ" เดี่ยว ๆ เพราะอยู่ใน "ปรากฏ") · เพิ่มคำ = เพิ่มเทสต์ใน letterRich.test.ts
 */
export const THAI_MISSPELLINGS: Readonly<Record<string, string>> = {
  'อนุญาติ': 'อนุญาต', 'กฏหมาย': 'กฎหมาย', 'กฏระเบียบ': 'กฎระเบียบ', 'กฏเกณฑ์': 'กฎเกณฑ์', 'ปรากฎ': 'ปรากฏ',
  'ปฎิบัติ': 'ปฏิบัติ', 'สังเกตุ': 'สังเกต', 'ลายเซ็นต์': 'ลายเซ็น', 'เซ็นต์ชื่อ': 'เซ็นชื่อ', 'มาตราฐาน': 'มาตรฐาน',
  'ผลลัพท์': 'ผลลัพธ์', 'ประณีประนอม': 'ประนีประนอม', 'ศรีษะ': 'ศีรษะ', 'ไอศครีม': 'ไอศกรีม', 'โอกาศ': 'โอกาส',
  'รสชาด': 'รสชาติ', 'ดำริห์': 'ดำริ', 'ทะยอย': 'ทยอย', 'ทนุถนอม': 'ทะนุถนอม', 'บันทัดฐาน': 'บรรทัดฐาน',
  'ผาสุข': 'ผาสุก', 'ภาพยนต์': 'ภาพยนตร์', 'จราจล': 'จลาจล', 'ฉนั้น': 'ฉะนั้น', 'นานับประการ': 'นานัปการ',
  'กงศุล': 'กงสุล', 'กระเพรา': 'กะเพรา', 'กาละเทศะ': 'กาลเทศะ', 'คลิ๊ก': 'คลิก', 'โควต้า': 'โควตา',
  'เปอร์เซนต์': 'เปอร์เซ็นต์', 'ออฟฟิต': 'ออฟฟิศ', 'อีเมล์': 'อีเมล', 'ซอฟแวร์': 'ซอฟต์แวร์',
  'อินเตอร์เน็ต': 'อินเทอร์เน็ต', 'เวปไซต์': 'เว็บไซต์', 'เว็ปไซต์': 'เว็บไซต์', 'เว็บไซด์': 'เว็บไซต์',
  'แอพพลิเคชั่น': 'แอปพลิเคชัน', 'ประมาน': 'ประมาณ', 'กรุนา': 'กรุณา', 'ประสงส์': 'ประสงค์', 'อุปกรน์': 'อุปกรณ์',
  'ติดตั่ง': 'ติดตั้ง', 'ผู้อำนายการ': 'ผู้อำนวยการ', 'อะไหร่': 'อะไหล่', 'ขอบคุน': 'ขอบคุณ', 'อณุเคราะห์': 'อนุเคราะห์',
  'พิจรณา': 'พิจารณา', 'ผลิตพันธ์': 'ผลิตภัณฑ์', 'สถานการน์': 'สถานการณ์', 'ค่าใช่จ่าย': 'ค่าใช้จ่าย',
  'เปลี่ยนแปรง': 'เปลี่ยนแปลง', 'สับดาห์': 'สัปดาห์', 'กระทันหัน': 'กะทันหัน',
}
export interface Misspelling { wrong: string; right: string; index: number }

/** หาคำที่อาจผิดในข้อความ เรียงตามตำแหน่ง · คำยาวกว่าชนะเมื่อทับกัน */
export function findMisspellings(text: string): Misspelling[] {
  const hits: Misspelling[] = []
  const words = Object.keys(THAI_MISSPELLINGS).sort((a, b) => b.length - a.length)
  const taken: [number, number][] = []
  for (const w of words) {
    let i = text.indexOf(w)
    while (i >= 0) {
      const end = i + w.length
      if (!taken.some(([s, e]) => i < e && end > s)) {
        hits.push({ wrong: w, right: THAI_MISSPELLINGS[w], index: i })
        taken.push([i, end])
      }
      i = text.indexOf(w, end)
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}
export function fixMisspellings(text: string): string {
  let out = ''
  let at = 0
  for (const h of findMisspellings(text)) { out += text.slice(at, h.index) + h.right; at = h.index + h.wrong.length }
  return out + text.slice(at)
}

// ---------------- จัดรูปแบบประโยคอัตโนมัติ ----------------
const TH = 'ก-ๅ็-๎'          // อักษร/สระ/วรรณยุกต์ไทย (ไม่รวม ๆ และเลขไทย)
/**
 * จัดวรรคตามแบบหนังสือราชการ: ช่องว่างซ้ำ → 1 · ไม้ยมกมีวรรคหน้า-หลัง · เว้นวรรคระหว่างอักษรไทยกับอังกฤษ/ตัวเลข
 *   trim=false ใช้กับ text node ทีละชิ้นในตัวแก้ไข (ไม่ตัดช่องว่างที่คั่นกับแท็กข้าง ๆ)
 */
export function autoFormatThai(text: string, opts: { trim?: boolean } = {}): string {
  let s = String(text ?? '').replace(/[ \t ]+/g, ' ')
  s = s.replace(/ ?ๆ ?/g, ' ๆ ')
  s = s.replace(new RegExp(`([${TH}])([A-Za-z0-9])`, 'g'), '$1 $2').replace(new RegExp(`([A-Za-z0-9])([${TH}])`, 'g'), '$1 $2')
  s = s.replace(/ {2,}/g, ' ').replace(/ ๆ $/, ' ๆ')
  return opts.trim === false ? s : s.trim()
}
