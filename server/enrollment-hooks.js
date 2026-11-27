// Seams between assisted enrollment (server/enrollment.js) and modules other streams own. Nothing here may throw into an
// enrollment action: each returns a safe default when its module is missing or fails.
import { recordAttribution } from './commercial-attribution.js'

// Who closed the sale and through which channel (server/commercial-attribution.js; idempotent, first touch kept, a no-op
// before migration 0048). ownerEmail lets the self-referral check run before the owner is a member.
export async function attributeAssisted(env, customerId, { channel, repEmail, partnerCode = null, ownerEmail = null }, now = Date.now()) {
  try {
    return (await recordAttribution(env.ONBOARDING_DB, customerId, { channel, repEmail, partnerCode, source: 'assisted', ownerEmail }, now)) ?? { recorded: true }
  } catch {
    return { recorded: false, reason: 'attribution_failed' }
  }
}

// Telephone setup (owned by the telephony work, server/telephony/lines.js phoneSetup, read-only). Until that module is
// released: "Phone: not available yet". Loaded at run time so this file works with or without it.
const UNAVAILABLE = { state: 'not_available', next: null, href: null, label: 'Phone: not available yet' }
export async function phoneHook(env, customerId) {
  try {
    const mod = await import('./telephony/lines.js')
    const r = typeof mod.phoneSetup === 'function' ? await mod.phoneSetup(env, customerId) : null
    if (!r || r.state === 'unavailable') return UNAVAILABLE
    return { ...r, label: r.next || null }
  } catch {
    return UNAVAILABLE
  }
}
