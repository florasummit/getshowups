// The platform-admin assistant's records (server/admin-assist/): ONE loader per request, shared by the weekly brief
// (brief.js) and the lookups (tools.js), so both read the same figures from the systems that already compute them:
// customer rows + attention flags (server/metrics.js), growth (metrics.js growth, growth.js), incidents + capability
// health (server/ops), billing reconciliation (server/reconcile.js), assisted enrollments (server/enrollment.js), partners
// and commissions (server/partners.js), acquisition activities (server/acquisition.js) and recorded AI costs.
// Every part is fail-soft: a part that can't be read is null ("could not be read"), never zeros that look like data.
// Contact details never leave here: owner emails, enrollment owner names/emails/phones/notes and partner addresses are
// dropped at this boundary.
import { customerRows, growth, SALES_BUSINESS } from '../metrics.js'
import { listIncidents } from '../ops/incidents.js'
import { capabilityStatuses } from '../ops/review.js'
import { integrationState, INTEGRATION_STATES } from '../ops/states.js'
import { lastReconciliation } from '../reconcile.js'
import { isStale, listEnrollments } from '../enrollment.js'
import { partnersOverview } from '../partners.js'
import { acquisitionOverview } from '../acquisition.js'
import { stripeConfigured, stripeLiveEnabled } from '../stripe.js'
import { RULES } from '../ratelimit.js'
import { spendToday } from '../ai-budget.js'

export const DAY = 86_400_000
// The admin assistant's own daily money ceiling (recorded costs of 'admin_ai_ask' events, UTC day). On Claude every call
// is also reserved in server/ai-budget.js (ENTRIES.admin_assistant, $0.50/day, booked on the 'getshowups' business).
export const ADMIN_DAILY_MICROS = 500_000 // $0.50 a day ≈ 200 questions on the included model
export const ADMIN_ANSWERS_PER_DAY = 80

const soft = async (fn, label) => {
  try {
    return await fn()
  } catch (err) {
    console.error('admin assistant data unavailable:', label, err?.name)
    return null
  }
}

// UTC periods (the platform has no single time zone). → { from, to, label } (ms, to exclusive)
export const PERIODS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'last_month']
export function periodRange(period, now = Date.now()) {
  const d0 = now - (now % DAY)
  const m = new Date(now)
  const month = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1)
  const prev = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - 1, 1)
  const day = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(t)
  const r = {
    today: [d0, now],
    yesterday: [d0 - DAY, d0],
    last_7_days: [now - 7 * DAY, now],
    last_30_days: [now - 30 * DAY, now],
    this_month: [month, now],
    last_month: [prev, month],
  }[PERIODS.includes(period) ? period : 'last_30_days']
  const p = PERIODS.includes(period) ? period : 'last_30_days'
  const [a, b] = [day(r[0]), day(r[1] - 1)]
  return { period: p, from: r[0], to: r[1], label: `${p.replace(/_/g, ' ')}: ${a === b ? a : `${a} to ${b}`} (UTC)` }
}

const PAID = ['active', 'trialing', 'past_due']

