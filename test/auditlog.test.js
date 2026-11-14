// Permanent audit log (migration 0015, server/auditlog.js): append-only (SQLite refuses changes), hash-chained
// (tampering detected), no personal data (emails → refs), never throws, and the producers that write to it.
// Real migrations on node:sqlite. Run: node --no-warnings --test test/auditlog.test.js
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { appendAudit, auditCheckpoint, emailRef, listAudit, verifyAuditChain, GENESIS } from '../server/auditlog.js'
import { audit } from '../server/platform.js'
import { handleEvent } from '../server/stripe.js'

function d1(skip = []) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.includes(f)) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, prepare: (q) => stmt(q) }
}
let db, logs, origError
beforeEach(() => {
  db = d1()
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})
afterEach(() => {
  console.error = origError
})
const rows = () => db.sql.prepare('SELECT * FROM audit_log ORDER BY seq').all()

test('append: entries are numbered 1,2,3 and each hash covers the previous one', async () => {
  for (let i = 0; i < 3; i++) assert.deepEqual(await appendAudit(db, { actorType: 'system', actor: 'system:test', action: `t.${i}`, customer: 'alpha', details: { n: i } }), { ok: true, seq: i + 1 })
  const r = rows()
  assert.deepEqual(r.map((x) => x.seq), [1, 2, 3])
  assert.equal(r[0].prev_hash, GENESIS)
  assert.equal(r[1].prev_hash, r[0].hash)
  assert.equal(r[2].prev_hash, r[1].hash)
  assert.deepEqual(await verifyAuditChain(db), { ok: true, checked: 3, headSeq: 3, headHash: r[2].hash })
})

test('append-only: SQLite refuses changing or removing an entry (the guard triggers)', async () => {
  await appendAudit(db, { actorType: 'system', actor: 'system:test', action: 't', details: {} })
  assert.throws(() => db.sql.exec("UPDATE audit_log SET action = 'x'"), /append-only/)
  assert.throws(() => db.sql.exec('DELETE FROM audit_log'), /append-only/)
  assert.equal(rows().length, 1)
})

test('tamper detection: an altered, reordered or missing entry is found by the chain check', async () => {
  for (let i = 0; i < 4; i++) await appendAudit(db, { actorType: 'system', actor: 'system:test', action: `t.${i}`, details: { n: i } })
  // Someone with raw database access drops the guards and edits an entry.
  db.sql.exec('DROP TRIGGER audit_log_append_only_u; DROP TRIGGER audit_log_append_only_d')
  db.sql.exec(`UPDATE audit_log SET details = '{"n":99}' WHERE seq = 2`)
  assert.deepEqual(await verifyAuditChain(db), { ok: false, checked: 1, brokenAt: 2, reason: 'altered' })
  db.sql.exec(`UPDATE audit_log SET details = '{"n":1}' WHERE seq = 2`)
  assert.equal((await verifyAuditChain(db)).ok, true, 'restored')
  db.sql.exec('DELETE FROM audit_log WHERE seq = 3')
  assert.deepEqual(await verifyAuditChain(db), { ok: false, checked: 2, brokenAt: 3, reason: 'missing' })
})

test('privacy: customer/owner emails become one-way refs (stable), staff admin actor stays readable; nothing personal stored', async () => {
  await appendAudit(db, { actorType: 'owner', actor: 'owner:Jamie.Lee@Example.net', action: 'website.publish', customer: 'alpha', details: { note: 'sent to jamie.lee@example.net', nested: { list: ['a@b.co'] } } })
  await appendAudit(db, { actorType: 'admin', actor: 'Founder@GetShowUps.example', action: 'invite.create', customer: 'alpha', details: { email: 'new.owner@pools.example' } })
  const text = JSON.stringify(rows())
  for (const s of ['jamie', 'Jamie', 'new.owner', 'a@b.co']) assert.ok(!text.includes(s), `no ${s}`)
  const ref = await emailRef('jamie.lee@example.net')
  assert.match(ref, /^ref:[0-9a-f]{20}$/)
  const [first, second] = await listAudit(db, { limit: 10 }).then((l) => l.reverse())
  assert.equal(first.actor, `owner:${ref}`, 'same person → same ref (case-insensitive)')
  assert.equal(first.details.note, `sent to ${ref}`)
  assert.equal(second.actor, 'founder@getshowups.example', 'staff identity kept (accountable)')
  assert.match(second.details.email, /^ref:/)
})

