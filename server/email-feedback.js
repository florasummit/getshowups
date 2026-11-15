// Delivery feedback from Resend (POST /api/email/webhook, migration 0020). Resend signs webhooks with Svix:
//   svix-signature = space-separated "v1,<base64 HMAC-SHA256>" over `${svix-id}.${svix-timestamp}.${raw body}`,
//   key = base64-decoded part of RESEND_WEBHOOK_SECRET after "whsec_". Timestamps older/newer than 5 minutes are refused.
// email.bounced (bounce.type "Permanent") → our message is marked failed/bounced (it never arrived) and the address is
// suppressed for that business; email.complained → suppressed. Temporary bounces are ignored (Resend retries).
// Idempotent (retries reuse svix-id; every write is conditional). Our message is found by Resend's email id only, never
// by addresses in the payload. Nothing from the payload is logged or stored except the event type.
import { addressHash } from './optouts.js'
import { track } from './events.js'
import { timingSafeEqual } from './google-oauth.js'

export const TOLERANCE_S = 5 * 60
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export const feedbackConfigured = (env) => /^whsec_[A-Za-z0-9+/=]{16,}$/.test(env.RESEND_WEBHOOK_SECRET || '')

export async function svixSignature(secret, id, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', fromB64(secret.slice('whsec_'.length)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))
}

export async function verifySvix(env, headers, body, nowMs = Date.now()) {
  const id = headers.get('svix-id') || ''
  const ts = headers.get('svix-timestamp') || ''
  const sigs = (headers.get('svix-signature') || '').split(' ').filter((s) => s.startsWith('v1,')).map((s) => s.slice(3))
  if (!id || !/^\d{1,12}$/.test(ts) || !sigs.length) return false
  if (Math.abs(nowMs / 1000 - Number(ts)) > TOLERANCE_S) return false
  const expected = await svixSignature(env.RESEND_WEBHOOK_SECRET, id, ts, body)
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected))
}

// Suppressed for this business (null if it can't be read: the caller decides; a missing table = nothing recorded yet).
export async function isSuppressed(env, customer, address) {
  const hash = await addressHash('email', address)
  if (!hash) return false
  try {
    return Boolean(await env.ONBOARDING_DB.prepare('SELECT 1 FROM email_suppressions WHERE customer = ?1 AND address_hash = ?2').bind(customer, hash).first())
  } catch (err) {
    return err?.message?.includes('no such table') ? false : null
  }
}

export async function handleFeedback(env, event, now = Date.now()) {
  const type = event?.type
  const emailId = typeof event?.data?.email_id === 'string' ? event.data.email_id.slice(0, 64) : ''
  const permanent = type === 'email.bounced' && event?.data?.bounce?.type === 'Permanent'
  if (!emailId || !(permanent || type === 'email.complained')) return 'ignored'
  const db = env.ONBOARDING_DB
  const m = await db
    .prepare("SELECT m.id, m.customer, l.email FROM messages m JOIN leads l ON l.id = m.lead_id AND l.customer = m.customer WHERE m.provider_id = ?1 AND m.channel = 'email'")
    .bind(emailId)
    .first()
  if (!m) return 'unknown_email' // e.g. an account email from the outbox, or another system's mail
  const reason = permanent ? 'bounced' : 'complained'
  const hash = await addressHash('email', m.email)
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO email_suppressions (customer, address_hash, reason, message_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(m.customer, hash, reason, m.id, now),
    ...(permanent ? [db.prepare("UPDATE messages SET status = 'failed', error = 'bounced', updated_at = ?2 WHERE id = ?1 AND status = 'sent'").bind(m.id, now)] : []),
  ])
  await track(env, `email_${reason}`, { id: `email_${reason}:${m.id}`, customer: m.customer, at: now })
  return reason
}
