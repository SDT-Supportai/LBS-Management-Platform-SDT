// 2026-11-24 — <option> รับได้เฉพาะข้อความล้วน
//   บั๊ก: กล่อง "+ เพิ่มวัสดุ" (JobDetailPage) ใส่ <div>/<b> ไว้ใน <option value="central_stock">
//   ⇒ React เตือน validateDOMNesting "<div> cannot appear as a child of <option>"
//   ตรวจจาก source ทุกไฟล์ .tsx ด้วย TypeScript parser: ลูกของ <option> ต้องเป็นข้อความ / {นิพจน์} เท่านั้น
import { describe, it, expect } from 'vitest'
import ts from 'typescript'

// อ่าน source ผ่าน Vite (ไม่ต้องพึ่ง node:fs / @types/node)
const sources = import.meta.glob<string>(['../**/*.tsx', '!../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true })

/** คืนตำแหน่ง "ไฟล์:บรรทัด" ของ <option> ที่มี element / fragment เป็นลูก */
function optionsWithElements(path: string, code: string): string[] {
  const sf = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const bad: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'option') {
      const hasElementChild = n.children.some(c => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxFragment(c))
      if (hasElementChild) bad.push(`${path.replace(/^\.\.\//, '')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return bad
}

describe('<option> ต้องเป็นข้อความล้วน (ห้ามมี <div>/<b>/<span> ข้างใน)', () => {
  it('อ่านไฟล์ได้จริง (กันเทสต์ผ่านเพราะ glob ว่าง)', () => {
    expect(Object.keys(sources)).toContain('../pages/JobDetailPage.tsx')
  })
  it('ทุกไฟล์ .tsx ใน src', () => {
    const bad = Object.entries(sources).flatMap(([p, code]) => optionsWithElements(p, code))
    expect(bad).toEqual([])
  })
})
