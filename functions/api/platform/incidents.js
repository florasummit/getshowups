// GET /api/platform/incidents?status=open|resolved&business=<id> — the incident register (platform admins only;
// read-only). GET /api/platform/incidents?id=<incident id> — one incident for the investigation view (history,
// underlying failure events as codes, latest success). Incidents are opened/updated/resolved only by the cron
// (server/ops/incidents.js), never by hand.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { incidentDetail, listIncidents } from '../../../server/ops/incidents.js'

const INCIDENT_RE = /^inc_[A-Za-z0-9_-]{6,40}$/

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const p = new URL(request.url).searchParams
  const id = p.get('id')
  const status = p.get('status')
  const business = p.get('business')
  if (id !== null && !INCIDENT_RE.test(id)) return json(400, { error: 'invalid_incident' })
  if (status !== null && !['open', 'resolved'].includes(status)) return json(400, { error: 'invalid_status' })
  if (business !== null && !CUSTOMER_RE.test(business)) return json(400, { error: 'invalid_customer' })
  try {
    if (id !== null) {
      const d = await incidentDetail(env.ONBOARDING_DB, id)
      return d ? json(200, d) : json(404, { error: 'not_found' })
    }
    return json(200, { incidents: await listIncidents(env.ONBOARDING_DB, { status, customer: business, limit: 200 }) })
  } catch (err) {
    console.error('incidents failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
