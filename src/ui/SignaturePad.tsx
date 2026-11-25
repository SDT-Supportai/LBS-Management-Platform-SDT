import { useEffect, useRef } from 'react'

// =============================================================================
// แผ่นเซ็นอิเล็กทรอนิกส์ (0100 Service Letter · คำตอบผู้ใช้ข้อ 4) — ยกตรรกะจาก initSigPad ของ ServiceMS
//   วาดด้วยนิ้ว/เมาส์/ปากกา (Pointer Events) → ส่งออกเป็น PNG data URL ผ่าน onChange
//   ว่าง = onChange('') · ค่าที่ได้ผ่าน safeSigImage ได้เสมอ (data:image/png;base64,…)
//   ⚠️ ไม่มีการเก็บลายเซ็นถาวร — เซ็นต่อฉบับเท่านั้น
// =============================================================================
const W = 520
const H = 170

export function SignaturePad({ value, onChange, disabled }: {
  value: string
  onChange: (dataUrl: string) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  // เริ่มด้วยพื้นขาว (PNG โปร่งใสบนกระดาษพิมพ์ก็ได้ แต่พื้นขาวทำให้ตัวอย่างตรงกับที่พิมพ์)
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    if (value) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, W, H)
      img.src = value
      dirty.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }
  }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = pos(e)
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return
    const ctx = e.currentTarget.getContext('2d')!
    const p = pos(e)
    ctx.strokeStyle = '#0f2a6b'
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
    dirty.current = true
  }
  const up = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    if (dirty.current && ref.current) onChange(ref.current.toDataURL('image/png'))
  }
  const clear = () => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, W, H)
    dirty.current = false
    onChange('')
  }

  return (
    <div className="sig-pad">
      <canvas ref={ref} width={W} height={H} aria-label="ช่องเซ็นชื่อ"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      <div className="sig-pad-bar">
        <span className="muted">{value ? '✓ เซ็นแล้ว' : 'เซ็นชื่อในกรอบด้วยเมาส์ / นิ้ว / ปากกา'}</span>
        <button type="button" className="small" disabled={disabled} onClick={clear}>ล้าง</button>
      </div>
    </div>
  )
}
