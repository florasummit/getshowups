// Writing help for the owner's own fields (server/writing.js).
//   GET  → { enabled }: whether to offer the buttons.
//   POST { field, action: 'draft' | 'improve' | 'shorten', text } → { text } (a suggestion; nothing is saved) | { error }.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { track } from '../../../server/events.js'
import { assistAccess, suggest, validateRequest } from '../../../server/writing.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { enabled: await assistAccess(env, session.customer) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  if (!(await assistAccess(env, customer))) return json(404, { error: 'not_found' })
  const [error, req] = validateRequest(await request.json().catch(() => null))
  if (error) return json(400, { error })
  for (const rule of ['aiWriteBurst', 'aiWrite']) {
    const rl = await hit(env, rule, customer.id)
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  let r
  try {
    r = await suggest(env, customer, req)
  } catch (err) {
    console.error('writing help failed:', err?.name)
    return json(503, { error: 'unavailable' })
  }
  // Numbers and codes only; never the text.
  await track(env, 'ai_write', { customer: customer.id, props: { field: req.field, action: req.action, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), costMicros: r.costMicros, ms: r.ms } })
  if (r.ok) return json(200, { text: r.text })
  return json(r.reason === 'timeout' || r.reason === 'unavailable' ? 503 : 422, { error: r.reason === 'timeout' ? 'unavailable' : r.reason })
}
