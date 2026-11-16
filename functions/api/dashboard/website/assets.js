// /api/dashboard/website/assets — website images for the signed-in business.
//   GET  → { assets: [{ id, url, size }] }
//   POST (raw JPEG/PNG/WebP body, ≤ 1 MB; the dashboard resizes before upload) → { asset }
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { cleanupAssets, deleteAsset, listAssets, MAX_BYTES, saveAsset } from '../../../../server/assets.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { assets: await listAssets(env.ONBOARDING_DB, session.customer.id) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'assetUpload', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  // JSON { action: 'delete', id }: remove a photo nothing recoverable uses (server/assets.js deleteAsset). Uploads are
  // raw image bytes, checked by their content, never by the declared type.
  if ((request.headers.get('Content-Type') || '').startsWith('application/json')) {
    const body = await request.json().catch(() => null)
    if (body?.action === 'cleanup') {
      // { action: 'cleanup' }: remove every photo nothing recoverable uses → { removed, kept, bytesFreed }.
      try {
        return json(200, await cleanupAssets(env.ONBOARDING_DB, session.customer.id))
      } catch (err) {
        console.error('asset cleanup failed:', err?.name)
        return json(503, { error: 'storage_error' })
      }
    }
    if (body?.action !== 'delete') return json(400, { error: 'invalid_request' })
    try {
      const r = await deleteAsset(env.ONBOARDING_DB, session.customer.id, body.id)
      return r.ok ? json(200, { ok: true }) : json(r.httpStatus, { error: r.error })
    } catch (err) {
      console.error('asset delete failed:', err?.name)
      return json(503, { error: 'storage_error' })
    }
  }
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return json(413, { error: 'too_large' })
  const buf = new Uint8Array(await request.arrayBuffer())
  try {
    const r = await saveAsset(env.ONBOARDING_DB, session.customer.id, buf)
    return r.ok ? json(201, { asset: r.asset }) : json(r.httpStatus, { error: r.error })
  } catch (err) {
    console.error('asset save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
