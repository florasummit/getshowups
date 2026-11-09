// GET /api/platform/plans — configured plans.  POST — create/update a plan mapped to a Stripe Price.
//   { id, name, stripePriceId, trialDays, entitlements: {…}, active }
// Prices are defined in Stripe, never here.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { listPlans } from '../../../server/stripe.js'

const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  return json(200, { plans: await listPlans(env.ONBOARDING_DB, { includeInactive: true }) })
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const b = (await request.json().catch(() => ({}))) || {}
  const name = String(b.name || '').trim()
  const trialDays = b.trialDays ?? 0
  const entitlements = b.entitlements ?? {}
  if (!ID_RE.test(String(b.id)) || !name || name.length > 60) return json(400, { error: 'invalid_plan' })
  if (!/^price_[A-Za-z0-9]{6,}$/.test(String(b.stripePriceId))) return json(400, { error: 'invalid_price' })
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) return json(400, { error: 'invalid_trial' })
  if (typeof entitlements !== 'object' || Array.isArray(entitlements) || JSON.stringify(entitlements).length > 2000) {
    return json(400, { error: 'invalid_entitlements' })
  }
  await env.ONBOARDING_DB.prepare(
    `INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET name = ?2, stripe_price_id = ?3, trial_days = ?4, entitlements = ?5, active = ?6`,
  )
    .bind(b.id, name, b.stripePriceId, trialDays, JSON.stringify(entitlements), b.active === false ? 0 : 1, Date.now())
    .run()
  await audit(env, admin.email, 'plan.upsert', null, { id: b.id, stripePriceId: b.stripePriceId, trialDays, active: b.active !== false })
  return json(200, { plans: await listPlans(env.ONBOARDING_DB, { includeInactive: true }) })
}
