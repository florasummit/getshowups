// ONE rule for who gets the self-service tools (Ads, Teach Your AI, Website Studio): every eligible business, no
// per-business allowlist and no platform-admin activation (owner decisions 2026-11-16 for Website Studio and
// 2026-11-22 for Ads + Teach Your AI). Eligible (all must hold, checked per request on the signed-in session's own
// business, never on client input):
//   - the business is active (an admin suspension or an account deletion turns it off);
//   - its hosting is active (paid subscription, trialing, past due, a never-billed pilot or a complimentary account);
//     not a self-serve sign-up before payment, and not a cancelled subscription (hostingStatus in server/website.js,
//     the same view billing uses).
// Each tool keeps its own emergency off switch (WEBSITE_STUDIO_ENABLED / ADS_ENABLED / AI_STUDIO_ENABLED === 'false')
// and its own schema check. Live use (ad spend, published AI rules reaching customers, texts) stays behind the separate
// approval switches; eligibility only decides what the owner can see and prepare. Fails closed: any lookup error → no.
import { CUSTOMER_RE } from './invites.js'
import { hostingStatus } from './website.js'

// Billing standing only (hosting active), whatever the account status. Ads uses this one: a suspended business keeps
// its Ads tab so the hold notice can say why its ads are paused (server/ads/holds.js) while every start is refused.
export async function hostingActive(env, customer, now = Date.now()) {
  try {
    if (!customer || typeof customer.id !== 'string' || !CUSTOMER_RE.test(customer.id)) return false
    return (await hostingStatus(env.ONBOARDING_DB, customer.id, now, env)).status === 'active'
  } catch (err) {
    console.error('eligibility check failed:', err?.name)
    return false
  }
}

// Active business + hosting active: Teach Your AI and Website Studio (editing tools a suspended business doesn't get).
export async function businessEligible(env, customer, now = Date.now()) {
  if (!customer || (customer.status || 'active') !== 'active') return false
  return hostingActive(env, customer, now)
}
