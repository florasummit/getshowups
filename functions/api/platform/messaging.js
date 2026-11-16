// /api/platform/messaging — platform admin (PLATFORM_ADMIN_EMAILS) view of follow-ups and texting.
//   GET  → counts only (failures, stuck work, webhook problems, spikes, volume/cost per business, registrations)
//   POST { customer, status?, note?, messagingService?, senderPhone?, confirm: true } → record what the PROVIDER
//        reported for a business's texting registration and/or its provisioned sender. Same-origin, audited.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { followupOps } from '../../../server/followups/ops.js'
import { followupsReady } from '../../../server/followups/settings.js'
import { recordProviderStatus } from '../../../server/followups/registration.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    return json(200, await followupOps(env))
  } catch (err) {
    console.error('platform messaging failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!(await followupsReady(env.ONBOARDING_DB))) return json(409, { error: 'not_ready' })
  const body = await request.json().catch(() => ({}))
  const customer = String(body?.customer || '').toLowerCase()
  if (!CUSTOMER_RE.test(customer) || body?.confirm !== true) return json(400, { error: 'invalid_request' })
  const pick = (k) => (Object.hasOwn(body, k) ? (body[k] === '' ? null : body[k]) : undefined)
  const r = await recordProviderStatus(env.ONBOARDING_DB, customer, { status: pick('status') ?? undefined, note: body.note || '', messagingService: pick('messagingService'), senderPhone: pick('senderPhone') }, admin.email)
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  await audit(env, admin.email, 'sms.registration_status', customer, { status: body.status ?? null, sender: pick('messagingService') !== undefined || pick('senderPhone') !== undefined })
  return json(200, { ok: true })
}
