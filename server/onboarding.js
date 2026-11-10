// Self-serve onboarding: who must pay before setup, the ordered steps (derived from saved data so any
// device resumes at the right place), the business profile collected during onboarding, and the
// launch-readiness checklist shown at the end of onboarding and on the dashboard.
import { unapprovedClaims } from './ads/spec.js'
import { getSubscription, listPlans, stripeConfigured } from './stripe.js'
import { websiteSummary } from './website.js'
import { domainFor } from './domains.js'
import { internalEmails, isTestLead } from './testdata.js'

const PAID = ['active', 'trialing', 'past_due'] // past_due: paid before, in Stripe's retry window

export async function getSignup(db, customerId) {
  return db.prepare('SELECT * FROM self_signups WHERE customer = ?1').bind(customerId).first()
}

// New self-serve businesses are billed when billing is configured and a plan is on sale.
export async function signupPlan(env, requested) {
  if (!stripeConfigured(env)) return null
  const plans = await listPlans(env.ONBOARDING_DB)
  return (plans.find((p) => p.id === requested) || plans[0])?.id ?? null
}

export async function recordSignup(db, customerId, planId, now = Date.now()) {
  await db.prepare('INSERT OR IGNORE INTO self_signups (customer, plan_id, created_at) VALUES (?1, ?2, ?3)').bind(customerId, planId, now).run()
}

// ---------- business profile ----------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
export function normalizePhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : null
}

// Returns [errors[], profile]. Text that customers see goes through the same claims filter as ads.
export function validateProfile(body, { requireServices = false } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const errors = []
  const phone = b.phone ? normalizePhone(b.phone) : ''
  if (phone === null) errors.push('phone')
  const industry = clean(b.industry).slice(0, 60)
  if (!industry) errors.push('industry')
  const description = clean(b.description)
  if (description.length > 400) errors.push('description')
  const services = (Array.isArray(b.services) ? b.services : [])
    .map((s) => ({ name: clean(s?.name), price: clean(s?.price) }))
    .filter((s) => s.name)
  if (services.length > 8 || services.some((s) => s.name.length > 60 || s.price.length > 40)) errors.push('services')
  if (requireServices && !services.length) errors.push('services')
  const cities = (Array.isArray(b.cities) ? b.cities : String(b.cities || '').split(','))
    .map(clean)
    .filter(Boolean)
  if (cities.length > 6 || cities.some((c) => c.length > 40)) errors.push('cities')
  for (const [field, texts] of [['description', [description]], ['services', services.flatMap((s) => [s.name, s.price])]]) {
    if (texts.some((t) => t && unapprovedClaims(t).length)) errors.push(`${field}:unapproved_claim`)
  }
  return [[...new Set(errors)], { phone: phone || '', industry, description, services, cities }]
}

export async function getProfile(db, customerId) {
  const r = await db.prepare('SELECT * FROM business_profiles WHERE customer = ?1').bind(customerId).first()
  return r && { phone: r.phone, industry: r.industry, description: r.description, services: JSON.parse(r.services), cities: JSON.parse(r.cities) }
}

