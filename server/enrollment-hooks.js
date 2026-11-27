// Seams between assisted enrollment (server/enrollment.js) and modules other streams own. Each returns a safe default
// until the lead connects it; nothing here may throw into an enrollment action. (A guarded dynamic import of a module
// that isn't in this branch would fail the Functions bundle, so the import is the lead's one-line change.)
//
// TODO(lead, stream C): replace attributeAssisted's body with
//   import { recordAttribution } from './commercial-attribution.js'
//   return recordAttribution(env.ONBOARDING_DB, customerId, { channel, repEmail, partnerCode: null, source: 'assisted', ownerEmail }, now)
// (recordAttribution is idempotent, never throws, no-op before 0048; ownerEmail runs the self-referral check).
// eslint-disable-next-line no-unused-vars
export async function attributeAssisted(env, customerId, { channel, repEmail, ownerEmail }, now = Date.now()) {
  return { recorded: false, reason: 'attribution_not_connected' }
}

// TODO(lead, telephony, draft PR #192): replace phoneHook's body with
//   import { phoneSetup } from './telephony/lines.js'
//   return (await phoneSetup(env, customerId)) || { state: 'unavailable' }
// phoneSetup → { state: 'unavailable' | 'not_started' | 'needs_owner' | 'ready' | 'live', next, href }; 'unavailable'
// (and this default) show "Phone: not available yet" in the enrollment checklist.
// eslint-disable-next-line no-unused-vars
export async function phoneHook(env, customerId) {
  return { state: 'unavailable', next: null, href: null }
}
