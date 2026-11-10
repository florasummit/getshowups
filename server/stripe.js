// Stripe recurring billing: Checkout for new subscriptions, the Stripe customer portal for upgrades,
// downgrades, cancellation and reactivation, and signed webhooks to mirror subscription state.
// Configured only when STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set. No card data is stored;
// prices live in Stripe (plans reference Stripe Price ids). Nothing here suspends accounts.
import { timingSafeEqual } from './google-oauth.js'
import { track } from './events.js'

// Live billing is a separate, explicit decision: unless STRIPE_LIVE_ENABLED is exactly 'true', only
// test-mode keys (sk_test_/rk_test_) count as configured, and live-mode events are refused.
export const stripeLiveEnabled = (env) => env.STRIPE_LIVE_ENABLED === 'true'
const testKey = (k) => /^(sk|rk)_test_/.test(String(k || ''))
export const stripeConfigured = (env) => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && (testKey(env.STRIPE_SECRET_KEY) || stripeLiveEnabled(env)))
const API = 'https://api.stripe.com/v1'
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

async function stripePost(env, path, params) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form(params),
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
  return s
    ? { status: s.status, planId: s.plan_id, currentPeriodEnd: s.current_period_end, cancelAtPeriodEnd: Boolean(s.cancel_at_period_end), stripeCustomerId: s.stripe_customer_id }
    : null
}

export async function createCheckout(env, { customer, email, planId, origin }) {
  const plan = await env.ONBOARDING_DB.prepare('SELECT * FROM plans WHERE id = ?1 AND active = 1').bind(planId).first()
  if (!plan) return { ok: false, httpStatus: 404, error: 'plan_not_found' }
  const existing = await getSubscription(env.ONBOARDING_DB, customer.id)
  if (existing && existing.status !== 'canceled' && existing.status !== 'incomplete') return { ok: false, httpStatus: 409, error: 'use_portal' }
  const r = await stripePost(env, '/checkout/sessions', {
    mode: 'subscription',
    client_reference_id: customer.id,
    customer: existing?.stripeCustomerId || undefined,
    customer_email: existing?.stripeCustomerId ? undefined : email,
    line_items: { 0: { price: plan.stripe_price_id, quantity: 1 } },
    // A trial is offered only to a business that has never subscribed.
    subscription_data: { metadata: { customer: customer.id, plan: plan.id }, trial_period_days: !existing && plan.trial_days > 0 ? plan.trial_days : undefined },
    metadata: { customer: customer.id, plan: plan.id },
    success_url: `${origin}/dashboard?billing=success`,
    cancel_url: `${origin}/dashboard?billing=canceled`,
  })
  return r.ok ? { ok: true, url: r.body.url } : r
}

export async function createPortal(env, { customer, origin }) {
  const existing = await getSubscription(env.ONBOARDING_DB, customer.id)
  if (!existing?.stripeCustomerId) return { ok: false, httpStatus: 409, error: 'no_billing_account' }
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
  const prior = await db.prepare('SELECT status, last_event_at FROM subscriptions WHERE customer = ?1').bind(customer).first()
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
  if (prior?.status !== status) {
    const type = status === 'canceled' ? 'subscription_canceled' : !prior || prior.status === 'incomplete' || prior.status === 'canceled' ? 'subscription_started' : 'subscription_status_changed'
    await track(env, type, { id: `stripe:${event.id}`, customer, props: { from: prior?.status ?? null, to: status, plan: plan?.id ?? null }, at })
  }
}

// Applies one verified event. Throws on storage errors so the caller can let Stripe retry.
export async function handleEvent(env, event) {
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
      if (customer) await upsertSubscription(env, customer, event, obj)
      return { handled: Boolean(customer) }
    case 'invoice.paid':
      if (customer && obj.amount_paid > 0) {
        await track(env, 'revenue', { id: `revenue:${obj.id}`, customer, props: { amountCents: obj.amount_paid, currency: obj.currency }, at: event.created * 1000 })
      }
      return { handled: Boolean(customer) }
    case 'invoice.payment_failed':
      if (customer) await track(env, 'payment_failed', { id: `stripe:${event.id}`, customer, at: event.created * 1000 })
      return { handled: Boolean(customer) }
    default:
      return { handled: false }
  }
}
