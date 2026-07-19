// Cloudflare Pages Function — ส่งข้อความแจ้งเตือนเข้า LINE group ผ่าน Messaging API (push)
// route: POST /line-notify   Frontend เรียกที่ StoreContext (settings.lineEndpoint)
// ตั้ง env ใน Cloudflare Pages: LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID
// (2026-07-19) ต้องแนบ Supabase JWT — กันคนนอกยิงข้อความเข้ากลุ่มทีม (endpoint เคยเปิดสาธารณะ)
import { createClient } from '@supabase/supabase-js'

export async function onRequestPost(context) {
  const { request, env } = context

  const token = env.LINE_CHANNEL_ACCESS_TOKEN
  const to = env.LINE_GROUP_ID
  if (!token || !to) {
    return Response.json({ ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID not configured' }, { status: 500 })
  }

  // ตรวจตัวตนผู้เรียก: ต้องเป็น user ที่ login ในระบบ (validate JWT ด้วย anon key แบบเดียวกับ admin-users)
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
  // (ไม่ตั้ง SUPABASE_URL/ANON_KEY = โหมดไม่มี DB — ข้ามการตรวจ เพื่อไม่ล็อกตัวเองตอน setup ครั้งแรก)

  let message
  try {
    ({ message } = await request.json())
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }
  if (!message || typeof message !== 'string') {
    return Response.json({ ok: false, error: 'message required' }, { status: 400 })
  }

  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: message.slice(0, 4900) }] }),
  })

  if (!r.ok) {
    const detail = await r.text()
    return Response.json({ ok: false, error: `LINE API ${r.status}: ${detail}` }, { status: 502 })
  }
  return Response.json({ ok: true })
}
