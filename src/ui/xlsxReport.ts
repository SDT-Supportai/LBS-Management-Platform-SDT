import type { WorkBook, WorkSheet } from 'xlsx'
import { fmtDateTime } from './format'

/**
 * โครง "รายงานผู้บริหาร" (Excel) — แหล่งความจริงเดียวของรูปแบบไฟล์ทุกหน้า (2026-09-09)
 *
 * ทุกไฟล์เรียงชีตเหมือนกันหมด คนเปิดไฟล์จากหน้าไหนก็อ่านท่าเดียวกัน:
 *   1. "สรุปผู้บริหาร" — หัวรายงาน + KPI + ตารางสรุปแบ่งกลุ่ม (ตัวเลขที่ผู้บริหารดู)
 *   2. ชีตข้อมูล       — รายละเอียดทุกบรรทัด + autofilter (คนทำงานกรอง/ตรวจ)
 *   3. "คำอธิบาย"      — คอลัมน์นี้คืออะไร · ตัวเลขนับจากอะไร (กันตีความผิด)
 *
 * ⚠️ ชีตข้อมูลของหน้าที่ **Import กลับได้** (คลัง LBS · ฐานข้อมูลวัสดุ) ต้องคง
 *    "หัวตารางอยู่แถว 1" และ **ห้ามมีแถวรวม** — ไม่งั้น sheet_to_json อ่านเพี้ยนทั้งไฟล์
 *    จึงเป็นเหตุผลที่ชีตสรุปเป็น "ชีตแยก" ไม่ใช่หัวกระดาษเหนือตาราง
 *    ตัวอ่านไฟล์ต้องหาชีตข้อมูลด้วย dataSheetName() ซึ่งข้ามชีตใน NON_DATA_SHEETS
 *
 * ⚠️ SheetJS รุ่น community เขียนลงไฟล์ได้เฉพาะ: ความกว้างคอลัมน์ (!cols) · merge (!merges) ·
 *    autofilter (!autofilter) · รูปแบบตัวเลขระดับเซลล์ (cell.z)
 *    **ตัวหนา / สีพื้น / เส้นขอบ / freeze pane เขียนไม่ได้** (ใส่ไปก็ไม่มีผล — เจอมาแล้วตอน 0052)
 *    ความอ่านง่ายจึงต้องมาจากลำดับหัวข้อ · การเว้นบรรทัด · ความกว้างคอลัมน์ · รูปแบบตัวเลข
 */

/** โมดูล xlsx ที่โหลดแบบ dynamic (`await import('xlsx')`) — ไม่ import ตรงเพื่อไม่ให้ bundle หลักบวม */
export type Xlsx = typeof import('xlsx')
export type Cell = string | number

// ---------------- ชื่อชีตมาตรฐาน ----------------
export const SHEET_SUMMARY = 'สรุปผู้บริหาร'
export const SHEET_GUIDE = 'คำอธิบาย'
/** ชีตที่ "ไม่ใช่ข้อมูล" — ตัวอ่านไฟล์ Import ต้องข้ามให้ครบทุกชื่อนี้ */
export const NON_DATA_SHEETS = new Set([SHEET_SUMMARY, SHEET_GUIDE, 'วิธีกรอก', 'วิธีใช้'])

/**
 * หาชีตข้อมูลในไฟล์ที่ผู้ใช้อัปมา — ลองชื่อที่คาดไว้ก่อน (รวมชื่อเก่าก่อน 2026-09-09
 * เพื่อไม่ให้ไฟล์ที่ export ไปก่อนหน้านี้พัง) แล้วค่อย fallback ชีตแรกที่ไม่ใช่คู่มือ/สรุป
 */
export function dataSheetName(wb: WorkBook, expected: string[] = []): string {
  for (const want of expected) {
    const hit = wb.SheetNames.find(s => s.trim().toLowerCase() === want.trim().toLowerCase())
    if (hit) return hit
  }
  // ชีตคำอธิบายอาจมีหลายชุดในไฟล์เดียว (เช่น "คำอธิบาย-คลังคงเหลือ") — ตัดด้วย prefix ไม่ใช่ชื่อเป๊ะ
  const isGuide = (n: string) =>
    NON_DATA_SHEETS.has(n.trim()) || /^(คำอธิบาย|สรุปผู้บริหาร|วิธี)/.test(n.trim())
  return wb.SheetNames.find(n => !isGuide(n)) ?? wb.SheetNames[0]
}

// ---------------- รูปแบบตัวเลข ----------------
// ผู้บริหารอ่านยอดเงินจากไฟล์นี้ตรง ๆ — ตัวคั่นหลักพันต้องมาจากไฟล์ ไม่ใช่ให้ไปตั้งเองใน Excel
export type NumKind = 'money' | 'money0' | 'int' | 'pct'
const NUM_FMT: Record<NumKind, string> = {
  money: '#,##0.00',
  money0: '#,##0',        // ยอดระดับล้าน — ทศนิยมทำให้ตารางอ่านยากกว่าเดิม
  int: '#,##0',
  pct: '0.0"%"',
}

