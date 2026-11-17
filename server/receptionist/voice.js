// Voice receptionist through Retell (speech recognition, voice, turn-taking and interruptions are Retell's; the
// conversation, knowledge and tools are OURS — the same engine as website chat).
//
// Flow: the customer clicks "Talk" → our server (not the browser) creates a Retell web call for a shared GetShowUps
// agent whose response engine is a custom LLM pointing at wss://<site>/api/receptionist/llm/<RETELL_WS_SECRET> (set up
// by scripts/retell-setup.mjs). We record the call id against the business and a new voice conversation. Retell then
// connects to /api/receptionist/llm/<secret>/<call_id>; after the secret, that call id — unguessable and created by us —
// is the only thing that routes a call to a business.
//
// Protocol (docs.retellai.com/api-references/llm-websocket): Retell sends JSON text frames with interaction_type
// ping_pong | update_only | response_required | reminder_required (call_details when asked); we answer with
// response_type config | ping_pong | response { response_id, content, content_complete, end_call }. A newer
// response_id means the caller spoke again: Retell discards older responses.
import { customerFromRow } from '../auth.js'
import { getCustomer } from '../customers.js'
import { startConversation, loadConversation, respond, getSettings } from './engine.js'
import { knowledgeFor } from './knowledge.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const retellBase = (env) => (typeof env.RETELL_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.RETELL_API_MOCK_ORIGIN) ? env.RETELL_API_MOCK_ORIGIN : 'https://api.retellai.com')
// Voice needs the Retell key, our agent, and the socket secret the agent's URL carries.
export const voiceConfigured = (env) => Boolean(env.RETELL_API_KEY && /^agent_[A-Za-z0-9]{6,80}$/.test(env.RETELL_AGENT_ID || '') && String(env.RETELL_WS_SECRET || '').length >= 32)
const CALL_TTL_MS = 60 * 60 * 1000

