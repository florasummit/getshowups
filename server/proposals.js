// Changes the assistant may PREPARE for the owner to review: service ZIPs, an appointment outcome, booking hours. The proposal is built by code
// from the owner's own words and recorded requests  and changes nothing. Applying is a separate,
// explicit owner action: re-validated, refused if the list changed meanwhile, audited, and read back.
import { recordEvent } from './auditlog.js'
import { checkZip } from './zipcode.js'
import { outsideZips } from './insights.js'
import { validateBusiness, validateHours } from './customers.js'
import { setOutcome } from './booking.js'
import { syncStage } from './ghl.js'
import { hoursText, OUTCOMES } from './operator-tools.js'

const MAX_ADD = 10
export const wantsServiceArea = (q) => /\b(service areas?|zip ?codes?|zips?|where (i|we) (work|serve))\b/i.test(q) && /\b(improv\w*|expand\w*|add\w*|remov\w*|delet\w*|drop|chang\w*|updat\w*|review\w*|suggest\w*|fix\w*|widen|better|include)\b/i.test(q)

// → { text, proposal? }
export async function serviceAreaProposal(env, customer, question, now = Date.now()) {
  const before = customer.serviceZips || []
  const named = [...new Set(question.match(/\b\d{5}\b/g) || [])]
  // "remove 29412" / "add 29464": each ZIP takes the nearest instruction before it. Adding is the default.
  const verb = (z) => (/(?:^|.*\W)(add|include|serve|remov\w*|delet\w*|drop|exclude|stop)\b[^]*$/i.exec(question.slice(0, question.indexOf(z)))?.[1] || 'add').toLowerCase()
  const wantsOut = named.filter((z) => /^(remov|delet|drop|exclude|stop)/.test(verb(z)))
  const wantsIn = named.filter((z) => !wantsOut.includes(z))
  const seen = named.length ? [] : (await outsideZips(env, customer, now)).filter((z) => z.check === 'outside')
  const repeat = seen.filter((z) => z.n > 1)
  if (!named.length && !repeat.length)
    return {
      text: !before.length
        ? 'You haven’t limited your area, so nobody is turned away for their ZIP.'
        : seen.length
          ? `In the last 90 days, inquiries came from ${seen.slice(0, 5).map((z) => z.zip).join(', ')}, once each. That’s too little to suggest a change. Tell me a ZIP to add or remove if you’ve decided.`
          : 'No inquiries from outside your ZIP codes are recorded in the last 90 days, so there’s nothing to suggest. Tell me a ZIP to add or remove if you’ve decided.',
    }
  const r = serviceAreaChange(customer, named.length ? wantsIn : repeat.map((z) => z.zip), wantsOut)
  if (r.proposal && !named.length) r.proposal.why = `From your records, last 90 days: ${repeat.filter((z) => r.proposal.add.includes(z.zip)).map((z) => `${z.n} inquiries from ${z.zip}`).join(', ')}.`
  return r
}

// The change itself: which ZIPs go in and out, with every refusal said. Nothing is saved.
export function serviceAreaChange(customer, wantsIn, wantsOut) {
  const before = customer.serviceZips || []
  const bad = wantsIn.filter((z) => checkZip(z).check !== 'valid')
  const add = [...new Set(wantsIn)].filter((z) => !bad.includes(z) && !before.includes(z)).slice(0, MAX_ADD)
  const remove = [...new Set(wantsOut)].filter((z) => before.includes(z))
  const notes = [bad.length && `${bad.join(', ')} isn’t a ZIP code we recognise, so it’s left out.`].filter(Boolean)
  if (!before.length && add.length) return { text: 'You haven’t limited your area, so people anywhere can book. Adding a ZIP would stop everyone else from booking, so nothing is suggested. If you do want a limit, set it in Settings under Business.' }
  if (remove.length && remove.length === before.length && !add.length) return { text: 'Removing every ZIP would let people anywhere book, so it isn’t suggested here. You can clear the list in Settings under Business.' }
  if (!add.length && !remove.length) return { text: ['Those ZIP codes wouldn’t change your list.', ...notes].join(' ') }
  return {
    text: 'Here’s a change to review. Nothing is saved until you approve it.',
    proposal: {
      type: 'service_zips',
      before,
      after: [...before.filter((z) => !remove.includes(z)), ...add],
      add,
      remove,
      why: 'From what you asked for.',
      effects: [
        add.length && `People in ${add.join(', ')} could book straight away${customer.appointmentMode === 'at_customer' ? ', so you’d drive there' : ''}.`,
        remove.length && `People in ${remove.join(', ')} would ask first instead of booking. Visits already booked stay.`,
        'Requests already waiting still need your answer in Appointments. Ad campaigns keep their own locations.',
        ...notes,
      ].filter(Boolean),
    },
  }
}

