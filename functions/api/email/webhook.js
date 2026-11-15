// POST /api/email/webhook — Resend delivery feedback (bounces, spam complaints). Signed with Svix
// (server/email-feedback.js); 503 until RESEND_WEBHOOK_SECRET is set. Returns counts only.
import { json } from '../../../server/google-oauth.js'
import { feedbackConfigured, handleFeedback, verifySvix } from '../../../server/email-feedback.js'
import { hitByIp, tooManyJson } from '../../../server/ratelimit.js'

export async function onRequestPost({ request, env }) {
  if (!feedbackConfigured(env)) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'emailWebhook', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const raw = await request.text()
  if (raw.length > 256 * 1024) return json(413, { error: 'too_large' })
  if (!(await verifySvix(env, request.headers, raw))) return json(401, { error: 'invalid_signature' })
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return json(400, { error: 'invalid_body' })
  }
  try {
    return json(200, { ok: true, result: await handleFeedback(env, event) })
  } catch (err) {
    // 5xx → Resend retries with backoff; the handler is idempotent.
    console.error('email feedback failed:', event?.type, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
