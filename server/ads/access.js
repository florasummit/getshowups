// Who gets the Ads feature: every business whose hosting is active (server/eligibility.js hostingActive: a paid, trialing
// or past-due subscription, a never-billed pilot or a complimentary account; not a self-serve sign-up before payment),
// no per-business allowlist (owner decision 2026-11-22; ADS_BUSINESSES was the pilot allowlist before and is ignored
// now). A suspended business keeps the tab: its ads are paused by the hold and the tab says why (server/ads/holds.js).
//   ADS_ENABLED === 'false'  emergency off switch (default on): every Ads route is 404 for everyone.
// Connecting an ad account and drafting never spends; live create/resume stays behind ADS_LIVE_LAUNCH, the owner's
// budget approval and the subscription rule (server/ads/campaigns.js liveFor), and test businesses never go live.
import { hostingActive } from '../eligibility.js'
import { restricted } from '../restrictions.js'

export const adsEnabled = (env) => env?.ADS_ENABLED !== 'false'

// `customer`: the session's business (id + status), never client input.
export const adsAccess = async (env, customer) => adsEnabled(env) && (await hostingActive(env, customer)) && !(await restricted(env, customer.id, 'ads'))
