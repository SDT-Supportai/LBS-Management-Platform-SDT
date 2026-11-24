// =============================================================================
// ธีม LBS Glass UI (2026-11-24) — ตรวจ styles.css ตรง ๆ (ธีมเป็น CSS ล้วน ไม่แตะ logic)
//   แบบ: canvas "LBS Glass UI" หน้า 02–15 = กระจกโทนสว่าง (พื้น #eef2fb · แผงขาวโปร่ง · ขอบขาว · เงานุ่ม)
//   🔴 ด่านสำคัญ: ห้ามใส่ backdrop-filter ให้ .panel / .card ทั้งแอป — Popup ทุกตัวไม่ได้ใช้ portal
//      (วาดอยู่ในแผง) · backdrop-filter ทำให้ position:fixed ของลูกยึดกับแผงแทนหน้าจอ
//      ⇒ Popup ถูกตัดอยู่ในกรอบแผง · แผนที่เต็มจอหลุดตำแหน่ง · มือถือช่างกระตุก (blur ทุกแผง)
//      ได้หน้าตากระจกจากพื้นโปร่ง + ขอบขาว + เงา บนพื้นไล่สีนิ่งแทน (พื้นเบลออยู่แล้ว blur ซ้ำมองไม่เห็นต่าง)
// =============================================================================
import { describe, it, expect } from 'vitest'
// อ่านไฟล์ตรงจากดิสก์ — `?raw` ของ Vite ใช้ไม่ได้ (vitest ไม่ประมวลผล CSS → ได้ข้อความว่าง)
//   โปรเจกต์ไม่มี @types/node (โค้ดแอปรันบนเบราว์เซอร์) จึงยกเว้น type เฉพาะบรรทัดนี้
// @ts-ignore — node:fs มีจริงตอนรัน vitest (Node) แต่ tsconfig ของแอปไม่รู้จัก
import { readFileSync } from 'node:fs'
const raw: string = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/** กฎทั้งหมด (selector, declarations, อยู่ใน @media อะไร) — parser ง่าย ๆ พอสำหรับไฟล์นี้ */
function rules(): { sel: string; body: string; media: string }[] {
  const out: { sel: string; body: string; media: string }[] = []
  const walk = (src: string, media: string) => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf('{', i)
      if (open < 0) break
      const head = src.slice(i, open).trim()
      // หาวงเล็บปิดที่คู่กัน
      let depth = 1, j = open + 1
      while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++ }
      const inner = src.slice(open + 1, j - 1)
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(inner, `${media} ${head}`.trim())
      else if (!head.startsWith('@')) out.push({ sel: head, body: inner, media })
      i = j
    }
  }
  walk(css, '')
  return out
}
const R = rules()
const sels = (r: { sel: string }) => r.sel.split(',').map(s => s.trim())

describe('ธีม Glass — ด่านกันพัง (backdrop-filter)', () => {
  it('🔴 backdrop-filter อยู่ได้เฉพาะจุดที่ไม่มี Popup/แผนที่เต็มจอซ้อนอยู่ข้างใน', () => {
    const ALLOWED = [/^\.modal-overlay$/, /^\.modal$/, /^\.gl-/, /^\.dash \.(card|panel)$/]
    const bad = R.filter(r => /backdrop-filter/.test(r.body))
      .flatMap(sels).filter(s => !ALLOWED.some(a => a.test(s)))
    expect(bad).toEqual([])
  })
})

