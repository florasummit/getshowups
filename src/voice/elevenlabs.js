// ElevenLabs Conversational AI adapter (browser): the Voice Lab and the customer path (src/receptionist/ChatPage.jsx
// passes the customer routes). Implements src/voice/adapter.js.
//
// Flow: start() → POST the connect route (our server mints a short-lived signed URL with the permanent key and returns
// OUR prompt/greeting overrides + the client tool names; the customer path hands the start route's payload in as
// `connect`) → @elevenlabs/client (official browser SDK, 1.37.1, lazy-loaded here only) opens the WebSocket
// conversation, streams the microphone, plays the agent's audio and handles barge-in. Every client tool call the agent
// makes is forwarded to the tool route with the caller's latest transcript (userText) and the server's result is
// returned to the agent (the SDK sends it as client_tool_result; a thrown handler would become is_error, so we never
// throw: a refused call is an honest { ok: false, error } the model is told about). Final transcript lines are posted
// to the session (action 'transcript'). A dropped connection reconnects at most twice, each time with a fresh signed URL.
// SDK facts used (dist/types.d.ts, dist/BaseConversation.js, dist/utils/overrides.js, dist/utils/WebSocketConnection.js,
// read 2026-11-21/22): onMessage({ message, role: 'user' | 'agent' }) = final transcripts and agent text;
// onModeChange({ mode }) flips to 'speaking' when the first agent audio plays; onInterruption; onDisconnect({ reason:
// 'user' | 'agent' | 'error', message?, closeCode?, closeReason? }). A WebSocket closed BEFORE conversation_initiation_
// metadata rejects startSession with SessionConnectionError { closeCode, closeReason } (the provider's own reason, e.g.
// an override its agent does not allow → 1008), or "closed due to a socket error" without a code.
//
// Every end of a session is RECORDED (disconnectInfo → the session's `disconnect` record + the outcome code), so a
// call that drops is explained by the records (what phase, which WebSocket close code, the provider's reason text),
// never guessed from "it dropped" (production 2026-11-22: three ElevenLabs test calls ended 3–5 s after the signed URL
// with no code anywhere). The handshake is bounded (CONNECT_TIMEOUT_MS) and the end request survives the page closing
// (keepalive + pagehide), so no session is left open to count against the daily minute budgets.
import { api } from '../lib/api.js'
import { createTurnMetrics } from './adapter.js'

export const MAX_RECONNECTS = 2
// The provider must answer the WebSocket handshake (conversation_initiation_metadata) within this time; a socket that
// opens and then hangs would otherwise leave the caller on "Connecting…" with nothing recorded.
export const CONNECT_TIMEOUT_MS = 20_000
const loadSdk = () => import('@elevenlabs/client')
const FALLBACK_NOTE = 'Something went wrong on our side: say so honestly and offer a callback request.'

export const LAB_ROUTES = { connect: '/api/platform/voice-lab/elevenlabs', tool: '/api/platform/voice-lab/tool', session: '/api/platform/voice-lab/session' }

