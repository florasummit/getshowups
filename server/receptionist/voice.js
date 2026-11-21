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
import { CUSTOMER_RE } from '../invites.js'
import { getCustomer } from '../customers.js'
import { startConversation, loadConversation, respond, getSettings } from './engine.js'
import { knowledgeFor } from './knowledge.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const retellBase = (env) => (typeof env.RETELL_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.RETELL_API_MOCK_ORIGIN) ? env.RETELL_API_MOCK_ORIGIN : 'https://api.retellai.com')
// Voice needs the Retell key, our agent, and the socket secret the agent's URL carries.
export const voiceConfigured = (env) => Boolean(env.RETELL_API_KEY && /^agent_[A-Za-z0-9]{6,80}$/.test(env.RETELL_AGENT_ID || '') && String(env.RETELL_WS_SECRET || '').length >= 32)

// Voice release gate (owner decision 2026-11-19: voice reliability is a launch blocker). Voice is offered ONLY to the
// businesses listed in RECEPTIONIST_VOICE_BUSINESSES (comma-separated ids, no wildcard; empty/unset = nobody), parsed
// like ADS_BUSINESSES. Chat is not affected. Fails closed. Nothing stored changes: there is no per-business voice
// setting; this gate only decides whether voice is offered.
export const voiceBusinesses = (env) =>
  String(env?.RECEPTIONIST_VOICE_BUSINESSES || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => CUSTOMER_RE.test(s))
export const voiceAllowedFor = (env, customerId) => typeof customerId === 'string' && CUSTOMER_RE.test(customerId) && voiceBusinesses(env).includes(customerId)
// 'available' | 'testing' (voice exists but not released for this business) | 'not_configured'
export const voiceStatus = (env, customerId) => (!voiceConfigured(env) ? 'not_configured' : voiceAllowedFor(env, customerId) ? 'available' : 'testing')
const CALL_TTL_MS = 60 * 60 * 1000

