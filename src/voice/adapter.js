// Voice Lab adapter interface (browser). One adapter per provider (src/voice/<provider>.js) puts the SAME receptionist
// on a real-time voice conversation; the Lab page drives every adapter through this shape and never talks to a
// provider itself:
//
//   const adapter = create<Provider>Adapter()
//   await adapter.start({ customer, id, token, onEvent })   // the Lab session from POST /api/platform/voice-lab/session
//   await adapter.stop({ outcome })   // outcome: the Lab's outcome code (optional), echoed on the final status event
//   adapter.state   // 'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error'
//   adapter.metrics()   // the latest metrics snapshot (same keys as the 'metrics' event)
//
// Events (onEvent({ type, ... })):
//   { type: 'status', status, mode?, reconnects?, reason?, outcome? }   mode: 'speaking' | 'listening' while live
//   { type: 'transcript', who: 'customer' | 'receptionist', text, at }   final lines only (also posted to the session)
//   { type: 'tool', name, ok, simulated, error?, ms }   every business tool call, after our server answered it
//   { type: 'metrics', metrics }   see createTurnMetrics(); the Lab sends the last one with action 'end'
//   { type: 'error', code }   codes only (e.g. microphone, no_microphone, connect_failed, rate_limited, disconnected)
//
// Rules every adapter keeps: provider credentials never reach the browser except a short-lived per-connection
// authorization issued by our server; the model acts only through POST /api/platform/voice-lab/tool (with the
// caller's latest words as userText); transcript lines go to the session with action 'transcript'; reconnects ask the
// server for a fresh authorization and are counted.

export const ADAPTER_STATES = ['idle', 'connecting', 'live', 'reconnecting', 'ended', 'error']

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null)

// Browser-side timing, counted the same way for every provider (numbers only; server/voice/sessions.js METRIC_KEYS):
//   firstResponseMs    end of the caller's first utterance (final transcript) → the agent's first audio
//   medianResponseMs / p95ResponseMs   the same per turn
//   turns, interruptions, toolCalls, toolFailures, reconnects
// A final user transcript arrives a little after speech ends, so response times are slightly optimistic; the same
// bias applies to every provider, which is what the Lab compares.
export function createTurnMetrics(now = () => Date.now()) {
  const responses = []
  let pendingSince = null
  let turns = 0
  let interruptions = 0
  let toolCalls = 0
  let toolFailures = 0
  let reconnects = 0
  return {
    userFinished(at = now()) {
      pendingSince = at
      turns++
    },
    agentStarted(at = now()) {
      if (pendingSince == null) return
      responses.push(Math.max(0, at - pendingSince))
      pendingSince = null
    },
    interrupted() {
      interruptions++
    },
    tool(ok) {
      toolCalls++
      if (!ok) toolFailures++
    },
    reconnected() {
      reconnects++
    },
    snapshot() {
      const sorted = [...responses].sort((a, b) => a - b)
      const m = { turns, interruptions, toolCalls, toolFailures, reconnects }
      if (responses.length) {
        m.firstResponseMs = responses[0]
        m.medianResponseMs = quantile(sorted, 0.5)
        m.p95ResponseMs = quantile(sorted, 0.95)
      }
      return m
    },
  }
}
