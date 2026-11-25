// Closed dates and minimum notice (migration 0041): one place every booking path reads (openSlots, book), so the booking
// page, the receptionist, resume links and the assistant can never offer a time the owner closed. Before 0041: none.
// Any other read error is thrown: times are not offered rather than offered on a day the owner may have closed.
import { realDate } from './dates.js'

export const NOTICE_OPTIONS = [0, 60, 120, 240, 720, 1440, 2880]
export const MAX_CLOSURES = 60
const missing = (err) => String(err?.message).includes('no such table')

export async function bookingRules(db, customerId) {
  try {
    const [r, c] = await Promise.all([
      db.prepare('SELECT min_notice_minutes FROM booking_rules WHERE customer = ?1').bind(customerId).first(),
      db.prepare('SELECT date, label FROM business_closures WHERE customer = ?1 ORDER BY date').bind(customerId).all(),
    ])
    return { ready: true, minNoticeMinutes: r?.min_notice_minutes ?? 0, closures: c.results.map((x) => ({ date: x.date, label: x.label })) }
  } catch (err) {
    if (missing(err)) return { ready: false, minNoticeMinutes: 0, closures: [] }
    throw err
  }
}

// The business's booking hours with its closed dates and notice, for computeSlots/isOfferedSlot.
export async function withBookingRules(db, customer) {
  const r = await bookingRules(db, customer.id)
  return { ...customer, minNoticeMinutes: r.minNoticeMinutes, closedDates: r.closures.map((c) => c.date) }
}

const clean = (v) => String(v ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()

// today: YYYY-MM-DD in the business's time zone; past dates are dropped. Returns [error, value].
export function validateBookingRules(body, today) {
  const n = body?.minNoticeMinutes ?? 0
  if (!NOTICE_OPTIONS.includes(n)) return ['invalid_notice']
  if (!Array.isArray(body?.closures) || body.closures.length > 200) return ['invalid_closures']
  const by = new Map()
  for (const c of body.closures) {
    const date = String(c?.date ?? '')
    const label = clean(c?.label)
    if (!realDate(date)) return ['invalid_date']
    if (label.length > 60) return ['invalid_label']
    if (date >= today) by.set(date, { date, label })
  }
  if (by.size > MAX_CLOSURES) return ['too_many_closures']
  return [null, { minNoticeMinutes: n, closures: [...by.values()].sort((a, b) => a.date.localeCompare(b.date)) }]
}

export async function saveBookingRules(db, customerId, v, now = Date.now()) {
  await db.batch([
    db.prepare('INSERT INTO booking_rules (customer, min_notice_minutes, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(customer) DO UPDATE SET min_notice_minutes = ?2, updated_at = ?3').bind(customerId, v.minNoticeMinutes, now),
    db.prepare('DELETE FROM business_closures WHERE customer = ?1').bind(customerId),
    ...v.closures.map((c) => db.prepare('INSERT INTO business_closures (customer, date, label, created_at) VALUES (?1, ?2, ?3, ?4)').bind(customerId, c.date, c.label, now)),
  ])
}
