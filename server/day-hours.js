// Booking hours per day (migration 0045, booking_day_hours): the ONE rule for "what are the hours on this weekday".
// customers.day_start/day_end stay the default range for every booking day (customers.workdays); a stored override gives
// a listed booking day its own range. No row, a missing table or an unreadable value = the default on every day (exactly
// the behaviour before per-day hours). Every reader that turns hours into availability (calendar.js computeSlots, the
// receptionist's "within hours") or describes them (receptionist knowledge, assistant, follow-ups, website, export) goes
// through hoursFor / hoursGroups, so they always agree. Closed dates and minimum notice still apply on top.
// Pure except the SQL helpers at the end; the customer object carries `dayHours` (server/auth.js customerFromRow).

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
const weekdayOk = (d) => Number.isInteger(d) && d >= 0 && d <= 6

export const missingDayHours = (err) => /no such table: booking_day_hours/.test(String(err?.message))

// Stored JSON (or an object) → { [weekday]: { start, end } } with only well-formed entries; anything else → {}.
export function parseDayHours(raw) {
  let v = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out = {}
  for (const [k, x] of Object.entries(v)) {
    const d = Number(k)
    if (!/^[0-6]$/.test(k) || !weekdayOk(d)) continue
    if (!x || !HM_RE.test(String(x.start)) || !HM_RE.test(String(x.end)) || x.start >= x.end) continue
    out[d] = { start: x.start, end: x.end }
  }
  return out
}

// The overrides that apply: only for booking days, only where they differ from the default range.
export function activeDayHours(h) {
  const days = new Set((h?.workdays || []).filter(weekdayOk))
  const out = {}
  for (const [k, x] of Object.entries(parseDayHours(h?.dayHours))) {
    const d = Number(k)
    if (days.has(d) && (x.start !== h.dayStart || x.end !== h.dayEnd)) out[d] = x
  }
  return out
}

// The hours of one weekday (0 Sunday … 6 Saturday): { start, end } ('HH:MM'), or null when it is not a booking day.
// h: anything with { workdays, dayStart, dayEnd, dayHours? } (the customer object or booking rules).
export function hoursFor(h, weekday) {
  if (!(h?.workdays || []).includes(weekday)) return null
  const o = parseDayHours(h.dayHours)[weekday]
  return o ? { start: o.start, end: o.end } : { start: h.dayStart, end: h.dayEnd }
}

// Booking days that share hours, in the order the days are stored: [{ days: [1,2,3,4], start, end }, { days: [5], … }].
// Without an override this is ONE group of every booking day with the default range, so a description built from it
// reads exactly as before per-day hours existed.
export function hoursGroups(h) {
  const groups = new Map()
  for (const d of [...new Set(h?.workdays || [])].filter(weekdayOk)) {
    const r = hoursFor(h, d)
    const key = `${r.start}-${r.end}`
    if (!groups.has(key)) groups.set(key, { days: [], start: r.start, end: r.end })
    groups.get(key).days.push(d)
  }
  return [...groups.values()]
}

// The per-day part of a booking-hours save. raw: { "<weekday>": { start, end } } (undefined/null = no day differs).
// hours: the validated default ({ workdays, dayStart, dayEnd, slotMinutes }, server/customers.js validateHours).
// Days that are not booking days are dropped; a day equal to the default is dropped. Each listed day: valid times,
// start before end, and at least one appointment fits. → [error, value, day]
export function validateDayHours(raw, hours) {
  if (raw === undefined || raw === null) return [null, {}]
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 7) return ['invalid_day_hours']
  const out = {}
  for (const [k, x] of Object.entries(raw)) {
    if (!/^[0-6]$/.test(k)) return ['invalid_day_hours']
    const d = Number(k)
    if (!hours.workdays.includes(d)) continue
    const start = String(x?.start ?? '')
    const end = String(x?.end ?? '')
    if (!HM_RE.test(start) || !HM_RE.test(end) || start >= end) return ['invalid_day_hours', null, d]
    if (mins(end) - mins(start) < hours.slotMinutes) return ['day_too_short', null, d]
    if (start !== hours.dayStart || end !== hours.dayEnd) out[d] = { start, end }
  }
  return [null, out]
}

// The statement that stores a validated value: the row, or no row when no day differs (= today's behaviour).
export function dayHoursStatement(db, customerId, value, now = Date.now()) {
  return Object.keys(value).length
    ? db.prepare('INSERT INTO booking_day_hours (customer, hours, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(customer) DO UPDATE SET hours = ?2, updated_at = ?3').bind(customerId, JSON.stringify(value), now)
    : db.prepare('DELETE FROM booking_day_hours WHERE customer = ?1').bind(customerId)
}

// Customer queries select the stored value with this column; before 0045 the same query runs without it.
// run(columns) → the query's promise. Columns: day_hours (JSON or NULL), day_hours_ready (1 = the table exists).
export async function withDayHoursColumn(run) {
  try {
    return await run('(SELECT hours FROM booking_day_hours bdh WHERE bdh.customer = c.id) AS day_hours, 1 AS day_hours_ready')
  } catch (err) {
    if (missingDayHours(err)) return run('NULL AS day_hours, 0 AS day_hours_ready')
    throw err
  }
}
