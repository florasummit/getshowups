// POST { type: 'service_zips', before, after, confirm: true }: the owner approves a change the assistant prepared
// (server/proposals.js). The business is the session's own; 409 stale when the list changed since it was reviewed.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { applyServiceArea } from '../../../server/proposals.js'
import { chatAccess } from '../../../server/assist.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await chatAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'assistMessage', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    const r = await applyServiceArea(env, session, await request.json().catch(() => null))
    return r.ok ? json(200, { ok: true, serviceZips: r.serviceZips }) : json(r.status, { error: r.error })
  } catch (err) {
    console.error('proposal failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
