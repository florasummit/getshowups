// "This week": the founder's prioritized list of material issues and next actions, WITHOUT a model call. Deterministic
// rules over the records (server/admin-assist/data.js), urgent → important → FYI, each with the admin page that
// resolves it. Shown at the top of Admin → Overview and as the assistant's first message; the assistant's lookups read
// the same list (tools.js weekly_brief). Real businesses only: test businesses and deleted accounts never appear.
// Business names are platform records the admin sees anyway; no contact detail is ever part of an item.
import { ADMIN_ANSWERS_PER_DAY, billingOf, DAY, integrationsOf, loaders } from './data.js'

export const LEVELS = ['urgent', 'important', 'fyi']
export const STUCK_PAID_DAYS = 7 // paid, but the ownership invitation not sent after this many days
export const EXPIRING_DAYS = 2 // an unaccepted invitation that expires within this many days
export const RECONCILE_STALE_DAYS = 2
export const SPEND_WARN = 0.8 // share of a daily ceiling that is "near"
const ENROLLMENT_OWNS = ['calendar_disconnected', 'setup_stalled', 'checkout_abandoned', 'no_owner', 'invite_pending']

const days = (ms) => Math.max(0, Math.floor(ms / DAY))
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
const bizHref = (id) => `/admin?business=${encodeURIComponent(id)}`
const ago = (now, t) => {
  const d = days(now - t)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

// One item per business for a rule, or one grouped item when many businesses share it (keeps the list short).
function perBusiness(out, level, rule, list, title, { detail = null, next, group = 3 }) {
  if (!list.length) return
  if (list.length > group) {
    out.push({ id: `${rule}:group`, rule, level, title: `${title}: ${plural(list.length, 'business')}`, detail: list.slice(0, 4).map((r) => r.name).join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : ''), next, href: '/admin', businesses: list.map((r) => ({ id: r.id, name: r.name })), count: list.length })
    return
  }
  for (const r of list) out.push({ id: `${rule}:${r.id}`, rule, level, title: `${title}: ${r.name}`, detail: detail?.(r) ?? null, next, href: bizHref(r.id), business: { id: r.id, name: r.name } })
}