// → { ok, accessToken, callId, conversationId } | { ok: false, error }. `existing`: the customer's current chat
// conversation (already verified by its token) — the call continues it, so nothing they said is lost.
export async function startVoiceCall(env, customer, now = Date.now(), existing = null, attribution = null) {
  if (!voiceConfigured(env)) return { ok: false, error: 'voice_not_configured' }
  const conv = existing && !existing.state?.endedAt ? { id: existing.id } : await startConversation(env, customer, 'voice', now, { attribution })
  let res
  try {
    res = await fetch(`${retellBase(env)}/v3/create-web-call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      // 'latest' = the agent's newest version, draft included (we never publish automatically); override with
      // RETELL_AGENT_VERSION (e.g. 'latest_published' or a version number) once a version is published.
      body: JSON.stringify({ agent_id: env.RETELL_AGENT_ID, agent_version: /^(latest|latest_published|\d{1,6})$/.test(env.RETELL_AGENT_VERSION || '') ? (/^\d+$/.test(env.RETELL_AGENT_VERSION) ? Number(env.RETELL_AGENT_VERSION) : env.RETELL_AGENT_VERSION) : 'latest', metadata: { business: customer.id, conversation: conv.id } }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false, error: 'voice_unreachable' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || typeof body.call_id !== 'string' || typeof body.access_token !== 'string') return { ok: false, error: res.status === 402 ? 'voice_billing' : `voice_http_${res.status}` }
  await env.ONBOARDING_DB.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES (?1, ?2, ?3, 'retell', ?4)")
    .bind(body.call_id.slice(0, 80), customer.id, conv.id, now)
    .run()
  return {
    ok: true,
    accessToken: body.access_token,
    callId: body.call_id,
    conversationId: conv.id,
    transport: typeof body.transport === 'string' ? body.transport : undefined,
    iceServers: Array.isArray(body.ice_servers) ? body.ice_servers : undefined,
  }
}

// The caller's words since the agent last spoke (Retell sends the whole transcript every time).
export function latestUserText(transcript) {
  const t = Array.isArray(transcript) ? transcript : []
  let i = t.length - 1
  const parts = []
  while (i >= 0 && t[i]?.role === 'user') parts.unshift(String(t[i--].content || ''))
  return parts.join(' ').trim()
}

// Handles one Retell LLM WebSocket for callId. `ws` is the server side of a WebSocketPair (already accepted).
export async function attachRetellSocket(env, ws, callId, now = Date.now()) {
  const send = (o) => {
    try {
      ws.send(JSON.stringify(o))
    } catch {}
  }
  const db = env.ONBOARDING_DB
  const call = /^[A-Za-z0-9_-]{8,80}$/.test(callId || '') ? await db.prepare('SELECT * FROM receptionist_calls WHERE call_id = ?1').bind(callId).first() : null
  if (!call || call.ended_at || now - call.created_at > CALL_TTL_MS) {
    ws.close(1008, 'unknown call')
    return false
  }
  const customer = customerFromRow(await getCustomer(db, call.customer))
  if (!customer || customer.status !== 'active') {
    ws.close(1008, 'unavailable')
    return false
  }
  const settings = await getSettings(db, customer.id)
  const k = await knowledgeFor(env, customer, settings)
  const start = await loadConversation(env, customer, call.conversation_id)
  send({ response_type: 'config', config: { auto_reconnect: true, call_details: false } })
  // Begin message (response_id 0): continuing a chat → no second greeting; otherwise the owner's greeting.
  const continuing = (start?.state?.log || []).length > 0
  send({ response_type: 'response', response_id: 0, content: continuing ? 'Hi, I’m here. Go ahead whenever you’re ready.' : k.greeting || `Thanks for calling ${customer.name}. How can I help you today?`, content_complete: true, end_call: false })

  let latest = 0
  let busy = Promise.resolve()
  const say = (id, content, last = true) => send({ response_type: 'response', response_id: id, content, content_complete: last, end_call: false })
  ws.addEventListener('message', (evt) => {
    let msg
    try {
      msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '')
    } catch {
      return
    }
    if (msg.interaction_type === 'ping_pong') return send({ response_type: 'ping_pong', timestamp: msg.timestamp })
    if (msg.interaction_type !== 'response_required' && msg.interaction_type !== 'reminder_required') return
    const id = Number(msg.response_id)
    latest = Math.max(latest, id)
    // One turn at a time. A turn the caller has already talked over (newer response_id) is skipped before it starts,
    // and dropped mid-way unless it acted — Retell discards that answer, so it must not enter the history either.
    busy = busy.then(async () => {
      if (id < latest) return
      if (msg.interaction_type === 'reminder_required') return say(id, 'Take your time, I’m still here. You can also type in the chat if that’s easier.')
      const text = latestUserText(msg.transcript)
      if (!text) return say(id, 'Sorry, I didn’t catch that. Could you say it again?')
      for (let attempt = 0; attempt < 2; attempt++) {
        const conv = await loadConversation(env, customer, call.conversation_id)
        if (!conv) return send({ response_type: 'response', response_id: id, content: 'Sorry, something went wrong on our side.', content_complete: true, end_call: true })
        if (conv.state.endedAt) return send({ response_type: 'response', response_id: id, content: 'This conversation has ended. Thanks for calling!', content_complete: true, end_call: true })
        let spoke = false
        const r = await respond(env, customer, conv, text, { channel: 'voice', onText: (s) => ((spoke = true), say(id, s, false)), isStale: () => latest > id }).catch(() => ({ ok: false, error: 'failed' }))
        if (r.error === 'stale') return
        if (r.error === 'busy' && attempt === 0 && !spoke) continue // a typed message landed at the same moment: retry once on the fresh record
        if (!r.ok && !spoke) return say(id, 'Sorry, give me a moment and try that again.')
        return say(id, '', true)
      }
    })
  })
  ws.addEventListener('close', () => {
    db.prepare('UPDATE receptionist_calls SET ended_at = ?2 WHERE call_id = ?1 AND ended_at IS NULL').bind(callId, Date.now()).run().catch(() => {})
  })
  return true
}
