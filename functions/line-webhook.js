// Cloudflare Pages Function — LINE Webhook (ตอบโต้ลูกค้า + ช่วยหา Group ID)
// route: POST /line-webhook   ตั้ง Webhook URL ใน LINE Developers Console เป็น:
//   https://<your-project>.pages.dev/line-webhook
// ตั้ง env ใน Cloudflare Pages: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET
// หมายเหตุ: ตรวจ signature ด้วย Web Crypto (SubtleCrypto) → รันบน Workers runtime ได้โดยไม่ต้องเปิด nodejs_compat

async function hmacSha256Base64(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function reply(token, replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
}

export async function onRequestPost(context) {
  const { request, env } = context
  const accessToken = env.LINE_CHANNEL_ACCESS_TOKEN
  const body = await request.text()

  // ตรวจ signature กันคนอื่นยิง webhook ปลอม
  const secret = env.LINE_CHANNEL_SECRET
  if (secret) {
    const signature = await hmacSha256Base64(secret, body)
    if (signature !== request.headers.get('x-line-signature')) {
      return new Response('Bad signature', { status: 403 })
    }
  }

  const { events = [] } = JSON.parse(body)
  for (const ev of events) {
    if (ev.type === 'message' && ev.message?.type === 'text') {
      const text = ev.message.text.trim()
      const src = ev.source ?? {}

      // ช่วยตั้งค่า: พิมพ์ "id" ในกลุ่ม -> บอทตอบ Group ID (เอาไปใส่ LINE_GROUP_ID)
      if (/^\/?(id|groupid|group id)$/i.test(text)) {
        const id = src.groupId ?? src.roomId ?? src.userId ?? '(ไม่พบ)'
        const label = src.groupId ? 'Group ID' : src.roomId ? 'Room ID' : 'User ID'
        await reply(accessToken, ev.replyToken, `${label}:\n${id}\n\nนำค่านี้ไปใส่ env LINE_GROUP_ID บน Cloudflare Pages แล้ว redeploy`)
        continue
      }

      // TODO Phase 2: ต่อ Supabase เพื่อตอบสถานะ Job จริง
      if (/^สถานะ\s+JOB-/i.test(text)) {
        await reply(accessToken, ev.replyToken, `ระบบรับเรื่องตรวจสอบ "${text}" แล้ว เจ้าหน้าที่ Project จะติดต่อกลับโดยเร็วครับ`)
      } else {
        await reply(accessToken, ev.replyToken,
          'สวัสดีครับ 115kV LBS Platform 🙏\nพิมพ์ "id" เพื่อดู Group ID (สำหรับตั้งค่าแจ้งเตือน)\nพิมพ์ "สถานะ JOB-XXXX-XXXX" เพื่อสอบถามสถานะงาน')
      }
    }
  }
  return Response.json({ ok: true })
}
