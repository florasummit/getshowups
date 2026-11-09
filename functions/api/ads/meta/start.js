// GET /api/ads/meta/start — owner connects their business's Meta (Facebook/Instagram) ad account.
// State + business id travel in an encrypted, HttpOnly cookie; the callback re-checks the session.
import { encrypt, json, randomToken } from '../../../../server/google-oauth.js'
import { cookie, requireSession } from '../../../../server/auth.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { META_SCOPES, META_STATE_COOKIE, META_STATE_TTL_SECONDS, metaConfigured, metaDialogUrl, metaRedirectUri } from '../../../../server/ads/meta.js'

export async function onRequestGet({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  if (!metaConfigured(env)) return json(503, { error: 'not_configured' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const rl = await hitByIp(env, 'adsConnect', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)

  const state = randomToken()
  const sealed = await encrypt(env, JSON.stringify({ state, customer: session.customer.id, iat: Date.now() }))
  const auth = new URL(metaDialogUrl(env))
  auth.search = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: metaRedirectUri(env),
    response_type: 'code',
    scope: META_SCOPES.join(','),
    state,
  }).toString()
  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': cookie(META_STATE_COOKIE, sealed, META_STATE_TTL_SECONDS),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
