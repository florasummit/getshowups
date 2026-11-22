// The rollout state of the global voice provider as the console shows it (GlobalProvider.jsx), derived from the
// server's facts (server/voice/global.js globalOverview), never from a click. Plain-English labels.
export const ROLLOUT_STATE = {
  unavailable: ['neutral', 'Not available'],
  not_configured: ['neutral', 'Not configured'],
  needs_verification: ['warn', 'Needs verification'],
  ready: ['ok', 'Ready to promote'],
  promoting: ['info', 'Promoting…'],
  active: ['ok', 'Active for every eligible business'],
  partial: ['warn', 'Partially rolled out'],
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

// The one next action for the situation: test the provider, promote it, or nothing (every business already uses it,
// or it cannot be used yet).
export function nextAction(global, state) {
  if (!global.ready || state === 'not_configured') return 'none'
  if (global.counts.total - global.counts.usingDefault === 0) return 'none'
  return global.verification?.ok ? 'promote' : 'test'
}
