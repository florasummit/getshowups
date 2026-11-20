// Control Center vocabulary: the ONE place that turns records into plain-English states. Pure functions (no I/O), so
// every label the founder reads is defined here and covered by tests. Evidence-based: nothing is called healthy,
// working or recovered without a recorded success; a deliberately disabled feature is never called failed.

const DAY = 86400000

// ---------- integrations (capability registry rows from server/ops/review.js capabilityStatuses) ----------
// healthy        seen working recently (a verification or success on record)
// degraded       was seen working, not recently
// failed         an open failure (no later success) or a failed verification
// disabled       switched off on purpose (a release switch / approval)
// setup_required not configured (credentials or setup missing)
// testing        runs in test / sandbox mode only (no live traffic)
// unknown        on, but no evidence either way yet ("not verified")
export const INTEGRATION_STATES = {
  healthy: { label: 'Healthy', tone: 'ok', explain: 'Seen working recently.' },
  degraded: { label: 'Degraded', tone: 'warn', explain: 'Was seen working, but not recently.' },
  failed: { label: 'Failed', tone: 'bad', explain: 'A recent failure has not been followed by a success.' },
  disabled: { label: 'Disabled', tone: 'neutral', explain: 'Switched off on purpose. Turning it on needs approval.' },
  setup_required: { label: 'Setup required', tone: 'neutral', explain: 'Not configured yet.' },
  testing: { label: 'Testing', tone: 'info', explain: 'Runs in test mode only; no live customer traffic.' },
  unknown: { label: 'Not verified', tone: 'neutral', explain: 'Switched on, but no recorded evidence that it works yet.' },
}
export function integrationState(cap) {
  const mode = cap?.mode
  if (!cap || mode === 'unknown' || !mode) return 'unknown'
  if (mode === 'disabled') return 'disabled'
  if (mode === 'missing') return 'setup_required'
  if (cap.health === 'failing') return 'failed'
  if (mode === 'sandbox') return 'testing'
  if (cap.health === 'healthy') return 'healthy'
  if (cap.health === 'degraded') return 'degraded'
  return 'unknown'
}

// ---------- incidents ----------
// active            still failing: a failure in the last 24 h, no success since
// quiet             still open, no new failure for a day or more, and no success either: awaiting verification
// recovered         resolved on a recorded success (or the calendar reconnected)
// closed_unverified resolved because no new failures were seen in the window: NOT confirmed fixed
export const INCIDENT_PHASES = {
  active: { label: 'Active failure', tone: 'bad' },
  quiet: { label: 'No new failures · awaiting verification', tone: 'warn' },
  recovered: { label: 'Recovered · success confirmed', tone: 'ok' },
  closed_unverified: { label: 'Closed · no new failures (not confirmed fixed)', tone: 'neutral' },
}
export function incidentPhase(i, now = Date.now()) {
  if (i.status === 'open') return now - (i.lastSeen || 0) < DAY ? 'active' : 'quiet'
  return i.resolution === 'success_seen' || i.resolution === 'connected' ? 'recovered' : 'closed_unverified'
}
export const quietDays = (i, now = Date.now()) => Math.floor((now - (i.lastSeen || now)) / DAY)

// Act now vs watch: the founder's triage for an OPEN incident. Never "monitor" a real customer's critical/high problem.
export function triage(i) {
  if (i.test) return { action: 'monitor', why: 'Test account: recorded for QA, not customer impact.' }
  if (['critical', 'high'].includes(i.severity)) return { action: 'act', why: i.customer ? 'A customer’s booking or messages are affected.' : 'Platform-wide and high severity.' }
  if (i.customer) return { action: 'act', why: 'One business is affected; check the account.' }
  return { action: 'monitor', why: 'Platform-wide, medium severity, and no business is linked to it. Check the evidence once, then watch for new failures.' }
}

