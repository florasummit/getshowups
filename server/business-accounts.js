// Business account types (docs/ACCOUNT_TYPES.md, migration 0034): the ONE place that says whether a business pays
// GetShowUps, which environment it operates in, and whether paid outside providers may serve its customers.
//
//   internal_live  GetShowUps-owned business with real customers (PoolThru): billing complimentary, environment
//                  production, provider spend allowed. Real leads/bookings/messages; never counted as a paying
//                  customer; never held, downgraded or resynced by Stripe reconciliation.
//   sandbox        admin-created test business: billing complimentary, environment sandbox (also in test_businesses,
//                  which carries every existing sandbox safeguard: test Ads accounts only, test recipients only, no
//                  live Stripe, out of metrics), provider spend blocked by default (paid testing goes through the
//                  admin-only Voice Lab or an explicit 'allowed').
//   customer       ordinary paying customer: billing stripe, environment production (the default when no row exists;
//                  an explicit row only records an audited reclassification).
//
// Four concepts, kept apart: classification (who owns it), billing (entitlement), environment (where it operates),
// provider_spend (outside paid providers for customer-facing use). Every decision is server-side; only platform
// admins write here (functions/api/platform/account.js, which audits every change with from/to into admin_audit and
// the permanent audit_log); customer users have no route to it. Reads fail soft: before the migration is applied
// every business is an ordinary customer, exactly as before.
import { CUSTOMER_RE } from './invites.js'
import { setTestBusiness, testStatus } from './testbusiness.js'
import { getSubscription } from './stripe.js'
import { createCustomer, getCustomer } from './customers.js'

export const CLASSIFICATIONS = {
  internal_live: { label: 'Internal live', billing: 'complimentary', environment: 'production', providerSpend: 'allowed', what: 'GetShowUps-owned business with real customers. Complimentary platform entitlement; real leads, bookings, messages and revenue; never counted as a paying customer.' },
  sandbox: { label: 'Admin sandbox', billing: 'complimentary', environment: 'sandbox', providerSpend: 'blocked', what: 'Development, testing, demos. Complimentary; clearly test data; excluded from customer and revenue reporting; no live messaging, bookings or ad spend by default.' },
  customer: { label: 'Paying customer', billing: 'stripe', environment: 'production', providerSpend: 'allowed', what: 'Ordinary external customer: normal Stripe onboarding, subscription and plan entitlements.' },
}
const DEFAULT = Object.freeze({ classification: 'customer', billing: 'stripe', environment: 'production', providerSpend: 'allowed', note: '', setBy: null, setAt: null, recorded: false })

const noTable = (err) => /no such table/i.test(String(err?.message || ''))
export async function accountsReady(db) {
  try {
    await db.prepare('SELECT 1 FROM business_accounts LIMIT 1').first()
    return true
  } catch (err) {
    if (noTable(err)) return false
    throw err
  }
}

