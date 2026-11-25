// Stripe recurring billing: Checkout for new subscriptions, the Stripe customer portal for upgrades,
// downgrades, cancellation and reactivation, and signed webhooks to mirror subscription state.
// Configured only when STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set. No card data is stored;
// prices live in Stripe (plans reference Stripe Price ids). Nothing here suspends accounts.
import { queueRecoveryEmail } from './billing-recovery.js'
import { isComplimentary } from './business-accounts.js'
import { recordEvent } from './auditlog.js'
import { enforceAdsHold } from './ads/holds.js'
import { timingSafeEqual } from './google-oauth.js'
import { track } from './events.js'
import { testStatus } from './testbusiness.js'
import { adminEmails } from './platform.js'

// Live billing is a separate, explicit decision: unless STRIPE_LIVE_ENABLED is exactly 'true', only
// test-mode keys (sk_test_/rk_test_) count as configured, and live-mode events are refused.
export const stripeLiveEnabled = (env) => env.STRIPE_LIVE_ENABLED === 'true'
const testKey = (k) => /^(sk|rk)_test_/.test(String(k || ''))
// A live (non-test) secret key is in use. Test businesses (server/testbusiness.js) never reach live
// Stripe: checkout and the billing portal are refused for them, so no live charge can be created.
export const stripeLiveKey = (env) => Boolean(env.STRIPE_SECRET_KEY) && !testKey(env.STRIPE_SECRET_KEY)
export const liveBlocked = async (env, customerId) => stripeLiveKey(env) && (await testStatus(env, customerId)).test
// A sandbox (test-key) subscription unlocks the real product, so until live billing is on, sandbox checkout is only
// for authorized testers: a platform admin, an email listed in MESSAGE_TEST_RECIPIENTS, or a business a platform admin
// marked as a test business (a readable mark; an unreadable table never authorizes). Everyone else is told online
// sign-up isn't open yet. Live billing (STRIPE_LIVE_ENABLED) is open to every customer.
export async function sandboxCheckoutAllowed(env, customerId, email) {
  if (stripeLiveEnabled(env)) return true
  const e = String(email || '').trim().toLowerCase()
  const testers = String(env.MESSAGE_TEST_RECIPIENTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'))
  if (e && (adminEmails(env).includes(e) || testers.includes(e))) return true
  const t = await testStatus(env, customerId)
  return t.test === true && !t.unreadable
}
// A Stripe key is set but billing isn't usable (a live key without STRIPE_LIVE_ENABLED, or no webhook secret). New
// self-serve signups must then be refused, not created unbilled: an unbilled self-serve business never pays (fail closed).
export const billingMisconfigured = (env) => Boolean(env.STRIPE_SECRET_KEY) && !stripeConfigured(env)
export const stripeConfigured = (env) => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && (testKey(env.STRIPE_SECRET_KEY) || stripeLiveEnabled(env)))
// STRIPE_API_MOCK_ORIGIN is a loopback-only test override (e2e); never set in production.
const apiBase = (env) => {
  const o = env?.STRIPE_API_MOCK_ORIGIN
  return typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? `${o}/v1` : 'https://api.stripe.com/v1'
}
const TOLERANCE_SECONDS = 300

export async function listPlans(db, { includeInactive = false } = {}) {
  const { results } = await db
    .prepare(`SELECT * FROM plans ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY created_at`)
    .all()
  return results.map((p) => ({ id: p.id, name: p.name, stripePriceId: p.stripe_price_id, trialDays: p.trial_days, entitlements: JSON.parse(p.entitlements), active: Boolean(p.active) }))
}

// Form-encodes nested params the way Stripe expects (a[b][c]=v).
function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    const key = prefix ? `${prefix}[${k}]` : k
    if (typeof v === 'object') form(v, key, out)
    else out.append(key, String(v))
  }
  return out
}

