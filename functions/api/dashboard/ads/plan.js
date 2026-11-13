// POST /api/dashboard/ads/plan — generate a campaign plan (AI when configured, else a labelled template)
// and save it as editable drafts. Drafts never launch and never spend. One open draft per platform: while one
// exists the owner edits it (or removes it to start over), so a second click never creates a duplicate.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { getProfile, openDraftIds, saveDraft } from '../../../../server/ads/campaigns.js'
import { generatePlan, draftSpecs } from '../../../../server/ads/strategy.js'
import { remainingDailyCents } from '../../../../server/ads/budget.js'
import { dailyCeilingCents } from '../../../../server/ads/spec.js'
import { websiteSummary } from '../../../../server/website.js'
import { adsEnabled, adsEnabledFor } from '../../../../server/ads/access.js'

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!adsEnabledFor(env, session.customer.id)) return json(404, { error: 'not_found' })
  const customer = session.customer
  const rl = await hit(env, 'adsPlan', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const db = env.ONBOARDING_DB
  const profile = await getProfile(db, customer.id)
  if (!profile) return json(409, { error: 'profile_required' })
  // Checked before planning, so a repeated click costs nothing (no AI call).
  const existing = await openDraftIds(db, customer.id, 'google')
  if (existing.length) return json(409, { error: 'draft_exists', campaignIds: existing })
  const result = await generatePlan(env, customer, profile)
  if (!result.ok) return json(result.retryable ? 503 : 422, { error: result.error })
  // Size drafts to what is still approvable; with no approval yet, to the owner's requested budget.
  const remaining = await remainingDailyCents(db, customer.id)
  const ceiling = remaining > 0 ? remaining : profile.monthlyBudgetCents ? dailyCeilingCents(profile.monthlyBudgetCents) : 1000
  // Ads send clicks to the published website when there is one, otherwise straight to booking.
  const origin = new URL(env.GOOGLE_REDIRECT_URI).origin
  const bookingUrl = (await websiteSummary(db, customer.id)).published ? `${origin}/p/${customer.id}` : `${origin}/book/${customer.id}`
  const ids = []
  for (const d of draftSpecs(customer, profile, result.plan, { dailyCeilingCents: ceiling, bookingUrl })) {
    // onlyIfNone: atomic, so two simultaneous requests still create one draft per platform.
    const saved = await saveDraft(env, customer, { spec: d.spec, onlyIfNone: true })
    if (!saved.ok) return json(409, { error: saved.error, ...(saved.error === 'draft_exists' ? { campaignIds: await openDraftIds(db, customer.id, d.platform) } : {}) })
    // The final URL carries our campaign id for attribution, so it is set once the id exists.
    if (d.platform === 'google') await saveDraft(env, customer, { id: saved.id, spec: { ...d.spec, finalUrl: d.url(saved.id) } })
    ids.push(saved.id)
  }
  const { rationale, imageConcepts, videoConcepts, tracking, landing, recommendedChannels } = result.plan
  return json(201, { source: result.source, campaignIds: ids, rationale, recommendedChannels, imageConcepts, videoConcepts, tracking, landing })
}
