// What the platform-admin assistant can look up and prepare (server/admin-assist/operator.js runs the conversation).
// Platform admins only (the route checks PLATFORM_ADMIN_EMAILS); the owner assistant (server/operator-tools.js) never
// imports this file and this file never imports the owner tools. Every lookup is fixed, typed and READ-ONLY over the
// records the admin pages already show; every result says its data source and period. Aggregates and references only:
// businesses are [B1], enrollments [E1], partners [P1] (the page fills in names), never contact details, never
// conversation text, never anything a business owner's customer typed. prepare_* tools PREPARE one allowlisted change
// (proposals.js applies it after the admin's explicit Approve); nothing here writes.
import { CUSTOMER_RE } from '../invites.js'
import { ATTENTION_WORDS, billingOf, DAY, integrationsOf, loaders, periodRange, PERIODS, SALES_BUSINESS, SETUP_WORDS } from './data.js'
import { ENROLLMENT_OWNS, weeklyBrief } from './brief.js'
import { STATUSES as CODE_STATUSES } from '../acquisition.js'
import { randomToken } from '../google-oauth.js'
import { QA_TOOLS } from './qa.js'

// Dates as people write them (never ISO: admin copy rule), UTC.
const ymd = (t) => (t ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(t) : null)
const usd = (micros) => (micros == null ? null : `$${(micros / 1e6).toFixed(micros > 0 && micros < 1e6 ? 4 : 2)}`)
const dollars = (cents) => (cents == null ? null : `$${(cents / 100).toFixed(2)}`)
const daysAgo = (now, t) => (t ? Math.floor((now - t) / DAY) : null)
const agoText = (now, t) => {
  const d = daysAgo(now, t)
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`
}
export const REF_RE = /^[BEPQ]\d{1,3}$/
const ID_RE = { B: CUSTOMER_RE, E: /^enr_[A-Za-z0-9_-]{16}$/, P: /^prt_[A-Za-z0-9_-]{4,40}$/, Q: /^qi_[A-Za-z0-9_-]{6,40}$/ }
// Businesses that are real by definition and are never marked as test businesses (CLAUDE.md).
const NEVER_TEST = new Set([SALES_BUSINESS, 'poolthru-llc'])

// ---------- references ----------
// given: { B1: 'harbor-pools', E2: 'enr_…', P1: 'prt_…' } from the conversation in the admin's browser: validated by
// shape here and resolved against the records again by every tool that uses one.
export function adminContext(env, given = {}, now = Date.now()) {
  const refs = new Map()
  const byKey = new Map()
  const next = { B: 1, E: 1, P: 1, Q: 1 }
  for (const [ref, id] of Object.entries(given && typeof given === 'object' ? given : {}).slice(0, 120)) {
    if (!REF_RE.test(ref) || typeof id !== 'string' || !ID_RE[ref[0]].test(id) || byKey.has(`${ref[0]}:${id}`)) continue
    refs.set(ref, { kind: ref[0], id, name: null })
    byKey.set(`${ref[0]}:${id}`, ref)
    next[ref[0]] = Math.max(next[ref[0]], Number(ref.slice(1)) + 1)
  }
  const c = {
    env,
    now,
    L: loaders(env, now),
    refs,
    shown: new Set(), // references that appeared in a lookup THIS turn (or were given): the answer may use them
    proposals: [],
    sources: [],
    ref(kind, id, name) {
      const key = `${kind}:${id}`
      let r = byKey.get(key)
      if (!r) {
        r = `${kind}${next[kind]++}`
        byKey.set(key, r)
        refs.set(r, { kind, id, name: null })
      }
      if (name) refs.get(r).name = String(name).replace(/\s+/g, ' ').trim().slice(0, 80)
      c.shown.add(r)
      return r
    },
    resolve(ref, kind) {
      const r = refs.get(String(ref || '').replace(/[[\]\s]/g, ''))
      return r && (!kind || r.kind === kind) ? r : null
    },
    book: () => Object.fromEntries([...refs].map(([r, v]) => [r, v.id])),
  }
  for (const r of refs.keys()) c.shown.add(r)
  return c
}

// ---------- the lookups ----------
const said = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const nameMatches = (name, id, words) => {
  if (/^\s*\[?[BEPQ]\d{1,3}\]?\s*$/.test(String(words))) return false // a reference, not words: see byRef
  const w = said(words).split(' ').filter((x) => x.length > 2 && !['the', 'and', 'llc', 'inc', 'business', 'company'].includes(x))
  if (!w.length) return false
  const hay = `${said(name)} ${said(id).replace(/-/g, ' ')}`
  return w.every((x) => hay.includes(x)) || w.some((x) => hay.split(' ').includes(x) && x.length > 3)
}

const inviteWords = (i, now) => (!i ? 'not sent' : i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : i.expires_at <= now ? `sent, expired ${ymd(i.expires_at)}` : `sent, expires ${ymd(i.expires_at)}`)

async function businesses(c, { which = 'all', name = '', ref = '' } = {}) {
  // "the first one": a reference from earlier, given as ref or (by mistake) as the name.
  const given = c.resolve(ref || name, 'B')
  if (given) name = ''
  const L = c.L
  const [rows, modes, receptionist, selfServe, enr, inv] = await Promise.all([L.rows(), L.modes(), L.receptionist(), L.selfServe(), L.enrollments(), L.enrollmentInvites()])
  if (!rows) return { source: 'customer records', error: 'could_not_be_read' }
  const enrolled = new Map((enr?.list || []).filter((e) => e.customer && e.stage !== 'claimed').map((e) => [e.customer, e]))
  const real = rows.filter((r) => !r.deleted && !r.testBusiness)
  let list = real
  if (given) list = rows.filter((r) => r.id === given.id)
  else if (name) list = rows.filter((r) => !r.deleted && nameMatches(r.name, r.id, name))
  const bill = (r) => billingOf(r, modes, L.live, selfServe)
  if (!name && !given) {
    if (which === 'paying' || which === 'at_risk') list = real.filter((r) => (bill(r).paying || bill(r).testPaying) && !enrolled.has(r.id))
    if (which === 'at_risk') list = list.filter((r) => signalsOf(r).length)
    else if (which === 'needs_attention') list = real.filter((r) => r.attention.length)
    else if (which === 'not_live') list = real.filter((r) => r.onboarding !== 'live')
    else if (which === 'live') list = real.filter((r) => r.onboarding === 'live')
  }
  function signalsOf(r) {
    return enrolled.has(r.id) ? [] : [
      r.attention.includes('past_due') && 'payment failed',
      r.attention.includes('cancel_scheduled') && 'cancellation scheduled',
      r.attention.includes('no_recent_bookings') && 'no bookings in 14 days',
      r.attention.includes('calendar_disconnected') && 'calendar disconnected',
      r.onboarding === 'live' && r.leads30 === 0 && 'no inquiries in 30 days',
      receptionist?.get(r.id) === false && r.onboarding === 'live' && 'receptionist turned off',
    ].filter(Boolean)
  }
  const out = (r) => {
    const b = bill(r)
    const flags = enrolled.has(r.id) ? r.attention.filter((a) => !ENROLLMENT_OWNS.includes(a)) : r.attention
    const signals = signalsOf(r)
    const ref = c.ref('B', r.id, r.name)
    ;(c.signals ||= new Map()).set(ref, signals.length)
    return {
      ref,
      setup: SETUP_WORDS[r.onboarding] || r.onboarding,
      billing: b.words,
      account_type: r.account?.classification || 'customer',
      ...(r.testBusiness ? { test_business: true } : {}),
      ...(enrolled.has(r.id) ? { assisted_enrollment: { enrollment: c.ref('E', enrolled.get(r.id).id, enrolled.get(r.id).businessName), stage: enrolled.get(r.id).stage, owner_claimed: false, ownership_invitation: inviteWords(inv?.get(enrolled.get(r.id).id), c.now) } } : {}),
      calendar: r.calendarConnected ? 'connected' : 'not connected',
      receptionist: receptionist ? (receptionist.get(r.id) ? 'on' : 'off') : 'could not be read',
      inquiries_last_30_days: r.leads30,
      bookings_last_30_days: r.booked30,
      last_booking: r.lastBooking ? `${ymd(r.lastBooking)} (${agoText(c.now, r.lastBooking)})` : 'none recorded',
      owner_signed_in: r.hasOwner,
      created: ymd(r.createdAt),
      attention: flags.map((a) => ATTENTION_WORDS[a] || a),
      churn_signals: signals,
    }
  }
  return {
    source: 'customer records, subscriptions, receptionist settings (as on Overview)',
    period: 'inquiries and bookings: last 30 days; flags: as of now',
    billing_mode: L.live ? 'live' : 'Stripe test mode: no business is a paying customer yet; "test mode" subscriptions are not revenue',
    asked: given ? `[${ref || name}]` : name ? `businesses matching "${String(name).slice(0, 40)}"` : which,
    matches: list.length,
    ...(name && list.length > 1 ? { note: 'Several businesses match: if the question fits only one, answer about it; otherwise ask which.' } : {}),
    excluded_test_businesses: name || given ? undefined : rows.filter((r) => r.testBusiness && !r.deleted).length,
    businesses: list.slice(0, 15).map(out),
    ...(list.length > 15 ? { not_listed: list.length - 15 } : {}),
  }
}

async function platformNumbers(c) {
  const g = await c.L.growth()
  if (!g) return { source: 'platform metrics', error: 'could_not_be_read' }
  return {
    source: 'platform metrics from records; test businesses and test records excluded',
    period: 'last 30 days unless named',
    customers: g.customers,
    activation_rate_percent: g.activationRate,
    first_booking_rate_percent: g.firstBookingRate,
    booking_conversion_last_30_days_percent: g.bookingConversion30,
    show_up_rate_last_30_days_percent: g.showUpRate30,
    retention_last_30_days_percent: g.retention30,
    signups_by_week: g.signupsByWeek,
    billing: !g.billing ? 'no subscriptions recorded' : g.billing.mode === 'test' ? { mode: 'Stripe test mode', test_subscriptions: g.billing.testSubscriptions, revenue: 'none (test mode is never revenue)' } : { mode: 'live', paying_customers: g.billing.payingCustomers, mrr: dollars(g.billing.mrrCents), revenue_last_30_days: dollars(g.billing.revenue30Cents), churn_last_30_days_percent: g.billing.churn30 },
    not_measured: ['customer acquisition cost', 'lifetime value', 'gross margin', 'revenue caused by GetShowUps'],
    sales_funnel_last_30_days: g.sales,
  }
}

async function billing(c, { period = 'this_month' } = {}) {
  const L = c.L
  const range = periodRange(period, c.now)
  const db = c.env.ONBOARDING_DB
  const [rows, modes, selfServe, recon] = await Promise.all([L.rows(), L.modes(), L.selfServe(), L.reconciliation()])
  const real = (rows || []).filter((r) => !r.deleted && !r.testBusiness)
  const counts = {}
  for (const r of real) if (r.subscription) counts[r.subscription.status] = (counts[r.subscription.status] || 0) + 1
  let payments = null
  try {
    const ev = (await db.prepare("SELECT type, customer, props FROM events e WHERE type IN ('revenue', 'payment_failed') AND at >= ?1 AND at < ?2 AND NOT EXISTS (SELECT 1 FROM test_businesses tb WHERE tb.customer = e.customer AND tb.is_test = 1) LIMIT 2000").bind(range.from, range.to).all()).results
    const rev = ev.filter((e) => e.type === 'revenue').map((e) => ({ ...e, p: JSON.parse(e.props || '{}') }))
    const liveRev = rev.filter((e) => e.p.livemode === true)
    payments = {
      live_payments: liveRev.length,
      live_revenue: L.live ? dollars(liveRev.reduce((n, e) => n + (e.p.amountCents || 0), 0)) : 'none: live billing is off',
      test_mode_payments: rev.length - liveRev.length,
      test_mode_note: 'Stripe test-mode payments are never revenue',
      failed_payments: ev.filter((e) => e.type === 'payment_failed').length,
      failed_payment_businesses: [...new Set(ev.filter((e) => e.type === 'payment_failed').map((e) => e.customer))].map((id) => {
        const r = real.find((x) => x.id === id)
        return r ? c.ref('B', r.id, r.name) : null
      }).filter(Boolean),
    }
  } catch {
    payments = 'could not be read'
  }
  const g = await L.growth()
  return {
    source: 'subscriptions and Stripe payment records, the last billing reconciliation; test businesses excluded',
    period: range.label,
    billing_mode: L.live ? 'live' : 'Stripe test mode (nobody has paid real money; no revenue)',
    stripe_configured: L.billingConfigured,
    subscriptions_by_status: counts,
    ...(L.live && g?.billing?.mode === 'live' ? { live: { paying_customers: g.billing.payingCustomers, mrr: dollars(g.billing.mrrCents), test_subscriptions_not_revenue: g.billing.testSubscriptions } } : {}),
    payments_in_period: payments,
    payment_failed_now: real.filter((r) => r.attention.includes('past_due')).map((r) => `${c.ref('B', r.id, r.name)}: ${billingOf(r, modes, L.live, selfServe).words}`),
    reconciliation: recon ? { last_run: `${ymd(recon.at)} (${agoText(c.now, recon.at)})`, issues_on_real_businesses: recon.real ?? 0, issues_total: recon.issues, by_type: recon.byType, auto_applied: (recon.applied || []).length } : L.billingConfigured ? 'never run' : 'Stripe is not configured',
  }
}

async function systemHealth(c) {
  const [incidents, caps, rows] = await Promise.all([c.L.incidents(), c.L.caps(), c.L.rows()])
  const names = new Map((rows || []).map((r) => [r.id, r.name]))
  const real = (incidents || []).filter((i) => !i.test)
  return {
    source: 'open incidents and integration health as recorded',
    period: 'open now; integration failures: last 7 days',
    open_incidents: incidents === null ? 'could not be read' : real.slice(0, 12).map((i) => ({ severity: i.severity, what: i.title, ...(i.customer ? { business: names.has(i.customer) ? c.ref('B', i.customer, names.get(i.customer)) : 'a business' } : { scope: 'platform-wide' }), open_since: ymd(i.firstSeen), last_seen: ymd(i.lastSeen), occurrences: i.occurrences, cause: i.cause === 'unknown' ? 'not known' : `${i.cause}: ${i.causeNote || i.code}`, next: i.next })),
    open_incidents_on_test_businesses: (incidents || []).filter((i) => i.test).length,
    integrations: caps === null ? 'could not be read' : integrationsOf(caps).filter((g) => !['setup_required', 'disabled'].includes(g.state)).map((g) => ({ name: g.name, service: g.service, state: g.words, failures_last_7_days: g.failures_7d, last_success: ymd(g.last_success) })),
    integrations_switched_off: caps === null ? undefined : integrationsOf(caps).filter((g) => g.state === 'disabled').map((g) => g.name),
    integrations_not_set_up: caps === null ? undefined : integrationsOf(caps).filter((g) => g.state === 'setup_required').length,
    resolve_at: '/admin/control',
  }
}

async function aiSpending(c, { period = 'yesterday' } = {}) {
  const [s, today, budget] = await Promise.all([c.L.aiSpend(period), c.L.adminSpendToday(), c.L.budgetToday()])
  if (!s) return { source: 'recorded AI costs', error: 'could_not_be_read' }
  const part = (p) => (p ? { uses: p.uses, cost: usd(p.micros) } : 'could not be read')
  return {
    source: 'costs each AI feature recorded (token counts × list price; the provider invoice is final)',
    period: s.range.label,
    paid_by_getshowups: { owner_assistant: part(s.parts.owner_assistant), admin_assistant: part(s.parts.admin_assistant), receptionist: part(s.parts.receptionist), website_ai: part(s.parts.website_ai), follow_up_text_answers: part(s.parts.follow_up_answers) },
    total: usd(s.totalMicros),
    on_owners_own_keys_not_our_cost: part(s.ownKeys),
    today_admin_assistant: today ? { cost: usd(today.micros), daily_ceiling: usd(today.ceilingMicros), questions: today.asks } : 'could not be read',
    today_owner_assistant_shared_allowance: today ? `${today.ownerAsksToday} of ${today.ownerSharedAllowance} questions` : 'could not be read',
    today_paid_providers_spending_guard: budget ? { total: usd(budget.platform), platform_ceiling: usd(budget.ceilings?.platform), by_entry: Object.fromEntries(Object.entries(budget.entries || {}).map(([k, v]) => [k, usd(v)])), warnings: (budget.warnings || []).map((w) => `${w.scope} ${w.state}`) } : 'could not be read',
    notes: ['receptionist costs are counted by conversation (last activity in the period)', 'follow-up answers include the text-message cost once sent'],
  }
}

async function growthActivity(c) {
  const [g, acq] = await Promise.all([c.L.growth(), c.L.acquisition()])
  return {
    source: 'growth metrics and the acquisition activities you recorded',
    period: 'signups: last 8 weeks; funnel: last 30 days; activities: as recorded',
    signups_by_week: g?.signupsByWeek ?? 'could not be read',
    sales_funnel_last_30_days: g ? g.sales ?? 'the GetShowUps sales business is not set up' : 'could not be read',
    activation_rate_percent: g?.activationRate ?? null,
    acquisition: !acq ? 'could not be read' : !acq.available ? 'not set up yet (migration 0044)' : {
      tracking_codes: acq.totals.codes, approved: acq.totals.approved, sent: acq.totals.sent, replied: acq.totals.replied, declined: acq.totals.declined, follow_ups_due: acq.totals.followUpsDue, recorded_cost: dollars(acq.totals.recordedCostCents),
      activities: acq.activities.filter((a) => !a.derived).map((a) => ({ title: a.title, codes: a.codes.map((x) => `${x.code}: ${x.status}${x.followUpDue ? ' (follow-up due)' : ''}`).slice(0, 8) })),
    },
    resolve_at: '/admin/growth',
  }
}

async function enrollments(c, { stage = 'all', name = '' } = {}) {
  const [e, inv, tests] = await Promise.all([c.L.enrollments(), c.L.enrollmentInvites(), c.L.tests()])
  if (!e) return { source: 'assisted enrollments', error: 'could_not_be_read' }
  if (!e.ready) return { source: 'assisted enrollments', note: 'not set up yet (migration 0047)' }
  const list = e.list.filter((x) => !tests?.has(x.customer))
  const counts = {}
  for (const x of list) counts[x.stage] = (counts[x.stage] || 0) + 1
  const stuckWhy = (x) => {
    const i = inv?.get(x.id)
    if (x.stale) return `unpaid for ${daysAgo(c.now, x.createdAt)} days${x.paymentSentAt ? ` (payment link sent ${daysAgo(c.now, x.paymentSentAt)} days ago)` : ' (no payment link sent)'}`
    if (['paid', 'configuring', 'ready'].includes(x.stage) && x.paidAt && c.now - x.paidAt > 7 * DAY) return `paid ${daysAgo(c.now, x.paidAt)} days ago, invitation not sent`
    if (x.stage === 'invited' && i && !i.accepted_at && !i.revoked_at && i.expires_at <= c.now) return `ownership invitation expired ${daysAgo(c.now, i.expires_at)} days ago`
    return null
  }
  const shown = list.filter((x) => (name ? nameMatches(x.businessName, '', name) : stage === 'all' || stage === 'stuck' ? true : x.stage === stage))
  const rowsOut = shown.map((x) => ({ x, why: stuckWhy(x) })).filter(({ why }) => stage !== 'stuck' || why)
  return {
    source: 'assisted enrollments; test businesses excluded',
    period: 'as of now',
    by_stage: counts,
    stuck_rule: 'unpaid over 14 days, paid but not handed over after 7 days, or an expired ownership invitation',
    enrollments: rowsOut.slice(0, 15).map(({ x, why }) => ({ ref: c.ref('E', x.id, x.businessName), stage: x.stage, started: ymd(x.createdAt), last_change: ymd(x.updatedAt), handled_by: x.rep ? 'a sales representative' : 'you', ...(why ? { stuck: why } : {}) })),
    resolve_at: '/admin/sales',
  }
}

async function partners(c, { name = '' } = {}) {
  const [p, rows, modes, selfServe] = await Promise.all([c.L.partners(), c.L.rows(), c.L.modes(), c.L.selfServe()])
  if (!p) return { source: 'referral partners', error: 'could_not_be_read' }
  if (!p.ready) return { source: 'referral partners', note: 'not set up yet (migration 0048)' }
  const byId = new Map((rows || []).map((r) => [r.id, r]))
  const sum = (m) => Object.entries(m || {}).map(([cur, v]) => `${(v.owedCents / 100).toFixed(2)} ${cur.toUpperCase()}`).join(', ') || '0'
  return {
    source: 'referral partners, their terms in effect, the commission ledger and recorded payouts',
    period: 'since each partner was added',
    billing_mode: c.L.live ? 'live' : 'Stripe test mode: test-mode commissions are never owed',
    referrals_program: c.env.REFERRALS_ENABLED === 'true' ? 'on' : 'off: nothing accrues; switching it on is a platform setting that needs your approval (no button)',
    ...(name ? { asked: `partners matching "${String(name).slice(0, 40)}"`, matches: p.partners.filter((x) => nameMatches(x.name, '', name)).length } : {}),
    partners: p.partners.filter((x) => !name || nameMatches(x.name, '', name)).slice(0, 20).map((x) => {
      const real = x.referred.filter((r) => !r.testBusiness)
      return {
        ref: c.ref('P', x.id, x.name),
        status: x.status,
        terms: x.terms ? `version ${x.termsVersion}: ${x.terms.type === 'percent' ? `${x.terms.value}%` : `${(x.terms.value / 100).toFixed(2)} ${String(x.terms.currency || '').toUpperCase()}`} ${x.terms.recurring}, window ${x.terms.windowDays} days` : 'no terms in effect',
        referred_businesses: real.length,
        referred_test_businesses: x.referred.length - real.length,
        referred_live_setups: real.filter((r) => byId.get(r.customer)?.onboarding === 'live').length,
        referred_paying_live: real.filter((r) => byId.get(r.customer) && billingOf(byId.get(r.customer), modes, c.L.live, selfServe).paying).length,
        commission_owed_live: c.L.live ? Object.entries(x.balances).map(([cur, b]) => `${(b.owedCents / 100).toFixed(2)} ${cur.toUpperCase()} owed (${(b.earnedCents / 100).toFixed(2)} earned, ${(b.paidCents / 100).toFixed(2)} paid)`).join(', ') || '0' : 'none (live billing off)',
        accruals_not_yet_paid_out: c.L.live ? x.unsettled : 0,
        ...(x.setupMissing.length ? { setup_missing: x.setupMissing.map((b) => b.replace(/_/g, ' ')) } : {}),
        test_mode_commission_not_owed: sum(x.testMode),
      }
    }),
    resolve_at: '/admin/growth',
  }
}

async function brief(c) {
  const b = await weeklyBrief(c.env, c.now, c.L)
  const swap = (s, x) => {
    let t = s || ''
    for (const o of [x.business, x.enrollment, ...(x.businesses || [])].filter(Boolean)) {
      const r = c.ref(o === x.enrollment ? 'E' : 'B', o.id, o.name)
      t = t.split(o.name).join(`[${r}]`)
    }
    return t
  }
  return {
    source: 'the weekly brief: fixed rules over every admin record (no AI)',
    period: 'as of now',
    counts: b.counts,
    total_items: b.items.length,
    // The closing line's N when an answer lists every urgent item and the 3 most important others.
    more_after_urgent_and_top_3_important: Math.max(0, b.items.length - b.counts.urgent - Math.min(3, b.counts.important)),
    // `about` (the reference) and `issue` (the title without the name) apart, so an answer reads "[B2]'s calendar is
    // disconnected" rather than repeating the title with the name glued on.
    items: b.items.slice(0, 25).map((x) => {
      const one = x.enrollment || x.business
      const ref = one ? c.ref(one === x.enrollment ? 'E' : 'B', one.id, one.name) : null
      return { level: x.level, ...(ref ? { about: `[${ref}]` } : {}), issue: one ? x.title.replace(`: ${one.name}`, '').replace(` (${one.name})`, '') : swap(x.title, x), detail: swap(x.detail, x), next: x.next, ...(x.prepare ? { can_prepare_if_asked: true } : {}), page: PAGE_OF(x.href) }
    }),
    ...(b.unreadable.length ? { could_not_be_read: b.unreadable } : {}),
  }
}

const PAGE_OF = (href) => ({ '/admin/control': 'Control Center', '/admin/sales': 'Sales', '/admin/growth': 'Growth' })[href.split('?')[0].split('#')[0]] || 'Overview'

// ---------- prepared changes (nothing saved here) ----------
const prep = (c, p) => {
  const id = `prop_${randomToken(9)}`
  c.proposals.push({ id, ...p })
  return { prepared: true, approval_card: p.title, note: 'Shown to the admin with an Approve button. Nothing has happened. Say it is ready to approve.' }
}
const nope = (why) => ({ prepared: false, reason: why })

// What a prepare tool acts on: a reference from a lookup, or the founder's own words for the name, matched HERE against
// the records (never guessed by the model). kinds: which of 'B' (business) / 'E' (enrollment) may match.
// → { one: { kind, id } } | { error } (none, or several: their references, so the founder can be asked which).
async function target(c, { ref, name }, kinds) {
  const r = ref ? c.resolve(ref) : null
  if (r && kinds.includes(r.kind)) return { one: r }
  const words = name || ref || c.question
  if (!words) return { error: 'Say which business or enrollment (a reference, or the name the founder used).' }
  const db = c.env.ONBOARDING_DB
  const found = []
  if (kinds.includes('E')) {
    const { results } = await db.prepare("SELECT id, customer, business_name FROM assisted_enrollments WHERE stage <> 'claimed' LIMIT 500").all().catch(() => ({ results: [] }))
    for (const e of results) if (nameMatches(e.business_name, '', words)) found.push({ kind: 'E', id: e.id, customer: e.customer, name: e.business_name })
  }
  if (kinds.includes('B')) {
    const rows = (await c.L.rows()) || []
    for (const b of rows.filter((x) => !x.deleted && nameMatches(x.name, x.id, words))) if (!found.some((f) => f.customer === b.id)) found.push({ kind: 'B', id: b.id, name: b.name })
  }
  if (found.length === 1) return { one: { kind: found[0].kind, id: found[0].id, ref: c.ref(found[0].kind, found[0].id, found[0].name) } }
  if (!found.length) return { error: `Nothing matches "${String(words).slice(0, 40)}". Ask the founder which business they mean.` }
  return { error: `Several match: ${found.slice(0, 5).map((f) => `[${c.ref(f.kind, f.id, f.name)}]`).join(', ')}. Ask the founder which one; prepare nothing yet.` }
}

async function prepareInvitation(c, { ref, name }) {
  const t = await target(c, { ref, name }, ['B', 'E'])
  if (t.error) return nope(t.error)
  const r = t.one
  const db = c.env.ONBOARDING_DB
  if (r.kind === 'E') {
    const e = await db.prepare('SELECT id, customer, business_name, stage, invite_id FROM assisted_enrollments WHERE id = ?1').bind(r.id).first().catch(() => null)
    if (!e) return nope('That enrollment is not recorded.')
    if (!['invited', 'ready'].includes(e.stage)) return nope(e.stage === 'claimed' ? 'The owner already claimed the business.' : `The enrollment is at stage ${e.stage}: an ownership invitation is only sent once it is paid and the required setup is done (Sales page).`)
    return prep(c, { type: 'resend_invitation', target: { kind: 'enrollment', id: e.id }, name: e.business_name, before: { stage: e.stage, inviteId: e.invite_id ?? null }, title: `${e.stage === 'invited' ? 'Resend' : 'Send'} the ownership invitation`, effects: ['A new single-use link replaces the old one (the old link stops working).', 'The email goes through the outbox and the launch gate.', 'Recorded in the audit log.'] })
  }
  const member = await db.prepare('SELECT 1 FROM customer_users WHERE customer = ?1 LIMIT 1').bind(r.id).first()
  if (member) return nope('This business already has an owner signed in, so there is no invitation to resend.')
  const enr = await db.prepare('SELECT id, stage FROM assisted_enrollments WHERE customer = ?1').bind(r.id).first().catch(() => null)
  if (enr) return prepareInvitation(c, { ref: c.ref('E', enr.id, null) }) // its ownership invitation, never a plain owner invite
  const inv = await db.prepare('SELECT id, created_at, expires_at FROM account_invites WHERE customer = ?1 AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1').bind(r.id).first()
  if (!inv) return nope('No invitation was ever sent for this business: send one from the business page (Invite).')
  const biz = await db.prepare('SELECT name FROM customers WHERE id = ?1').bind(r.id).first()
  return prep(c, { type: 'resend_invitation', target: { kind: 'business', id: r.id }, name: biz?.name || r.id, before: { inviteId: inv.id }, title: 'Resend the owner invitation', effects: [`The last invitation was sent ${ymd(inv.created_at)}${inv.expires_at <= c.now ? ' and has expired' : ''}.`, 'A new link replaces it (the old link stops working), to the same email address.', 'Recorded in the audit log.'] })
}

async function prepareAbandon(c, { ref, name }) {
  const t = await target(c, { ref, name }, ['E'])
  if (t.error) return nope(t.error)
  const r = t.one
  const e = await c.env.ONBOARDING_DB.prepare('SELECT id, business_name, stage FROM assisted_enrollments WHERE id = ?1').bind(r.id).first().catch(() => null)
  if (!e) return nope('That enrollment is not recorded.')
  if (!['prospect', 'payment_sent'].includes(e.stage)) return nope(e.stage === 'abandoned' ? 'It is already marked abandoned.' : `It is at stage ${e.stage} (paid or later), so it can't be marked abandoned.`)
  return prep(c, { type: 'mark_abandoned', target: { kind: 'enrollment', id: e.id }, name: e.business_name, before: { stage: e.stage }, title: 'Mark the enrollment abandoned', effects: ['It moves to Abandoned in Sales; nothing is deleted.', 'An open ownership invitation is revoked.', 'A later payment still moves it forward.', 'Recorded in the audit log.'] })
}

