// /api/claim — the owner takes over a business GetShowUps staff set up for them (server/enrollment.js).
//   GET  ?token=…  → { businessName, email (masked), state: signed_out | wrong_account | has_business | ready, signedInAs?, termsVersion }
//                    404 invite_invalid for unknown, expired, revoked or used links (one answer for all)
//   POST { token, acceptTerms: true, termsVersion } (signed in, same origin) → { customer, onboarded }
// The signed-in VERIFIED email (server/auth.js session) must be the invited one; nothing is linked by name or by a typed
// address. Rate-limited per IP.
import { json, missingConfig } from '../../server/google-oauth.js'
import { getSession, requireSession } from '../../server/auth.js'
import { hitByIp, tooManyJson } from '../../server/ratelimit.js'
import { claimBusiness, peekClaim } from '../../server/enrollment.js'

export async function onRequestGet({ request, env }) {
  if (missingConfig(env).length) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'claimPeek', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    const session = await getSession(request, env)
    const r = await peekClaim(env, new URL(request.url).searchParams.get('token'), session)
    return r ? json(200, r) : json(404, { error: 'invite_invalid' })
  } catch (err) {
    console.error('claim preview failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const rl = await hitByIp(env, 'claimAccept', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const { session, response } = await requireSession(request, env, { needCustomer: false, write: true })
  if (response) return response
  if (session.staff) return json(403, { error: 'staff_not_allowed' })
  const b = (await request.json().catch(() => null)) || {}
  try {
    const r = await claimBusiness(env, { token: b.token, session, acceptTerms: b.acceptTerms, termsVersion: b.termsVersion })
    if (!r.ok) return json(r.httpStatus, { error: r.error, ...(r.expected ? { expected: r.expected } : {}) })
    return json(200, { customer: r.customer, onboarded: r.onboarded })
  } catch (err) {
    console.error('claim failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
