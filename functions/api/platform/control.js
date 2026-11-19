// GET /api/platform/control — Control Center overview (platform admins only; read-only): open incidents (customer vs
// test), affected businesses, accounts needing assistance, integration health, next actions.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { controlOverview } from '../../../server/ops/control.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    return json(200, await controlOverview(env))
  } catch (err) {
    console.error('control overview failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
