// Founder alerts (server/alerts.js): off by default; calendar / availability / comms incidents from existing records →
// one email per incident to platform admins the launch gate allows; test + deleted businesses never alert; cap + digest;
// no lead personal data in the email.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { founderAlerts, MAX_ALERTS } from '../server/alerts.js'
import { recordAvailability } from '../server/booking.js'
import { flushOutbox } from '../server/email.js'
import { recordEvent } from '../server/auditlog.js'

const MIN = 60 * 1000
const NOW = Date.UTC(2026, 10, 15, 15, 0) // on the hour: the hourly "no calendar" check runs
const OFF_HOUR = NOW + 5 * MIN

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

let db, env, kvKeys, realFetch, sent
const biz = (id, { hours = false } = {}) =>
  db.sql.prepare("INSERT INTO customers (id, name, timezone, status, created_at, updated_at, hours_confirmed_at) VALUES (?, ?, 'America/New_York', 'active', 1, 1, ?)").run(id, `${id} Pools`, hours ? 1 : null)
const lead = (id, customer) =>
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES (?, ?, 'Casey Customer', 'casey@example.net', '555-010-0100', 'Pool', 'booked', 'h', 1, 1)").run(id, customer)
const failedMessage = (id, customer, kind, at) => {
  lead(`L-${id}`, customer)
  db.sql.prepare("INSERT INTO messages (id, customer, lead_id, kind, channel, send_at, status, attempts, error, created_at, updated_at) VALUES (?, ?, ?, ?, 'email', ?, 'failed', 3, 'http_500', ?, ?)").run(id, customer, `L-${id}`, kind, at, at, at)
}
const failLookups = async (customer, error, times) => {
  for (const at of times) await recordAvailability(env, customer, { ok: false, status: error }, at)
}
const outbox = () => db.sql.prepare("SELECT id, to_email, customer, template, subject, body, status FROM email_outbox WHERE template = 'founder_alert' ORDER BY id").all()

beforeEach(() => {
  db = d1()
  kvKeys = []
  env = {
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { list: async () => ({ keys: kvKeys.map((name) => ({ name })), list_complete: true }) },
    GOOGLE_REDIRECT_URI: 'https://getshowups.example/api/google/oauth/callback',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'GetShowUps <hello@getshowups.example>',
    PLATFORM_ADMIN_EMAILS: 'founder@getshowups.example, ops@getshowups.example',
    MESSAGE_TEST_RECIPIENTS: 'founder@getshowups.example',
    FOUNDER_ALERTS_ENABLED: 'true',
  }
  biz('alpha'); biz('bravo')
  sent = []
  realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) }); return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 }) }
})
afterEach(() => { globalThis.fetch = realFetch })

test('off unless FOUNDER_ALERTS_ENABLED is exactly "true": nothing queued', async () => {
  failedMessage('confirmation:email:a1', 'alpha', 'confirmation', NOW - MIN)
  for (const v of [undefined, '', 'TRUE', '1', 'yes']) {
    env.FOUNDER_ALERTS_ENABLED = v
    assert.deepEqual(await founderAlerts(env, NOW), { enabled: false })
  }
  assert.equal(outbox().length, 0)
})

