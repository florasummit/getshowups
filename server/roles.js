// Commercial staff roles (migration 0047, docs/ASSISTED_ENROLLMENT.md). ONE authorization model on top of the existing
// session: a signed-in verified email (server/auth.js) has the roles
//   platform_admin  listed in PLATFORM_ADMIN_EMAILS (exactly as requirePlatformAdmin decides today; everything)
//   sales_rep       active commercial_roles row: sees and acts ONLY on enrollments assigned to them
//   onboarding      active commercial_roles row: configures any enrollment before its handoff; never billing or roles
// Business membership (customer_users) never grants a role and a role never grants membership. Roles are read on
// every request (no cache), so a revocation takes effect on the next request. Before 0047 is applied (or on a read
// error) only platform admins have a role: fails closed for the new roles. Affiliates/partners have no login.
import { json, missingConfig } from './google-oauth.js'
import { EMAIL_RE, getSession, isSameOrigin } from './auth.js'
import { adminEmails, audit } from './platform.js'

export const STAFF_ROLES = ['sales_rep', 'onboarding']
export const ROLE_LABELS = { platform_admin: 'Platform admin', sales_rep: 'Sales representative', onboarding: 'Onboarding' }
const norm = (e) => String(e || '').trim().toLowerCase()
const noTable = (err) => /no such table/i.test(String(err?.message || ''))

export async function rolesOf(env, email) {
  const e = norm(email)
  const roles = new Set()
  if (!e) return roles
  if (adminEmails(env).includes(e)) roles.add('platform_admin')
  try {
    const { results } = await env.ONBOARDING_DB.prepare('SELECT role FROM commercial_roles WHERE email = ?1 AND revoked_at IS NULL').bind(e).all()
    for (const r of results) if (STAFF_ROLES.includes(r.role)) roles.add(r.role)
  } catch (err) {
    if (!noTable(err)) console.error('roles lookup failed:', err?.name)
  }
  return roles
}

// Mirrors requirePlatformAdmin: 503 not configured, 403 cross-origin write, 401 signed out, 403 without one of `roles`.
// Returns { staff: { email, roles } } or { response }.
export async function requireRole(request, env, roles, { write = false } = {}) {
  if (missingConfig(env).length) return { response: json(503, { error: 'not_configured' }) }
  if (write && !isSameOrigin(request, env)) return { response: json(403, { error: 'forbidden' }) }
  let session
  try {
    session = await getSession(request, env)
  } catch (err) {
    console.error('Session lookup failed:', err?.message)
    return { response: json(503, { error: 'storage_error' }) }
  }
  if (!session) return { response: json(401, { error: 'unauthenticated' }) }
  const have = await rolesOf(env, session.email)
  if (!roles.some((r) => have.has(r))) return { response: json(403, { error: 'forbidden_role' }) }
  return { staff: { email: session.email, roles: have }, session }
}

// Stream A (email sign-in eligibility): does this email hold an active commercial role? Never throws; false before 0047.
export async function hasCommercialRole(db, email) {
  const e = norm(email)
  if (!e) return false
  try {
    return Boolean(await db.prepare('SELECT 1 FROM commercial_roles WHERE email = ?1 AND revoked_at IS NULL LIMIT 1').bind(e).first())
  } catch {
    return false
  }
}

export const isAdmin = (staff) => staff?.roles?.has('platform_admin') === true

// Active grants (platform admin view). Fail-soft: null before the migration.
export async function listRoles(env) {
  try {
    const { results } = await env.ONBOARDING_DB.prepare('SELECT id, email, role, granted_by, granted_at FROM commercial_roles WHERE revoked_at IS NULL ORDER BY email, role').all()
    return results.map((r) => ({ id: r.id, email: r.email, role: r.role, grantedBy: r.granted_by, grantedAt: r.granted_at }))
  } catch (err) {
    if (noTable(err)) return null
    throw err
  }
}

// Platform admin only (the route checks); audited. Granting an active role again is a no-op (unique partial index).
export async function grantRole(env, admin, email, role, now = Date.now()) {
  const e = norm(email)
  if (!EMAIL_RE.test(e)) return { ok: false, httpStatus: 400, error: 'invalid_email' }
  if (!STAFF_ROLES.includes(role)) return { ok: false, httpStatus: 400, error: 'invalid_role' }
  if (adminEmails(env).includes(e)) return { ok: false, httpStatus: 409, error: 'already_admin' }
  try {
    const r = await env.ONBOARDING_DB.prepare('INSERT OR IGNORE INTO commercial_roles (email, role, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)').bind(e, role, admin.email, now).run()
    if (!r.meta?.changes) return { ok: true, changed: false }
  } catch (err) {
    if (noTable(err)) return { ok: false, httpStatus: 503, error: 'migration_required' }
    throw err
  }
  await audit(env, admin.email, 'commercial.role_granted', null, { email: e, role })
  return { ok: true, changed: true }
}

export async function revokeRole(env, admin, email, role, now = Date.now()) {
  const e = norm(email)
  if (!STAFF_ROLES.includes(role)) return { ok: false, httpStatus: 400, error: 'invalid_role' }
  try {
    const r = await env.ONBOARDING_DB.prepare('UPDATE commercial_roles SET revoked_at = ?3, revoked_by = ?4 WHERE email = ?1 AND role = ?2 AND revoked_at IS NULL').bind(e, role, now, admin.email).run()
    if (!r.meta?.changes) return { ok: false, httpStatus: 404, error: 'not_found' }
  } catch (err) {
    if (noTable(err)) return { ok: false, httpStatus: 503, error: 'migration_required' }
    throw err
  }
  await audit(env, admin.email, 'commercial.role_revoked', null, { email: e, role })
  return { ok: true, changed: true }
}