export async function weeklyBrief(env, now = Date.now(), L = loaders(env, now)) {
  const [rows0, modes, selfServe, incidents, recon, enr0, enrInv, invites, acq, caps, spend, tests] = await Promise.all([L.rows(), L.modes(), L.selfServe(), L.incidents(), L.reconciliation(), L.enrollments(), L.enrollmentInvites(), L.invites(), L.acquisition(), L.caps(), L.adminSpendToday(), L.tests()])
  // Enrollments of admin-marked test businesses are never on the list.
  const enr = enr0 && { ...enr0, list: enr0.list.filter((e) => !tests?.has(e.customer)) }
  const out = []
  const unread = []
  if (!rows0) unread.push('customer records')
  const rows = (rows0 || []).filter((r) => !r.testBusiness && !r.deleted)
  const bill = (r) => billingOf(r, modes, L.live, selfServe)
  // Serving customers: a paid subscription (live or test mode), a complimentary account or a never-billed pilot.
  const serving = (r) => ['active', 'trialing', 'past_due', 'test', 'complimentary', 'not_billed'].includes(bill(r).state)

  // Businesses in an assisted enrollment that the owner hasn't claimed yet: their setup, calendar, payment and invitation
  // are the enrollment's (one item there), never repeated as account flags.
  const enrolled = new Set((enr?.list || []).filter((e) => e.stage !== 'claimed').map((e) => e.customer).filter(Boolean))
  const has = (a) => rows.filter((r) => r.attention.includes(a) && !(enrolled.has(r.id) && ENROLLMENT_OWNS.includes(a)))

  // ---------- urgent ----------
  perBusiness(out, 'urgent', 'past_due', has('past_due'), 'Payment failed', { detail: (r) => bill(r).words, next: 'Check billing with the owner. Payment retries and refunds happen in Stripe.', group: 5 })
  perBusiness(out, 'urgent', 'ads_running_on_hold', has('ads_running_on_hold'), 'Ads still running while on hold', { next: 'Open the business and check the ads safety stop now.' })
  perBusiness(out, 'urgent', 'deletion_stuck', has('deletion_stuck'), 'Account deletion stuck', { next: 'Open the deletion record on the business.' })
  const cal = has('calendar_disconnected')
  perBusiness(out, 'urgent', 'calendar_disconnected', cal.filter(serving), 'Calendar disconnected on a serving business', { detail: (r) => `${bill(r).words}. Customers can't see open times until the owner reconnects Google Calendar.`, next: 'Ask the owner to reconnect Google Calendar (Dashboard → Settings).' })
  const real = (incidents || []).filter((i) => !i.test)
  const names = new Map((rows0 || []).map((r) => [r.id, r.name]))
  for (const i of real.filter((x) => ['critical', 'high'].includes(x.severity)).slice(0, 5)) {
    out.push({ id: `incident:${i.id}`, rule: 'incident', level: 'urgent', title: `${i.severity === 'critical' ? 'Critical' : 'High'} incident: ${i.title}${i.customer && names.get(i.customer) ? ` (${names.get(i.customer)})` : ''}`, detail: `Opened ${ago(now, i.firstSeen)}, last seen ${ago(now, i.lastSeen)}; ${plural(i.occurrences, 'occurrence')}.`, next: i.next || i.recovery || 'Open it in the Control Center.', href: `/admin/control?incident=${encodeURIComponent(i.id)}`, incident: i.id, ...(i.customer ? { business: { id: i.customer, name: names.get(i.customer) || i.customer } } : {}) })
  }
  if (recon?.real > 0) out.push({ id: 'reconciliation:mismatch', rule: 'reconciliation', level: 'urgent', title: `Billing records don't match Stripe: ${plural(recon.real, 'issue')} on real businesses`, detail: `Last reconciliation ${ago(now, recon.at)}.`, next: 'Open Billing reconciliation on Overview and resync the business from Stripe if Stripe is right.', href: '/admin#reconciliation' })

  // ---------- important ----------
  perBusiness(out, 'important', 'booking_failures', has('booking_failures'), 'Booking failures in the last 7 days', { next: 'Open the business; the Control Center shows the failure codes.' })
  perBusiness(out, 'important', 'calendar_disconnected', cal.filter((r) => !serving(r)), 'Calendar disconnected', { detail: (r) => bill(r).words, next: 'Ask the owner to reconnect Google Calendar.' })
  if (enr?.ready) {
    const inv = enrInv || new Map()
    for (const e of enr.list.filter((x) => x.stale)) out.push({ id: `enrollment_stale:${e.id}`, rule: 'enrollment_stuck', level: 'important', title: `Enrollment stuck before payment: ${e.businessName}`, detail: e.paymentSentAt ? `Payment link sent ${ago(now, e.paymentSentAt)} (${plural(e.paymentSends || 1, 'time')}); started ${ago(now, e.createdAt)}.` : `Started ${ago(now, e.createdAt)}; no payment link sent.`, next: 'Follow up, or mark it abandoned in Sales.', href: '/admin/sales', enrollment: { id: e.id, name: e.businessName } })
    for (const e of enr.list.filter((x) => ['paid', 'configuring', 'ready'].includes(x.stage) && x.paidAt && now - x.paidAt > STUCK_PAID_DAYS * DAY)) out.push({ id: `enrollment_paid:${e.id}`, rule: 'enrollment_stuck', level: 'important', title: `Paid but not handed over: ${e.businessName}`, detail: `Paid ${ago(now, e.paidAt)}; the ownership invitation hasn't been sent.`, next: e.stage === 'ready' ? 'Send the ownership invitation in Sales.' : 'Finish the required setup, then send the ownership invitation.', href: '/admin/sales', enrollment: { id: e.id, name: e.businessName } })
    for (const e of enr.list.filter((x) => x.stage === 'invited')) {
      const i = inv.get(e.id)
      if (!i || i.accepted_at || i.revoked_at) continue
      if (i.expires_at <= now) out.push({ id: `enrollment_invite_expired:${e.id}`, rule: 'invitation_expiring', level: 'important', title: `Ownership invitation expired: ${e.businessName}`, detail: `Expired ${ago(now, i.expires_at)}; the owner hasn't claimed the business.`, next: 'Resend the ownership invitation (the assistant can prepare it).', href: '/admin/sales', enrollment: { id: e.id, name: e.businessName }, prepare: 'resend_invitation' })
      else if (i.expires_at - now < EXPIRING_DAYS * DAY) out.push({ id: `enrollment_invite_expiring:${e.id}`, rule: 'invitation_expiring', level: 'important', title: `Ownership invitation expires soon: ${e.businessName}`, detail: `Expires in ${Math.max(1, Math.ceil((i.expires_at - now) / 3_600_000))} hours.`, next: 'Remind the owner, or resend it once it expires.', href: '/admin/sales', enrollment: { id: e.id, name: e.businessName } })
    }
  } else if (enr === null) unread.push('enrollments')
  const byBiz = new Map(rows.map((r) => [r.id, r]))
  for (const i of invites || []) {
    const r = byBiz.get(i.customer)
    if (!r || r.hasOwner || enrolled.has(r.id)) continue
    if (i.expires_at <= now) continue // shown as no_owner / invite_pending by its flags
    if (i.expires_at - now < EXPIRING_DAYS * DAY) out.push({ id: `invite_expiring:${i.id}`, rule: 'invitation_expiring', level: 'important', title: `Owner invitation expires soon: ${r.name}`, detail: `Sent ${ago(now, i.created_at)}; expires in ${Math.max(1, Math.ceil((i.expires_at - now) / 3_600_000))} hours.`, next: 'Remind the owner, or resend the invitation (the assistant can prepare it).', href: bizHref(r.id), business: { id: r.id, name: r.name }, prepare: 'resend_invitation' })
  }
  const expiringIds = new Set(out.filter((x) => x.rule === 'invitation_expiring' && x.business).map((x) => x.business.id))
  perBusiness(out, 'important', 'invite_pending', has('invite_pending').filter((r) => !expiringIds.has(r.id)), 'Owner invitation not accepted after 3 days', { next: 'Follow up with the owner, or resend the invitation.' })
  perBusiness(out, 'important', 'no_owner', has('no_owner'), 'No owner and no open invitation', { next: 'Send a new owner invitation from the business.' })
  perBusiness(out, 'important', 'setup_stalled', has('setup_stalled').filter((r) => r.onboarding !== 'invited' && !r.attention.includes('calendar_disconnected')), 'Setup stalled for over a day', { detail: (r) => ({ calendar: 'Google Calendar not connected yet.', hours: 'Booking hours not set yet.' })[r.onboarding] || null, next: 'Offer the owner help to finish setup.' })
  perBusiness(out, 'important', 'checkout_abandoned', has('checkout_abandoned'), 'Signed up but didn’t pay', { next: 'Follow up if they still want to start.' })
  perBusiness(out, 'important', 'recovery_ending', has('recovery_ending'), 'Recovery period ends within 14 days', { next: 'Contact them before their data recovery window closes.' })
  perBusiness(out, 'important', 'domain_problem', has('domain_problem'), 'Own domain stopped working', { next: 'Open the business’s website settings.' })
  const minor = real.filter((x) => !['critical', 'high'].includes(x.severity))
  if (minor.length) out.push({ id: 'incidents:minor', rule: 'incident', level: 'important', title: `${plural(minor.length, 'open incident')} of medium or low severity`, detail: minor.slice(0, 3).map((i) => i.title).join('; '), next: 'Review them in the Control Center.', href: '/admin/control', count: minor.length })
  // Reconciliation's own check fails while it reports a mismatch: that mismatch is already the item above.
  for (const g of integrationsOf(caps).filter((x) => x.state === 'failed' && !(x.id === 'billing.reconcile' && recon?.real > 0))) out.push({ id: `integration:${g.id}`, rule: 'integration_failed', level: 'important', title: `Integration failing: ${g.name}`, detail: g.failures_7d ? `${plural(g.failures_7d, 'failure')} in the last 7 days, no success since.` : 'Its latest automatic check reported a problem.', next: 'Open it in the Control Center → Integrations.', href: '/admin/control' })
  if (L.billingConfigured && (!recon || now - recon.at > RECONCILE_STALE_DAYS * DAY)) out.push({ id: 'reconciliation:stale', rule: 'reconciliation', level: 'important', title: recon ? `Billing reconciliation last ran ${ago(now, recon.at)}` : 'Billing reconciliation has never run', detail: 'It normally runs every day.', next: 'Run it now (the assistant can prepare it), then check the cron.', href: '/admin#reconciliation', prepare: 'run_reconciliation' })
  if (spend) {
    if (spend.micros >= SPEND_WARN * spend.ceilingMicros || spend.answered >= SPEND_WARN * ADMIN_ANSWERS_PER_DAY) out.push({ id: 'ai:admin', rule: 'ai_spend', level: 'important', title: 'Admin assistant near its daily ceiling', detail: `$${(spend.micros / 1e6).toFixed(2)} of $${(spend.ceilingMicros / 1e6).toFixed(2)} used today (UTC).`, next: 'It stops at the ceiling and resumes at 00:00 UTC; this list keeps working.', href: '/admin' })
    if (spend.ownerAsksToday >= SPEND_WARN * spend.ownerSharedAllowance) out.push({ id: 'ai:owners', rule: 'ai_spend', level: 'important', title: 'Owners’ assistant near its shared daily allowance', detail: `${spend.ownerAsksToday} of ${spend.ownerSharedAllowance} questions used today (UTC).`, next: 'Owners still get answers from their records when it is used up. Raising it needs a decision.', href: '/admin/control' })
  }

  // ---------- FYI ----------
  perBusiness(out, 'fyi', 'cancel_scheduled', has('cancel_scheduled'), 'Cancellation scheduled', { next: 'Ask why, if you want to keep them.' })
  perBusiness(out, 'fyi', 'subscription_ended', has('subscription_ended').filter((r) => !has('recovery_ending').includes(r)), 'Subscription ended', { next: 'Nothing is deleted automatically; they can come back within the recovery period.' })
  perBusiness(out, 'fyi', 'no_recent_bookings', has('no_recent_bookings'), 'No bookings in 14 days', { next: 'Worth a check-in: are they still using GetShowUps?' })
  perBusiness(out, 'fyi', 'domain_activation', has('domain_activation'), 'Own domain waiting to activate', { next: 'Open the business’s domain settings.' })
  perBusiness(out, 'fyi', 'suspended', has('suspended'), 'Suspended', { next: 'Suspension is lifted from the business page.' })
  const due = acq?.totals?.followUpsDue || 0
  if (due) out.push({ id: 'acquisition:followups', rule: 'followups_due', level: 'fyi', title: `${plural(due, 'outreach follow-up')} due`, detail: 'Outreach you recorded as sent at least 4 days ago without a follow-up.', next: 'Follow up, then record it in Growth → Activities.', href: '/admin/growth', count: due })
  if (!L.live) {
    const g = await L.growth()
    const n = g?.billing?.testSubscriptions || 0
    out.push({ id: 'billing:test_mode', rule: 'billing_mode', level: 'fyi', title: 'Billing is in Stripe test mode', detail: n ? `${plural(n, 'test subscription')}; none of it is revenue.` : 'No revenue is counted until live billing is switched on.', next: 'Switching on live billing needs your approval.', href: '/admin' })
  }
  out.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  return { generatedAt: now, items: out, counts: Object.fromEntries(LEVELS.map((l) => [l, out.filter((x) => x.level === l).length])), unreadable: unread }
}
