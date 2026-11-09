// POST /api/admin/customers — create or link a business to the people allowed to manage it.
// Used for businesses that existed before self-service sign-up (e.g. PoolThru, whose Google Calendar
// connection is stored under google:poolthru). The owner then finishes setup in the dashboard.
//   Authorization: Bearer <ADMIN_API_TOKEN>
//   Body: { "customer": "poolthru", "name": "PoolThru", "timezone": "America/New_York",
//           "users": ["care@poolthru.example"], "serviceZips": [] }
// Users are added, never moved between businesses: an email owned by another business → 409.
import { isAdmin, json, missingConfig } from '../../../server/google-oauth.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { EMAIL_RE } from '../../../server/auth.js'
import { validateBusiness } from '../../../server/customers.js'

export async function onRequestPost({ request, env }) {
  if (missingConfig(env).length) return json(503, { error: 'not_configured' })
  if (!(await isAdmin(request, env))) return json(401, { error: 'unauthorized' })

  const body = await request.json().catch(() => null)
  if (!body) return json(400, { error: 'invalid_json' })
  const id = String(body.customer || '').toLowerCase()
  if (!CUSTOMER_RE.test(id)) return json(400, { error: 'invalid_customer' })
  const [error, business] = validateBusiness(body)
  if (error) return json(400, { error })
  const users = Array.isArray(body.users) ? body.users.map((e) => String(e).trim().toLowerCase()) : []
  if (!users.length || users.length > 20 || users.some((e) => !EMAIL_RE.test(e))) return json(400, { error: 'invalid_users' })

  const db = env.ONBOARDING_DB
  for (const email of users) {
    const owner = await db.prepare('SELECT customer FROM customer_users WHERE email = ?1').bind(email).first()
    if (owner && owner.customer !== id) return json(409, { error: 'email_belongs_to_another_customer' })
  }

  const now = Date.now()
  await db.batch([
    db
      .prepare(
        `INSERT INTO customers (id, name, timezone, service_zips, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET name = ?2, timezone = ?3, service_zips = ?4, updated_at = ?5`,
      )
      .bind(id, business.name, business.timezone, business.serviceZips.join(','), now),
    ...users.map((email) =>
      db.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(email) DO NOTHING').bind(email, id, now),
    ),
  ])
  const { results } = await db.prepare('SELECT email FROM customer_users WHERE customer = ?1 ORDER BY email').bind(id).all()
  return json(200, {
    customer: id,
    ...business,
    calendarConnected: Boolean(await env.GOOGLE_TOKENS.get(`google:${id}`)),
    users: results.map((r) => r.email),
  })
}
