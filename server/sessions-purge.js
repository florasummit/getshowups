// Expired sign-in sessions are refused already (server/auth.js); this removes the rows, which hold an email address.
// Predicate: expired more than GRACE_MS ago, nothing else, at most BATCH per run. An active session can never match.
// dryRun counts without deleting. Off: SESSION_PURGE_ENABLED=false.
export const GRACE_MS = 86_400_000
export const BATCH = 200

export async function purgeExpiredSessions(env, now = Date.now(), { dryRun = false } = {}) {
  if (env.SESSION_PURGE_ENABLED === 'false') return { enabled: false }
  const db = env.ONBOARDING_DB
  const before = now - GRACE_MS
  if (dryRun) return { enabled: true, wouldRemove: Number((await db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at < ?1').bind(before).first()).n) }
  const r = await db.prepare('DELETE FROM sessions WHERE expires_at < ?1 AND token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < ?1 LIMIT ?2)').bind(before, BATCH).run()
  return { enabled: true, removed: r.meta.changes }
}
