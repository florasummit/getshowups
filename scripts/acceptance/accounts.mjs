// Which businesses a deployed acceptance run may use: named here AND admin-marked as a test business by the server. Both
// the sign-in (login.mjs) and the run (run.mjs) decide with this, so one can't accept what the other refuses.
export const ALLOWED = ['gsu-journey-test', 'gsu-stripe-test-pools']

// me: /api/dashboard/me. → 'signed_out' | 'ok' | a reason to refuse.
export function verdict(me) {
  if (!me?.email) return 'signed_out'
  if (!me.customer) return 'no_business'
  if (me.testBusiness !== true) return 'real_business'
  return ALLOWED.includes(me.customer.id) ? 'ok' : 'not_allowed'
}
export function explain(me, v) {
  const who = `You signed in as ${me.email}. Google accepted it.`
  const why = { no_business: 'That account has no business.', real_business: `That account belongs to ${me.customer?.name}, which is not a test business, so this testing window signed it out.`, not_allowed: `${me.customer?.name} is a test business, but not one this runner may use.` }[v]
  return `${who} ${why} Use the Google account that owns ${ALLOWED.join(' or ')}: press Continue with Google, then “Use another account”.`
}
