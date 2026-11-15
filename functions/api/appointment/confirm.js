// /api/appointment/confirm?a=<appointment id>&k=<signed token>[&do=cancel] — the link in confirmation and reminder
// messages ("confirm you'll be there" / "can't make it?").
//   GET  shows the appointment with Confirm and "Can't make it?" (read-only: email scanners prefetch links);
//        do=cancel shows the cancel question (still read-only).
//   POST records the confirmation (appointment_confirmations), or with do=cancel cancels the appointment the same way
//        the owner does (server/booking.js cancelAppointment: Google event removed first, then cancelled; the business
//        is told by an owner notice) and offers a new time through the signed lead link.
// The signed token only works for its own appointment; the page shows the business name and time only.
import { escapeHtml, page } from '../../../server/google-oauth.js'
import { resumeUrl, verifyLinkToken } from '../../../server/links.js'
import { cancelAppointment } from '../../../server/booking.js'
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
    `SELECT ap.id, ap.customer, ap.lead_id, ap.start_at, ap.status, c.name, c.timezone,
            (SELECT l.status FROM leads l WHERE l.id = ap.lead_id AND l.customer = ap.customer) AS lead_status,
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
const what = (row) => (isVisit(row) ? 'visit' : 'appointment')
const hidden = (a, k, action) =>
  `<input type="hidden" name="a" value="${escapeHtml(a)}"><input type="hidden" name="k" value="${escapeHtml(k)}">${action ? `<input type="hidden" name="do" value="${action}">` : ''}`
const cantMake = (a, k) => `<p><a href="/api/appointment/confirm?a=${encodeURIComponent(a)}&amp;k=${encodeURIComponent(k)}&amp;do=cancel">Can’t make it? Cancel or pick a new time</a></p>`
const done = (row, a, k) =>
  page(200, 'You’re confirmed', `${row.name} · ${when(row.start_at, row.timezone)}. ${isVisit(row) ? 'Thanks for confirming the visit.' : 'See you then!'}`, HEADERS, cantMake(a, k), false)
const CANCEL_FAIL = {
  calendar_unavailable: 'We couldn’t cancel it right now. Please try again in a few minutes.',
  calendar_access: 'We couldn’t cancel it online. Please contact the business directly.',
  cancel_incomplete: 'We couldn’t finish cancelling. Please try again in a minute.',
}

async function cancel(env, row, a, k, confirm) {
  if (!confirm) {
    const form = `<form method="post" action="/api/appointment/confirm">${hidden(a, k, 'cancel')}<button type="submit">Yes, cancel my ${what(row)}</button></form><p><a href="/api/appointment/confirm?a=${encodeURIComponent(a)}&amp;k=${encodeURIComponent(k)}">Keep it</a></p>`
    return page(200, `Cancel your ${what(row)}?`, `${row.name} · ${when(row.start_at, row.timezone)}. After cancelling you can pick a new time.`, HEADERS, form, false)
  }
  const r = await cancelAppointment(env, { id: row.customer }, row.id, { by: 'customer' })
  if (!r.ok) return page(r.httpStatus === 409 ? 410 : 503, 'Not cancelled yet', CANCEL_FAIL[r.error] || `This ${what(row)} can no longer be cancelled online. Please contact ${row.name} directly.`, HEADERS, '', false)
  return cancelled(env, row, true)
}
// justNow: this request cancelled it (the business is told by an owner notice). Earlier cancellations: if the customer
// cancelled, their lead is open again and the signed link rebooks it; if the business cancelled, the lead is not reopened,
// so offer the normal booking page instead of a link that would be refused.
const cancelled = async (env, row, justNow = false) => {
  const reopened = justNow || row.lead_status === 'new'
  const link = reopened ? await resumeUrl(env, row.customer, row.lead_id) : `/book/${encodeURIComponent(row.customer)}`
  const message = justNow ? `${row.name} has been told. Want another time?` : `This ${what(row)} has been cancelled. Want another time?`
  return page(200, `Your ${what(row)} is cancelled`, message, HEADERS, `<p><a href="${escapeHtml(link)}">Pick a new time</a></p>`, false)
}

async function handle(request, env, a, k, confirm, action = null) {
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
  if (action === 'cancel' && row.status === 'cancelled' && row.start_at > now) return cancelled(env, row)
  if (row.status !== 'booked' || row.start_at <= now) return closed(row)
  if (action === 'cancel') {
    try {
      return await cancel(env, row, a, k, confirm)
    } catch (err) {
      console.error('confirm: cancel failed:', err?.name)
      return page(503, 'Not cancelled yet', CANCEL_FAIL.cancel_incomplete, HEADERS, '', false)
    }
  }
  if (row.confirmed_at) return done(row, a, k)
  if (!confirm) {
    const label = isVisit(row) ? 'Confirm the visit' : 'Confirm I’ll be there'
    const form = `<form method="post" action="/api/appointment/confirm"><input type="hidden" name="a" value="${escapeHtml(a)}"><input type="hidden" name="k" value="${escapeHtml(k)}"><button type="submit">${label}</button></form>${cantMake(a, k)}`
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
  return done(row, a, k)
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  return handle(request, env, url.searchParams.get('a'), url.searchParams.get('k'), false, url.searchParams.get('do') === 'cancel' ? 'cancel' : null)
}

export async function onRequestPost({ request, env }) {
  const form = await request.formData().catch(() => null)
  return handle(request, env, form?.get('a'), form?.get('k'), true, form?.get('do') === 'cancel' ? 'cancel' : null)
}
