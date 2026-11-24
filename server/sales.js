// GetShowUps selling itself (docs/SALES_PLAYBOOK.md): the two business records a platform admin can create with one
// click from the console, so the sales assistant and the Voice Lab need no hand-typed setup:
//   'sales'  id getshowups      — REAL (never a test business): the public sales chat at /chat/getshowups, leads and
//                                 consultations in the product, the homepage "Ask our AI" entry (enrollment.salesChat).
//   'lab'    id getshowups-lab  — admin-marked TEST business with the same sales configuration, for the Voice Lab
//                                 (dry-run sessions, never counted in metrics, never customer-facing).
// Both use the existing creation path (customers, customer_users, service settings, hours, profile with industry
// "Software" → the receptionist's sales playbook, receptionist settings with the approved answers). The founder still
// connects the Google Calendar the consultations land on from the dashboard (OAuth needs their browser); until then the
// sales chat answers questions and records callback requests but cannot offer times. Idempotent: an existing record is
// reported, never changed.
import { createCustomer, getCustomer, updateHours } from './customers.js'
import { getProfile, saveProfile } from './onboarding.js'
import { setTestBusiness } from './testbusiness.js'
import { getSettings } from './receptionist/engine.js'
import { CUSTOMER_RE } from './invites.js'

export const SALES_KINDS = {
  sales: { id: 'getshowups', name: 'GetShowUps', test: false },
  lab: { id: 'getshowups-lab', name: 'GetShowUps Lab', test: true },
}

export const SALES_PROFILE = {
  phone: '',
  industry: 'Software',
  description: 'AI receptionist and booking for pool, HVAC and roofing businesses: every inquiry answered, qualified and booked on your Google Calendar while you are on a job.',
  services: [
    { name: 'Growth plan', price: '$499/month' },
    { name: 'Enterprise plan', price: 'Starting at $10,000/month' },
  ],
  cities: [],
}
export const SALES_HOURS = { slotMinutes: 20, dayStart: '09:00', dayEnd: '17:00', workdays: [1, 2, 3, 4, 5] }
export const SALES_GREETING = 'Hi, this is the GetShowUps assistant. What kind of business do you run, and how do new inquiries reach you today?'
// Owner-approved answers (≤ 3000 characters, server/receptionist/knowledge.js LIMITS.knowledge). Only facts that are
// true in production; the engine's guards still apply (listed price only, no promises).
export const SALES_NOTES = `What you get for $499/month: a professional website built and hosted for you (your GetShowUps address or your own domain); an AI receptionist on your website chat that answers in seconds using only your services, prices, towns, hours and approved notes; online booking straight into your Google Calendar with a real open time; service-area screening for every lead; Teach Your AI (your questions, rules and hand-offs); Google Calendar invitations for every booking; show-up and visit tracking; direct help from the founding team.
Not available yet (say so plainly): text messaging, email reminders, ad management, and voice on the phone. Voice on the website is in a pilot.
Pricing: the Growth plan is $499 a month, billed monthly, no setup fee, no free trial, cancel any time from the billing page. Advertising spend, if they run ads, is separate and paid directly to Google or Meta. Applicable taxes are separate where required. No discounts.
Enterprise: for agencies, franchises, entrepreneurship programs, universities and multi-location organizations; priced by agreement, never online checkout. Each business runs as its own workspace today; one login across businesses, shared reporting and one invoice are not live. Offer to take their details or book a consultation, or point them to Contact sales under Pricing.
Setup: the founder sets the business up with them on a short call; online enrollment opens later. Nothing is charged until they choose to sign up.
Already have voicemail or texts: voicemail does not ask the questions or book the time; the receptionist answers in seconds, checks the area, asks what they would ask, and books a real open slot. Every inquiry still shows on their dashboard.
Will it say something wrong: it uses only their records and never invents a price or a promise; if a price is not listed it says the team will confirm. They can test it before customers see it.
Customers want a person: it never pretends to be them and cannot transfer calls; if someone asks for a person it records a callback request they see immediately.
Price objection: billed monthly with no setup fee and cancel any time; the dashboard shows exactly what came in and what got booked, so they can judge it on their own numbers. Never promise lead counts, bookings or revenue.
No website: a hosted website with booking and chat is included.
Cancel: the website stays online to the end of the paid period plus 14 days, content can be downloaded, the domain is always theirs.
Who it is for: pool service, HVAC and roofing businesses that book appointments and miss inquiries while on jobs. If a business has nothing to book or no inquiries to answer, say it is probably not a fit.
Consultation: a free 20-minute call with the founder to look at their services, service area and current website; booked on this calendar.`

