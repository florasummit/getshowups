// GET /api/platform/commercial — Admin → Growth → Pipeline and Partners: the commercial pipeline (server/commercial-report.js)
// and the referral partners with their referred customers and commission ledger (server/partners.js). Platform admins
// only; read-only. No owner contact details; partner contact addresses are GetShowUps' own records for this admin view.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { commercialPipeline } from '../../../server/commercial-report.js'
import { partnersOverview } from '../../../server/partners.js'
import { stripeLiveEnabled } from '../../../server/stripe.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    const pipeline = await commercialPipeline(env)
    const partners = await partnersOverview(env, { origin: new URL(request.url).origin, live: stripeLiveEnabled(env) })
    return json(200, { pipeline, partners })
  } catch (err) {
    console.error('commercial view failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
