// Is the five-minute job alive? Each finished run stamps one row; GET /api/health reports its age so an OUTSIDE monitor can
// notice silence (founder alerts are sent by that same job, so they can't report it stopping). The row lives in
// rate_limits (key, win = time, far expiry): no new table, no customer data.
const KEY = 'heartbeat:cron'
export const STALE_MS = 20 * 60_000
export const beat = (db, now = Date.now()) =>
  db.prepare('INSERT INTO rate_limits (key, win, count, expires_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(key) DO UPDATE SET win = ?2, count = 1, expires_at = ?3').bind(KEY, now, now + 3650 * 86_400_000).run()
export async function heartbeat(db, now = Date.now()) {
  const r = await db.prepare('SELECT win FROM rate_limits WHERE key = ?1').bind(KEY).first()
  if (!r) return { status: 'unknown', ageSeconds: null }
  const age = Math.max(0, now - r.win)
  return { status: age > STALE_MS ? 'stale' : 'ok', ageSeconds: Math.round(age / 1000) }
}
