// Business Review (server/ops/*, /api/platform/review): capability registry, generic status engine, a newly
// registered capability appearing with its status/dependencies/events/incidents without changes to the engine or UI,
// business view (counts only, tenant isolation), change history, and the conversation control lock (one automation
// per conversation). Real handlers + migrations on node:sqlite; nothing external.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { recordEvent } from '../server/auditlog.js'
import { registerCapability, unregisterCapability, listCapabilities } from '../server/ops/registry.js'
import { platformReview, businessReview } from '../server/ops/review.js'
import { recordChanges, migrationStatus } from '../server/ops/changes.js'
import { acquireControl, releaseControl, currentController } from '../server/conversations/control.js'
import { validateAction, listConversationProviders } from '../server/conversations/providers.js'
import * as route from '../functions/api/platform/review.js'
import { safeNext } from '../server/auth.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86400000
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
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
const kvStore = () => {
  const m = new Map()
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) }
}
let env, db, origError, logs
beforeEach(() => {
  db = d1()
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.join(' '))
  env = {
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: kvStore(),
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/x`,
    TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    ADMIN_API_TOKEN: 'a'.repeat(40),
    PLATFORM_ADMIN_EMAILS: 'founder@getshowups.example',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    ADS_ENABLED: 'true',
  }
  const now = Date.now()
  for (const id of ['alpha', 'beta']) {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1', ?, ?, ?)").run(id, `${id} Pools`, now, now, now)
    db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, now)
  }
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES ('leadA001', 'alpha', 'Lee Secret', 'lee.secret@example.net', '843-555-0100', 'x', '29401', 'booked', 'h', ?, ?)").run(now - DAY, now)
  db.sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES ('apA1', 'alpha', 'leadA001', ?, ?, 'showed', 'ev1', ?, ?)").run(now - DAY, now - DAY + 3600000, now - DAY, now)
  db.sql.prepare("INSERT INTO lead_attribution (lead_id, customer, source, created_at) VALUES ('leadA001', 'alpha', 'google_ads', ?)").run(now - DAY)
})
afterEach(() => {
  console.error = origError
})
async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
const get = async (path, c) => {
  const res = await route.onRequestGet({ request: new Request(ORIGIN + path, { headers: c ? { Cookie: c } : {} }), env })
  return { status: res.status, json: await res.json() }
}

test('registry: refuses malformed capabilities (id, name, journey step, state function)', () => {
  assert.throws(() => registerCapability({ id: 'Bad Id', name: 'x', journey: 'lead', state: () => ({}) }), /bad id/)
  assert.throws(() => registerCapability({ id: 'x.y', journey: 'lead', state: () => ({}) }), /name required/)
  assert.throws(() => registerCapability({ id: 'x.y', name: 'x', journey: 'nowhere', state: () => ({}) }), /unknown journey/)
  assert.throws(() => registerCapability({ id: 'x.y', name: 'x', journey: 'lead' }), /state/)
})

test('platform view: statuses come from configuration + real activity (evidence), never from labels', async () => {
  const r = await platformReview(env)
  const cap = (id) => r.capabilities.find((c) => c.id === id)
  assert.equal(cap('billing.stripe').status, 'sandbox', 'Stripe test key')
  assert.match(cap('billing.stripe').approval, /STRIPE_LIVE_ENABLED/)
  assert.equal(cap('ads.google').status, 'sandbox')
  assert.ok(cap('ads.google').blockers.length >= 1)
  assert.equal(cap('account.deletion').status, 'disabled')
  assert.equal(cap('lead.qualify').status, 'missing')
  assert.equal(cap('calendar.google').status, 'live_verified', 'a real booking on Google Calendar yesterday')
  assert.match(cap('calendar.google').verification.evidence, /Last booking placed on Google Calendar/)
  assert.equal(cap('website.hosting').status, 'built_tested', 'live but nothing published yet → not verified')
  assert.equal(cap('messaging.email').status, 'disabled', 'Resend not configured here')
  // Dependencies resolved both ways; a dependency that is off is flagged.
  assert.ok(cap('platform.database').usedBy.includes('lead.capture'))
  assert.ok(cap('account.retention').blockedBy.includes('account.deletion'))
  // Journey order and every capability placed.
  assert.deepEqual(r.journey.slice(0, 9).map((j) => j.id), ['signup', 'billing', 'onboarding', 'website', 'advertising', 'lead', 'booking', 'showup', 'results'])
  assert.equal(r.journey.flatMap((j) => j.capabilities).length, r.capabilities.length)
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.capabilities.length)
  assert.ok(r.approvals.some((a) => a.capability === 'ads.google'))
  assert.ok(!JSON.stringify(r).includes('lee.secret') && !JSON.stringify(r).includes('Lee Secret'), 'no lead personal data')
})

test('PHASE 4: a newly registered capability appears with status, dependencies, events and incidents — no engine/UI change', async () => {
  const id = 'example.widget'
  registerCapability({
    id,
    name: 'Example widget sender',
    journey: 'booking',
    description: 'Sends widgets.',
    dependsOn: ['platform.database', 'example.missing_dep'],
    external: 'Widget Co',
    state: () => ({ mode: 'live', note: 'Example' }),
    verify: async () => ({ ok: true, at: Date.now(), evidence: 'Last widget sent just now' }),
    business: async (_env, customer) => ({ status: customer === 'alpha' ? 'attention' : 'ok', summary: customer === 'alpha' ? 'Widget failed' : 'Fine' }),
  })
  try {
    // A failure event, then the review shows it as an open incident.
    await recordEvent(db, { type: 'widget.send', actor: 'system:widgets', customer: 'alpha', capability: id, resource: { type: 'widget', id: 'w1' }, outcome: 'failure', correlationId: 'c1', details: { error: 'widget_down' } })
    let r = await platformReview(env)
    const c = r.capabilities.find((x) => x.id === id)
    assert.equal(c.status, 'live_verified')
    assert.deepEqual([c.name, c.external, c.description], ['Example widget sender', 'Widget Co', 'Sends widgets.'])
    assert.deepEqual(c.blockedBy, ['example.missing_dep'], 'undeclared dependency flagged')
    assert.equal(c.events.failures7, 1)
    assert.deepEqual(c.openFailures.map((f) => f.details.error), ['widget_down'])
    assert.ok(r.journey.find((j) => j.id === 'booking').capabilities.includes(id))
    assert.ok(r.incidents.some((i) => i.capability === id && i.kind === 'failure' && i.customer === 'alpha'))
    // Business view picks up its per-business status and events.
    const b = await businessReview(env, 'alpha')
    assert.deepEqual(b.capabilities.find((x) => x.id === id), { id, name: 'Example widget sender', journey: 'booking', status: 'attention', summary: 'Widget failed' })
    assert.ok(b.events.some((e) => e.capability === id && e.outcome === 'failure'))
    assert.ok(b.openFailures.some((f) => f.capability === id))
    // The retry succeeds for the same resource → the incident closes by itself.
    await recordEvent(db, { type: 'widget.send', actor: 'system:widgets', customer: 'alpha', capability: id, resource: { type: 'widget', id: 'w1' }, outcome: 'success', correlationId: 'c1' })
    r = await platformReview(env)
    assert.equal(r.capabilities.find((x) => x.id === id).openFailures.length, 0)
    assert.ok(!r.incidents.some((i) => i.capability === id && i.kind === 'failure'))
  } finally {
    unregisterCapability(id)
  }
  assert.ok(!listCapabilities().some((c) => c.id === id))
})

test('a failing check never breaks the review: that capability shows "unknown"/unverified, the rest still render', async () => {
  registerCapability({ id: 'example.broken', name: 'Broken', journey: 'platform', state: () => { throw new Error('boom') }, verify: async () => { throw new Error('boom') } })
  try {
    const r = await platformReview(env)
    const c = r.capabilities.find((x) => x.id === 'example.broken')
    assert.equal(c.status, 'unknown')
    assert.deepEqual(c.verification, { ok: false, at: null, evidence: 'Check failed or timed out' })
    assert.ok(r.capabilities.length > 20)
  } finally {
    unregisterCapability('example.broken')
  }
})

test('business view: counts only (no lead names/emails/phones), tenant-isolated, 404 for unknown; route admin-only', async () => {
  await recordEvent(db, { type: 'ads.pause', actor: 'system:hold', customer: 'beta', capability: 'ads.google', resource: { type: 'campaign', id: 'cmp_b' }, outcome: 'failure' })
  const c = await cookie('founder@getshowups.example')
  const a = await get('/api/platform/review?business=alpha', c)
  assert.equal(a.status, 200)
  assert.deepEqual([a.json.funnel.leads, a.json.funnel.booked, a.json.funnel.showed], [1, 1, 1])
  assert.deepEqual(a.json.attribution, [{ source: 'google_ads', n: 1 }])
  const text = JSON.stringify(a.json)
  for (const s of ['Lee Secret', 'lee.secret', '843-555', 'owner@alpha']) assert.ok(!text.includes(s), `no ${s}`)
  assert.equal(a.json.events.filter((e) => e.customer !== 'alpha').length, 0, 'only its own events')
  assert.equal(a.json.openFailures.length, 0, "beta's failure is not alpha's")
  assert.equal((await get('/api/platform/review?business=beta', c)).json.openFailures.length, 1)
  assert.equal((await get('/api/platform/review?business=nobody', c)).status, 404)
  assert.equal((await get('/api/platform/review?business=../x', c)).status, 400)
  assert.equal((await get('/api/platform/review', await cookie('owner@alpha.example'))).status, 403)
  assert.equal((await get('/api/platform/review')).status, 401)
  assert.equal(route.onRequestPost, undefined, 'read-only')
  const p = await get('/api/platform/review', c)
  assert.equal(p.status, 200)
  assert.ok(!JSON.stringify(p.json).includes('owner@alpha'), 'no owner emails in the platform view')
})

test('change history: a new release and a changed switch are recorded once; pending migrations detected', async () => {
  const build = { commit: 'a'.repeat(40), builtAt: '2026-11-14T00:00:00Z', migrations: [{ file: '0001_x.sql', tables: ['customers'] }, { file: '0099_future.sql', tables: ['not_there'] }] }
  env.ASSETS = { fetch: async () => new Response(JSON.stringify(build)) }
  assert.deepEqual(await recordChanges(env), { release: true, config: true })
  assert.deepEqual(await recordChanges(env), { release: false, config: false }, 'nothing changed → nothing recorded')
  env.ADS_LIVE_LAUNCH = 'true'
  assert.deepEqual(await recordChanges(env), { release: false, config: true })
  build.commit = 'b'.repeat(40)
  assert.deepEqual(await recordChanges(env), { release: true, config: false })
  const rel = db.sql.prepare("SELECT details FROM audit_log WHERE action = 'platform.release' ORDER BY seq DESC").get()
  assert.deepEqual(JSON.parse(rel.details).pendingMigrations, ['0099_future.sql'])
  assert.deepEqual(await migrationStatus(env, build), [{ file: '0001_x.sql', applied: true, missing: [] }, { file: '0099_future.sql', applied: false, missing: ['not_there'] }])
  const r = await platformReview(env)
  assert.ok(r.incidents.some((i) => i.kind === 'migration' && i.title.includes('0099_future.sql')))
  assert.equal(r.release.history.length, 4)
  const cfg = JSON.parse(db.sql.prepare("SELECT details FROM audit_log WHERE action = 'platform.config' ORDER BY seq DESC").get().details)
  assert.equal(cfg.switches.ADS_LIVE_LAUNCH, true)
  assert.equal(cfg.stripeMode, 'test_key')
  assert.ok(!JSON.stringify(cfg).includes('sk_test_fake'), 'never secret values')
})

test('conversation control: one automation at a time; a person always wins; leases expire; tenant-scoped; audited', async () => {
  const t = Date.now()
  const base = { customer: 'alpha', conversationId: 'leadA001' }
  assert.equal((await acquireControl(db, { ...base, controller: 'provider:claude', leaseMs: 60000, now: t })).ok, true)
  assert.deepEqual(await acquireControl(db, { ...base, controller: 'provider:ghl', now: t + 1000 }), { ok: false, error: 'controlled_by_other', controller: 'provider:claude' })
  assert.equal((await acquireControl(db, { ...base, controller: 'provider:claude', now: t + 2000 })).ok, true, 'renewing its own lease')
  // Same conversation id in another business: independent.
  assert.equal((await acquireControl(db, { customer: 'beta', conversationId: 'leadA001', controller: 'provider:ghl', now: t })).ok, true)
  // A person takes over at once; no provider can take it back while they hold it.
  assert.equal((await acquireControl(db, { ...base, controller: 'human', now: t + 3000 })).ok, true)
  assert.equal((await acquireControl(db, { ...base, controller: 'provider:claude', now: t + 4000 })).error, 'controlled_by_other')
  assert.equal((await currentController(db, 'alpha', 'leadA001', t + 999999999)).controller, 'human', 'a person never times out')
  assert.equal((await releaseControl(db, { ...base, controller: 'provider:claude' })).error, 'not_controller')
  assert.equal((await releaseControl(db, { ...base, controller: 'human' })).ok, true)
  assert.equal((await acquireControl(db, { ...base, controller: 'provider:ghl', leaseMs: 5000, now: t + 10000 })).ok, true)
  assert.equal((await acquireControl(db, { ...base, controller: 'provider:claude', now: t + 16000 })).ok, true, 'expired lease can be taken')
  assert.equal((await acquireControl(db, { ...base, controller: 'robot' })).error, 'invalid_request')
  const ev = db.sql.prepare("SELECT action, capability, resource_type FROM audit_log WHERE capability = 'conversations.control'").all()
  assert.ok(ev.length >= 5 && ev.every((e) => e.resource_type === 'conversation'))
})

test('conversation providers: planned providers appear as "Not built" capabilities; proposed actions are validated', async () => {
  assert.deepEqual(listConversationProviders().map((p) => [p.id, p.kind, p.built]), [['claude', 'text', false], ['openai', 'text', false], ['voice', 'voice', false], ['ghl', 'crm', false]])
  const r = await platformReview(env)
  for (const id of ['conversations.claude', 'conversations.openai', 'conversations.voice', 'conversations.ghl']) assert.equal(r.capabilities.find((c) => c.id === id).status, 'missing', id)
  assert.equal(r.capabilities.find((c) => c.id === 'conversations.control').status, 'sandbox')
  assert.deepEqual(validateAction({ type: 'reply', text: 'Hi' }), { ok: true })
  assert.equal(validateAction({ type: 'charge_card' }).error, 'unknown_action')
  assert.equal(validateAction({ type: 'book_slot', start: 'tomorrow-ish' }).error, 'invalid_slot')
  assert.equal(validateAction({ type: 'reply', text: 'x'.repeat(1001) }).error, 'invalid_reply')
})

test('sign-in can return to /admin/review (allowlisted); other admin paths still fall back', () => {
  assert.equal(safeNext('/admin/review'), '/admin/review')
  assert.equal(safeNext('/admin/other'), '/dashboard')
  assert.equal(safeNext('/admin/review/../x'), '/dashboard')
})

test('a hanging check is cut off after the timeout; health is a separate axis (failing / quiet / working / no evidence)', async () => {
  registerCapability({ id: 'example.slow', name: 'Slow', journey: 'platform', state: () => ({ mode: 'live' }), verify: () => new Promise(() => {}) })
  registerCapability({ id: 'example.quiet', name: 'Quiet', journey: 'platform', state: () => ({ mode: 'live' }), verify: async () => ({ ok: false, at: Date.now() - 90 * DAY, evidence: 'Last seen long ago' }) })
  try {
    await recordEvent(db, { type: 'x.fail', capability: 'example.quiet', resource: { type: 'x', id: '1' }, outcome: 'failure' })
    const t0 = Date.now()
    const r = await platformReview(env)
    assert.ok(Date.now() - t0 < 8000, 'review returned despite a hanging check')
    const cap = (id) => r.capabilities.find((c) => c.id === id)
    assert.deepEqual([cap('example.slow').status, cap('example.slow').health], ['built_tested', 'unknown'])
    assert.equal(cap('example.quiet').health, 'failing', 'open failure wins')
    assert.equal(cap('calendar.google').health, 'healthy')
    assert.equal(cap('account.deletion').health, 'not_applicable')
    assert.equal(Object.values(r.health).reduce((a, b) => a + b, 0), r.capabilities.length)
  } finally {
    unregisterCapability('example.slow')
    unregisterCapability('example.quiet')
  }
})
