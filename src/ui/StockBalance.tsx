import { Link } from 'react-router-dom'
import { StackBar, type KpiPart } from './kpi'

// =============================================================================
// LBS — Stock Balance แบบการ์ด Glass (2026-11-24) ตาม canvas หน้า 2 — เดิมเป็นตาราง 8 คอลัมน์
//   แถวต่อคลัง: ชื่อ + ยอดรวม + แถบส่วนประกอบ (สีเดียวกับการ์ด KPI) + บรรทัดตัวเลขที่มีค่า
//   ท้ายการ์ด: สรุปรวมทุกคลัง · ตัวเลขทุกคอลัมน์ของตารางเดิมยังเห็นครบ (ไม่มีอะไรหาย)
//   แสดงผลอย่างเดียว — ตัวเลขมาจาก stockSummary เดิม · เทสต์: StockBalance.test.tsx
// =============================================================================

export interface StockSum {
  total: number; onHand: number; pending: number; unknown: number
  allocated: number; issued: number; noContract: number
}

const parts = (s: StockSum): KpiPart[] => [
  { label: 'On Hand', value: s.onHand, tone: 'green' },
  { label: 'Pending', value: s.pending, tone: 'amber' },
  { label: 'ไม่ระบุ ETA', value: s.unknown, tone: 'gray' },
  { label: 'ถูกดึงเข้า Job', value: s.allocated, tone: 'violet' },
  { label: 'เบิกติดตั้งแล้ว', value: s.issued, tone: 'blue' },
]

const LEGEND: { label: string; tone: KpiPart['tone']; title?: string }[] = [
  { label: 'On Hand', tone: 'green', title: 'ถึงคลังแล้ว' },
  { label: 'Pending', tone: 'amber', title: 'รอเข้าคลัง · ดึงจองได้ เบิกไม่ได้' },
  { label: 'ไม่ระบุ ETA', tone: 'gray', title: 'ยังไม่ระบุ ETA to WH — กรอก FOB date ที่หน้า Project Stock' },
  { label: 'ถูกดึงเข้า Job', tone: 'violet' },
  { label: 'เบิกแล้ว', tone: 'blue' },
]

export function StockBalanceCard({ rows, totals }: {
  rows: { id: string; stockNo: string; closed: boolean; sum: StockSum }[]
  totals: StockSum
}) {
  return (
    <section className="panel stock-bal" aria-label="LBS Stock Balance">
      <div className="panel-head">
        <h3 title="สต็อก LBS รายคลัง">LBS — Stock Balance</h3>
        <Link to="/stocks">จัดการสต็อก →</Link>
      </div>
      <div className="panel-body">
        {rows.length === 0 ? <div className="empty">ยังไม่มี Project Stock</div> : (
          <>
            <div className="sb-legend">
              {LEGEND.map(l => <span key={l.label} title={l.title}><span className={`kpi-dot ${l.tone}`} aria-hidden="true" />{l.label}</span>)}
            </div>
            <div className="sb-rows">
              {rows.map(r => {
                const s = r.sum
                return (
                  <div key={r.id} className="sb-row">
                    <div className="sb-head">
                      <span>
                        <Link to="/stocks"><b>{r.stockNo}</b></Link>
                        {r.closed && <span className="badge red" style={{ marginLeft: 6 }}>ปิดคลัง</span>}
                      </span>
                      <span className="sb-total"><b>{s.total}</b> เครื่อง</span>
                    </div>
                    <StackBar total={s.total} parts={parts(s)} />
                    <div className="sb-note">
                      <span>{`On Hand ${s.onHand}`}</span>
                      {s.pending > 0 && <span className="sb-amber">{`Pending ${s.pending}`}</span>}
                      {s.unknown > 0 && <span title="ยังไม่ระบุ ETA to WH — กรอก FOB date ที่หน้า Project Stock">{`ไม่ระบุ ETA ${s.unknown}`}</span>}
                      {s.noContract > 0 && <span className="sb-warn" title="ดึงเข้า Job ได้เฉพาะเครื่องที่มี Contract No. แล้ว">{`ไม่มี Contract No. ${s.noContract}`}</span>}
                      {s.allocated > 0 && <span>{`ถูกดึงเข้า Job ${s.allocated}`}</span>}
                      {s.issued > 0 && <span>{`เบิกติดตั้งแล้ว ${s.issued}`}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="sb-tiles">
              <div><b className="sb-tile-n">{totals.total}</b><span>รวมทุกคลัง</span></div>
              <div title="ถึงคลังแล้ว"><b className={`sb-tile-n ${totals.onHand > 0 ? 'green' : 'red'}`}>{totals.onHand}</b><span>On Hand</span></div>
              <div title="รอเข้าคลัง · ดึงจองได้ เบิกไม่ได้"><b className={`sb-tile-n${totals.pending > 0 ? ' amber' : ''}`}>{totals.pending}</b><span>Pending</span></div>
              <div><b className={`sb-tile-n${totals.allocated > 0 ? ' violet' : ''}`}>{totals.allocated}</b><span>ถูกดึงเข้า Job</span></div>
              <div><b className={`sb-tile-n${totals.issued > 0 ? ' blue' : ''}`}>{totals.issued}</b><span>เบิกแล้ว</span></div>
            </div>
            {(totals.noContract > 0 || totals.unknown > 0) && (
              <div className="kpi-notes" style={{ marginTop: 8, justifyContent: 'center' }}>
                {totals.noContract > 0 && <Link to="/stocks?f=no_contract" title="ดึงเข้า Job ได้เฉพาะเครื่องที่มี Contract No. แล้ว — Division กรอกที่ LBS Inventory"><b style={{ color: 'var(--danger)' }}>ไม่มี Contract No. {totals.noContract} (ดึงไม่ได้)</b></Link>}
                {totals.unknown > 0 && <span>ไม่ระบุ ETA {totals.unknown}</span>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
