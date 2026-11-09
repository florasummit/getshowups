// POST /api/auth/logout — ends the dashboard session (deletes it server-side) and clears the cookie.
import { json, missingConfig } from '../../../server/google-oauth.js'
import { SESSION_COOKIE, cookie, deleteSession, getSession, isSameOrigin } from '../../../server/auth.js'

export async function onRequestPost({ request, env }) {
  if (missingConfig(env).length) return json(503, { error: 'not_configured' })
  if (!isSameOrigin(request, env)) return json(403, { error: 'forbidden' })

  const session = await getSession(request, env)
  if (session) await deleteSession(env.ONBOARDING_DB, session.tokenHash)
  const res = json(200, { ok: true })
  res.headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0))
  return res
}
