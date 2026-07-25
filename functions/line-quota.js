// Cloudflare Pages Function — ตรวจโควตา LINE Messaging API (push message quota)
// route: GET /line-quota   Frontend เรียกที่ DevSettings (ปุ่ม "ตรวจโควตา Messaging API")
// ใช้ env เดียวกับ line-notify: LINE_CHANNEL_ACCESS_TOKEN (+ Supabase JWT กันคนนอก)
// LINE API: /message/quota (ลิมิต/เดือน) + /message/quota/consumption (ใช้ไปเดือนนี้)
import { createClient } from '@supabase/supabase-js'

export async function onRequestGet(context) {
  const { request, env } = context

  const token = env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) {
    return Response.json({ ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN not configured' }, { status: 500 })
  }

  // ตรวจตัวตนผู้เรียก: ต้อง login ในระบบ (validate JWT แบบเดียวกับ line-notify)
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const anonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
  if (url && anonKey) {
    const jwt = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!jwt) return Response.json({ ok: false, error: 'กรุณาเข้าสู่ระบบก่อน (missing token)' }, { status: 401 })
    const asCaller = createClient(url, anonKey, { auth: { persistSession: false } })
    const { data: caller, error: authErr } = await asCaller.auth.getUser(jwt)
    if (authErr || !caller?.user) {
      return Response.json({ ok: false, error: 'token ไม่ถูกต้อง' }, { status: 401 })
    }
  }

  const headers = { Authorization: `Bearer ${token}` }
  try {
    const [qRes, cRes] = await Promise.all([
      fetch('https://api.line.me/v2/bot/message/quota', { headers }),
      fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers }),
    ])
    if (!qRes.ok) {
      const detail = await qRes.text()
      return Response.json({ ok: false, error: `LINE API ${qRes.status}: ${detail}` }, { status: 502 })
    }
    const q = await qRes.json()               // { type: 'limited'|'none', value?: number }
    const c = cRes.ok ? await cRes.json() : { totalUsage: 0 }   // { totalUsage: number }
    const limit = q.type === 'limited' ? Number(q.value ?? 0) : null   // null = ไม่จำกัด
    const used = Number(c.totalUsage ?? 0)
    return Response.json({
      ok: true,
      type: q.type,
      limit,
      used,
      remaining: limit === null ? null : Math.max(0, limit - used),
    })
  } catch (e) {
    return Response.json({ ok: false, error: `เรียก LINE API ไม่ได้: ${e}` }, { status: 502 })
  }
}
