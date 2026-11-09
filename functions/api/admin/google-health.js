// GET /api/admin/google-health?customer=<customer-id>
//   Authorization: Bearer <ADMIN_API_TOKEN>
//
// Read-only check that one customer's stored Google connection still works:
//   1. reads google:<customer> from KV (that key only)
//   2. decrypts the refresh token inside the Worker
//   3. exchanges it for a short-lived access token
//   4. calls freeBusy.query on the primary calendar (allowed by the calendar.freebusy scope)
// Responds with status codes and sanitized error codes only: no tokens, no credentials, no
// calendar or event data. Nothing is written to KV, D1, or Google Calendar.
// Only GET is exported. Other methods never reach this handler (Pages answers POST with 405).
import { isAdmin, json, missingConfig } from '../../../server/google-oauth.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { checkConnection } from '../../../server/calendar.js'

export async function onRequestGet({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) {
    console.error('Google OAuth not configured; missing:', missing.join(', '))
    return json(503, { error: 'not_configured' })
  }
  if (!(await isAdmin(request, env))) return json(401, { error: 'unauthorized' })

  const customer = (new URL(request.url).searchParams.get('customer') || '').toLowerCase()
  if (!CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_customer' })

  const { httpStatus, body } = await checkConnection(env, customer)
  return json(httpStatus, body)
}
