// Seams between assisted enrollment (server/enrollment.js) and modules other streams own. Nothing here may throw into an
// enrollment action: each returns a safe default when its module is missing or fails.
import { recordAttribution } from './commercial-attribution.js'

// Who closed the sale and through which channel (server/commercial-attribution.js; idempotent, first touch kept, a no-op
// before migration 0048). ownerEmail runs the self-referral check before the owner is a member.
export async function attributeAssisted(env, customerId, { channel, repEmail, partnerCode = null, ownerEmail = null }, now = Date.now()) {
  try {
    return (await recordAttribution(env.ONBOARDING_DB, customerId, { channel, repEmail, partnerCode, source: 'assisted', ownerEmail }, now)) ?? { recorded: true }
  } catch {
    return { recorded: false, reason: 'attribution_failed' }
  }
}

// Telephone setup: server/telephony/lines.js phoneSetup (read-only, owned by the telephony work, draft PR #192) →
// { state: 'unavailable' | 'not_started' | 'needs_owner' | 'ready' | 'live', next, href }. Loaded at run time, so this file
// works with or without that module; 'unavailable' (and any failure) shows "Phone: not available yet" in the checklist.
const UNAVAILABLE = { state: 'unavailable', next: null, href: null }
export async function phoneHook(env, customerId) {
  try {
    const mod = await import('./telephony/lines.js')
    return (typeof mod.phoneSetup === 'function' && customerId ? await mod.phoneSetup(env, customerId) : null) || UNAVAILABLE
  } catch {
    return UNAVAILABLE
  }
}
