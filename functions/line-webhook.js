// Cloudflare Pages Function — LINE Webhook (ตอบสถานะ Job จริง + ช่วยหา Group ID)
// route: POST /line-webhook   ตั้ง Webhook URL ใน LINE Developers Console เป็น:
//   https://lbs-platform-sdt.pages.dev/line-webhook
// env ที่ใช้: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET,
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (อ่านสถานะ Job — ชุดเดียวกับ admin-users),
//   LINE_GROUP_ID (ถ้าตั้งแล้ว: ตอบสถานะ Job เฉพาะในกลุ่มนี้ กันข้อมูลรั่วไปแชทอื่น)
// หมายเหตุ: ตรวจ signature ด้วย Web Crypto → ไม่ต้องเปิด nodejs_compat
import { createClient } from '@supabase/supabase-js'

const STATUS_TH = {
  draft: '📝 Draft — ยังไม่ได้ดึง LBS',
  allocated: '📦 Allocated — ดึง LBS แล้ว รอครบตาม Scope',
  procuring_accessory: '🛒 Procuring Accessory — รอวัสดุจาก PO',
  ready_to_issue: '✅ Ready to Issue — ของครบ พร้อมเบิกให้ Service',
  issued: '🚚 Issued — เบิกแล้ว รอติดตั้ง',
  installed: '🎉 Installed — ติดตั้งเสร็จแล้ว',
  cancelled: '❌ Cancelled — ยกเลิกแล้ว',
}

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

