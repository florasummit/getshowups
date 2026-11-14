// Billing reconciliation: Stripe (where the money is) against our records. Read-only toward Stripe; it reports
// differences and never fixes them by itself. A platform admin can resync one business from Stripe (audited).
// Runs daily from the cron and on demand from /admin; every run is recorded in the permanent audit log
// (ids, statuses and amounts only, no personal data).
import { appendAudit } from './auditlog.js'
import { fetchStripeSubscription, handleEvent, listPaidInvoices, listStripeSubscriptions, monthlyCents, stripeConfigured, stripeLiveEnabled, stripeStatus } from './stripe.js'

const DAY = 86400000
const WINDOW_DAYS = 35
const LIVE = ['active', 'trialing', 'past_due', 'incomplete']

export const ISSUE_TEXT = {
  billing_after_deletion: 'Stripe still has a running subscription for a deleted account',
  incomplete_listing: 'Too many subscriptions to list in one run; missing-subscription check skipped',
  stripe_only: 'Subscription in Stripe that our records don’t have',
  ours_only: 'Our records point to a subscription Stripe doesn’t have',
  status_mismatch: 'Status differs from Stripe',
  amount_mismatch: 'Monthly amount differs from Stripe',
  cancel_mismatch: 'Scheduled cancellation differs from Stripe',
  mode_mismatch: 'Live/test mode differs from Stripe',
  payment_not_recorded: 'Paid invoice in Stripe not recorded here',
  payment_unknown: 'Recorded payment not found among Stripe’s paid invoices',
}

async function deletedSet(db) {
  try {
    return new Set((await db.prepare('SELECT customer FROM account_deletions').all()).results.map((r) => r.customer))
  } catch {
    return new Set()
  }
}

export async function reconcileBilling(env, { now = Date.now(), actor = 'system:reconcile' } = {}) {
  if (!stripeConfigured(env)) return { ok: false, error: 'not_configured' }
  const db = env.ONBOARDING_DB
  const since = now - WINDOW_DAYS * DAY
  const [subs, invoices] = await Promise.all([listStripeSubscriptions(env), listPaidInvoices(env, Math.floor(since / 1000))])
  if (!subs.ok) return { ok: false, error: `stripe_${subs.error}` }
  if (!invoices.ok) return { ok: false, error: `stripe_${invoices.error}` }
  const { results: ours } = await db.prepare('SELECT * FROM subscriptions').all()
  const modes = new Map(
    (await db.prepare('SELECT customer, livemode FROM subscription_modes').all().catch(() => ({ results: [] }))).results.map((r) => [r.customer, r.livemode === 1]),
  )
  const deleted = await deletedSet(db)
  const bySubId = new Map(ours.filter((o) => o.stripe_subscription_id).map((o) => [o.stripe_subscription_id, o]))
  const byStripeCustomer = new Map(ours.filter((o) => o.stripe_customer_id).map((o) => [o.stripe_customer_id, o.customer]))
  const issues = []
  const add = (type, customer, extra = {}) => issues.push({ type, customer: customer ?? null, ...extra })

  const seen = new Set()
  for (const s of subs.data) {
    seen.add(s.id)
    const customer = bySubId.get(s.id)?.customer ?? s.metadata?.customer ?? byStripeCustomer.get(s.customer) ?? null
    if (customer && deleted.has(customer) && LIVE.includes(s.status)) {
      add('billing_after_deletion', customer, { subscription: s.id, stripe: s.status })
      continue
    }
    const o = bySubId.get(s.id)
    if (!o) {
      // Ended subscriptions that were replaced later are history, not a problem.
      if (LIVE.includes(s.status)) add('stripe_only', customer, { subscription: s.id, stripe: s.status })
      continue
    }
    const theirs = stripeStatus(s.status)
    if (theirs !== o.status) add('status_mismatch', o.customer, { subscription: s.id, ours: o.status, stripe: theirs })
    if (o.status === 'active' && monthlyCents(s) !== (o.mrr_cents || 0)) add('amount_mismatch', o.customer, { subscription: s.id, ours: o.mrr_cents || 0, stripe: monthlyCents(s) })
    const cancel = Boolean(s.cancel_at_period_end || (s.cancel_at && s.status !== 'canceled'))
    if (o.status !== 'canceled' && cancel !== Boolean(o.cancel_at_period_end)) add('cancel_mismatch', o.customer, { subscription: s.id, ours: Boolean(o.cancel_at_period_end), stripe: cancel })
    if (modes.has(o.customer) && modes.get(o.customer) !== (s.livemode === true)) add('mode_mismatch', o.customer, { subscription: s.id, ours: modes.get(o.customer), stripe: s.livemode === true })
  }
  // Only when Stripe's list was complete: a truncated list would turn every unseen subscription into a false alarm.
  if (subs.complete !== false) {
    for (const o of ours) {
      if (o.stripe_subscription_id && !seen.has(o.stripe_subscription_id) && o.status !== 'canceled') add('ours_only', o.customer, { subscription: o.stripe_subscription_id, ours: o.status })
    }
  } else add('incomplete_listing', null, { stripe: subs.data.length })

  // Payments in the last 35 days, both ways (only invoices with money; $0 invoices are not revenue).
  const paid = invoices.data.filter((i) => (i.amount_paid || 0) > 0)
  const { results: revenue } = await db.prepare("SELECT id, customer FROM events WHERE type = 'revenue' AND at >= ?1").bind(since).all()
  const recorded = new Set(revenue.map((r) => r.id))
  const stripeInvoices = new Set(paid.map((i) => `revenue:${i.id}`))
  for (const i of paid) {
    const customer = i.parent?.subscription_details?.metadata?.customer ?? i.subscription_details?.metadata?.customer ?? i.metadata?.customer ?? byStripeCustomer.get(i.customer) ?? null
    if (!recorded.has(`revenue:${i.id}`)) add('payment_not_recorded', customer, { invoice: i.id, stripe: i.amount_paid })
  }
  for (const r of revenue) if (!stripeInvoices.has(r.id)) add('payment_unknown', r.customer, { invoice: r.id.replace(/^revenue:/, '') })

  const byType = {}
  for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1
  const result = { ok: true, at: now, checked: { subscriptions: subs.data.length, records: ours.length, invoices: paid.length, windowDays: WINDOW_DAYS }, issues: issues.length, byType, list: issues.slice(0, 50) }
  await appendAudit(db, { actorType: actor.startsWith('system') ? 'system' : 'admin', actor, action: 'billing.reconciliation', details: result, at: now })
  if (issues.length) console.error('billing reconciliation: issues', JSON.stringify(byType))
  return result
}

