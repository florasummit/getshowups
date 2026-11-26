// POST /api/dashboard/hours — save booking hours (also completes that onboarding step).
//   Body: { workdays: [1,2,3,4,5], dayStart: "09:00", dayEnd: "17:00", slotMinutes: 60, dayHours?: { "5": { start, end } } }
// dayHours (Settings → Booking hours, "Different hours on some days"; server/day-hours.js, migration 0045): booking days
// with their own range, saved in the same batch as the default. Left out (onboarding, older pages) = the stored per-day
// hours are kept untouched. {} = every day uses the default (the row is removed). The default columns are never derived
// from it. Before 0045: a save that needs a day of its own answers 409 day_hours_unavailable, nothing changes.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { progress, updateHours, validateHours } from '../../../server/customers.js'
import { track } from '../../../server/events.js'
import { hasBase, hoursOf, isStale } from '../../../server/stale.js'
import { dayHoursStatement, missingDayHours, validateDayHours } from '../../../server/day-hours.js'

const canon = (v) => (v && typeof v === 'object' ? JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]?.start, v[k]?.end])) : 'none')

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const [error, hours] = validateHours(body)
  if (error) return json(400, { error })
  const withDays = body?.dayHours !== undefined
  const [dayError, dayHours, day] = withDays ? validateDayHours(body.dayHours, hours) : [null, null]
  if (dayError) return json(400, { error: dayError, day })
  const c = session.customer
  // `base` (the hours the page started from; session.customer is read fresh for this request): changed elsewhere since
  // → 409 with the current hours, nothing replaced. The per-day part is compared only when the page sent it.
  const current = withDays ? { ...hoursOf(c), dayHours: c.dayHours } : hoursOf(c)
  const staleDays = withDays && hasBase(body) && body.base.dayHours !== undefined && canon(body.base.dayHours) !== canon(c.dayHours)
  if (isStale(body, hoursOf(c)) || staleDays) return json(409, { error: 'conflict', current })
  const db = env.ONBOARDING_DB
  try {
    if (!withDays) await updateHours(db, c.id, hours)
    else {
      const update = db.prepare('UPDATE customers SET slot_minutes = ?2, day_start = ?3, day_end = ?4, workdays = ?5, hours_confirmed_at = ?6, updated_at = ?6 WHERE id = ?1')
      const now = Date.now()
      try {
        await db.batch([update.bind(c.id, hours.slotMinutes, hours.dayStart, hours.dayEnd, hours.workdays.join(','), now), dayHoursStatement(db, c.id, dayHours, now)])
      } catch (err) {
        if (!missingDayHours(err)) throw err
        // Before 0045 nothing can differ per day: the plain save still works; a day of its own can't be kept.
        if (Object.keys(dayHours).length) return json(409, { error: 'day_hours_unavailable' })
        await updateHours(db, c.id, hours)
      }
    }
  } catch (err) {
    console.error('hours save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
  const customer = { ...c, hoursConfirmed: true }
  if ((await progress(env, customer)).complete) {
    await track(env, 'setup_completed', { id: `setup_completed:${customer.id}`, customer: customer.id })
  }
  // The per-day part is answered only to a page that sent it (older pages get exactly the shape they always did).
  return json(200, { ok: true, hours: withDays ? { ...hours, dayHours } : hours })
}
