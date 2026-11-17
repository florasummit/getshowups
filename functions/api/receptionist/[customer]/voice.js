// POST /api/receptionist/:customer/voice — start a browser voice call with the AI receptionist (Retell web call,
// created by our server; the browser only receives the call's access token).  → { accessToken, conversationId }
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { receptionistOn } from '../../../../server/receptionist/engine.js'
import { startVoiceCall, voiceConfigured } from '../../../../server/receptionist/voice.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  for (const rl of [await hitByIp(env, 'receptionistVoice', request), await hit(env, 'receptionistVoicePerBusiness', customer.id)]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  if (!(await receptionistOn(env, customer))) return json(404, { error: 'receptionist_off' })
  if (!voiceConfigured(env)) return json(503, { error: 'voice_not_configured' })
  try {
    const r = await startVoiceCall(env, customer)
    if (!r.ok) return json(502, { error: r.error })
    return json(200, { accessToken: r.accessToken, callId: r.callId, transport: r.transport, iceServers: r.iceServers, conversationId: r.conversationId })
  } catch (err) {
    console.error('receptionist voice failed:', customer.id, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