export function loaders(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const memo = new Map()
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, soft(fn, key))
    return memo.get(key)
  }
  const L = {
    now,
    live: stripeLiveEnabled(env),
    billingConfigured: stripeConfigured(env),
    // Customer rows WITHOUT owner emails (the only contact detail customerRows carries).
    rows: () => once('rows', async () => (await customerRows(env, now)).map(({ owners, ...r }) => ({ ...r, hasOwner: Boolean(owners) }))),
    modes: () => once('modes', async () => new Map((await db.prepare('SELECT customer, livemode FROM subscription_modes').all()).results.map((m) => [m.customer, m.livemode]))),
    receptionist: () => once('receptionist', async () => new Map((await db.prepare('SELECT customer, enabled FROM receptionist_settings').all()).results.map((r) => [r.customer, r.enabled === 1]))),
    selfServe: () => once('selfServe', async () => new Set((await db.prepare('SELECT customer FROM self_signups').all()).results.map((r) => r.customer))),
    // Unaccepted account invitations (no email: only ids, times and the business).
    invites: () =>
      once('invites', async () => (await db.prepare('SELECT id, customer, created_at, expires_at, revoked_at FROM account_invites WHERE accepted_at IS NULL AND (revoked_at IS NULL) AND expires_at > ?1 ORDER BY created_at DESC LIMIT 500').bind(now - 30 * DAY).all()).results),
    growth: () => once('growth', async () => growth(env, await L.rows(), now)),
    incidents: () => once('incidents', () => listIncidents(db, { status: 'open', limit: 100 })),
    caps: () => once('caps', () => capabilityStatuses(env, now)),
    reconciliation: () => once('reconciliation', () => lastReconciliation(db)),
    enrollments: () =>
      once('enrollments', async () => {
        const r = await listEnrollments(env, { email: 'assistant', roles: new Set(['platform_admin']) }, now)
        if (!r.ready) return { ready: false, list: [] }
        // Contact details and notes are dropped here.
        return {
          ready: true,
          list: r.enrollments.map((e) => ({ id: e.id, customer: e.customer, businessName: e.businessName, stage: e.stage, stale: isStale({ created_at: e.createdAt }, e.stage, now), rep: Boolean(e.assignedRep), createdAt: e.createdAt, updatedAt: e.updatedAt, paymentSentAt: e.paymentSentAt, paymentSends: e.paymentSends, paidAt: e.paidAt, invitedAt: e.invitedAt, claimedAt: e.claimedAt, abandonedAt: e.abandonedAt })),
        }
      }),
    enrollmentInvites: () =>
      once('enrollmentInvites', async () => new Map((await db.prepare('SELECT e.id, i.expires_at, i.accepted_at, i.revoked_at FROM assisted_enrollments e JOIN account_invites i ON i.id = e.invite_id').all()).results.map((r) => [r.id, r]))),
    tests: () => once('tests', async () => new Set((await db.prepare('SELECT customer FROM test_businesses WHERE is_test = 1').all()).results.map((r) => r.customer))),
    partners: () =>
      once('partners', async () => {
        const p = await partnersOverview(env, { live: L.live })
        // Picked field by field: the partner's contact address, code and link never pass.
        return { ready: p.ready, partners: p.partners.map((x) => ({ id: x.id, name: x.name, status: x.status, terms: x.terms, termsVersion: x.termsVersion, createdAt: x.createdAt, referred: x.referred, liability: x.liability, testMode: x.testMode, balances: x.payouts?.balances || {}, unsettled: (x.payouts?.unsettled || []).length, setupMissing: x.checklist?.blockers || [] })) }
      }),
    acquisition: () => once('acquisition', () => acquisitionOverview(env, null, { now })),
    aiSpend: (period) => once(`ai:${period}`, () => aiSpend(db, periodRange(period, now))),
    adminSpendToday: () => once('adminSpendToday', () => adminSpendToday(db, now)),
    // The spending guard's counters today (paid providers only; business ids only).
    budgetToday: () => once('budgetToday', () => spendToday(env, now)),
  }
  return L
}

// Billing words for one business row, from records only. test mode is never "paying".
export function billingOf(r, modes, live, selfServe) {
  const acct = r.account?.billing === 'complimentary'
  if (acct) return { state: 'complimentary', paying: false, words: 'complimentary account (never billed)' }
  const s = r.subscription
  if (!s) return selfServe?.has(r.id) ? { state: 'not_paid', paying: false, words: 'signed up, not paid' } : { state: 'not_billed', paying: false, words: 'not billed (pilot or invited)' }
  const liveSub = live && modes?.get(r.id) === 1
  if (s.status === 'canceled') return { state: 'ended', paying: false, words: 'subscription ended' }
  if (!PAID.includes(s.status)) return { state: 'pending', paying: false, words: `subscription ${s.status}` }
  if (!liveSub) return { state: 'test', paying: false, testPaying: true, words: `${s.status === 'past_due' ? 'payment failed' : s.status} in Stripe TEST mode (not revenue)` }
  return { state: s.status, paying: true, words: s.status === 'past_due' ? 'payment failed (live)' : `${s.status} (live)` }
}

