// GET /api/platform/ai-spend — today's GetShowUps-paid AI spending (server/ai-budget.js): platform total, the public share,
// the top businesses and each entry point, against their ceilings, plus the emergency switches. Platform admins only,
// read-only; business ids and micro-dollars, nothing else.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { spendToday } from '../../../server/ai-budget.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    return json(200, await spendToday(env))
  } catch {
    return json(503, { error: 'unavailable' })
  }
}
