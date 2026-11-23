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
import { adsAccess } from '../../../server/ads/access.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    const data = await overview(env.ONBOARDING_DB, session.customer.id, Date.now(), internalEmails(env))
    // Advertising results appear for every business with Ads (server/ads/access.js: eligible, switch not off).
    const ads = (await adsAccess(env, session.customer)) ? await adSummary(env.ONBOARDING_DB, session.customer.id, Date.now(), internalEmails(env)) : null
    // Open receptionist callback requests / messages (null = not available, e.g. before migration 0027; never a fake 0).
    const requests = await env.ONBOARDING_DB.prepare("SELECT count(*) AS n, coalesce(sum(urgent), 0) AS urgent FROM receptionist_requests WHERE customer = ?1 AND status = 'open'")
      .bind(session.customer.id)
      .first()
      .then((r) => ({ open: Number(r?.n) || 0, urgent: Number(r?.urgent) || 0 }))
      .catch(() => null)
    return json(200, { ...data, automation: await messageSummary(env, session.customer), ads, requests })
  } catch (err) {
    console.error('overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
