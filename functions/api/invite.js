// GET /api/invite?token=… — public preview of an account invitation (business name + masked email).
import { json, missingConfig } from '../../server/google-oauth.js'
import { peekAccountInvite } from '../../server/accounts.js'
import { hitByIp, tooManyJson } from '../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  if (missingConfig(env).length) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'invitePeek', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const invite = await peekAccountInvite(env, new URL(request.url).searchParams.get('token'))
  return invite ? json(200, invite) : json(404, { error: 'invite_invalid' })
}
