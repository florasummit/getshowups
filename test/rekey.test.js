// Key rotation: old data stays readable during it, is rewritten once, links already sent keep working, and after the old
// key is gone everything still opens. A wrong key never opens anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { decrypt, encrypt } from '../server/google-oauth.js'
import { openKey, sealKey } from '../server/ai-credentials.js'
import { linkToken, verifyLinkToken } from '../server/links.js'
import { rekey } from '../server/rekey.js'
import * as api from '../functions/api/admin/rekey.js'

const key = (n) => Buffer.alloc(32, n).toString('base64')
test('rotate, rewrite, retire', async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  sql.exec('PRAGMA foreign_keys = OFF')
  const stmt = (q, a = []) => ({ bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  const m = new Map()
  const KV = { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) }
  const old = { TOKEN_ENCRYPTION_KEY: key(1), GOOGLE_TOKENS: KV, ONBOARDING_DB: { prepare: (q) => stmt(q) } }
  m.set('google:alpha', JSON.stringify({ refreshToken: await encrypt(old, 'cal'), scope: 's' }))
  m.set('ads:google:alpha', await encrypt(old, '{"refreshToken":"ads"}'))
  m.set('google:broken', 'not json')
  sql.prepare("INSERT INTO ai_credentials (customer, provider, sealed, hint, status, validated_at, created_at, updated_at) VALUES ('alpha', 'anthropic', ?, 'x', 'ok', 1, 1, 1)").run(await sealKey(old, 'alpha', 'anthropic', 'sk'))
  const link = await linkToken(old, 'lead', 'l1')
  const during = { ...old, TOKEN_ENCRYPTION_KEY: key(2), TOKEN_ENCRYPTION_KEY_PREVIOUS: key(1) }
  assert.equal(await decrypt(during, JSON.parse(m.get('google:alpha')).refreshToken), 'cal')
  assert.equal(await verifyLinkToken(during, 'lead', 'l1', link), true)
  assert.equal(await verifyLinkToken({ ...during, TOKEN_ENCRYPTION_KEY_PREVIOUS: key(9) }, 'lead', 'l1', link), false)
  assert.deepEqual(await rekey(during), { rewritten: 3, current: 0, unreadable: 1 })
  assert.deepEqual(await rekey(during), { rewritten: 0, current: 3, unreadable: 1 })
  const after = { ...during, TOKEN_ENCRYPTION_KEY_PREVIOUS: undefined }
  const rec = JSON.parse(m.get('google:alpha'))
  assert.deepEqual([await decrypt(after, rec.refreshToken), rec.scope], ['cal', 's'])
  assert.equal(JSON.parse(await decrypt(after, m.get('ads:google:alpha'))).refreshToken, 'ads')
  assert.equal(await openKey(after, 'alpha', 'anthropic', sql.prepare('SELECT sealed FROM ai_credentials').get().sealed), 'sk')
  await assert.rejects(decrypt({ TOKEN_ENCRYPTION_KEY: key(3), TOKEN_ENCRYPTION_KEY_PREVIOUS: key(4) }, rec.refreshToken))
})

test('the admin route needs the token and a rotation in progress', async () => {
  const env = { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'https://x.example/cb', TOKEN_ENCRYPTION_KEY: key(1), ADMIN_API_TOKEN: 'a'.repeat(40), GOOGLE_TOKENS: {}, ONBOARDING_DB: {} }
  const call = async (auth) => (await api.onRequestPost({ env, request: new Request('https://x.example', { method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {} }) })).status
  assert.equal(await call(null), 401)
  assert.equal(await call('a'.repeat(40)), 409)
})
