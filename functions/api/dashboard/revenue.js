// POST /api/dashboard/revenue { appointmentId, kind: 'invoiced'|'paid', amountCents: integer|null }
// Records what was billed or received for a visit that happened (server/revenue.js; append-only history, null clears).
// Session business only; same-origin; rate-limited; audited (amounts are business data, not personal data).
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { recordEvent } from '../../../server/auditlog.js'
import { recordRevenue } from '../../../server/revenue.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'revenueWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => ({}))
  const r = await recordRevenue(env.ONBOARDING_DB, session.customer, b?.appointmentId, b?.kind, b?.amountCents === undefined ? undefined : b.amountCents, session.email)
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  if (!r.unchanged)
    await recordEvent(env.ONBOARDING_DB, { type: 'appointment.revenue', actorType: 'owner', actor: session.email, customer: session.customer.id, capability: 'outcomes', resource: { type: 'appointment', id: b.appointmentId }, outcome: 'success', details: { kind: b.kind, cleared: b.amountCents === null } }).catch(() => {})
  return json(200, { revenue: r.revenue })
}
