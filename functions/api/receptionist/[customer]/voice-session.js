// POST /api/receptionist/:customer/voice-session — lifecycle of a running voice session (OpenAI / ElevenLabs; Retell
// ends through its own socket). Body: { action: 'transcript', id | conversationId, token, lines } appends what was
// said (text only, into the conversation the owner sees); { action: 'end', id | conversationId, token, metrics,
// outcome } closes the voice part (the conversation stays open for typing). Numbers only in metrics, codes only in
// outcome; the conversation's own token authorizes it.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { customerVoiceTranscript, endCustomerVoiceSession, loadCustomerVoiceSession } from '../../../../server/voice/customer.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  const rl = await hitByIp(env, 'receptionistVoiceSession', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  const s = await loadCustomerVoiceSession(env, customer, body?.id || body?.conversationId, body?.token)
  if (!s) return json(404, { error: 'not_found' })
  if (body.action === 'transcript') return json(200, await customerVoiceTranscript(env, s, body.lines))
  if (body.action === 'end') return json(200, await endCustomerVoiceSession(env, s, { metrics: body.metrics, outcome: body.outcome }))
  return json(400, { error: 'invalid_action' })
}
