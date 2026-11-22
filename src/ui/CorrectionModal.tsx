import { useState } from 'react'
import { useStore } from '../data/StoreContext'
import { ACCEPTANCE_TYPES, jobInstalledUnits, jobWarranties, correctionLabel } from '../data/logic'
import { Modal, useTryAction } from './components'
import { fmtDate } from './format'
import type { AcceptanceType, CloseoutCorrection, Job } from '../types'

// =============================================================================
// 0094 — ขอแก้ข้อมูลที่บันทึกผิดหลังปิดงาน → รอ Division พิจารณา (มติผู้ใช้ Q2 2026-11-22)
//   เริ่มนับประกันแล้วเปิดงานใหม่ไม่ได้ ⇒ แก้ผ่านคำขอนี้แทน · งานยังปิดอยู่ · หลักฐานเดิมไม่ถูกลบ
//   แก้ได้ 4 แบบ: วันที่ติดตั้งรายเครื่อง · วันประกัน · เอกสารรับมอบ · Serial ที่ยืนยันสลับกัน (2 เครื่องบนใบเดียวกัน)
//   DB ตรวจซ้ำที่ rpc_request_closeout_correction และตอนอนุมัติ (app_exec_correct_closeout)
// =============================================================================
type Kind = CloseoutCorrection['kind']
const KIND_LABEL: Record<Kind, string> = {
  install_date: 'วันที่ติดตั้งรายเครื่อง',
  warranty: 'วันเริ่ม / สิ้นสุดประกัน',
  acceptance: 'เอกสารรับมอบ',
  swap_serial: 'Serial ที่ยืนยันสลับกัน',
}

