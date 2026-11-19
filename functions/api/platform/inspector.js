// Account Inspector (platform admins only).
//   GET  /api/platform/inspector?business=<id>         → account, journey, readiness, incidents, history (read-only)
//   POST /api/platform/inspector { business, check: 'calendar' }
//        → read-only calendar diagnosis (token refresh + freeBusy count; nothing stored or changed at Google).
//          Same-origin, rate-limited per business, audited. Codes and counts only.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { diagnoseCalendar, inspectAccount } from '../../../server/ops/inspector.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const id = String(new URL(request.url).searchParams.get('business') || '').toLowerCase()
  if (!CUSTOMER_RE.test(id)) return json(400, { error: 'invalid_customer' })
  try {
    const r = await inspectAccount(env, id)
    return r ? json(200, r) : json(404, { error: 'not_found' })
  } catch (err) {
    console.error('inspector failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const id = String(body?.business || '').toLowerCase()
  if (!CUSTOMER_RE.test(id)) return json(400, { error: 'invalid_customer' })
  if (body?.check !== 'calendar') return json(400, { error: 'invalid_check' })
  const rl = await hit(env, 'supportDiagnose', id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    const r = await diagnoseCalendar(env, id)
    if (!r) return json(404, { error: 'not_found' })
    await audit(env, admin.email, 'support.diagnose_calendar', id, { code: r.code })
    return json(200, r)
  } catch (err) {
    console.error('diagnose failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
