// /api/dashboard/website/assets — website images for the signed-in business.
//   GET                → { assets: [{ id, url, size }] }  (hidden photos left out)
//   GET ?usage=1       → { assets: [{ id, url, size, hidden?, usage: { draft, live, versions, history, logo } | null }] }
//   POST (raw JPEG/PNG/WebP body, ≤ 1 MB; the dashboard resizes before upload) → { asset }
//   POST JSON { action: 'delete', id }   remove a photo nothing recoverable uses (409 in_use + usage otherwise)
//             { action: 'hide' | 'show', id }  hide a photo only history uses (bytes kept) / show it again
//             { action: 'cleanup' }      remove every photo nothing recoverable uses
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { cleanupAssets, deleteAsset, hideAsset, listAssets, MAX_BYTES, saveAsset } from '../../../../server/assets.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const usage = new URL(request.url).searchParams.get('usage') === '1'
  try {
    return json(200, { assets: await listAssets(env.ONBOARDING_DB, session.customer.id, usage ? { hidden: true, usage: true } : {}) })
  } catch (err) {
    console.error('asset list failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'assetUpload', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  // JSON actions (delete / hide / show / cleanup). Uploads are raw image bytes, checked by their content, never by the
  // declared type.
  if ((request.headers.get('Content-Type') || '').startsWith('application/json')) {
    const body = await request.json().catch(() => null)
    const db = env.ONBOARDING_DB
    const id = session.customer.id
    try {
      if (body?.action === 'cleanup') return json(200, await cleanupAssets(db, id))
      let r
      if (body?.action === 'delete') r = await deleteAsset(db, id, body.id)
      else if (body?.action === 'hide' || body?.action === 'show') r = await hideAsset(db, id, body.id, body.action === 'hide')
      else return json(400, { error: 'invalid_request' })
      return r.ok ? json(200, { ok: true, ...(r.removed ? { removed: r.removed } : {}) }) : json(r.httpStatus, { error: r.error, ...(r.usage ? { usage: r.usage } : {}) })
    } catch (err) {
      console.error('asset action failed:', err?.name)
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
