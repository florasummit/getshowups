// Email outbox. Messages are queued with a dedupe id and delivered only through a configured
// provider (Resend: RESEND_API_KEY + EMAIL_FROM). Without one, messages stay 'pending' and the admin
// console says so; nothing is ever reported as sent unless the provider accepted it.
import { track } from './events.js'
import { sandboxed, statusIn, testStatuses } from './testbusiness.js'

export const emailConfigured = (env) => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM)

// Launch gate (fails closed): unless MESSAGES_LIVE is exactly 'true', email and texts go only to the
// addresses/phone numbers listed in MESSAGE_TEST_RECIPIENTS (comma-separated; stored as a secret so no
// address is committed). Everything else is held (outbox) or skipped as 'test_mode' (lead messages).
export const messagesLive = (env) => env.MESSAGES_LIVE === 'true'
const normalize = (v) => {
  const s = String(v ?? '').trim().toLowerCase()
  if (s.includes('@')) return s
  const d = s.replace(/\D/g, '')
  return d.length === 10 ? `+1${d}` : d ? `+${d}` : ''
}
// testOnly: the sender is a test business (server/testbusiness.js), so MESSAGES_LIVE never applies.
export function recipientAllowed(env, to, { testOnly = false } = {}) {
  if (messagesLive(env) && !testOnly) return true
  const target = normalize(to)
  if (!target) return false
  return String(env.MESSAGE_TEST_RECIPIENTS ?? '')
    .split(',')
    .map(normalize)
    .some((r) => r && r === target)
}

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

// Sends one plain-text email through Resend. fromName/replyTo are optional (messages to a business's
// leads go out as "<Business> via GetShowUps" with replies to the business owner).
// Returns { ok, providerId } or { ok: false, error } with an allowlisted code.
export async function sendEmail(env, { id, to, subject, text, fromName, replyTo, testOnly = false }) {
  if (!recipientAllowed(env, to, { testOnly })) return { ok: false, error: 'test_mode', permanent: true }
  const address = String(env.EMAIL_FROM).match(/<([^>]+)>/)?.[1] || String(env.EMAIL_FROM).trim()
  const name = fromName ? String(fromName).replace(/["<>\r\n\\]/g, '').slice(0, 70) : null
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
      body: JSON.stringify({
        from: name ? `"${name}" <${address}>` : env.EMAIL_FROM,
        to: [to],
        subject,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.json().catch(() => ({}))
    return res.ok ? { ok: true, providerId: typeof body.id === 'string' ? body.id.slice(0, 64) : null } : { ok: false, error: `http_${res.status}` }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}

const deliver = (env, msg, testOnly) => sendEmail(env, { id: msg.id, to: msg.to_email, subject: msg.subject, text: msg.body, testOnly })

// Sends pending messages (max 3 attempts each). No-op when no provider is configured. In test mode,
// messages to non-test recipients stay pending (held, not attempted).
export async function flushOutbox(env, now = Date.now(), limit = 20) {
  if (!emailConfigured(env)) return { configured: false, sent: 0, failed: 0 }
  const db = env.ONBOARDING_DB
  const { results } = await db.prepare("SELECT * FROM email_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?1").bind(limit).all()
  let sent = 0
  let failed = 0
  const tests = results.length ? await testStatuses(env) : new Map()
  for (const msg of results) {
    // Mail queued by (or while it was) a test business only ever goes to test recipients.
    const testOnly = msg.customer ? sandboxed(statusIn(tests, msg.customer), msg.created_at) : tests === null
    if (!recipientAllowed(env, msg.to_email, { testOnly })) continue
    const r = await deliver(env, msg, testOnly)
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
