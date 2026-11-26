// The business's own address (migration 0045, business_addresses): where customers come for an appointment. Optional;
// the owner sets it in Settings → Business with "Show this address to customers" (off by default). Shown publicly ONLY
// when public = 1 AND the appointment mode is at_business: a business that visits its customers (at_customer) never has
// its address exposed, even when marked public. Field rules: server/booking.js validateAddress (the same US address
// rules as a lead's service address, server/lead-fields.js). Before 0045: no address anywhere (null), saving answers
// address_unavailable. Not on the website yet (the renderer is unchanged).
import { formatAddress, validateAddress } from './booking.js'

const missing = (err) => /no such table: business_addresses/.test(String(err?.message))
const shape = (r) => (r ? { street: r.street, unit: r.unit, city: r.city, state: r.state, zip: r.zip, public: r.public === 1 } : null)

// → { ready, address: { street, unit, city, state, zip, public } | null }. Any other error is thrown.
export async function getBusinessAddress(db, customerId) {
  try {
    const r = await db.prepare('SELECT street, unit, city, state, zip, public FROM business_addresses WHERE customer = ?1').bind(customerId).first()
    return { ready: true, address: shape(r) }
  } catch (err) {
    if (missing(err)) return { ready: false, address: null }
    throw err
  }
}

// body: { address: { street, unit?, city, state, zip } | null, public: boolean }. null address = remove it.
// → [error, value] where value = { address: {…} | null, public }
export function validateBusinessAddress(body) {
  if (typeof body?.public !== 'boolean') return ['invalid_request']
  if (body.address === null) return [null, { address: null, public: false }]
  if (!body.address || typeof body.address !== 'object') return ['invalid_request']
  const [error, a] = validateAddress(body.address)
  if (error) return [error]
  return [null, { address: a, public: body.public }]
}

export async function saveBusinessAddress(db, customerId, v, now = Date.now()) {
  try {
    if (!v.address) await db.prepare('DELETE FROM business_addresses WHERE customer = ?1').bind(customerId).run()
    else {
      const a = v.address
      await db
        .prepare(
          'INSERT INTO business_addresses (customer, street, unit, city, state, zip, public, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(customer) DO UPDATE SET street = ?2, unit = ?3, city = ?4, state = ?5, zip = ?6, public = ?7, updated_at = ?8',
        )
        .bind(customerId, a.street, a.unit, a.city, a.state, a.zip, v.public ? 1 : 0, now)
        .run()
    }
    return { ok: true }
  } catch (err) {
    if (missing(err)) return { ok: false, error: 'address_unavailable' }
    throw err
  }
}

// What a customer may see: the one-line address when the owner chose to show it AND customers come to the business;
// null otherwise (private, a visiting business, no address, table missing, or unreadable).
export async function publicAddress(db, customer) {
  if (customer?.appointmentMode !== 'at_business') return null
  const r = await getBusinessAddress(db, customer.id).catch(() => ({ address: null }))
  return r.address?.public ? formatAddress(r.address) : null
}
