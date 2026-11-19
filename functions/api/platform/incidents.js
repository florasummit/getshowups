// GET /api/platform/incidents?status=open|resolved&business=<id> — the incident register (platform admins only;
// read-only). Incidents are opened/updated/resolved only by the cron (server/ops/incidents.js), never by hand.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { listIncidents } from '../../../server/ops/incidents.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const p = new URL(request.url).searchParams
  const status = p.get('status')
  const business = p.get('business')
  if (status !== null && !['open', 'resolved'].includes(status)) return json(400, { error: 'invalid_status' })
  if (business !== null && !CUSTOMER_RE.test(business)) return json(400, { error: 'invalid_customer' })
  try {
    return json(200, { incidents: await listIncidents(env.ONBOARDING_DB, { status, customer: business, limit: 200 }) })
  } catch (err) {
    console.error('incidents failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
