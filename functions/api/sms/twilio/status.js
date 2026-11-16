// POST /api/sms/twilio/status?m=<message id>.<signed token> — Twilio delivery updates for one of our texts.
// Signature-checked AND the per-message signed token must match; only forward progress is recorded.
import { verifyTwilio } from '../../../../server/followups/transport.js'
import { deliveryUpdate } from '../../../../server/followups/engine.js'
import { hitByIp } from '../../../../server/ratelimit.js'

export async function onRequestPost({ request, env }) {
  if (!env.TWILIO_AUTH_TOKEN || !env.ONBOARDING_DB) return new Response('Not configured', { status: 503 })
  const rl = await hitByIp(env, 'smsWebhook', request)
  if (rl.limited) return new Response('Too many requests', { status: 429 })
  const params = new URLSearchParams(await request.text())
  if (!(await verifyTwilio(env, request, params))) return new Response('Forbidden', { status: 403 })
  const r = await deliveryUpdate(env, new URL(request.url).searchParams.get('m'), params)
  return new Response(null, { status: r.ok ? 204 : r.httpStatus || 400 })
}
