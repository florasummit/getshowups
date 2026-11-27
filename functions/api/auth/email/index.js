// GET /api/auth/email — public: are the sign-in screens offering "Continue with email"? { offered: boolean }.
// True only when delivery is configured, migration 0046 is applied and sign-in emails may reach any address
// (AUTH_EMAIL_LIVE or MESSAGES_LIVE). Display only: POST /api/auth/email/start enforces everything itself.
import { json } from '../../../../server/google-oauth.js'
import { emailSignInOffered } from '../../../../server/email-auth.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  if (!env.ONBOARDING_DB) return json(200, { offered: false })
  const rl = await hitByIp(env, 'authEmailStatus', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  return json(200, { offered: await emailSignInOffered(env).catch(() => false) })
}
