// /api/dashboard/availability — closed dates and minimum notice (server/booking-rules.js).
//   GET  → { ready, minNoticeMinutes, closures, today, suggested: upcoming holidays on a booking day, booked: { date: n } }
//   POST { minNoticeMinutes, closures: [{ date, label }], base } → saved | 409 changed elsewhere. Existing bookings are never changed.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { bookingRules, saveBookingRules, validateBookingRules } from '../../../server/booking-rules.js'
import { dateIn, holidays, weekday } from '../../../server/dates.js'
import { isStale } from '../../../server/stale.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { appendOwnerChange } from '../../../server/owner-changes.js'

const shape = (r) => ({ minNoticeMinutes: r.minNoticeMinutes, closures: r.closures })

async function view(env, c, r, now = Date.now()) {
  const today = dateIn(now, c.timezone)
  const { results } = await env.ONBOARDING_DB.prepare("SELECT start_at FROM appointments WHERE customer = ?1 AND status = 'booked' AND start_at > ?2 ORDER BY start_at LIMIT 500").bind(c.id, now).all()
  const closed = new Set(r.closures.map((x) => x.date))
  const booked = {}
  for (const a of results) {
    const d = dateIn(a.start_at, c.timezone)
    if (closed.has(d)) booked[d] = (booked[d] || 0) + 1
  }
  return { ready: r.ready, ...shape(r), closures: r.closures.filter((x) => x.date >= today), today, booked, suggested: holidays(today, 90).filter((h) => !closed.has(h.date) && c.workdays.includes(weekday(h.date))) }
}

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    return json(200, await view(env, session.customer, await bookingRules(env.ONBOARDING_DB, session.customer.id)))
  } catch {
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const c = session.customer
  const rl = await hit(env, 'accountWrite', c.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  const today = dateIn(Date.now(), c.timezone)
  const [error, v] = validateBookingRules(body, today)
  if (error) return json(400, { error })
  try {
    const db = env.ONBOARDING_DB
    const now = await bookingRules(db, c.id)
    if (!now.ready) return json(409, { error: 'not_available_yet' })
    const current = { ...shape(now), closures: now.closures.filter((x) => x.date >= today) }
    if (isStale(body, current)) return json(409, { error: 'conflict', current })
    await saveBookingRules(db, c.id, v)
    await appendOwnerChange(env, session, 'booking.rules_changed', { closures: v.closures.length, minNoticeMinutes: v.minNoticeMinutes })
    return json(200, await view(env, c, await bookingRules(db, c.id)))
  } catch (err) {
    console.error('availability save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
