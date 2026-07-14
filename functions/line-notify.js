// Cloudflare Pages Function — ส่งข้อความแจ้งเตือนเข้า LINE group ผ่าน Messaging API (push)
// route: POST /line-notify   Frontend เรียกที่ StoreContext (settings.lineEndpoint)
// ตั้ง env ใน Cloudflare Pages: LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID
export async function onRequestPost(context) {
  const { request, env } = context

  const token = env.LINE_CHANNEL_ACCESS_TOKEN
  const to = env.LINE_GROUP_ID
  if (!token || !to) {
    return Response.json({ ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID not configured' }, { status: 500 })
  }

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