async function prepareReconciliation(c) {
  if (!c.L.billingConfigured) return nope('Stripe is not configured, so there is nothing to reconcile.')
  const last = await c.L.reconciliation()
  return prep(c, { type: 'run_reconciliation', target: { kind: 'platform' }, name: 'Billing reconciliation', before: { lastAt: last?.at ?? null }, title: 'Run billing reconciliation now', effects: ['Reads Stripe subscriptions and the last 35 days of paid invoices and compares them with our records.', 'Read-only toward Stripe. One thing is applied automatically, as every day: a subscription Stripe reports ended is marked ended here.', 'Recorded in the audit log.'] })
}

async function prepareCodeStatus(c, { code, status }) {
  const acq = await c.L.acquisition()
  if (!acq?.available) return nope('Acquisition activities are not set up.')
  const found = acq.activities.flatMap((a) => a.codes.map((x) => ({ a, x }))).find(({ x }) => x.code === String(code || '').trim())
  if (!found) return nope('That tracking code is not in the plan. Look it up with growth_activity.')
  if (!CODE_STATUSES.includes(status) || !found.a.statuses.includes(status)) return nope(`Status must be one of: ${found.a.statuses.join(', ')}.`)
  if (found.x.status === status) return nope(`It is already recorded as ${status}.`)
  return prep(c, { type: 'code_status', target: { kind: 'code', id: found.x.code }, name: `${found.a.title}: ${found.x.code}`, before: { status: found.x.status }, after: { status }, title: `Record ${found.x.code} as ${status.replace('_', ' ')}`, effects: [`From ${found.x.status} to ${status}. This records what you did; it sends, publishes or spends nothing.`, 'Recorded in the audit log.'] })
}

