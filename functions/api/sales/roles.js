// /api/sales/roles — commercial staff roles (server/roles.js). Platform admins only; every change audited.
//   GET  → { roles: [{ id, email, role, grantedBy, grantedAt }] | null (before migration 0047) }
//   POST { action: 'grant' | 'revoke', email, role: 'sales_rep' | 'onboarding' } → { ok, changed }
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { grantRole, listRoles, revokeRole } from '../../../server/roles.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  return json(200, { roles: await listRoles(env) })
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = (await request.json().catch(() => null)) || {}
  const fn = body.action === 'grant' ? grantRole : body.action === 'revoke' ? revokeRole : null
  if (!fn) return json(400, { error: 'invalid_request' })
  const r = await fn(env, admin, body.email, body.role)
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  return json(200, { ok: true, changed: r.changed, roles: await listRoles(env) })
}
