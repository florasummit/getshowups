// GET /api/dashboard/setup-check — what is missing or inconsistent in this business's setup (server/setup-check.js).
// POST { id, action: 'dismiss' } — the owner's "I work that day" for a notice that offers it (same-origin; this business only).
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { dismissCheck, setupCheck } from '../../../server/setup-check.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, await setupCheck(env, session.customer))
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'assistMessage', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => null)
  if (b?.action !== 'dismiss') return json(400, { error: 'invalid_request' })
  try {
    const ok = await dismissCheck(env, session.customer, String(b?.id || ''))
    return ok ? json(200, await setupCheck(env, session.customer)) : json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('setup check dismissal failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
