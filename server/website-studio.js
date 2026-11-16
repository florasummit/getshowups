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

// Publishing Studio output is a separate, later decision (owner, 2026-11-16: no public AI-designed website during the
// internal pilot). Unless WEBSITE_STUDIO_PUBLISH is exactly 'true', content that carries an AI-designed site or
// old-address redirects can't go live (publish or restore); drafts and private previews are unaffected. Content that was
// already live is never taken down by this.
export const studioPublishAllowed = (env) => env?.WEBSITE_STUDIO_PUBLISH === 'true'
export const hasStudioOutput = (content) => Boolean(content && (content.site || content.redirects?.length))