// The account view of one business. Never throws for a missing table (the default), throws on storage errors.
export async function accountOf(env, customerId) {
  if (!CUSTOMER_RE.test(String(customerId || ''))) return { ...DEFAULT }
  try {
    const r = await env.ONBOARDING_DB.prepare('SELECT classification, billing, environment, provider_spend, note, set_by, set_at FROM business_accounts WHERE customer = ?1').bind(customerId).first()
    if (!r) return { ...DEFAULT }
    return { classification: r.classification, billing: r.billing, environment: r.environment, providerSpend: r.provider_spend, note: r.note, setBy: r.set_by, setAt: r.set_at, recorded: true }
  } catch (err) {
    if (noTable(err)) return { ...DEFAULT }
    throw err
  }
}
// Map of every recorded account (customer → view) for list views; null when the table does not exist.
export async function accountsMap(env) {
  try {
    const { results } = await env.ONBOARDING_DB.prepare('SELECT customer, classification, billing, environment, provider_spend FROM business_accounts').all()
    return new Map(results.map((r) => [r.customer, { classification: r.classification, billing: r.billing, environment: r.environment, providerSpend: r.provider_spend }]))
  } catch (err) {
    if (noTable(err)) return null
    throw err
  }
}
export const isComplimentary = async (env, customerId) => (await accountOf(env, customerId)).billing === 'complimentary'
// Customer-facing paid providers (ads live launch, public receptionist chat/voice) for this business?
// An assisted-enrollment workspace (server/enrollment.js, migration 0047) is blocked until Stripe's verified subscription
// event marked it paid: no paid provider serves customers of a business that hasn't paid.
export const providerSpendAllowed = async (env, customerId) => (await accountOf(env, customerId)).providerSpend === 'allowed' && !(await assistedUnpaid(env, customerId))
export async function assistedUnpaid(env, customerId) {
  try {
    return Boolean(await env.ONBOARDING_DB.prepare("SELECT 1 FROM assisted_enrollments WHERE customer = ?1 AND paid_at IS NULL AND stage <> 'claimed'").bind(customerId).first())
  } catch (err) {
    if (noTable(err)) return false
    throw err
  }
}
// SQL fragment: businesses billed by Stripe (no complimentary row). Only valid once accountsReady().
export const stripeBilledSql = (col) => `NOT EXISTS (SELECT 1 FROM business_accounts ba WHERE ba.customer = ${col} AND ba.billing = 'complimentary')`

