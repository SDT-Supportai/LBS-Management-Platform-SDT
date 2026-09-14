import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../data/StoreContext'
import { publicStockView, unitEta, unitFlowState, unitInstallDate } from '../data/logic'
import { fetchPublicStockView } from '../data/remote'
import { supabase } from '../lib/supabase'
import { UNIT_FLOW, fmtDate, fmtDateTime } from '../ui/format'
import type { DB, PublicStockView } from '../types'

/**
 * หน้าสาธารณะ "คลัง LBS" — เปิดได้โดยไม่ต้อง login (0069)
 *   URL: <app>/#/share/<token>
 *
 * 🔴 ข้อตกลงความปลอดภัย (มติผู้ใช้ 2026-09-14):
 *   - ใครถือลิงก์ก็เปิดได้ · ส่งต่อแล้วคุมไม่ได้ ⇒ เปิดเฉพาะข้อมูลที่ "หลุดแล้วไม่เสียหาย"
 *   - **ไม่มีตัวเลขเงินทุกชนิด** (Cost/Set · มูลค่าคลังรวม) และ **ไม่มีเบอร์โทรลูกค้า** (PDPA)
 *   - การกรองฟิลด์ทำที่ **ชั้นข้อมูล** (rpc_public_lbs_stock ฝั่ง LIVE · publicStockView ฝั่ง demo)
 *     ไม่ใช่ซ่อนที่หน้าจอ — ถ้าซ่อนแค่ที่นี่ ข้อมูลจริงเดินทางไปถึงเบราว์เซอร์คนนอกแล้ว
 *
 * หน้าไม่มี sidebar / ปุ่มทำรายการใด ๆ — อ่านอย่างเดียวล้วน
 * สถานะรายเครื่องคำนวณด้วย unitFlowState() ชุดเดียวกับหน้าในระบบ (ประกอบ DB ย่อยจาก payload)
 */
/**
 * ⚠️ token มาเป็น **prop** ไม่ใช่ useParams() — หน้านี้ถูก render นอก <Routes> ของแอป
 *    (ต้องอยู่เหนือด่าน login) ⇒ useParams() จะคืน {} เสมอ เปิดลิงก์ไม่ออกทุกครั้ง
 */
