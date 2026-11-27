// POST /api/phone/twilio/<step>: Twilio voice webhooks for business lines (server/telephony/calls.js).
// Rate-limited per IP before the signature check; X-Twilio-Signature verified with the subaccount's token, which also names
// the business (accountCustomer). A request signed by the parent account routes nowhere. Codes only in logs/events.
import { verifyTwilio } from '../../../../server/followups/transport.js'
import { hitByIp } from '../../../../server/ratelimit.js'
import { recordEvent } from '../../../../server/auditlog.js'
import { phoneReady } from '../../../../server/telephony/lines.js'
import { aiResult, callStatus, dialResult, incomingCall, screenCall, verifyStep } from '../../../../server/telephony/calls.js'
import { hangup, twiml } from '../../../../server/telephony/twiml.js'

const STEPS = new Set(['voice', 'screen', 'dial', 'ai', 'status', 'verify'])

export async function onRequestPost({ request, env, params }) {
  const step = String(params.step || '')
  if (!STEPS.has(step)) return new Response('Not found', { status: 404 })
  if (!env.TWILIO_AUTH_TOKEN || !env.ONBOARDING_DB || !(await phoneReady(env.ONBOARDING_DB))) return new Response('Not configured', { status: 503 })
  const rl = await hitByIp(env, 'phoneWebhook', request)
  if (rl.limited) return new Response('Too many requests', { status: 429 })
  const p = new URLSearchParams(await request.text())
  const v = await verifyTwilio(env, request, p)
  if (!v.ok || !v.customer) {
    const unsigned = v.reason === 'unsigned'
    await recordEvent(env.ONBOARDING_DB, { type: 'phone.webhook_rejected', actor: 'system:twilio', capability: 'phone.calls', resource: { type: 'webhook', id: step }, outcome: unsigned ? 'info' : 'failure', details: { reason: v.ok ? 'parent_account' : v.reason || 'bad_signature' } })
    return new Response('Forbidden', { status: 403 })
  }
  const url = new URL(request.url)
  const ctx = { accountCustomer: v.customer, origin: url.origin }
  try {
    if (step === 'voice') return await incomingCall(env, p, ctx)
    if (step === 'screen') return await screenCall(env, p, url, ctx)
    if (step === 'dial') return await dialResult(env, p, url, ctx)
    if (step === 'ai') return await aiResult(env, p, url, ctx)
    if (step === 'verify') return await verifyStep(env, p, url, ctx)
    await callStatus(env, p, ctx)
    return new Response('', { status: 204 })
  } catch (err) {
    console.error('phone webhook failed:', step, err?.name || 'error')
    await recordEvent(env.ONBOARDING_DB, { type: 'phone.webhook_failed', actor: 'system:twilio', customer: v.customer, capability: 'phone.calls', resource: { type: 'webhook', id: step }, outcome: 'failure' }).catch(() => {})
    // A caller is never left in silence: status callbacks may be retried; voice steps end politely.
    return step === 'status' ? new Response('Unavailable', { status: 503 }) : twiml('<Say voice="Polly.Joanna">Sorry, something went wrong. Please call again.</Say>', hangup())
  }
}
