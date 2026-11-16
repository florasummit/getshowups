// Who gets Website Studio (internal pilot, owner decision 2026-11-16). Two switches, both off by default, both production
// settings (approval), like Ads (server/ads/access.js):
//   WEBSITE_STUDIO_ENABLED === 'true'  master switch (off → Studio routes are 404 for everyone)
//   WEBSITE_STUDIO_BUSINESSES          comma-separated business ids in the pilot while the master switch is on.
// No wildcard: each business is listed explicitly. Empty/unset → nobody.
// Website Studio = the business's own AI key (server/ai-credentials.js), the AI designer (server/ai-designer.js), and
// bringing in the current website (server/website-import.js, incl. old-address redirects). Everything else about websites
// is unchanged for every business. Published content is never gated: turning a business off keeps its live website.
import { CUSTOMER_RE } from './invites.js'

export const studioEnabled = (env) => env?.WEBSITE_STUDIO_ENABLED === 'true'

export const studioBusinesses = (env) =>
  String(env?.WEBSITE_STUDIO_BUSINESSES || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => CUSTOMER_RE.test(s))

export const studioEnabledFor = (env, customerId) =>
  studioEnabled(env) && typeof customerId === 'string' && CUSTOMER_RE.test(customerId) && studioBusinesses(env).includes(customerId)