function getSb(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

// ปุ่ม ✅ อนุมัติ ใน Flex ส่ง postback data = "action=approve&req=<uuid>"
async function handleApprovePostback(env, token, replyToken, data, userId) {
  const sb = getSb(env)
  if (!sb) { await reply(token, replyToken, 'ยังไม่ได้เชื่อมต่อฐานข้อมูล — ตั้ง SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ก่อน'); return }
  const params = new URLSearchParams(data)
  const reqId = params.get('req')
  if (!reqId) { await reply(token, replyToken, 'คำขอไม่ถูกต้อง'); return }
  const { data: result, error } = await sb.rpc('rpc_line_approve', { p_request_id: reqId, p_line_user_id: userId })
  if (error) { await reply(token, replyToken, 'อนุมัติไม่สำเร็จ: ' + error.message); return }
  const MSG = {
    unlinked: '⚠️ บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ — เปิดแอป > ตั้งค่า > เชื่อมบัญชี LINE',
    inactive: '⚠️ บัญชีของคุณถูกปิดการใช้งาน',
    forbidden: '⛔ บัญชีของคุณไม่มีสิทธิ์อนุมัติ (เฉพาะ Division/Manage)',
    notfound: 'ไม่พบคำขออนุมัตินี้แล้ว',
    decided: 'คำขอนี้ถูกตัดสินไปแล้ว (อาจมีคนอนุมัติ/ตีกลับก่อนหน้า)',
  }
  if (typeof result === 'string' && result.startsWith('ok:')) {
    await reply(token, replyToken, `✅ อนุมัติเรียบร้อย — ${result.slice(3)}\nระบบดำเนินการให้แล้ว`)
  } else {
    await reply(token, replyToken, MSG[result] ?? ('อนุมัติไม่สำเร็จ: ' + result))
  }
}

// ตอบสถานะ Job จริงจาก Supabase (อ่านอย่างเดียว)
async function jobStatusText(env, jobNoRaw) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return 'ยังไม่ได้เชื่อมต่อฐานข้อมูล — ตั้ง SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY บน Cloudflare Pages ก่อน'

  const sb = createClient(url, key, { auth: { persistSession: false } })
  // ilike ไม่มี wildcard = เทียบเท่ากันแบบ case-insensitive (Job No. กรอกเอง อาจพิมพ์เล็ก/ใหญ่ต่างกัน)
  const { data: job, error } = await sb.from('jobs').select('*').ilike('job_no', jobNoRaw.trim()).maybeSingle()
  if (error) return 'อ่านข้อมูลไม่สำเร็จ: ' + error.message
  if (!job) return `ไม่พบงานเลขที่ "${jobNoRaw.trim()}" ในระบบ — ตรวจ Job No. อีกครั้ง`

  const { data: st } = await sb.from('v_job_status').select('*').eq('job_id', job.id).maybeSingle()
  const status = st?.status ?? 'draft'

  const lines = [
    `📋 ${job.job_no} — ${job.customer_name}`,
    `สถานะ: ${STATUS_TH[status] ?? status}`,
    `LBS: ${st?.lbs_allocated ?? 0}/${job.lbs_qty_required} เครื่อง`,
  ]
  if (job.scope) lines.push(`Scope: ${job.scope}`)
  if (status === 'issued' && job.install_start_date) {
    const range = job.install_start_date === job.install_end_date
      ? job.install_start_date : `${job.install_start_date} – ${job.install_end_date}`
    lines.push(`📅 นัดติดตั้ง: ${range}`, `📍 ${job.issue_location ?? job.install_location ?? '-'}`)
  } else if (status === 'installed') {
    lines.push(`📅 ติดตั้งเสร็จเมื่อ: ${job.installed_at?.slice(0, 10) ?? '-'}`)
  } else if (status === 'cancelled') {
    lines.push(`เหตุผล: ${job.cancel_reason ?? '-'}`)
  } else if (job.required_date) {
    lines.push(`กำหนดส่ง: ${job.required_date}`)
  }
  return lines.join('\n')
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
    // ปุ่มใน Flex (อนุมัติ) — postback จากแชท 1:1 ของผู้อนุมัติ
    if (ev.type === 'postback') {
      const data = ev.postback?.data ?? ''
      const userId = ev.source?.userId
      if (data.startsWith('action=approve') && userId) {
        await handleApprovePostback(env, accessToken, ev.replyToken, data, userId)
      }
      continue
    }

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

      // เชื่อมบัญชี: พิมพ์โค้ด 6 หลัก (จากแอป > ตั้งค่า > เชื่อมบัญชี LINE) ในแชท 1:1
      if (/^\d{6}$/.test(text) && src.userId) {
        const sb = getSb(env)
        if (!sb) { await reply(accessToken, ev.replyToken, 'ยังไม่ได้เชื่อมต่อฐานข้อมูล'); continue }
        const { data: name, error } = await sb.rpc('app_line_bind', { p_code: text, p_line_user_id: src.userId })
        if (error) await reply(accessToken, ev.replyToken, 'เชื่อมบัญชีไม่สำเร็จ: ' + error.message)
        else if (name) await reply(accessToken, ev.replyToken, `✅ เชื่อมบัญชีสำเร็จ: ${name}\nจากนี้จะได้รับคำขออนุมัติที่นี่ กดปุ่มอนุมัติได้เลย`)
        else await reply(accessToken, ev.replyToken, '⚠️ โค้ดไม่ถูกต้องหรือหมดอายุ — สร้างโค้ดใหม่ในแอปแล้วลองอีกครั้ง (โค้ดมีอายุ 10 นาที)')
        continue
      }

      // สอบถามสถานะ Job: "สถานะ <Job No.>"
      const m = text.match(/^สถานะ\s+(.+)$/i)
      if (m) {
        // กันข้อมูลรั่ว: ถ้าตั้ง LINE_GROUP_ID แล้ว ตอบสถานะเฉพาะในกลุ่มที่ลงทะเบียน
        if (env.LINE_GROUP_ID && src.groupId !== env.LINE_GROUP_ID) {
          await reply(accessToken, ev.replyToken, 'ขออภัย บอทตอบสถานะงานได้เฉพาะในกลุ่มที่ลงทะเบียนไว้ครับ 🙏')
          continue
        }
        await reply(accessToken, ev.replyToken, await jobStatusText(env, m[1]))
        continue
      }

      await reply(accessToken, ev.replyToken,
        'สวัสดีครับ 115kV LBS Platform 🙏\nพิมพ์ "สถานะ <Job No.>" เช่น "สถานะ JOB-2026-0002" เพื่อดูสถานะงาน\nพิมพ์ "id" เพื่อดู Group ID (สำหรับตั้งค่าแจ้งเตือน)')
    }
  }
  return Response.json({ ok: true })
}
