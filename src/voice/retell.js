// Retell in the Voice Lab: the PRODUCTION path, not a second one. Retell's browser voice already exists on the public
// chat page (/chat/<business id>, "Talk instead"), where our server creates the call and routes it ONLY by the call id
// it created, and the agent is a custom LLM served by the receptionist engine. The Lab must not change that agent and
// adds nothing to customer routes, so this adapter opens that page for the chosen TEST business in a new tab.
//
// Same shape as the other Lab adapters (src/voice/adapter.js, Agent D): createRetellAdapter() →
// { start({ customer, id, token, onEvent }), state, metrics(), stop({ outcome }) }. Events here: 'status' only
// (connecting → ended with reason 'opened_in_new_tab', or 'error' with reason 'popup_blocked'). No transcript,
// tool or metrics events come from the browser: for Retell, what happened is read from the engine's own records
// (receptionist_events: voice_turn timings, tool outcomes) on the conversation the page created.
export const RETELL_NOTE = 'Retell runs the production agent on the public chat page. Metrics for Retell come from the engine’s recorded events (voice_turn, tool outcomes), not from this browser.'

export function createRetellAdapter() {
  let state = 'idle'
  let openedAt = null
  const metrics = () => ({ turns: 0, interruptions: 0, toolCalls: 0, toolFailures: 0, reconnects: 0, source: 'engine_events' })
  return {
    get state() {
      return state
    },
    metrics,
    async start({ customer, onEvent }) {
      state = 'connecting'
      onEvent?.({ type: 'status', state })
      const id = String(customer || '')
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
        state = 'error'
        onEvent?.({ type: 'error', code: 'invalid_customer', fatal: true })
        onEvent?.({ type: 'status', state, reason: 'invalid_customer' })
        return { ok: false, error: 'invalid_customer' }
      }
      const win = window.open(`/chat/${id}`, '_blank', 'noopener,noreferrer')
      if (!win) {
        state = 'error'
        onEvent?.({ type: 'error', code: 'popup_blocked', fatal: true })
        onEvent?.({ type: 'status', state, reason: 'popup_blocked' })
        return { ok: false, error: 'popup_blocked' }
      }
      openedAt = Date.now()
      state = 'ended'
      onEvent?.({ type: 'status', state, reason: 'opened_in_new_tab' })
      return { ok: true, openedAt, url: `/chat/${id}` }
    },
    stop() {
      state = 'ended'
      return { ok: true }
    },
  }
}
