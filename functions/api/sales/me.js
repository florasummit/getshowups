// GET /api/sales/me — the signed-in person's commercial staff roles (server/roles.js). 401 signed out, 403 no role.
// Lets the admin console show a sales representative or onboarding person their one screen (Enrollments) and nothing else.
import { json } from '../../../server/google-oauth.js'
import { requireRole } from '../../../server/roles.js'
import { enrollmentsReady } from '../../../server/enrollment.js'

export async function onRequestGet({ request, env }) {
  const { staff, response } = await requireRole(request, env, ['platform_admin', 'sales_rep', 'onboarding'])
  if (response) return response
  return json(200, { email: staff.email, roles: [...staff.roles].sort(), ready: await enrollmentsReady(env.ONBOARDING_DB).catch(() => false) })
}