test('availability: 3 failed lookups in 30 min → one alert per incident (not per run); fewer → none; recovery closes it; a new incident alerts again', async () => {
  await failLookups('alpha', 'google_unavailable', [NOW - 20 * MIN, NOW - 14 * MIN])
  assert.equal((await founderAlerts(env, NOW)).queued, 0)
  await failLookups('alpha', 'google_unavailable', [NOW - 2 * MIN])
  const r = await founderAlerts(env, NOW)
  assert.equal(r.queued, 1)
  const rows = outbox()
  assert.equal(rows.length, 1) // only the admin the gate delivers to (MESSAGES_LIVE off)
  assert.equal(rows[0].to_email, 'founder@getshowups.example')
  assert.equal(r.held, 1)
  assert.match(rows[0].subject, /Booking page shows no times .* alpha Pools/)
  assert.match(rows[0].body, /Business: alpha Pools \(alpha\)\nError code: google_unavailable\nFailed booking-page lookups in the last 30 min: 3/)
  assert.match(rows[0].body, /https:\/\/getshowups\.example\/admin\/review/)
  // Later runs while it stays open: nothing new.
  await failLookups('alpha', 'google_unavailable', [OFF_HOUR - MIN])
  assert.equal((await founderAlerts(env, OFF_HOUR)).queued, 0)
  // Recovered, then broken again: a new incident, a new alert.
  await recordAvailability(env, 'alpha', { ok: true }, OFF_HOUR)
  const later = OFF_HOUR + 40 * MIN
  await failLookups('alpha', 'google_unavailable', [later - 15 * MIN, later - 9 * MIN, later - 3 * MIN])
  assert.equal((await founderAlerts(env, later)).queued, 1)
  assert.equal(outbox().length, 2)
})

test('calendar: invalid grant alerts at once; a possibly temporary refresh failure only after 10 min open; hours confirmed with no calendar alerts hourly, once a day', async () => {
  await failLookups('alpha', 'reconnect_required', [NOW - MIN])
  await failLookups('bravo', 'token_refresh_failed', [NOW - 4 * MIN])
  let r = await founderAlerts(env, NOW)
  assert.equal(r.queued, 1)
  assert.match(outbox()[0].id, /^alert:calendar:alpha:/)
  r = await founderAlerts(env, NOW + 7 * MIN)
  assert.equal(r.queued, 1)
  assert.ok(outbox().some((o) => o.id.startsWith('alert:calendar:bravo:')))

  biz('charlie', { hours: true }); biz('delta', { hours: true })
  kvKeys = ['google:delta']
  assert.equal((await founderAlerts(env, OFF_HOUR)).queued, 0) // KV is listed once an hour only
  r = await founderAlerts(env, NOW + 60 * MIN)
  assert.equal(r.queued, 1)
  const c = outbox().find((o) => o.id.startsWith('alert:calendar:charlie:'))
  assert.match(c.body, /Error code: not_connected/)
  assert.equal((await founderAlerts(env, NOW + 120 * MIN)).queued, 0) // once per day
})

test('comms: one failed booking confirmation alerts; two other failures do not; a third does; test-mode refusals never count', async () => {
  failedMessage('reminder_24h:email:b1', 'bravo', 'reminder_24h', NOW - 10 * MIN)
  failedMessage('reminder_2h:email:b2', 'bravo', 'reminder_2h', NOW - 9 * MIN)
  db.sql.prepare("INSERT INTO email_outbox (id, to_email, customer, template, subject, body, status, error, created_at) VALUES ('x1', 'owner@bravo.example', 'bravo', 'owner_booking', 's', 'b', 'failed', 'test_mode', ?)").run(NOW - MIN)
  assert.equal((await founderAlerts(env, NOW)).queued, 0)
  failedMessage('confirmation:email:a1', 'alpha', 'confirmation', NOW - MIN)
  assert.equal((await founderAlerts(env, NOW)).queued, 1)
  db.sql.prepare("INSERT INTO email_outbox (id, to_email, customer, template, subject, body, status, error, attempts, created_at) VALUES ('x2', 'owner@bravo.example', 'bravo', 'owner_booking', 's', 'b', 'failed', 'http_500', 3, ?)").run(NOW - 30 * MIN)
  assert.equal((await founderAlerts(env, NOW + MIN)).queued, 1)
  const b = outbox().find((o) => o.id.startsWith('alert:comms:bravo:'))
  assert.match(b.body, /Failed deliveries in the last hour: 3 \(booking confirmations: 0\)/)
  // Follow-up text failures (audit events) count too.
  biz('echo')
  for (let i = 0; i < 3; i++) await recordEvent(db, { type: 'followups.send_failed', actor: 'system:followups', customer: 'echo', capability: 'followups.sms', resource: { type: 'message', id: `m${i}` }, outcome: 'failure', details: { error: 'http_500' }, at: NOW - i * MIN })
  assert.equal((await founderAlerts(env, NOW + 2 * MIN)).queued, 1)
})

