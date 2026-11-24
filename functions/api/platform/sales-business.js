// GET  /api/platform/sales-business → { sales: status, lab: status } (platform admins; read-only)
// POST /api/platform/sales-business { kind: 'sales' | 'lab', confirm: true } → creates that GetShowUps record once
//      (server/sales.js createSalesBusiness; idempotent; same-origin; audited). The founder then connects the Google
//      Calendar from the dashboard. Nothing is sent, charged or activated; the Lab record is an admin-marked test business.
// POST { kind, action: 'refresh_answers', version, confirm: true } → applies the current approved answers to that record
//      (409 conflict if it was edited since the page loaded; audited).
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { createSalesBusiness, refreshSalesAnswers, salesStatus } from '../../../server/sales.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const [sales, lab] = await Promise.all([salesStatus(env, 'sales'), salesStatus(env, 'lab')])
  return json(200, { sales, lab })
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  if (!['sales', 'lab'].includes(body?.kind)) return json(400, { error: 'invalid_request' })
  if (body?.confirm !== true) return json(400, { error: 'confirmation_required' })
  if (body.action === 'refresh_answers') {
    const r = await refreshSalesAnswers(env, body.kind, String(body.version || ''))
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    if (r.changed) await audit(env, admin.email, 'sales_business.answers_refreshed', r.id, { kind: body.kind })
    return json(200, { changed: r.changed, kind: body.kind, status: await salesStatus(env, body.kind) })
  }
  if (body.action !== undefined) return json(400, { error: 'invalid_request' })
  const r = await createSalesBusiness(env, admin, body.kind)
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  if (r.created) await audit(env, admin.email, 'sales_business.created', r.id, { kind: r.kind })
  return json(200, { created: r.created, kind: r.kind, id: r.id, status: r.status })
}