export function CorrectionModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const { db, act } = useStore()
  const tryAction = useTryAction()
  const units = jobInstalledUnits(db, job.id)
  const warranties = jobWarranties(db, job.id)
  const instW = warranties.find(w => w.kind === 'installation')

  const [kind, setKind] = useState<Kind>('install_date')
  const [unitId, setUnitId] = useState(units[0]?.unit.id ?? '')
  const [date, setDate] = useState('')
  const [wTarget, setWTarget] = useState<string>('')                 // '' = ประกันงานติดตั้ง
  const [wStart, setWStart] = useState(instW?.startDate ?? '')
  const [wEnd, setWEnd] = useState(instW?.endDate ?? '')
  const [accType, setAccType] = useState<AcceptanceType>(job.acceptanceType ?? 'HANDOVER')
  const [accNo, setAccNo] = useState(job.acceptanceDocNo ?? '')
  const [accDate, setAccDate] = useState(job.acceptanceDate ?? '')
  const [swap, setSwap] = useState<string[]>([])
  const [reason, setReason] = useState('')

  const pickWarranty = (target: string) => {
    setWTarget(target)
    const w = target ? warranties.find(x => x.kind === 'lbs' && x.unitId === target) : instW
    setWStart(w?.startDate ?? ''); setWEnd(w?.endDate ?? '')
  }

  const correction: CloseoutCorrection | null =
    kind === 'install_date' ? (unitId && date ? { kind, unitId, installedDate: date } : null)
    : kind === 'warranty' ? (wStart && wEnd ? { kind, unitId: wTarget || undefined, startDate: wStart, endDate: wEnd } : null)
    : kind === 'acceptance' ? (accDate ? { kind, acceptanceType: accType, acceptanceDocNo: accNo.trim() || undefined, acceptanceDate: accDate } : null)
    : swap.length === 2 ? { kind, unitIds: swap } : null

  const submit = async () => {
    if (!correction) return
    const ok = await tryAction(() => act.requestCloseoutCorrection({ jobId: job.id, reason, correction }),
      `ส่งคำขอแก้ข้อมูล ${job.jobNo} แล้ว — รอ Division พิจารณา`)
    if (ok) onClose()
  }

  return (
    <Modal title={`ขอแก้ข้อมูลที่บันทึกผิด — ${job.jobNo}`} size="wide" onClose={onClose}
      footer={<>
        <button onClick={onClose}>ยกเลิก</button>
        <button className="primary" disabled={!correction || !reason.trim()} onClick={submit}>ส่งคำขอให้ Division พิจารณา</button>
      </>}>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-body muted" style={{ fontSize: 13 }}>
          งานนี้เริ่มนับประกันแล้ว จึง<b>เปิดงานใหม่ไม่ได้</b> — แก้ข้อมูลที่บันทึกผิดผ่านคำขอนี้แทน<br />
          งาน<b>ยังปิดอยู่</b> · ข้อมูลเดิมไม่ถูกลบ (เก็บในประวัติ/Audit พร้อมเหตุผล) · มีผลเมื่อ Division อนุมัติ
        </div>
      </div>

      <label className="field"><span>ต้องการแก้อะไร *</span>
        <select value={kind} onChange={e => setKind(e.target.value as Kind)}>
          {(Object.keys(KIND_LABEL) as Kind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>

      {kind === 'install_date' && (
        <div className="row">
          <label className="field"><span>เครื่อง *</span>
            <select value={unitId} onChange={e => setUnitId(e.target.value)}>
              {units.map(({ unit, installedDate }) => (
                <option key={unit.id} value={unit.id}>{unit.serialLvb} — เดิม {fmtDate(installedDate)}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>วันที่ติดตั้งที่ถูกต้อง *</span>
            <input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={e => setDate(e.target.value)} />
          </label>
        </div>
      )}
      {kind === 'install_date' && (
        <div className="muted" style={{ marginBottom: 10 }}>
          ประกันตัวเครื่องที่เริ่มนับตามวันติดตั้งเดิม จะเลื่อนตามวันที่ใหม่ให้อัตโนมัติ (ระยะประกันเท่าเดิม)
        </div>
      )}

      {kind === 'warranty' && (
        <>
          <label className="field"><span>ประกันที่จะแก้ *</span>
            <select value={wTarget} onChange={e => pickWarranty(e.target.value)}>
              <option value="">ประกันงานติดตั้ง (Installation)</option>
              {units.map(({ unit }) => <option key={unit.id} value={unit.id}>ประกันตัวเครื่อง {unit.serialLvb}</option>)}
            </select>
          </label>
          <div className="row">
            <label className="field"><span>วันเริ่ม *</span><input type="date" value={wStart} onChange={e => setWStart(e.target.value)} /></label>
            <label className="field"><span>วันสิ้นสุด *</span><input type="date" value={wEnd} onChange={e => setWEnd(e.target.value)} /></label>
          </div>
        </>
      )}

      {kind === 'acceptance' && (
        <>
          <div className="row">
            <label className="field"><span>ประเภทเอกสาร *</span>
              <select value={accType} onChange={e => setAccType(e.target.value as AcceptanceType)}>
                {ACCEPTANCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="field"><span>เลขที่เอกสาร</span><input value={accNo} onChange={e => setAccNo(e.target.value)} /></label>
            <label className="field"><span>วันที่เอกสาร *</span><input type="date" value={accDate} onChange={e => setAccDate(e.target.value)} /></label>
          </div>
          <div className="muted" style={{ marginBottom: 10 }}>
            เปลี่ยนประเภทเอกสาร ต้องแนบไฟล์ประเภทนั้นไว้ก่อน (แนบได้ที่หน้า Service (Warranty))
          </div>
        </>
      )}

      {kind === 'swap_serial' && (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            เลือก <b>2 เครื่อง</b> ที่ยืนยันสลับกัน — วันที่ · GPS · รูป · ช่าง และประกันตัวเครื่องจะสลับไปอยู่กับเครื่องที่ถูกต้อง
          </div>
          {units.map(({ unit, installedDate }) => (
            <label key={unit.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
              <input type="checkbox" checked={swap.includes(unit.id)}
                disabled={!swap.includes(unit.id) && swap.length >= 2}
                onChange={() => setSwap(p => p.includes(unit.id) ? p.filter(x => x !== unit.id) : [...p, unit.id])} />
              <span className="mono">{unit.serialLvb}</span>
              <span className="muted">· ติดตั้ง {fmtDate(installedDate)}</span>
            </label>
          ))}
        </>
      )}

      <label className="field" style={{ marginTop: 10 }}><span>เหตุผล *</span>
        <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
          placeholder="เช่น ช่างกรอกวันที่ผิด — วันติดตั้งจริงตามใบส่งงานคือ 4 ก.ย." />
      </label>
      {correction && (
        <div className="muted">สรุปคำขอ: <b>{correctionLabel(db, correction)}</b></div>
      )}
    </Modal>
  )
}
