// Who gets Website Studio: every eligible business (owner decision 2026-11-16; it was an internal pilot listed in
// WEBSITE_STUDIO_BUSINESSES before). Website Studio = the business's own Claude/OpenAI key (server/ai-credentials.js),
// the AI designer (server/ai-designer.js), and bringing in the current website (server/website-import.js, incl.
// old-address redirects). Everything else about websites is unchanged; manual editing never needs a key.
// Eligible (all must hold, checked per request on the signed-in session's own business):
//   - Studio is not switched off: WEBSITE_STUDIO_ENABLED === 'false' is the emergency off switch (default on);
//   - the business is active (an admin suspension or an account deletion turns it off);
//   - its website hosting is active (paid subscription, trialing, past due, or a pilot exempt from billing); not a
//     self-serve sign-up before payment, and not a cancelled subscription;
//   - the database has Studio's tables (migrations 0021–0023). Until they are applied Studio stays hidden instead of
//     failing, so deploying this never requires the migration first.
// Published content is never gated: a business losing access keeps its live website.
import { CUSTOMER_RE } from './invites.js'
import { hostingStatus } from './website.js'

export const studioEnabled = (env) => env?.WEBSITE_STUDIO_ENABLED !== 'false'

export const STUDIO_TABLES = ['website_imports', 'ai_credentials', 'ai_model_registry', 'ai_key_usage', 'website_design_turns']
// Once the tables exist they don't disappear, so "ready" is remembered for the life of the isolate; "missing" is
// re-checked on every request (the migration may be applied at any time).
const ready = new WeakSet()
export async function studioSchemaReady(db) {
  if (!db) return false
  if (ready.has(db)) return true
  const r = await db
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${STUDIO_TABLES.map((_, i) => `?${i + 1}`).join(', ')})`)
    .bind(...STUDIO_TABLES)
    .first()
  const ok = Number(r?.n) === STUDIO_TABLES.length
  if (ok) ready.add(db)
  return ok
}

// `customer`: the session's business (session.customer: id + status). Fails closed: any lookup error → no access.
export async function studioAccess(env, customer) {
  try {
    if (!studioEnabled(env) || !customer || typeof customer.id !== 'string' || !CUSTOMER_RE.test(customer.id)) return false
    if ((customer.status || 'active') !== 'active') return false
    const db = env.ONBOARDING_DB
    if ((await hostingStatus(db, customer.id)).status !== 'active') return false
    return await studioSchemaReady(db)
  } catch (err) {
    console.error('studio access check failed:', err?.name)
    return false
  }
}

// Publishing is a standard self-service step for every eligible business (owner decision 2026-11-16; it was held back
// during the internal pilot). The owner publishes explicitly (confirmation required); drafts are never published
// automatically. WEBSITE_STUDIO_PUBLISH === 'false' is the emergency off switch: content that carries an AI-designed site
// or old-address redirects then can't go live (publish or restore); what is already live keeps serving.
export const studioPublishAllowed = (env) => env?.WEBSITE_STUDIO_PUBLISH !== 'false'
export const hasStudioOutput = (content) => Boolean(content && (content.site || content.redirects?.length))
