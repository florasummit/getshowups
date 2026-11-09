// POST /api/dashboard/accept-invite — { token }. Joins the invited business if the signed-in Google
// email is the invited one. The customer then authorizes their own Google Calendar during setup.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { acceptInvite } from '../../../server/accounts.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { needCustomer: false, write: true })
  if (response) return response
  const { token } = (await request.json().catch(() => ({}))) || {}
  const result = await acceptInvite(env, { token, email: session.email, hasBusiness: Boolean(session.customer) })
  if (result.ok) return json(200, { customer: result.customer })
  const status = result.error === 'invite_invalid' ? 404 : 409
  return json(status, { error: result.error, ...(result.expected ? { expected: result.expected } : {}) })
}
