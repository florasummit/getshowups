// Enterprise inquiry (pricing section → "Contact sales"; server/enterprise.js).
//   GET  → { t }: the signed form token the page sends back (rate-limited per visitor).
//   POST { t, organization, name, email, type, count?, goal, website (trap) } → { ok: true } | { error }.
// Public: no session, no same-origin check (a public form), protected by the token, the trap field and rate limits.
// The answer is a code only; nothing typed is echoed or logged.
import { json } from '../../../server/google-oauth.js'
import { hit, hitByIp, tooManyJson } from '../../../server/ratelimit.js'
import { inquiryToken, submitInquiry } from '../../../server/enterprise.js'

const STATUS = { expired: 400, invalid_organization: 400, invalid_type: 400, invalid_count: 400, invalid_goal: 400, invalid_name: 400, invalid_email: 400, invalid_need: 400, unavailable: 503 }

export async function onRequestGet({ request, env }) {
  const rl = await hitByIp(env, 'enterpriseToken', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  if (!env.TOKEN_ENCRYPTION_KEY) return json(503, { error: 'not_configured' })
  return json(200, { t: await inquiryToken(env) })
}

export async function onRequestPost({ request, env }) {
  for (const rl of [await hitByIp(env, 'enterpriseInquiry', request), await hit(env, 'enterpriseInquiryTotal', 'all')]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  if (!env.TOKEN_ENCRYPTION_KEY || !env.ONBOARDING_DB) return json(503, { error: 'not_configured' })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_request' })
  const fields = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : typeof v === 'number' ? String(v) : '']))
  const r = await submitInquiry(env, fields)
  if (r.state === 'sent') return json(200, { ok: true })
  return json(STATUS[r.state] || 400, { error: r.state })
}
