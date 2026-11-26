// POST /api/platform/acquisition { code, status?, label?, costCents? } → records what the founder did with one
// tracking code of an acquisition activity (server/acquisition.js). Platform admins only, same-origin, audited
// (codes and statuses only). It records; it never sends, publishes or spends anything. 409 not_ready before migration 0044.
// { code, activity, create: true } adds a NEW code to an activity: 409 code_exists when the code is in the plan or stored
// already (adding never changes an existing code). The view itself is part of GET /api/platform/growth.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { saveAcquisitionCode } from '../../../server/acquisition.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || (body.create !== true && body.status === undefined && body.label === undefined && body.costCents === undefined)) return json(400, { error: 'invalid_request' })
  try {
    const r = await saveAcquisitionCode(env, body)
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    await audit(env, admin.email, 'acquisition.code_updated', null, { code: r.code, activity: r.activity, from: r.from, to: r.to })
    return json(200, { ok: true, code: r.code, status: r.to.status })
  } catch (err) {
    console.error('acquisition save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
