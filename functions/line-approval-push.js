// Cloudflare Pages Function — ดันการ์ดคำขออนุมัติ (Flex + ปุ่ม ✅ อนุมัติ) เข้าแชท 1:1 ของผู้อนุมัติ
// route: POST /line-approval-push   body: { requestId }
// Frontend (StoreContext) เรียกหลัง project ขออนุมัติสำเร็จ (โหมด LIVE เท่านั้น)
// env: LINE_CHANNEL_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      VITE_SUPABASE_ANON_KEY (validate JWT ผู้เรียก), APP_URL (ลิงก์ตรวจสอบ)
import { createClient } from '@supabase/supabase-js'

// ⚠️ ต้องครบทุก type ใน approval_requests_req_type_check — เพิ่ม type ใหม่ที่ 0016/0028/0041
//    ต้องมาเติมที่นี่ด้วย ไม่งั้นการ์ดในมือถือบอกประเภทผิด
const TYPE_LABEL = {
  create_pr: 'ออก PR', issue_job: 'เบิกให้ Service', cancel_job: 'ยกเลิก Job',
  swap_lbs: 'สลับ LBS', reopen_job: 'เปิดงานใหม่',
}

// ⚠️ ห้าม fallback เป็นข้อความของ type อื่น — ผู้อนุมัติจะกด ✅ ให้เรื่องที่เข้าใจผิด
//    เคยพลาดจริง: 0041 เพิ่ม reopen_job แต่ไม่ได้แก้ที่นี่ → ไม่มีสาขาแล้วตกลงมาที่ 'ยกเลิก Job'
//    การ์ดบอกว่า "ยกเลิก Job" แต่กด ✅ แล้วระบบเปิดงานใหม่
function summarize(type, payload) {
  if (type === 'create_pr') return `ออก PR · ${(payload.request_ids ?? []).length} รายการ`
  if (type === 'issue_job') {
    const s = payload.start_date, e = payload.end_date
    const range = s === e ? s : `${s} – ${e}`
    return `ติดตั้ง ${range}${payload.location ? ' · ' + payload.location : ''}`
  }
  if (type === 'swap_lbs') return `สลับ LBS · เหตุผล: ${payload.reason ?? '-'}`
  if (type === 'reopen_job') return `เปิดงานใหม่ · เหตุผล: ${payload.reason ?? '-'}`
  if (type === 'cancel_job') return `ยกเลิก Job · เหตุผล: ${payload.reason ?? '-'}`
  return `คำขอประเภท "${type}" — การ์ดนี้อธิบายรายละเอียดไม่ได้ กรุณาเปิดตรวจในระบบ`
}

