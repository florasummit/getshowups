// Who gets the Ads feature. Two switches, both off by default, both production settings (approval):
//   ADS_ENABLED === 'true'  master switch (off → every Ads route is 404 for everyone)
//   ADS_BUSINESSES          comma-separated business ids that get Ads while the master switch is on.
// No wildcard: each business is listed explicitly, so a controlled rollout is one business at a time.
// Empty/unset → nobody. Live spending stays a separate switch (ADS_LIVE_LAUNCH).
import { CUSTOMER_RE } from '../invites.js'

export const adsEnabled = (env) => env?.ADS_ENABLED === 'true'

export const adsBusinesses = (env) =>
  String(env?.ADS_BUSINESSES || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => CUSTOMER_RE.test(s))

export const adsEnabledFor = (env, customerId) =>
  adsEnabled(env) && typeof customerId === 'string' && CUSTOMER_RE.test(customerId) && adsBusinesses(env).includes(customerId)
