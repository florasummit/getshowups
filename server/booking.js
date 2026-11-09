// Appointment engine: lead capture → qualification → booking on Google Calendar → outcomes → results.
// Double booking is prevented by (1) a partial UNIQUE index on (customer, start_at) that reserves the
// slot atomically, (2) a fresh freeBusy check after reserving, and (3) rollback if Google fails.
import { randomToken, sha256Hex, timingSafeEqual } from './google-oauth.js'
import { EMAIL_RE } from './auth.js'
import { computeSlots, connect, createEvent, deleteEvent, freeBusy, isOfferedSlot } from './calendar.js'
import { track } from './events.js'
import { verifyLinkToken } from './links.js'
import { scheduleAppointmentMessages, scheduleLeadMessages, scheduleNoShowMessage } from './messages.js'

export const BOOKING_DAYS = 14
const DAY = 24 * 60 * 60 * 1000
// A 'pending' reservation older than this was abandoned (e.g. the Worker was killed mid-booking).
// Every Google call times out well before it, so a live booking is never mistaken for stale.
export const STALE_PENDING_MS = 2 * 60 * 1000
const hexId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
const PHONE_RE = /^[0-9+().\-\s]{7,25}$/
// Version of the SMS consent checkbox text on the booking page (src/booking/BookingPage.jsx).
export const SMS_CONSENT_WORDING = 'booking-sms-v1'
const hasSmsConsent = async (db, leadId) => Boolean(await db.prepare('SELECT 1 AS y FROM sms_consents WHERE lead_id = ?1').bind(leadId).first())

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

// Returns [error, value] for a booking-page lead submission.
export function validateLead(body) {
  const lead = {
    name: clean(body?.name, 80),
    email: clean(body?.email, 254).toLowerCase(),
    phone: clean(body?.phone, 25),
    need: clean(body?.need, 500),
    zip: clean(body?.zip, 10).toUpperCase(),
    smsConsent: body?.smsConsent === true,
  }
  if (lead.name.length < 2) return ['invalid_name']
  if (!EMAIL_RE.test(lead.email)) return ['invalid_email']
  if (!PHONE_RE.test(lead.phone) || lead.phone.replace(/\D/g, '').length < 7) return ['invalid_phone']
  if (lead.need.length < 2) return ['invalid_need']
  return [null, lead]
}

