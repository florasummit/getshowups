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
import { attention, attentionCard } from '../../../server/attention.js'
import { adsAccess } from '../../../server/ads/access.js'
import { rangeOf } from '../../../server/operator-tools.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    // One definition of "the last 30 days" for Overview and the assistant (server/operator-tools.js rangeStats).
    const now = Date.now()
    // DASH-08: bookings by when they were made, visits and outcomes by when they were scheduled (server/booking.js).
    const w = rangeOf({ period: 'last_30_days' }, session.customer.timezone, now)
    const data = await overview(env.ONBOARDING_DB, session.customer.id, now, internalEmails(env), w.from, w.to)
    // Advertising results appear for every business with Ads (server/ads/access.js: eligible, switch not off).
    const ads = (await adsAccess(env, session.customer)) ? await adSummary(env.ONBOARDING_DB, session.customer.id, Date.now(), internalEmails(env)) : null
    // "Needs your attention" (server/attention.js): the assistant answers from the same service.
    const card = attentionCard(await attention(env, session.customer.id))
    return json(200, { ...data, automation: await messageSummary(env, session.customer), ads, attention: card })
  } catch (err) {
    console.error('overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
