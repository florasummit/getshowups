// GET /api/platform/control — Control Center overview (platform admins only; read-only): open incidents (customer vs
// test), affected businesses, accounts needing assistance, integration health, next actions.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { controlOverview } from '../../../server/ops/control.js'
import { qaOverview } from '../../../server/ops/qa.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    const qa = await qaOverview(env.ONBOARDING_DB).catch(() => null)
    return json(200, await controlOverview(env, Date.now(), { qa: qa && { automated: qa.automated.slice(0, 5), human: qa.human.slice(0, 5), failedJourneys: qa.failedJourneys }, activation: qa?.activation ?? null }))
  } catch (err) {
    console.error('control overview failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
