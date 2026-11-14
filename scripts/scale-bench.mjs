// Reproducible scalability benchmark: seeds N synthetic businesses (deterministic) into the real schema on node:sqlite,
// then measures wall time and database round trips (each first/all/run = one D1 request in production) for the admin
// views, Business Review and the cron jobs. Nothing external is called (outside APIs are stubbed to fail fast).
//   node --no-warnings scripts/scale-bench.mjs 10 100 1000
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const sizes = process.argv.slice(2).map(Number).filter(Boolean)
const DAY = 86400000

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').sort()) sql.exec(readFileSync(`migrations/${f}`, 'utf8'))
  const counter = { n: 0 }
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => (counter.n++, sql.prepare(q).get(...args) ?? null),
    all: async () => (counter.n++, { results: sql.prepare(q).all(...args) }),
    run: async () => (counter.n++, { meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, counter, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => (counter.n++, sql.prepare(s.q).run(...s.args))) }
}
function kv() {
  const m = new Map()
  const counter = { n: 0 }
  return {
    m,
    counter,
    get: async (k) => (counter.n++, m.get(k) ?? null),
    put: async (k, v) => void (counter.n++, m.set(k, v)),
    delete: async (k) => void (counter.n++, m.delete(k)),
    list: async ({ prefix = '' } = {}) => (counter.n++, { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).slice(0, 1000).map((name) => ({ name })), list_complete: true }),
  }
}

async function seed(db, store, n, now) {
  const q = (s) => db.sql.prepare(s)
  const ins = {
    c: q("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, status, created_at, updated_at) VALUES (?, ?, 'UTC', '29401', '09:00', '17:00', '1,2,3,4,5', ?, ?, ?, ?)"),
    u: q('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)'),
    s: q("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, last_event_at, updated_at) VALUES (?, ?, ?, 'founding', ?, 49900, 'usd', ?, ?, ?)"),
    ss: q("INSERT INTO self_signups (customer, plan_id, created_at, onboarded_at) VALUES (?, 'founding', ?, ?)"),
    l: q("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?, ?, 'Synthetic Lead', ?, '555-010-0000', 'x', '29401', 'booked', 'h', ?, ?)"),
    a: q("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'ev', ?, ?)"),
    w: q("INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?, '{}', 1, ?, ?)"),
    camp: q("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, platform_campaign_id, created_at, updated_at) VALUES (?, ?, 'google', ?, '{}', 2500, '1', ?, ?)"),
    ev: q("INSERT INTO events (id, type, customer, at, props) VALUES (?, ?, ?, ?, '{}')"),
  }
  db.sql.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    const id = `biz-${String(i).padStart(5, '0')}`
    // Deterministic mix: 80% active, 8% past_due, 8% canceled (half past the 90-day window), 4% suspended.
    const kind = i % 25 === 0 ? 'suspended' : i % 12 === 1 ? 'past_due' : i % 12 === 2 ? 'canceled' : 'active'
    ins.c.run(id, `Business ${i}`, now - 200 * DAY, kind === 'suspended' ? 'suspended' : 'active', now - 200 * DAY, now)
    ins.u.run(`owner${i}@synthetic.example`, id, now)
    ins.ss.run(id, now - 200 * DAY, now - 199 * DAY)
    const periodEnd = kind === 'canceled' ? now - (i % 24 === 2 ? 120 : 20) * DAY : now + 20 * DAY
    ins.s.run(id, `cus_${i}`, `sub_${i}`, kind === 'canceled' ? 'canceled' : kind === 'past_due' ? 'past_due' : 'active', periodEnd, now - DAY, now)
    ins.w.run(id, now - 10 * DAY, now)
    for (let j = 0; j < 20; j++) {
      const lid = `l${i}x${j}`
      ins.l.run(lid, id, `lead${i}x${j}@synthetic.example`, now - (j + 1) * DAY, now)
      if (j < 10) ins.a.run(`a${i}x${j}`, id, lid, now - j * DAY, now - j * DAY + 3600000, j % 3 === 0 ? 'no_show' : 'showed', now - j * DAY, now)
    }
    // Ads: 1 in 5 advertise; those on hold keep a campaign "active" that we can't reach (no stored Ads token).
    if (i % 5 === 0) for (let k = 0; k < 2; k++) ins.camp.run(`cmp_${i}_${k}`, id, k === 0 && kind !== 'active' ? 'active' : 'paused', now - 30 * DAY, now)
    ins.ev.run(`setup:${id}`, 'setup_completed', id, now - 199 * DAY)
    await store.put(`google:${id}`, JSON.stringify({ customer: id }))
  }
  db.sql.exec('COMMIT')
}

async function measure(label, db, store, fn) {
  const q0 = db.counter.n
  const k0 = store.counter.n
  const t0 = performance.now()
  const r = await fn()
  return { label, ms: Math.round(performance.now() - t0), d1: db.counter.n - q0, kv: store.counter.n - k0, r }
}

const origFetch = globalThis.fetch
globalThis.fetch = async () => new Response('{}', { status: 503 }) // no outside calls
console.error = () => {}

const { recordEvent, verifyAuditChain, auditCheckpoint } = await import('../server/auditlog.js')
const { customerRows } = await import('../server/metrics.js')
const { platformReview, businessReview } = await import('../server/ops/review.js')
const { enforceAdsHolds } = await import('../server/ads/holds.js')
const { processRecoveryExpiries } = await import('../server/lifecycle.js')
const { requestDeletion } = await import('../server/deletion.js')

