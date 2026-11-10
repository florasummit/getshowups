// Business accounts: validation, creation, settings, and onboarding progress.
import { CUSTOMER_RE } from './invites.js'
import { isValidTimeZone } from './calendar.js'
import { track } from './events.js'
import { onboardingSteps } from './onboarding.js'

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const ZIP_RE = /^[A-Za-z0-9 -]{3,10}$/

export const APPOINTMENT_MODES = ['at_business', 'at_customer']

// Returns [error, value]. Fields: name, timezone, serviceZips (array or comma string, optional),
// appointmentMode ('at_business' default | 'at_customer').
export function validateBusiness(body) {
  const name = String(body?.name ?? '').trim()
  const timezone = String(body?.timezone ?? '')
  const rawZips = Array.isArray(body?.serviceZips) ? body.serviceZips : String(body?.serviceZips ?? '').split(/[\s,]+/)
  const serviceZips = [...new Set(rawZips.map((z) => String(z).trim().toUpperCase()).filter(Boolean))]
  if (!name || name.length > 80) return ['invalid_name']
  if (!isValidTimeZone(timezone)) return ['invalid_timezone']
  if (serviceZips.length > 200 || serviceZips.some((z) => !ZIP_RE.test(z))) return ['invalid_zips']
  // Omitted = keep the current mode (new businesses default to at_business).
  const appointmentMode = body?.appointmentMode
  if (appointmentMode !== undefined && !APPOINTMENT_MODES.includes(appointmentMode)) return ['invalid_mode']
  return [null, { name, timezone, serviceZips, appointmentMode }]
}

// Returns [error, value]. Fields: workdays [0-6], dayStart/dayEnd 'HH:MM', slotMinutes 15–240.
export function validateHours(body) {
  const slotMinutes = body?.slotMinutes ?? 60
  const dayStart = body?.dayStart ?? '09:00'
  const dayEnd = body?.dayEnd ?? '17:00'
  const workdays = body?.workdays ?? [1, 2, 3, 4, 5]
  if (!Number.isInteger(slotMinutes) || slotMinutes < 15 || slotMinutes > 240) return ['invalid_slot_minutes']
  if (!HM_RE.test(dayStart) || !HM_RE.test(dayEnd) || dayStart >= dayEnd) return ['invalid_hours']
  if (!Array.isArray(workdays) || !workdays.length || workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return ['invalid_workdays']
  }
  return [null, { slotMinutes, dayStart, dayEnd, workdays: [...new Set(workdays)].sort((a, b) => a - b) }]
}

export function slugify(name) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return CUSTOMER_RE.test(base) ? base : `biz-${base}`.slice(0, 40).replace(/-+$/, '') || 'business'
}

// A new business id must not collide with an existing business, a stored Google connection, or an
// outstanding invite. Otherwise a stranger could inherit another business's calendar access.
async function idTaken(env, id) {
  const db = env.ONBOARDING_DB
  if (await db.prepare('SELECT 1 FROM customers WHERE id = ?1').bind(id).first()) return true
  if (await db.prepare('SELECT 1 FROM onboarding_invites WHERE customer = ?1 LIMIT 1').bind(id).first()) return true
  return Boolean(await env.GOOGLE_TOKENS.get(`google:${id}`))
}

export async function uniqueCustomerId(env, name) {
  const base = slugify(name)
  for (let i = 1; i <= 50; i++) {
    const id = i === 1 ? base : `${base.slice(0, 36)}-${i}`
    if (CUSTOMER_RE.test(id) && !(await idTaken(env, id))) return id
  }
  return `${base.slice(0, 30)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`
}

// Acquisition source: a short, safe label (utm_source / ref) or 'direct'.
export const cleanSource = (v) => {
  const s = String(v ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40)
  return s || 'direct'
}

// Creates a business. With `email`, that person becomes its owner in the same batch (throws on a race,
// email PK). Admin invitations create the business first and add the owner when they accept.
const modeStatement = (db, id, mode, now) =>
  db
    .prepare(
      `INSERT INTO service_settings (customer, appointment_mode, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(customer) DO UPDATE SET appointment_mode = ?2, updated_at = ?3`,
    )
    .bind(id, mode, now)

export async function createCustomer(env, email, { name, timezone, serviceZips, appointmentMode }, { source = 'direct', via = 'self_serve', planId = null } = {}, now = Date.now()) {
  const id = await uniqueCustomerId(env, name)
  const db = env.ONBOARDING_DB
  await db.batch([
    db
      .prepare(
        'INSERT INTO customers (id, name, timezone, service_zips, source, created_via, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)',
      )
      .bind(id, name, timezone, serviceZips.join(','), cleanSource(source), via, now),
    ...(email ? [db.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?1, ?2, ?3)').bind(email, id, now)] : []),
    modeStatement(db, id, appointmentMode ?? 'at_business', now),
    // Self-serve signup on a paid plan: recorded atomically with the business so it can never skip billing.
    ...(planId ? [db.prepare('INSERT INTO self_signups (customer, plan_id, created_at) VALUES (?1, ?2, ?3)').bind(id, planId, now)] : []),
  ])
  await track(env, 'business_created', { id: `business_created:${id}`, customer: id, props: { source: cleanSource(source), via }, at: now })
  return id
}

export async function updateBusiness(db, id, { name, timezone, serviceZips, appointmentMode }, now = Date.now()) {
  await db.batch([
    db.prepare('UPDATE customers SET name = ?2, timezone = ?3, service_zips = ?4, updated_at = ?5 WHERE id = ?1').bind(id, name, timezone, serviceZips.join(','), now),
    ...(appointmentMode ? [modeStatement(db, id, appointmentMode, now)] : []),
  ])
}

export async function updateHours(db, id, { slotMinutes, dayStart, dayEnd, workdays }, now = Date.now()) {
  await db
    .prepare(
      'UPDATE customers SET slot_minutes = ?2, day_start = ?3, day_end = ?4, workdays = ?5, hours_confirmed_at = ?6, updated_at = ?6 WHERE id = ?1',
    )
    .bind(id, slotMinutes, dayStart, dayEnd, workdays.join(','), now)
    .run()
}

// Onboarding progress is derived from saved data, so setup always resumes at the right step.
// Setup progress. `steps` is the ordered onboarding (see server/onboarding.js); `complete` is true when
// every step is done. Legacy businesses keep business → calendar → hours.
export async function progress(env, customer) {
  if (!customer) return { business: false, calendar: false, hours: false, complete: false, selfServe: false, billing: 'not_required', steps: [{ id: 'business', done: false }] }
  const calendar = Boolean(await env.GOOGLE_TOKENS.get(`google:${customer.id}`))
  const hours = customer.hoursConfirmed
  const o = await onboardingSteps(env, customer, { calendar })
  return { business: true, calendar, hours, complete: o.steps.every((s) => s.done), ...o }
}

export async function getCustomer(db, id) {
  return db
    .prepare(
      `SELECT c.*, coalesce(cs.automations, 1) AS automations, ss.appointment_mode
         FROM customers c
         LEFT JOIN customer_settings cs ON cs.customer = c.id
         LEFT JOIN service_settings ss ON ss.customer = c.id
        WHERE c.id = ?1`,
    )
    .bind(id)
    .first()
}
