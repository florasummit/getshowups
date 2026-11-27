// /api/sales/enrollments — assisted enrollment for GetShowUps staff (server/enrollment.js, docs/ASSISTED_ENROLLMENT.md).
// Roles from server/roles.js on every request: platform admins everything; sales representatives ONLY their assigned
// enrollments; onboarding personnel configure and invite (never payment, assignment or roles). An enrollment the caller
// may not see answers 404. Every write is same-origin, rate-limited and audited.
//   GET               → { ready, enrollments[], plans[], roles[], reps[] (admins), abandonAfterDays }
//   GET ?id=enr_…     → { enrollment, payment, invitation, checklist, configureUrl, previewUrl, can }
//   POST { action, id?, … }:
//     create { businessName, ownerName, ownerEmail, phone, notes, planId, timezone, assignedRepEmail? }
//     update { id, …same fields } · assign { id, repEmail } · workspace { id } · payment { id, email: bool }
//     invite { id } (send or resend) · revoke_invite { id } · abandon { id }
import { json } from '../../../server/google-oauth.js'
import { requireRole } from '../../../server/roles.js'
import { listRoles } from '../../../server/roles.js'
import { listPlans } from '../../../server/stripe.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import {
  ABANDON_AFTER_DAYS,
  assignEnrollment,
  createEnrollment,
  createWorkspace,
  enrollmentDetail,
  listEnrollments,
  markAbandoned,
  revokeInvitation,
  sendInvitation,
  sendPaymentLink,
  updateProspect,
} from '../../../server/enrollment.js'

const ROLES = ['platform_admin', 'sales_rep', 'onboarding']
const out = (r, ok) => (r.ok ? json(200, ok(r)) : json(r.httpStatus || 500, { error: r.error, ...(r.missing ? { missing: r.missing } : {}) }))

export async function onRequestGet({ request, env }) {
  const { staff, response } = await requireRole(request, env, ROLES)
  if (response) return response
  try {
    const id = new URL(request.url).searchParams.get('id')
    if (id) return out(await enrollmentDetail(env, staff, id), (r) => ({ ...r, ok: undefined }))
    const list = await listEnrollments(env, staff)
    const admin = staff.roles.has('platform_admin')
    const roles = admin ? await listRoles(env) : null
    return json(200, {
      ...list,
      plans: (await listPlans(env.ONBOARDING_DB)).map((p) => ({ id: p.id, name: p.name })),
      roles: [...staff.roles].sort(),
      reps: roles ? roles.filter((r) => r.role === 'sales_rep').map((r) => r.email) : null,
      staffRoles: roles,
      abandonAfterDays: ABANDON_AFTER_DAYS,
    })
  } catch (err) {
    console.error('enrollments read failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { staff, response } = await requireRole(request, env, ROLES, { write: true })
  if (response) return response
  const rl = await hit(env, 'enrollmentWrite', staff.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = (await request.json().catch(() => null)) || {}
  try {
    switch (b.action) {
      case 'create':
        return out(await createEnrollment(env, staff, b), (r) => ({ id: r.id }))
      case 'update':
        return out(await updateProspect(env, staff, b.id, b), () => ({ ok: true }))
      case 'assign':
        return out(await assignEnrollment(env, staff, b.id, b.repEmail), () => ({ ok: true }))
      case 'workspace':
        return out(await createWorkspace(env, staff, b.id), (r) => ({ customer: r.customer }))
      case 'payment': {
        const pl = await hit(env, 'enrollmentPayment', String(b.id || '').slice(0, 40))
        if (pl.limited) return tooManyJson(pl.retryAfter)
        return out(await sendPaymentLink(env, staff, b.id, { email: b.email === true }), (r) => ({ url: r.url, emailed: r.emailed }))
      }
      case 'invite':
        return out(await sendInvitation(env, staff, b.id), (r) => ({ url: r.url, expiresAt: r.expiresAt }))
      case 'revoke_invite':
        return out(await revokeInvitation(env, staff, b.id), () => ({ ok: true }))
      case 'abandon':
        return out(await markAbandoned(env, staff, b.id), () => ({ ok: true }))
      default:
        return json(400, { error: 'invalid_request' })
    }
  } catch (err) {
    console.error('enrollment action failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
