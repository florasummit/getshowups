// POST /api/auth/email/start { email, next? } — "Continue with email". Always the same answer for a well-formed address
// ({ ok, resendAfter }), whether or not it may sign in: the lookup and the email happen after the response
// (server/email-auth.js issueSignIn). Sets an HttpOnly cookie binding the emailed link to this browser.
import { json, missingConfig } from '../../../../server/google-oauth.js'
import { cookie, isSameOrigin, safeNext } from '../../../../server/auth.js'
import { EMAIL_LOGIN_COOKIE, EMAIL_LOGIN_TTL_MS, RESEND_AFTER_SECONDS, deliveryConfigured, issueSignIn, normalizeEmail, sealBrowser, tableReady, validEmail } from '../../../../server/email-auth.js'
import { hit, hitByIp, resetHit, tooManyJson } from '../../../../server/ratelimit.js'

export async function onRequestPost(context) {
  const { request, env } = context
  if (missingConfig(env).length) return json(503, { error: 'not_configured' })
  if (!isSameOrigin(request, env)) return json(403, { error: 'forbidden' })
  if (!deliveryConfigured(env) || !(await tableReady(env.ONBOARDING_DB))) return json(503, { error: 'not_available' })
  const ip = await hitByIp(env, 'authEmailStart', request)
  if (ip.limited) return tooManyJson(ip.retryAfter)

  const body = await request.json().catch(() => null)
  const email = normalizeEmail(body?.email)
  if (!validEmail(email)) return json(400, { error: 'invalid_email' })
  const next = safeNext(body?.next)
  const perAddress = await hit(env, 'authEmailPerAddress', email)
  if (perAddress.limited) return tooManyJson(perAddress.retryAfter)

  // A new request ends the old code, so its guesses start again (same for every address: nothing is revealed).
  await resetHit(env, 'authEmailCode', email)
  const { secret, sealed } = await sealBrowser(env, { email, next })
  const work = issueSignIn(env, { email, next, browserSecret: secret }, Date.now(), { hitSend: () => hit(env, 'authEmailSendAll', 'all') })
  if (typeof context.waitUntil === 'function') context.waitUntil(work)
  else await work

  const res = json(200, { ok: true, resendAfter: RESEND_AFTER_SECONDS })
  res.headers.append('Set-Cookie', cookie(EMAIL_LOGIN_COOKIE, sealed, EMAIL_LOGIN_TTL_MS / 1000))
  return res
}
