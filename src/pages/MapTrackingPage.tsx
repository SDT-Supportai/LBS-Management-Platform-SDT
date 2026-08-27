import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useStore } from '../data/StoreContext'
import { fmtDate, fmtDateTime } from '../ui/format'
import { memberFullName } from '../data/logic'

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
// พิกัดที่หลุดออกนอกกรอบนี้ = ข้อมูลผิด (เช่นสลับ lat/lng) — กันหมุดหลุดไปอยู่กลางทะเลจีน
const TH_BOUNDS = { minLat: 5.5, maxLat: 20.6, minLng: 97.3, maxLng: 105.7 }
const inThailand = (lat: number, lng: number) =>
  lat >= TH_BOUNDS.minLat && lat <= TH_BOUNDS.maxLat && lng >= TH_BOUNDS.minLng && lng <= TH_BOUNDS.maxLng

type Pin = {
  key: string
  lat: number
  lng: number
  /** ราย Serial (unit_installations) หรือ ระดับงาน (jobs.install_checkin_*) */
  level: 'unit' | 'job'
  outcome: 'installed' | 'blocked'
  jobId: string
  jobNo: string
  customer: string
  location: string
  serial?: string
  serialOm?: string
  date?: string
  by?: string
  photoUrl?: string
  note?: string
}

