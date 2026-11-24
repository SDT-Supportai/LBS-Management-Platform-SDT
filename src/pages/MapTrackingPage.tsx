import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useStore } from '../data/StoreContext'
import { fmtDate } from '../ui/format'
import { buildMapPins, groupPins, unpinnedBlocked, nextFit, type Pin, type FitState } from '../data/mapPins'
import { mapsUrl } from '../data/field'

// =============================================================================
// Map Tracking — ประเทศไทย (2026-08-23)
//
// จุดบนแผนที่ = **การ Check-in ราย Serial** ตอนยืนยันติดตั้ง (unit_installations)
//   ตำแหน่ง GPS + รูป เป็นข้อมูลบังคับตั้งแต่ 0019/0035 อยู่แล้ว — หน้านี้แค่เอามาวางบนแผนที่
//   ไม่มีการเก็บพิกัดใหม่ ไม่มีคอลัมน์เพิ่ม ไม่ต้อง migration
//
// ชั้นที่ 2 (เปิด/ปิดได้) = Check-in ระดับงานจาก confirmInstall (jobs.install_checkin_*)
//   งานเก่าก่อน 0035 ยืนยันทีเดียวทั้งใบ จึงมีแต่พิกัดระดับงาน — ถ้าไม่โชว์ แผนที่จะว่างเปล่า
//   สำหรับงานเก่าทั้งหมด · ติดป้ายแยกให้ชัดว่าเป็นระดับงาน ไม่ใช่ราย Serial
//
// เลือก Leaflet + OpenStreetMap: ไม่ต้องมี API key ไม่ต้องผูกบัตร (มติ 2026-08-23)
//   ⚠️ ต้องต่อเน็ตเพื่อโหลด tile — แอปนี้ต่อ Supabase อยู่แล้วจึงไม่ใช่ข้อจำกัดใหม่
//   ⚠️ ไอคอนใช้ divIcon (HTML ล้วน) ไม่ใช่ marker-icon.png ของ Leaflet
//      เพราะ path รูปใน CSS ของ Leaflet พังเวลาผ่าน bundler — divIcon เลี่ยงปัญหานี้ทั้งหมด
//      และได้ระบายสีตามผลติดตั้งฟรี (เขียว = ติดตั้งแล้ว · แดง = ติดตั้งไม่ได้)
// =============================================================================

// กรอบประเทศไทยโดยประมาณ — ใช้เป็นมุมมองตั้งต้นเมื่อยังไม่มีหมุด
const TH_CENTER: [number, number] = [13.5, 100.9]
const TH_ZOOM = 6
// inThailand ย้ายไปอยู่ logic.ts (0060) — ใช้ร่วมกับฝั่ง validate ตอนกรอกพิกัด แหล่งความจริงเดียว

