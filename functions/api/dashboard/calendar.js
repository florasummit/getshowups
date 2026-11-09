// GET /api/dashboard/calendar — live Google Calendar connection status for the signed-in customer.
// Runs the same read-only check as the admin health endpoint. The customer comes from the session.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { connect, freeBusy } from '../../../server/calendar.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response

  const checkedAt = new Date().toISOString()
  const conn = await connect(env, session.customer.id)
  if (!conn.ok) return json(200, { status: conn.status, checkedAt })

  const now = Date.now()
  const fb = await freeBusy(env, conn.accessToken, now, now + 24 * 60 * 60 * 1000)
  if (!fb.ok) {
    console.error('dashboard calendar check failed:', session.customer.id, fb.httpStatus, fb.error)
    return json(200, { status: 'calendar_error', checkedAt, account: conn.account, error: fb.error })
  }
  return json(200, { status: 'healthy', checkedAt, account: conn.account, scopesOk: conn.scopes.ok })
}
