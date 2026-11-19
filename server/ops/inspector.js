// Account Inspector + Customer Journey Inspector (Control Center). Platform-admin read views composed from the same
// authoritative records the product uses (no copies): Business Review (server/ops/review.js), onboarding steps
// (server/onboarding.js), hosting, receptionist/voice gates, messages/outbox counts, the incident register.
// Counts and codes only: never lead/customer contact details, never credentials or calendar contents.
// Support never signs in as the customer: "customer view" = the exact onboarding checklist and public pages the
// owner/customers see, rendered from records. The one active check (diagnoseCalendar) is read-only toward Google
// (token refresh + freeBusy: busy-interval COUNT only), rate-limited and audited by the route.
import { businessReview } from './review.js'
import { listIncidents } from './incidents.js'
import { journey as journeyDef } from './journeys.js'
import { onboardingSteps } from '../onboarding.js'
import { customerFromRow } from '../auth.js'
import { getCustomer } from '../customers.js'
import { hostingStatus, isHosted } from '../website.js'
import { messagesLive } from '../email.js'
import { stripeLiveEnabled } from '../stripe.js'
import { getSettings, modelConfigured } from '../receptionist/engine.js'
import { voiceStatus } from '../receptionist/voice.js'
import { openSlots } from '../booking.js'

const DAY = 86400000
const safe = async (fn, fallback) => {
  try {
    return await fn()
  } catch (err) {
    console.error('inspector check failed:', err?.message?.includes('no such table') ? 'table_missing' : err?.name)
    return fallback
  }
}

const STEP_TITLES = { business: 'Business created', payment: 'Plan and payment', details: 'Business details', services: 'Services', calendar: 'Google Calendar', hours: 'Booking hours', website: 'Website', address: 'Website address', publish: 'Publish', launch: 'Launch' }
const SELF_SERVE = ['business', 'payment', 'details', 'services', 'calendar', 'hours', 'website', 'address', 'publish', 'launch']

// Journey type for this business (primary) + flags. From records only.
export function journeyType({ testBusiness, createdVia, selfServe, complete, recovering }) {
  const primary = testBusiness ? 'test' : createdVia === 'admin_invite' || createdVia === 'admin_link' ? 'invited' : selfServe ? 'new' : 'existing'
  return { primary, incomplete: !complete, recovery: recovering }
}

// Step states: completed | current | blocked | failed | skipped | unknown, each with a reason code.
export function journeySteps({ onboarding, incidents, bookable, billingLive, messages }) {
  if (!onboarding) return SELF_SERVE.map((id) => ({ id, title: STEP_TITLES[id], state: 'unknown', reason: 'check_failed' }))
  const open = incidents.filter((i) => i.status === 'open')
  const failedStep = (id) => (id === 'calendar' ? open.find((i) => i.kind === 'calendar') : null)
  const have = new Map(onboarding.steps.map((s) => [s.id, s]))
  const out = []
  let currentSet = false
  for (const id of SELF_SERVE) {
    const s = have.get(id)
    if (!s) {
      out.push({ id, title: STEP_TITLES[id], state: 'skipped', reason: 'legacy_setup' })
      continue
    }
    const inc = failedStep(id)
    if (inc) out.push({ id, title: STEP_TITLES[id], state: 'failed', reason: inc.code, incident: inc.id })
    else if (s.done) out.push({ id, title: STEP_TITLES[id], state: 'completed' })
    else if (!currentSet && id === 'payment' && !billingLive && onboarding.billing === 'required') {
      out.push({ id, title: STEP_TITLES[id], state: 'blocked', reason: 'billing_not_live' })
      currentSet = true
    } else if (!currentSet) {
      out.push({ id, title: STEP_TITLES[id], state: 'current' })
      currentSet = true
    } else out.push({ id, title: STEP_TITLES[id], state: 'blocked', reason: 'earlier_step' })
  }
  // Operating after setup: can customers book, do messages go out?
  const avail = open.find((i) => i.kind === 'availability' || i.kind === 'calendar')
  out.push(avail ? { id: 'booking_live', title: 'Customers can book', state: 'failed', reason: avail.code, incident: avail.id } : bookable ? { id: 'booking_live', title: 'Customers can book', state: 'completed' } : { id: 'booking_live', title: 'Customers can book', state: currentSet ? 'blocked' : 'failed', reason: 'not_bookable' })
  const comms = open.find((i) => i.kind === 'comms')
  out.push(comms ? { id: 'messages', title: 'Messages delivered', state: 'failed', reason: comms.code, incident: comms.id } : messages.gate === 'test_only' ? { id: 'messages', title: 'Messages delivered', state: 'skipped', reason: 'test_mode' } : { id: 'messages', title: 'Messages delivered', state: messages.sent7 > 0 ? 'completed' : 'unknown', reason: messages.sent7 > 0 ? null : 'no_messages_yet' })
  return out
}

