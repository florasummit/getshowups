// Calls (and Local Services leads) Google reports for the signed-in business (server/ads/calls.js).
//   GET  ?days=7|30|90                                              → the report; { ready: false } while GOOGLE_CALLS_ENABLED is off or before migration 0040
//   POST { action: 'handled', id, handled }                        → the owner called back (or not)
//   POST { action: 'link', kind: 'call'|'lsa', id, leadId|null }   → a recorded customer of this business, or unlink
//   POST { action: 'add', kind, id, name, phone, need, zip }       → the caller becomes a customer record; returns bookUrl
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { addCaller, callReport, callsOn, callsReady, linkCall, markHandled } from '../../../../server/ads/calls.js'
import { internalEmails } from '../../../../server/testdata.js'

const daysOf = (v) => ([7, 30, 90].includes(Number(v)) ? Number(v) : 30)
// Who a call can be linked to: this business's newest inquiries (name and day only).
const people = async (db, customerId) =>
  (await db.prepare('SELECT id, name, created_at FROM leads WHERE customer = ?1 ORDER BY created_at DESC LIMIT 300').bind(customerId).all()).results.map((l) => ({ id: l.id, name: l.name, at: l.created_at }))
const report = async (env, customer, days) => {
  if (!callsOn(env)) return { ready: false }
  const r = await callReport(env.ONBOARDING_DB, customer.id, { days, internal: internalEmails(env) })
  return r.ready ? { ...r, addressNeeded: customer.appointmentMode === 'at_customer', zipNeeded: Boolean(customer.serviceZips?.length), people: await people(env.ONBOARDING_DB, customer.id) } : r
}

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  try {
    return json(200, await report(env, session.customer, daysOf(new URL(request.url).searchParams.get('days'))))
  } catch (err) {
    console.error('calls load failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'adsWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => null)
  const db = env.ONBOARDING_DB
  try {
    if (!callsOn(env) || !(await callsReady(db))) return json(404, { error: 'not_found' })
    const kind = b?.kind === 'lsa' ? 'lsa' : 'call'
    let r
    if (b?.action === 'handled' && typeof b.handled === 'boolean') r = await markHandled(db, session.customer.id, b.id, b.handled)
    else if (b?.action === 'link' && (b.leadId === null || typeof b.leadId === 'string')) r = await linkCall(db, session.customer.id, kind, b.id, b.leadId)
    else if (b?.action === 'add') r = await addCaller(env, session.customer, kind, b.id, b)
    else return json(400, { error: 'invalid_request' })
    if (!r.ok) return json(/not_found/.test(r.error) ? 404 : /^already/.test(r.error) ? 409 : 400, { error: r.error, ...(r.lead ? { lead: r.lead } : {}) })
    return json(200, { ...(await report(env, session.customer, daysOf(b.days))), ...(r.bookUrl ? { bookUrl: r.bookUrl } : {}), ...(r.notBookable ? { notBookable: true } : {}) })
  } catch (err) {
    console.error('calls save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
