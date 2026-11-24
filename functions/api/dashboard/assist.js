// "Ask about this" (server/assist.js): read-only, one question about one help topic.
//   GET → { enabled }.  POST { topic, question } → { answer } | { error }. The business is the signed-in session's own.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { track } from '../../../server/events.js'
import { ask, chatAccess, validateQuestion } from '../../../server/assist.js'

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
  for (const rule of ['aiAskBurst', 'aiAsk']) {
    const rl = await hit(env, rule, customer.id)
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  let r
  try {
    r = await ask(env, customer, req)
  } catch (err) {
    console.error('assist failed:', err?.name)
    return json(503, { error: 'unavailable' })
  }
  // Topic, codes and numbers only; never the question or the answer.
  await track(env, 'ai_ask', { customer: customer.id, props: { topic: req.topic, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), costMicros: r.costMicros, ms: r.ms } })
  if (r.ok) return json(200, { answer: r.answer })
  return json(['timeout', 'unavailable'].includes(r.reason) ? 503 : 422, { error: r.reason === 'timeout' ? 'unavailable' : r.reason })
}
