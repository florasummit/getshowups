// POST /api/receptionist/:customer/voice-tool — the ONLY way a provider-hosted voice model acts: the browser forwards
// the provider's function call here with the caller's latest transcribed words; our server runs the engine's tool
// bound to THIS conversation's business with every guard (dry-run for admin test sessions, real for customers) and
// answers with exactly what the model is told. Body: { id | conversationId, token, name, input, userText }.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { VOICE_TOOL_NAMES } from '../../../../server/voice/tools.js'
import { customerVoiceTool, loadCustomerVoiceSession } from '../../../../server/voice/customer.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  const rl = await hitByIp(env, 'receptionistVoiceTool', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  if (!VOICE_TOOL_NAMES.includes(body?.name)) return json(400, { error: 'unknown_tool' })
  const s = await loadCustomerVoiceSession(env, customer, body?.id || body?.conversationId, body?.token)
  if (!s) return json(404, { error: 'not_found' })
  const result = await customerVoiceTool(env, s, body.name, body.input && typeof body.input === 'object' ? body.input : {}, typeof body.userText === 'string' ? body.userText : '')
  return json(200, { result })
}