// What the SDK reports when a connection ends or never starts, as a record: a code (the session's outcome), the
// WebSocket close code and the provider's close reason as printable ASCII (≤ 120 chars; never audio, transcript or a
// credential). `phase`: start (the handshake), live (an established call), reconnect (a reconnect attempt).
// RFC 6455 close codes the provider uses: 1000 normal (before the handshake finished = the agent refused to start
// without saying why), 1006 abnormal (the socket vanished: network, proxy, the browser), 1008 policy (ElevenLabs'
// configuration refusals, e.g. an override the agent does not allow, a missing dynamic variable, an unauthorized or
// unknown agent, a plan limit), 1009 message too big, 1011–1013 server errors.
const CLOSE_CODES = { 1000: 'closed_before_start', 1006: 'socket_closed', 1008: 'provider_refused', 1009: 'payload_too_large', 1011: 'provider_error', 1012: 'provider_error', 1013: 'provider_error' }
const CODE_RE = /^[a-z_]{1,32}$/
const safeText = (s) =>
  String(s || '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || null
export function disconnectInfo(phase, err) {
  const ours = typeof err?.code === 'string' && CODE_RE.test(err.code) ? err.code : null
  const closeCode = Number.isInteger(err?.closeCode) && err.closeCode >= 1000 && err.closeCode <= 4999 ? err.closeCode : null
  let code = ours
  if (!code && closeCode != null) code = closeCode === 1000 && phase !== 'start' ? 'agent_ended' : CLOSE_CODES[closeCode] || 'provider_closed'
  if (!code && /socket error/i.test(String(err?.message || ''))) code = 'socket_error'
  if (!code) code = phase === 'live' ? 'connection_lost' : 'connect_failed'
  const reason = ours ? null : safeText(err?.closeReason || (closeCode == null ? err?.message : ''))
  return { phase, code, closeCode, reason }
}

export function createElevenLabsAdapter({ sdk = loadSdk, now = () => Date.now(), post = api, routes: routeOverrides = null, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const routes = { ...LAB_ROUTES, ...(routeOverrides || {}) }
  let initial = null // the start route's own connect payload (signedUrl, overrides, …), first connection only
  let state = 'idle'
  let session = null
  let onEvent = () => {}
  let conversation = null
  let stopping = false
  let reconnects = 0
  let lastUserText = ''
  let agentSpeaking = false
  let metrics = createTurnMetrics(now)
  let queue = []
  let flushTimer = null
  let ended = false

  // Events use the shared shape (src/voice/adapter.js): onEvent(name, payload). ElevenLabs' own session states map to
  // the interface's: live → connected, ended → stopped, error → failed.
  const STATE = { idle: 'idle', connecting: 'connecting', live: 'connected', reconnecting: 'reconnecting', ended: 'stopped', error: 'failed' }
  const emit = (e) => {
    const { type, ...payload } = e
    try {
      const { status, ...rest } = payload
      onEvent(type, type === 'status' ? { state: STATE[status] || status, ...rest } : payload)
    } catch {}
  }
  const setState = (s, extra = {}) => {
    state = s
    emit({ type: 'status', status: s, ...extra })
  }
  const withSession = (extra) => ({ customer: session.customer, id: session.id, token: session.token, ...extra })
  const emitMetrics = () => emit({ type: 'metrics', metrics: metrics.snapshot() })

  const flush = async () => {
    flushTimer = null
    if (!queue.length || !session) return
    const lines = queue
    queue = []
    await post(routes.session, { method: 'POST', body: withSession({ action: 'transcript', lines }) })
  }
  const said = (who, text) => {
    const at = now()
    emit({ type: 'transcript', who, text, at })
    queue.push({ who, text, at })
    if (!flushTimer) flushTimer = setTimeout(flush, 800)
  }

  // The only way the agent acts: our server runs the engine tool for this session and tells us what to answer.
  const runTool = async (name, params) => {
    const t0 = now()
    const { status, data } = await post(routes.tool, { method: 'POST', body: withSession({ name, input: params && typeof params === 'object' ? params : {}, userText: lastUserText }) })
    const result = status === 200 && data?.result && typeof data.result === 'object' ? data.result : { ok: false, error: data?.error || (status === 429 ? 'rate_limited' : 'tool_failed'), note: FALLBACK_NOTE }
    const ok = result.ok !== false
    metrics.tool(ok)
    emit({ type: 'tool', name, ok, simulated: Boolean(result.simulated), ...(ok ? {} : { error: result.error }), ms: now() - t0 })
    emitMetrics()
    return result // objects are JSON-stringified by the SDK for client_tool_result
  }

  // The customer path ends the session here (the Lab page sends 'end' itself when routes are the Lab's). keepalive:
  // the request completes even when the page is closing. Once per session.
  const sendEnd = (outcome, disconnect) => {
    if (!routeOverrides || !session || ended) return Promise.resolve()
    ended = true
    return post(routes.session, { method: 'POST', body: withSession({ action: 'end', metrics: metrics.snapshot(), ...(outcome ? { outcome } : {}), ...(disconnect ? { disconnect } : {}) }), keepalive: true }).catch(() => {})
  }
  // The page is closing (navigation, tab closed, reload) during a call: end the provider session and record it, so no
  // session stays open against the daily minute budgets (the normal finish() never gets to run on unload).
  const onPageHide = () => {
    if (state !== 'connecting' && state !== 'live' && state !== 'reconnecting') return
    stopping = true
    const c = conversation
    conversation = null
    try {
      c?.endSession?.()
    } catch {}
    sendEnd('page_closed', { phase: state === 'live' ? 'live' : 'start', code: 'page_closed', closeCode: null, reason: null })
    state = 'ended'
    detachPage()
  }
  const attachPage = () => typeof window !== 'undefined' && window.addEventListener?.('pagehide', onPageHide)
  const detachPage = () => typeof window !== 'undefined' && window.removeEventListener?.('pagehide', onPageHide)

  async function finish(s, reason, outcome, disconnect = null) {
    if (flushTimer) clearTimeout(flushTimer)
    await flush().catch(() => {})
    emitMetrics()
    // A failed session's outcome is its failure code; a disconnect record says what the SDK saw.
    await sendEnd(outcome || (s === 'error' ? reason : undefined), disconnect)
    detachPage()
    if (s === 'error') emit({ type: 'error', code: reason, fatal: true, ...(disconnect ? { disconnect } : {}) })
    setState(s, { reason, reconnects, ...(outcome ? { outcome } : {}), ...(disconnect ? { disconnect } : {}) })
  }

  async function onDisconnect(details) {
    conversation = null
    agentSpeaking = false
    if (stopping || state === 'ended' || state === 'error') return
    if (details?.reason === 'error' && reconnects < MAX_RECONNECTS) {
      reconnects++
      metrics.reconnected()
      setState('reconnecting', { reconnects })
      try {
        await connect()
      } catch (err) {
        const d = disconnectInfo('reconnect', err)
        await finish('error', err?.code || 'reconnect_failed', undefined, d)
      }
      return
    }
    if (details?.reason === 'error') return finish('error', 'disconnected', undefined, disconnectInfo('live', details))
    return finish('ended', details?.reason === 'agent' ? 'agent_ended' : 'ended')
  }

  async function connect() {
    const { status, data } = initial ? { status: 200, data: initial } : await post(routes.connect, { method: 'POST', body: withSession({}) })
    initial = null
    if (status !== 200 || typeof data?.signedUrl !== 'string') throw Object.assign(new Error('connect refused'), { code: data?.error || (status === 429 ? 'rate_limited' : 'connect_failed') })
    const { Conversation } = await sdk()
    const clientTools = Object.fromEntries((Array.isArray(data.clientTools) ? data.clientTools : []).map((n) => [n, (params) => runTool(n, params)]))
    const started = Conversation.startSession({
      signedUrl: data.signedUrl,
      connectionType: 'websocket',
      overrides: data.overrides,
      dynamicVariables: data.dynamicVariables,
      clientTools,
      onConnect: () => setState('live', { reconnects }),
      onMessage: ({ message, role, source }) => {
        if (typeof message !== 'string' || !message.trim()) return
        const who = role === 'user' || source === 'user' ? 'customer' : 'receptionist'
        if (who === 'customer') {
          lastUserText = message
          metrics.userFinished(now())
        }
        said(who, message)
      },
      onModeChange: ({ mode }) => {
        const speaking = mode === 'speaking'
        if (speaking && !agentSpeaking) {
          metrics.agentStarted(now())
          emitMetrics()
        }
        agentSpeaking = speaking
        emit({ type: 'status', status: state, mode })
      },
      onInterruption: () => {
        metrics.interrupted()
        emitMetrics()
      },
      onError: (message) => emit({ type: 'error', code: 'provider_error', detail: String(message || '').slice(0, 160), fatal: false }),
      onDisconnect: (details) => {
        onDisconnect(details).catch(() => {})
      },
    })
    // Bounded handshake: a session the provider never confirms is ended and reported, not waited for.
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('handshake timeout'), { code: 'connect_timeout' })), connectTimeoutMs)
    })
    try {
      conversation = await Promise.race([started, timeout])
    } catch (err) {
      if (err?.code === 'connect_timeout') started.then((c) => c?.endSession?.()).catch(() => {})
      throw err
    } finally {
      clearTimeout(timer)
    }
    if (stopping || state === 'ended' || state === 'error') {
      // Ended while the handshake was in flight (page closing): never keep the provider session.
      const c = conversation
      conversation = null
      try {
        await c?.endSession?.()
      } catch {}
    }
  }

  return {
    get state() {
      return STATE[state] || state
    },
    metrics: () => metrics.snapshot(),
    async start({ customer, id, token, onEvent: cb, connect: first = null }) {
      if (state === 'connecting' || state === 'live' || state === 'reconnecting') return
      session = { customer, id, token }
      initial = first && typeof first.signedUrl === 'string' ? first : null
      onEvent = typeof cb === 'function' ? cb : () => {}
      stopping = false
      ended = false
      reconnects = 0
      lastUserText = ''
      agentSpeaking = false
      metrics = createTurnMetrics(now)
      queue = []
      setState('connecting')
      attachPage()
      // Microphone inside the click (permission prompt + playback are tied to the gesture); a blocked microphone is
      // reported before a signed URL is minted. The SDK opens its own capture afterwards.
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          for (const t of stream.getTracks()) t.stop()
        } catch (err) {
          const code = err?.name === 'NotFoundError' ? 'no_microphone' : 'microphone'
          return finish('error', code, undefined, { phase: 'start', code, closeCode: null, reason: null })
        }
      }
      try {
        await connect()
      } catch (err) {
        if (state === 'ended' || state === 'error') return // already finished (page closed during the handshake)
        const d = disconnectInfo('start', err)
        await finish('error', d.code, undefined, d)
      }
    },
    // { outcome }: the Lab's outcome code for this session (e.g. 'booked'), echoed on the final status event; the page
    // sends it with action 'end'. Idempotent.
    async stop({ outcome } = {}) {
      stopping = true
      const c = conversation
      conversation = null
      try {
        await c?.endSession()
      } catch {}
      if (state !== 'ended' && state !== 'error' && state !== 'idle') await finish('ended', 'stopped', typeof outcome === 'string' && CODE_RE.test(outcome) ? outcome : undefined)
      detachPage()
    },
  }
}
