// Seams between assisted enrollment (server/enrollment.js) and modules other streams own. Each returns a safe default
// until the lead connects it; nothing here may throw into an enrollment action.
//
// TODO(lead, stream C): replace attributeAssisted's body with
//   import { recordAttribution } from './commercial-attribution.js'
//   return recordAttribution(env.ONBOARDING_DB, customerId, { channel, repEmail, partnerCode: null, source: 'assisted' }, now)
// (recordAttribution is idempotent, never throws and is a no-op before migration 0048).
// eslint-disable-next-line no-unused-vars
export async function attributeAssisted(env, customerId, { channel, repEmail }, now = Date.now()) {
  return { recorded: false, reason: 'attribution_not_connected' }
}

// TODO(lead, telephony stream): replace phoneHook's body with
//   import { phoneSetup } from './telephony/setup.js'
//   return phoneSetup(env, customerId)   // read-only → { state, next, href }
// eslint-disable-next-line no-unused-vars
export async function phoneHook(env, customerId) {
  return { state: 'not_available', next: null, href: null, label: 'Phone: not available yet' }
}
