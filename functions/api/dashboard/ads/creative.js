// /api/dashboard/ads/creative
//   GET ?id=<creative id>  the asset bytes (this business only)
//   POST { action: 'image', prompt, size? } | { action: 'video', prompt, imageId } | { action: 'approve'|'reject', id }
// Generation is quota- and cost-capped per business per month (server/ads/creative.js).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { generateImage, startVideo, setCreativeDecision, getCreativeAsset } from '../../../../server/ads/creative.js'

export async function onRequestGet({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const id = new URL(request.url).searchParams.get('id')
  const asset = id && /^[A-Za-z0-9_-]{8,40}$/.test(id) ? await getCreativeAsset(env, session.customer.id, id) : null
  if (!asset) return json(404, { error: 'not_found' })
  return new Response(asset.bytes, { headers: { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } })
}

export async function onRequestPost({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const id = session.customer.id
  const body = await request.json().catch(() => null)
  const generating = body?.action === 'image' || body?.action === 'video'
  const rl = await hit(env, generating ? 'adsCreative' : 'adsWrite', id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  let r
  if (body?.action === 'image') r = await generateImage(env, id, { prompt: body.prompt, size: body.size || '1024x1024' })
  else if (body?.action === 'video') r = await startVideo(env, id, { prompt: body.prompt, imageCreativeId: body.imageId })
  else if (body?.action === 'approve' || body?.action === 'reject') r = (await setCreativeDecision(env.ONBOARDING_DB, id, body.id, body.action === 'approve' ? 'approved' : 'rejected')) ? { ok: true } : { ok: false, error: 'not_found' }
  else return json(400, { error: 'invalid_request' })
  if (!r.ok) {
    const status = r.error === 'not_configured' ? 503 : r.error?.startsWith('quota_') ? 429 : r.error === 'not_found' ? 404 : r.retryable ? 503 : 400
    return json(status, { error: r.error })
  }
  return json(r.creative ? 201 : 200, r.creative ? { creative: r.creative } : { ok: true })
}