export async function stripePost(env, path, params, { idempotencyKey, method = 'POST' } = {}) {
  try {
    const res = await fetch(`${apiBase(env)}${path}${method === 'GET' ? `?${form(params)}` : ''}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: method === 'POST' ? form(params) : undefined,
      signal: AbortSignal.timeout(10000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, httpStatus: res.status, error: /^[a-z_]{1,60}$/.test(body?.error?.code || '') ? body.error.code : 'stripe_error' }
    return { ok: true, body }
  } catch {
    return { ok: false, httpStatus: 0, error: 'network_error' }
  }
}

export async function getSubscription(db, customerId) {
  const s = await db.prepare('SELECT * FROM subscriptions WHERE customer = ?1').bind(customerId).first()
  if (!s) return null
  // livemode from the webhook (subscription_modes, 0013): true | false | null (never recorded / table missing).
  const m = await db.prepare('SELECT livemode FROM subscription_modes WHERE customer = ?1').bind(customerId).first().catch(() => null)
  return { status: s.status, planId: s.plan_id, currentPeriodEnd: s.current_period_end, cancelAtPeriodEnd: Boolean(s.cancel_at_period_end), stripeCustomerId: s.stripe_customer_id, stripeSubscriptionId: s.stripe_subscription_id, livemode: m ? m.livemode === 1 : null }
}

// The subscription as it counts for ACCESS. Once live billing is on, a subscription Stripe recorded in test mode
// (sandbox checkout before go-live) is not payment: it is reported as status 'sandbox' (not paid, not manageable),
// so the owner is asked to subscribe for real and live checkout can start. Admin-marked test businesses keep their
// sandbox subscription (they never use live Stripe). An 'incomplete' placeholder (checkout opened, never paid) is
// unchanged. With live billing off nothing changes. Stored rows are never modified here.
export async function billingSubscription(env, customerId) {
  const sub = await getSubscription(env.ONBOARDING_DB, customerId)
  if (!sub || !stripeLiveEnabled(env) || sub.livemode === true || sub.status === 'incomplete') return sub
  if ((await testStatus(env, customerId)).test) return sub
  return { ...sub, status: 'sandbox', sandbox: true, cancelAtPeriodEnd: false }
}

// Starts (or resumes) Stripe Checkout for one business. The business's Stripe customer is created once
// (idempotency key) and stored before Checkout, so every session and subscription hangs off the same
// customer. Before opening Checkout we ask Stripe whether that customer already has a subscription
// (covers a payment whose webhook has not arrived yet) and reuse a still-open session if there is one.
const LIVE_SUB = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']
export async function createCheckout(env, { customer, email, planId, origin }) {
  if (await liveBlocked(env, customer.id)) return { ok: false, httpStatus: 403, error: 'test_business' }
  if (await isComplimentary(env, customer.id)) return { ok: false, httpStatus: 403, error: 'complimentary' }
  if (!(await sandboxCheckoutAllowed(env, customer.id, email))) return { ok: false, httpStatus: 403, error: 'billing_not_live' }
  const db = env.ONBOARDING_DB
  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?1 AND active = 1').bind(planId).first()
  if (!plan) return { ok: false, httpStatus: 404, error: 'plan_not_found' }
  const existing = await billingSubscription(env, customer.id)
  if (existing && !['canceled', 'incomplete', 'sandbox'].includes(existing.status)) return { ok: false, httpStatus: 409, error: 'use_portal' }
  const neverSubscribed = !existing || existing.sandbox === true || (existing.status === 'incomplete' && !existing.stripeSubscriptionId)

  let stripeCustomer = existing?.stripeCustomerId
  // Live billing: a stored Stripe customer that was not recorded live may be a test-mode customer (sandbox
  // checkout before go-live), which live Stripe doesn't know. Ask live Stripe; only "no such customer" replaces
  // it (any other answer stops, so a live customer is never duplicated). A known sandbox subscription is replaced.
  let replace = existing?.sandbox === true
  if (stripeCustomer && !replace && stripeLiveEnabled(env) && existing.livemode !== true) {
    const c = await stripePost(env, `/customers/${encodeURIComponent(stripeCustomer)}`, {}, { method: 'GET' })
    if (!c.ok && c.error !== 'resource_missing') return c
    replace = !c.ok || c.body.deleted === true || c.body.livemode === false
  }
  if (replace) stripeCustomer = null
  if (!stripeCustomer) {
    const c = await stripePost(env, '/customers', { email, metadata: { customer: customer.id } }, { idempotencyKey: `gsu-customer-${customer.id}${replace ? '-live' : ''}` })
    if (!c.ok) return c
    stripeCustomer = c.body.id
    // A replaced sandbox record starts over as a live placeholder; the webhook fills in the live subscription.
    await db
      .prepare(
        `INSERT INTO subscriptions (customer, stripe_customer_id, status, last_event_at, updated_at) VALUES (?1, ?2, 'incomplete', 0, ?3)
         ON CONFLICT(customer) DO UPDATE SET stripe_customer_id = CASE WHEN ?4 = 1 THEN ?2 ELSE coalesce(subscriptions.stripe_customer_id, ?2) END,
           stripe_subscription_id = CASE WHEN ?4 = 1 THEN NULL ELSE subscriptions.stripe_subscription_id END,
           status = CASE WHEN ?4 = 1 THEN 'incomplete' ELSE subscriptions.status END,
           cancel_at_period_end = CASE WHEN ?4 = 1 THEN 0 ELSE subscriptions.cancel_at_period_end END,
           mrr_cents = CASE WHEN ?4 = 1 THEN 0 ELSE subscriptions.mrr_cents END,
           last_event_at = CASE WHEN ?4 = 1 THEN 0 ELSE subscriptions.last_event_at END, updated_at = ?3`,
      )
      .bind(customer.id, stripeCustomer, Date.now(), replace ? 1 : 0)
      .run()
    if (replace) await recordEvent(db, { type: 'billing.sandbox_replaced', actor: 'owner', actorType: 'owner', customer: customer.id, capability: 'billing.stripe', resource: { type: 'customer', id: customer.id }, outcome: 'success', details: { from: existing?.status ?? null } })
  } else {
    const subs = await stripePost(env, '/subscriptions', { customer: stripeCustomer, status: 'all', limit: 10 }, { method: 'GET' })
    if (!subs.ok) return subs
    if ((subs.body.data || []).some((x) => LIVE_SUB.includes(x.status))) return { ok: false, httpStatus: 409, error: 'use_portal' }
    const open = await stripePost(env, '/checkout/sessions', { customer: stripeCustomer, status: 'open', limit: 5 }, { method: 'GET' })
    const resume = open.ok && (open.body.data || []).find((x) => x.url && x.metadata?.plan === plan.id && x.mode === 'subscription')
    if (resume) return { ok: true, url: resume.url, resumed: true }
  }
  const r = await stripePost(env, '/checkout/sessions', {
    mode: 'subscription',
    client_reference_id: customer.id,
    customer: stripeCustomer,
    line_items: { 0: { price: plan.stripe_price_id, quantity: 1 } },
    // A trial is offered only to a business that has never subscribed (the founding plan has none).
    subscription_data: { metadata: { customer: customer.id, plan: plan.id }, trial_period_days: neverSubscribed && plan.trial_days > 0 ? plan.trial_days : undefined },
    metadata: { customer: customer.id, plan: plan.id },
    success_url: `${origin}/dashboard?billing=success`,
    cancel_url: `${origin}/dashboard?billing=canceled`,
    // Two tabs (or a double click) within a minute get the same Checkout, never two that could both be paid.
  }, { idempotencyKey: `gsu-checkout-${customer.id}-${plan.id}-${stripeCustomer}-${Math.floor(Date.now() / 60000)}` })
  return r.ok ? { ok: true, url: r.body.url } : r
}

export async function createPortal(env, { customer, origin }) {
  if (await liveBlocked(env, customer.id)) return { ok: false, httpStatus: 403, error: 'test_business' }
  const existing = await billingSubscription(env, customer.id)
  if (!existing?.stripeCustomerId || existing.sandbox) return { ok: false, httpStatus: 409, error: 'no_billing_account' }
  const r = await stripePost(env, '/billing_portal/sessions', { customer: existing.stripeCustomerId, return_url: `${origin}/dashboard` })
  return r.ok ? { ok: true, url: r.body.url } : r
}

// ---------- webhooks ----------

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Verifies the Stripe-Signature header (t=…,v1=…) against the raw body, with replay tolerance.
export async function verifySignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(header || '').split(',').map((p) => p.trim().split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false
  const expected = await hmacHex(secret, `${t}.${rawBody}`)
  return sigs.some((s) => timingSafeEqual(s, expected))
}

const STATUS = { trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', paused: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled', incomplete: 'incomplete' }
const MONTHLY = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 }

export function monthlyCents(subscription) {
  let total = 0
  for (const item of subscription?.items?.data || []) {
    const price = item.price || {}
    const r = price.recurring || {}
    if (!Number.isFinite(price.unit_amount) || !MONTHLY[r.interval]) continue
    total += (price.unit_amount * (item.quantity || 1) * MONTHLY[r.interval]) / (r.interval_count || 1)
  }
  return Math.round(total)
}

async function customerFor(db, obj) {
  // Invoices: subscription metadata is at parent.subscription_details (API 2025-03-31+); older versions
  // used subscription_details at the top level.
  const fromMeta = obj?.metadata?.customer || obj?.client_reference_id || obj?.parent?.subscription_details?.metadata?.customer || obj?.subscription_details?.metadata?.customer
  if (fromMeta && (await db.prepare('SELECT 1 FROM customers WHERE id = ?1').bind(fromMeta).first())) return fromMeta
  if (obj?.customer) return (await db.prepare('SELECT customer FROM subscriptions WHERE stripe_customer_id = ?1').bind(obj.customer).first())?.customer ?? null
  return null
}

async function upsertSubscription(env, customer, event, sub) {
  const db = env.ONBOARDING_DB
  const at = event.created * 1000
  const prior = await db.prepare('SELECT status, last_event_at, cancel_at_period_end FROM subscriptions WHERE customer = ?1').bind(customer).first()
  if (prior && prior.last_event_at > at) return // an older event arriving late: ignore
  const status = event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[sub.status] || 'incomplete'
  const priceId = sub.items?.data?.[0]?.price?.id
  // The billing period end lives on subscription items since API 2025-03-31; older versions had it on
  // the subscription. Use whichever is present (latest item end when several).
  const itemEnds = (sub.items?.data || []).map((i) => i.current_period_end).filter(Number.isFinite)
  const periodEnd = sub.current_period_end ?? (itemEnds.length ? Math.max(...itemEnds) : null)
  // A scheduled cancellation: older API versions set cancel_at_period_end; current versions (seen with
  // 2026-10-28 from the customer portal) set cancel_at and leave cancel_at_period_end false.
  const cancelScheduled = Boolean(sub.cancel_at_period_end || (sub.cancel_at && status !== 'canceled'))
  const plan = priceId ? await db.prepare('SELECT id FROM plans WHERE stripe_price_id = ?1').bind(priceId).first() : null
  await db
    .prepare(
      `INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, cancel_at_period_end, last_event_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(customer) DO UPDATE SET stripe_customer_id = ?2, stripe_subscription_id = ?3, plan_id = ?4, status = ?5, mrr_cents = ?6,
         currency = ?7, current_period_end = ?8, cancel_at_period_end = ?9, last_event_at = ?10, updated_at = ?11`,
    )
    .bind(customer, sub.customer, sub.id, plan?.id ?? null, status, monthlyCents(sub), sub.currency || null, periodEnd ? periodEnd * 1000 : null, cancelScheduled ? 1 : 0, at, Date.now())
    .run()
  await recordMode(db, customer, event)
  const billingAudit = (action, details) =>
    recordEvent(db, { type: action, actor: 'stripe', customer, capability: 'billing.stripe', resource: { type: 'subscription', id: sub.id }, correlationId: `stripe:${event.id}`, details: { livemode: event.livemode === true, ...details }, at })
  if (prior?.status !== status) await billingAudit('billing.subscription_status', { from: prior?.status ?? null, to: status, plan: plan?.id ?? null })
  if (Boolean(prior?.cancel_at_period_end) !== cancelScheduled && status !== 'canceled') await billingAudit(cancelScheduled ? 'billing.cancellation_scheduled' : 'billing.cancellation_withdrawn', { periodEnd: periodEnd ? periodEnd * 1000 : null })
  if (prior?.status !== status) {
    const type = status === 'canceled' ? 'subscription_canceled' : !prior || prior.status === 'incomplete' || prior.status === 'canceled' ? 'subscription_started' : 'subscription_status_changed'
    await track(env, type, { id: `stripe:${event.id}`, customer, props: { from: prior?.status ?? null, to: status, plan: plan?.id ?? null }, at })
  }
}

// Records whether this business's subscription is Stripe live or test mode (revenue counts live only).
// Best effort: before migration 0013 is applied the table is missing; the subscription itself is already
// stored, and an unrecorded mode is treated as test (never counted as revenue), so the webhook still succeeds.
async function recordMode(db, customer, event) {
  try {
    await db
      .prepare('INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(customer) DO UPDATE SET livemode = ?2, updated_at = ?3')
      .bind(customer, event.livemode === true ? 1 : 0, Date.now())
      .run()
  } catch (err) {
    console.error('subscription mode not recorded:', err?.message?.includes('no such table') ? 'table_missing' : 'storage_error')
  }
}

// Applies one verified event. Throws on storage errors so the caller can let Stripe retry.
// after(fn): work that must follow the stored change but must not fail or delay the receipt (ads holds:
// pausing campaigns on Google). The webhook runs it after responding; the cron sweep retries any failure.
export async function handleEvent(env, event, { after = null } = {}) {
  const correlationId = `stripe:${event.id}`
  const holdCheck = (customer) => after?.(() => enforceAdsHold(env, customer, { actor: 'system:billing', correlationId }))
  const db = env.ONBOARDING_DB
  const obj = event.data?.object || {}
  const customer = await customerFor(db, obj)
  switch (event.type) {
    case 'checkout.session.completed':
      if (customer && obj.customer) {
        await db
          .prepare(
            `INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, status, last_event_at, updated_at) VALUES (?1, ?2, ?3, 'incomplete', 0, ?4)
             ON CONFLICT(customer) DO UPDATE SET stripe_customer_id = ?2, stripe_subscription_id = coalesce(?3, stripe_subscription_id), updated_at = ?4`,
          )
          .bind(customer, obj.customer, obj.subscription || null, Date.now())
          .run()
      }
      return { handled: Boolean(customer) }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      if (customer) {
        await upsertSubscription(env, customer, event, obj)
        holdCheck(customer)
      }
      return { handled: Boolean(customer) }
    case 'invoice.paid':
      // Any successful payment (including $0) closes an earlier payment failure for ads holds.
      if (customer) {
        await track(env, 'payment_succeeded', { id: `paid:${obj.id}`, customer, at: event.created * 1000 })
        await recordEvent(db, { type: 'billing.payment_succeeded', actor: 'stripe', customer, capability: 'billing.stripe', resource: { type: 'invoice', id: obj.id }, correlationId, details: { amountCents: obj.amount_paid ?? null, currency: obj.currency ?? null, livemode: event.livemode === true }, at: event.created * 1000 })
      }
      if (customer && obj.amount_paid > 0) {
        await track(env, 'revenue', { id: `revenue:${obj.id}`, customer, props: { amountCents: obj.amount_paid, currency: obj.currency, livemode: event.livemode === true }, at: event.created * 1000 })
      }
      return { handled: Boolean(customer) }
    case 'invoice.payment_failed':
      if (customer) {
        await track(env, 'payment_failed', { id: `stripe:${event.id}`, customer, at: event.created * 1000 })
        await recordEvent(db, { type: 'billing.payment_failed', actor: 'stripe', customer, capability: 'billing.stripe', resource: { type: 'invoice', id: obj.id ?? event.id }, correlationId, details: { livemode: event.livemode === true }, at: event.created * 1000 })
        holdCheck(customer) // owner decision: ads pause on the first failed payment
        // One recovery email per invoice to the owners (outbox; the MESSAGES_LIVE gate applies).
        await queueRecoveryEmail(env, customer, String(obj.id || event.id), { correlationId, now: event.created * 1000 })
      }
      return { handled: Boolean(customer) }
    default:
      return { handled: false }
  }
}

// ---------- account deletion ----------
// Ends billing for a deleted business at once: every subscription of its Stripe customer is canceled now (no
// proration credit, no final invoice), Stripe is asked again to confirm, then the Stripe customer object is
// deleted (Stripe keeps its own transaction records for its legal duties). Idempotent: already canceled or
// already deleted counts as done. Returns { ok, canceled, customerDeleted } or { ok: false, error }.
const ENDED_SUB = ['canceled', 'incomplete_expired']

// Read-only: true when Stripe reports the subscription ended (or no longer exists).
export const stripeModeMismatch = (env, sub) => sub?.livemode === true && !stripeLiveKey(env)
// mustExist: a live subscription always stays readable in Stripe after it ends, so "not found" means the wrong account.
export async function subscriptionEnded(env, id, { mustExist = false } = {}) {
  const r = await stripePost(env, `/subscriptions/${encodeURIComponent(id)}`, {}, { method: 'GET' })
  if (!r.ok) return r.error === 'resource_missing' && !mustExist ? { ok: true, ended: true } : r
  return { ok: true, ended: ENDED_SUB.includes(r.body.status) }
}

export async function endBillingNow(env, { stripeCustomerId = null, stripeSubscriptionId = null, mustExist = false } = {}) {
  const ids = new Set(stripeSubscriptionId ? [stripeSubscriptionId] : [])
  if (stripeCustomerId) {
    const list = await stripePost(env, '/subscriptions', { customer: stripeCustomerId, status: 'all', limit: 100 }, { method: 'GET' })
    if (!list.ok && list.error !== 'resource_missing') return list
    for (const s of list.ok ? list.body.data || [] : []) if (LIVE_SUB.includes(s.status)) ids.add(s.id)
  }
  let canceled = 0
  let notFound = 0
  for (const id of ids) {
    const path = `/subscriptions/${encodeURIComponent(id)}`
    const before = await stripePost(env, path, {}, { method: 'GET' })
    if (!before.ok && (before.error !== 'resource_missing' || (mustExist && id === stripeSubscriptionId))) return before
    if (!before.ok) {
      notFound++
      continue
    }
    if (before.ok && !ENDED_SUB.includes(before.body.status)) {
      const del = await stripePost(env, path, {}, { method: 'DELETE' })
      if (!del.ok && del.error !== 'resource_missing') return del
    }
    const check = await stripePost(env, path, {}, { method: 'GET' })
    if (!check.ok && check.error !== 'resource_missing') return check
    if (check.ok && !ENDED_SUB.includes(check.body.status)) return { ok: false, error: 'not_canceled' }
    canceled++
  }
  let customerDeleted = false
  if (stripeCustomerId) {
    const del = await stripePost(env, `/customers/${encodeURIComponent(stripeCustomerId)}`, {}, { method: 'DELETE' })
    if (!del.ok && del.error !== 'resource_missing') return del
    customerDeleted = true
  }
  return { ok: true, canceled, notFound, customerDeleted }
}

// ---------- reconciliation (read-only) ----------
// Lists every subscription (all statuses) and the paid invoices since a time, following Stripe's pagination.
async function listAll(env, path, params, cap = 20000) {
  const out = []
  let after
  for (;;) {
    const r = await stripePost(env, path, { ...params, limit: 100, starting_after: after }, { method: 'GET' })
    if (!r.ok) return r
    out.push(...(r.body.data || []))
    if (!r.body.has_more || !out.length) return { ok: true, data: out, complete: true }
    if (out.length >= cap) return { ok: true, data: out, complete: false }
    after = out.at(-1).id
  }
}
export const listStripeSubscriptions = (env) => listAll(env, '/subscriptions', { status: 'all' })
export const listPaidInvoices = (env, sinceSec) => listAll(env, '/invoices', { status: 'paid', created: { gte: sinceSec } })
export const fetchStripeSubscription = (env, id) => stripePost(env, `/subscriptions/${encodeURIComponent(id)}`, {}, { method: 'GET' })
export const stripeStatus = (s) => (s === 'deleted' ? 'canceled' : STATUS[s] || 'incomplete')
