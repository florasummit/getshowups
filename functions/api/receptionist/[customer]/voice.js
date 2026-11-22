// POST /api/receptionist/:customer/voice — start a browser voice session with the AI receptionist on the business's
// ACTIVE provider (server/voice/customer.js; the provider is decided server-side from receptionist_voice_settings,
// never by the browser). The browser receives only what it needs to connect (a Retell access token, a short-lived
// OpenAI client secret, or an ElevenLabs signed URL); our provider keys never leave the server.
//   Body: { conversationId?, token?, attribution?, test?: { provider, voiceId? } }
//         conversationId/token continue the customer's chat conversation (context kept) or a new one starts.
//         test: a platform admin (signed in) testing a candidate provider on an admin-marked TEST business — dry-run
//         tools, never for customers; anyone else gets 403.
//   → { provider, conversationId, token, ...connection }  (retell: accessToken, callId, transport, iceServers;
//      openai: clientSecret, expiresAt, sessionConfig, greeting; elevenlabs: signedUrl, expiresAt, overrides,
//      dynamicVariables, clientTools)
import { json } from '../../../../server/google-oauth.js'
import { bookableCustomer } from '../../../../server/public.js'
import { getSession } from '../../../../server/auth.js'
import { hit, hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { loadConversation, receptionistOn } from '../../../../server/receptionist/engine.js'
import { providerSpendAllowed } from '../../../../server/business-accounts.js'
import { startCustomerVoiceSession, testOverrideAllowed } from '../../../../server/voice/customer.js'
import { PROVIDERS } from '../../../../server/voice/providers.js'
import { catalogFor } from '../../../../server/voice/catalog.js'

export async function onRequestPost({ request, env, params }) {
  const { customer, response } = await bookableCustomer(env, params, { write: true, request })
  if (response) return response
  for (const rl of [await hitByIp(env, 'receptionistVoice', request), await hit(env, 'receptionistVoicePerBusiness', customer.id)]) {
    if (rl.limited) return tooManyJson(rl.retryAfter)
  }
  const body = await request.json().catch(() => ({}))
  let test = null
  if (body?.test && typeof body.test === 'object') {
    // Admin test of a candidate provider on the customer path: the signed-in platform admin, a test business.
    let session = null
    try {
      session = await getSession(request, env)
    } catch {
      session = null
    }
    const allowed = session ? await testOverrideAllowed(env, customer, session.email) : { ok: false, error: 'test_not_allowed' }
    if (!allowed.ok) return json(403, { error: allowed.error })
    const provider = String(body.test.provider || '')
    if (!PROVIDERS.includes(provider)) return json(400, { error: 'invalid_provider' })
    let voiceId = ''
    if (typeof body.test.voiceId === 'string' && body.test.voiceId) {
      const c = await catalogFor(env, provider)
      if (!c.voices.some((v) => v.id === body.test.voiceId)) return json(400, { error: 'voice_unknown' })
      voiceId = body.test.voiceId
    }
    test = { provider, voiceId, admin: allowed.admin }
  } else {
    // Customers: the receptionist must be on and the business allowed to spend on providers.
    if (!(await receptionistOn(env, customer)) || !(await providerSpendAllowed(env, customer.id))) return json(404, { error: 'receptionist_off' })
  }
  try {
    let existing = null
    if (body?.conversationId) {
      existing = await loadConversation(env, customer, String(body.conversationId), String(body.token || ''))
      if (!existing) return json(404, { error: 'conversation_not_found' })
      if (existing.state.endedAt) return json(410, { error: 'conversation_ended' })
    }
    const r = await startCustomerVoiceSession(env, customer, { existing, attribution: body?.attribution, test }, Date.now())
    if (!r.ok) return json(r.httpStatus || 502, { error: r.error })
    const { ok: _ok, ...payload } = r
    return json(200, { ...payload, ...(test ? { test: true } : {}) })
  } catch (err) {
    console.error('receptionist voice failed:', customer.id, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