// → { ok, created, kind, id, status } | { ok: false, httpStatus, error }
export async function createSalesBusiness(env, admin, kind, now = Date.now()) {
  const spec = SALES_KINDS[kind]
  if (!spec) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const db = env.ONBOARDING_DB
  const existing = await getCustomer(db, spec.id)
  if (existing) return { ok: true, created: false, kind, id: spec.id, status: await salesStatus(env, kind) }
  // An email belongs to one business (customer_users): the admin owns the SALES record (its dashboard, calendar, settings);
  // the Lab test business has no owner row (platform admins drive it through the Lab).
  const id = await createCustomer(env, spec.test ? null : admin.email, { name: spec.name, timezone: 'America/New_York', serviceZips: [], appointmentMode: 'at_business' }, { source: 'platform', via: 'admin_link' }, now)
  if (id !== spec.id) {
    // The slug for the name is taken by something else: never create a differently named sales business by accident.
    console.error('sales business: unexpected id', id)
    return { ok: false, httpStatus: 409, error: 'id_unavailable' }
  }
  await updateHours(db, id, SALES_HOURS, now)
  await saveProfile(db, id, SALES_PROFILE, now)
  await db
    .prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, transfer_phone, updated_at) VALUES (?1, 1, 'ai_first', ?2, ?3, NULL, ?4) ON CONFLICT(customer) DO NOTHING")
    .bind(id, SALES_GREETING, SALES_NOTES, now)
    .run()
  if (spec.test) await setTestBusiness(env, id, true, admin.email, now)
  return { ok: true, created: true, kind, id, status: await salesStatus(env, kind) }
}

// The record keeps the answers it was created with; when the approved answers above change, the console shows the
// difference and an admin applies it (confirmed, audited; the page's version must still be the stored one). Only the plan
// list, description and approved notes: greeting, hours, calendar, on/off and voice are never touched.
async function salesAnswers(env, id) {
  const db = env.ONBOARDING_DB
  const [profile, settings, stamp] = await Promise.all([
    getProfile(db, id),
    getSettings(db, id),
    db.prepare('SELECT (SELECT updated_at FROM business_profiles WHERE customer = ?1) AS p, (SELECT updated_at FROM receptionist_settings WHERE customer = ?1) AS s').bind(id).first(),
  ])
  const list = (l) => (l || []).map((s) => `${s.name}: ${s.price || ''}`).join('\n')
  const stored = { services: list(profile?.services), description: profile?.description || '', notes: settings.knowledge }
  const latest = { services: list(SALES_PROFILE.services), description: SALES_PROFILE.description, notes: SALES_NOTES }
  return { current: JSON.stringify(stored) === JSON.stringify(latest), stored, latest, version: `${stamp?.p ?? 0}:${stamp?.s ?? 0}` }
}

// → { ok, changed, id } | { ok: false, httpStatus, error }
export async function refreshSalesAnswers(env, kind, version, now = Date.now()) {
  const spec = SALES_KINDS[kind]
  if (!spec) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const db = env.ONBOARDING_DB
  if (!(await getCustomer(db, spec.id))) return { ok: false, httpStatus: 404, error: 'not_found' }
  const a = await salesAnswers(env, spec.id)
  if (a.version !== version) return { ok: false, httpStatus: 409, error: 'conflict' }
  if (a.current) return { ok: true, changed: false, id: spec.id }
  const [p, s] = a.version.split(':').map(Number)
  const results = await db.batch([
    db.prepare('UPDATE business_profiles SET services = ?2, description = ?3, updated_at = ?4 WHERE customer = ?1 AND updated_at = ?5 AND EXISTS (SELECT 1 FROM receptionist_settings r WHERE r.customer = ?1 AND r.updated_at = ?6)').bind(spec.id, JSON.stringify(SALES_PROFILE.services), SALES_PROFILE.description, now, p, s),
    db.prepare('UPDATE receptionist_settings SET knowledge = ?2, updated_at = ?3 WHERE customer = ?1 AND updated_at = ?4 AND EXISTS (SELECT 1 FROM business_profiles b WHERE b.customer = ?1 AND b.updated_at = ?3)').bind(spec.id, SALES_NOTES, now, s),
  ])
  // An edit in between changed neither row (each update requires the other's version too).
  if (!results.every((r) => (r?.meta?.changes ?? 0) > 0)) return { ok: false, httpStatus: 409, error: 'conflict' }
  return { ok: true, changed: true, id: spec.id }
}

// What the console shows per record: exists, receptionist on, calendar connected (the one step only the founder can do).
export async function salesStatus(env, kind) {
  const spec = SALES_KINDS[kind]
  if (!spec || !CUSTOMER_RE.test(spec.id)) return null
  const row = await getCustomer(env.ONBOARDING_DB, spec.id)
  if (!row) return { exists: false }
  const [settings, calendar] = await Promise.all([getSettings(env.ONBOARDING_DB, spec.id), env.GOOGLE_TOKENS.get(`google:${spec.id}`)])
  return { exists: true, id: spec.id, name: row.name, receptionistOn: settings.enabled, calendarConnected: Boolean(calendar), hoursConfirmed: Boolean(row.hours_confirmed_at), chatUrl: `/chat/${spec.id}`, answers: await salesAnswers(env, spec.id) }
}
