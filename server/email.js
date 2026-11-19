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
// unsubscribeUrl (optional, https only): adds List-Unsubscribe + List-Unsubscribe-Post (RFC 8058 one-click).
export async function sendEmail(env, { id, to, subject, text, fromName, replyTo, testOnly = false, unsubscribeUrl = null }) {
  if (!recipientAllowed(env, to, { testOnly })) return { ok: false, error: 'test_mode', permanent: true }
  const address = String(env.EMAIL_FROM).match(/<([^>]+)>/)?.[1] || String(env.EMAIL_FROM).trim()
  const name = fromName ? String(fromName).replace(/["<>\r\n\\]/g, '').slice(0, 70) : null
  const unsub = typeof unsubscribeUrl === 'string' && /^https:\/\/[^\s<>]+$/.test(unsubscribeUrl) ? unsubscribeUrl : null
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
        ...(unsub ? { headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.json().catch(() => ({}))
    // 400/422: Resend refused this message as invalid (bad address, bad payload): retrying the same request can't help.
    return res.ok ? { ok: true, providerId: typeof body.id === 'string' ? body.id.slice(0, 64) : null } : { ok: false, error: `http_${res.status}`, ...(res.status === 400 || res.status === 422 ? { permanent: true } : {}) }
  } catch {
    // Unknown outcome (timeout after Resend accepted it?): a retry is safe only with the same Idempotency-Key and
    // within Resend's 24 h idempotency window (callers enforce that window, see OUTBOX_RETRY_WINDOW_MS).
    return { ok: false, error: 'network_error', unknown: true }
  }
}

// Outbox retries: attempt n+1 waits OUTBOX_BACKOFF_MS[n] after the message was queued (5 min, then 30 min), so a short
// provider outage doesn't burn all three attempts in ten minutes.
export const OUTBOX_BACKOFF_MS = [0, 5 * 60 * 1000, 30 * 60 * 1000]
// Resend keeps an Idempotency-Key for 24 h. A message already attempted is never retried after this window (a retry
// could then deliver it twice), and nothing waits longer than this to go out late in a burst.
export const OUTBOX_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000
// Owner notices are about something that happened now (new booking, cancellation, callback): one that couldn't go out
// within the notice window is closed (expired) instead of arriving hours later, e.g. when a provider is configured.
const OWNER_NOTICE_TEMPLATES = ['owner_booking', 'owner_lead', 'owner_cancel', 'owner_bounce', 'owner_callback', 'owner_coverage']
export const OWNER_NOTICE_MAX_AGE_MS = 2 * 60 * 60 * 1000

const deliver = (env, msg, testOnly) => sendEmail(env, { id: msg.id, to: msg.to_email, subject: msg.subject, text: msg.body, testOnly })

// Sends pending messages (max 3 attempts each). No-op when no provider is configured. A message the launch gate
// doesn't allow now (test mode, non-test recipient) is closed as failed/test_mode, never attempted: held mail would
// otherwise go out days late in a burst when MESSAGES_LIVE is turned on, and 20+ held rows (e.g. from test businesses)
// would fill every batch and stop all other email.
// idPrefix (optional): only messages whose id starts with it (an event-driven flush right after the triggering
// request, e.g. the owner's new-booking notice); the cron flush takes everything due.
export async function flushOutbox(env, now = Date.now(), limit = 20, { idPrefix = null } = {}) {
  if (!emailConfigured(env)) return { configured: false, sent: 0, failed: 0 }
  const db = env.ONBOARDING_DB
  const prefix = typeof idPrefix === 'string' && /^[a-z_]+:[A-Za-z0-9_-]+:$/.test(idPrefix) ? idPrefix : null
  // Stale mail is closed, never sent late: owner notices past their window, anything already attempted past the
  // provider's idempotency window (a retry could duplicate it), and anything queued longer than that window.
  if (!prefix) {
    await db
      .prepare(
        `UPDATE email_outbox SET status = 'failed', error = 'expired' WHERE status = 'pending'
           AND ((template IN (${OWNER_NOTICE_TEMPLATES.map((t) => `'${t}'`).join(', ')}) AND created_at < ?1) OR created_at < ?2)`,
      )
      .bind(now - OWNER_NOTICE_MAX_AGE_MS, now - OUTBOX_RETRY_WINDOW_MS)
      .run()
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM email_outbox WHERE status = 'pending'
         AND (attempts = 0 OR (attempts = 1 AND created_at <= ?2) OR (attempts >= 2 AND created_at <= ?3))
         AND (?4 IS NULL OR (id >= ?4 AND id < ?4 || '~'))
       ORDER BY created_at LIMIT ?1`,
    )
    .bind(limit, now - OUTBOX_BACKOFF_MS[1], now - OUTBOX_BACKOFF_MS[2], prefix)
    .all()
  let sent = 0
  let failed = 0
  const tests = results.length ? await testStatuses(env) : new Map()
  for (const msg of results) {
    // Mail queued by (or while it was) a test business only ever goes to test recipients.
    const testOnly = msg.customer ? sandboxed(statusIn(tests, msg.customer), msg.created_at) : tests === null
    if (!recipientAllowed(env, msg.to_email, { testOnly })) {
      // Closed only on a definite refusal. If test-business status couldn't be read (a temporary storage error),
      // nothing is sent (fails closed) but the message stays pending and is decided on a later run.
      if (tests === null) continue
      await db.prepare("UPDATE email_outbox SET status = 'failed', error = 'test_mode' WHERE id = ?1 AND status = 'pending'").bind(msg.id).run()
      continue
    }
    const r = await deliver(env, msg, testOnly)
    if (r.ok) {
      sent++
      // Owner notices carry a lead's contact details: once delivered, the stored copy is cleared.
      await db.prepare("UPDATE email_outbox SET status = 'sent', sent_at = ?2, attempts = attempts + 1, error = NULL, body = CASE WHEN template IN ('owner_booking', 'owner_lead', 'owner_cancel', 'owner_bounce', 'owner_callback', 'owner_coverage') THEN '' ELSE body END WHERE id = ?1").bind(msg.id, now).run()
      await track(env, 'email_sent', { id: `email_sent:${msg.id}`, customer: msg.customer, props: { template: msg.template }, at: now })
    } else {
      failed++
      await db
        .prepare("UPDATE email_outbox SET attempts = attempts + 1, error = ?2, status = CASE WHEN attempts + 1 >= 3 OR ?3 = 1 THEN 'failed' ELSE 'pending' END WHERE id = ?1 AND status = 'pending'")
        .bind(msg.id, r.error, r.permanent ? 1 : 0)
        .run()
    }
  }
  return { configured: true, sent, failed }
}