/** หมุดที่พิกัดเดียวกัน (ปัดทศนิยม 5 ตำแหน่ง ≈ 1 เมตร) รวมเป็นหมุดเดียว ไม่งั้นทับกันอ่านไม่ออก */
function groupPins(pins: Pin[]) {
  const m = new Map<string, Pin[]>()
  pins.forEach(p => {
    const k = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
    const arr = m.get(k) ?? []
    arr.push(p)
    m.set(k, arr)
  })
  return [...m.values()]
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export default function MapTrackingPage() {
  const { db } = useStore()
  const boxRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const [showJobLevel, setShowJobLevel] = useState(true)
  const [expanded, setExpanded] = useState(false)          // ขยายแผนที่เต็มจอ
  const [search, setSearch] = useState('')
  const [onlyBlocked, setOnlyBlocked] = useState(false)

  const userOf = (id?: string) => db.users.find(u => u.id === id)?.fullName ?? '-'

  // ---- รวบพิกัดจาก 2 แหล่ง ----
  const allPins = useMemo<Pin[]>(() => {
    const out: Pin[] = []

    // 1) ราย Serial — เอาแถวล่าสุดต่อเครื่อง (unitInstallations เป็น log หลายแถวต่อเครื่องได้)
    const latestByUnit = new Map<string, typeof db.unitInstallations[number]>()
    db.unitInstallations.forEach(r => {
      const cur = latestByUnit.get(r.unitId)
      if (!cur || r.performedAt > cur.performedAt) latestByUnit.set(r.unitId, r)
    })
    latestByUnit.forEach(r => {
      if (r.checkinLat == null || r.checkinLng == null) return          // blocked ไม่บังคับเช็คอิน
      if (!inThailand(r.checkinLat, r.checkinLng)) return
      const unit = db.lbsUnits.find(u => u.id === r.unitId)
      const job = db.jobs.find(j => j.id === r.jobId)
      if (!job) return
      out.push({
        key: `u:${r.id}`, lat: r.checkinLat, lng: r.checkinLng, level: 'unit',
        outcome: r.outcome, jobId: job.id, jobNo: job.jobNo, customer: job.customerName,
        location: job.issueLocation || job.installLocation || '-',
        serial: unit?.serialLvb, serialOm: unit?.serialOm,
        date: r.installedDate ?? r.performedAt,
        by: r.installedByMemberId ? memberFullName(db, r.installedByMemberId) : userOf(r.performedBy),
        photoUrl: r.photoUrl, note: r.reason || r.note,
      })
    })

    // 2) ระดับงาน (งานเก่าก่อน 0035) — ข้ามงานที่มีหมุดราย Serial อยู่แล้ว กันหมุดซ้อน
    const jobsWithUnitPins = new Set(out.map(p => p.jobId))
    db.jobs.forEach(j => {
      if (j.installCheckinLat == null || j.installCheckinLng == null) return
      if (jobsWithUnitPins.has(j.id)) return
      if (!inThailand(j.installCheckinLat, j.installCheckinLng)) return
      out.push({
        key: `j:${j.id}`, lat: j.installCheckinLat, lng: j.installCheckinLng, level: 'job',
        outcome: 'installed', jobId: j.id, jobNo: j.jobNo, customer: j.customerName,
        location: j.issueLocation || j.installLocation || '-',
        date: j.installedAt, by: userOf(j.installConfirmedBy),
        photoUrl: j.installPhotoUrl, note: j.installNote,
      })
    })
    return out
  }, [db])

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
      if (onlyBlocked && p.outcome !== 'blocked') return false
      if (!t) return true
      return [p.jobNo, p.customer, p.location, p.serial, p.serialOm]
        .some(v => v?.toLowerCase().includes(t))
    })
  }, [allPins, search, showJobLevel, onlyBlocked])

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
      const n = g.length
      const cls = blocked ? 'mp-pin blocked' : 'mp-pin'
      const icon = L.divIcon({
        className: 'mp-pin-wrap',
        html: `<span class="${cls}">${n > 1 ? n : ''}</span>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      })
      // hover = Job No. (สิ่งที่ผู้ใช้ขอ) · คลิก = รายละเอียดเต็ม
      const jobNos = [...new Set(g.map(p => p.jobNo))]
      const tip = jobNos.length === 1
        ? `<b>${esc(jobNos[0])}</b>${n > 1 ? ` · ${n} เครื่อง` : g[0].serial ? ` · ${esc(g[0].serial)}` : ''}`
        : `<b>${jobNos.map(esc).join(' · ')}</b> (${n} จุด)`
      const body = g.map(p => `
        <div class="mp-row">
          <div><b>${esc(p.jobNo)}</b> · ${esc(p.customer)}</div>
          <div class="mp-sub">${esc(p.location)}</div>
          <div class="mp-sub">
            ${p.level === 'unit'
              ? `Serial <span class="mp-mono">${esc(p.serial ?? '-')}</span>${p.serialOm ? ` / <span class="mp-mono">${esc(p.serialOm)}</span>` : ''}`
              : 'เช็คอินระดับงาน (ก่อนแยกราย Serial)'}
          </div>
          <div class="mp-sub">${p.outcome === 'blocked' ? '⚠️ ติดตั้งไม่ได้' : '✅ ติดตั้งแล้ว'} ${p.date ? esc(fmtDate(p.date)) : ''} · ${esc(p.by ?? '-')}</div>
          ${p.note ? `<div class="mp-sub">📝 ${esc(p.note)}</div>` : ''}
          ${p.photoUrl ? `<div class="mp-sub"><a href="${esc(p.photoUrl)}" target="_blank" rel="noreferrer">🖼️ รูปหน้างาน</a></div>` : ''}
          <div class="mp-sub"><a href="#/jobs/${esc(p.jobId)}">เปิดหน้า Job →</a></div>
        </div>`).join('')

      L.marker([g[0].lat, g[0].lng], { icon })
        .bindTooltip(tip, { direction: 'top', offset: [0, -12] })
        .bindPopup(`<div class="mp-pop">${body}</div>`, { maxWidth: 320 })
        .addTo(layer)
    })

    if (groups.length > 0) {
      map.fitBounds(L.latLngBounds(groups.map(g => [g[0].lat, g[0].lng] as [number, number])).pad(0.25),
        { maxZoom: 12 })
    } else {
      map.setView(TH_CENTER, TH_ZOOM)
    }
  }, [pins])

  const unitPins = allPins.filter(p => p.level === 'unit')
  const jobPins = allPins.filter(p => p.level === 'job')
  const blockedCount = pins.filter(p => p.outcome === 'blocked').length

  return (
    <>
      <div className="page-title">Map Tracking — ประเทศไทย</div>
      <div className="page-sub">
        ตำแหน่งติดตั้งจริงจากการ <b>Check-in ราย Serial</b> ตอนที่ Service ยืนยันหน้างาน —
        ชี้ที่หมุดเพื่อดู <b>Job No.</b> · คลิกเพื่อดู Serial / ช่างผู้ติดตั้ง / รูปหน้างาน
      </div>

      <div className="cards" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="label">จุดติดตั้งบนแผนที่</div>
          <div className="value">{pins.length}<span className="muted">/{allPins.length}</span></div>
          <div className="hint">ราย Serial {unitPins.length} · ระดับงาน {jobPins.length}</div>
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
              : 'ไม่มีจุดที่ติดตั้งไม่สำเร็จ'}
          </div>
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
            <button className="small" onClick={() => setExpanded(true)} title="ขยายแผนที่เต็มจอ (ออกด้วย Esc)">
              ⛶ ขยายเต็มจอ
            </button>
          </div>
        </div>
        <div className="panel-body">
          {allPins.length === 0 && (
            <div className="empty" style={{ marginBottom: 10 }}>
              ยังไม่มีการ Check-in — หมุดจะขึ้นเองเมื่อ Service ยืนยันติดตั้งรายเครื่องพร้อมพิกัด GPS
            </div>
          )}
          {/* กล่องแผนที่ตัวเดิมย้ายเข้า .map-wrap เพื่อให้โหมดเต็มจอเปลี่ยนแค่ CSS
              — ไม่ทำลาย/สร้าง map instance ใหม่ หมุดกับตำแหน่งที่เลื่อนไว้จึงไม่รีเซ็ต */}
          <div className={`map-wrap${expanded ? ' expanded' : ''}`}>
            <div ref={boxRef} className="map-box" />
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
                    <tr key={p.key}>
                      <td><Link to={`/jobs/${p.jobId}`}><b>{p.jobNo}</b></Link><div className="muted">{p.customer}</div></td>
                      <td className="mono">
                        {p.level === 'unit'
                          ? <>{p.serial ?? '-'}<div className="muted mono">{p.serialOm}</div></>
                          : <span className="badge neutral">ระดับงาน</span>}
                      </td>
                      <td>{p.location}</td>
                      <td>{p.outcome === 'blocked'
                        ? <span className="badge red">⚠️ ติดตั้งไม่ได้</span>
                        : <span className="badge green">✅ ติดตั้งแล้ว</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{p.date ? fmtDate(p.date) : '-'}</td>
                      <td className="muted">{p.by ?? '-'}</td>
                      <td className="muted mono" style={{ whiteSpace: 'nowrap' }}>
                        <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">
                          📍 {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                        </a>
                        {p.photoUrl && <> · <a href={p.photoUrl} target="_blank" rel="noreferrer">🖼️</a></>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="panel-body muted">
            อัปเดตล่าสุดจากข้อมูลยืนยันติดตั้ง — {fmtDateTime(new Date().toISOString())}
          </div>
        </div>
      )}
    </>
  )
}