const out = []
for (const n of sizes) {
  const db = d1()
  const store = kv()
  const now = Date.now()
  const env = { ONBOARDING_DB: db, GOOGLE_TOKENS: store, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', ADS_ENABLED: 'true', GOOGLE_CLIENT_ID: 'cid', TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), PLATFORM_ADMIN_EMAILS: 'a@b.co' }
  await seed(db, store, n, now)
  // ~25 standard events per business (pauses, billing, website…), some failures.
  const evs = n * 25
  const tEv = performance.now()
  for (let i = 0; i < evs; i++) {
    const b = i % n
    await recordEvent(db, { type: 'synthetic.event', actor: 'system:bench', customer: `biz-${String(b).padStart(5, '0')}`, capability: i % 7 === 0 ? 'ads.google' : 'billing.stripe', resource: { type: 'thing', id: `t${i % (n * 3)}` }, outcome: i % 50 === 0 ? 'failure' : 'success', at: now - (evs - i) * 1000 })
  }
  const evMs = performance.now() - tEv
  const rows = await measure('customerRows (admin overview list)', db, store, () => customerRows(env, now))
  const chain = await measure(`verifyAuditChain (${evs} entries)`, db, store, () => verifyAuditChain(db))
  const prCold = await measure('platformReview (no checkpoint yet: full chain)', db, store, () => platformReview(env, now))
  const cp = await measure('auditCheckpoint (daily cron, full chain)', db, store, () => auditCheckpoint(db, now))
  for (let i = 0; i < 50; i++) await recordEvent(db, { type: 'synthetic.after', actor: 'system:bench', capability: 'billing.stripe', outcome: 'success', at: now + i })
  const pr = await measure('platformReview (after checkpoint: incremental)', db, store, () => platformReview(env, now))
  const br = await measure('businessReview (one business)', db, store, () => businessReview(env, 'biz-00007', now))
  const holds = await measure('enforceAdsHolds (one cron run)', db, store, () => enforceAdsHolds(env, { now }))
  const holds2 = await measure('enforceAdsHolds (next run)', db, store, () => enforceAdsHolds(env, { now: now + 300000 }))
  const rec1 = await measure('processRecoveryExpiries (run 1)', db, store, () => processRecoveryExpiries(env, { now }))
  const rec2 = await measure('processRecoveryExpiries (run 2)', db, store, () => processRecoveryExpiries(env, { now: now + 300000 }))
  // One full account deletion (20 leads, 10 appointments, website, campaigns, audit events), billing skipped (no Stripe id).
  db.sql.prepare("UPDATE subscriptions SET stripe_subscription_id = NULL, stripe_customer_id = NULL WHERE customer = 'biz-00005'").run()
  env.ACCOUNT_DELETION_ENABLED = 'true'
  const del = await measure('requestDeletion (one business, all steps)', db, store, () => requestDeletion(env, 'biz-00005', { type: 'admin', id: 'a@b.co' }, now))
  delete env.ACCOUNT_DELETION_ENABLED
  // 50 simultaneous audit writers (e.g. a burst of webhooks): all written, chain intact.
  const before = db.sql.prepare('SELECT count(*) n FROM audit_log').get().n
  const burst = await measure('50 concurrent audit appends', db, store, () => Promise.all(Array.from({ length: 50 }, (_, i) => recordEvent(db, { type: 'synthetic.burst', actor: 'system:bench', outcome: 'success', details: { i } }))))
  const burstOk = burst.r.every((x) => x.ok) && db.sql.prepare('SELECT count(*) n FROM audit_log').get().n === before + 50
  const chainAfter = (await verifyAuditChain(db, { fromSeq: before + 1 })).ok
  const expiredTotal = db.sql.prepare("SELECT count(*) n FROM subscriptions WHERE status = 'canceled' AND current_period_end <= ?").get(now - 90 * DAY).n
  const heldActive = db.sql.prepare("SELECT count(DISTINCT customer) n FROM ad_campaigns WHERE status = 'active'").get().n
  out.push({ n, evs, evAppendMsPer: +(evMs / evs).toFixed(3), results: [rows, chain, prCold, cp, pr, br, holds, holds2, rec1, rec2, del, burst], delStatus: del.r.status, burstOk, chainAfter, expiredTotal, heldActive, holdsChecked: [holds.r.checked, holds2.r.checked], recExpired: [rec1.r.expired, rec2.r.expired], businessKeys: Object.keys(br.r || {}).length, isolation: (br.r?.events || []).every((e) => e.customer === 'biz-00007') })
}
globalThis.fetch = origFetch
for (const o of out) {
  console.log(`\n=== ${o.n} businesses · ${o.evs} audit entries (append ${o.evAppendMsPer} ms each) ===`)
  for (const m of o.results) console.log(`${m.label.padEnd(48)} ${String(m.ms).padStart(7)} ms  ${String(m.d1).padStart(6)} D1 queries  ${String(m.kv).padStart(5)} KV ops`)
  console.log(`held businesses with a running campaign: ${o.heldActive}; checked per hold run: ${o.holdsChecked.join(' → ')}`)
  console.log(`expired recovery windows: ${o.expiredTotal}; newly recorded per run: ${o.recExpired.join(' → ')}`)
  console.log(`business view tenant-isolated: ${o.isolation}; deletion status: ${o.delStatus}; burst written+chained: ${o.burstOk && o.chainAfter}`)
}
