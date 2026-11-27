// POST /api/platform/partners — referral partner admin (server/partners.js): { action: 'create', name, contactEmail?, terms? }
// | { action: 'pause' | 'resume', id } | { action: 'terms', id, terms }. Platform admins only, same-origin, audited (ids,
// statuses and terms; the contact address never enters the audit). Partners get no login and no access. Recording a
// partner or terms pays nothing and accrues nothing unless REFERRALS_ENABLED is exactly 'true'. 409 not_ready before 0048.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { savePartner } from '../../../server/partners.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_request' })
  try {
    const r = await savePartner(env, body, admin.email)
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    await audit(env, admin.email, `partner.${body.action === 'create' ? 'created' : body.action === 'terms' ? 'terms_set' : body.action === 'pause' ? 'paused' : 'resumed'}`, null, { partner: r.partner.id, from: r.from ?? null, to: r.to ?? null })
    return json(200, { ok: true, partner: r.partner })
  } catch (err) {
    console.error('partner save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
