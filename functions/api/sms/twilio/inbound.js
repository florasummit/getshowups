// POST /api/sms/twilio/inbound — Twilio "A message comes in" webhook for every business sender.
// Signature-checked (X-Twilio-Signature with TWILIO_AUTH_TOKEN), rate-limited per IP before the check, idempotent per
// MessageSid (a repeated webhook records nothing new and sends nothing). Answers are sent separately (never in the
// webhook response), so the reply path has the same checks as every other text. Responds with empty TwiML.
import { verifyTwilio } from '../../../../server/followups/transport.js'
import { handleInbound, processReplies, sendQueued } from '../../../../server/followups/engine.js'
import { hitByIp } from '../../../../server/ratelimit.js'
import { recordEvent } from '../../../../server/auditlog.js'

const twiml = (status = 200) => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status, headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' } })

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.TWILIO_AUTH_TOKEN || !env.ONBOARDING_DB) return new Response('Not configured', { status: 503 })
  const rl = await hitByIp(env, 'smsWebhook', request)
  if (rl.limited) return new Response('Too many requests', { status: 429 })
  const params = new URLSearchParams(await request.text())
  if (!(await verifyTwilio(env, request, params))) {
    await recordEvent(env.ONBOARDING_DB, { type: 'sms.webhook_rejected', actor: 'system:twilio', capability: 'followups.sms_inbound', resource: { type: 'webhook', id: 'inbound' }, outcome: 'failure', details: { reason: 'bad_signature' } })
    return new Response('Forbidden', { status: 403 })
  }
  const r = await handleInbound(env, { from: params.get('From'), to: params.get('To'), body: params.get('Body') || '', providerId: params.get('MessageSid'), messagingService: params.get('MessagingServiceSid') })
  if (!r.ok) return new Response('Unavailable', { status: 503 }) // Twilio retries; the MessageSid keeps it idempotent
  // Answer now (in the background); the 5-minute cron is the safety net.
  if (r.action && r.action !== 'duplicate') {
    const work = (async () => {
      await processReplies(env)
      await sendQueued(env)
    })().catch(() => {})
    if (typeof waitUntil === 'function') waitUntil(work)
    else await work
  }
  return twiml()
}
