// The rollout state of the global voice provider as the Voice Lab shows it (GlobalProvider.jsx), derived from the
// server's facts (server/voice/global.js globalOverview), never from a click. Plain-English labels.
export const ROLLOUT_STATE = {
  unavailable: ['neutral', 'Not available'],
  not_configured: ['neutral', 'Not configured'],
  needs_verification: ['warn', 'Needs a test'],
  ready: ['ok', 'Ready to activate'],
  promoting: ['info', 'Activating…'],
  active: ['ok', 'Active for every business'],
  partial: ['warn', 'Active for most businesses'],
  blocked: ['bad', 'Blocked'],
  rolled_back: ['neutral', 'Rolled back'],
}

export function rolloutState(global, { blocked = false, promoting = false } = {}) {
  const cur = global.current
  if (!global.ready) return 'unavailable'
  if (!global.providers.find((p) => p.id === cur.provider)?.configured) return 'not_configured'
  if (promoting) return 'promoting'
  if (blocked) return 'blocked'
  const remaining = global.counts.total - global.counts.usingDefault
  if (remaining === 0) return 'active'
  if (cur.mode === 'all') return 'partial'
  if (cur.mode === 'rollback') return 'rolled_back'
  return global.verification?.ok ? 'ready' : 'needs_verification'
}

// The one next action for the situation: test the provider, activate it for all businesses, or nothing (every
// business already uses it, or it cannot be used yet).
export function nextAction(global, state) {
  if (!global.ready || state === 'not_configured') return 'none'
  if (global.counts.total - global.counts.usingDefault === 0) return 'none'
  return global.verification?.ok ? 'promote' : 'test'
}

// Why the newest finished production-path test did not verify the provider, in the admin's words (codes in, words out).
export const LAST_TEST = {
  ok: 'it showed everything the verification needs.',
  area: 'the receptionist took the service-area path (where the caller is was not on the business’s list) and never offered times or booked.',
  no_tools: 'no tool ran: the receptionist never looked up times.',
  no_availability: 'the availability lookup did not succeed.',
  no_booking: 'times were offered but no booking (dry run) went through.',
  audio: 'audio was not measured both ways (microphone live and AI audio received).',
  connection: 'its connection failed.',
}

// The adapter's disconnect record (server/voice/sessions.js cleanDisconnect: phase, code, WebSocket close code, the
// provider's reason text) in the admin's words. Codes in, words out; the close code and reason are shown as recorded.
export const DISCONNECT = {
  provider_refused: 'the voice provider refused the session (policy close 1008: its agent configuration or account refused it)',
  closed_before_start: 'the voice provider closed the connection normally before the session started',
  socket_closed: 'the connection closed abnormally (1006: the network, a proxy or the browser dropped it)',
  socket_error: 'the WebSocket could not be opened (network error, or blocked)',
  connect_timeout: 'the voice provider did not confirm the session within 20 s',
  payload_too_large: 'the session setup message was too large for the voice provider',
  provider_error: 'the voice provider reported an internal error',
  provider_closed: 'the voice provider closed the connection',
  connect_failed: 'the connection could not be started (no close code was reported)',
  reconnect_failed: 'a reconnect could not be started',
  connection_lost: 'the connection dropped',
  disconnected: 'the connection dropped and two reconnects failed',
  page_closed: 'the page was closed or reloaded during the call',
  microphone: 'the microphone was not allowed',
  no_microphone: 'no microphone was found',
  rate_limited: 'too many connections were started from that address',
  conversation_ended: 'the conversation had already ended',
  session_expired: 'the session had passed its 15-minute ceiling',
  reconnect_limit: 'the session had used its three connections',
  voice_not_configured: 'the provider is not configured on the platform',
  voice_unavailable: 'the provider is switched off on the platform',
}
export const PHASE = { start: 'while connecting', live: 'during the call', reconnect: 'while reconnecting' }
// One line for a disconnect record, or '' without one.
export function disconnectText(d) {
  if (!d?.code) return ''
  const what = DISCONNECT[d.code] || d.code
  const detail = [d.closeCode ? `WebSocket close ${d.closeCode}` : null, d.reason ? `“${d.reason}”` : null].filter(Boolean).join(': ')
  return `Connection record: ${what} ${PHASE[d.phase] || d.phase}${detail ? ` (${detail})` : ''}.`
}
