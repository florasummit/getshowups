import { recipientAllowed } from './email.js'

// Text messages through Twilio. Inactive unless TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a sender
// (TWILIO_MESSAGING_SERVICE_SID preferred, or TWILIO_FROM) are configured. US carriers also require an
// approved A2P 10DLC campaign or toll-free verification before messages are delivered.
// Twilio handles STOP/HELP replies on the sender; a send to an opted-out number fails with 21610.

export const smsConfigured = (env) =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM))

// US/Canada numbers to E.164 (+1XXXXXXXXXX); explicit "+<country>" numbers are kept. Otherwise null.
export function toE164(phone) {
  const raw = String(phone ?? '').trim()
  const digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

// Returns { ok, providerId } or { ok: false, error, permanent } with an allowlisted error code.
export async function sendSms(env, { to, text, testOnly = false }) {
  const number = toE164(to)
  if (!number) return { ok: false, error: 'invalid_phone', permanent: true }
  if (!recipientAllowed(env, number, { testOnly })) return { ok: false, error: 'test_mode', permanent: true }
  const form = new URLSearchParams({ To: number, Body: text })
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID)
  else form.set('From', env.TWILIO_FROM)
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && typeof body.sid === 'string') return { ok: true, providerId: body.sid.slice(0, 64) }
    const code = Number.isInteger(body.code) ? body.code : null
    // 4xx are not retried (bad number, opted out, unverified sender); 429/5xx are.
    return { ok: false, error: code ? `twilio_${code}` : `http_${res.status}`, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}
