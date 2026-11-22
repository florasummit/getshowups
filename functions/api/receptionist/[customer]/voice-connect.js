// POST /api/receptionist/:customer/voice-connect — reconnect a running voice session (OpenAI: a fresh short-lived
// client secret; ElevenLabs: a fresh signed URL), pinned to the provider the session started with, at most three
// connections per session. Body: { id | conversationId, token } (the conversation's own token authorizes it).
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { loadCustomerVoiceSession, reconnectCustomerVoiceSession } from '../../../../server/voice/customer.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  const rl = await hitByIp(env, 'receptionistVoiceConnect', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  const s = await loadCustomerVoiceSession(env, customer, body?.id || body?.conversationId, body?.token)
  if (!s) return json(404, { error: 'not_found' })
  const r = await reconnectCustomerVoiceSession(env, s)
  if (!r.ok) return json(r.httpStatus || 502, { error: r.error })
  const { ok: _ok, ...payload } = r
  return json(200, payload)
}
