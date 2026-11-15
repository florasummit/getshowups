// Owner notices (server/notify.js): new booking / unbooked lead → each business member, once; launch gate; no stale burst.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { queueOwnerNotices, LEAD_GRACE_MS, WINDOW_MS } from '../server/notify.js'
import { flushOutbox } from '../server/email.js'

const MIN = 60 * 1000
const NOW = Date.UTC(2026, 10, 15, 15, 0)

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q, args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } } },
  })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}

let db, env, sent, realFetch
const biz = (id, { status = 'active' } = {}) => db.sql.prepare("INSERT INTO customers (id, name, timezone, status, created_at, updated_at) VALUES (?, ?, 'America/New_York', ?, 1, 1)").run(id, `${id} Pools`, status)
const member = (email, customer) => db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(email, customer)
const lead = (id, customer, at, status = 'new', name = 'Casey Customer') =>
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES (?, ?, ?, 'casey@example.net', '555-010-0100', 'Weekly pool cleaning', ?, 'h', ?, ?)").run(id, customer, name, status, at, at)
const appt = (id, customer, leadId, at, status = 'booked') =>
  db.sql.prepare('INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, customer, leadId, Date.UTC(2026, 10, 17, 14), Date.UTC(2026, 10, 17, 15), status, at, at)
const outbox = () => db.sql.prepare('SELECT id, to_email, customer, template, subject, body, status FROM email_outbox ORDER BY id').all()

beforeEach(() => {
  db = d1()
  env = { ONBOARDING_DB: db, GOOGLE_REDIRECT_URI: 'https://getshowups.example/api/google/oauth/callback', RESEND_API_KEY: 're_test', EMAIL_FROM: 'GetShowUps <hello@getshowups.example>', MESSAGES_LIVE: 'true', MESSAGE_TEST_RECIPIENTS: 'tester@getshowups.example' }
  biz('alpha'); biz('bravo')
  member('owner@alpha.example', 'alpha'); member('partner@alpha.example', 'alpha'); member('boss@bravo.example', 'bravo')
  sent = []
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 }) }
})
afterEach(() => { globalThis.fetch = realFetch })

test('a new booking notifies every member of that business once (not other businesses); details + dashboard link', async () => {
  lead('L1', 'alpha', NOW - 3 * MIN, 'booked')
  appt('A1', 'alpha', 'L1', NOW - 2 * MIN)
  assert.deepEqual(await queueOwnerNotices(env, NOW), { queued: 2, held: 0 })
  const rows = outbox()
  assert.deepEqual(rows.map((r) => r.to_email).sort(), ['owner@alpha.example', 'partner@alpha.example'])
  assert.ok(rows.every((r) => r.customer === 'alpha' && r.template === 'owner_booking'))
  assert.equal(rows[0].subject, 'New booking: Casey Customer, Tuesday, November 17 at 9:00 AM EST')
  assert.match(rows[0].body, /Casey Customer booked alpha Pools for Tuesday, November 17 at 9:00 AM EST/)
  assert.match(rows[0].body, /Phone: 555-010-0100\nEmail: casey@example\.net/)
  assert.match(rows[0].body, /https:\/\/getshowups\.example\/dashboard\/appointments/)
  // Idempotent: later runs queue nothing more.
  assert.deepEqual(await queueOwnerNotices(env, NOW + 5 * MIN), { queued: 0, held: 0 })
  assert.equal(outbox().length, 2)
})

test('an unbooked qualified lead is noticed only after the grace period; booked, unqualified and stale leads are not', async () => {
  lead('NEW', 'alpha', NOW - 5 * MIN)
  lead('BOOKED', 'alpha', NOW - 30 * MIN, 'booked'); appt('A2', 'alpha', 'BOOKED', NOW - WINDOW_MS - MIN)
  lead('UNQ', 'alpha', NOW - 30 * MIN, 'unqualified')
  lead('OLD', 'alpha', NOW - WINDOW_MS - MIN)
  assert.equal((await queueOwnerNotices(env, NOW)).queued, 0, 'within grace: give them time to book')
  const later = NOW + LEAD_GRACE_MS
  assert.equal((await queueOwnerNotices(env, later)).queued, 2)
  const rows = outbox()
  assert.ok(rows.every((r) => r.template === 'owner_lead' && r.id.startsWith('owner_lead:NEW:')))
  assert.equal(rows[0].subject, "New lead: Casey Customer hasn't picked a time yet")
  assert.match(rows[0].body, /asked alpha Pools about: Weekly pool cleaning/)
  // A lead with a cancelled appointment counts as unbooked again; an old booking (outside the window) never notifies.
  assert.ok(!rows.some((r) => r.template === 'owner_booking'))
})

