// Per-business feature restrictions set by a platform admin (migration 0041). A row = off for that business. They only
// ever take away: no row can turn something on that a switch, plan or approval keeps off. Before 0041: none. Any other
// read error counts as restricted (the same fail-closed rule as eligibility).
export const FEATURES = { ads: 'Running ads', teach_ai: 'Teach Your AI', website_studio: 'Website Studio and AI design', receptionist: 'AI receptionist', assistant: 'Dashboard assistant' }
export async function restricted(env, customerId, feature, { onError = 'restricted' } = {}) {
  try {
    return Boolean(await env.ONBOARDING_DB.prepare('SELECT 1 AS x FROM business_restrictions WHERE customer = ?1 AND feature = ?2').bind(customerId, feature).first())
  } catch (err) {
    if (String(err?.message).includes('no such table')) return false
    if (onError === 'throw') throw err
    return true
  }
}
export async function listRestrictions(db, customerId) {
  try {
    const { results } = await db.prepare('SELECT feature, reason, set_at FROM business_restrictions WHERE customer = ?1 ORDER BY feature').bind(customerId).all()
    return { ready: true, list: results.map((r) => ({ feature: r.feature, reason: r.reason, at: r.set_at })) }
  } catch (err) {
    if (String(err?.message).includes('no such table')) return { ready: false, list: [] }
    throw err
  }
}
export async function setRestriction(db, customerId, feature, on, reason, by, now = Date.now()) {
  await (on
    ? db.prepare('INSERT INTO business_restrictions (customer, feature, reason, set_by, set_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(customer, feature) DO UPDATE SET reason = ?3, set_by = ?4, set_at = ?5').bind(customerId, feature, reason, by, now)
    : db.prepare('DELETE FROM business_restrictions WHERE customer = ?1 AND feature = ?2').bind(customerId, feature)
  ).run()
}