export async function saveProfile(db, customerId, p, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(customer) DO UPDATE SET phone = ?2, industry = ?3, description = ?4, services = ?5, cities = ?6, updated_at = ?7`,
    )
    .bind(customerId, p.phone, p.industry, p.description, JSON.stringify(p.services), JSON.stringify(p.cities), now)
    .run()
}

// ---------- steps ----------
// Legacy businesses (no self_signups row): business → calendar → hours, exactly as before.
// Self-serve: business → payment → details → services → calendar → hours → website → address → publish → launch.
export async function onboardingSteps(env, customer, { calendar }) {
  const db = env.ONBOARDING_DB
  const signup = customer ? await getSignup(db, customer.id) : null
  if (!signup) {
    const steps = [
      { id: 'business', done: Boolean(customer) },
      { id: 'calendar', done: calendar },
      { id: 'hours', done: Boolean(customer?.hoursConfirmed) },
    ]
    return { selfServe: false, steps, billing: 'not_required' }
  }
  const [sub, profile, site, marks, domain] = await Promise.all([
    getSubscription(db, customer.id),
    getProfile(db, customer.id),
    websiteSummary(db, customer.id),
    db.prepare('SELECT step FROM onboarding_marks WHERE customer = ?1').bind(customer.id).all(),
    domainFor(env, customer.id),
  ])
  const marked = new Set(marks.results.map((m) => m.step))
  const billing = sub ? sub.status : 'required'
  const steps = [
    { id: 'business', done: true },
    // After onboarding, billing problems are shown on the dashboard (no automatic lock-out).
    { id: 'payment', done: PAID.includes(billing) || Boolean(signup.onboarded_at) },
    { id: 'details', done: Boolean(profile?.industry) },
    { id: 'services', done: Boolean(profile?.services?.length) },
    { id: 'calendar', done: calendar },
    { id: 'hours', done: customer.hoursConfirmed },
    // Businesses that finished onboarding before these steps existed are not sent back into setup.
    { id: 'website', done: site.exists || Boolean(signup.onboarded_at) },
    // Website address: the GetShowUps address, or the owner's domain (connecting continues in the background).
    { id: 'address', done: marked.has('address') || Boolean(domain) || Boolean(signup.onboarded_at) },
    // Published, or the owner chose to keep it private for now.
    { id: 'publish', done: site.published || marked.has('publish') || Boolean(signup.onboarded_at) },
    { id: 'launch', done: Boolean(signup.onboarded_at) },
  ]
  return { selfServe: true, steps, billing, planId: signup.plan_id }
}

export const MARKS = ['address', 'publish']
export async function markStep(db, customerId, step, value = null, now = Date.now()) {
  if (!MARKS.includes(step)) throw new Error('bad step')
  await db.prepare('INSERT INTO onboarding_marks (customer, step, value, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(customer, step) DO UPDATE SET value = ?3, at = ?4').bind(customerId, step, value, now).run()
}

export async function markSignup(db, customerId, field, now = Date.now()) {
  if (!['test_checked_at', 'onboarded_at'].includes(field)) throw new Error('bad field')
  await db.prepare(`UPDATE self_signups SET ${field} = coalesce(${field}, ?2) WHERE customer = ?1`).bind(customerId, now).run()
}

// ---------- readiness ----------
// Honest status of everything the customer depends on. state: ok | action | pending | off.
// Billing appears only for businesses that are billed: self-serve signups, or a business with a real
// Stripe subscription. Pilot/invited businesses are never asked to pay; a checkout someone opened
// and abandoned (an 'incomplete' placeholder without a subscription) is not a plan to fix.
export async function readiness(env, customer, { calendarStatus } = {}) {
  const db = env.ONBOARDING_DB
  const [sub, site, signup, appts, domain] = await Promise.all([
    getSubscription(db, customer.id),
    websiteSummary(db, customer.id),
    getSignup(db, customer.id),
    // Real bookings only (test records never count).
    db.prepare(`SELECT count(*) AS n FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.customer = ?1 AND NOT ${isTestLead('l', '?2')}`).bind(customer.id, internalEmails(env)).first(),
    domainFor(env, customer.id),
  ])
  const items = []
  if (signup || sub?.stripeSubscriptionId) {
    const s = sub?.status
    items.push({
      id: 'subscription',
      state: (s === 'active' || s === 'trialing') && !sub.cancelAtPeriodEnd ? 'ok' : 'action',
      detail: s === 'active' || s === 'trialing' ? (sub.cancelAtPeriodEnd ? 'cancel_scheduled' : 'active') : s || 'not_started',
    })
  }
  items.push({ id: 'calendar', state: calendarStatus === 'healthy' ? 'ok' : 'action', detail: calendarStatus || 'unknown' })
  items.push({ id: 'hours', state: customer.hoursConfirmed ? 'ok' : 'action' })
  items.push({ id: 'page', state: site.published ? 'ok' : 'action', detail: site.published ? 'published' : site.exists ? 'draft' : 'none' })
  if (domain) {
    items.push({ id: 'domain', state: domain.status === 'connected' ? 'ok' : domain.status === 'needs_attention' || domain.step === 'verify' || domain.step === 'point' ? 'action' : 'pending', detail: domain.status, step: domain.step })
  }
  items.push({ id: 'booking', state: (appts?.n ?? 0) > 0 ? 'ok' : 'pending', detail: (appts?.n ?? 0) > 0 ? 'has_bookings' : 'no_bookings_yet' })
  items.push({ id: 'email', state: env.MESSAGES_LIVE === 'true' ? 'ok' : 'pending', detail: env.MESSAGES_LIVE === 'true' ? 'live' : 'activating' })
  items.push({ id: 'sms', state: 'off', detail: 'not_available_yet' })
  items.push({ id: 'ads', state: env.ADS_ENABLED === 'true' ? 'pending' : 'off', detail: env.ADS_ENABLED === 'true' ? 'connect_in_ads' : 'not_available_yet' })
  const next = items.find((i) => i.state === 'action')?.id ?? (items.find((i) => i.id === 'booking').state !== 'ok' ? 'share' : null)
  return { items, next }
}