// canApprove = false เมื่อ type ไม่รู้จัก → ตัดปุ่ม ✅ ออก เหลือแค่ลิงก์เข้าระบบ
// (ปุ่มอนุมัติในมือถือไม่ควรมี เมื่อการ์ดอธิบายเรื่องที่จะอนุมัติไม่ได้)
function buildFlex(appUrl, reqId, typeLabel, jobNo, customer, detail, requester, canApprove) {
  const row = (label, val) => ({
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#8c8c8c', size: 'sm', flex: 2 },
      { type: 'text', text: val || '-', size: 'sm', flex: 5, wrap: true },
    ],
  })
  return {
    type: 'flex',
    altText: `🔔 คำขออนุมัติ${typeLabel}: ${jobNo}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: '#2563eb',
        contents: [{ type: 'text', text: '🔔 คำขออนุมัติจาก Project', weight: 'bold', color: '#ffffff', size: 'sm' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: typeLabel, weight: 'bold', size: 'lg' },
          { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
            row('Job', jobNo), row('ลูกค้า', customer), row('รายละเอียด', detail),
          ] },
          { type: 'text', text: `ผู้ขอ: ${requester}`, size: 'xs', color: '#8c8c8c' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          ...(canApprove ? [{ type: 'button', style: 'primary', color: '#16a34a', height: 'sm',
            action: { type: 'postback', label: '✅ อนุมัติ', data: `action=approve&req=${reqId}`, displayText: `อนุมัติ ${jobNo}` } }] : []),
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'uri', label: '🔎 ตรวจสอบในระบบ', uri: `${appUrl}/approvals` } },
          { type: 'text',
            text: canApprove ? 'ตีกลับได้ที่หน้าเว็บ (ต้องระบุเหตุผล)' : 'ประเภทคำขอนี้ต้องอนุมัติที่หน้าเว็บ',
            size: 'xxs', color: '#aaaaaa', align: 'center' },
        ],
      },
    },
  }
}

export async function onRequestPost(context) {
  const { request, env } = context
  const token = env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return Response.json({ ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN not configured' }, { status: 500 })

  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const anonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return Response.json({ ok: false, error: 'Supabase not configured' }, { status: 500 })

  // ตรวจ JWT ผู้เรียก — fail-CLOSED
  // ⚠️ ห้ามห่อด้วย `if (anonKey)` (โค้ดเดิมเป็นแบบนั้น) — endpoint นี้ดันการ์ดที่มี
  //    ปุ่ม ✅ อนุมัติจริง เข้าแชท 1:1 ของผู้อนุมัติทุกคน · ตรวจตัวตนไม่ได้ = ต้องปฏิเสธ ไม่ใช่ปล่อยผ่าน
  if (!anonKey) {
    console.error('[line-approval-push] VITE_SUPABASE_ANON_KEY ไม่ได้ตั้งค่า — ปฏิเสธทุก request (fail-closed)')
    return Response.json({ ok: false, error: 'Auth not configured' }, { status: 503 })
  }
  const jwt = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return Response.json({ ok: false, error: 'กรุณาเข้าสู่ระบบก่อน' }, { status: 401 })
  const asCaller = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: caller, error: authErr } = await asCaller.auth.getUser(jwt)
  if (authErr || !caller?.user) return Response.json({ ok: false, error: 'token ไม่ถูกต้อง' }, { status: 401 })

  // รับ requestId ตรง ๆ หรือระบุ jobId+type (คำขอ pending ต่อ job+type มีได้ตัวเดียว — unique index)
  let body
  try { body = await request.json() } catch { return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 }) }
  const { requestId, jobId, type } = body ?? {}
  if (!requestId && !(jobId && type)) return Response.json({ ok: false, error: 'requestId หรือ jobId+type จำเป็น' }, { status: 400 })

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } })

  // ด่านแผนก — เดิมเช็คแค่ "เป็น user ที่ login" ⇒ VIP (อ่านอย่างเดียว) / Service / session ที่หลุด
  // ดันการ์ดปุ่ม ✅ เข้าแชทผู้อนุมัติได้ทุกคน · ผู้เรียกที่ถูกต้องมีแค่คนที่ "ขออนุมัติ" ได้จริง
  // = ตรงกับ rpc_request_approval → app_assert_dept(ARRAY['project']) ซึ่งอนุญาต admin ในตัวอยู่แล้ว
  // (Division เป็นฝ่ายรับการ์ด ไม่ใช่ฝ่ายส่ง จึงไม่อยู่ในรายการนี้)
  const { data: me } = await sb.from('profiles')
    .select('department, is_active').eq('id', caller.user.id).maybeSingle()
  if (!me?.is_active || !['project', 'admin'].includes(me.department)) {
    return Response.json({ ok: false, error: 'แผนกของคุณไม่มีสิทธิ์ส่งการ์ดขออนุมัติ' }, { status: 403 })
  }

  let q = sb.from('approval_requests').select('*').eq('status', 'pending')
  q = requestId ? q.eq('id', requestId) : q.eq('job_id', jobId).eq('req_type', type)
  const { data: r, error: rErr } = await q.maybeSingle()
  if (rErr) return Response.json({ ok: false, error: rErr.message }, { status: 500 })
  if (!r) return Response.json({ ok: true, skipped: 'ไม่พบคำขอที่รออนุมัติ' })

  const { data: job } = await sb.from('jobs').select('job_no, customer_name').eq('id', r.job_id).maybeSingle()
  const { data: requester } = await sb.from('profiles').select('full_name').eq('id', r.requested_by).maybeSingle()

  // ผู้อนุมัติที่เชื่อม LINE แล้ว (Division/admin, ยัง active)
  const { data: approvers } = await sb.from('profiles').select('line_user_id')
    .in('department', ['sales', 'admin']).eq('is_active', true).not('line_user_id', 'is', null)
  const recipients = (approvers ?? []).map(a => a.line_user_id).filter(Boolean)
  if (recipients.length === 0) return Response.json({ ok: true, skipped: 'ยังไม่มีผู้อนุมัติที่เชื่อม LINE' })

  const appUrl = (env.APP_URL || 'https://lbs-platform-sdt.pages.dev').replace(/\/$/, '')
  const known = Object.prototype.hasOwnProperty.call(TYPE_LABEL, r.req_type)
  const typeLabel = known ? TYPE_LABEL[r.req_type] : `คำขอ (${r.req_type})`
  const flex = buildFlex(appUrl, r.id, typeLabel, job?.job_no ?? '-', job?.customer_name ?? '-',
    summarize(r.req_type, r.payload ?? {}), requester?.full_name ?? '-', known)

  const results = await Promise.all(recipients.map(to =>
    fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [flex] }),
    }).then(res => res.ok).catch(() => false)
  ))
  const sent = results.filter(Boolean).length
  return Response.json({ ok: true, sent, total: recipients.length })
}
