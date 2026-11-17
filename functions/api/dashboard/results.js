// GET /api/dashboard/results?days=7|30|90&scope=ads|all → { funnel, diagnostics }
// The acquisition funnel for the signed-in business only (server/ads/funnel.js): one definition of results, real
// records only. scope 'ads' needs the Ads feature for this business; 'all' (every lead) is available to everyone.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { adsEnabledFor } from '../../../server/ads/access.js'
import { diagnose, funnel } from '../../../server/ads/funnel.js'
import { internalEmails } from '../../../server/testdata.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const q = new URL(request.url).searchParams
  const days = [7, 30, 90].includes(Number(q.get('days'))) ? Number(q.get('days')) : 30
  const scope = q.get('scope') === 'all' ? 'all' : 'ads'
  if (scope === 'ads' && !adsEnabledFor(env, session.customer.id)) return json(404, { error: 'not_found' })
  try {
    const f = await funnel(env.ONBOARDING_DB, session.customer.id, { days, scope, internal: internalEmails(env) })
    return json(200, { funnel: f, diagnostics: diagnose(f) })
  } catch (err) {
    console.error('results failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