export async function lastReconciliation(db) {
  try {
    const r = await db.prepare("SELECT at, details FROM audit_log WHERE action = 'billing.reconciliation' ORDER BY seq DESC LIMIT 1").first()
    return r ? JSON.parse(r.details) : null
  } catch {
    return null
  }
}

// Cron: once a day.
export async function dailyReconciliation(env, now = Date.now()) {
  if (!stripeConfigured(env)) return { skipped: 'not_configured' }
  const last = await lastReconciliation(env.ONBOARDING_DB)
  if (last && now - last.at < DAY) return { skipped: 'recent' }
  const r = await reconcileBilling(env, { now })
  return r.ok ? { issues: r.issues } : { error: r.error }
}

// Admin fix for one business: take Stripe's current subscription and apply it exactly like a webhook would.
export async function resyncFromStripe(env, customerId, now = Date.now()) {
  if (!stripeConfigured(env)) return { ok: false, error: 'not_configured' }
  const o = await env.ONBOARDING_DB.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE customer = ?1').bind(customerId).first()
  if (!o?.stripe_subscription_id) return { ok: false, error: 'no_subscription' }
  const r = await fetchStripeSubscription(env, o.stripe_subscription_id)
  if (!r.ok) return { ok: false, error: `stripe_${r.error}` }
  if (r.body.livemode === true && !stripeLiveEnabled(env)) return { ok: false, error: 'livemode_not_enabled' }
  const sub = { ...r.body, metadata: { ...(r.body.metadata || {}), customer: customerId } }
  const later = []
  await handleEvent(
    env,
    { id: `resync_${customerId}_${now}`, type: sub.status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', created: Math.floor(now / 1000), livemode: r.body.livemode === true, data: { object: sub } },
    { after: (fn) => later.push(fn) },
  )
  for (const fn of later) await Promise.resolve().then(fn).catch(() => {}) // ads hold check; the cron sweep retries
  const after = await env.ONBOARDING_DB.prepare('SELECT status, mrr_cents FROM subscriptions WHERE customer = ?1').bind(customerId).first()
  return { ok: true, status: after.status, mrrCents: after.mrr_cents }
}
