// Email outbox. Messages are queued with a dedupe id and delivered only through a configured
// provider (Resend: RESEND_API_KEY + EMAIL_FROM). Without one, messages stay 'pending' and the admin
// console says so; nothing is ever reported as sent unless the provider accepted it.
import { track } from './events.js'

export const emailConfigured = (env) => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM)

// Returns true if newly queued, false if this dedupe id already exists.
export async function enqueue(env, { id, to, customer = null, template, subject, body }, now = Date.now()) {
  const res = await env.ONBOARDING_DB.prepare(
    `INSERT OR IGNORE INTO email_outbox (id, to_email, customer, template, subject, body, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`,
  )
    .bind(id, to, customer, template, subject, body, now)
    .run()
  return (res?.meta?.changes ?? res?.changes ?? 0) > 0
}

async function deliver(env, msg) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': msg.id },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to_email], subject: msg.subject, text: msg.body }),
      signal: AbortSignal.timeout(8000),
    })
    return res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}

// Sends pending messages (max 3 attempts each). No-op when no provider is configured.
export async function flushOutbox(env, now = Date.now(), limit = 20) {
  if (!emailConfigured(env)) return { configured: false, sent: 0, failed: 0 }
  const db = env.ONBOARDING_DB
  const { results } = await db.prepare("SELECT * FROM email_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?1").bind(limit).all()
  let sent = 0
  let failed = 0
  for (const msg of results) {
    const r = await deliver(env, msg)
    if (r.ok) {
      sent++
      await db.prepare("UPDATE email_outbox SET status = 'sent', sent_at = ?2, attempts = attempts + 1, error = NULL WHERE id = ?1").bind(msg.id, now).run()
      await track(env, 'email_sent', { id: `email_sent:${msg.id}`, customer: msg.customer, props: { template: msg.template }, at: now })
    } else {
      failed++
      await db
        .prepare("UPDATE email_outbox SET attempts = attempts + 1, error = ?2, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END WHERE id = ?1")
        .bind(msg.id, r.error)
        .run()
    }
  }
  return { configured: true, sent, failed }
}
