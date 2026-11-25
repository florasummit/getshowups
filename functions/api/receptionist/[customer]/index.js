// GET /api/receptionist/:customer — public: is the AI receptionist on for this business, and what to show.
//   → { enabled, name, greeting, phone, voice }   (404 like any unknown business when it can't take bookings)
//   ?test=<provider>: a signed-in platform admin's test session on an admin-marked TEST business
//   (server/voice/testing.js adminTestAccess). With the receptionist off for customers the page still renders for
//   that admin, voice only ({ enabled: true, testOnly: true, test: { provider, name } }); anyone else gets the usual
//   { enabled: false } (plus test: { error } naming why, codes only). Customers' availability never changes.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { getSettings, receptionistOn, receptionistRequestsReady } from '../../../../server/receptionist/engine.js'
import { customerVoiceStatus } from '../../../../server/voice/customer.js'
import { adminTestAccess } from '../../../../server/voice/testing.js'
import { getProfile } from '../../../../server/onboarding.js'
import { hostingStatus, isHosted, liveContent } from '../../../../server/website.js'
import { connectedHost } from '../../../../server/domains.js'
import { siteOrigin } from '../../../../server/auth.js'
import { providerSpendAllowed } from '../../../../server/business-accounts.js'
import { bookingServices } from '../../../../server/services.js'
import { publicBrand } from '../../../../server/public-brand.js'

export async function onRequestGet({ request, env, params }) {
  const rl = await hitByIp(env, 'bookView', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const { customer, response } = await bookableCustomer(env, params)
  if (response) return response
  const wanted = new URL(request.url).searchParams.get('test') || ''
  const test = wanted ? await adminTestAccess(env, request, customer, wanted) : null
  const on = (await receptionistOn(env, customer)) && (await providerSpendAllowed(env, customer.id))
  if (!on) {
    if (!test?.ok) return json(200, { enabled: false, name: customer.name, ...(test ? { test: { error: test.error } } : {}) })
    const s = await getSettings(env.ONBOARDING_DB, customer.id)
    const profile = await getProfile(env.ONBOARDING_DB, customer.id).catch(() => null)
    // The admin's dry-run test page on a business whose receptionist is off for customers: voice on the candidate
    // provider only (typed chat stays off, like for everyone else).
    return json(200, { enabled: true, testOnly: true, test: { provider: test.provider, name: test.name }, name: customer.name, greeting: s.greeting || `Hi! I'm the ${customer.name} assistant. Ask me anything, or I can find you a time.`, phone: profile?.phone || '', voice: false, voiceStatus: await customerVoiceStatus(env, customer.id), callbacks: false, website: null })
  }
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
    // Voice by the business's active provider (server/voice/customer.js): Retell where released
    // (RECEPTIONIST_VOICE_BUSINESSES), another provider once an admin activated it; otherwise "in testing".
    voice: (await customerVoiceStatus(env, customer.id)) === 'available',
    voiceStatus: await customerVoiceStatus(env, customer.id),
    callbacks: await receptionistRequestsReady(env.ONBOARDING_DB),
    website,
    // Quick replies come from the business's own offered services (names only; hidden ones left out), and the page
    // wears the business's published brand (GetShowUps' own chat: product).
    services: bookingServices(profile?.services, customer.slotMinutes).map((x) => ({ name: x.name, flow: x.flow })),
    brand: await publicBrand(env, customer),
    ...(test ? { test: test.ok ? { provider: test.provider, name: test.name } : { error: test.error } } : {}),
  })
}
