// GET /api/receptionist/:customer — public: is the AI receptionist on for this business, and what to show.
//   → { enabled, name, greeting, phone, voice }   (404 like any unknown business when it can't take bookings)
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { getSettings, receptionistOn } from '../../../../server/receptionist/engine.js'
import { voiceConfigured } from '../../../../server/receptionist/voice.js'
import { getProfile } from '../../../../server/onboarding.js'

export async function onRequestGet({ request, env, params }) {
  const rl = await hitByIp(env, 'bookView', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const on = await receptionistOn(env, customer)
  if (!on) return json(200, { enabled: false, name: customer.name })
  const s = await getSettings(env.ONBOARDING_DB, customer.id)
  const profile = await getProfile(env.ONBOARDING_DB, customer.id).catch(() => null)
  return json(200, { enabled: true, name: customer.name, greeting: s.greeting || `Hi! I'm the ${customer.name} assistant. Ask me anything or I can find you a time.`, phone: profile?.phone || '', voice: voiceConfigured(env) })
}
