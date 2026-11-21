// Retell adapter for the Voice Lab (browser): the PRODUCTION voice path on an admin-marked TEST business. Our server
// creates the Retell web call for the Lab session (POST /api/platform/voice-lab/retell; our API key never leaves it);
// the browser runs Retell's SDK (speech, voice, turn-taking, barge-in), and the receptionist engine answers through the
// same custom-LLM socket customers get. Tools run inside the engine on our server (dry-run when the session is), so
// 'tool' events are not emitted here: the Lab reads tool outcomes from the engine's events in the end-of-session
// summary. Same interface as the other adapters (src/voice/adapter.js): start/stop/state/metrics(), events
// status · transcript · metrics · error.
import { api } from '../lib/api.js'
import { ADAPTER_STATES, createTurnMetrics, emitter } from './adapter.js'

export function createRetellAdapter({ sdk = () => import('retell-client-js-sdk'), post = api, now = () => Date.now() } = {}) {
  let state = 'idle'
  let emit = () => {}
  let session = null
  let call = null
  let agentTalking = false
  let metrics = createTurnMetrics(now)
  let lastLines = []
  let stopped = false
  const setState = (s, extra = {}) => {
    state = ADAPTER_STATES.includes(s) ? s : state
    emit('status', { state, ...extra })
  }
  const withSession = (extra) => ({ customer: session.customer, id: session.id, token: session.token, ...extra })
  const snapshot = () => metrics.snapshot()
  // Retell sends the whole transcript on every update: emit only lines that are new or changed, final = the speaker
  // has moved on (a later line exists) or the agent finished.
  const onTranscript = (lines) => {
    const mapped = lines.map((l) => ({ who: l.role === 'agent' ? 'receptionist' : 'customer', text: String(l.content || '').trim() })).filter((l) => l.text)
    mapped.forEach((l, i) => {
      const prev = lastLines[i]
      const final = i < mapped.length - 1
      if (prev && prev.text === l.text && prev.final === final) return
      emit('transcript', { who: l.who, text: l.text, at: now(), final })
    })
    lastLines = mapped.map((l, i) => ({ ...l, final: i < mapped.length - 1 }))
  }
  const flushTranscript = async () => {
    const finals = lastLines.filter((l) => l.text)
    if (!finals.length || !session) return
    await post('/api/platform/voice-lab/session', { method: 'POST', body: withSession({ action: 'transcript', lines: finals.map((l) => ({ who: l.who, text: l.text, at: now() })) }) }).catch(() => {})
  }
  return {
    get state() {
      return state
    },
    metrics: snapshot,
    async start({ customer, id, token, onEvent }) {
      if (state !== 'idle') throw Object.assign(new Error('already_started'), { code: 'already_started' })
      emit = emitter(onEvent)
      session = { customer, id, token }
      setState('connecting')
      const { status, data } = await post('/api/platform/voice-lab/retell', { method: 'POST', body: withSession({}) })
      if (status !== 200) {
        const code = data?.error || (status === 429 ? 'rate_limited' : 'connect_failed')
        emit('error', { code, fatal: true })
        setState('failed', { reason: code })
        throw Object.assign(new Error(code), { code })
      }
      let RetellWebClient
      try {
        ;({ RetellWebClient } = await sdk())
      } catch {
        emit('error', { code: 'sdk_unavailable', fatal: true })
        setState('failed', { reason: 'sdk_unavailable' })
        throw Object.assign(new Error('sdk_unavailable'), { code: 'sdk_unavailable' })
      }
      call = new RetellWebClient()
      call.on('call_started', () => setState('connected'))
      call.on('agent_start_talking', () => {
        agentTalking = true
        metrics.agentStarted()
        emit('metrics', snapshot())
      })
      call.on('agent_stop_talking', () => {
        agentTalking = false
      })
      call.on('user_start_talking', () => {
        if (agentTalking) {
          metrics.interrupted()
          emit('metrics', snapshot())
        }
      })
      call.on('user_stop_talking', () => metrics.userFinished())
      call.on('update', (u) => Array.isArray(u?.transcript) && onTranscript(u.transcript))
      call.on('call_ended', () => {
        if (stopped) return
        stopped = true
        setState('stopped', { reason: 'call_ended' })
      })
      call.on('error', () => {
        try {
          call?.stopCall()
        } catch {}
        if (stopped) return
        stopped = true
        emit('error', { code: 'provider_error', fatal: true })
        setState('failed', { reason: 'provider_error' })
      })
      try {
        await call.startCall({ accessToken: data.accessToken, callId: data.callId, transport: data.transport, iceServers: data.iceServers })
      } catch (err) {
        const code = err?.name === 'NotAllowedError' || /permission|microphone/i.test(String(err?.message)) ? 'mic_denied' : 'connect_failed'
        emit('error', { code, fatal: true })
        setState('failed', { reason: code })
        throw Object.assign(new Error(code), { code })
      }
      return { ok: true }
    },
    async stop({ outcome } = {}) {
      if (state === 'stopped' || state === 'idle') return { ok: true, metrics: snapshot() }
      setState('stopping')
      stopped = true
      try {
        call?.stopCall()
      } catch {}
      call = null
      await flushTranscript()
      const m = snapshot()
      emit('metrics', m)
      setState('stopped', { reason: 'stopped', ...(outcome ? { outcome } : {}) })
      return { ok: true, metrics: m }
    },
  }
}
