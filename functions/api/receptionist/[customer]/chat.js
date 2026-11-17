// POST /api/receptionist/:customer/chat — one customer message to the AI receptionist (website chat).
//   Body: { text, conversationId?, token? }  → { conversationId, token, reply, status, booked, handoff }
// Same-origin; rate-limited per IP and per business; the conversation token (signed) is required to continue one.
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { linkToken } from '../../../../server/links.js'
import { loadConversation, receptionistOn, respond, startConversation } from '../../../../server/receptionist/engine.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  for (const rl of [await hitByIp(env, 'receptionistChat', request), await hit(env, 'receptionistPerBusiness', customer.id)]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  if (!(await receptionistOn(env, customer))) return json(404, { error: 'receptionist_off' })
  const body = await request.json().catch(() => ({}))
  const text = String(body?.text || '').trim()
  if (!text || text.length > 1500) return json(400, { error: 'invalid_message' })
  try {
    let conv
    let token = body.token
    if (body.conversationId) {
      conv = await loadConversation(env, customer, String(body.conversationId), String(body.token || ''))
      if (!conv) return json(404, { error: 'conversation_not_found' })
    } else {
      const c = await startConversation(env, customer, 'chat')
      token = c.token
      conv = await loadConversation(env, customer, c.id)
    }
    const r = await respond(env, customer, conv, text)
    if (!r.ok) return json(r.error === 'busy' ? 409 : 400, { error: r.error })
    return json(200, { conversationId: conv.id, token: token || (await linkToken(env, 'receptionist', conv.id)), reply: r.reply, status: r.status, booked: r.booked, handoff: r.handoff })
  } catch (err) {
    console.error('receptionist chat failed:', customer.id, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
