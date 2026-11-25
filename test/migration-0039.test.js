// Migration 0039 (ChatGPT Ads platform): the one reviewed table rebuild. Proves on a database shaped like production
// (every migration before 0039, real-looking rows in every affected table, foreign keys enforced) that it keeps every
// row and column byte for byte, keeps the index and the foreign key, accepts 'openai', still refuses unknown platforms,
// is safe to run twice, and that the rollback script restores the old constraint and refuses while 'openai' rows exist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).sort()
const FILE = '0039_ads_platform_openai.sql'
const read = (u) => readFileSync(new URL(u, import.meta.url), 'utf8')
const UP = read(`../migrations/${FILE}`)
const DOWN = read('../scripts/rollback/0039_ads_platform_openai.down.sql')

function before0039() {
  const sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys = ON')
  for (const f of MIGRATIONS.filter((f) => f < FILE)) sql.exec(read(`../migrations/${f}`))
  return sql
}
function seed(sql) {
  const now = 1_790_000_000_000
  for (const id of ['poolthru-llc', 'bob-electrical']) sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES (?, ?, 'America/New_York', ?, ?)").run(id, id, now, now)
  sql.prepare("INSERT INTO ad_connections (customer, platform, account_id, account_name, currency, extra, status, connected_at, updated_at) VALUES ('poolthru-llc', 'google', '123', 'PoolThru', 'USD', '{\"testAccount\":false}', 'connected', ?, ?)").run(now, now + 1)
  sql.prepare("INSERT INTO ad_connections (customer, platform, account_id, account_name, currency, extra, status, connected_at, updated_at) VALUES ('bob-electrical', 'meta', NULL, NULL, NULL, '{}', 'needs_account', ?, ?)").run(now, now)
  const camp = sql.prepare('INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, platform_ids, approved_by, approved_at, launched_at, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  camp.run('c1', 'poolthru-llc', 'google', 'paused', '{"platform":"google","name":"Repairs"}', 1500, '999', '{"campaignId":"999"}', 'owner@x', now, now, null, now, now)
  camp.run('c2', 'poolthru-llc', 'google', 'draft', '{"platform":"google"}', 1000, null, '{}', null, null, null, 'invalid_spec', now, now)
  camp.run('c3', 'bob-electrical', 'meta', 'removed', '{"platform":"meta"}', 2000, null, '{}', null, null, null, null, now, now)
  const m = sql.prepare('INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
  m.run('c1', 'poolthru-llc', '2026-11-20', 1234, 400, 12, 1.5, now)
  m.run('c1', 'poolthru-llc', '2026-11-21', 0, 0, 0, 0, now)
}
const dump = (sql) => ({
  connections: sql.prepare('SELECT * FROM ad_connections ORDER BY customer, platform').all(),
  campaigns: sql.prepare('SELECT * FROM ad_campaigns ORDER BY id').all(),
  metrics: sql.prepare('SELECT * FROM ad_metrics_daily ORDER BY campaign_id, date').all(),
})
const cols = (sql, t) => sql.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])
const insertOpenAi = (sql) => {
  sql.prepare("INSERT INTO ad_connections (customer, platform, account_id, extra, status, connected_at, updated_at) VALUES ('poolthru-llc', 'openai', 'acct_1', '{}', 'connected', 1, 1)").run()
  sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('o1', 'poolthru-llc', 'openai', 'draft', '{}', 1000, 1, 1)").run()
}

test('0039 keeps every row, column, index and foreign key, and accepts openai', () => {
  const sql = before0039()
  seed(sql)
  const rows = dump(sql)
  const shape = ['ad_connections', 'ad_campaigns', 'ad_metrics_daily'].map((t) => cols(sql, t))
  sql.exec(UP)
  assert.deepEqual(dump(sql), rows, 'every row unchanged')
  assert.deepEqual(['ad_connections', 'ad_campaigns', 'ad_metrics_daily'].map((t) => cols(sql, t)), shape, 'same columns, types, defaults, keys')
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), [])
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_list(ad_metrics_daily)').all().map((f) => [f.table, f.from, f.to]).sort(), [['ad_campaigns', 'campaign_id', 'id'], ['customers', 'customer', 'id']])
  assert.ok(sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ad_campaigns_customer'").get())
  assert.equal(sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%_0039'").get().n, 0, 'no leftover tables')
  insertOpenAi(sql)
  assert.throws(() => sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at) VALUES ('x', 'poolthru-llc', 'tiktok', 'draft', '{}', 1, 1, 1)").run(), /CHECK/)
  assert.throws(() => sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, fetched_at) VALUES ('nope', 'poolthru-llc', '2026-11-22', 1)").run(), /FOREIGN KEY/, 'the foreign key is still enforced')
})

test('0039 is safe to run twice (every test file and release run applies all migrations again)', () => {
  const sql = before0039()
  seed(sql)
  sql.exec(UP)
  insertOpenAi(sql)
  const rows = dump(sql)
  sql.exec(UP)
  assert.deepEqual(dump(sql), rows)
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), [])
})

test('rollback refuses while openai rows exist, and otherwise restores the google/meta constraint with every row', () => {
  const sql = before0039()
  seed(sql)
  const rows = dump(sql)
  sql.exec(UP)
  insertOpenAi(sql)
  sql.exec('BEGIN')
  assert.throws(() => sql.exec(DOWN), /CHECK/)
  sql.exec('ROLLBACK')
  assert.equal(sql.prepare("SELECT count(*) AS n FROM ad_campaigns WHERE platform = 'openai'").get().n, 1, 'nothing changed')
  sql.exec("DELETE FROM ad_campaigns WHERE platform = 'openai'; DELETE FROM ad_connections WHERE platform = 'openai'")
  sql.exec(DOWN)
  assert.deepEqual(dump(sql), rows)
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), [])
  assert.throws(() => insertOpenAi(sql), /CHECK/)
  assert.equal(sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%_down' OR name LIKE 'rollback_%'").get().n, 0)
})

test('0039 is the only rebuild: its statements touch only the three ad tables', () => {
  const touched = [...UP.replace(/--.*$/gm, '').matchAll(/\b(?:DROP TABLE|ALTER TABLE)\s+(\w+)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(touched)].sort(), ['ad_campaigns', 'ad_campaigns_0039', 'ad_connections', 'ad_connections_0039', 'ad_metrics_daily', 'ad_metrics_daily_0039'])
  assert.doesNotMatch(UP.replace(/--.*$/gm, ''), /\b(DELETE|UPDATE)\b/)
})
