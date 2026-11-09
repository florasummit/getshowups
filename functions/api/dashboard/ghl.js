// /api/dashboard/ghl — the signed-in owner's GoHighLevel connection.
//   GET  → { connected, locationId, pipelineId, stageIds, workflowId, smsVia } (never the token)
//   POST { token, locationId, pipelineId, stageIds: {new, booked, showed, noShow, completed},
//          workflowId?, smsVia?: 'getshowups'|'ghl' }   → verifies the token, then saves (encrypted)
//   POST { disconnect: true }                             → removes the connection
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { deleteGhlConfig, getGhlConfig, publicConfig, saveGhlConfig } from '../../../server/ghl.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, publicConfig(await getGhlConfig(env, session.customer.id)))
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_json' })
  if (body.disconnect === true) {
    const r = await deleteGhlConfig(env, session.customer.id)
    return r.ok ? json(200, { connected: false }) : json(503, { error: r.error })
  }
  const r = await saveGhlConfig(env, session.customer.id, body)
  if (r.ok) return json(200, r.config)
  const status = r.error === 'storage_error' || r.error === 'provider_error' || r.error === 'network_error' ? 502 : 400
  return json(status, { error: r.error })
}
