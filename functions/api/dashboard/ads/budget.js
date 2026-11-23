// POST /api/dashboard/ads/budget — the owner approves a monthly ad spending ceiling.
//   Body: { monthlyCents, confirm: true }. Ad spend is billed by Google/Meta to the owner's own account.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { approveBudget } from '../../../../server/ads/budget.js'
import { logAction, enforceApproval } from '../../../../server/ads/campaigns.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { adsHold } from '../../../../server/ads/holds.js'
import { currentApproval } from '../../../../server/ads/budget.js'

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'adsWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (body?.confirm !== true) return json(400, { error: 'confirmation_required' })
  // On hold: a lower ceiling is always fine; a higher one waits until the hold is resolved.
  const hold = await adsHold(env, session.customer.id)
  if (hold) {
    const current = await currentApproval(env.ONBOARDING_DB, session.customer.id)
    if (!current || Number(body.monthlyCents) > current.monthly_cents) return json(409, { error: 'ads_on_hold', hold: hold.reason })
  }
  const r = await approveBudget(env.ONBOARDING_DB, session.customer.id, body.monthlyCents, session.email)
  if (!r.ok) return json(400, { error: r.error })
  await logAction(env.ONBOARDING_DB, { customer: session.customer.id, campaignId: null, actor: `owner:${session.email}`, kind: 'budget_approve', reason: 'Owner approved a monthly ad budget', details: { monthlyCents: r.monthlyCents } })
  // A lower approval also applies to campaigns already running (lowered on Google, or paused).
  const enforced = await enforceApproval(env, session.customer.id, `owner:${session.email}`).catch((err) => (console.error('ads budget enforce failed:', err?.name), { failed: 1 }))
  return json(200, { monthlyCents: r.monthlyCents, dailyCeilingCents: r.dailyCeilingCents, enforced })
}
