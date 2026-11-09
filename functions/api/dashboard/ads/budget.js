// POST /api/dashboard/ads/budget — the owner approves a monthly ad spending ceiling.
//   Body: { monthlyCents, confirm: true }. Ad spend is billed by Google/Meta to the owner's own account.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { approveBudget } from '../../../../server/ads/budget.js'
import { logAction } from '../../../../server/ads/campaigns.js'

export async function onRequestPost({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'adsWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (body?.confirm !== true) return json(400, { error: 'confirmation_required' })
  const r = await approveBudget(env.ONBOARDING_DB, session.customer.id, body.monthlyCents, session.email)
  if (!r.ok) return json(400, { error: r.error })
  await logAction(env.ONBOARDING_DB, { customer: session.customer.id, campaignId: null, actor: `owner:${session.email}`, kind: 'budget_approve', reason: 'Owner approved a monthly ad budget', details: { monthlyCents: r.monthlyCents } })
  return json(200, { monthlyCents: r.monthlyCents, dailyCeilingCents: r.dailyCeilingCents })
}
