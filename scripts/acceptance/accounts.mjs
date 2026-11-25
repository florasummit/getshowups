// Which businesses a deployed acceptance run may use: named here AND admin-marked as a test business by the server. The
// server decides first (server/acceptance.js); this is the runner's own second look.
export const ALLOWED = ['gsu-journey-test']

// me: /api/dashboard/me. → 'signed_out' | 'ok' | a reason to refuse.
export function verdict(me) {
  if (!me?.email) return 'signed_out'
  if (!me.customer) return 'no_business'
  if (me.testBusiness !== true) return 'real_business'
  return ALLOWED.includes(me.customer.id) ? 'ok' : 'not_allowed'
}
export function explain(me, v) {
  const who = 'The test session was refused by the runner.'
  const why = { no_business: 'It has no business.', real_business: `${me.customer?.name} is not a test business.`, not_allowed: `${me.customer?.name} is a test business, but not one this runner may use.` }[v]
  return `${who} ${why} Pair with ${ALLOWED.join(' or ')}: node scripts/acceptance/pair.mjs.`
}