export async function createLead(env, customer, lead, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const qualified = customer.serviceZips.length === 0 || customer.serviceZips.includes(lead.zip)
  const id = randomToken(12)
  const token = randomToken(32)
  const insertLead = db
    .prepare(
      `INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    )
    .bind(id, customer.id, lead.name, lead.email, lead.phone, lead.need, lead.zip, qualified ? 'new' : 'unqualified', await sha256Hex(token), now)
  if (lead.smsConsent) {
    await db.batch([
      insertLead,
      db.prepare('INSERT INTO sms_consents (lead_id, customer, wording, consented_at) VALUES (?1, ?2, ?3, ?4)').bind(id, customer.id, SMS_CONSENT_WORDING, now),
    ])
  } else {
    await insertLead.run()
  }
  await track(env, 'lead_created', { id: `lead:${id}`, customer: customer.id, props: { qualified }, at: now })
  await scheduleLeadMessages(env, customer, { id, qualified, smsConsent: lead.smsConsent }, now)
  return { id, token, qualified }
}

// Open slots for the public booking page: booking hours minus Google busy time minus our own
// reserved appointments (covers the moment between reserving and Google showing the event).
export async function openSlots(env, customer, now = Date.now()) {
  const conn = await connect(env, customer.id)
  if (!conn.ok) return { ok: false, status: conn.status }
  const { rangeEnd } = computeSlots({ busy: [], rules: customer, now, days: BOOKING_DAYS })
  const fb = await freeBusy(env, conn.accessToken, now, rangeEnd)
  if (!fb.ok) return { ok: false, status: 'calendar_error' }
  const { results } = await env.ONBOARDING_DB.prepare(
    "SELECT start_at, end_at FROM appointments WHERE customer = ?1 AND status <> 'cancelled' AND end_at > ?2 AND NOT (status = 'pending' AND created_at < ?3)",
  )
    .bind(customer.id, now, now - STALE_PENDING_MS)
    .all()
  const busy = [...fb.busy, ...results.map((r) => ({ start: r.start_at, end: r.end_at }))]
  return { ok: true, slots: computeSlots({ busy, rules: customer, now, days: BOOKING_DAYS }).slots }
}

const fail = (httpStatus, error) => ({ ok: false, httpStatus, error })
// Operational failures (not customer mistakes) are recorded for the platform dashboard.
const OPERATIONAL = new Set(['calendar_unavailable', 'calendar_error', 'booking_failed', 'storage_error'])

export async function bookAppointment(env, customer, input, now = Date.now()) {
  const result = await book(env, customer, input, now)
  if (result.ok) {
    const { id, leadId, smsConsent, start } = result.appointment
    await track(env, 'appointment_booked', { id: `booked:${id}`, customer: customer.id, at: now })
    await scheduleAppointmentMessages(env, customer, { id, leadId, smsConsent, start }, now)
    result.appointment = { id, start, end: result.appointment.end }
  } else if (OPERATIONAL.has(result.error)) {
    await track(env, 'booking_failed', { customer: customer.id, props: { error: result.error }, at: now })
  }
  return result
}

async function book(env, customer, { leadId, leadToken, start }, now) {
  const db = env.ONBOARDING_DB
  if (typeof leadId !== 'string' || typeof leadToken !== 'string' || !Number.isInteger(start)) return fail(400, 'invalid_request')

  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?1 AND customer = ?2').bind(leadId, customer.id).first()
  // The browser that created the lead holds leadToken; a "pick a time" link in a follow-up message
  // carries a signed token for the same lead instead.
  const tokenOk = lead && (timingSafeEqual(await sha256Hex(leadToken), lead.token_hash) || (await verifyLinkToken(env, 'lead', lead.id, leadToken)))
  if (!tokenOk) return fail(404, 'lead_not_found')
  if (lead.status === 'unqualified') return fail(409, 'not_qualified')
  if (lead.status === 'booked') return fail(409, 'already_booked')
  if (!isOfferedSlot({ rules: customer, now, days: BOOKING_DAYS, start })) return fail(409, 'slot_unavailable')

  const end = start + customer.slotMinutes * 60 * 1000
  const conn = await connect(env, customer.id)
  if (!conn.ok) return fail(503, 'calendar_unavailable')

  // 0. Clear abandoned reservations so a crashed booking can never block a slot forever.
  await db
    .prepare("DELETE FROM appointments WHERE customer = ?1 AND status = 'pending' AND created_at < ?2")
    .bind(customer.id, now - STALE_PENDING_MS)
    .run()

  // 1. Reserve the slot. The partial UNIQUE index rejects a second active booking at this time.
  const id = hexId()
  const eventId = `gsu${id}` // base32hex-safe, so Google accepts it as the event id
  try {
    await db
      .prepare(
        "INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
      )
      .bind(id, customer.id, lead.id, start, end, now)
      .run()
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return fail(409, 'slot_unavailable')
    throw err
  }
  const release = () => db.prepare('DELETE FROM appointments WHERE id = ?1').bind(id).run()

  // 2. Confirm the time is still free on the real calendar.
  const fb = await freeBusy(env, conn.accessToken, start, end)
  if (!fb.ok) {
    await release()
    return fail(502, 'calendar_error')
  }
  if (fb.busy.some((b) => b.start < end && b.end > start)) {
    await release()
    return fail(409, 'slot_unavailable')
  }

  // 3. Create the real calendar event; the lead receives Google's invitation. One retry on a
  //    timeout/5xx is safe because the event id is fixed (a landed first attempt returns 409).
  const details = {
    id: eventId,
    start,
    end,
    timeZone: customer.timezone,
    summary: `${lead.name}: ${lead.need.slice(0, 60)}`,
    description: [`Name: ${lead.name}`, `Phone: ${lead.phone}`, `Email: ${lead.email}`, ...(lead.zip ? [`ZIP: ${lead.zip}`] : []), '', lead.need, '', 'Booked with GetShowUps'].join('\n'),
    attendee: { email: lead.email, displayName: lead.name },
  }
  let event = await createEvent(env, conn.accessToken, details)
  if (!event.ok && event.retryable) event = await createEvent(env, conn.accessToken, details)
  if (!event.ok) {
    console.error('booking: event create failed:', customer.id, event.httpStatus, event.error)
    // The outcome is unknown after a timeout: remove the event in case it was created, then free the slot.
    if (event.retryable) await deleteEvent(env, conn.accessToken, eventId)
    await release()
    return fail(502, 'booking_failed')
  }

  // 4. Record it. The lead update is conditional so one lead can never hold two bookings.
  try {
    const booked = await db
      .prepare("UPDATE leads SET status = 'booked', updated_at = ?3 WHERE id = ?1 AND customer = ?2 AND status = 'new' RETURNING id")
      .bind(lead.id, customer.id, now)
      .first()
    if (!booked) {
      await deleteEvent(env, conn.accessToken, event.eventId)
      await release()
      return fail(409, 'already_booked')
    }
    await db
      .prepare("UPDATE appointments SET status = 'booked', google_event_id = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(id, event.eventId, now)
      .run()
  } catch (err) {
    console.error('booking: record failed:', customer.id, err?.message)
    await deleteEvent(env, conn.accessToken, event.eventId)
    await release().catch(() => {})
    return fail(503, 'storage_error')
  }
  return { ok: true, appointment: { id, start, end, leadId: lead.id, smsConsent: await hasSmsConsent(db, lead.id) } }
}

// Owner marks a past appointment as showed / no-show (or corrects it). A no-show reopens the lead
// (status 'new') so it can book again and shows under "Haven't booked yet"; correcting it to showed
// before they rebook closes the lead again.
export async function setOutcome(env, customer, id, outcome, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!['showed', 'no_show'].includes(outcome) || typeof id !== 'string') return fail(400, 'invalid_request')
  const row = await db
    .prepare(
      "UPDATE appointments SET status = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2 AND status IN ('booked', 'showed', 'no_show') AND start_at <= ?4 RETURNING id, status, lead_id",
    )
    .bind(id, customer.id, outcome, now)
    .first()
  if (!row) return fail(404, 'not_found')
  const [from, to] = outcome === 'no_show' ? ['booked', 'new'] : ['new', 'booked']
  const lead = await db
    .prepare('UPDATE leads SET status = ?4, updated_at = ?5 WHERE id = ?1 AND customer = ?2 AND status = ?3 RETURNING id')
    .bind(row.lead_id, customer.id, from, to, now)
    .first()
  if (outcome === 'no_show' && lead) {
    await scheduleNoShowMessage(env, customer, { id, leadId: row.lead_id, smsConsent: await hasSmsConsent(db, row.lead_id) }, now)
  }
  await track(env, 'appointment_outcome', { id: `outcome:${id}`, customer: customer.id, props: { outcome }, at: now, replace: true })
  return { ok: true, appointment: { id: row.id, status: row.status } }
}

// Results and work lists for the dashboard home (last 30 days + upcoming).
export async function overview(db, customerId, now = Date.now()) {
  const since = now - 30 * DAY
  const one = (sql, ...args) => db.prepare(sql).bind(customerId, ...args).first()
  const leads = await one('SELECT count(*) AS n FROM leads WHERE customer = ?1 AND created_at >= ?2', since)
  const counts = await one(
    `SELECT
       sum(CASE WHEN a.status IN ('booked','showed','no_show') THEN 1 ELSE 0 END) AS booked,
       sum(CASE WHEN a.status IN ('booked','showed','no_show') AND ac.appointment_id IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
       count(DISTINCT CASE WHEN a.status IN ('booked','showed','no_show') THEN a.lead_id END) AS booked_leads,
       sum(CASE WHEN a.status = 'showed' THEN 1 ELSE 0 END) AS showed,
       sum(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS no_show
     FROM appointments a LEFT JOIN appointment_confirmations ac ON ac.appointment_id = a.id
     WHERE a.customer = ?1 AND a.created_at >= ?2`,
    since,
  )
  const list = async (sql, ...args) => (await db.prepare(sql).bind(customerId, ...args).all()).results
  const apptCols = 'a.id, a.start_at, a.end_at, a.status, (SELECT confirmed_at FROM appointment_confirmations ac WHERE ac.appointment_id = a.id) AS confirmed_at, l.name, l.phone, l.email, l.need'
  const upcoming = await list(
    `SELECT ${apptCols} FROM appointments a JOIN leads l ON l.id = a.lead_id
      WHERE a.customer = ?1 AND a.status = 'booked' AND a.start_at > ?2 ORDER BY a.start_at LIMIT 25`,
    now,
  )
  const needsOutcome = await list(
    `SELECT ${apptCols} FROM appointments a JOIN leads l ON l.id = a.lead_id
      WHERE a.customer = ?1 AND a.status = 'booked' AND a.start_at <= ?2 ORDER BY a.start_at DESC LIMIT 25`,
    now,
  )
  const recent = await list(
    `SELECT ${apptCols} FROM appointments a JOIN leads l ON l.id = a.lead_id
      WHERE a.customer = ?1 AND a.status IN ('showed','no_show') ORDER BY a.start_at DESC LIMIT 10`,
  )
  const followUp = await list(
    `SELECT id, name, phone, email, need, status, created_at FROM leads
      WHERE customer = ?1 AND status IN ('new','unqualified') AND created_at >= ?2 ORDER BY created_at DESC LIMIT 25`,
    since,
  )
  const showed = counts?.showed ?? 0
  const noShow = counts?.no_show ?? 0
  const appt = (r) => ({
    id: r.id,
    start: new Date(r.start_at).toISOString(),
    end: new Date(r.end_at).toISOString(),
    status: r.status,
    confirmed: Boolean(r.confirmed_at),
    name: r.name,
    phone: r.phone,
    email: r.email,
    need: r.need,
  })
  const leadCount = leads?.n ?? 0
  const booked = counts?.booked ?? 0
  return {
    stats: {
      leads: leadCount,
      booked,
      confirmed: counts?.confirmed ?? 0,
      showed,
      noShow,
      // Share of leads (last 30 days) that booked; capped because a rebooking or an older lead can book in the window.
      bookingRate: leadCount ? Math.min(100, Math.round(((counts?.booked_leads ?? 0) / leadCount) * 100)) : null,
      showRate: showed + noShow ? Math.round((showed / (showed + noShow)) * 100) : null,
    },
    upcoming: upcoming.map(appt),
    needsOutcome: needsOutcome.map(appt),
    recent: recent.map(appt),
    followUp: followUp.map((r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, need: r.need, status: r.status, createdAt: new Date(r.created_at).toISOString() })),
  }
}
