// OpenAI Realtime adapter (browser side of the Voice Lab) — implements src/voice/adapter.js for OpenAI.
//
// Flow (official docs checked 2026-11-21, see docs/VOICE_LAB.md "OpenAI Realtime"):
//   1. POST /api/platform/voice-lab/openai { customer, id, token } → our server mints a SHORT-LIVED client secret
//      (ek_…) and fixes the session config (model, voice, server VAD, instructions, our seven tools). We never see
//      the permanent key.
//   2. WebRTC: microphone track in, remote audio track out (played in an <audio> element), data channel 'oai-events'
//      for JSON events. SDP offer → POST https://api.openai.com/v1/realtime/calls (Authorization: Bearer <client
//      secret>, Content-Type: application/sdp) → SDP answer.
//   3. Server VAD does turn-taking: the model answers when the caller stops talking and is cut off when they start
//      again (interruptions are counted from input_audio_buffer.speech_started while a response is playing).
//   4. A tool call (response.function_call_arguments.done, or a function_call item in response.done as a fallback)
//      is forwarded to POST /api/platform/voice-lab/tool with the caller's latest transcribed words; the result goes
//      back verbatim as conversation.item.create { type: 'function_call_output' } + response.create. The model
//      never executes anything itself.
//   5. Transcript: caller lines from conversation.item.input_audio_transcription.completed, receptionist lines from
//      response.output_audio_transcript.done; queued to POST /api/platform/voice-lab/session action 'transcript'.
//   6. Metrics measured here: speech_stopped → first response signal (output_audio_buffer.started, an audio or
//      transcript delta) per turn → firstResponseMs, median, p95; interruptions; tool calls/failures; reconnects;
//      token usage from response.done. Numbers only; sent with action 'end'.
//   7. Recovery: ICE failure / disconnect / channel closed → re-mint and reconnect (fresh session, same config,
//      no second greeting), at most 2 times, then the session is ended with code connection_lost.
//   8. Audio, both ways, is proven rather than assumed: the remote track is attached to an <audio> element the
//      adapter creates itself when none is injected (2026-11-22: the Lab injected none, so the call was silent) and
//      played; a blocked autoplay is reported (audio_blocked) and resumeAudio() retries it from a click. Level meters
//      on the microphone and on the remote stream report 'mic: live' / 'audio: received' in status events, and a
//      microphone that stays silent for MIC_SILENT_MS after connecting is reported (mic_silent, not fatal).
// Nothing of the conversation is logged to the console. Dependencies are injectable for tests (no real WebRTC in node).
import { api as defaultApi } from '../lib/api.js'
import { emitter, summarizeMetrics } from './adapter.js'

export const OPENAI_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
export const OPENAI_DATA_CHANNEL = 'oai-events'
export const MAX_RECONNECTS = 2
const DISCONNECT_GRACE_MS = 3000
export const MIC_SILENT_MS = 8000
const LEVEL_INTERVAL_MS = 250
const LEVEL_THRESHOLD = 0.01 // RMS of the time-domain signal (0–1); silence from a working microphone is ≈0.001
const TRANSCRIPT_FLUSH_MS = 1500
// Any of these after the caller stopped speaking = the model has started answering.
const FIRST_RESPONSE_EVENTS = ['output_audio_buffer.started', 'response.output_audio.delta', 'response.output_audio_transcript.delta', 'response.output_text.delta']

const parse = (data) => {
  try {
    const ev = JSON.parse(data)
    return ev && typeof ev === 'object' && typeof ev.type === 'string' ? ev : null
  } catch {
    return null
  }
}

