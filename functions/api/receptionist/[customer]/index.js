// GET /api/receptionist/:customer — public: is the AI receptionist on for this business, and what to show.
//   → { enabled, name, greeting, phone, voice }   (404 like any unknown business when it can't take bookings)
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { getSettings, receptionistOn, receptionistRequestsReady } from '../../../../server/receptionist/engine.js'
import { voiceStatus } from '../../../../server/receptionist/voice.js'
import { getProfile } from '../../../../server/onboarding.js'
import { hostingStatus, isHosted, liveContent } from '../../../../server/website.js'
import { connectedHost } from '../../../../server/domains.js'
import { siteOrigin } from '../../../../server/auth.js'
import { providerSpendAllowed } from '../../../../server/business-accounts.js'

export async function onRequestGet({ request, env, params }) {
  const rl = await hitByIp(env, 'bookView', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const on = (await receptionistOn(env, customer)) && (await providerSpendAllowed(env, customer.id))
  if (!on) return json(200, { enabled: false, name: customer.name })
  const s = await getSettings(env.ONBOARDING_DB, customer.id)
  const profile = await getProfile(env.ONBOARDING_DB, customer.id).catch(() => null)
  // A way back to the business's own website, only when it is actually live (same checks as serving it).
  const website = await (async () => {
    if (!isHosted(await hostingStatus(env.ONBOARDING_DB, customer.id, Date.now(), env)) || !(await liveContent(env.ONBOARDING_DB, customer.id))) return null
    const host = await connectedHost(env.ONBOARDING_DB, customer.id)
    return host ? `https://${host}/` : `${siteOrigin(env)}/p/${customer.id}`
  })().catch(() => null)
  return json(200, {
    enabled: true,
    name: customer.name,
    greeting: s.greeting || `Hi! I'm the ${customer.name} assistant. Ask me anything, or I can find you a time.`,
    phone: profile?.phone || '',
    // Voice only where released (RECEPTIONIST_VOICE_BUSINESSES); otherwise the page says it is in testing.
    voice: voiceStatus(env, customer.id) === 'available',
    voiceStatus: voiceStatus(env, customer.id),
    callbacks: await receptionistRequestsReady(env.ONBOARDING_DB),
    website,
  })
}
