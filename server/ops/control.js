// Control Center overview: exceptions first. Built from the incident register, the existing customer rows (attention
// flags) and capability health. Test businesses are listed separately and never counted as customer impact.
// `qa` and `activation` are filled by the QA module (server/ops/qa.js) when its tables exist; null = not available.
// Labels/states come from ./states.js (one vocabulary, tested).
import { listIncidents } from './incidents.js'
import { capabilityStatuses } from './review.js'
import { customerRows } from '../metrics.js'
import { INTEGRATION_STATES, integrationState, withPhase } from './states.js'

const DAY = 86400000
const ASSIST = {
  calendar_disconnected: 'Ask the owner to reconnect Google Calendar.',
  setup_stalled: 'Setup stalled for over a day: offer help finishing setup.',
  past_due: 'Payment problem: check billing with the owner.',
  checkout_abandoned: 'Checkout not completed: follow up if they still want to start.',
  booking_failures: 'Booking failures in the last 7 days: open the account.',
  no_owner: 'No owner account: resend or create the invitation.',
  invite_pending: 'Invitation not accepted after 3 days: follow up.',
  domain_problem: 'Own domain needs attention: open Website settings.',
  ads_running_on_hold: 'Ads running while on hold: check the safety stop now.',
}
export const ATTENTION_LABEL = {
  suspended: 'Suspended', past_due: 'Payment failed', ads_running_on_hold: 'Ads running while on hold', deletion_stuck: 'Deletion stuck',
  booking_failures: 'Booking failures', calendar_disconnected: 'Calendar disconnected', setup_stalled: 'Setup stalled', checkout_abandoned: 'Didn’t finish checkout',
  cancel_scheduled: 'Cancellation scheduled', subscription_ended: 'Subscription ended', recovery_ending: 'Recovery period ending', recovery_ended: 'Recovery period ended',
  domain_activation: 'Domain waiting to activate', domain_problem: 'Domain problem', invite_pending: 'Invite not accepted', no_owner: 'No owner', no_recent_bookings: 'No bookings in 14 days',
}

export function presentIntegration(c, incidents) {
  const state = integrationState(c)
  const affected = [...new Set(incidents.filter((i) => i.status === 'open' && i.feature === c.id && i.customer).map((i) => i.customer))]
  return {
    id: c.id, name: c.name, external: c.external, description: (c.description || '').replace(/\s*\([^)]*\.(js|mjs)[^)]*\)/g, '') || null, status: c.status, health: c.health, mode: c.mode,
    state, stateLabel: INTEGRATION_STATES[state].label, tone: INTEGRATION_STATES[state].tone,
    stateExplain: state === 'failed' && !(c.openFailures || []).length && c.verification?.problem ? `The latest automatic check reported a problem${c.verification.evidence ? `: ${c.verification.evidence}` : '.'}` : INTEGRATION_STATES[state].explain,
    note: c.note, approval: c.approval, verification: c.verification, lastSuccess: c.events?.lastSuccess ?? null, lastFailure: c.events?.lastFailure ?? null,
    failures7: c.events?.failures7 ?? 0, openFailures: (c.openFailures || []).length, openIncidents: incidents.filter((i) => i.status === 'open' && i.feature === c.id).map((i) => i.id),
    affectedBusinesses: affected, usedBy: c.usedBy || [], blockedBy: c.blockedBy || [], blockers: c.blockers || [],
  }
}

export async function controlOverview(env, now = Date.now(), extras = {}) {
  const db = env.ONBOARDING_DB
  const incidents = await listIncidents(db, { limit: 200 })
  const open = incidents.filter((i) => i.status === 'open')
  const real = open.filter((i) => !i.test)
  const rows = await customerRows(env, now).catch(() => [])
  const names = new Map(rows.map((r) => [r.id, r.name]))
  const affected = [...new Set(real.map((i) => i.customer).filter(Boolean))]
  const assistance = rows
    .filter((r) => !r.deleted && !r.testBusiness && r.attention?.length)
    .map((r) => ({ id: r.id, name: r.name, attention: r.attention, labels: r.attention.map((a) => ATTENTION_LABEL[a] || a), actions: r.attention.map((a) => ASSIST[a]).filter(Boolean) }))
  const caps = await capabilityStatuses(env, now).catch(() => [])
  const integrations = caps.filter((c) => c.external).map((c) => presentIntegration(c, incidents))
  const SEV = { critical: 0, high: 1, medium: 2, low: 3 }
  const withName = (i) => ({ ...withPhase(i, now), businessName: names.get(i.customer) || null })
  const nextActions = [
    ...real
      .filter((i) => ['critical', 'high'].includes(i.severity))
      .sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.lastSeen - a.lastSeen)
      .slice(0, 5)
      .map((i) => ({ kind: 'incident', incident: i.id, customer: i.customer, severity: i.severity, text: i.recovery })),
    ...assistance.slice(0, 5).flatMap((a) => a.actions.slice(0, 1).map((text) => ({ kind: 'account', customer: a.id, severity: 'medium', text }))),
  ]
  // Needs attention: EVERY open incident and every account needing help, triaged act vs monitor (never "nothing needs
  // action" while something is open). Real customer problems first, then platform, then test accounts.
  const attention = [
    ...[...open]
      .sort((a, b) => Number(a.test) - Number(b.test) || SEV[a.severity] - SEV[b.severity] || b.lastSeen - a.lastSeen)
      .slice(0, 20)
      .map((i) => withPhase(i, now))
      .map((i) => ({ kind: 'incident', id: i.id, severity: i.severity, title: i.title, scope: i.scope, customer: i.customer, businessName: names.get(i.customer) || null, test: i.test, impact: i.impact, phase: i.phase, phaseLabel: i.phaseLabel, phaseTone: i.phaseTone, next: i.next, ...i.triage })),
    ...assistance.slice(0, 10).map((a) => ({ kind: 'account', id: a.id, severity: 'medium', title: a.labels.join(' · '), scope: 'account', customer: a.id, businessName: a.name, test: false, impact: null, phase: null, next: a.actions[0] || 'Open the account.', action: 'act', why: 'Account flagged by its records.' })),
  ]
  attention.sort((a, b) => (a.action === 'act' ? 0 : 1) - (b.action === 'act' ? 0 : 1))
  // Before real customers: switches that stay off until approved (from the capability registry), plus activation.
  const approvals = caps.filter((c) => c.approval && ['disabled', 'sandbox'].includes(c.status)).map((c) => ({ id: c.id, name: c.name, approval: c.approval, state: integrationState(c) }))
  return {
    generatedAt: now,
    incidents: {
      critical: real.filter((i) => i.severity === 'critical').length,
      open: real.length,
      openTest: open.length - real.length,
      openAll: open.length,
      resolved7d: incidents.filter((i) => i.status === 'resolved' && i.resolvedAt >= now - 7 * DAY).length,
      list: open.slice(0, 50).map(withName),
      recentlyResolved: incidents.filter((i) => i.status === 'resolved').slice(0, 10).map(withName),
    },
    affectedBusinesses: affected.map((id) => ({ id, name: names.get(id) || id })),
    assistance,
    attention,
    integrations,
    approvals,
    businesses: rows.filter((r) => !r.deleted).map((r) => ({ id: r.id, name: r.name, test: r.testBusiness, onboarding: r.onboarding, attention: r.attention, labels: (r.attention || []).map((a) => ATTENTION_LABEL[a] || a), createdAt: r.createdAt, affected: affected.includes(r.id), appointmentMode: r.appointmentMode || null })),
    qa: extras.qa ?? null,
    activation: extras.activation ?? null,
    nextActions,
  }
}
