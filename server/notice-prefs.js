// Which owner notices each member gets (migration 0041). A row = off. Before 0041, or if it can't be read: everything on.
export const NOTICE_KINDS = { owner_booking: 'New booking', owner_lead: 'Someone asked and hasn’t booked', owner_cancel: 'A customer cancelled', owner_callback: 'Call-back requests and messages', owner_coverage: 'Requests outside your area', owner_bounce: 'A customer’s email didn’t arrive' }
export async function noticesOff(db, customers) {
  try {
    if (!customers.length) return new Set()
    const { results } = await db.prepare(`SELECT customer, email, kind FROM owner_notice_off WHERE customer IN (${customers.map((_, i) => `?${i + 1}`).join(',')})`).bind(...customers).all()
    return new Set(results.map((r) => `${r.customer}|${r.email}|${r.kind}`))
  } catch {
    return new Set()
  }
}
export async function myNotices(db, customer, email) {
  const { results } = await db.prepare('SELECT kind FROM owner_notice_off WHERE customer = ?1 AND email = ?2').bind(customer, email).all()
  const off = new Set(results.map((r) => r.kind))
  return Object.entries(NOTICE_KINDS).map(([kind, label]) => ({ kind, label, on: !off.has(kind) }))
}
export async function setNotice(db, customer, email, kind, on, now = Date.now()) {
  if (!Object.hasOwn(NOTICE_KINDS, kind) || typeof on !== 'boolean') return false
  await (on ? db.prepare('DELETE FROM owner_notice_off WHERE customer = ?1 AND email = ?2 AND kind = ?3').bind(customer, email, kind) : db.prepare('INSERT OR IGNORE INTO owner_notice_off (customer, email, kind, created_at) VALUES (?1, ?2, ?3, ?4)').bind(customer, email, kind, now)).run()
  return true
}
