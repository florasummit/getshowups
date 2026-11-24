// Only sessions expired for more than a day go; active ones never; dry run counts and changes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { BATCH, GRACE_MS, purgeExpiredSessions } from '../server/sessions-purge.js'

test('expired sessions are purged narrowly', async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  const env = { ONBOARDING_DB: { prepare: (q) => stmt(q) } }
  const NOW = 1_800_000_000_000
  const add = (id, at) => sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, 1, ?)').run(id, 'o@x.example', at)
  add('active', NOW + 1)
  add('justexpired', NOW - 1)
  add('boundary', NOW - GRACE_MS)
  for (let i = 0; i < BATCH + 5; i++) add(`old${i}`, NOW - GRACE_MS - 1)
  const ids = () => sql.prepare("SELECT token_hash FROM sessions WHERE token_hash NOT LIKE 'old%' ORDER BY 1").all().map((r) => r.token_hash)
  const n = () => sql.prepare('SELECT count(*) AS n FROM sessions').get().n
  assert.deepEqual(await purgeExpiredSessions(env, NOW, { dryRun: true }), { enabled: true, wouldRemove: BATCH + 5 })
  assert.equal(n(), BATCH + 8)
  assert.deepEqual(await purgeExpiredSessions({ ...env, SESSION_PURGE_ENABLED: 'false' }, NOW), { enabled: false })
  assert.deepEqual([(await purgeExpiredSessions(env, NOW)).removed, (await purgeExpiredSessions(env, NOW)).removed, (await purgeExpiredSessions(env, NOW)).removed], [BATCH, 5, 0])
  assert.deepEqual(ids(), ['active', 'boundary', 'justexpired'])
})
