// GET /api/platform/customer?id=…[&health=1] — one business: owners, onboarding, invitations,
// activity counts, subscription, audit trail, and (on request) a live calendar health check.
// Lead and appointment contact details are not exposed here; counts only.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { customerRows } from '../../../server/metrics.js'
import { checkConnection } from '../../../server/calendar.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const url = new URL(request.url)
  const id = String(url.searchParams.get('id') || '').toLowerCase()
  if (!CUSTOMER_RE.test(id)) return json(400, { error: 'invalid_customer' })
  const summary = (await customerRows(env)).find((c) => c.id === id)
  if (!summary) return json(404, { error: 'not_found' })
  const db = env.ONBOARDING_DB
  const list = async (sql) => (await db.prepare(sql).bind(id).all()).results
  const invites = await list(
    'SELECT id, email, created_by, created_at, expires_at, accepted_at, revoked_at, sent_count FROM account_invites WHERE customer = ?1 ORDER BY created_at DESC LIMIT 20',
  )
  const auditLog = await list('SELECT at, actor, action, details FROM admin_audit WHERE customer = ?1 ORDER BY at DESC LIMIT 30')
  const totals = await db
    .prepare(
      "SELECT (SELECT count(*) FROM leads WHERE customer = ?1) AS leads, (SELECT count(*) FROM appointments WHERE customer = ?1 AND status IN ('booked','showed','no_show')) AS booked, (SELECT count(*) FROM appointments WHERE customer = ?1 AND status = 'showed') AS showed, (SELECT count(*) FROM appointments WHERE customer = ?1 AND status = 'no_show') AS no_show",
    )
    .bind(id)
    .first()
  const health = url.searchParams.get('health') === '1' ? (await checkConnection(env, id)).body : null
  const now = Date.now()
  const withState = invites.map((i) => ({ ...i, active: !i.accepted_at && !i.revoked_at && i.expires_at > now }))
  return json(200, { ...summary, totals, invites: withState, audit: auditLog.map((a) => ({ ...a, details: JSON.parse(a.details) })), health })
}