test('test businesses, deleted accounts and an unreadable test list never alert', async () => {
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('alpha', 1, 'admin@getshowups.example', 1)").run()
  db.sql.prepare("INSERT INTO account_deletions (customer, requested_at, requested_by, status, step, next_attempt_at) VALUES ('bravo', 1, 'system', 'in_progress', 'data', 1)").run()
  failedMessage('confirmation:email:a1', 'alpha', 'confirmation', NOW - MIN)
  failedMessage('confirmation:email:b1', 'bravo', 'confirmation', NOW - MIN)
  assert.equal((await founderAlerts(env, NOW)).queued, 0)
  db.sql.exec('DELETE FROM test_businesses; DELETE FROM account_deletions')
  db.sql.exec('ALTER TABLE test_businesses RENAME TO tb_gone')
  assert.equal((await founderAlerts(env, NOW)).queued, 0) // fails closed
  db.sql.exec('ALTER TABLE tb_gone RENAME TO test_businesses')
  assert.equal((await founderAlerts(env, NOW)).queued, 2)
})

test('recipients: platform admins only, and only those the launch gate delivers to now (nothing held to burst later)', async () => {
  failedMessage('confirmation:email:a1', 'alpha', 'confirmation', NOW - MIN)
  env.MESSAGE_TEST_RECIPIENTS = 'tester@getshowups.example' // not an admin
  const r = await founderAlerts(env, NOW)
  assert.equal(r.recipients, 0)
  assert.equal(r.queued, 0)
  assert.equal(outbox().length, 0)
  env.MESSAGES_LIVE = 'true'
  assert.equal((await founderAlerts(env, NOW)).queued, 1)
  assert.deepEqual(outbox().map((o) => o.to_email).sort(), ['founder@getshowups.example', 'ops@getshowups.example'])
})

test('cap: at most MAX_ALERTS new alerts per run, the rest in one digest; the rest alert individually next run', async () => {
  for (let i = 0; i < MAX_ALERTS + 2; i++) {
    biz(`b${i}`)
    failedMessage(`confirmation:email:c${i}`, `b${i}`, 'confirmation', NOW - MIN)
  }
  const r = await founderAlerts(env, NOW)
  assert.equal(r.queued, MAX_ALERTS)
  assert.equal(r.digest, 2)
  const digest = outbox().find((o) => o.id.startsWith('alert:digest:'))
  assert.match(digest.body, /2 more open incident/)
  assert.equal((await founderAlerts(env, NOW + MIN)).queued, 2)
})

test('the email carries codes and counts only (no lead name, email or phone); the flush sends it once with the outbox id as idempotency key', async () => {
  failedMessage('confirmation:email:a1', 'alpha', 'confirmation', NOW - MIN)
  await failLookups('alpha', 'reconnect_required', [NOW - MIN])
  await founderAlerts(env, NOW)
  for (const o of outbox()) assert.doesNotMatch(`${o.subject}\n${o.body}`, /Casey|casey@example\.net|555-010-0100/)
  const out = await flushOutbox(env, NOW)
  assert.equal(out.sent, 2)
  assert.deepEqual(sent.map((s) => s.key).sort(), outbox().map((o) => o.id).sort())
  await founderAlerts(env, NOW + MIN)
  await flushOutbox(env, NOW + MIN)
  assert.equal(sent.length, 2)
  // Each queued alert is recorded as a platform.alerts event (codes only).
  const ev = db.sql.prepare("SELECT action, details FROM audit_log WHERE capability = 'platform.alerts'").all()
  assert.equal(ev.length, 2)
  assert.ok(ev.every((e) => e.action === 'alert.queued' && !/casey|555/i.test(e.details)))
})