export const ATTENTION_WORDS = {
  suspended: 'suspended', past_due: 'payment failed', ads_running_on_hold: 'ads running while on hold', deletion_stuck: 'deletion stuck',
  booking_failures: 'booking failures in the last 7 days', calendar_disconnected: 'Google Calendar disconnected', setup_stalled: 'setup stalled for over a day',
  checkout_abandoned: 'signed up but did not pay', cancel_scheduled: 'cancellation scheduled', subscription_ended: 'subscription ended',
  recovery_ending: 'recovery period ends within 14 days', recovery_ended: 'recovery period over', domain_activation: 'own domain waiting to activate',
  domain_problem: 'own domain problem', invite_pending: 'owner invitation not accepted after 3 days', no_owner: 'no owner and no invitation', no_recent_bookings: 'no bookings in 14 days',
}
export const SETUP_WORDS = { invited: 'owner not signed in yet', calendar: 'calendar not connected yet', hours: 'booking hours not set yet', live: 'set up and live', suspended: 'suspended', deleted: 'deleted' }

// Integrations as recorded by the capability registry (external services only).
export function integrationsOf(caps) {
  return (caps || []).filter((c) => c.external).map((c) => {
    const state = integrationState(c)
    return { id: c.id, name: c.name, service: c.external, state, words: INTEGRATION_STATES[state].label, failures_7d: c.events?.failures7 ?? 0, last_success: c.events?.lastSuccess ?? null, last_failure: c.events?.lastFailure ?? null, needs_approval: Boolean(c.approval && ['disabled', 'sandbox'].includes(c.status)) }
  })
}

// Recorded AI costs in a period, by feature. Micro-dollars as recorded by each feature (estimates from token counts at
// list prices; the provider's invoice is the final word). Own-key usage is billed to the owner, so it is reported apart.
async function aiSpend(db, range) {
  const part = async (sql) => {
    try {
      const r = await db.prepare(sql).bind(range.from, range.to).first()
      return { uses: Number(r?.n || 0), micros: Math.round(Number(r?.c || 0)) }
    } catch {
      return null
    }
  }
  const parts = {
    owner_assistant: await part("SELECT count(*) AS n, coalesce(sum(json_extract(props, '$.costMicros')), 0) AS c FROM events WHERE type = 'ai_ask' AND at >= ?1 AND at < ?2"),
    admin_assistant: await part("SELECT count(*) AS n, coalesce(sum(json_extract(props, '$.costMicros')), 0) AS c FROM events WHERE type = 'admin_ai_ask' AND at >= ?1 AND at < ?2"),
    receptionist: await part('SELECT count(*) AS n, coalesce(sum(cost_micros), 0) AS c FROM receptionist_conversations WHERE updated_at >= ?1 AND updated_at < ?2'),
    website_ai: await part("SELECT count(*) AS n, coalesce(sum(cost_micros), 0) AS c FROM website_generations WHERE source = 'ai' AND created_at >= ?1 AND created_at < ?2"),
    follow_up_answers: await part("SELECT count(*) AS n, coalesce(sum(cost_micros), 0) AS c FROM thread_messages WHERE author = 'ai' AND created_at >= ?1 AND created_at < ?2"),
  }
  const ownKeys = await part('SELECT count(*) AS n, coalesce(sum(cost_micros), 0) AS c FROM ai_key_usage WHERE created_at >= ?1 AND created_at < ?2')
  const known = Object.values(parts).filter(Boolean)
  return { range, parts, totalMicros: known.length ? known.reduce((n, p) => n + p.micros, 0) : null, unreadable: Object.entries(parts).filter(([, v]) => !v).map(([k]) => k), ownKeys }
}

async function adminSpendToday(db, now) {
  const r = await db.prepare("SELECT count(*) AS n, coalesce(sum(json_extract(props, '$.costMicros')), 0) AS c, coalesce(sum(json_extract(props, '$.ok') = 1), 0) AS ok FROM events WHERE type = 'admin_ai_ask' AND at >= ?1").bind(now - (now % DAY)).first()
  const owner = await db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ai_ask' AND at >= ?1").bind(now - (now % DAY)).first()
  return { asks: Number(r?.n || 0), answered: Number(r?.ok || 0), micros: Math.round(Number(r?.c || 0)), ceilingMicros: ADMIN_DAILY_MICROS, ownerAsksToday: Number(owner?.n || 0), ownerSharedAllowance: RULES.aiAskAll.limit }
}

export { SALES_BUSINESS }
