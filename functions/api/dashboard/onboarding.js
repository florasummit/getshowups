// /api/dashboard/onboarding — guided-setup actions and the launch checklist.
//   GET  → { readiness: { items, next } }   (live calendar check included)
//   POST { action: 'check_availability' } → { slots, status }   (the same data the booking page shows)
//   POST { action: 'tested' }   → marks the booking test step done
//   POST { action: 'finish' }   → finishes onboarding (calendar, hours and a saved page required)
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { connect, freeBusy } from '../../../server/calendar.js'
import { openSlots } from '../../../server/booking.js'
import { progress } from '../../../server/customers.js'
import { getSignup, markSignup, readiness } from '../../../server/onboarding.js'
import { track } from '../../../server/events.js'

async function calendarStatus(env, customerId) {
  const conn = await connect(env, customerId)
  if (!conn.ok) return conn.status
  const now = Date.now()
  const fb = await freeBusy(env, conn.accessToken, now, now + 86400000)
  return fb.ok ? 'healthy' : 'calendar_error'
}

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    return json(200, { readiness: await readiness(env, session.customer, { calendarStatus: await calendarStatus(env, session.customer.id) }) })
  } catch (err) {
    console.error('readiness failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  const body = await request.json().catch(() => null)
  const db = env.ONBOARDING_DB
  if (!(await getSignup(db, customer.id))) return json(409, { error: 'not_self_serve' })
  switch (body?.action) {
    case 'check_availability': {
      if (!customer.hoursConfirmed) return json(409, { error: 'hours_required' })
      const r = await openSlots(env, customer)
      return json(200, { status: r.ok ? 'ok' : 'unavailable', slots: r.ok ? r.slots.length : 0, first: r.ok && r.slots[0] ? new Date(r.slots[0].start).toISOString() : null })
    }
    case 'tested':
      await markSignup(db, customer.id, 'test_checked_at')
      return json(200, { ok: true })
    case 'finish': {
      const p = await progress(env, customer)
      const required = ['payment', 'details', 'services', 'calendar', 'hours', 'page']
      const missing = p.steps.filter((s) => required.includes(s.id) && !s.done).map((s) => s.id)
      if (missing.length) return json(409, { error: 'steps_incomplete', missing })
      await markSignup(db, customer.id, 'test_checked_at')
      await markSignup(db, customer.id, 'onboarded_at')
      await track(env, 'onboarding_completed', { id: `onboarded:${customer.id}`, customer: customer.id })
      return json(200, { ok: true })
    }
    default:
      return json(400, { error: 'invalid_request' })
  }
}
