// Research Vault access (docs/RESEARCH_VAULT.md). Separate from platform administration: being a platform admin is
// necessary but NOT sufficient. Allowed:
//   founder     the one email in RESEARCH_FOUNDER_EMAIL (must also be in PLATFORM_ADMIN_EMAILS): everything
//   director    research_members row, not revoked: read, write, manage researchers
//   researcher  research_members row, not revoked: read, write
// Every refusal is the same generic 404 { error: 'not_found' }, whatever the reason (signed out, not admin, not a
// member, vault off, tables missing): the route's existence is never confirmed. Not relying on obscurity: every
// request is authorized server-side. Writes also need a recent sign-in (RECENT_MS): the existing sign-in has no
// second factor, so "signed in within 12 hours" is the step-up this architecture supports.
import { json, missingConfig } from '../google-oauth.js'
import { getSession, isSameOrigin } from '../auth.js'
import { adminEmails } from '../platform.js'
import { recordEvent } from '../auditlog.js'

export const RECENT_MS = 12 * 3_600_000
export const NOT_FOUND = () => json(404, { error: 'not_found' })
const founderOf = (env) => String(env.RESEARCH_FOUNDER_EMAIL || '').trim().toLowerCase()

let ready = null
export async function researchReady(db) {
  if (ready === db) return true
  try {
    const n = Number((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('research_members', 'research_nodes', 'research_versions', 'research_edges')").first())?.n)
    if (n === 4) ready = db
    return n === 4
  } catch {
    return false
  }
}

// → { researcher: { email, role, ref } } | { response } (always the same 404 on refusal)
export async function requireResearcher(request, env, { write = false, manage = false, now = Date.now() } = {}) {
  const founder = founderOf(env)
  if (!founder || missingConfig(env).length || !env.ONBOARDING_DB) return { response: NOT_FOUND() }
  if (write && !isSameOrigin(request, env)) return { response: NOT_FOUND() }
  let session = null
  try {
    session = await getSession(request, env, now)
  } catch {
    return { response: NOT_FOUND() }
  }
  if (!session || !adminEmails(env).includes(session.email)) return { response: NOT_FOUND() }
  if (!(await researchReady(env.ONBOARDING_DB))) return { response: NOT_FOUND() }
  let role = session.email === founder ? 'founder' : null
  if (!role) {
    const m = await env.ONBOARDING_DB.prepare('SELECT role FROM research_members WHERE email = ?1 AND revoked_at IS NULL').bind(session.email).first().catch(() => null)
    role = m?.role || null
  }
  if (!role || (manage && role === 'researcher')) {
    await recordEvent(env.ONBOARDING_DB, { type: 'research.access_refused', actor: `admin:${session.email}`, capability: 'research.vault', resource: { type: 'vault', id: 'research' }, outcome: 'info' }).catch(() => {})
    return { response: NOT_FOUND() }
  }
  if (write && !(Number(session.signedInAt) > now - RECENT_MS)) return { response: json(401, { error: 'recent_sign_in_required' }) }
  return { researcher: { email: session.email, role, ref: `admin:${session.email}` } }
}
