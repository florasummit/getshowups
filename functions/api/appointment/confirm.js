// /api/appointment/confirm?a=<appointment id>&k=<signed token> — the "confirm you'll be there" link in
// confirmation and reminder messages.
//   GET  shows the appointment and a Confirm button (read-only: email scanners prefetch links).
//   POST records the confirmation (appointment_confirmations).
// The signed token only works for its own appointment; the page shows the business name and time only.
import { escapeHtml, page } from '../../../server/google-oauth.js'
import { verifyLinkToken } from '../../../server/links.js'
import { track } from '../../../server/events.js'
import { hitByIp, tooManyPage } from '../../../server/ratelimit.js'

const ID_RE = /^[0-9a-f]{32}$/
// The page posts the form back to itself, so allow the Origin header for same-origin requests.
const HEADERS = { 'Referrer-Policy': 'same-origin' }

const when = (ts, timeZone) =>
  new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ts))

async function load(env, a, k) {
  if (!ID_RE.test(String(a)) || !(await verifyLinkToken(env, 'confirm', a, k))) return null
  return env.ONBOARDING_DB.prepare(
    `SELECT ap.id, ap.customer, ap.start_at, ap.status, c.name, c.timezone,
            (SELECT ss.appointment_mode FROM service_settings ss WHERE ss.customer = ap.customer) AS appointment_mode,
            (SELECT confirmed_at FROM appointment_confirmations ac WHERE ac.appointment_id = ap.id) AS confirmed_at
       FROM appointments ap JOIN customers c ON c.id = ap.customer WHERE ap.id = ?1`,
  )
    .bind(a)
    .first()
}

const invalid = () => page(404, 'Link not valid', 'This confirmation link is not valid. Please use the link from your most recent message.', HEADERS, '', false)
const closed = (row) => page(410, 'Can’t confirm online', `This appointment can no longer be confirmed online. Please contact ${row.name} directly.`, HEADERS, '', false)
const isVisit = (row) => row.appointment_mode === 'at_customer'
const done = (row) =>
  page(200, 'You’re confirmed', `${row.name} · ${when(row.start_at, row.timezone)}. ${isVisit(row) ? 'Thanks for confirming the visit.' : 'See you then!'}`, HEADERS, '', false)

async function handle(request, env, a, k, confirm) {
  const rl = await hitByIp(env, 'confirm', request)
  if (rl.limited) return tooManyPage(rl.retryAfter)
  let row
  try {
    row = await load(env, a, k)
  } catch (err) {
    console.error('confirm: lookup failed:', err?.message)
    return page(503, 'Please try again', 'We couldn’t load your appointment right now. Please try again in a minute.', HEADERS, '', false)
  }
  if (!row) return invalid()
  const now = Date.now()
  if (row.status !== 'booked' || row.start_at <= now) return closed(row)
  if (row.confirmed_at) return done(row)
  if (!confirm) {
    const label = isVisit(row) ? 'Confirm the visit' : 'Confirm I’ll be there'
    const form = `<form method="post" action="/api/appointment/confirm"><input type="hidden" name="a" value="${escapeHtml(a)}"><input type="hidden" name="k" value="${escapeHtml(k)}"><button type="submit">${label}</button></form>`
    const note = isVisit(row) ? 'Confirm the time works and that the business can access the property.' : ''
    return page(200, isVisit(row) ? 'Confirm your visit' : 'Confirm your appointment', `${row.name} · ${when(row.start_at, row.timezone)}${note ? `. ${note}` : ''}`, HEADERS, form, false)
  }
  const updated = await env.ONBOARDING_DB.prepare(
    `INSERT OR IGNORE INTO appointment_confirmations (appointment_id, customer, confirmed_at)
       SELECT id, customer, ?2 FROM appointments WHERE id = ?1 AND status = 'booked' AND start_at > ?2
     RETURNING appointment_id`,
  )
    .bind(row.id, now)
    .first()
  if (updated) await track(env, 'appointment_confirmed', { id: `confirmed:${row.id}`, customer: row.customer, at: now })
  return done(row)
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  return handle(request, env, url.searchParams.get('a'), url.searchParams.get('k'), false)
}

export async function onRequestPost({ request, env }) {
  const form = await request.formData().catch(() => null)
  return handle(request, env, form?.get('a'), form?.get('k'), true)
}
