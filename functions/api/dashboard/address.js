// /api/dashboard/address — the business's own address (server/business-address.js, migration 0045).
//   GET  → { ready, address: { street, unit, city, state, zip, public } | null, shown: whether customers see it now }
//   POST { address: {…} | null, public: boolean, base } → saved | 409 changed elsewhere | 409 address_unavailable (before 0045)
// Customers see it only when public AND customers come to the business (at_business); never for a visiting business.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { getBusinessAddress, saveBusinessAddress, validateBusinessAddress } from '../../../server/business-address.js'
import { isStale } from '../../../server/stale.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { appendOwnerChange } from '../../../server/owner-changes.js'

const view = (c, r) => ({ ready: r.ready, address: r.address, shown: Boolean(r.address?.public && c.appointmentMode === 'at_business') })
// The form's shape, for the stale check.
const current = (r) => ({ address: r.address ? { street: r.address.street, unit: r.address.unit, city: r.address.city, state: r.address.state, zip: r.address.zip } : null, public: Boolean(r.address?.public) })

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    return json(200, view(session.customer, await getBusinessAddress(env.ONBOARDING_DB, session.customer.id)))
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
  const [error, v] = validateBusinessAddress(body)
  if (error) return json(400, { error })
  try {
    const db = env.ONBOARDING_DB
    const now = await getBusinessAddress(db, c.id)
    if (!now.ready) return json(409, { error: 'address_unavailable' })
    if (isStale(body, current(now))) return json(409, { error: 'conflict', current: current(now) })
    const r = await saveBusinessAddress(db, c.id, v)
    if (!r.ok) return json(409, { error: r.error })
    await appendOwnerChange(env, session, 'business.address_changed', { set: Boolean(v.address), public: v.public })
    return json(200, view(c, await getBusinessAddress(db, c.id)))
  } catch (err) {
    console.error('address save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
