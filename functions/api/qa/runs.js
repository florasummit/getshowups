// POST /api/qa/runs — store one automated test run (scripts/qa-report.mjs, from CI or a local run).
// Auth: Authorization: Bearer <QA_INGEST_TOKEN> (32+ chars; unset = 503, the endpoint is off). Rate-limited per IP.
// Stores only registry-linked tests + failures, redacted and bounded (server/ops/qa.js). Returns counts only.
import { json, sha256Hex, timingSafeEqual } from '../../../server/google-oauth.js'
import { hitByIp, tooManyJson } from '../../../server/ratelimit.js'
import { ingestAutomatedRun, qaReady } from '../../../server/ops/qa.js'

const MAX_BYTES = 2_000_000

export async function onRequestPost({ request, env }) {
  if (!env.ONBOARDING_DB || !env.QA_INGEST_TOKEN || env.QA_INGEST_TOKEN.length < 32) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'qaIngest', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const header = request.headers.get('Authorization') || ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!presented || !timingSafeEqual(await sha256Hex(presented), await sha256Hex(env.QA_INGEST_TOKEN))) return json(401, { error: 'unauthorized' })
  if (!(await qaReady(env.ONBOARDING_DB))) return json(503, { error: 'not_available' })
  // Size is checked on the bytes actually received (a missing or false Content-Length doesn't bypass it).
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return json(413, { error: 'too_large' })
  const raw = await request.text().catch(() => '')
  if (raw.length > MAX_BYTES) return json(413, { error: 'too_large' })
  let body = null
  try {
    body = JSON.parse(raw)
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  try {
    const r = await ingestAutomatedRun(env.ONBOARDING_DB, body, Date.now(), { bodyHash: await sha256Hex(raw) })
    if (r.error) return json(400, { error: r.error })
    return json(r.duplicate ? 200 : 201, r)
  } catch (err) {
    console.error('qa ingest failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