// Reclassify one business (platform admin, confirmed, audited). Derived fields follow the classification; the only
// per-business choice is provider_spend. Refused when the business has a LIVE Stripe subscription still running
// (nothing is cancelled automatically: the admin ends it in Stripe first). Sandbox ⇄ production moves the test mark
// through the existing setTestBusiness (unmarking never promotes sandbox-era data). Never touches Stripe records.
export async function classifyBusiness(env, admin, customerId, classification, { note = '', providerSpend = null } = {}, now = Date.now()) {
  if (!CUSTOMER_RE.test(String(customerId || ''))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const spec = CLASSIFICATIONS[classification]
  if (!spec) return { ok: false, httpStatus: 400, error: 'invalid_classification' }
  if (providerSpend != null && !['allowed', 'blocked'].includes(providerSpend)) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const db = env.ONBOARDING_DB
  if (!(await accountsReady(db))) return { ok: false, httpStatus: 503, error: 'migration_required' }
  const row = await getCustomer(db, customerId)
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  const sub = await getSubscription(db, customerId)
  if (classification !== 'customer' && sub?.stripeSubscriptionId && sub.livemode === true && ['active', 'trialing', 'past_due'].includes(sub.status)) return { ok: false, httpStatus: 409, error: 'live_subscription_running' }
  const before = await accountOf(env, customerId)
  const spend = providerSpend || spec.providerSpend
  const cleanNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  await db
    .prepare(
      `INSERT INTO business_accounts (customer, classification, billing, environment, provider_spend, note, set_by, set_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(customer) DO UPDATE SET classification = ?2, billing = ?3, environment = ?4, provider_spend = ?5, note = ?6, set_by = ?7, set_at = ?8`,
    )
    .bind(customerId, classification, spec.billing, spec.environment, spend, cleanNote, admin.email, now)
    .run()
  // Environment ⇄ test mark (the existing sandbox safeguards live there).
  const t = await testStatus(env, customerId)
  const wantTest = spec.environment === 'sandbox'
  let mark = { changed: false }
  if (!t.unreadable && t.test !== wantTest) mark = await setTestBusiness(env, customerId, wantTest, admin.email, now)
  // The caller (the platform route) writes the ONE audit record (admin_audit + permanent audit_log) with these details.
  return { ok: true, from: before.recorded ? before.classification : 'customer', note: cleanNote, account: await accountOf(env, customerId), testMark: { test: wantTest, changed: Boolean(mark.changed) }, subscription: sub ? { status: sub.status, stripe: Boolean(sub.stripeSubscriptionId), livemode: sub.livemode } : null }
}

// Create an internal-live or sandbox business (platform admin). The optional owner must not already own a business
// (customer_users.email is unique); without one, admins drive it from the console and the Lab until an owner is
// linked. Uses the ordinary creation path (never a self_signups row, so never a payment step).
export async function createClassifiedBusiness(env, admin, { name, classification, ownerEmail = '', timezone = 'America/New_York', note = '' }, now = Date.now()) {
  const spec = CLASSIFICATIONS[classification]
  if (!spec || classification === 'customer') return { ok: false, httpStatus: 400, error: 'invalid_classification' }
  const clean = String(name || '').replace(/\s+/g, ' ').trim()
  if (clean.length < 2 || clean.length > 80) return { ok: false, httpStatus: 400, error: 'invalid_name' }
  const email = String(ownerEmail || '').trim().toLowerCase()
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return { ok: false, httpStatus: 400, error: 'invalid_email' }
  const db = env.ONBOARDING_DB
  if (!(await accountsReady(db))) return { ok: false, httpStatus: 503, error: 'migration_required' }
  if (email && (await db.prepare('SELECT customer FROM customer_users WHERE lower(email) = ?1').bind(email).first())) return { ok: false, httpStatus: 409, error: 'owner_has_business' }
  const id = await createCustomer(env, email || null, { name: clean, timezone, serviceZips: [], appointmentMode: 'at_business' }, { source: 'platform', via: 'admin_link' }, now)
  const r = await classifyBusiness(env, admin, id, classification, { note }, now)
  if (!r.ok) return r
  return { ok: true, id, account: r.account }
}

// Estimated outside-provider costs for one business (operational analytics; estimates, never charges to the
// business): receptionist model usage, website AI usage, ad creatives, ad spend synced from the platforms, Voice Lab
// minutes. Each source is read fail-soft (a missing table reads as 0).
export async function providerCosts(env, customerId, days = 30, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const since = now - days * 86_400_000
  const one = async (sql, ...args) => {
    try {
      return (await db.prepare(sql).bind(...args).first()) || {}
    } catch (err) {
      if (noTable(err)) return {}
      throw err
    }
  }
  const r = await one('SELECT coalesce(sum(cost_micros), 0) AS micros, count(*) AS n FROM receptionist_conversations WHERE customer = ?1 AND updated_at >= ?2', customerId, since)
  const w = await one('SELECT coalesce(sum(cost_micros), 0) AS micros, count(*) AS n FROM website_generations WHERE customer = ?1 AND created_at >= ?2', customerId, since)
  const c = await one('SELECT coalesce(sum(cost_cents), 0) AS cents, count(*) AS n FROM ai_usage WHERE customer = ?1 AND at >= ?2', customerId, since)
  const a = await one("SELECT coalesce(sum(spend_cents), 0) AS cents, count(*) AS n FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2", customerId, new Date(since).toISOString().slice(0, 10))
  const l = await one("SELECT coalesce(sum(coalesce(ended_at, ?3) - created_at), 0) AS ms, count(*) AS n FROM receptionist_calls WHERE customer = ?1 AND created_at >= ?2 AND provider IN ('openai', 'elevenlabs', 'retell-lab')", customerId, since, now)
  const items = [
    { key: 'receptionist', label: 'AI receptionist (model usage)', micros: Number(r.micros || 0), n: Number(r.n || 0), unit: 'conversations' },
    { key: 'websiteAi', label: 'Website AI generations', micros: Number(w.micros || 0), n: Number(w.n || 0), unit: 'generations' },
    { key: 'adCreatives', label: 'Ad creatives (AI images/video)', micros: Number(c.cents || 0) * 10_000, n: Number(c.n || 0), unit: 'creatives' },
    { key: 'adSpend', label: 'Ad spend synced from platforms', micros: Number(a.cents || 0) * 10_000, n: Number(a.n || 0), unit: 'campaign-days' },
    { key: 'voiceLab', label: 'Voice Lab minutes (provider time)', micros: null, n: Math.ceil(Number(l.ms || 0) / 60_000), unit: 'minutes' },
  ]
  return { days, items, totalMicros: items.reduce((s, i) => s + (i.micros || 0), 0), estimate: true }
}
