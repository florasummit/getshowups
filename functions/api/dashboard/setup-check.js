// GET /api/dashboard/setup-check — what is missing or inconsistent in this business's setup (server/setup-check.js).
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { setupCheck } from '../../../server/setup-check.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, await setupCheck(env, session.customer))
}
