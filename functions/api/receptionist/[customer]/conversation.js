// /api/receptionist/:customer/conversation — the customer's OWN conversation (signed token required).
//   POST { action: 'view', conversationId, token } → { transcript (what they saw/heard, incl. voice), status, ended, booked, request }
//   POST { action: 'end',  conversationId, token } → ends it (no more turns; the page starts a clean one)
// POST for both so the token never lands in a URL or log. Same-origin; rate-limited.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { endConversation, loadConversation, publicState, visibleTranscript } from '../../../../server/receptionist/engine.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  const rl = await hitByIp(env, 'receptionistChat', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  if (!['view', 'end'].includes(body?.action)) return json(400, { error: 'invalid_request' })
  try {
    const conv = await loadConversation(env, customer, String(body.conversationId || ''), String(body.token || ''))
    if (!conv) return json(404, { error: 'conversation_not_found' })
    if (body.action === 'end') await endConversation(env, customer, conv)
    return json(200, { conversationId: conv.id, transcript: visibleTranscript(conv.transcript, conv.state).map(({ who, text, channel }) => ({ who, text, channel })), ...publicState(conv, customer) })
  } catch (err) {
    console.error('receptionist conversation failed:', customer.id, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