async function prepareTestMark(c, { ref, name, test: raw }) {
  // true/false from the model, or else from the founder's own words ("it's a real customer", "take off the test mark").
  const said = String(c.question || '')
  const test = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : /\b(real|unmark|not a test|take [\w ]{0,12}off|remove)\b/i.test(said) ? false : /\bmark\b[^.?!]*\btest\b/i.test(said) ? true : raw
  if (typeof test !== 'boolean') return nope('Say whether to mark it as a test business (test: true) or remove the mark (test: false).')
  const t = await target(c, { ref, name }, ['B'])
  if (t.error) return nope(t.error)
  const r = t.one
  if (test && NEVER_TEST.has(r.id)) return nope('This is a real business by definition and is never marked as a test business.')
  const row = await c.env.ONBOARDING_DB.prepare('SELECT c.name, coalesce(tb.is_test, 0) AS is_test FROM customers c LEFT JOIN test_businesses tb ON tb.customer = c.id WHERE c.id = ?1').bind(r.id).first().catch(() => null)
  if (!row) return nope('That business is not recorded.')
  if (Boolean(row.is_test) === test) return nope(`It is already ${test ? 'marked' : 'not marked'} as a test business.`)
  return prep(c, { type: 'test_mark', target: { kind: 'business', id: r.id }, name: row.name, before: { test: Boolean(row.is_test) }, after: { test }, title: test ? 'Mark as a test business' : 'Remove the test-business mark', effects: test ? ['Left out of every count, metric and MRR from now on.', 'Never uses live ads, live messages or live billing.'] : ['Counted as a real business from now on.', 'Anything created while it was marked stays sandboxed; Ads accounts must be chosen again.'] })
}

