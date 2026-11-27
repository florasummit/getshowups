// POST /api/auth/email/verify — finishes email sign-in with either
//   { email, code }  the 6-digit code (any browser; 5 wrong codes per request, and per address, then a new code is needed)
//   { token }        the emailed link, confirmed by a click on /dashboard/email-sign-in (only in the browser that asked)
// Success creates the same session as Google sign-in (server/auth.js createSession + cookie + landingFor) and answers
// { ok, next }. Refusals are allowlisted codes; a wrong, expired or used code is one answer (code_invalid).
import { json, missingConfig, sha256Hex } from '../../../../server/google-oauth.js'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, cookie, createSession, isSameOrigin, landingFor } from '../../../../server/auth.js'
import { EMAIL_LOGIN_COOKIE, cleanCode, consumeCode, consumeLink, normalizeEmail, tableReady, validEmail } from '../../../../server/email-auth.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { track } from '../../../../server/events.js'

export async function onRequestPost({ request, env }) {
  if (missingConfig(env).length) return json(503, { error: 'not_configured' })
  if (!isSameOrigin(request, env)) return json(403, { error: 'forbidden' })
  if (!(await tableReady(env.ONBOARDING_DB))) return json(503, { error: 'not_available' })
  const ip = await hitByIp(env, 'authEmailVerify', request)
  if (ip.limited) return tooManyJson(ip.retryAfter)

  const body = await request.json().catch(() => null)
  let email
  let next
  try {
    if (typeof body?.token === 'string') {
      const r = await consumeLink(env, request, { token: body.token })
      if (!r.ok) return json(400, { error: r.error })
      ;({ email, next } = r)
    } else {
      email = normalizeEmail(body?.email)
      if (!validEmail(email)) return json(400, { error: 'invalid_email' })
      // Guesses are counted per address whether or not a request exists, so "too many" reveals nothing either.
      if ((await hit(env, 'authEmailCode', email)).limited) return json(429, { error: 'too_many_attempts' })
      const r = await consumeCode(env, { email, code: cleanCode(body?.code) })
      if (!r.ok) return json(400, { error: 'code_invalid' })
      next = r.next
    }
  } catch (err) {
    console.error('email sign-in check failed:', err?.name || 'error')
    return json(503, { error: 'storage_error' })
  }

  let token
  try {
    token = await createSession(env.ONBOARDING_DB, email)
  } catch (err) {
    console.error('Session create failed:', err?.name || 'error')
    return json(503, { error: 'storage_error' })
  }
  await track(env, 'signup', { id: `signup:${await sha256Hex(email)}` }) // first sign-in only (deduped), as for Google
  const res = json(200, { ok: true, next: await landingFor(env, email, next) })
  res.headers.append('Set-Cookie', cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS))
  res.headers.append('Set-Cookie', cookie(EMAIL_LOGIN_COOKIE, '', 0))
  return res
}
