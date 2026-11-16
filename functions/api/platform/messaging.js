// /api/platform/messaging — platform admin (PLATFORM_ADMIN_EMAILS) view of follow-ups and texting.
//   GET  → counts only (failures, stuck work, webhook problems, spikes, volume/cost per business, registrations)
//   GET ?customer=<id> → that business's Twilio provisioning state (steps, statuses; no personal data, no secrets)
//   POST { customer, status?, note?, messagingService?, senderPhone?, confirm: true } → record what the PROVIDER
//        reported for a business's texting registration and/or its provisioned sender (manual fallback).
//   POST { customer, action: 'provision', step, approve?, areaCode?, confirm: true } → run ONE Twilio step in the
//        business's own subaccount (server/followups/provisioning.js). Submitting/charging steps also need
//        TWILIO_REGISTRATION_SUBMIT=true and approve: true.
//   POST { customer, action: 'sync' | 'resend_otp' | 'usage' | 'clear_unknown' (kind), confirm: true }
//   Same-origin, every write audited.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { followupOps } from '../../../server/followups/ops.js'
import { followupsReady } from '../../../server/followups/settings.js'
import { recordProviderStatus } from '../../../server/followups/registration.js'
import { clearUnknown, provisioningState, resendOtp, runStep, syncRegistration } from '../../../server/followups/provisioning.js'
import { syncUsage } from '../../../server/followups/twilio.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    const one = String(new URL(request.url).searchParams.get('customer') || '').toLowerCase()
    if (one) return CUSTOMER_RE.test(one) ? json(200, { provisioning: await provisioningState(env, one) }) : json(400, { error: 'invalid_request' })
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
  const action = body.action
  if (action) {
    let r
    try {
      if (action === 'provision') r = await runStep(env, customer, String(body.step || ''), { approve: body.approve === true, areaCode: body.areaCode })
      else if (action === 'sync') r = await syncRegistration(env, customer)
      else if (action === 'resend_otp') r = await resendOtp(env, customer)
      else if (action === 'usage') r = await syncUsage(env, customer)
      else if (action === 'clear_unknown') r = await clearUnknown(env, customer, body.kind)
      else return json(400, { error: 'invalid_request' })
    } catch (err) {
      console.error('platform messaging action failed:', err?.name)
      r = { ok: false, httpStatus: 503, error: 'storage_error' }
    }
    await audit(env, admin.email, `sms.${action}`, customer, { step: action === 'provision' ? String(body.step || '').slice(0, 40) : undefined, approved: body.approve === true || undefined, kind: action === 'clear_unknown' ? String(body.kind || '').slice(0, 60) : undefined, ok: r.ok, error: r.ok ? undefined : r.error })
    if (!r.ok) return json(r.httpStatus || 409, { error: r.error })
    return json(200, { ...r, provisioning: await provisioningState(env, customer) })
  }
  const pick = (k) => (Object.hasOwn(body, k) ? (body[k] === '' ? null : body[k]) : undefined)
  const r = await recordProviderStatus(env.ONBOARDING_DB, customer, { status: pick('status') ?? undefined, note: body.note || '', messagingService: pick('messagingService'), senderPhone: pick('senderPhone') }, admin.email)
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  await audit(env, admin.email, 'sms.registration_status', customer, { status: body.status ?? null, sender: pick('messagingService') !== undefined || pick('senderPhone') !== undefined })
  return json(200, { ok: true })
}
