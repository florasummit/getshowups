// GET /api/enrollment — public: can a visitor sign up and pay online right now? { open: boolean, salesChat: boolean }
// (salesChat: the GetShowUps business runs its own receptionist, so the homepage can offer that chat; server/public.js).
// Lets the homepage and the sign-up screen say "enrollment isn't open yet" BEFORE Google sign-in. Display only: sign-in,
// invitations, admin and tester access are unchanged, and POST /api/dashboard/business still enforces the rule.
import { json } from '../../server/google-oauth.js'
import { enrollmentOpen } from '../../server/onboarding.js'
import { salesChatAvailable } from '../../server/public.js'
import { hitByIp, tooManyJson } from '../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  if (!env.ONBOARDING_DB) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'enrollment', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    const [open, salesChat] = await Promise.all([enrollmentOpen(env), salesChatAvailable(env)])
    return json(200, { open, salesChat })
  } catch {
    return json(503, { error: 'unavailable' })
  }
}