// → { ok, serviceZips } | { ok: false, error, status }
export async function applyServiceArea(env, session, body, now = Date.now()) {
  const customer = session.customer
  const list = (v) => Array.isArray(v) && v.length <= 200 && v.every((z) => typeof z === 'string' && /^\d{5}$/.test(z))
  if (body?.type !== 'service_zips' || body.confirm !== true || !list(body.before) || !list(body.after) || !body.after.length || new Set(body.after).size !== body.after.length) return { ok: false, error: 'invalid_request', status: 400 }
  const added = body.after.filter((z) => !body.before.includes(z))
  const removed = body.before.filter((z) => !body.after.includes(z))
  if (added.length > MAX_ADD || (!added.length && !removed.length) || added.some((z) => checkZip(z).check !== 'valid')) return { ok: false, error: 'invalid_request', status: 400 }
  const [error] = validateBusiness({ name: customer.name, timezone: customer.timezone, serviceZips: body.after })
  if (error) return { ok: false, error, status: 400 }
  const db = env.ONBOARDING_DB
  // Saved only while the list is still the one that was reviewed (an unlimited list is '' or NULL and never matches).
  const r = await db.prepare('UPDATE customers SET service_zips = ?2, updated_at = ?3 WHERE id = ?1 AND service_zips = ?4').bind(customer.id, body.after.join(','), now, body.before.join(',')).run()
  if (!r.meta.changes) return { ok: false, error: 'stale', status: 409 }
  await recordEvent(db, { type: 'business.service_zips', actor: `owner:${session.email}`, customer: customer.id, capability: 'assist.ask', outcome: 'success', resource: { type: 'customer', id: customer.id }, details: { added: added.length, removed: removed.length, via: 'assistant' } })
  const row = await db.prepare('SELECT service_zips FROM customers WHERE id = ?1').bind(customer.id).first()
  return { ok: true, serviceZips: row.service_zips.split(',') }
}

// Records an appointment outcome the owner approved, through the same code as the Appointments page. Refused when the
// appointment is no longer as it was reviewed; a second press of the same approval changes nothing.
export async function applyOutcome(env, session, body, now = Date.now()) {
  const o = Object.hasOwn(OUTCOMES, String(body?.outcome)) ? OUTCOMES[body.outcome] : null
  const b = body?.before
  if (!o || body.confirm !== true || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id) || !b || !['booked', 'showed', 'no_show'].includes(b.status) || ![null, 'completed', 'not_completed'].includes(b.work ?? null)) return { ok: false, error: 'invalid_request', status: 400 }
  const db = env.ONBOARDING_DB
  const cur = await db
    .prepare("SELECT a.status, a.start_at, ao.work FROM appointments a LEFT JOIN appointment_outcomes ao ON ao.appointment_id = a.id AND ao.customer = a.customer WHERE a.id = ?1 AND a.customer = ?2 AND a.status IN ('booked','showed','no_show')")
    .bind(body.id, session.customer.id)
    .first()
  if (!cur || cur.start_at > now) return { ok: false, error: 'not_found', status: 404 }
  if (cur.status === o.status && (cur.work ?? null) === o.work) return { ok: true, already: true, state: o.label }
  if (cur.status !== b.status || (cur.work ?? null) !== (b.work ?? null)) return { ok: false, error: 'stale', status: 409 }
  const r = await setOutcome(env, session.customer, body.id, o.status === 'booked' ? 'clear' : o.status, { work: o.work ?? undefined, by: session.email }, now)
  if (!r.ok) return { ok: false, error: r.error === 'changed' ? 'stale' : r.error, status: r.httpStatus }
  if (r.appointment.status !== 'booked') await syncStage(env, session.customer.id, r.leadId, r.appointment.status === 'no_show' ? 'noShow' : r.appointment.work === 'completed' ? 'completed' : 'showed').catch(() => null)
  await recordEvent(db, { type: 'appointment.outcome', actor: `owner:${session.email}`, customer: session.customer.id, capability: 'assist.ask', outcome: 'success', resource: { type: 'appointment', id: body.id }, details: { outcome: body.outcome, via: 'assistant' } })
  return { ok: true, state: o.label }
}

// Saves booking hours the owner approved, only while they are still the ones reviewed.
export async function applyHours(env, session, body, now = Date.now()) {
  // Every field explicit: validateHours fills in missing ones, which must never become a change nobody reviewed.
  const whole = (h) => h && typeof h.dayStart === 'string' && typeof h.dayEnd === 'string' && Array.isArray(h.workdays) && Number.isInteger(h.slotMinutes)
  if (!whole(body?.before) || !whole(body?.after)) return { ok: false, error: 'invalid_request', status: 400 }
  const [e1, before] = validateHours(body?.before)
  const [e2, after] = validateHours(body?.after)
  if (body?.confirm !== true || e1 || e2) return { ok: false, error: 'invalid_request', status: 400 }
  const r = await env.ONBOARDING_DB.prepare('UPDATE customers SET slot_minutes = ?2, day_start = ?3, day_end = ?4, workdays = ?5, hours_confirmed_at = ?6, updated_at = ?6 WHERE id = ?1 AND slot_minutes = ?7 AND day_start = ?8 AND day_end = ?9 AND workdays = ?10')
    .bind(session.customer.id, after.slotMinutes, after.dayStart, after.dayEnd, after.workdays.join(','), now, before.slotMinutes, before.dayStart, before.dayEnd, before.workdays.join(','))
    .run()
  if (!r.meta.changes) return { ok: false, error: 'stale', status: 409 }
  await recordEvent(env.ONBOARDING_DB, { type: 'business.hours', actor: `owner:${session.email}`, customer: session.customer.id, capability: 'assist.ask', outcome: 'success', resource: { type: 'customer', id: session.customer.id }, details: { via: 'assistant' } })
  return { ok: true, state: hoursText(after) }
}

export function applyProposal(env, session, body) {
  return body?.type === 'outcome' ? applyOutcome(env, session, body) : body?.type === 'hours' ? applyHours(env, session, body) : applyServiceArea(env, session, body)
}
