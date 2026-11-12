// GET /api/dashboard/overview — results (last 30 days), upcoming appointments, outcomes to record,
// leads to follow up, automatic-message status and (when Ads is on) advertising results, for the
// signed-in business only. Test records are
// listed (test: true) but never counted.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { overview } from '../../../server/booking.js'
import { messageSummary } from '../../../server/messages.js'
import { internalEmails } from '../../../server/testdata.js'
import { adSummary } from '../../../server/ads/campaigns.js'
import { adsEnabledFor } from '../../../server/ads/access.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    const data = await overview(env.ONBOARDING_DB, session.customer.id, Date.now(), internalEmails(env))
    // Advertising results appear only for businesses with Ads switched on (ADS_ENABLED + ADS_BUSINESSES).
    const ads = adsEnabledFor(env, session.customer.id) ? await adSummary(env.ONBOARDING_DB, session.customer.id) : null
    return json(200, { ...data, automation: await messageSummary(env, session.customer), ads })
  } catch (err) {
    console.error('overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