const P = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const REF = { type: 'string', description: 'A reference from a lookup, like B1 or E2.' }
const NAME = { type: 'string', description: 'Or the name as the founder wrote it, e.g. "harbor" (matched against the records).' }
export const TOOLS = [
  { name: 'weekly_brief', description: 'What needs the founder now: the prioritized list (urgent, important, FYI) of material issues across billing, setup, calendars, enrollments, invitations, incidents, reconciliation, follow-ups and AI spend, each with its next step and admin page. Read first for "what needs me", "anything urgent", "what should I do".', parameters: P(), run: brief },
  { name: 'platform_numbers', description: 'Platform-wide figures: customers, activation, booking conversion, show-up rate, retention, signups by week, billing summary, sales funnel. Last 30 days.', parameters: P(), run: platformNumbers },
  { name: 'business_health', description: 'Per business: setup stage, billing status (test mode vs live), calendar, receptionist on/off, inquiries and bookings in 30 days, last booking, attention flags and churn signals. which: all | paying | at_risk (paying businesses WITH a churn signal: use for churn) | needs_attention | not_live | live. Or name: words from a business name to find it. Or ref: a [B] reference from earlier ("the first one").', parameters: P({ which: { type: 'string', enum: ['all', 'paying', 'at_risk', 'needs_attention', 'not_live', 'live'] }, name: { type: 'string', description: 'Words of the business name, e.g. "harbor".' }, ref: REF }), run: businesses },
  { name: 'billing', description: 'Subscriptions by status, billing mode (test or live), payments and failed payments in a period, revenue (live mode only), and the last billing reconciliation with its mismatches.', parameters: P({ period: { type: 'string', enum: PERIODS } }), run: billing },
  { name: 'system_health', description: 'Is anything broken: open incidents (severity, what, business, since when, next step) and the health of integrations (Google, Stripe, email, Twilio, voice providers) as recorded.', parameters: P(), run: systemHealth },
  { name: 'ai_spending', description: 'Recorded AI costs by feature for a period (owner assistant, admin assistant, receptionist, website AI, follow-up answers), own-key usage apart, and today\'s use against the daily ceilings.', parameters: P({ period: { type: 'string', enum: PERIODS } }), run: aiSpending },
  { name: 'growth_activity', description: 'Signups by week, the GetShowUps sales funnel, and the acquisition activities with their tracking codes and statuses (approved, sent, replied) and follow-ups due.', parameters: P(), run: growthActivity },
  { name: 'enrollments', description: 'Assisted enrollments by stage (prospect, payment_sent, paid, configuring, ready, invited, claimed, abandoned) and which are stuck and why. stage: all | stuck | one stage. Or name: words of the business name.', parameters: P({ stage: { type: 'string', enum: ['all', 'stuck', 'prospect', 'payment_sent', 'paid', 'configuring', 'ready', 'invited', 'claimed', 'abandoned'] }, name: NAME }), run: enrollments },
  { name: 'partners', description: 'Referral partners: status (active or paused), terms, referred businesses (set up, paying), commission owed in live mode, and test-mode commissions (never owed). name: words of a partner name to find one.', parameters: P({ name: NAME }), run: partners },
  { name: 'prepare_resend_invitation', description: 'Prepare resending an owner or ownership invitation for a business or enrollment, by reference or by the name the founder used. The admin approves it on a card.', parameters: P({ ref: REF, name: NAME }), run: prepareInvitation },
  { name: 'prepare_mark_abandoned', description: 'Prepare marking an unpaid enrollment as abandoned, by reference or name. The admin approves it on a card.', parameters: P({ ref: REF, name: NAME }), run: prepareAbandon },
  { name: 'prepare_run_reconciliation', description: 'Prepare running the billing reconciliation (Stripe vs our records) now. The admin approves it on a card.', parameters: P(), run: prepareReconciliation },
  { name: 'prepare_code_status', description: 'Prepare recording the status of an acquisition tracking code (what the founder did: approved, sent, followed_up, replied, declined). The admin approves it on a card.', parameters: P({ code: { type: 'string' }, status: { type: 'string', enum: CODE_STATUSES } }, ['code', 'status']), run: prepareCodeStatus },
  { name: 'prepare_test_mark', description: 'Prepare marking a business as a test business (test: true) or removing the mark (test: false, i.e. it is a real customer), by reference or name. The admin approves it on a card.', parameters: P({ ref: REF, name: NAME, test: { type: 'boolean' } }, ['test']), run: prepareTestMark },
  ...QA_TOOLS((c, p) => prep(c, p), (why) => nope(why)),
  { name: 'no_lookup_needed', description: 'Use only when the question needs no records (a greeting, how GetShowUps works in general, or something you cannot do here).', parameters: P({ why: { type: 'string', enum: ['general_question', 'greeting', 'not_possible_here'] } }), run: async () => ({ ok: true }) },
]
export const TOOL_NAMES = TOOLS.map((t) => t.name)

