// GET /api/ads/openai/locations?q=charleston — ChatGPT Ads markets (metro areas) and regions matching the text, read
// through the business's own key (OpenAI GET /geo_lookup/search). Read-only; nothing is stored. OpenAI cannot target
// ZIP codes, a radius or a city: the dashboard says so next to the results.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { openaiAdsEnabled, searchLocations } from '../../../../server/ads/openai.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env) || !openaiAdsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'adsGeo', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const r = await searchLocations(env, session.customer.id, new URL(request.url).searchParams.get('q'))
  if (!r.ok) return json(r.error === 'invalid_request' ? 400 : r.error === 'not_connected' ? 404 : r.reconnect ? 409 : 503, { error: r.error })
  return json(200, { results: r.results })
}
