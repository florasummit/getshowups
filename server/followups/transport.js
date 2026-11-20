// Message transports. The follow-up engine only calls send(channel, …) and reads normalized results; adding a provider
// means adding one transport here, not changing the workflow.
//   result: { ok: true, providerId, segments, costMicros } | { ok: false, error (allowlisted), permanent }
// Twilio: the business's OWN sender (its Messaging Service, else its number); delivery updates come back to
// /api/sms/twilio/status (signed). Credentials stay server-side; nothing about them is logged or returned.
import { siteOrigin } from '../auth.js'
import { toE164 } from '../sms.js'
import { sendEmail, recipientAllowed } from '../email.js'
import { ACCOUNT_SID_RE, signingKeys } from './twilio.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
// Test-only: a loopback Twilio stand-in (never honored for any other origin).
const twilioOrigin = (env) => (typeof env.TWILIO_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.TWILIO_API_MOCK_ORIGIN) ? env.TWILIO_API_MOCK_ORIGIN : 'https://api.twilio.com')

// GSM-7 vs UCS-2 segments (what carriers bill). Estimates until Twilio reports a price.
export function segmentsOf(text) {
  const t = String(text || '')
  const gsm = /^[\n\r -_a-zA-Z0-9!"#$%&'()*+,\-./:;<=>?@£¥èéùìòÇØøÅåΔΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(t)
  const single = gsm ? 160 : 70
  const multi = gsm ? 153 : 67
  return t.length <= single ? 1 : Math.ceil(t.length / multi)
}
// US 10DLC list price per segment incl. typical carrier fee, in micro-dollars (estimate; overridable).
export const smsSegmentMicros = (env) => (Number.isInteger(Number(env.SMS_SEGMENT_MICROS)) && Number(env.SMS_SEGMENT_MICROS) > 0 ? Number(env.SMS_SEGMENT_MICROS) : 11_000)

export async function sendTwilio(env, { to, text, sender, statusToken, testOnly = false }) {
  const number = toE164(to)
  if (!number) return { ok: false, error: 'invalid_phone', permanent: true }
  // Defense in depth: the launch gate is re-checked at the provider call (callers check it too).
  if (!recipientAllowed(env, number, { testOnly })) return { ok: false, error: 'test_mode', permanent: true }
  if (!sender?.messagingService && !sender?.from) return { ok: false, error: 'no_sender', permanent: true }
  // Always from the business's OWN subaccount (parent credentials may act on a subaccount's v2010 resources).
  if (!ACCOUNT_SID_RE.test(sender?.accountSid || '')) return { ok: false, error: 'no_account', permanent: true }
  const form = new URLSearchParams({ To: number, Body: text })
  if (sender.messagingService) form.set('MessagingServiceSid', sender.messagingService)
  else form.set('From', sender.from)
  if (statusToken) form.set('StatusCallback', `${siteOrigin(env)}/api/sms/twilio/status?m=${encodeURIComponent(statusToken)}`)
  const segments = segmentsOf(text)
  try {
    const res = await fetch(`${twilioOrigin(env)}/2010-04-01/Accounts/${encodeURIComponent(sender.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && typeof body.sid === 'string') return { ok: true, providerId: body.sid.slice(0, 64), segments, costMicros: segments * smsSegmentMicros(env) }
    const code = Number.isInteger(body.code) ? body.code : null
    return { ok: false, error: code ? `twilio_${code}` : `http_${res.status}`, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 }
  } catch {
    // Unknown outcome (timeout after sending?): never retried automatically (no duplicate texts).
    return { ok: false, error: 'network_error', permanent: true }
  }
}

export async function send(env, channel, msg) {
  if (channel === 'sms') return sendTwilio(env, msg)
  if (channel === 'email') {
    const r = await sendEmail(env, { id: msg.id, to: msg.to, subject: msg.subject, text: msg.text, fromName: msg.fromName, replyTo: msg.replyTo, testOnly: msg.testOnly })
    return r.ok ? { ok: true, providerId: r.providerId ?? null, segments: null, costMicros: null } : { ok: false, error: r.error || 'email_failed', permanent: Boolean(r.permanent) }
  }
  return { ok: false, error: 'unknown_channel', permanent: true }
}

// Twilio request signature (X-Twilio-Signature): base64(HMAC-SHA1(authToken, url + sorted(key+value)...)).
export async function twilioSignature(authToken, url, params) {
  const data = url + [...params.keys()].sort().map((k) => k + params.getAll(k).join('')).join('')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

const sameSig = (a, b) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
// Signed by the account that owns the number (the business's subaccount; the parent's token is also accepted for
// that subaccount). Returns { ok, customer } — customer = the business whose subaccount sent it (null = parent), so
// callers can refuse a webhook that names another business's sender.
// A refusal carries a reason code: 'unsigned' (no X-Twilio-Signature at all: Twilio always signs, so this was never
// Twilio — a probe or our own smoke test), 'unknown_account' (AccountSid is neither ours nor an active subaccount),
// 'bad_signature' (signed, but not with a token we hold for that account / that URL: possible misconfiguration).
export async function verifyTwilio(env, request, params) {
  const given = request.headers.get('X-Twilio-Signature') || ''
  if (!env.TWILIO_AUTH_TOKEN) return { ok: false, reason: 'not_configured' }
  if (!given) return { ok: false, reason: 'unsigned' }
  const keys = await signingKeys(env, params.get('AccountSid') || '').catch(() => null)
  if (!keys) return { ok: false, reason: 'unknown_account' }
  // Twilio signs the public URL it called (behind Cloudflare: the request URL as received).
  for (const token of keys.tokens) if (sameSig(await twilioSignature(token, request.url, params), given)) return { ok: true, customer: keys.customer }
  return { ok: false, reason: 'bad_signature' }
}