export async function runAdminTool(c, name, args) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) return { error: 'unknown_tool' }
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) return { error: 'invalid_arguments' }
  try {
    const r = await t.run(c, args || {})
    if (r?.source && !c.sources.some((s) => s.tool === name)) c.sources.push({ tool: name, source: r.source, period: r.period || null })
    return r
  } catch (err) {
    console.error('admin tool failed:', name, err?.name)
    return { error: 'could_not_be_read' }
  }
}

// Names behind references, for the admin's page only (never sent to the model). Looked up again: a removed one is left out.
export async function namesFor(c, refs) {
  const db = c.env.ONBOARDING_DB
  const out = {}
  for (const ref of refs) {
    const r = c.refs.get(ref)
    if (!r) continue
    if (r.name) {
      out[ref] = r.name
      continue
    }
    const sql = { B: 'SELECT name FROM customers WHERE id = ?1', E: 'SELECT business_name AS name FROM assisted_enrollments WHERE id = ?1', P: 'SELECT name FROM referral_partners WHERE id = ?1', Q: 'SELECT title AS name FROM qa_items WHERE id = ?1' }[r.kind]
    const row = await db.prepare(sql).bind(r.id).first().catch(() => null)
    if (row?.name) out[ref] = r.name = String(row.name).slice(0, 80)
  }
  return out
}