/** สเปกคอลัมน์ของชีตข้อมูล — คุมความกว้าง · รูปแบบตัวเลข · แถวรวม · ชีตคำอธิบาย จากที่เดียว */
export interface ReportCol {
  key: string
  width: number
  note: string
  num?: NumKind
  /** รวมยอดคอลัมน์นี้ในแถวรวมท้ายตาราง (มีผลเมื่อ dataSheet เรียกด้วย totalRow) */
  total?: boolean
}

function applyNumFmt(X: Xlsx, ws: WorkSheet, cols: ReportCol[], lastRow: number): void {
  cols.forEach((col, ci) => {
    if (!col.num) return
    const z = NUM_FMT[col.num]
    for (let r = 1; r <= lastRow; r++) {
      const cell = ws[X.utils.encode_cell({ r, c: ci })]
      if (cell && typeof cell.v === 'number') cell.z = z
    }
  })
}

/**
 * ชีตข้อมูล — หัวตารางแถว 1 + autofilter + ความกว้าง + รูปแบบตัวเลข
 *
 * totalRow ใส่ได้เฉพาะชีตที่ "อ่านอย่างเดียว" · ชีตที่ Import กลับได้ห้ามใส่
 * autofilter คลุมแค่แถวข้อมูล ไม่คลุมแถวรวม — กรองแล้วยอดรวมจะไม่หายไปกับแถวที่ถูกซ่อน
 */
export function dataSheet(
  X: Xlsx,
  rows: Record<string, Cell>[],
  cols: ReportCol[],
  opt: { totalRow?: boolean; totalLabel?: string } = {},
): WorkSheet {
  const headers = cols.map(c => c.key)
  const body: Record<string, Cell>[] = [...rows]
  if (opt.totalRow) {
    const total: Record<string, Cell> = {}
    cols.forEach((c, i) => {
      if (i === 0) { total[c.key] = opt.totalLabel ?? `รวม ${rows.length} รายการ`; return }
      total[c.key] = c.total
        ? rows.reduce((s, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0)
        : ''
    })
    body.push(total)
  }
  // header: บังคับลำดับคอลัมน์ + **ไม่มีข้อมูลก็ยังได้หัวตารางครบ** (บั๊กคลังเปล่าที่เจอตอน 0049)
  const ws = X.utils.json_to_sheet(body, { header: headers })
  ws['!cols'] = cols.map(c => ({ wch: c.width }))
  ws['!autofilter'] = {
    ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: cols.length - 1 } }),
  }
  applyNumFmt(X, ws, cols, body.length)
  return ws
}

// ---------------- ชีต "สรุปผู้บริหาร" ----------------

/** 1 บรรทัด KPI — value เป็นตัวเลขจะได้ตัวคั่นหลักพัน · เป็นข้อความใช้เมื่อยังไม่มีข้อมูล ('-') */
export interface Kpi {
  label: string
  value: Cell
  unit?: string
  note?: string
  num?: NumKind
}

/** ตารางสรุปแบ่งกลุ่มในชีตสรุป (เช่น สรุปตาม Job · สรุปตามหมวดงบ · Top 10 มูลค่า) */
export interface SumTable {
  title: string
  head: string[]
  rows: Cell[][]
  /** index คอลัมน์ → รูปแบบตัวเลข */
  num?: Record<number, NumKind>
  /** แถวรวมท้ายตาราง (ผู้เรียกคำนวณมาเอง — บางคอลัมน์รวมไม่ได้ เช่น % หรือวันที่) */
  total?: Cell[]
  /** ข้อความเมื่อไม่มีแถวเลย */
  empty?: string
}

export interface ExecReport {
  /** ชื่อรายงาน — บรรทัดแรกของไฟล์ ต้องอ่านจบว่านี่คือรายงานอะไร */
  title: string
  /** ขอบเขตข้อมูล เช่น "Project Stock No.3" / "JOB-2026-0005" / "ทั้งระบบ" */
  scope?: string
  /** คู่ label/value ในหัวรายงาน (ออกเมื่อ · ผู้ออก · จำนวนรายการ ฯลฯ) */
  meta: [string, Cell][]
  /** ข้อจำกัดที่ต้องเห็นก่อนเอาเลขไปใช้ (ไฟล์ถูกกรองอยู่ · ราคายังไม่ครบ ฯลฯ) */
  warnings?: string[]
  kpis: Kpi[]
  tables?: SumTable[]
  notes?: string[]
  widths?: number[]
}

const SUM_COLS = 6
const SUM_WIDTHS = [30, 26, 14, 16, 18, 22]

