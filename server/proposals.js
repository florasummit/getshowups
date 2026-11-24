// Changes the assistant may PREPARE for the owner to review. One type: the service ZIP list. The proposal is built by code
// from the owner's own words and recorded requests (never by a model) and changes nothing. Applying is a separate,
// explicit owner action: re-validated, refused if the list changed meanwhile, audited, and read back.
import { recordEvent } from './auditlog.js'
import { checkZip } from './zipcode.js'
import { outsideZips } from './insights.js'
import { validateBusiness } from './customers.js'

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
  const bad = wantsIn.filter((z) => checkZip(z).check !== 'valid')
  const seen = named.length ? [] : (await outsideZips(env, customer, now)).filter((z) => z.check === 'outside')
  const repeat = seen.filter((z) => z.n > 1)
  const add = (named.length ? wantsIn.filter((z) => !bad.includes(z)) : repeat.map((z) => z.zip)).filter((z) => !before.includes(z)).slice(0, MAX_ADD)
  const remove = wantsOut.filter((z) => before.includes(z))
  const notes = [bad.length && `${bad.join(', ')} isn’t a ZIP code we recognise, so it’s left out.`].filter(Boolean)
  if (!before.length && add.length) return { text: 'You haven’t limited your area, so people anywhere can book. Adding a ZIP would stop everyone else from booking, so nothing is suggested. If you do want a limit, set it in Settings under Business.' }
  if (remove.length && remove.length === before.length && !add.length) return { text: 'Removing every ZIP would let people anywhere book, so it isn’t suggested here. You can clear the list in Settings under Business.' }
  if (!add.length && !remove.length) {
    const none = !before.length
      ? 'You haven’t limited your area, so nobody is turned away for their ZIP.'
      : named.length
        ? 'Those ZIP codes wouldn’t change your list.'
        : seen.length
          ? `In the last 90 days, inquiries came from ${seen.slice(0, 5).map((z) => z.zip).join(', ')}, once each. That’s too little to suggest a change. Tell me a ZIP to add or remove if you’ve decided.`
          : 'No inquiries from outside your ZIP codes are recorded in the last 90 days, so there’s nothing to suggest. Tell me a ZIP to add or remove if you’ve decided.'
    return { text: [none, ...notes].join(' ') }
  }
  const after = [...before.filter((z) => !remove.includes(z)), ...add]
  const why = named.length ? 'From what you asked for.' : `From your records, last 90 days: ${repeat.filter((z) => add.includes(z.zip)).map((z) => `${z.n} inquiries from ${z.zip}`).join(', ')}.`
  return {
    text: 'Here’s a change to review. Nothing is saved until you approve it.',
    proposal: {
      type: 'service_zips',
      before,
      after,
      add,
      remove,
      why,
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
