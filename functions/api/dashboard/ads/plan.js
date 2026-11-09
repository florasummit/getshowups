// POST /api/dashboard/ads/plan — generate a campaign plan (AI when configured, else a labelled template)
// and save it as editable drafts. Drafts never launch and never spend.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { getProfile, saveDraft } from '../../../../server/ads/campaigns.js'
import { generatePlan, draftSpecs } from '../../../../server/ads/strategy.js'
import { remainingDailyCents } from '../../../../server/ads/budget.js'
import { dailyCeilingCents } from '../../../../server/ads/spec.js'
import { getPage } from '../../../../server/landing.js'

export async function onRequestPost({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  const rl = await hit(env, 'adsPlan', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const db = env.ONBOARDING_DB
  const profile = await getProfile(db, customer.id)
  if (!profile) return json(409, { error: 'profile_required' })
  const result = await generatePlan(env, customer, profile)
  if (!result.ok) return json(result.retryable ? 503 : 422, { error: result.error })
  // Size drafts to what is still approvable; with no approval yet, to the owner's requested budget.
  const remaining = await remainingDailyCents(db, customer.id)
  const ceiling = remaining > 0 ? remaining : profile.monthlyBudgetCents ? dailyCeilingCents(profile.monthlyBudgetCents) : 1000
  // Ads send clicks to the published landing page when there is one, otherwise straight to booking.
  const origin = new URL(env.GOOGLE_REDIRECT_URI).origin
  const bookingUrl = (await getPage(db, customer.id))?.published ? `${origin}/p/${customer.id}` : `${origin}/book/${customer.id}`
  const ids = []
  for (const d of draftSpecs(customer, profile, result.plan, { dailyCeilingCents: ceiling, bookingUrl })) {
    const saved = await saveDraft(env, customer, { spec: d.spec })
    if (!saved.ok) return json(409, { error: saved.error })
    // The final URL carries our campaign id for attribution, so it is set once the id exists.
    if (d.platform === 'google') await saveDraft(env, customer, { id: saved.id, spec: { ...d.spec, finalUrl: d.url(saved.id) } })
    ids.push(saved.id)
  }
  const { rationale, imageConcepts, videoConcepts, tracking, landing, recommendedChannels } = result.plan
  return json(201, { source: result.source, campaignIds: ids, rationale, recommendedChannels, imageConcepts, videoConcepts, tracking, landing })
}