export default function PublicStockPage({ token }: { token: string }) {
  const { db, act } = useStore()          // ใช้เฉพาะโหมด demo — LIVE ยิง RPC ตรง ไม่ผ่าน store
  const [view, setView] = useState<PublicStockView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true); setError(null)
    const load = async () => {
      if (supabase) return fetchPublicStockView(supabase, token)
      // demo: อ่านจาก localStorage ด้วยกติกาเดียวกับ RPC (ไว้ทดสอบ flow ได้โดยไม่ต้องต่อ Supabase)
      const v = publicStockView(db, token)
      act.touchShareLink({ token })
      return v
    }
    load()
      .then(v => { if (alive) setView(v) })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // DB ย่อยจาก payload — ให้ helper ชุดเดิม (unitFlowState / unitInstallDate) ใช้ได้โดยไม่ต้องเขียนกติกาซ้ำ
  const miniDb = useMemo(() => ({
    lbsUnits: view?.units ?? [],
    jobs: view?.jobs ?? [],
    unitInstallations: view?.installs ?? [],
  } as unknown as DB), [view])

  const rows = useMemo(() => {
    if (!view) return []
    const stockNoOf = (id: string) => view.stocks.find(s => s.id === id)?.stockNo ?? '-'
    return view.units.map(u => {
      const job = u.jobId ? view.jobs.find(j => j.id === u.jobId) : undefined
      return {
        u, job,
        stockNo: stockNoOf(u.projectStockId),
        flow: unitFlowState(miniDb, u as DB['lbsUnits'][number]),
        eta: unitEta(u),
        installed: unitInstallDate(miniDb, u.id),
      }
    }).sort((a, b) => a.stockNo.localeCompare(b.stockNo) || a.u.serialLvb.localeCompare(b.u.serialLvb))
  }, [view, miniDb])

  const kpi = useMemo(() => {
    const by = (k: string) => rows.filter(r => r.flow === k).length
    return {
      total: rows.length,
      onHand: by('on_hand'), pending: by('pending'), unknown: by('unknown'),
      allocated: by('allocated'), issued: by('issued'),
      installed: by('installed'), blocked: by('blocked'),
    }
  }, [rows])

  if (loading) return <div className="public-wrap"><div className="empty">กำลังโหลด…</div></div>
  if (error || !view) {
    return (
      <div className="public-wrap">
        <div className="panel"><div className="panel-body">
          <h2 style={{ marginBottom: 6 }}>เปิดลิงก์นี้ไม่ได้</h2>
          <div className="muted">{error ?? 'ลิงก์ไม่ถูกต้อง'}</div>
          <div className="muted" style={{ marginTop: 10 }}>
            ลิงก์อาจถูกเพิกถอนแล้ว หรือคัดลอกมาไม่ครบ — ขอลิงก์ใหม่จากผู้ดูแลระบบ (แผนก Division)
          </div>
        </div></div>
      </div>
    )
  }

  return (
    <div className="public-wrap">
      <div className="public-head">
        <div>
          <div className="public-title">Project Stock — คลัง LBS</div>
          <div className="muted">{view.stockNo} · ข้อมูล ณ {fmtDateTime(view.generatedAt)}</div>
        </div>
        <span className="badge neutral">อ่านอย่างเดียว</span>
      </div>

      <div className="public-kpis">
        {[
          { label: 'ทั้งหมด', value: kpi.total, cls: '' },
          { label: 'On Hand (พร้อมดึง)', value: kpi.onHand, cls: 'green' },
          { label: 'Pending (รอเข้าคลัง)', value: kpi.pending, cls: 'amber' },
          { label: 'ยังไม่ระบุ ETA', value: kpi.unknown, cls: '' },
          { label: 'ถูกดึงเข้า Job', value: kpi.allocated, cls: 'blue' },
          { label: 'เบิกแล้ว รอติดตั้ง', value: kpi.issued, cls: '' },
          { label: 'ติดตั้งแล้ว', value: kpi.installed, cls: 'green' },
        ].map(k => (
          <div key={k.label} className="public-kpi">
            <div className={`public-kpi-value ${k.cls}`}>{k.value}</div>
            <div className="muted">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head"><h3>รายเครื่อง · {rows.length} เครื่อง</h3></div>
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>คลัง</th><th>Serial.LVB</th><th>Serial.OM</th><th>สถานะ</th>
              <th>ETA to WH</th><th>Job No.</th><th>ลูกค้า</th><th>สถานที่ติดตั้ง</th>
              <th>กำหนดส่ง</th><th>ติดตั้งจริง</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={10}><div className="empty">ยังไม่มีเครื่องในขอบเขตนี้</div></td></tr>
              )}
              {rows.map(r => (
                <tr key={r.u.id}>
                  <td className="mono">{r.stockNo}</td>
                  <td className="mono">{r.u.serialLvb}</td>
                  <td className="mono">{r.u.serialOm || <span className="muted">-</span>}</td>
                  <td><span className={`badge ${UNIT_FLOW[r.flow].cls}`} title={UNIT_FLOW[r.flow].hint}>
                    {UNIT_FLOW[r.flow].label}
                  </span></td>
                  <td>{r.eta ? fmtDate(r.eta) : <span className="muted">-</span>}</td>
                  <td className="mono">{r.job?.jobNo ?? <span className="muted">-</span>}</td>
                  <td>{r.job?.customerName ?? <span className="muted">-</span>}</td>
                  <td>{r.job?.installLocation || <span className="muted">-</span>}</td>
                  <td>{r.u.planDeliveryDate ? fmtDate(r.u.planDeliveryDate) : <span className="muted">-</span>}</td>
                  <td>{r.installed ? fmtDate(r.installed) : <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="muted public-foot">
        ลิงก์นี้เปิดดูได้โดยไม่ต้องเข้าสู่ระบบ · <b>ไม่มีข้อมูลต้นทุนและมูลค่าคลัง</b> ·
        ผู้ดูแลเพิกถอนลิงก์ได้ทุกเมื่อ — กรุณาอย่าเผยแพร่ต่อสาธารณะ
        <div style={{ marginTop: 4 }}>115kV LBS Project Management Platform</div>
      </div>
    </div>
  )
}
