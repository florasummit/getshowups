// GET /api/platform/growth — Admin → Growth: measured figures (labelled live / test / estimated / unavailable, with
// samples and the date range), the simulator's prefilled baseline (measured where the sample allows, otherwise a
// labelled assumption) and the deterministic Decide recommendation. Platform admins only; read-only; no personal data.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { growthMeasure, decide } from '../../../server/growth.js'
import { baselineFrom } from '../../../server/growth-model.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    const measure = await growthMeasure(env)
    const baseline = baselineFrom(measure.measured)
    return json(200, { measure, baseline, decide: decide(measure) })
  } catch (err) {
    console.error('growth failed:', err?.name, err?.message?.slice(0, 80))
    return json(503, { error: 'storage_error' })
  }
}
