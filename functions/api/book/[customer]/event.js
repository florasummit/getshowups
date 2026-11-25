// POST /api/book/:customer/event — the booking page reports how far a visit got (server/booking-funnel.js).
//   Body: { stage, visit, device, source?, service? }  → 204. Codes only; nothing personal is accepted or stored.
// Same-origin only, rate-limited per IP, and never an error the visitor sees (the page ignores the answer).
import { json } from '../../../../server/google-oauth.js'
import { isSameOrigin } from '../../../../server/auth.js'
import { CUSTOMER_RE } from '../../../../server/invites.js'
import { getCustomer } from '../../../../server/customers.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { track } from '../../../../server/events.js'
import { validateStage } from '../../../../server/booking-funnel.js'

export async function onRequestPost({ request, env, params }) {
  if (!isSameOrigin(request, env)) return json(403, { error: 'forbidden' })
  const id = String(params?.customer || '').toLowerCase()
  if (!CUSTOMER_RE.test(id)) return json(404, { error: 'not_found' })
  const rl = await hitByIp(env, 'bookEvent', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const [error, e] = validateStage(await request.json().catch(() => null))
  if (error) return json(400, { error })
  const customer = await getCustomer(env.ONBOARDING_DB, id).catch(() => null)
  if (!customer || customer.status !== 'active') return json(404, { error: 'not_found' })
  await track(env, 'booking_stage', { id: `bk:${e.visit}:${e.stage}`, customer: id, props: { stage: e.stage, device: e.device, source: e.source, ...(e.service ? { service: e.service } : {}) } })
  return new Response(null, { status: 204 })
}
