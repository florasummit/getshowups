// GET  /api/ads/gbp/locations — the Business Profile locations the signed-in business's grant reaches (fresh from
//      Google, names and places only) and which one is linked.
// POST /api/ads/gbp/locations { locationName } — link one of them (validated against Google's list), reading its
//      verification state. Read-only toward the profile itself.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { gbpEnabled, getGbp, listLocations, publicLocation, selectLocation } from '../../../../server/ads/gbp.js'

const STATUS = { reconnect_required: 409, permission_denied: 403, quota_exhausted: 503, transient: 503, not_ready: 503, location_not_accessible: 400, invalid_request: 400, not_found: 404 }

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env) || !gbpEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const row = await getGbp(env, session.customer.id)
  if (!row) return json(404, { error: 'not_connected' })
  const r = await listLocations(env, session.customer.id)
  if (!r.ok) return json(STATUS[r.error] || 502, { error: r.error })
  return json(200, { status: row.status, selected: row.location_name || null, locations: r.locations.map(publicLocation) })
}

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env) || !gbpEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'adsWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (!(await getGbp(env, session.customer.id))) return json(404, { error: 'not_connected' })
  const r = await selectLocation(env, session.customer.id, body?.locationName)
  if (!r.ok) return json(STATUS[r.error] || 502, { error: r.error })
  return json(200, { ok: true, location: r.location, verification: r.verification })
}