/** คีย์กลุ่มหมุด (พิกัดเดียวกัน ปัด 5 ตำแหน่ง) — ใช้เลือกหมุดจากแผนที่/ตาราง */
const coordKey = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export default function MapTrackingPage() {
  const { db } = useStore()
  const boxRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const [showJobLevel, setShowJobLevel] = useState(true)
  const [showPlan, setShowPlan] = useState(true)            // ชั้น "แผนติดตั้ง" (0060)
  const [expanded, setExpanded] = useState(false)          // ขยายแผนที่เต็มจอ
  const [search, setSearch] = useState('')
  const [onlyBlocked, setOnlyBlocked] = useState(false)
  // เฟส 5: เลือกตามหมุด → กล่องรายละเอียดใต้แผนที่ (ไม่บังแผนที่ · มือถือใช้ได้) แทน popup ทับหมุด
  const [selected, setSelected] = useState<string | null>(null)
  const fitRef = useRef<FitState | null>(null)

  // ---- หมุดทั้งหมด — เฟส 5 ย้ายไป src/data/mapPins.ts (มีเทสต์) ----
  //   แก้ในนั้น: เครื่องติดตั้งไม่ได้ขึ้นหมุดแดงที่จุดตามแผน · แถวเวลาเท่ากันแถวหลังชนะ · หมุดแผนของจุดที่ติดตั้งครบหายไป ·
  //   งานหลายจุดบอกสถานที่ของจุดที่เครื่องอยู่ · ลิงก์รูปกัน javascript: · งานยกเลิกไม่มีหมุด
  const allPins = useMemo<Pin[]>(() => buildMapPins(db), [db])

  // ⚠️ Leaflet คำนวณ tile จากขนาดกล่องตอน init — เปลี่ยนขนาดด้วย CSS แล้วไม่บอกมัน
  //    จะได้แผนที่เทาครึ่งจอ (บั๊กคลาสสิกของ Leaflet) → ต้องเรียก invalidateSize ทุกครั้งที่ย่อ/ขยาย
  //    หน่วง 1 เฟรมให้ browser คำนวณ layout ใหม่เสร็จก่อน ไม่งั้นมันอ่านขนาดเก่าไปอีก
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const t = window.setTimeout(() => map.invalidateSize(), 60)
    if (!expanded) return () => window.clearTimeout(t)
    // ล็อก scroll ของหน้า: กันจอเลื่อนตอนลากแผนที่ + ตัด scrollbar ที่กินขอบขวาไป ~15px
    // (เก็บค่าเดิมไว้คืน เผื่อมีใครตั้ง overflow ไว้จากที่อื่น)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [expanded])

  const pins = useMemo(() => {
    const t = search.trim().toLowerCase()
    return allPins.filter(p => {
      if (p.level === 'job' && !showJobLevel) return false
      if (p.level === 'plan' && !showPlan) return false
      if (onlyBlocked && p.outcome !== 'blocked') return false
      if (!t) return true
      return [p.jobNo, p.customer, p.location, p.serial, p.serialOm]
        .some(v => v?.toLowerCase().includes(t))
    })
  }, [allPins, search, showJobLevel, showPlan, onlyBlocked])

  // ---- สร้างแผนที่ครั้งเดียว ----
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return
    const map = L.map(boxRef.current, { center: TH_CENTER, zoom: TH_ZOOM, scrollWheelZoom: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; layerRef.current = null }
  }, [])

  // ---- วาดหมุดใหม่ทุกครั้งที่ตัวกรอง/ข้อมูลเปลี่ยน ----
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()

    const groups = groupPins(pins)
    groups.forEach(g => {
      const blocked = g.some(p => p.outcome === 'blocked')
      const allPlan = g.every(p => p.level === 'plan')
      const n = g.length
      // ลำดับความสำคัญของสี: ติดตั้งไม่ได้ (แดง) > ติดตั้งแล้ว (เขียว) > ตามแผน (โปร่ง)
      const cls = blocked ? 'mp-pin blocked' : allPlan ? 'mp-pin plan' : 'mp-pin'
      const isSel = selected === coordKey(g[0])
      const icon = L.divIcon({
        className: 'mp-pin-wrap',
        html: `<span class="${cls}${isSel ? ' selected' : ''}">${n > 1 ? n : ''}</span>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      })
      // hover = Job No. (สิ่งที่ผู้ใช้ขอ) · คลิก = รายละเอียดเต็ม
      const jobNos = [...new Set(g.map(p => p.jobNo))]
      const tipTail = n > 1 ? ` · ${n} จุด`
        : g[0].level === 'plan' ? ` · จุดที่ ${g[0].siteNo} (ตามแผน)`
        : g[0].serial ? ` · ${esc(g[0].serial)}` : ''
      const tip = jobNos.length === 1
        ? `<b>${esc(jobNos[0])}</b>${tipTail}`
        : `<b>${jobNos.map(esc).join(' · ')}</b> (${n} จุด)`
      L.marker([g[0].lat, g[0].lng], { icon })
        .bindTooltip(tip, { direction: 'top', offset: [0, -12] })
        .on('click', () => setSelected(coordKey(g[0])))
        .addTo(layer)
    })

    // เฟส 5: ปรับมุมมองเฉพาะครั้งแรกที่มีหมุด / ตอนเปลี่ยนตัวกรอง — เดิม fit ทุกครั้งที่ข้อมูลเปลี่ยน
    //   (พิมพ์ค้นหาทีละตัว · ข้อมูลรีเฟรช) ⇒ ตำแหน่ง/ซูมที่ผู้ใช้เลื่อนไว้รีเซ็ตตลอด
    //   รีวิวเฟส 5 #10: หมุดชุดแรกมาทีหลัง (ข้อมูลยังโหลดตอนเปิดหน้า) ก็ซูมไปที่หมุด — กติกาอยู่ที่ nextFit (มีเทสต์)
    const fit = nextFit(fitRef.current, [search.trim(), showJobLevel, showPlan, onlyBlocked].join('|'), groups.length)
    fitRef.current = fit.state
    if (fit.action === 'bounds') {
      map.fitBounds(L.latLngBounds(groups.map(g => [g[0].lat, g[0].lng] as [number, number])).pad(0.25), { maxZoom: 12 })
    } else if (fit.action === 'center') {
      map.setView(TH_CENTER, TH_ZOOM)
    }
  }, [pins, selected, search, showJobLevel, showPlan, onlyBlocked])

  const selectedGroup = selected ? groupPins(pins).find(g => coordKey(g[0]) === selected) : undefined
  const focusPin = (p: Pin) => {
    setSelected(coordKey(p))
    mapRef.current?.setView([p.lat, p.lng], Math.max(mapRef.current.getZoom(), 14))
    boxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const unitPins = allPins.filter(p => p.level === 'unit')
  const jobPins = allPins.filter(p => p.level === 'job')
  const planPins = allPins.filter(p => p.level === 'plan')
  const blockedCount = pins.filter(p => p.outcome === 'blocked').length
  // เฟส 5: ติดตั้งไม่ได้แต่ไม่มีพิกัดให้ปักหมุดเลย — บอกจำนวนไว้ ไม่ให้แผนที่ดูเหมือนไม่มีปัญหา
  const unpinned = useMemo(() => unpinnedBlocked(db), [db])

  return (
    <>
      <div className="page-title">Map Tracking — ประเทศไทย</div>
      <div className="page-sub">
        <b>ติดตั้งแล้ว</b> = ตำแหน่งจริงจากการ Check-in ราย Serial ตอน Service ยืนยันหน้างาน ·
        <b>ตามแผน</b> = พิกัดจุดติดตั้งที่กรอกไว้ตอนเปิด Job (ยังไม่ได้ติดตั้ง) —
        ชี้ที่หมุดเพื่อดู <b>Job No.</b> · คลิกหมุด/แถวในตารางเพื่อดูรายละเอียดใต้แผนที่
      </div>

      <div className="cards" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="label">จุดติดตั้งบนแผนที่</div>
          <div className="value">{pins.length}<span className="muted">/{allPins.length}</span></div>
          <div className="hint">ราย Serial {unitPins.length} · ระดับงาน {jobPins.length} · ตามแผน {planPins.length}</div>
        </div>
        <div className="card">
          <div className="label">งานที่มีหมุด</div>
          <div className="value">{new Set(pins.map(p => p.jobId)).size}</div>
          <div className="hint">จากทั้งหมด {db.jobs.length} Job ในระบบ</div>
        </div>
        <div className="card">
          <div className="label">ติดตั้งไม่ได้</div>
          <div className="value">{blockedCount}</div>
          <div className="hint">
            {blockedCount > 0
              ? <>หมุดสีแดง · <Link to="/service">ดูเหตุผลที่หน้า Site Installation →</Link></>
              : unpinned.length > 0 ? 'ไม่มีหมุดแดงบนแผนที่' : 'ไม่มีจุดที่ติดตั้งไม่สำเร็จ'}
          </div>
          {unpinned.length > 0 && (
            <div className="hint" style={{ color: 'var(--amber)' }}
              title={unpinned.map(u => `${u.jobNo} · ${u.serial}${u.reason ? ` — ${u.reason}` : ''}`).join('\n')}>
              ⚠️ อีก {unpinned.length} เครื่องไม่มีพิกัด (ไม่มีเช็คอิน/พิกัดแผน) — {[...new Set(unpinned.map(u => u.jobNo))].join(', ')}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>แผนที่</h3>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input style={{ width: 220 }} value={search} onChange={e => setSearch(e.target.value)}
              placeholder="ค้น Job No. / Serial / ลูกค้า / สถานที่" />
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={onlyBlocked} onChange={e => setOnlyBlocked(e.target.checked)} />
              เฉพาะที่ติดตั้งไม่ได้
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}
              title="งานเก่าก่อนเฟส B ยืนยันติดตั้งทีเดียวทั้งใบ จึงมีแต่พิกัดระดับงาน">
              <input type="checkbox" checked={showJobLevel} onChange={e => setShowJobLevel(e.target.checked)} />
              รวมเช็คอินระดับงาน ({jobPins.length})
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}
              title="พิกัดจุดติดตั้งที่กรอกไว้ตอนเปิด Job — ใช้วางแผนเส้นทางทีมช่างก่อนออกไซต์">
              <input type="checkbox" checked={showPlan} onChange={e => setShowPlan(e.target.checked)} />
              รวมจุดตามแผน ({planPins.length})
            </label>
            <button className="small" onClick={() => setExpanded(true)} title="ขยายแผนที่เต็มจอ (ออกด้วย Esc)">
              ⛶ ขยายเต็มจอ
            </button>
          </div>
        </div>
        <div className="panel-body">
          {allPins.length === 0 && (
            <div className="empty" style={{ marginBottom: 10 }}>
              ยังไม่มีหมุด — หมุด <b>ติดตั้งแล้ว</b> ขึ้นเองเมื่อ Service ยืนยันติดตั้งพร้อมพิกัด GPS ·
              หมุด <b>ตามแผน</b> ขึ้นเมื่อกรอกพิกัดจุดติดตั้งที่หน้า Jobs (ปุ่ม "แก้ไขข้อมูล Job")
            </div>
          )}
          {/* กล่องแผนที่ตัวเดิมย้ายเข้า .map-wrap เพื่อให้โหมดเต็มจอเปลี่ยนแค่ CSS
              — ไม่ทำลาย/สร้าง map instance ใหม่ หมุดกับตำแหน่งที่เลื่อนไว้จึงไม่รีเซ็ต */}
          <div className={`map-wrap${expanded ? ' expanded' : ''}`}>
            <div ref={boxRef} className="map-box" />
            {selectedGroup && (
              <div className={`mp-detail${expanded ? ' sheet' : ''}`} role="region" aria-label="รายละเอียดหมุด">
                <div className="mp-detail-head">
                  <b>{selectedGroup.length > 1 ? `${selectedGroup.length} จุดที่ตำแหน่งนี้` : selectedGroup[0].jobNo}</b>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <a className="small" href={mapsUrl(selectedGroup[0].lat, selectedGroup[0].lng)} target="_blank" rel="noreferrer">🧭 นำทาง</a>
                    <button className="small" onClick={() => setSelected(null)} aria-label="ปิดรายละเอียด">✕</button>
                  </span>
                </div>
                {selectedGroup.map(p => (
                  <div key={p.key} className="mp-detail-row">
                    <div><Link to={`/jobs/${p.jobId}`}><b>{p.jobNo}</b></Link> · {p.customer}</div>
                    <div className="muted">{p.siteNo ? `จุดที่ ${p.siteNo} · ` : ''}{p.location}</div>
                    <div className="muted">
                      {p.level === 'unit'
                        ? <>Serial <span className="mono">{p.serial ?? '-'}</span>{p.serialOm && <> / <span className="mono">{p.serialOm}</span></>}</>
                        : p.level === 'plan' ? `จุดติดตั้งตามแผน · ${p.statusLabel ?? '-'}` : 'เช็คอินระดับงาน (ก่อนแยกราย Serial)'}
                    </div>
                    <div>
                      {p.level === 'plan'
                        // "กำหนดตามแผน" = วันที่ของจุดนี้ที่กรอกตอนเปิดงาน — ไม่ใช่กำหนดส่งที่มีผลของทั้งใบ (0075)
                        ? <span>📌 ยังไม่ติดตั้ง{p.date && <> · กำหนดตามแผน {fmtDate(p.date)}</>}</span>
                        : p.outcome === 'blocked'
                          ? <span style={{ color: 'var(--danger)' }}>⚠️ ติดตั้งไม่ได้{p.reason && <> — เหตุผล: {p.reason}</>}</span>
                          : <span>✅ ติดตั้งแล้ว {p.date ? fmtDate(p.date) : ''} · {p.by ?? '-'}</span>}
                    </div>
                    {p.approx && <div className="muted" style={{ fontSize: 12 }}>📍 ตำแหน่งโดยประมาณ (จุดติดตั้งตามแผน — ไม่มีเช็คอิน)</div>}
                    {p.note && <div className="muted">📝 {p.note}</div>}
                    {p.photoUrl && <div><a href={p.photoUrl} target="_blank" rel="noreferrer">🖼️ รูปหน้างาน</a></div>}
                  </div>
                ))}
              </div>
            )}
            {expanded && (
              <div className="map-exit">
                <span className="muted">{pins.length} จุด{search.trim() ? ` · กรอง "${search.trim()}"` : ''}</span>
                <button className="small" onClick={() => setExpanded(false)}>✕ ย่อกลับ (Esc)</button>
              </div>
            )}
          </div>
          <div className="muted" style={{ marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span><span className="mp-legend" /> ติดตั้งแล้ว</span>
            <span><span className="mp-legend blocked" /> ติดตั้งไม่ได้</span>
            <span><span className="mp-legend plan" /> ตามแผน (ยังไม่ติดตั้ง)</span>
            <span>ตัวเลขในหมุด = จำนวนจุดที่พิกัดเดียวกัน</span>
            <span>แผนที่จาก OpenStreetMap (ต้องต่ออินเทอร์เน็ต)</span>
          </div>
        </div>
      </div>

      {/* ตารางคู่แผนที่ — บางทีอยากไล่อ่านเป็นรายการมากกว่าจิ้มหมุด */}
      {pins.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h3>รายการจุดติดตั้ง <span className="muted" style={{ fontWeight: 400 }}>· {pins.length} จุด</span></h3></div>
          <div className="table-scroll">
            <table className="grid">
              <thead><tr><th>Job No.</th><th>Serial (LVB / OM)</th><th>สถานที่</th><th>ผล</th><th>วันที่</th><th>ช่าง/ผู้ยืนยัน</th><th>พิกัด</th></tr></thead>
              <tbody>
                {pins.slice()
                  .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
                  .map(p => (
                    <tr key={p.key} className={`clickable${selected === coordKey(p) ? ' row-selected' : ''}`} onClick={() => focusPin(p)}>
                      <td><Link to={`/jobs/${p.jobId}`} onClick={e => e.stopPropagation()}><b>{p.jobNo}</b></Link><div className="muted">{p.customer}</div></td>
                      <td className="mono">
                        {p.level === 'unit'
                          ? <>{p.serial ?? '-'}<div className="muted mono">{p.serialOm}</div></>
                          : p.level === 'plan'
                            ? <span className="badge blue">จุดที่ {p.siteNo}</span>
                            : <span className="badge neutral">ระดับงาน</span>}
                      </td>
                      <td>{p.location}</td>
                      <td>{p.level === 'plan'
                        ? <><span className="badge blue">📌 ตามแผน</span><div className="muted">{p.statusLabel}</div></>
                        : p.outcome === 'blocked'
                          ? <><span className="badge red">⚠️ ติดตั้งไม่ได้</span>{p.reason && <div className="muted" style={{ fontSize: 12 }}>{p.reason}</div>}</>
                          : <span className="badge green">✅ ติดตั้งแล้ว</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{p.date ? <>{p.level === 'plan' && <span className="muted">กำหนดตามแผน </span>}{fmtDate(p.date)}</> : '-'}</td>
                      <td className="muted">{p.by ?? '-'}</td>
                      <td className="muted mono" style={{ whiteSpace: 'nowrap' }}>
                        <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                          📍 {p.lat.toFixed(5)}, {p.lng.toFixed(5)}{p.approx && ' (ประมาณ)'}
                        </a>
                        {p.photoUrl && <> · <a href={p.photoUrl} target="_blank" rel="noreferrer">🖼️</a></>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="panel-body muted">
            จากข้อมูลยืนยันติดตั้งที่โหลดล่าสุด — กด ↻ Refresh บนแถบด้านบนเพื่อดึงใหม่
          </div>
        </div>
      )}
    </>
  )
}
