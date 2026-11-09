// POST /api/dashboard/connect-link — issues a single-use Google Calendar connection link for the
// signed-in customer through the existing invite flow ("reconnect" if a connection exists).
import { json } from '../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../server/auth.js'
import { createInvite } from '../../../server/invites.js'

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response

  const customer = session.customer.id
  let existing
  try {
    existing = await env.GOOGLE_TOKENS.get(`google:${customer}`)
  } catch {
    return json(503, { error: 'storage_error' })
  }
  const purpose = existing ? 'reconnect' : 'connect'
  let invite
  try {
    invite = await createInvite(env.ONBOARDING_DB, customer, purpose)
  } catch (err) {
    console.error('connect-link invite failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
  const { token, expiresAt } = invite
  // invite is returned so the dashboard can submit it straight to the confirmation step.
  return json(201, { purpose, invite: token, url: `${siteOrigin(env)}/api/google/oauth/start?invite=${token}`, expiresAt: new Date(expiresAt).toISOString() })
}
