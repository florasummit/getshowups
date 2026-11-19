// Control Center overview: exceptions first. Built from the incident register, the existing customer rows (attention
// flags) and capability health. Test businesses are listed separately and never counted as customer impact.
// `qa` and `activation` are filled by the QA module (server/ops/qa.js) when its tables exist; null = not available.
import { listIncidents } from './incidents.js'
import { capabilityStatuses } from './review.js'
import { customerRows } from '../metrics.js'

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
    .map((r) => ({ id: r.id, name: r.name, attention: r.attention, actions: r.attention.map((a) => ASSIST[a]).filter(Boolean) }))
  const caps = await capabilityStatuses(env, now).catch(() => [])
  const integrations = caps.filter((c) => c.external).map((c) => ({ id: c.id, name: c.name, external: c.external, status: c.status, health: c.health }))
  const SEV = { critical: 0, high: 1, medium: 2, low: 3 }
  const nextActions = [
    ...real
      .filter((i) => ['critical', 'high'].includes(i.severity))
      .sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.lastSeen - a.lastSeen)
      .slice(0, 5)
      .map((i) => ({ kind: 'incident', incident: i.id, customer: i.customer, severity: i.severity, text: i.recovery })),
    ...assistance.slice(0, 5).flatMap((a) => a.actions.slice(0, 1).map((text) => ({ kind: 'account', customer: a.id, severity: 'medium', text }))),
  ]
  return {
    generatedAt: now,
    incidents: {
      critical: real.filter((i) => i.severity === 'critical').length,
      open: real.length,
      openTest: open.length - real.length,
      resolved7d: incidents.filter((i) => i.status === 'resolved' && i.resolvedAt >= now - 7 * DAY).length,
      list: open.slice(0, 50).map((i) => ({ ...i, businessName: names.get(i.customer) || null })),
      recentlyResolved: incidents.filter((i) => i.status === 'resolved').slice(0, 10).map((i) => ({ ...i, businessName: names.get(i.customer) || null })),
    },
    affectedBusinesses: affected.map((id) => ({ id, name: names.get(id) || id })),
    assistance,
    integrations,
    businesses: rows.filter((r) => !r.deleted).map((r) => ({ id: r.id, name: r.name, test: r.testBusiness, onboarding: r.onboarding, attention: r.attention })),
    qa: extras.qa ?? null,
    activation: extras.activation ?? null,
    nextActions,
  }
}
