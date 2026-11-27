// GET /api/platform/qa/evidence/<id> — a screenshot's bytes (sniffed type, no-store, nosniff, never framed by others)
// or a text evidence record as JSON; 410 after retention cleared it. Platform admins only.
import { json } from '../../../../../server/google-oauth.js'
import { qaGet } from '../../../../../server/ops/qa-route.js'
import { getEvidence, present } from '../../../../../server/ops/qa-evidence.js'

export const onRequestGet = qaGet(async ({ env, params }) => {
  const e = await getEvidence(env.ONBOARDING_DB, String(params?.id || ''))
  if (!e) return json(404, { error: 'not_found' })
  if (e.kind !== 'screenshot') return json(200, { evidence: present(e) })
  if (!e.data) return json(410, { error: 'purged' })
  const bin = atob(e.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Response(bytes, { status: 200, headers: { 'Content-Type': e.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'", 'Referrer-Policy': 'no-referrer' } })
})
