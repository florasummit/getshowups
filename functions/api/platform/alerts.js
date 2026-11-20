// GET  /api/platform/alerts — founder alert delivery status (platform admins only; read-only; counts, never addresses).
// POST /api/platform/alerts { action: 'test', confirm: true } — one labelled test email to the deliverable admins, sent
//      at once through the real outbox + launch gate + provider. Only while FOUNDER_ALERTS_ENABLED is on. Same-origin,
//      rate-limited per admin, audited. Creates no incident and touches no business.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { alertsStatus, sendTestAlert } from '../../../server/alerts.js'

const REFUSED = new Set(['alerts_disabled', 'email_not_configured', 'no_recipient', 'too_soon'])

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  return json(200, await alertsStatus(env))
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  if (body?.action !== 'test') return json(400, { error: 'invalid_action' })
  if (body?.confirm !== true) return json(400, { error: 'confirmation_required' })
  const rl = await hit(env, 'alertTest', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    const r = await sendTestAlert(env)
    if (REFUSED.has(r.error)) return json(409, { error: r.error })
    await audit(env, admin.email, 'alerts.test_sent', null, { recipients: r.recipients, sent: r.sent, errors: r.errors })
    return json(200, r)
  } catch (err) {
    console.error('test alert failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
