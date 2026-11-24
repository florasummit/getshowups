// Heartbeat + health, response time + AI cost, booking boundaries (DST, time zones, closed/full days), restore of a
// representative synthetic business into an empty database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beat, heartbeat, STALE_MS } from '../server/heartbeat.js'
import { onRequestGet as health } from '../functions/api/health.js'
import { aiCost, responseTime } from '../server/response-time.js'
import { computeSlots, zonedToUtc } from '../server/calendar.js'

const files = readdirSync(new URL('../migrations/', import.meta.url)).sort()
const migrate = (sql) => files.forEach((f) => sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')))
const fresh = () => {
  const sql = new DatabaseSync(':memory:')
  migrate(sql)
  const stmt = (q, a = []) => ({ bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  return { sql, prepare: (q) => stmt(q) }
}
const biz = (db, id) => db.sql.prepare("INSERT INTO customers (id, name, timezone, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', 1, 1, 1)").run(id, `${id} co`)

test('health: ok after a run, 503 when the job is silent, unknown, the database is gone or configuration is missing; says nothing else', async () => {
  const db = fresh()
  const env = { ONBOARDING_DB: db, GOOGLE_TOKENS: {}, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), CRON_SECRET: 'x'.repeat(40) }
  const get = async (e = env) => {
    const r = await health({ env: e, request: new Request('https://getshowups.com/api/health') })
    return [r.status, await r.json()]
  }
  assert.deepEqual(await get(), [503, { status: 'job_unknown', job: { ageSeconds: null } }])
  await beat(db)
  const [status, body] = await get()
  assert.deepEqual([status, body.status, Object.keys(body)], [200, 'ok', ['status', 'job']])
  await beat(db, Date.now() - STALE_MS - 1000)
  assert.equal((await get())[1].status, 'job_stale')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM rate_limits WHERE key = 'heartbeat:cron'").get().n, 1)
  assert.deepEqual(await get({ ...env, CRON_SECRET: '' }), [503, { status: 'misconfigured' }])
  db.sql.exec('DROP TABLE rate_limits')
  assert.deepEqual(await get(), [503, { status: 'database' }])
  await assert.rejects(heartbeat(db))
})

test('response time: first message sent or booking; failed sends, notes, test records and other businesses never count; few = no median', async () => {
  const db = fresh()
  for (const id of ['a', 'b']) biz(db, id)
  const now = Date.now()
  let n = 0
  const lead = (c, { sent = null, status = 'sent', channel = 'email', booked = null, test = false } = {}) => {
    const id = `l${++n}`
    const at = now - 5 * 864e5
    db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'N', 'x@y.example', '1', 'x', '29401', 'new', 'x', ?, 1)").run(id, c, at)
    if (sent != null) db.sql.prepare("INSERT INTO thread_messages (id, customer, lead_id, direction, channel, author, body, status, created_at, updated_at) VALUES (?, ?, ?, 'out', ?, 'owner', 'x', ?, ?, 1)").run(`m${id}`, c, id, channel, status, at + sent * 60_000)
    if (booked != null) db.sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, 2, 'booked', 'e', ?, 1)").run(`p${id}`, c, id, n * 1000, at + booked * 60_000)
    if (test) db.sql.prepare("INSERT INTO test_marks (lead_id, customer, is_test, marked_by, marked_at) VALUES (?, ?, 1, 'o', 1)").run(id, c)
  }
  lead('a', { sent: 10 }); lead('a', { booked: 2 }); lead('a', { sent: 50, booked: 30 }); lead('a', { sent: 5, status: 'failed' }); lead('a', { sent: 1, channel: 'note' }); lead('a', { sent: 1, test: true }); lead('b', { sent: 9999 })
  assert.deepEqual(await responseTime(db, 'a', { now }), { inquiries: 5, handled: 3, noneRecorded: 2, medianMinutes: null, slowestMinutes: null, min: 5 })
  lead('a', { sent: 100 }); lead('a', { sent: 200 })
  const r = await responseTime(db, 'a', { now })
  assert.deepEqual([r.handled, r.medianMinutes, r.slowestMinutes], [5, 30, 200])
  assert.equal((await responseTime(db, 'a', { now, days: 1 })).inquiries, 0)
  db.sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES ('e1', 'ai_ask', 'a', ?, '{\"costMicros\":500}'), ('e2', 'ai_ask', 'b', ?, '{\"costMicros\":900}')").run(now, now)
  assert.deepEqual(await aiCost(db, 'a', { now }), { assistantQuestions: 1, assistantMicros: 500, conversations: 0, receptionistMicros: 0 })
})

