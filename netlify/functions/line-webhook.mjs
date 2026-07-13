// LINE Webhook สำหรับตอบโต้ลูกค้า (Phase 2)
// ตั้งค่า Webhook URL ใน LINE Developers Console เป็น:
//   https://<your-site>.netlify.app/.netlify/functions/line-webhook
// ตั้ง env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET

import crypto from 'node:crypto'

async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 })

  const body = await req.text()

  // ตรวจ signature กันคนอื่นยิง webhook ปลอม
  const secret = process.env.LINE_CHANNEL_SECRET
  if (secret) {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64')
    if (signature !== req.headers.get('x-line-signature')) {
      return new Response('Bad signature', { status: 403 })
    }
  }

  const { events = [] } = JSON.parse(body)
  for (const ev of events) {
    if (ev.type === 'message' && ev.message?.type === 'text') {
      const text = ev.message.text.trim()
      // TODO Phase 2: ต่อ Supabase เพื่อตอบสถานะ Job จริง เช่นลูกค้าพิมพ์ "สถานะ JOB-2026-0001"
      if (/^สถานะ\s+JOB-/i.test(text)) {
        await reply(ev.replyToken, `ระบบรับเรื่องตรวจสอบ "${text}" แล้ว เจ้าหน้าที่ Project จะติดต่อกลับโดยเร็วครับ`)
      } else {
        await reply(ev.replyToken,
          'สวัสดีครับ 115kV LBS Platform 🙏\nพิมพ์ "สถานะ JOB-XXXX-XXXX" เพื่อสอบถามสถานะงาน หรือรอเจ้าหน้าที่ตอบกลับครับ')
      }
    }
  }
  return Response.json({ ok: true })
}