// ---------- account readiness (inspectAccount) ----------
// Each area: one state from a fixed set, never collapsing "configured" into "working".
export const READINESS_STATES = {
  verified: { label: 'Verified working', tone: 'ok' },
  configured: { label: 'Configured · not verified', tone: 'info' },
  enabled: { label: 'Enabled', tone: 'info' },
  eligible: { label: 'Eligible', tone: 'info' },
  test_mode: { label: 'Test mode', tone: 'neutral' },
  not_set_up: { label: 'Not set up', tone: 'neutral' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
}
const BOOKING_REASON = { not_active: 'business is not active', hours_not_confirmed: 'booking hours not confirmed', calendar_not_connected: 'no calendar connected' }
const reasonText = (r) => BOOKING_REASON[r] || (r.startsWith('hosting_') ? `website hosting is ${r.slice(8)}` : r.replace(/_/g, ' '))

export function accountReadiness(a) {
  const openCal = a.incidents.find((i) => i.status === 'open' && ['calendar', 'availability'].includes(i.kind))
  const openComms = a.incidents.find((i) => i.status === 'open' && i.kind === 'comms')
  const lookupOk = a.calendar.lastLookup?.outcome === 'success'
  const out = []
  out.push({
    id: 'calendar', label: 'Google Calendar',
    state: openCal ? 'failed' : !a.calendar.connected ? 'not_set_up' : lookupOk ? 'verified' : 'configured',
    detail: openCal ? `Lookups failing (${openCal.code}). See the open incident.` : !a.calendar.connected ? 'No calendar connected.' : lookupOk ? 'Connected; the last availability lookup succeeded.' : a.calendar.lastLookup ? 'Connected; the last lookup did not succeed.' : 'Connected; no availability lookup recorded yet.',
  })
  out.push({
    id: 'booking', label: 'Booking page',
    state: openCal ? 'failed' : !a.booking.ready ? 'not_set_up' : lookupOk ? 'verified' : 'configured',
    detail: openCal ? 'Customers can’t see open times right now.' : !a.booking.ready ? `Not bookable: ${a.booking.reasons.map(reasonText).join(', ')}.` : lookupOk ? 'Bookable; open times were offered recently.' : 'Bookable on paper; no lookup recorded yet.',
  })
  out.push({
    id: 'website', label: 'Website',
    state: a.website.live ? (['active', 'grace'].includes(a.website.hosting) ? 'enabled' : 'failed') : 'not_set_up',
    detail: a.website.live ? `Published${a.website.domain ? ` at ${a.website.domain}` : ''}; hosting ${a.website.hosting}.` : 'Not published.',
  })
  out.push({
    id: 'messages', label: 'Messages',
    state: openComms ? 'failed' : a.communications.gate === 'live' ? (a.communications.sent7 > 0 ? 'verified' : 'enabled') : 'test_mode',
    detail: `${a.communications.gate === 'live' ? 'Live' : 'Only test recipients receive messages (launch gate)'}. Last 7 days: ${a.communications.sent7} sent, ${a.communications.failed7} failed, ${a.communications.skipped7} skipped.`,
  })
  out.push({
    id: 'voice', label: 'Voice receptionist',
    state: a.voice.status === 'not_configured' ? 'disabled' : a.voice.status === 'available' ? (a.voice.receptionist ? 'enabled' : 'eligible') : 'not_applicable',
    detail: a.voice.status === 'not_configured' ? 'Voice is not configured on the platform.' : a.voice.status === 'available' ? `On the voice allowlist; receptionist is ${a.voice.receptionist ? 'on' : 'off'}.` : 'Not on the voice allowlist (chat only).',
  })
  out.push({
    id: 'billing', label: 'Billing',
    state: !a.billing.selfServe ? 'not_applicable' : a.billing.liveBilling ? 'enabled' : 'test_mode',
    detail: !a.billing.selfServe ? 'Never billed (pilot, invited or admin-created).' : `${a.billing.liveBilling ? 'Live billing' : 'Test billing only (live billing is off)'}; ${String(a.billing.state).replace(/_/g, ' ')}.`,
  })
  return out
}

// ---------- plain-English journey reasons ----------
export const STEP_REASONS = {
  legacy_setup: 'Not part of this account’s setup (created before self-serve onboarding)',
  earlier_step: 'Waiting on an earlier step',
  billing_not_live: 'Live billing is off, so this step can’t be completed by a real customer yet',
  check_failed: 'Couldn’t be checked',
  not_bookable: 'Not bookable yet',
  test_mode: 'Messages go to test recipients only',
  no_messages_yet: 'No message sent in the last 7 days',
}

// An incident with its phase label attached (one vocabulary on every screen).
export function withPhase(i, now = Date.now()) {
  const phase = incidentPhase(i, now)
  const days = i.status === 'open' && phase === 'quiet' ? quietDays(i, now) : null
  return { ...i, phase, phaseLabel: days ? `No new failures for ${days} day${days === 1 ? '' : 's'} · awaiting verification` : INCIDENT_PHASES[phase].label, phaseTone: INCIDENT_PHASES[phase].tone, ...(i.status === 'open' ? { triage: triage(i) } : {}) }
}
