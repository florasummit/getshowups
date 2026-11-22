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
  connection: 'it ended with a connection failure.',
}
