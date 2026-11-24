// The dashboard assistant (server/assist.js): read-only, one question at a time, the session's own business.
//   GET → { enabled }.
//   POST { question, topic?, view?, days? (7|30|90: the Ads results period on screen), history? }
//     → { kind, answer, days, note?, evidence?, proposal? } | { error, evidence? }.
// Help and prepared changes need no model and don't use the daily allowance.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { track } from '../../../server/events.js'
import { ask, chatAccess, deterministic, evidenceFor, validateQuestion } from '../../../server/assist.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { enabled: await chatAccess(env, session.customer) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  if (!(await chatAccess(env, customer))) return json(404, { error: 'not_found' })
  const [error, req] = validateQuestion(await request.json().catch(() => null))
  if (error) return json(400, { error })
  const burst = await hit(env, 'assistMessage', customer.id)
  if (burst.limited) return tooManyJson(burst.retryAfter)
  let evidence = null
  try {
    const d = await deterministic(env, customer, req)
    if (d) return json(200, { ...d, days: req.days })
    evidence = await evidenceFor(env, customer, req)
  } catch (err) {
    console.error('assist failed:', err?.name)
    return json(503, { error: 'unavailable' })
  }
  const extra = evidence ? { evidence, days: req.days } : {}
  for (const rule of ['aiAskBurst', 'aiAsk']) {
    const rl = await hit(env, rule, customer.id)
    if (rl.limited) return evidence ? json(429, { error: 'rate_limited', ...extra }) : tooManyJson(rl.retryAfter)
  }
  let r
  try {
    r = await ask(env, customer, req)
  } catch (err) {
    console.error('assist failed:', err?.name)
    return json(503, { error: 'unavailable', ...extra })
  }
  // Topic, codes and numbers only; never the question or the answer.
  await track(env, 'ai_ask', { customer: customer.id, props: { topic: req.topic, view: req.view, days: req.days, ok: r.ok, ...(r.ok ? { kind: r.kind } : { reason: r.reason }), costMicros: r.costMicros, ms: r.ms } })
  if (r.ok) return json(200, { kind: r.kind, answer: r.answer, days: req.days, ...(r.note ? { note: r.note } : {}), ...extra })
  return json(['timeout', 'unavailable'].includes(r.reason) ? 503 : 422, { error: r.reason === 'timeout' ? 'unavailable' : r.reason, ...extra })
}
