// GET /api/platform/review            — Business Review, Platform view (capabilities, journey, dependencies, health,
//                                        incidents, approvals, release/config/migration history, business list)
// GET /api/platform/review?business=id — Business view for one business (counts only; no lead contact details)
// Platform admins only; read-only. Built from the capability registry (server/ops/), so new features appear here
// without changes to this route or the UI.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { businessReview, platformReview } from '../../../server/ops/review.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const id = new URL(request.url).searchParams.get('business')
  try {
    if (id !== null) {
      const b = String(id).toLowerCase()
      if (!CUSTOMER_RE.test(b)) return json(400, { error: 'invalid_customer' })
      const r = await businessReview(env, b)
      return r ? json(200, r) : json(404, { error: 'not_found' })
    }
    return json(200, await platformReview(env))
  } catch (err) {
    console.error('review failed:', err?.name, err?.message?.slice(0, 80))
    return json(503, { error: 'storage_error' })
  }
}