test('never throws: missing table (before migration 0015) or bad input → logged code, action unaffected', async () => {
  const old = d1(['0015_audit_log.sql'])
  assert.deepEqual(await appendAudit(old, { actorType: 'system', actor: 'x', action: 't' }), { ok: false, error: 'table_missing' })
  assert.deepEqual(await appendAudit(db, { actorType: 'hacker', actor: 'x', action: 't' }), { ok: false, error: 'storage_error' })
  assert.ok(logs.every((l) => /^audit log not written: t (table_missing|storage_error)$/.test(l)))
})

test('concurrent writers: no gaps or forks (a taken sequence number is retried)', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendAudit(db, { actorType: 'system', actor: 'system:test', action: `c.${i}` })))
  assert.deepEqual(rows().map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal((await verifyAuditChain(db)).ok, true)
})

test('daily checkpoint: verifies the chain once a day and records the result', async () => {
  await appendAudit(db, { actorType: 'system', actor: 'system:test', action: 't' })
  const now = Date.now()
  assert.equal((await auditCheckpoint(db, now)).ok, true)
  assert.deepEqual(await auditCheckpoint(db, now + 1000), { skipped: true })
  const cp = rows().at(-1)
  assert.equal(cp.action, 'audit.checkpoint')
  assert.deepEqual(JSON.parse(cp.details), { ok: true, headSeq: 1, headHash: rows()[0].hash })
  assert.equal((await auditCheckpoint(db, now + 86400001)).ok, true, 'next day: checked again (incl. the checkpoint)')
})

test('producers: admin audit() and Stripe billing changes (status, cancellation scheduled, payments) are recorded', async () => {
  const now = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, created_at, updated_at) VALUES ('alpha', 'Alpha', 'UTC', '', '09:00', '17:00', '1', ?, ?)").run(now, now)
  const env = { ONBOARDING_DB: db }
  await audit(env, 'ops@getshowups.example', 'customer.suspend', 'alpha', { reason: 'r' })
  let t = Math.floor(now / 1000)
  const sub = (status, extra = {}) => ({ id: 'sub_1', customer: 'cus_1', status, metadata: { customer: 'alpha' }, items: { data: [] }, ...extra })
  const ev = (type, object) => handleEvent(env, { id: `evt_${t}`, type, created: t++, livemode: false, data: { object } })
  await ev('customer.subscription.created', sub('active'))
  await ev('customer.subscription.updated', sub('active', { cancel_at_period_end: true }))
  await ev('customer.subscription.updated', sub('active', { cancel_at_period_end: false }))
  await ev('invoice.payment_failed', { id: 'in_1', customer: 'cus_1', metadata: { customer: 'alpha' } })
  await ev('invoice.paid', { id: 'in_1', customer: 'cus_1', amount_paid: 49900, currency: 'usd' })
  await ev('customer.subscription.deleted', sub('canceled'))
  assert.deepEqual(
    rows().map((r) => `${r.actor_type}:${r.action}`),
    [
      'admin:customer.suspend',
      'stripe:billing.subscription_status',
      'stripe:billing.cancellation_scheduled',
      'stripe:billing.cancellation_withdrawn',
      'stripe:billing.payment_failed',
      'stripe:billing.payment_succeeded',
      'stripe:billing.subscription_status',
    ],
  )
  assert.deepEqual(JSON.parse(rows().at(-1).details), { eventId: `evt_${t - 1}`, subscription: 'sub_1', livemode: false, from: 'active', to: 'canceled', plan: null })
  assert.equal((await verifyAuditChain(db)).ok, true)
})