export async function inspectAccount(env, id, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const base = await businessReview(env, id, now)
  if (!base) return null
  const customer = customerFromRow(await getCustomer(db, id))
  const calendar = Boolean(base.calendarConnected)
  const onboarding = await safe(() => onboardingSteps(env, customer, { calendar }), null)
  const hosting = await safe(() => hostingStatus(db, id, now, env), 'unknown')
  const bookable = Boolean(customer && customer.status === 'active' && customer.hoursConfirmed && calendar && isHosted(hosting))
  const lastLookup = await safe(() => db.prepare("SELECT outcome, at FROM audit_log WHERE customer = ?1 AND capability = 'calendar.google' AND resource_type = 'availability' ORDER BY seq DESC LIMIT 1").bind(id).first(), null)
  const msg = await safe(
    () =>
      db
        .prepare(
          `SELECT sum(status = 'sent') AS sent, sum(status = 'failed') AS failed, sum(status = 'skipped') AS skipped, sum(status = 'scheduled') AS scheduled,
                  (SELECT count(*) FROM email_outbox o WHERE o.customer = ?1 AND o.status = 'failed' AND o.created_at >= ?2 AND o.error <> 'test_mode') AS outbox_failed
             FROM messages WHERE customer = ?1 AND updated_at >= ?2`,
        )
        .bind(id, now - 7 * DAY)
        .first(),
    {},
  )
  const messages = { gate: messagesLive(env) && !base.testBusiness ? 'live' : 'test_only', sent7: msg?.sent || 0, failed7: (msg?.failed || 0) + (msg?.outbox_failed || 0), skipped7: msg?.skipped || 0, scheduled: msg?.scheduled || 0 }
  const receptionist = await safe(() => getSettings(db, id), { enabled: false })
  const incidents = await safe(() => listIncidents(db, { customer: id, limit: 30 }), [])
  const billingLive = stripeLiveEnabled(env)
  const steps = journeySteps({ onboarding, incidents, bookable, billingLive, messages })
  const complete = steps.filter((s) => SELF_SERVE.includes(s.id)).every((s) => ['completed', 'skipped'].includes(s.state))
  const recovering = incidents.some((i) => i.status === 'open' && ['calendar', 'availability'].includes(i.kind))
  const type = journeyType({ testBusiness: base.testBusiness, createdVia: base.createdVia ?? customer?.createdVia, selfServe: Boolean(onboarding?.selfServe), complete, recovering })
  return {
    identity: { id, name: base.name, status: base.status, test: base.testBusiness, deleted: base.deleted, createdAt: base.createdAt, attention: base.attention },
    journey: {
      type,
      definition: type.recovery ? 'calendar-recovery' : type.primary === 'invited' ? 'invited-user' : type.primary === 'existing' ? 'returning-owner' : 'activation',
      title: journeyDef(type.recovery ? 'calendar-recovery' : type.primary === 'invited' ? 'invited-user' : type.primary === 'existing' ? 'returning-owner' : 'activation')?.title,
      steps,
    },
    website: { ...base.website, hosting },
    calendar: { connected: calendar, lastLookup: lastLookup ? { outcome: lastLookup.outcome, at: lastLookup.at } : null },
    booking: { ready: bookable, reasons: bookable ? [] : [!customer || customer.status !== 'active' ? 'not_active' : null, customer?.hoursConfirmed ? null : 'hours_not_confirmed', calendar ? null : 'calendar_not_connected', isHosted(hosting) ? null : `hosting_${hosting}`].filter(Boolean) },
    communications: messages,
    voice: { receptionist: Boolean(receptionist?.enabled), model: modelConfigured(env), status: voiceStatus(env, id) },
    billing: { selfServe: Boolean(onboarding?.selfServe), state: onboarding?.billing ?? 'unknown', liveBilling: billingLive, lifecycle: base.lifecycle ? { stage: base.lifecycle.stage ?? null, subscription: base.lifecycle.subscription?.status ?? null, hosting: base.lifecycle.hosting ?? null } : null },
    incidents,
    history: (base.events || []).slice(0, 25).map((e) => ({ at: e.at, action: e.action, outcome: e.outcome, capability: e.capability })),
    capabilities: base.capabilities,
    // Customer-view previews: what the owner's checklist says, and the public pages customers see. No impersonation.
    customerView: {
      ownerChecklist: (onboarding?.steps || []).map((s) => ({ id: s.id, title: STEP_TITLES[s.id] || s.id, done: s.done })),
      publicPages: [base.website?.live ? { label: 'Website', href: `/p/${id}` } : null, bookable ? { label: 'Booking page', href: `/book/${id}` } : null, receptionist?.enabled ? { label: 'Chat', href: `/chat/${id}` } : null].filter(Boolean),
    },
  }
}

// Read-only calendar diagnosis: connection (token refresh) + freeBusy via the booking engine's own lookup. Returns
// codes and counts only (never events, never the account email). Not recorded as an availability event, so a support
// check never closes or opens an incident.
export async function diagnoseCalendar(env, id, now = Date.now()) {
  const customer = customerFromRow(await getCustomer(env.ONBOARDING_DB, id))
  if (!customer) return null
  const started = Date.now()
  const r = await safe(() => openSlots(env, customer, now), { ok: false, status: 'check_failed' })
  return { checkedAt: now, ms: Date.now() - started, ok: Boolean(r.ok), code: r.ok ? (r.slots?.length ? 'times_available' : 'no_free_time') : r.status || 'calendar_error', openTimes: r.ok ? r.slots?.length ?? 0 : null }
}
