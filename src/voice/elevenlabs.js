// ElevenLabs Conversational AI adapter for the Voice Lab (browser). Implements src/voice/adapter.js.
//
// Flow: start() → POST /api/platform/voice-lab/elevenlabs (our server mints a short-lived signed URL with the
// permanent key and returns OUR prompt/greeting overrides + the client tool names) → @elevenlabs/client (official
// browser SDK, 1.37.1, lazy-loaded here only) opens the WebSocket conversation, streams the microphone, plays the
// agent's audio and handles barge-in. Every client tool call the agent makes is forwarded to
// POST /api/platform/voice-lab/tool with the caller's latest transcript (userText) and the server's result is returned
// to the agent (the SDK sends it as client_tool_result; a thrown handler would become is_error, so we never throw: a
// refused call is an honest { ok: false, error } the model is told about). Final transcript lines are posted to the
// session (action 'transcript'). A dropped connection reconnects at most twice, each time with a fresh signed URL.
// SDK facts used (dist/types.d.ts, dist/BaseConversation.js, dist/utils/overrides.js, read 2026-11-21):
// onMessage({ message, role: 'user' | 'agent' }) = final transcripts and agent text; onModeChange({ mode }) flips to
// 'speaking' when the first agent audio plays; onInterruption; onDisconnect({ reason: 'user' | 'agent' | 'error' }).
import { api } from '../lib/api.js'
import { createTurnMetrics } from './adapter.js'

export const MAX_RECONNECTS = 2
const loadSdk = () => import('@elevenlabs/client')
const FALLBACK_NOTE = 'Something went wrong on our side: say so honestly and offer a callback request.'

export function createElevenLabsAdapter({ sdk = loadSdk, now = () => Date.now(), post = api } = {}) {
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
    await post('/api/platform/voice-lab/session', { method: 'POST', body: withSession({ action: 'transcript', lines }) })
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
    const { status, data } = await post('/api/platform/voice-lab/tool', { method: 'POST', body: withSession({ name, input: params && typeof params === 'object' ? params : {}, userText: lastUserText }) })
    const result = status === 200 && data?.result && typeof data.result === 'object' ? data.result : { ok: false, error: data?.error || (status === 429 ? 'rate_limited' : 'tool_failed'), note: FALLBACK_NOTE }
    const ok = result.ok !== false
    metrics.tool(ok)
    emit({ type: 'tool', name, ok, simulated: Boolean(result.simulated), ...(ok ? {} : { error: result.error }), ms: now() - t0 })
    emitMetrics()
    return result // objects are JSON-stringified by the SDK for client_tool_result
  }

  async function finish(s, reason, outcome) {
    if (flushTimer) clearTimeout(flushTimer)
    await flush().catch(() => {})
    emitMetrics()
    if (s === 'error') emit({ type: 'error', code: reason, fatal: true })
    setState(s, { reason, reconnects, ...(outcome ? { outcome } : {}) })
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
        await finish('error', err?.code || 'reconnect_failed')
      }
      return
    }
    if (details?.reason === 'error') return finish('error', 'disconnected')
    return finish('ended', details?.reason === 'agent' ? 'agent_ended' : 'ended')
  }

  async function connect() {
    const { status, data } = await post('/api/platform/voice-lab/elevenlabs', { method: 'POST', body: withSession({}) })
    if (status !== 200 || typeof data?.signedUrl !== 'string') throw Object.assign(new Error('connect refused'), { code: data?.error || (status === 429 ? 'rate_limited' : 'connect_failed') })
    const { Conversation } = await sdk()
    const clientTools = Object.fromEntries((Array.isArray(data.clientTools) ? data.clientTools : []).map((n) => [n, (params) => runTool(n, params)]))
    conversation = await Conversation.startSession({
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
  }

  return {
    get state() {
      return STATE[state] || state
    },
    metrics: () => metrics.snapshot(),
    async start({ customer, id, token, onEvent: cb }) {
      if (state === 'connecting' || state === 'live' || state === 'reconnecting') return
      session = { customer, id, token }
      onEvent = typeof cb === 'function' ? cb : () => {}
      stopping = false
      reconnects = 0
      lastUserText = ''
      agentSpeaking = false
      metrics = createTurnMetrics(now)
      queue = []
      setState('connecting')
      // Microphone inside the click (permission prompt + playback are tied to the gesture); a blocked microphone is
      // reported before a signed URL is minted. The SDK opens its own capture afterwards.
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          for (const t of stream.getTracks()) t.stop()
        } catch (err) {
          return finish('error', err?.name === 'NotFoundError' ? 'no_microphone' : 'microphone')
        }
      }
      try {
        await connect()
      } catch (err) {
        await finish('error', err?.code || 'connect_failed')
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
      if (state !== 'ended' && state !== 'error' && state !== 'idle') await finish('ended', 'stopped', typeof outcome === 'string' && /^[a-z_]{1,32}$/.test(outcome) ? outcome : undefined)
    },
  }
}