// → { ok, accessToken, callId, conversationId } | { ok: false, error }. `existing`: the customer's current chat
// conversation (already verified by its token) — the call continues it, so nothing they said is lost.
export async function startVoiceCall(env, customer, now = Date.now(), existing = null, attribution = null) {
  if (!voiceConfigured(env)) return { ok: false, error: 'voice_not_configured' }
  if (!voiceAllowedFor(env, customer.id)) return { ok: false, error: 'voice_not_available' }
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

// The caller's words for this turn. `pending` = words of an earlier turn that was talked over and dropped (never
// saved): when an agent line (e.g. the holding line) was heard in between, latestUserText alone would lose them.
export function turnText(transcript, pending = '') {
  const latest = latestUserText(transcript)
  const p = String(pending || '').trim()
  if (!p || latest.startsWith(p)) return latest
  return `${p} ${latest}`.trim()
}

// A closed socket is not an ended call: with auto_reconnect Retell closes and reconnects (up to twice) when pings stop
// for 5 s. The same call may reconnect within this window; after it (or once the conversation ended) it may not.
export const RECONNECT_MS = 2 * 60 * 1000
const REMINDER = 'Take your time, I’m still here. You can also type in the chat if that’s easier.'
const RETRY_LINE = 'Sorry, give me a moment and try that again.'

// Handles one Retell LLM WebSocket for callId. `ws` is the server side of a WebSocketPair (already accepted).
// clock: test hook for the per-turn timings (numbers only, recorded as receptionist_events 'voice_turn').
export async function attachRetellSocket(env, ws, callId, now = Date.now(), { clock = Date.now } = {}) {
  const send = (o) => {
    try {
      ws.send(JSON.stringify(o))
    } catch {}
  }
  const db = env.ONBOARDING_DB
  const call = /^[A-Za-z0-9_-]{8,80}$/.test(callId || '') ? await db.prepare('SELECT * FROM receptionist_calls WHERE call_id = ?1').bind(callId).first() : null
  if (!call || now - call.created_at > CALL_TTL_MS || (call.ended_at && now - call.ended_at > RECONNECT_MS)) {
    ws.close(1008, 'unknown call')
    return false
  }
  const customer = customerFromRow(await getCustomer(db, call.customer))
  if (!customer || customer.status !== 'active' || !voiceAllowedFor(env, customer.id)) {
    ws.close(1008, 'unavailable')
    return false
  }
  const settings = await getSettings(db, customer.id)
  const k = await knowledgeFor(env, customer, settings)
  const start = await loadConversation(env, customer, call.conversation_id)
  const reconnect = Boolean(call.ended_at)
  const ev = (kind, ok, detail) => (start ? db.prepare('INSERT INTO receptionist_events (customer, conversation_id, kind, ok, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(customer.id, start.id, kind, ok ? 1 : 0, detail, clock()).run().catch(() => {}) : Promise.resolve())
  if (reconnect) {
    if (!start || start.state?.endedAt) {
      ws.close(1008, 'unknown call')
      return false
    }
    await db.prepare('UPDATE receptionist_calls SET ended_at = NULL WHERE call_id = ?1').bind(callId).run()
    await ev('voice_socket', true, 'reconnected')
  }
  send({ response_type: 'config', config: { auto_reconnect: true, call_details: false } })
  // Begin message (response_id 0) on the first connection only: a reconnect mid-call must not greet again.
  // Continuing a chat → no second greeting; otherwise the owner's greeting.
  if (!reconnect) {
    const continuing = (start?.state?.log || []).length > 0
    send({ response_type: 'response', response_id: 0, content: continuing ? 'Hi, I’m here. Go ahead whenever you’re ready.' : k.greeting || `Thanks for calling ${customer.name}. How can I help you today?`, content_complete: true, end_call: false })
  }

  let latest = 0 // newest response_id seen
  let inflight = null // the turn generating right now: { id, controller }
  let pending = '' // words of a talked-over turn that was dropped (not saved yet)
  let queue = Promise.resolve()
  const say = (id, content, last = true) => send({ response_type: 'response', response_id: id, content, content_complete: last, end_call: false })

  async function runTurn(msg, turn) {
    const { id } = turn
    if (id < latest) return // talked over before it started
    inflight = turn
    const t = { started: clock(), firstChunk: null }
    const sayT = (content, last) => {
      if (t.firstChunk === null && content) t.firstChunk = clock()
      say(id, content, last)
    }
    try {
      if (msg.interaction_type === 'reminder_required') return sayT(REMINDER, true)
      const text = turnText(msg.transcript, pending)
      if (!text) return sayT('Sorry, I didn’t catch that. Could you say it again?', true)
      for (let attempt = 0; attempt < 2; attempt++) {
        const conv = await loadConversation(env, customer, call.conversation_id)
        if (!conv) return send({ response_type: 'response', response_id: id, content: 'Sorry, something went wrong on our side.', content_complete: true, end_call: true })
        if (conv.state.endedAt) return send({ response_type: 'response', response_id: id, content: 'This conversation has ended. Thanks for calling!', content_complete: true, end_call: true })
        let spoke = false
        const timing = {}
        const r = await respond(env, customer, conv, text, { channel: 'voice', onText: (s) => ((spoke = true), sayT(s, false)), isStale: () => latest > id, signal: turn.controller.signal, timing, defer: (p) => void p }).catch(() => ({ ok: false, error: 'failed' }))
        const result = r.ok ? 'ok' : r.error === 'stale' ? 'stale' : r.error === 'busy' ? 'busy' : 'failed'
        // Numbers and codes only, from the frame's arrival: queue wait (q), the model's first token (tok), the first
        // chunk handed to Retell (first), the holding line if one was spoken (hold; -1 = none), whole turn (total),
        // model and tool time, model calls. Diagnosable per turn in the owner's events and Business Review.
        const end = clock()
        const ms = (v) => (Number.isFinite(v) ? v : -1)
        await ev('voice_turn', r.ok, `r=${result};q=${t.started - turn.received};tok=${ms(timing.firstTokenMs == null ? null : timing.firstTokenMs + (t.started - turn.received))};first=${t.firstChunk === null ? -1 : t.firstChunk - turn.received};hold=${ms(timing.holdMs == null ? null : timing.holdMs + (t.started - turn.received))};total=${end - turn.received};model=${timing.modelMs ?? 0};tools=${timing.toolMs ?? 0};calls=${timing.modelCalls ?? 0}`.slice(0, 120))
        if (r.error === 'stale') {
          pending = text // not saved: the next turn carries these words
          return
        }
        if (r.error === 'busy' && attempt === 0 && !spoke) continue // a typed message landed at the same moment: retry once on the fresh record
        if (r.ok || r.error !== 'busy') pending = ''
        if (!r.ok && !spoke) return sayT(RETRY_LINE, true)
        return sayT('', true)
      }
    } finally {
      if (inflight === turn) inflight = null
    }
  }

  ws.addEventListener('message', (evt) => {
    let msg
    try {
      msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '')
    } catch {
      return
    }
    // Keepalive is answered at once, never queued behind a turn (Retell reconnects after 5 s without one).
    if (msg.interaction_type === 'ping_pong') return send({ response_type: 'ping_pong', timestamp: msg.timestamp })
    if (msg.interaction_type !== 'response_required' && msg.interaction_type !== 'reminder_required') return
    const id = Number(msg.response_id)
    // A frame without a usable response_id can't be answered (and must not poison the staleness check).
    if (!Number.isSafeInteger(id) || id < 0) return void ev('voice_frame', false, 'bad_response_id')
    if (id < latest) return // older than a request already seen: Retell has discarded it
    latest = id
    // Barge-in: the caller spoke again. Stop generating the old answer now (unless it already acted, see respond),
    // so this turn doesn't wait for words nobody will hear.
    if (inflight && inflight.id < id) inflight.controller.abort()
    const turn = { id, controller: new AbortController(), received: clock() }
    // One turn at a time. A failure in one turn never stops the ones after it.
    queue = queue
      .then(() => runTurn(msg, turn))
      .catch((err) => {
        console.error('receptionist voice turn failed:', err?.name)
        if (turn.id === latest) say(turn.id, RETRY_LINE, true)
      })
  })
  ws.addEventListener('close', () => {
    // Only the socket closed: Retell may reconnect within RECONNECT_MS (see above).
    db.prepare('UPDATE receptionist_calls SET ended_at = ?2 WHERE call_id = ?1 AND ended_at IS NULL').bind(callId, clock()).run().catch(() => {})
  })
  return true
}
