// GET → { insights } (deterministic, this business only, no model). POST { id, kind: 'snooze'|'dismiss' } → { ok }.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { dismissInsight, insights } from '../../../server/insights.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    return json(200, { insights: await insights(env, session.customer) })
  } catch (err) {
    console.error('insights failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'assistMessage', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => null)
  try {
    const ok = await dismissInsight(env, session.customer, String(b?.id || ''), String(b?.kind || ''))
    return ok ? json(200, { ok: true }) : json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('insight dismissal failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