test('slots: daylight saving keeps local hours, other time zones, closed, finished and fully booked days', () => {
  const R = { timezone: 'America/New_York', slotMinutes: 60, dayStart: '09:00', dayEnd: '17:00', workdays: [0, 1, 2, 3, 4, 5, 6] }
  const local = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ms)
  for (const start of ['2026-10-31T10:00:00Z', '2027-03-13T10:00:00Z']) {
    const { slots } = computeSlots({ busy: [], rules: R, now: Date.parse(start), days: 3 })
    assert.equal(slots.length, 24, start)
    assert.deepEqual([...new Set(slots.map((s) => local(s.start, R.timezone)))].sort(), ['09', '10', '11', '12', '13', '14', '15', '16'])
  }
  // A window across the change itself: the repeated or missing hour neither duplicates nor overlaps a slot.
  for (const d of ['2026-11-01T04:00:00Z', '2027-03-14T05:00:00Z']) {
    const { slots } = computeSlots({ busy: [], rules: { ...R, dayStart: '00:00', dayEnd: '06:00' }, now: Date.parse(d), days: 1 })
    for (let i = 1; i < slots.length; i++) assert.ok(slots[i].start >= slots[i - 1].end)
    assert.equal(slots.at(-1).end, zonedToUtc(...(d.startsWith('2026') ? [2026, 11, 1] : [2027, 3, 14]), 6, 0, R.timezone))
  }
  assert.equal(computeSlots({ busy: [], rules: { ...R, timezone: 'Pacific/Honolulu' }, now: Date.parse('2026-12-07T08:00:00Z'), days: 1 }).slots.length, 0, 'Sunday evening there: closed for the day')
  const monday = Date.parse('2026-12-07T13:00:00Z')
  assert.equal(computeSlots({ busy: [], rules: { ...R, workdays: [2] }, now: monday, days: 1 }).slots.length, 0)
  assert.equal(computeSlots({ busy: [], rules: R, now: Date.parse('2026-12-07T22:30:00Z'), days: 1 }).slots.length, 0)
  assert.equal(computeSlots({ busy: [{ start: monday, end: monday + 864e5 }], rules: R, now: monday, days: 1 }).slots.length, 0)
  assert.equal(computeSlots({ busy: [], rules: R, now: Date.parse('2026-12-07T19:00:00Z'), days: 1 }).slots.length, 3, 'same day: only what is left')
})

test('recovery: a synthetic business exported as SQL and loaded into an empty database is identical, and migrations re-apply over it', () => {
  const a = new DatabaseSync(':memory:')
  migrate(a)
  a.exec("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('syn', 'Sýn ''Pools'' \n2', 'America/New_York', 1, 1)")
  a.exec("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES ('l1', 'syn', 'Sam', 's@y.example', '1', 'Green; pool -- x', '29401', 'booked', 'x', 1, 1)")
  a.exec("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES ('p1', 'syn', 'l1', 10, 20, 'showed', 'e', 1, 1)")
  a.exec("INSERT INTO revenue_entries (customer, appointment_id, kind, amount_cents, recorded_by, recorded_at) VALUES ('syn', 'p1', 'paid', 20000, 'ref:x', 1)")
  const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
  const objs = a.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC").all()
  const rows = (d, t) => d.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()
  let dump = 'PRAGMA foreign_keys = OFF;'
  for (const o of objs.filter((x) => x.type === 'table')) dump += `${o.sql};${rows(a, o.name).map((r) => `INSERT INTO "${o.name}" VALUES (${Object.values(r).map(q).join(',')});`).join('')}`
  for (const o of objs.filter((x) => x.type !== 'table')) dump += `${o.sql};`
  const b = new DatabaseSync(':memory:')
  b.exec(dump)
  for (const t of ['customers', 'leads', 'appointments', 'revenue_entries']) assert.deepEqual(rows(b, t), rows(a, t), t)
  assert.equal(b.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(b.prepare('PRAGMA foreign_key_check').all(), [])
  migrate(b)
  assert.deepEqual(rows(b, 'appointments'), rows(a, 'appointments'))
})