describe('ธีม Glass — หน้าตาตามแบบ', () => {
  const root = R.find(r => r.sel === ':root' && !r.media)!
  it('token พื้นหน้า = #eef2fb ตามแบบ · มี token แผงกระจก', () => {
    expect(root.body).toMatch(/--bg:\s*#eef2fb/i)
    expect(root.body).toMatch(/--glass-bg:/)
    expect(root.body).toMatch(/--glass-line:/)
    expect(root.body).toMatch(/--glass-shadow:/)
  })
  it('--surface ถูกนิยาม (เดิมอ้างใน .today-card / .mp-detail / .btn-like แต่ไม่มีค่าจริง)', () => {
    expect(root.body).toMatch(/--surface:/)
  })
  it('แผง/การ์ด/แถบขั้นต่อไป ใช้พื้นกระจก (ไม่ใช่ขาวทึบ) นอกเวลาพิมพ์', () => {
    for (const cls of ['.panel', '.card', '.next-step']) {
      const r = R.filter(x => !/print/.test(x.media) && sels(x).includes(cls) && /background:\s*var\(--glass-bg\)/.test(x.body))
      expect(r.length, cls).toBeGreaterThan(0)
    }
  })
  it('ตัวอักษรจาง (--muted) อ่านผ่าน WCAG AA ≥4.5:1 บนพื้นหน้าใหม่ · แผง · พื้นฟ้าอ่อน/เหลืองอ่อน', () => {
    const tok = (n: string) => root.body.match(new RegExp(`--${n}:\\s*(#[0-9a-f]{6})`, 'i'))![1]
    const lum = (h: string) => {
      const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]
    }
    const ratio = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
    const muted = tok('muted')
    for (const bg of ['bg', 'primary-soft', 'amber-soft']) expect(ratio(muted, tok(bg)), bg).toBeGreaterThanOrEqual(4.5)
    // จุดกลางแสงพื้นหลัง (#b9c8ff โปร่ง .35 บน #eef2fb ≈ #dfe6fd) — ตัวอักษรบนพื้นหน้าตรงนั้นต้องยังผ่าน
    expect(ratio(muted, '#dfe6fd')).toBeGreaterThanOrEqual(4.5)
  })

  it('🔴 ชื่อแอปบนหัวมือถือเป็นตัวขาว — เดิมกฎ b { color: var(--text) } ทับ ⇒ ตัวเข้มบนพื้นกรมท่า มองไม่เห็น', () => {
    expect(R.some(x => sels(x).includes('.mobile-header b') && /color:\s*#fff\b/i.test(x.body))).toBe(true)
  })

  it('sidebar ใช้ไล่สีกรมท่าตามแบบ (#14224f → #0b1433)', () => {
    const r = R.filter(x => sels(x).includes('.sidebar') && /#14224f/i.test(x.body) && /#0b1433/i.test(x.body))
    expect(r.length).toBeGreaterThan(0)
  })
})

describe('ธีม Glass — พิมพ์ / มือถือ / ลดการเคลื่อนไหว', () => {
  it('พิมพ์: พื้นหน้าขาว ไม่มีพื้นไล่สี · แผงขาวทึบ', () => {
    const p = R.filter(x => /print/.test(x.media))
    expect(p.some(x => sels(x).includes('body') && /background:\s*#fff/i.test(x.body))).toBe(true)
    expect(p.some(x => sels(x).includes('.panel') && /background:\s*#fff/i.test(x.body))).toBe(true)
  })
  it('ธีมไม่เพิ่ม animation วนไม่รู้จบตัวใหม่ (เคลื่อนไหวได้เฉพาะของเดิม)', () => {
    const KNOWN = /^(\.aurora|\.sidebar nav a|\.topbar-btn|\.gl-|\.modal|\.skel|\.spin|\.gps|\.toast|\.top-progress|\.progress|\.busy-bar)/
    const loops = R.filter(x => /animation:[^;]*infinite/.test(x.body)).flatMap(sels).filter(s => !KNOWN.test(s))
    expect(loops).toEqual([])
  })
})

// รอบ 2 (2026-11-24): ชิ้นส่วนรายหน้าจาก canvas — Audit / Warranty / Standards / Map / Material Master / Users
describe('ธีม Glass รอบ 2 — คลาสกลางที่หน้าต่าง ๆ ใช้', () => {
  const has = (sel: string, re?: RegExp) => R.some(x => sels(x).includes(sel) && (!re || re.test(x.body)))
  it('ป้ายสีม่วง .badge.violet (ใช้ token --violet เดิม)', () => {
    expect(has('.badge.violet', /var\(--violet\)/)).toBe(true)
  })
  it('ช่องค้นหามีแว่นขยาย = CSS ล้วน (background-image) เว้นซ้ายให้ไอคอน', () => {
    expect(has('input.search-input', /background-image:/)).toBe(true)
    expect(has('input.search-input', /padding-left:\s*36px/)).toBe(true)
  })
  it('แผงเตือนขอบซ้ายเหลือง .panel.accent-amber', () => {
    expect(has('.panel.accent-amber', /border-left:\s*4px solid/)).toBe(true)
  })
  it('แท็บแบบแคปซูล .subtabs.seg — ปุ่มที่เลือก (.on / .active) เป็นพื้นไล่สี ตัวขาว', () => {
    expect(has('.subtabs.seg')).toBe(true)
    expect(has('.subtabs.seg button.on', /linear-gradient/)).toBe(true)
    expect(has('.subtabs.seg button.on', /color:\s*#fff/i)).toBe(true)
  })
  it('🔴 hover ของ .subtabs.seg ต้องไม่ทับแท็บที่เลือก (เดิม :hover:not(:disabled) specificity สูงกว่า .on ⇒ ชี้แล้วแท็บขาว)', () => {
    const hovers = R.flatMap(sels).filter(s => s.startsWith('.subtabs.seg') && s.includes(':hover'))
    expect(hovers.length).toBeGreaterThan(0)
    for (const s of hovers) {
      expect(s, s).toContain(':not(.on)')
      expect(s, s).toContain(':not(.active)')
    }
  })
  it('การ์ดหลักฐานติดตั้งรายเครื่อง: รูปซ้าย 140px · จอแคบเรียงรูปไว้บน · ไม่มี backdrop-filter (อยู่ใน Popup)', () => {
    expect(has('.unit-ev', /grid-template-columns:\s*140px/)).toBe(true)
    expect(R.some(x => /max-width:\s*560px/.test(x.media) && sels(x).includes('.unit-ev') && /grid-template-columns:\s*1fr/.test(x.body))).toBe(true)
    expect(R.filter(x => sels(x).some(s => s.startsWith('.unit-ev')) && /backdrop-filter/.test(x.body))).toEqual([])
    expect(has('.unit-ev-photo img', /object-fit:\s*cover/)).toBe(true)
  })
  it('Dashboard: การ์ด KPI 4 ใบ (auto-fit ≥270px · มุม 22px) · แถบ/จุดสีครบ 5 โทน · วงแหวนเขียวเมื่อครบ', () => {
    expect(has('.kpi-grid', /minmax\(270px/)).toBe(true)
    expect(has('.dash .card.kpi-card', /border-radius:\s*22px/)).toBe(true)
    for (const t of ['green', 'amber', 'violet', 'blue', 'red', 'gray']) {
      expect(has(`.kpi-seg.${t}`), `seg ${t}`).toBe(true)
      expect(has(`.kpi-dot.${t}`), `dot ${t}`).toBe(true)
    }
    expect(has('.kpi-ring-bar.done', /stroke:\s*#16a34a/i)).toBe(true)
    // Job List: ไม่มีแถบเว้นแถว (แบบใช้เส้นคั่น) · LBS ครบ = เขียว
    expect(has('.dash .job-list-tb tbody tr:nth-child(even)', /background:\s*none/)).toBe(true)
    expect(has('.lbs-count.ok', /color:/)).toBe(true)
  })
  it('Dashboard: Job List + Stock Balance เคียงกัน (2 : 1 · จอแคบเรียงลง) · Stock Balance มุม 22px · สรุปท้ายการ์ดมีสีตามโทน', () => {
    expect(has('.dash-split', /flex-wrap:\s*wrap/)).toBe(true)
    expect(has('.dash-split > .dash-main', /flex:\s*2 1 620px/)).toBe(true)
    expect(has('.dash-split > .dash-side', /flex:\s*1 1 320px/)).toBe(true)
    expect(has('.dash .panel.stock-bal', /border-radius:\s*22px/)).toBe(true)
    for (const t of ['red', 'green', 'amber', 'violet', 'blue']) expect(has(`.sb-tile-n.${t}`), t).toBe(true)
    expect(R.filter(x => sels(x).some(s => s.startsWith('.sb-') || s.startsWith('.dash-split')) && /backdrop-filter/.test(x.body))).toEqual([])
  })
  it('ชิปตัวกรอง (checkbox ข้างใน) เปลี่ยนสีเมื่อเลือกด้วย :has(:checked) — ไม่ต้องแก้ state', () => {
    expect(has('.chk-chip')).toBe(true)
    expect(R.some(x => sels(x).some(s => s.startsWith('.chk-chip:has(') && s.includes(':checked')))).toBe(true)
  })
})
