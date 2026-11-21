// Voice Lab adapter interface (browser). One shape for every provider so the Lab UI (src/admin/VoiceLab) drives
// OpenAI Realtime, ElevenLabs or Retell the same way. Implementations: src/voice/openai.js (createOpenAIAdapter).
//
//   const adapter = createOpenAIAdapter()
//   await adapter.start({ customer, id, token, onEvent })   // the Lab session from POST /api/platform/voice-lab/session
//   adapter.state                                            // 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopping' | 'stopped' | 'failed'
//   const { summary } = await adapter.stop({ outcome })      // ends the Lab session (POST session action 'end' with the metrics)
//
// onEvent(name, payload) is called with:
//   'status'      { state, attempt?, reason? }                        state changes (see above); reason is a code
//   'transcript'  { who: 'customer' | 'receptionist', text, at, final } a finished line (also queued to the server as text)
//   'tool'        { name, ok, simulated, error?, ms }                  a model tool call that our server ran (dry-run → simulated)
//   'metrics'     { firstResponseMs, medianResponseMs, p95ResponseMs, turns, interruptions, toolCalls, toolFailures,
//                   reconnects, audioSeconds, inputTokens, outputTokens }   numbers only; sent to the server on stop
//   'error'       { code, detail?, fatal }                             codes only (provider_error, mic_denied, connect_failed,
//                                                                      sdp_failed, connection_lost, tool_failed, …)
// Rules every adapter keeps: the browser holds only a short-lived provider credential minted by our server for this
// session; a tool call is forwarded to POST /api/platform/voice-lab/tool and its result handed back verbatim (the
// model never acts by itself); transcript text goes only to our server (POST session action 'transcript'); nothing
// of the conversation is logged to the console.

export const ADAPTER_STATES = ['idle', 'connecting', 'connected', 'reconnecting', 'stopping', 'stopped', 'failed']
export const ADAPTER_EVENTS = ['status', 'transcript', 'tool', 'metrics', 'error']

export const METRIC_KEYS = ['firstResponseMs', 'medianResponseMs', 'p95ResponseMs', 'turns', 'interruptions', 'toolCalls', 'toolFailures', 'reconnects', 'audioSeconds', 'inputTokens', 'outputTokens']

// Per-turn response times → the metrics the server keeps (server/voice/sessions.js cleanMetrics drops anything else).
export function summarizeMetrics(m) {
  const times = [...(m.responseTimes || [])].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b)
  const q = (p) => (times.length ? times[Math.min(times.length - 1, Math.max(0, Math.ceil(p * times.length) - 1))] : undefined)
  const out = {
    firstResponseMs: Number.isFinite(m.firstResponseMs) ? m.firstResponseMs : undefined,
    medianResponseMs: q(0.5),
    p95ResponseMs: q(0.95),
    turns: times.length,
    interruptions: m.interruptions || 0,
    toolCalls: m.toolCalls || 0,
    toolFailures: m.toolFailures || 0,
    reconnects: m.reconnects || 0,
    audioSeconds: Number.isFinite(m.audioSeconds) ? m.audioSeconds : undefined,
    inputTokens: m.inputTokens || 0,
    outputTokens: m.outputTokens || 0,
  }
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => METRIC_KEYS.includes(k) && Number.isFinite(v)).map(([k, v]) => [k, Math.round(v)]))
}

// A safe emitter: a listener that throws never breaks the call.
export const emitter = (onEvent) => (name, payload) => {
  if (!ADAPTER_EVENTS.includes(name) || typeof onEvent !== 'function') return
  try {
    onEvent(name, payload)
  } catch {
    /* the UI's problem, not the call's */
  }
}