test('cancelled bookings and suspended businesses send nothing; names cannot inject header lines', async () => {
  lead('L1', 'alpha', NOW - 3 * MIN, 'booked', 'Eve\r\nBcc: x@evil.example'); appt('A1', 'alpha', 'L1', NOW - 2 * MIN, 'cancelled')
  biz('susp', { status: 'suspended' }); member('o@susp.example', 'susp'); lead('L2', 'susp', NOW - 3 * MIN, 'booked'); appt('A3', 'susp', 'L2', NOW - 2 * MIN)
  lead('L3', 'bravo', NOW - 3 * MIN, 'booked', 'Eve\r\nBcc: x@evil.example'); appt('A4', 'bravo', 'L3', NOW - 2 * MIN)
  assert.deepEqual(await queueOwnerNotices(env, NOW), { queued: 1, held: 0 })
  const [row] = outbox()
  assert.equal(row.to_email, 'boss@bravo.example')
  assert.ok(!/[\r\n]/.test(row.subject))
  assert.match(row.subject, /^New booking: Eve Bcc: x@evil\.example,/)
})

test('launch gate: with messaging not live only test recipients get notices, nothing is queued to send late; test businesses stay test-only', async () => {
  env.MESSAGES_LIVE = 'false'
  lead('L1', 'alpha', NOW - 3 * MIN, 'booked'); appt('A1', 'alpha', 'L1', NOW - 2 * MIN)
  assert.deepEqual(await queueOwnerNotices(env, NOW), { queued: 0, held: 2 })
  assert.equal(outbox().length, 0, 'nothing waits in the outbox')
  env.MESSAGE_TEST_RECIPIENTS = 'tester@getshowups.example,owner@alpha.example'
  assert.deepEqual(await queueOwnerNotices(env, NOW), { queued: 1, held: 1 })
  // Live messaging, but bravo is a test business: its non-test member is held.
  env.MESSAGES_LIVE = 'true'
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('bravo', 1, 'admin', 1)").run()
  lead('L2', 'bravo', NOW - 3 * MIN, 'booked'); appt('A2', 'bravo', 'L2', NOW - 2 * MIN)
  assert.deepEqual(await queueOwnerNotices(env, NOW), { queued: 1, held: 1 }, 'partner@alpha now allowed (not skipped because owner@alpha got one); bravo held')
  assert.ok(!outbox().some((r) => r.customer === 'bravo'))
  // After the window, nothing old is picked up any more (no burst when messaging goes live).
  assert.deepEqual(await queueOwnerNotices(env, NOW + WINDOW_MS + MIN), { queued: 0, held: 0 })
})

test('flush delivers through Resend once and clears the stored lead details', async () => {
  lead('L1', 'alpha', NOW - 3 * MIN, 'booked'); appt('A1', 'alpha', 'L1', NOW - 2 * MIN)
  await queueOwnerNotices(env, NOW)
  const r = await flushOutbox(env, NOW)
  assert.equal(r.sent, 2)
  assert.equal(sent.length, 2)
  assert.ok(sent.every((s) => s.url === 'https://api.resend.com/emails' && /^New booking:/.test(s.body.subject) && /555-010-0100/.test(s.body.text)))
  assert.ok(outbox().every((x) => x.status === 'sent' && x.body === ''), 'body cleared after delivery')
  assert.equal((await flushOutbox(env, NOW + MIN)).sent, 0)
})

test('overlapping cron runs never queue a notice twice; flushes reuse the outbox id as the Resend idempotency key', async () => {
  lead('L1', 'alpha', NOW - 3 * MIN, 'booked'); appt('A1', 'alpha', 'L1', NOW - 2 * MIN)
  const [a, b] = await Promise.all([queueOwnerNotices(env, NOW), queueOwnerNotices(env, NOW)])
  assert.equal(a.queued + b.queued, 2)
  assert.equal(outbox().length, 2)
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), key: init.headers['Idempotency-Key'] }); return new Response('{"id":"re_1"}', { status: 200 }) }
  await Promise.all([flushOutbox(env, NOW), flushOutbox(env, NOW)])
  // Both runs may attempt a pending row; Resend deduplicates on the key (the outbox id), so the owner gets one email.
  const keys = sent.map((s) => s.key)
  assert.ok(keys.every((k) => /^owner_booking:A1:[0-9a-f]{16}$/.test(k)))
  assert.equal(new Set(keys).size, 2)
})