export function createOpenAIAdapter(deps = {}) {
  const apiFn = deps.api || defaultApi
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a))
  const PeerConnection = deps.RTCPeerConnection || globalThis.RTCPeerConnection
  const getUserMedia = deps.getUserMedia || ((c) => globalThis.navigator.mediaDevices.getUserMedia(c))
  const now = deps.now || (() => (globalThis.performance || Date).now())
  const setT = deps.setTimeout || ((...a) => globalThis.setTimeout(...a))
  const clearT = deps.clearTimeout || ((...a) => globalThis.clearTimeout(...a))
  const injectedAudio = deps.audio || null
  const doc = deps.document || globalThis.document || null
  const AudioCtx = deps.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext || null
  const MediaStreamCtor = deps.MediaStream || globalThis.MediaStream || null

  let state = 'idle'
  let emit = () => {}
  let session = null
  let pc = null
  let dc = null
  let mic = null
  let greeted = false
  let finished = null
  let stopping = false
  let responseActive = false
  let speaking = false
  let lastUserText = ''
  let connectedAt = null
  let turn = { at: 0, awaiting: false }
  const parts = new Map()
  const handledCalls = new Set()
  const pending = []
  let flushTimer = null
  const metrics = { firstResponseMs: undefined, responseTimes: [], interruptions: 0, toolCalls: 0, toolFailures: 0, reconnects: 0, inputTokens: 0, outputTokens: 0, audioSeconds: 0 }
  // Audio diagnostics (what the status events carry besides the state): mic 'unknown' | 'live' | 'silent',
  // audio 'none' | 'playing' | 'received' | 'blocked'. Reported on every transition, never per level sample.
  const diag = { mic: 'unknown', audio: 'none' }
  let player = injectedAudio
  let remoteStream = null
  const meters = []
  let micTimer = null

  const setState = (s, extra = {}) => {
    state = s
    emit('status', { state: s, mic: diag.mic, audio: diag.audio, ...extra })
  }
  const setDiag = (patch) => {
    const changed = Object.entries(patch).some(([k, v]) => diag[k] !== v)
    Object.assign(diag, patch)
    if (changed) emit('status', { state, mic: diag.mic, audio: diag.audio })
  }

  // The element that plays the receptionist: injected (tests) or created here, hidden, autoplay, inline.
  const ensurePlayer = () => {
    if (player) return player
    if (!doc?.createElement) return null
    const el = doc.createElement('audio')
    el.autoplay = true
    el.setAttribute('playsinline', '')
    el.setAttribute('data-voice-lab-audio', 'openai')
    if (el.style) el.style.display = 'none'
    doc.body?.appendChild?.(el)
    player = el
    return el
  }
  const playRemote = () => {
    const el = ensurePlayer()
    if (!el) return
    let p
    try {
      p = el.play?.()
    } catch (err) {
      p = Promise.reject(err)
    }
    if (p && typeof p.then === 'function') {
      p.then(
        () => setDiag({ audio: diag.audio === 'received' ? 'received' : 'playing' }),
        () => {
          setDiag({ audio: 'blocked' })
          emit('error', { code: 'audio_blocked', fatal: false })
        },
      )
    }
  }
  // A level meter on a stream: calls onLevel(rms) every LEVEL_INTERVAL_MS. Null when Web Audio is unavailable.
  const meter = (stream, onLevel) => {
    if (!AudioCtx || !stream) return null
    let ctx
    try {
      ctx = new AudioCtx()
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const id = setT(function tick() {
        an.getByteTimeDomainData(buf)
        let sum = 0
        for (const v of buf) {
          const d = (v - 128) / 128
          sum += d * d
        }
        onLevel(Math.sqrt(sum / buf.length))
        m.id = setT(tick, LEVEL_INTERVAL_MS)
      }, LEVEL_INTERVAL_MS)
      const m = { id, stop: () => { clearT(m.id); ctx.close?.()?.catch?.(() => {}) } }
      meters.push(m)
      if (ctx.state === 'suspended') ctx.resume?.()?.catch?.(() => {})
      return m
    } catch {
      try {
        ctx?.close?.()
      } catch {
        /* nothing to close */
      }
      return null
    }
  }
  const stopMeters = () => {
    for (const m of meters.splice(0)) m.stop()
    if (micTimer) clearT(micTimer)
    micTimer = null
  }
  const snapshot = () => summarizeMetrics(metrics)
  const send = (obj) => {
    if (!dc || dc.readyState !== 'open') return false
    try {
      dc.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  // Transcript lines go to our server in small batches (text only), and to the UI at once.
  const line = (who, text) => {
    const t = String(text || '').trim()
    if (!t) return
    const at = Date.now()
    pending.push({ who, text: t, at })
    emit('transcript', { who, text: t, at, final: true })
    if (!flushTimer) flushTimer = setT(() => flush(), TRANSCRIPT_FLUSH_MS)
  }
  const flush = async () => {
    if (flushTimer) clearT(flushTimer)
    flushTimer = null
    if (!pending.length || !session) return
    const lines = pending.splice(0, pending.length)
    const r = await apiFn('/api/platform/voice-lab/session', { method: 'POST', body: { action: 'transcript', customer: session.customer, id: session.id, token: session.token, lines } })
    if (r.status !== 200) emit('error', { code: 'transcript_failed', detail: r.data?.error, fatal: false })
  }

  // The ONLY way the model acts: our server runs the engine's tool for this Lab session (dry-run unless started live)
  // and the result is handed back exactly as returned.
  const toolCall = async (callId, name, argsJson) => {
    if (!callId || handledCalls.has(callId)) return
    handledCalls.add(callId)
    metrics.toolCalls += 1
    let input = {}
    try {
      input = argsJson ? JSON.parse(argsJson) : {}
      if (!input || typeof input !== 'object' || Array.isArray(input)) input = {}
    } catch {
      input = {}
    }
    const t0 = now()
    const r = await apiFn('/api/platform/voice-lab/tool', { method: 'POST', body: { customer: session.customer, id: session.id, token: session.token, name, input, userText: lastUserText } })
    const result = r.status === 200 && r.data?.result && typeof r.data.result === 'object' ? r.data.result : { ok: false, error: r.data?.error || 'tool_failed', note: 'The tool could not run: say so honestly and offer to have someone call back.' }
    const ok = result.ok !== false
    if (!ok) metrics.toolFailures += 1
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } })
    send({ type: 'response.create' })
    emit('tool', { name, ok, simulated: Boolean(result.simulated), ...(ok ? {} : { error: String(result.error || 'tool_failed') }), ms: Math.round(now() - t0) })
    emit('metrics', snapshot())
  }

  const handle = (ev) => {
    if (!ev) return
    const t = ev.type
    if (t === 'input_audio_buffer.speech_started') {
      if (responseActive || speaking) metrics.interruptions += 1
      return
    }
    if (t === 'input_audio_buffer.speech_stopped') {
      turn = { at: now(), awaiting: true }
      return
    }
    if (t === 'response.created') responseActive = true
    if (FIRST_RESPONSE_EVENTS.includes(t) && turn.awaiting) {
      const ms = now() - turn.at
      turn.awaiting = false
      metrics.responseTimes.push(ms)
      if (!Number.isFinite(metrics.firstResponseMs)) metrics.firstResponseMs = ms
      emit('metrics', snapshot())
    }
    if (t === 'output_audio_buffer.started') speaking = true
    if (t === 'output_audio_buffer.stopped' || t === 'output_audio_buffer.cleared') speaking = false
    if (t === 'response.output_audio_transcript.delta' && ev.item_id) parts.set(ev.item_id, (parts.get(ev.item_id) || '') + String(ev.delta || ''))
    if (t === 'response.output_audio_transcript.done' || t === 'response.output_text.done') {
      const text = typeof ev.transcript === 'string' ? ev.transcript : typeof ev.text === 'string' ? ev.text : parts.get(ev.item_id) || ''
      parts.delete(ev.item_id)
      line('receptionist', text)
    }
    if (t === 'conversation.item.input_audio_transcription.completed') {
      const text = String(ev.transcript || '').trim()
      if (text) lastUserText = text
      line('customer', text)
    }
    if (t === 'response.function_call_arguments.done') toolCall(ev.call_id, ev.name, ev.arguments)
    if (t === 'response.done') {
      responseActive = false
      const u = ev.response?.usage
      if (u) {
        metrics.inputTokens += Number(u.input_tokens) || 0
        metrics.outputTokens += Number(u.output_tokens) || 0
      }
      for (const item of ev.response?.output || []) if (item?.type === 'function_call' && item.call_id && item.status !== 'incomplete') toolCall(item.call_id, item.name, item.arguments)
      emit('metrics', snapshot())
    }
    if (t === 'error') emit('error', { code: 'provider_error', detail: String(ev.error?.code || ev.error?.type || 'unknown').slice(0, 64), fatal: false })
  }

  const teardown = () => {
    stopMeters()
    if (connectedAt != null) {
      metrics.audioSeconds += (now() - connectedAt) / 1000
      connectedAt = null
    }
    if (dc) {
      dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null
      try {
        dc.close()
      } catch {
        /* already closed */
      }
    }
    if (pc) {
      pc.onconnectionstatechange = pc.ontrack = pc.oniceconnectionstatechange = null
      try {
        pc.close()
      } catch {
        /* already closed */
      }
    }
    dc = null
    pc = null
    responseActive = false
    speaking = false
    turn = { at: 0, awaiting: false }
  }

  const fail = async (code) => {
    emit('error', { code, fatal: true })
    await finish({ outcome: 'connection_lost', failed: true })
  }

  const reconnect = async (reason) => {
    if (stopping || finished) return
    if (metrics.reconnects >= MAX_RECONNECTS) return fail('connection_lost')
    metrics.reconnects += 1
    teardown()
    setState('reconnecting', { attempt: metrics.reconnects, reason })
    try {
      await connect()
    } catch (err) {
      emit('error', { code: err?.code || 'connect_failed', fatal: false })
      await reconnect(err?.code || 'connect_failed')
    }
  }

  const codeError = (code) => Object.assign(new Error(code), { code })

  // One connection: mint → mic → peer connection → data channel → SDP exchange. Resolves once the answer is applied;
  // 'connected' is emitted when the data channel opens and the session config has been (re)sent.
  const connect = async () => {
    ensurePlayer() // created inside the Start click's gesture, before any await: autoplay policies allow it
    const r = await apiFn('/api/platform/voice-lab/openai', { method: 'POST', body: { customer: session.customer, id: session.id, token: session.token } })
    if (r.status !== 200 || typeof r.data?.clientSecret !== 'string') throw codeError(r.data?.error || 'connect_failed')
    const { clientSecret, expiresAt, sessionConfig, greeting } = r.data
    if (!mic) {
      try {
        mic = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      } catch {
        throw codeError('mic_denied')
      }
    }
    const cur = new PeerConnection()
    pc = cur
    cur.ontrack = (e) => {
      const stream = e.streams?.[0] || (MediaStreamCtor && e.track ? new MediaStreamCtor([e.track]) : null)
      remoteStream = stream
      const el = ensurePlayer()
      if (!el) {
        emit('error', { code: 'audio_unavailable', fatal: false })
        return
      }
      el.srcObject = stream
      playRemote()
      meter(stream, (level) => {
        if (level >= LEVEL_THRESHOLD && diag.audio !== 'received') setDiag({ audio: 'received' })
      })
    }
    for (const track of mic.getAudioTracks()) cur.addTrack(track, mic)
    const channel = cur.createDataChannel(OPENAI_DATA_CHANNEL)
    dc = channel
    channel.onmessage = (e) => handle(parse(e.data))
    channel.onopen = () => {
      if (pc !== cur) return
      const config = { ...(sessionConfig && typeof sessionConfig === 'object' ? sessionConfig : {}) }
      delete config.model // session.update configures the live session; the model was fixed by the client secret
      send({ type: 'session.update', session: config })
      if (!greeted) {
        greeted = true
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `The call has just connected. Open the call now with this greeting, then wait for the caller: "${String(greeting || 'Hi, how can I help?').replace(/"/g, "'")}"` }] } })
        send({ type: 'response.create' })
      }
      connectedAt = now()
      setState('connected', { attempt: metrics.reconnects })
      // Microphone level: proof that the caller's audio exists before it ever reaches the provider.
      if (!meters.some((x) => x.mic)) {
        const m = meter(mic, (level) => {
          if (level >= LEVEL_THRESHOLD && diag.mic !== 'live') setDiag({ mic: 'live' })
        })
        if (m) m.mic = true
        if (micTimer) clearT(micTimer)
        micTimer = setT(() => {
          if (diag.mic !== 'live' && !stopping && !finished) {
            setDiag({ mic: 'silent' })
            emit('error', { code: 'mic_silent', fatal: false })
          }
        }, MIC_SILENT_MS)
      }
    }
    channel.onclose = () => {
      if (pc === cur && !stopping) reconnect('channel_closed')
    }
    cur.onconnectionstatechange = () => {
      if (pc !== cur || stopping) return
      const s = cur.connectionState
      if (s === 'failed' || s === 'closed') reconnect(`ice_${s}`)
      if (s === 'disconnected') setT(() => {
        if (pc === cur && !stopping && cur.connectionState === 'disconnected') reconnect('ice_disconnected')
      }, DISCONNECT_GRACE_MS)
    }
    const offer = await cur.createOffer()
    await cur.setLocalDescription(offer)
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) throw codeError('secret_expired')
    let res
    try {
      res = await fetchFn(OPENAI_CALLS_URL, { method: 'POST', headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' }, body: offer.sdp })
    } catch {
      throw codeError('sdp_failed')
    }
    if (!res.ok) throw codeError(res.status === 401 || res.status === 403 ? 'secret_rejected' : 'sdp_failed')
    await cur.setRemoteDescription({ type: 'answer', sdp: await res.text() })
  }

  const finish = async ({ outcome, failed = false } = {}) => {
    if (finished) return finished
    finished = (async () => {
      stopping = true
      setState('stopping')
      teardown()
      if (mic) for (const track of mic.getTracks?.() || []) track.stop?.()
      mic = null
      await flush()
      const m = snapshot()
      emit('metrics', m)
      let summary = null
      if (session) {
        const r = await apiFn('/api/platform/voice-lab/session', { method: 'POST', body: { action: 'end', customer: session.customer, id: session.id, token: session.token, metrics: m, ...(outcome ? { outcome } : {}) } })
        if (r.status === 200) summary = r.data?.summary || null
        else emit('error', { code: 'end_failed', detail: r.data?.error, fatal: false })
      }
      setState(failed ? 'failed' : 'stopped')
      return { summary, metrics: m }
    })()
    return finished
  }

  return {
    get state() {
      return state
    },
    get diagnostics() {
      return { ...diag, remoteStream: Boolean(remoteStream) }
    },
    metrics: snapshot,
    // From a click: retries playback after the browser blocked autoplay (audio_blocked) and resumes the meters.
    resumeAudio() {
      playRemote()
      return diag.audio
    },
    async start({ customer, id, token, onEvent } = {}) {
      if (state !== 'idle') throw codeError('already_started')
      if (!customer || !id || !token) throw codeError('invalid_session')
      session = { customer, id, token }
      emit = emitter(onEvent)
      setState('connecting')
      try {
        await connect()
      } catch (err) {
        const code = err?.code || 'connect_failed'
        emit('error', { code, fatal: true })
        await finish({ outcome: code === 'mic_denied' ? 'mic_denied' : 'connect_failed', failed: true })
        throw err
      }
    },
    stop({ outcome } = {}) {
      if (state === 'idle') return Promise.resolve({ summary: null, metrics: snapshot() })
      return finish({ outcome: outcome || 'ended' })
    },
  }
}
