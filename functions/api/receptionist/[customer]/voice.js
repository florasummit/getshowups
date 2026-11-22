// POST /api/receptionist/:customer/voice — start a browser voice call with the AI receptionist (Retell web call,
// created by our server; the browser only receives the call's access token).
//   Body: { conversationId?, token? } — continue the customer's chat conversation (context kept) or start a new one.
//   → { accessToken, callId, transport, iceServers, conversationId, token }
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { conversationToken, loadConversation, receptionistOn } from '../../../../server/receptionist/engine.js'
import { startVoiceCall, voiceAllowedFor, voiceConfigured } from '../../../../server/receptionist/voice.js'
import { providerSpendAllowed } from '../../../../server/business-accounts.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  for (const rl of [await hitByIp(env, 'receptionistVoice', request), await hit(env, 'receptionistVoicePerBusiness', customer.id)]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  if (!(await receptionistOn(env, customer)) || !(await providerSpendAllowed(env, customer.id))) return json(404, { error: 'receptionist_off' })
  if (!voiceConfigured(env)) return json(503, { error: 'voice_not_configured' })
  // Release gate (RECEPTIONIST_VOICE_BUSINESSES): voice is in testing for every business not listed.
  if (!voiceAllowedFor(env, customer.id)) return json(403, { error: 'voice_not_available' })
  const body = await request.json().catch(() => ({}))
  try {
    let existing = null
    if (body?.conversationId) {
      existing = await loadConversation(env, customer, String(body.conversationId), String(body.token || ''))
      if (!existing) return json(404, { error: 'conversation_not_found' })
      if (existing.state.endedAt) return json(410, { error: 'conversation_ended' })
    }
    const r = await startVoiceCall(env, customer, Date.now(), existing, body?.attribution)
    if (!r.ok) return json(502, { error: r.error })
    return json(200, { accessToken: r.accessToken, callId: r.callId, transport: r.transport, iceServers: r.iceServers, conversationId: r.conversationId, token: await conversationToken(env, r.conversationId) })
  } catch (err) {
    console.error('receptionist voice failed:', customer.id, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
