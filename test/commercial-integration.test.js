// The seams between the three commercial enrollment streams (sign-in, assisted enrollment, attribution), on the real
// migrations: an assisted sale records who closed it, staff can sign in by email only while their role is active, and the
// telephone hook degrades to "not available" until that module exists. Real modules on node:sqlite; nothing external.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { attributeAssisted, phoneHook } from '../server/enrollment-hooks.js'
import { signInAllowed } from '../server/email-auth.js'

function d1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.some((s) => f.startsWith(s))) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
  })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } })) }
}
const env = (db) => ({ ONBOARDING_DB: db, PLATFORM_ADMIN_EMAILS: 'founder@getshowups.example', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' })

test('an assisted sale records its channel and closing representative once (first touch kept)', async () => {
  const db = d1()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_at, updated_at) VALUES ('assisted1', 'A', 'UTC', '', 1, 1)").run()
  await attributeAssisted(env(db), 'assisted1', { channel: 'sales_rep', repEmail: 'rep@sales.example', ownerEmail: 'owner@pools.example' }, 10)
  await attributeAssisted(env(db), 'assisted1', { channel: 'founder', repEmail: 'other@sales.example', ownerEmail: 'owner@pools.example' }, 20)
  const row = db.sql.prepare("SELECT channel, closing_rep_email, partner_id FROM commercial_attribution WHERE customer = 'assisted1'").get()
  assert.deepEqual({ ...row }, { channel: 'sales_rep', closing_rep_email: 'rep@sales.example', partner_id: null })
})

test('before migration 0048 an assisted sale still completes: attribution is a quiet no-op', async () => {
  const db = d1({ skip: ['0048'] })
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_at, updated_at) VALUES ('assisted2', 'B', 'UTC', '', 1, 1)").run()
  const r = await attributeAssisted(env(db), 'assisted2', { channel: 'founder', repEmail: 'founder@getshowups.example' })
  assert.ok(r && typeof r === 'object')
})

test('staff may sign in by email only while their role is active; revocation ends it', async () => {
  const db = d1()
  const e = env(db)
  // A plan on sale with test billing = online sign-up closed (the production state today).
  db.sql.prepare("INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES ('founding', 'Growth', 'price_X', 0, '{}', 1, 1)").run()
  assert.equal(await signInAllowed(e, 'rep@sales.example'), false, 'no role, no business, sign-up closed')
  db.sql.prepare("INSERT INTO commercial_roles (email, role, granted_by, granted_at) VALUES ('rep@sales.example', 'sales_rep', 'founder@getshowups.example', 1)").run()
  assert.equal(await signInAllowed(e, 'rep@sales.example'), true)
  db.sql.prepare("UPDATE commercial_roles SET revoked_at = 2, revoked_by = 'founder@getshowups.example' WHERE email = 'rep@sales.example'").run()
  assert.equal(await signInAllowed(e, 'rep@sales.example'), false)
  assert.equal(await signInAllowed(e, 'stranger@x.example'), false)
})

test('the telephone hook says "not available yet" until that module is released', async () => {
  const r = await phoneHook(env(d1()), 'assisted1')
  assert.equal(r.label, 'Phone: not available yet')
})
