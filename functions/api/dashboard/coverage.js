// POST /api/dashboard/coverage { leadId, decision: 'approve' | 'decline' }
// The owner's answer to a service-area request (server/coverage.js). Approve: the SAME lead becomes bookable and the
// visitor is sent their booking link (normal message rules: automations, launch gate, opt-outs); the response also
// carries the link so the owner can send it themselves. Decline: the lead is kept, never bookable. The business's
// service ZIP list is never changed here. Session business only; same-origin; rate-limited; audited (no contact data).
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { recordEvent } from '../../../server/auditlog.js'
import { decideCoverage } from '../../../server/coverage.js'
import { scheduleCoverageMessage } from '../../../server/messages.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'coverageWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => ({}))
  const r = await decideCoverage(env, session.customer, b?.leadId, b?.decision, session.email)
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  if (!r.unchanged) {
    if (r.coverage === 'approved') {
      const consent = await env.ONBOARDING_DB.prepare('SELECT 1 AS y FROM sms_consents WHERE lead_id = ?1').bind(b.leadId).first().catch(() => null)
      await scheduleCoverageMessage(env, session.customer, { id: b.leadId, smsConsent: Boolean(consent) })
    }
    await recordEvent(env.ONBOARDING_DB, { type: 'lead.coverage', actorType: 'owner', actor: session.email, customer: session.customer.id, capability: 'booking', resource: { type: 'lead', id: b.leadId }, outcome: 'success', details: { decision: r.coverage } }).catch(() => {})
  }
  return json(200, { coverage: r.coverage, bookingUrl: r.bookingUrl ?? null, unchanged: Boolean(r.unchanged) })
}