export function summarySheet(X: Xlsx, rep: ExecReport): WorkSheet {
  const aoa: Cell[][] = []
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = []
  const fmts: { r: number; c: number; z: string }[] = []

  const push = (row: Cell[] = []): number => { aoa.push(row); return aoa.length - 1 }
  /** หัวข้อคั่น — merge เต็มแถวให้ข้อความยาวไม่ถูกคอลัมน์ถัดไปบัง (แทนตัวหนาที่เขียนไม่ได้) */
  const band = (text: string): void => {
    const r = push([text])
    merges.push({ s: { r, c: 0 }, e: { r, c: SUM_COLS - 1 } })
  }
  const num = (r: number, c: number, kind?: NumKind): void => {
    if (kind) fmts.push({ r, c, z: NUM_FMT[kind] })
  }

  band(rep.title)
  if (rep.scope) band(`ขอบเขตข้อมูล: ${rep.scope}`)
  push()

  band('ข้อมูลรายงาน')
  rep.meta.forEach(([k, v]) => push([k, v]))
  push()

  if (rep.warnings?.length) {
    rep.warnings.forEach(w => band(`⚠️ ${w}`))
    push()
  }

  band('ตัวชี้วัดหลัก (KPI)')
  const headRow = push(['ตัวชี้วัด', 'ค่า', 'หน่วย', 'หมายเหตุ'])
  merges.push({ s: { r: headRow, c: 3 }, e: { r: headRow, c: SUM_COLS - 1 } })
  rep.kpis.forEach(k => {
    const r = push([k.label, k.value, k.unit ?? '', k.note ?? ''])
    num(r, 1, k.num)
    merges.push({ s: { r, c: 3 }, e: { r, c: SUM_COLS - 1 } })
  })
  push()

  const tables = rep.tables ?? []
  tables.forEach(t => {
    band(t.title)
    if (t.rows.length === 0) {
      band(t.empty ?? '(ไม่มีข้อมูลในขอบเขตนี้)')
    } else {
      push(t.head)
      const applyRowFmt = (r: number) =>
        Object.entries(t.num ?? {}).forEach(([ci, kind]) => num(r, Number(ci), kind))
      t.rows.forEach(row => applyRowFmt(push(row)))
      if (t.total) applyRowFmt(push(t.total))
    }
    push()
  })

  if (rep.notes?.length) {
    band('หมายเหตุ / วิธีอ่านตัวเลข')
    rep.notes.forEach((n, i) => {
      const r = push([String(i + 1), n])
      merges.push({ s: { r, c: 1 }, e: { r, c: SUM_COLS - 1 } })
    })
  }

  const ws = X.utils.aoa_to_sheet(aoa)
  ws['!cols'] = (rep.widths ?? SUM_WIDTHS).map(w => ({ wch: w }))
  ws['!merges'] = merges
  fmts.forEach(f => {
    const cell = ws[X.utils.encode_cell({ r: f.r, c: f.c })]
    if (cell && typeof cell.v === 'number') cell.z = f.z
  })
  return ws
}

// ---------------- ชีต "คำอธิบาย" ----------------

/** ชีตอธิบายคอลัมน์ + ข้อควรรู้ — ใช้กับรายงานที่ "อ่านอย่างเดียว" (ไม่ใช่แบบฟอร์มกรอก) */
export function guideSheet(
  X: Xlsx,
  head: Cell[][],
  cols: ReportCol[],
  notes: string[],
): WorkSheet {
  const aoa: Cell[][] = [
    ...head,
    [],
    ['คอลัมน์', 'คำอธิบาย'],
    ...cols.map(c => [c.key, c.note] as Cell[]),
    [],
    ['ข้อควรรู้'],
    ...notes.map((n, i) => [String(i + 1), n] as Cell[]),
  ]
  const ws = X.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 24 }, { wch: 100 }]
  return ws
}

// ---------------- ประกอบไฟล์ + บันทึก ----------------

/** ชื่อชีตใน Excel ยาวได้ไม่เกิน 31 ตัวอักษร — ตัดที่นี่ที่เดียว ไม่ต้องจำทุกจุดที่เรียก */
export function buildWorkbook(X: Xlsx, sheets: { name: string; ws: WorkSheet }[]): WorkBook {
  const wb = X.utils.book_new()
  sheets.forEach(s => X.utils.book_append_sheet(wb, s.ws, s.name.slice(0, 31)))
  return wb
}

export function saveReport(X: Xlsx, wb: WorkBook, baseName: string): void {
  const safe = baseName.replace(/[\\/:*?"<>|]/g, '-')
  X.writeFile(wb, `${safe}-${new Date().toISOString().slice(0, 10)}.xlsx`)
}

/** บรรทัด "ออกเมื่อ / โดยใคร" — ทุกรายงานต้องตอบได้ว่าเลขชุดนี้เป็นของวันไหน ใครกด */
export function stampMeta(by?: { fullName?: string } | null, deptLabel?: string): [string, Cell][] {
  return [
    ['ออกรายงานเมื่อ', fmtDateTime(new Date().toISOString())],
    ['ผู้ออกรายงาน', by?.fullName ? `${by.fullName}${deptLabel ? ` (${deptLabel})` : ''}` : '-'],
  ]
}

/** ค่าที่ยังไม่มี → '-' (ตัวเลข 0 ยังเป็น 0 ไม่ถูกกลืน) */
export function orDash(n?: number): Cell {
  return n === undefined || n === null || Number.isNaN(n) ? '-' : n
}
