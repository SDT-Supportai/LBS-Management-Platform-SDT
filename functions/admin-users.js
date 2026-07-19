// Cloudflare Pages Function — จัดการผู้ใช้ด้วย Supabase service role (สร้าง user / เปลี่ยนรหัสผ่าน)
// route: POST /admin-users  (frontend เรียกที่ remote.ts → callAdminFn)
// ทำฝั่ง server เท่านั้น + อนุญาตเฉพาะผู้เรียกที่เป็นแผนก admin
// ตั้ง env ใน Cloudflare Pages → Settings → Environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_ANON_KEY
//   (VITE_SUPABASE_ANON_KEY ใช้ตรวจ token ของผู้เรียก — service key แบบใหม่ sb_secret_
//    มีข้อจำกัดบน auth endpoint จึงไม่ใช้ตรวจ token)
import { createClient } from '@supabase/supabase-js'

export async function onRequestPost(context) {
  const { request, env } = context

  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
  if (!url || !serviceKey) {
    return Response.json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' }, { status: 500 })
  }

  // ตรวจตัวตนผู้เรียกจาก JWT ด้วย anon key (validate ถูกต้องกว่าใช้ secret key)
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return Response.json({ error: 'กรุณาเข้าสู่ระบบก่อน' }, { status: 401 })

  const asCaller = createClient(url, anonKey || serviceKey, { auth: { persistSession: false } })
  const { data: caller, error: authErr } = await asCaller.auth.getUser(token)
  if (authErr || !caller?.user) {
    return Response.json({ error: 'token ไม่ถูกต้อง: ' + (authErr?.message ?? 'no user') }, { status: 401 })
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: profile, error: profErr } = await admin
    .from('profiles').select('department, is_active').eq('id', caller.user.id).single()
  if (profErr) return Response.json({ error: 'อ่าน profile ไม่ได้ (service key อาจไม่ถูกต้อง): ' + profErr.message }, { status: 500 })
  if (!profile?.is_active || profile.department !== 'admin') {
    return Response.json({ error: 'เฉพาะผู้ดูแลระบบ (admin) เท่านั้น' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }) }

  try {
    if (body.action === 'create') {
      const { email, password, fullName, department } = body
      if (!email || !password || !fullName || !department) {
        return Response.json({ error: 'กรุณาระบุอีเมล รหัสผ่าน ชื่อ และแผนก' }, { status: 400 })
      }
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { full_name: fullName, department },
      })
      if (error) return Response.json({ error: error.message }, { status: 400 })
      await admin.from('profiles').update({ full_name: fullName, department }).eq('id', data.user.id)
      await admin.from('audit_logs').insert({
        entity_type: 'user', entity_id: data.user.id, action: 'create_user',
        actor_id: caller.user.id, detail: `เพิ่มผู้ใช้ ${fullName} (${email}) แผนก ${department}`,
      })
      return Response.json({ ok: true, userId: data.user.id })
    }

    // เปลี่ยนอีเมล (= อีเมลที่ใช้ login) — อัปเดตทั้ง auth.users และ profiles ให้ตรงกัน
    if (body.action === 'set_email') {
      const { userId, email } = body
      const em = String(email ?? '').trim().toLowerCase()
      if (!userId || !em) return Response.json({ error: 'กรุณาระบุผู้ใช้และอีเมลใหม่' }, { status: 400 })
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return Response.json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' }, { status: 400 })
      const { data: dup } = await admin.from('profiles').select('id').eq('email', em).neq('id', userId).maybeSingle()
      if (dup) return Response.json({ error: `อีเมล ${em} มีผู้ใช้อยู่แล้ว` }, { status: 400 })
      const { error } = await admin.auth.admin.updateUserById(userId, { email: em, email_confirm: true })
      if (error) return Response.json({ error: error.message }, { status: 400 })
      const { error: profErr2 } = await admin.from('profiles').update({ email: em }).eq('id', userId)
      if (profErr2) return Response.json({ error: 'อัปเดต profile ไม่สำเร็จ: ' + profErr2.message }, { status: 500 })
      await admin.from('audit_logs').insert({
        entity_type: 'user', entity_id: userId, action: 'set_email',
        actor_id: caller.user.id, detail: `เปลี่ยนอีเมลผู้ใช้เป็น ${em}`,
      })
      return Response.json({ ok: true })
    }

    if (body.action === 'set_password') {
      const { userId, password } = body
      if (!userId || !password) return Response.json({ error: 'กรุณาระบุผู้ใช้และรหัสผ่านใหม่' }, { status: 400 })
      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) return Response.json({ error: error.message }, { status: 400 })
      await admin.from('audit_logs').insert({
        entity_type: 'user', entity_id: userId, action: 'set_password',
        actor_id: caller.user.id, detail: 'เปลี่ยนรหัสผ่านผู้ใช้',
      })
      return Response.json({ ok: true })
    }

    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
