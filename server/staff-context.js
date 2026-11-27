// Staff configuring a PENDING assisted-enrollment workspace through the ordinary dashboard routes (docs/ASSISTED_ENROLLMENT.md).
// No impersonation: the request carries the staff member's own session plus the enrollment id (header
// X-GSU-Enrollment); requireSession (server/auth.js) hands the route a session whose customer is that enrollment's
// business and whose `staff` says who is acting. The staff email is never written to customer_users, so owner-only
// checks (isOwner) never pass for staff. Allowed only:
//   - for a staff role that may configure this enrollment (platform admin; onboarding: any; sales rep: assigned only),
//     read on every request (a revocation or reassignment takes effect on the next request);
//   - while the enrollment has a workspace and is not claimed or abandoned (after the handoff staff access ends);
//   - on the configuration routes below (setup, settings, website, receptionist settings). Everything else (billing,
//     people, account deletion, export, AI keys, ads, domains, messages, leads, appointments) answers 403 staff_not_allowed.
// Every staff write is audited (admin_audit + audit_log) with the route, the enrollment and the acting email.
import { json } from './google-oauth.js'
import { customerFromRow } from './auth.js'
import { getCustomer } from './customers.js'
import { rolesOf } from './roles.js'
import { audit } from './platform.js'

export const STAFF_HEADER = 'X-GSU-Enrollment'
export const ENROLLMENT_ID_RE = /^enr_[A-Za-z0-9_-]{16}$/
export const STAFF_PATHS = new Set([
  '/api/dashboard/me',
  '/api/dashboard/business',
  '/api/dashboard/hours',
  '/api/dashboard/profile',
  '/api/dashboard/policies',
  '/api/dashboard/onboarding',
  '/api/dashboard/setup-check',
  '/api/dashboard/availability',
  '/api/dashboard/booking',
  '/api/dashboard/calendar',
  '/api/dashboard/connect-link',
  '/api/dashboard/address',
  '/api/dashboard/website',
  '/api/dashboard/website/preview',
  '/api/dashboard/website/assets',
  '/api/dashboard/website/import',
  '/api/dashboard/receptionist',
  '/api/dashboard/receptionist/voices',
])
export const CONFIGURABLE_STAGES = ['prospect', 'payment_sent', 'paid', 'configuring', 'ready', 'invited']

export const mayConfigure = (roles, email, row) =>
  roles.has('platform_admin') || roles.has('onboarding') || (roles.has('sales_rep') && Boolean(row.assigned_rep_email) && row.assigned_rep_email === email)

// paths: false only for /site-assets (a read of this business's own private images, no route behind it).
export async function staffSession(request, env, session, enrollmentId, { write = false, paths = true } = {}) {
  const forbidden = (error = 'staff_not_allowed') => ({ response: json(403, { error }) })
  if (!ENROLLMENT_ID_RE.test(String(enrollmentId))) return forbidden()
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  if (paths && !STAFF_PATHS.has(path)) return forbidden()
  const db = env.ONBOARDING_DB
  let row
  try {
    row = await db.prepare('SELECT * FROM assisted_enrollments WHERE id = ?1').bind(enrollmentId).first()
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return forbidden()
    throw err
  }
  if (!row?.customer || !CONFIGURABLE_STAGES.includes(row.stage) || row.assignment_closed_at) return forbidden()
  const roles = await rolesOf(env, session.email)
  if (!mayConfigure(roles, session.email, row)) return forbidden()
  const customer = customerFromRow(await getCustomer(db, row.customer))
  if (!customer) return forbidden()
  const role = roles.has('platform_admin') ? 'platform_admin' : roles.has('onboarding') ? 'onboarding' : 'sales_rep'
  if (write) await audit(env, session.email, 'enrollment.staff_write', customer.id, { enrollment: row.id, path, role })
  if (!row.config_started_at) await db.prepare('UPDATE assisted_enrollments SET config_started_at = ?2, updated_at = ?2 WHERE id = ?1 AND config_started_at IS NULL').bind(row.id, Date.now()).run()
  return { session: { ...session, customer, staff: { email: session.email, role, enrollmentId: row.id } } }
}
