// Commercial attribution, referral partners and the commission ledger (migration 0048; server/commercial-attribution.js,
// server/partners.js, server/commissions.js, server/commercial-report.js): first-touch capture through the real self-serve
// route, self-referral and manipulation refusals, accruals from collected (paid, tax-excluded) revenue through the real
// signed Stripe webhook, refund/dispute reversals, idempotent replays, live vs test mode, the REFERRALS_ENABLED switch,
// ledger immutability and the admin pipeline/partner views (admin-only, test data excluded, no owner contact details).
// node:sqlite D1, Map KV, fetch mocked; nothing external.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { recordAttribution, partnerFromCode, selfReferral, correctAttribution } from '../server/commercial-attribution.js'
import { validateTerms, newCode } from '../server/partners.js'
import { commissionAmount, commissionBasis, withinRecurring, accrueCommission } from '../server/commissions.js'
import { commercialPipeline } from '../server/commercial-report.js'
import { captureReferral, referralCandidates } from '../src/lib/referral.js'
import * as business from '../functions/api/dashboard/business.js'
import * as webhook from '../functions/api/stripe/webhook.js'
import * as partnersRoute from '../functions/api/platform/partners.js'
import * as commercialRoute from '../functions/api/platform/commercial.js'
import * as attributionRoute from '../functions/api/platform/attribution.js'
import * as referralLink from '../functions/r/[code].js'

const ORIGIN = 'https://getshowups.com'
const WHSEC = 'whsec_test_commercial'
const ADMIN = 'founder@getshowups.com'
const DAY = 86_400_000
const MONTH_S = 31 * 86400
let env, db, kv, origFetch, stripeCalls

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => {
      if (a.some((x) => x === undefined)) throw new TypeError('undefined bound') // like D1
      return stmt(q, a)
    },
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN')
      try {
        for (const s of list) sql.prepare(s.q).run(...s.args)
        sql.exec('COMMIT')
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}
async function cookieFor(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, { cookie, body, params, origin = ORIGIN, path = '/x', raw, headers = {} } = {}) {
  const h = { ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST' && origin) h.Origin = origin
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${ORIGIN}${path}`, { method, headers: h, body: raw ?? (body && JSON.stringify(body)) }), env, params })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text || 'null')
  } catch {
    parsed = null
  }
  return { status: res.status, json: parsed, text, headers: res.headers }
}
async function deliver(event, livemode = false) {
  const raw = JSON.stringify({ livemode, created: Math.floor(Date.now() / 1000), ...event })
  const t = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WHSEC), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))), (b) => b.toString(16).padStart(2, '0')).join('')
  return call(webhook, 'POST', { raw, headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, origin: null })
}
let evt = 0
const paid = (customer, invoice, { amount = 49900, tax = 0, live = false, at = Math.floor(Date.now() / 1000), charge = `ch_${invoice}`, pi = `pi_${invoice}`, newApi = false, eventId = `evt_${++evt}` } = {}) =>
  deliver(
    {
      id: eventId,
      type: 'invoice.paid',
      created: at,
      data: { object: { id: invoice, customer: `cus_${customer}`, amount_paid: amount, currency: 'usd', ...(newApi ? { total_taxes: tax ? [{ amount: tax }] : [] } : { tax, charge, payment_intent: pi }), status_transitions: { paid_at: at }, parent: { subscription_details: { metadata: { customer } } } } },
    },
    live,
  )
const refunded = (charge, amount, refundedCents, { live = false, pi = null, invoice = null } = {}) => deliver({ id: `evt_${++evt}`, type: 'charge.refunded', data: { object: { id: charge, amount, amount_refunded: refundedCents, currency: 'usd', payment_intent: pi, ...(invoice ? { invoice } : {}) } } }, live)
const disputed = (id, charge, amount, type = 'charge.dispute.created', live = false) => deliver({ id: `evt_${++evt}`, type, data: { object: { id, charge, payment_intent: null, amount, currency: 'usd' } } }, live)
const ledger = () => db.sql.prepare('SELECT kind, amount_cents AS amount, stripe_object_id AS obj, livemode, customer, partner_id FROM commission_ledger ORDER BY id').all().map((r) => ({ ...r }))
const owed = () => db.sql.prepare('SELECT coalesce(sum(amount_cents), 0) AS n FROM commission_ledger').get().n
const attr = (id) => ({ ...(db.sql.prepare('SELECT * FROM commercial_attribution WHERE customer = ?').get(id) || {}) })
const markTest = (id) => db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, 'founder', 1)").run(id)

const TERMS = { type: 'percent', value: 20, recurring: 'lifetime', windowDays: 90 }
async function makePartner(fields = {}) {
  const cookie = await cookieFor(ADMIN)
  const r = await call(partnersRoute, 'POST', { cookie, body: { action: 'create', name: 'Pool Supply Co', contactEmail: 'rep@poolsupply.example', terms: TERMS, ...fields } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json.partner
}
async function signup(email, name, partner = undefined) {
  const cookie = await cookieFor(email)
  const r = await call(business, 'POST', { cookie, body: { name, timezone: 'America/New_York', serviceZips: '', plan: 'founding', source: 'newsletter', partner } })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  return r.json.id
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  stripeCalls = []
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) },
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    PLATFORM_ADMIN_EMAILS: ADMIN,
    REFERRALS_ENABLED: 'true',
    MESSAGE_TEST_RECIPIENTS: 'owner@pools.example,owner@spa.example,me@poolsupply.example,boss@gmail.com,owner@hvac.example,owner2@pools.example',
  }
  db.sql.prepare("INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES ('founding', 'Growth', 'price_FOUNDING', 0, '{}', 1, 1)").run()
  origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://api.stripe.com/v1/invoice_payments')) {
      stripeCalls.push(u)
      const pi = new URL(u).searchParams.get('payment[payment_intent]')
      return new Response(JSON.stringify({ data: pi === 'pi_newapi' ? [{ invoice: 'in_newapi' }] : [] }))
    }
    throw new Error(`unexpected ${u}`)
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

// ---------- codes and capture ----------
test('codes: random, readable, case-insensitive lookup; malformed codes are never looked up; no contact details returned', async () => {
  const codes = new Set(Array.from({ length: 200 }, () => newCode()))
  assert.equal(codes.size, 200)
  for (const c of codes) assert.match(c, /^[a-hj-km-np-z2-9]{10}$/)
  const p = await makePartner()
  assert.deepEqual(await partnerFromCode(db, p.code.toUpperCase()), { id: p.id, name: 'Pool Supply Co', status: 'active' })
  for (const bad of ['', 'short', "x' OR 1=1 --", 'a'.repeat(33), null]) assert.equal(await partnerFromCode(db, bad), null)
  assert.equal(p.link, `/r/${p.code}`)
})

test('referral link: /r/<code> redirects home with the code, the same answer whether or not it exists; a malformed code is dropped', async () => {
  const p = await makePartner()
  const good = await call(referralLink, 'GET', { params: { code: p.code.toUpperCase() } })
  const unknown = await call(referralLink, 'GET', { params: { code: 'zzzzzzzzzz' } })
  assert.deepEqual([good.status, good.headers.get('Location')], [302, `/?partner=${p.code}`])
  assert.deepEqual([unknown.status, unknown.headers.get('Location')], [302, '/?partner=zzzzzzzzzz'])
  assert.equal((await call(referralLink, 'GET', { params: { code: '<script>' } })).headers.get('Location'), '/')
  for (let i = 0; i < 57; i++) await call(referralLink, 'GET', { params: { code: p.code } })
  assert.equal((await call(referralLink, 'GET', { params: { code: p.code } })).status, 429, 'rate limited per IP')
})

test('browser first touch: the first codes seen are kept in order (at most 3, no repeats), later links never replace them', () => {
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
  try {
    captureReferral('?partner=aaaaaaaaaa', 1000)
    captureReferral('?ref=AAAAAAAAAA', 2000)
    captureReferral('?ref=bbbbbbbbbb', 3000)
    captureReferral('?utm_source=x', 3500)
    captureReferral('?partner=cccccccccc', 4000)
    captureReferral('?partner=dddddddddd', 5000)
    captureReferral('?partner=<bad>', 6000)
    assert.deepEqual(referralCandidates(), [{ code: 'aaaaaaaaaa', at: 1000 }, { code: 'bbbbbbbbbb', at: 3000 }, { code: 'cccccccccc', at: 4000 }])
    store.set('gsu_partner', 'not json')
    assert.deepEqual(referralCandidates(), [])
  } finally {
    delete globalThis.localStorage
  }
})

// ---------- attribution ----------
test('self-serve signup records first-touch attribution once: partner channel, marketing source kept apart, owner never re-attributed', async () => {
  const p = await makePartner()
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() - DAY }])
  const a = attr(id)
  assert.deepEqual([a.channel, a.partner_id, a.marketing_source, a.partner_refusal, a.closing_rep_email], ['partner', p.id, 'newsletter', null, null])
  // A second attempt (stream B, a replay, a later link) never changes the first touch.
  const again = await recordAttribution(db, id, { channel: 'sales_rep', repEmail: 'rep@getshowups.com', partnerCode: null, source: 'other' })
  assert.deepEqual([again.ok, again.recorded], [true, false])
  assert.equal(attr(id).channel, 'partner')
  // No code: plain self-serve.
  const plain = await signup('owner@spa.example', 'Spa Co')
  assert.deepEqual([attr(plain).channel, attr(plain).partner_id, attr(plain).partner_refusal], ['self_serve', null, null])
})

test('duplicate / conflicting referrals: the first VALID touch wins; unknown and paused codes are refused, never attributed', async () => {
  const first = await makePartner({ name: 'First' })
  const second = await makePartner({ name: 'Second' })
  const paused = await makePartner({ name: 'Paused' })
  await call(partnersRoute, 'POST', { cookie: await cookieFor(ADMIN), body: { action: 'pause', id: paused.id } })
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_at, updated_at) VALUES ('b1', 'B1', 'UTC', '', 1, 1), ('b2', 'B2', 'UTC', '', 1, 1), ('b3', 'B3', 'UTC', '', 1, 1)").run()
  const t = Date.now()
  assert.equal((await recordAttribution(db, 'b1', { partnerCode: [{ code: first.code, at: t - 2 * DAY }, { code: second.code, at: t - DAY }] }, t)).partnerId, first.id)
  assert.equal((await recordAttribution(db, 'b2', { partnerCode: [{ code: 'unknown123', at: t - 3 * DAY }, { code: paused.code, at: t - 2 * DAY }, { code: second.code, at: t - DAY }] }, t)).partnerId, second.id)
  const none = await recordAttribution(db, 'b3', { partnerCode: [{ code: paused.code, at: t }] }, t)
  assert.deepEqual([none.partnerId, none.refusal, attr('b3').partner_refusal], [null, 'paused', 'paused'])
})

test('self-referral is refused: owner = partner, same company domain, partner already a member, partner = closing rep; shared public mailbox domains are fine', async () => {
  assert.equal(selfReferral('Rep@PoolSupply.example', ['rep@poolsupply.example']), true)
  assert.equal(selfReferral('rep@poolsupply.example', ['owner@poolsupply.example']), true)
  assert.equal(selfReferral('someone@gmail.com', ['boss@gmail.com']), false)
  assert.equal(selfReferral(null, ['x@y.example']), false)
  const p = await makePartner({ contactEmail: 'rep@poolsupply.example' })
  const own = await signup('me@poolsupply.example', 'Supply Pools', [{ code: p.code, at: Date.now() }])
  assert.deepEqual([attr(own).partner_id, attr(own).partner_refusal, attr(own).channel], [null, 'self_referral', 'self_serve'])
  const gmailPartner = await makePartner({ contactEmail: 'someone@gmail.com' })
  const ok = await signup('boss@gmail.com', 'Gmail Pools', [{ code: gmailPartner.code, at: Date.now() }])
  assert.equal(attr(ok).partner_id, gmailPartner.id)
  // Assisted path (stream B): the closing rep or the invited owner can't be the referrer.
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_at, updated_at) VALUES ('assist1', 'A', 'UTC', '', 1, 1), ('assist2', 'B', 'UTC', '', 1, 1)").run()
  assert.equal((await recordAttribution(db, 'assist1', { channel: 'sales_rep', repEmail: 'REP@poolsupply.example', partnerCode: p.code })).refusal, 'self_referral')
  assert.equal((await recordAttribution(db, 'assist2', { channel: 'founder', ownerEmail: 'boss@poolsupply.example', partnerCode: p.code })).refusal, 'self_referral')
  assert.deepEqual([attr('assist1').channel, attr('assist1').closing_rep_email], ['sales_rep', 'rep@poolsupply.example'])
})

test('attribution window: a touch older than the partner terms allow is refused; a browser time in the future is clamped', async () => {
  const p = await makePartner({ terms: { ...TERMS, windowDays: 30 } })
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_at, updated_at) VALUES ('w1', 'W', 'UTC', '', 1, 1), ('w2', 'W', 'UTC', '', 1, 1)").run()
  const t = Date.now()
  assert.equal((await recordAttribution(db, 'w1', { partnerCode: [{ code: p.code, at: t - 40 * DAY }] }, t)).refusal, 'outside_window')
  await recordAttribution(db, 'w2', { partnerCode: [{ code: p.code, at: t + 365 * DAY }] }, t)
  assert.equal(attr('w2').partner_touched_at, t)
})

test('recordAttribution never throws and is a no-op before migration 0048', async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort().filter((f) => f < '0048')) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const old = { prepare: (q) => ({ bind: (...a) => ({ first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...a).changes } }) }), first: async () => sql.prepare(q).get() ?? null, all: async () => ({ results: sql.prepare(q).all() }) }) }
  const r = await recordAttribution(old, 'x1', { partnerCode: 'abcdefghjk' })
  assert.equal(r.ok, true)
  assert.equal(r.recorded, false)
  assert.equal(await partnerFromCode(old, 'abcdefghjk'), null)
  const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down') }, all: async () => { throw new Error('D1 down') }, run: async () => { throw new Error('D1 down') } }) }) }
  assert.deepEqual(await recordAttribution(broken, 'x1', {}), { ok: false, error: 'storage_error' })
})

// ---------- terms ----------
test('terms: every field is required and validated; nothing is filled in by default', () => {
  assert.deepEqual(validateTerms({ type: 'percent', value: 12.5, recurring: 'months:12', windowDays: 60 }), [null, { type: 'percent', value: 12.5, recurring: 'months:12', windowDays: 60 }])
  assert.deepEqual(validateTerms({ type: 'fixed', value: 10000, currency: 'USD', recurring: 'once', windowDays: 30 })[1], { type: 'fixed', value: 10000, currency: 'usd', recurring: 'once', windowDays: 30 })
  for (const [t, err] of [
    [{}, 'invalid_terms_type'],
    [{ type: 'percent', recurring: 'once', windowDays: 30 }, 'invalid_terms_value'],
    [{ type: 'percent', value: 101, recurring: 'once', windowDays: 30 }, 'invalid_terms_value'],
    [{ type: 'percent', value: 0.001, recurring: 'once', windowDays: 30 }, 'invalid_terms_value'],
    [{ type: 'fixed', value: 10.5, currency: 'usd', recurring: 'once', windowDays: 30 }, 'invalid_terms_value'],
    [{ type: 'fixed', value: 100, recurring: 'once', windowDays: 30 }, 'invalid_terms_currency'],
    [{ type: 'percent', value: 10, windowDays: 30 }, 'invalid_terms_recurring'],
    [{ type: 'percent', value: 10, recurring: 'months:0', windowDays: 30 }, 'invalid_terms_recurring'],
    [{ type: 'percent', value: 10, recurring: 'lifetime' }, 'invalid_terms_window'],
  ])
    assert.equal(validateTerms(t)[0], err, JSON.stringify(t))
  assert.equal(validateTerms(null)[0], 'invalid_terms')
})

test('accrual math: percent of the collected amount less tax; fixed capped at the amount and only in its currency; recurring rules', () => {
  assert.equal(commissionBasis({ amount_paid: 54390, tax: 4490 }), 49900)
  assert.equal(commissionBasis({ amount_paid: 54390, total_taxes: [{ amount: 4000 }, { amount: 490 }] }), 49900)
  assert.equal(commissionBasis({ amount_paid: 100, tax: 500 }), 0)
  assert.equal(commissionAmount({ type: 'percent', value: 20 }, 49900, 'usd'), 9980)
  assert.equal(commissionAmount({ type: 'percent', value: 12.5 }, 333, 'usd'), 42)
  assert.equal(commissionAmount({ type: 'fixed', value: 10000, currency: 'usd' }, 49900, 'USD'), 10000)
  assert.equal(commissionAmount({ type: 'fixed', value: 10000, currency: 'usd' }, 5000, 'usd'), 5000)
  assert.equal(commissionAmount({ type: 'fixed', value: 10000, currency: 'usd' }, 49900, 'eur'), 0)
  assert.equal(commissionAmount(null, 49900, 'usd'), 0)
  const jan31 = Date.UTC(2027, 0, 31)
  assert.equal(withinRecurring('once', null, jan31), true)
  assert.equal(withinRecurring('once', jan31, jan31 + DAY), false)
  assert.equal(withinRecurring('lifetime', jan31, jan31 + 3650 * DAY), true)
  assert.equal(withinRecurring('months:1', jan31, Date.UTC(2027, 1, 27)), true)
  assert.equal(withinRecurring('months:1', jan31, Date.UTC(2027, 1, 28)), false, 'one month after Jan 31 is Feb 28')
  assert.equal(withinRecurring('bogus', jan31, jan31 + 1), false)
})

// ---------- accruals through the verified webhook ----------
test('invoice.paid accrues one commission from the collected amount (tax excluded) with the terms snapshotted; replays add nothing', async () => {
  const p = await makePartner()
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  assert.equal((await paid(id, 'in_1', { amount: 54390, tax: 4490, eventId: 'evt_same' })).status, 200)
  assert.deepEqual(ledger(), [{ kind: 'accrual', amount: 9980, obj: 'in_1', livemode: 0, customer: id, partner_id: p.id }])
  const row = db.sql.prepare('SELECT basis_cents, paid_cents, rule, stripe_charge_id FROM commission_ledger').get()
  assert.deepEqual([row.basis_cents, row.paid_cents, row.stripe_charge_id], [49900, 54390, 'ch_in_1'])
  assert.deepEqual(Object.keys(JSON.parse(row.rule)).sort(), ['partnerId', 'recurring', 'termsUpdatedAt', 'type', 'value', 'windowDays'])
  // The same event again (Stripe retry) and the same invoice under another event id: still one accrual.
  assert.equal((await paid(id, 'in_1', { amount: 54390, tax: 4490, eventId: 'evt_same' })).json.duplicate, true)
  await paid(id, 'in_1', { amount: 54390, tax: 4490 })
  assert.equal(ledger().length, 1)
  // Zero-amount invoices and businesses without a partner accrue nothing.
  await paid(id, 'in_zero', { amount: 0 })
  const plain = await signup('owner@spa.example', 'Spa Co')
  await paid(plain, 'in_plain')
  assert.equal(ledger().length, 1)
  // The audit trail has the accrual (codes and amounts, no emails).
  const ev = db.sql.prepare("SELECT details FROM audit_log WHERE action = 'commission.accrued'").all()
  assert.equal(ev.length, 1)
  assert.ok(!ev[0].details.includes('@'))
})

test('recurring rules over real payments: once, months:N, lifetime; changing terms applies to later payments only', async () => {
  const t0 = Math.floor(Date.UTC(2027, 0, 10) / 1000)
  const once = await makePartner({ name: 'Once', terms: { type: 'fixed', value: 5000, currency: 'usd', recurring: 'once', windowDays: 90 } })
  const two = await makePartner({ name: 'Two', terms: { type: 'percent', value: 10, recurring: 'months:2', windowDays: 90 } })
  const life = await makePartner({ name: 'Life', terms: { type: 'percent', value: 10, recurring: 'lifetime', windowDays: 90 } })
  const a = await signup('owner@pools.example', 'A', [{ code: once.code, at: Date.now() }])
  const b = await signup('owner@spa.example', 'B', [{ code: two.code, at: Date.now() }])
  const c = await signup('owner@hvac.example', 'C', [{ code: life.code, at: Date.now() }])
  for (let m = 0; m < 4; m++) for (const id of [a, b, c]) await paid(id, `in_${id}_${m}`, { at: t0 + m * MONTH_S })
  const n = (id) => ledger().filter((l) => l.customer === id).map((l) => l.amount)
  assert.deepEqual(n(a), [5000])
  assert.deepEqual(n(b), [4990, 4990], 'payments within 2 months of the first commissioned one')
  assert.deepEqual(n(c), [4990, 4990, 4990, 4990])
  await call(partnersRoute, 'POST', { cookie: await cookieFor(ADMIN), body: { action: 'terms', id: life.id, terms: { type: 'percent', value: 5, recurring: 'lifetime', windowDays: 90 } } })
  await paid(c, `in_${c}_4`, { at: t0 + 4 * MONTH_S })
  assert.deepEqual(n(c), [4990, 4990, 4990, 4990, 2495])
  const audits = db.sql.prepare("SELECT action, details FROM admin_audit WHERE action LIKE 'partner.%'").all()
  assert.ok(audits.some((x) => x.action === 'partner.terms_set' && JSON.parse(x.details).from.terms.value === 10))
  assert.ok(audits.every((x) => !x.details.includes('rep@poolsupply.example')), 'the partner contact address never enters the audit')
})

test('no accrual when: switch off, partner paused, no terms, test business, subscription ended, partner became a member', async () => {
  const p = await makePartner()
  const noTerms = await makePartner({ name: 'No terms', terms: undefined })
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  const idNoTerms = await signup('owner@spa.example', 'Spa Co', [{ code: noTerms.code, at: Date.now() }])
  const idTest = await signup('owner@hvac.example', 'Hvac Co', [{ code: p.code, at: Date.now() }])
  markTest(idTest)
  delete env.REFERRALS_ENABLED
  await paid(id, 'in_off')
  env.REFERRALS_ENABLED = 'TRUE'
  await paid(id, 'in_off2')
  env.REFERRALS_ENABLED = 'true'
  await paid(idNoTerms, 'in_noterms')
  await paid(idTest, 'in_test')
  assert.equal(ledger().length, 0)
  await call(partnersRoute, 'POST', { cookie: await cookieFor(ADMIN), body: { action: 'pause', id: p.id } })
  await paid(id, 'in_paused')
  assert.equal(ledger().length, 0)
  await call(partnersRoute, 'POST', { cookie: await cookieFor(ADMIN), body: { action: 'resume', id: p.id } })
  await paid(id, 'in_ok')
  assert.equal(ledger().length, 1)
  // Cancellation: no commission for payments after the subscription ended.
  const end = Math.floor(Date.now() / 1000)
  await deliver({ id: `evt_${++evt}`, type: 'customer.subscription.deleted', created: end, data: { object: { id: `sub_${id}`, customer: `cus_${id}`, status: 'canceled', metadata: { customer: id }, items: { data: [] } } } })
  assert.equal(attr(id).commission_ended_at, end * 1000)
  await paid(id, 'in_after_cancel', { at: end + 60 })
  // The partner's address later joins the business: no further commission.
  const other = await signup('owner2@pools.example', 'Pools Two', [{ code: p.code, at: Date.now() }])
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES ('rep@poolsupply.example', ?, 1)").run(other)
  await paid(other, 'in_member')
  assert.deepEqual(ledger().map((l) => l.obj), ['in_ok'])
  const r = await accrueCommission({ ...env, REFERRALS_ENABLED: 'false' }, id, { id: 'e', created: 1 }, { id: 'in_x', amount_paid: 100 })
  assert.deepEqual(r, { accrued: false, reason: 'off' })
})

// ---------- reversals ----------
test('refunds reverse proportionally and cumulatively; disputes reverse once; never more than accrued; replays add nothing', async () => {
  const p = await makePartner()
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  await paid(id, 'in_1', { amount: 50000 }) // 20% → 10000
  await refunded('ch_in_1', 50000, 12500) // 25% refunded → −2500
  await refunded('ch_in_1', 50000, 12500) // the same refund state again → nothing
  await refunded('ch_in_1', 50000, 25000) // now 50% in total → a further −2500
  assert.deepEqual(ledger().filter((l) => l.kind === 'reversal').map((l) => [l.amount, l.obj]), [[-2500, 'refund:ch_in_1:12500'], [-2500, 'refund:ch_in_1:25000']])
  await disputed('dp_1', 'ch_in_1', 25000) // the remaining half disputed → −5000
  await disputed('dp_1', 'ch_in_1', 25000, 'charge.dispute.funds_withdrawn') // same dispute: once
  await refunded('ch_in_1', 50000, 50000) // nothing left to reverse
  assert.equal(owed(), 0)
  assert.equal(ledger().filter((l) => l.kind === 'reversal').length, 3)
  // A refund of a payment without a commission does nothing.
  assert.equal((await refunded('ch_unknown', 1000, 1000)).json.handled, false)
})

test('reversal still applies with the switch off; newer Stripe payloads are matched through invoice payments (read-only lookup)', async () => {
  const p = await makePartner()
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  await paid(id, 'in_newapi', { amount: 10000, newApi: true }) // no charge / payment_intent on the invoice
  assert.deepEqual(ledger().map((l) => l.amount), [2000])
  delete env.REFERRALS_ENABLED
  await refunded('ch_new', 10000, 10000, { pi: 'pi_newapi' })
  assert.equal(owed(), 0)
  assert.equal(stripeCalls.length, 1)
  assert.match(stripeCalls[0], /payment%5Btype%5D=payment_intent/)
})

test('ledger is append-only: UPDATE and DELETE are refused by the database', async () => {
  const p = await makePartner()
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  await paid(id, 'in_1')
  assert.throws(() => db.sql.prepare('UPDATE commission_ledger SET amount_cents = 1').run(), /append-only/)
  assert.throws(() => db.sql.prepare('DELETE FROM commission_ledger').run(), /append-only/)
  assert.throws(() => db.sql.prepare("INSERT INTO commission_ledger (partner_id, customer, kind, stripe_object_id, amount_cents, currency, basis_cents, paid_cents, livemode, rule, created_at) VALUES ('x', 'y', 'accrual', 'in_1', 1, 'usd', 1, 1, 0, '{}', 1)").run(), /UNIQUE/)
})

// ---------- live vs test, reporting ----------
test('live vs test: test-mode accruals are tagged test and never a liability; live accruals count only while live billing is on', async () => {
  const p = await makePartner()
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  await paid(id, 'in_test')
  const cookie = await cookieFor(ADMIN)
  let v = (await call(commercialRoute, 'GET', { cookie })).json
  const mine = () => v.partners.partners.find((x) => x.id === p.id)
  assert.deepEqual(mine().liability, {})
  assert.deepEqual(mine().testMode, { usd: { accruedCents: 9980, reversedCents: 0, owedCents: 9980 } })
  assert.equal(v.pipeline.rows.find((r) => r.id === id).commissionCents, null)
  assert.equal(v.pipeline.testCommissionCents, 9980)
  env.STRIPE_LIVE_ENABLED = 'true'
  db.sql.prepare("INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, last_event_at, updated_at) VALUES (?, ?, 'sub_live', 'founding', 'active', 49900, 'usd', 0, 1)").run(id, `cus_${id}`)
  db.sql.prepare('INSERT INTO subscription_modes (customer, livemode, updated_at) VALUES (?, 1, 1)').run(id)
  await paid(id, 'in_live', { live: true })
  v = (await call(commercialRoute, 'GET', { cookie })).json
  assert.deepEqual(mine().liability, { usd: { accruedCents: 9980, reversedCents: 0, owedCents: 9980 } })
  const row = v.pipeline.rows.find((r) => r.id === id)
  assert.deepEqual([row.payment, row.activeSubscription, row.collectedRevenueCents, row.commissionCents], ['confirmed', true, 49900, 9980])
  const ch = v.pipeline.byChannel.find((c) => c.key === 'partner')
  assert.deepEqual([ch.businesses, ch.activeSubscriptions, ch.revenueCents, ch.commissionCents, ch.acquisitionCostCents, ch.retention], [1, 1, 49900, 9980, 9980, 1])
})

test('pipeline: stages per business; test businesses, the sales business and test subscriptions are never customers or revenue; no owner emails', async () => {
  const p = await makePartner()
  const a = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  const b = await signup('owner@spa.example', 'Spa Co')
  const t = await signup('owner@hvac.example', 'Hvac Co', [{ code: p.code, at: Date.now() }])
  markTest(t)
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_via, created_at, updated_at) VALUES ('getshowups', 'GetShowUps', 'UTC', '', 'admin_invite', 1, 1), ('invited1', 'Invited', 'UTC', '', 'admin_invite', 1, 1)").run()
  db.sql.prepare("INSERT INTO account_invites (id, token_hash, email, customer, created_by, created_at, expires_at) VALUES ('i1', 'h', 'new@owner.example', 'invited1', ?, 1, ?)").run(ADMIN, Date.now() + DAY)
  // Test-mode subscription: "test", never a customer.
  await deliver({ id: `evt_${++evt}`, type: 'customer.subscription.updated', data: { object: { id: `sub_${b}`, customer: `cus_${b}`, status: 'active', metadata: { customer: b }, currency: 'usd', items: { data: [{ quantity: 1, current_period_end: 1900000000, price: { id: 'price_FOUNDING', unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } } }] } } } })
  await paid(b, 'in_b')
  const v = (await call(commercialRoute, 'GET', { cookie: await cookieFor(ADMIN) })).json.pipeline
  const ids = v.rows.map((r) => r.id).sort()
  assert.deepEqual(ids, [a, b, 'invited1'].sort())
  assert.equal(v.excludedTest, 1)
  const row = (id) => v.rows.find((r) => r.id === id)
  assert.deepEqual([row(a).channel, row(a).partner.name, row(a).source, row(a).payment, row(a).invitation], ['partner', 'Pool Supply Co', 'newsletter', 'pending', 'claimed'])
  assert.deepEqual([row(b).channel, row(b).payment, row(b).activeSubscription, row(b).collectedRevenueCents], ['self_serve', 'test', false, null])
  assert.deepEqual([row('invited1').channel, row('invited1').invitation, row('invited1').payment], ['founder', 'pending', 'not_billed'])
  assert.deepEqual(v.byChannel.map((c) => c.key), ['self_serve', 'founder', 'sales_rep', 'partner'])
  assert.ok(v.byChannel.every((c) => c.revenueCents === null && c.retention === null), 'test billing: nothing is revenue')
  assert.equal(v.byChannel.reduce((n, c) => n + c.activeSubscriptions, 0), 0)
  const all = JSON.stringify(v)
  for (const e of ['owner@pools.example', 'owner@spa.example', 'new@owner.example', 'rep@poolsupply.example']) assert.ok(!all.includes(e), e)
})

test('admin only: partner and pipeline routes refuse owners, cross-origin writes and signed-out visitors; partners have no access path', async () => {
  const owner = await cookieFor('owner@pools.example')
  assert.equal((await call(commercialRoute, 'GET', { cookie: owner })).status, 403)
  assert.equal((await call(commercialRoute, 'GET', {})).status, 401)
  assert.equal((await call(partnersRoute, 'POST', { cookie: owner, body: { action: 'create', name: 'X' } })).status, 403)
  assert.equal((await call(partnersRoute, 'POST', { cookie: await cookieFor(ADMIN), origin: 'https://evil.example', body: { action: 'create', name: 'X' } })).status, 403)
  assert.equal((await call(attributionRoute, 'POST', { cookie: owner, body: { customer: 'x1', confirm: true } })).status, 403)
  const bad = await call(partnersRoute, 'POST', { cookie: await cookieFor(ADMIN), body: { action: 'create', name: 'X', contactEmail: 'not-an-email' } })
  assert.deepEqual([bad.status, bad.json.error], [400, 'invalid_email'])
  assert.deepEqual((await call(partnersRoute, 'POST', { cookie: await cookieFor(ADMIN), body: { action: 'pause', id: 'prt_missing' } })).json.error, 'not_found')
})

test('admin correction: the only way an attribution changes; confirmation required, self-referral still refused, audited from → to', async () => {
  const p = await makePartner()
  const q = await makePartner({ name: 'Other', contactEmail: 'x@other-partner.example' })
  const id = await signup('owner@pools.example', 'Pools Co', [{ code: p.code, at: Date.now() }])
  const cookie = await cookieFor(ADMIN)
  assert.equal((await call(attributionRoute, 'POST', { cookie, body: { customer: id, partnerId: q.id } })).json.error, 'confirmation_required')
  const r = await call(attributionRoute, 'POST', { cookie, body: { customer: id, partnerId: q.id, repEmail: 'closer@getshowups.com', channel: 'sales_rep', confirm: true } })
  assert.equal(r.status, 200)
  assert.deepEqual([attr(id).partner_id, attr(id).channel, attr(id).closing_rep_email, attr(id).corrected_by], [q.id, 'sales_rep', 'closer@getshowups.com', ADMIN])
  const audit = JSON.parse(db.sql.prepare("SELECT details FROM admin_audit WHERE action = 'attribution.corrected'").get().details)
  assert.deepEqual([audit.from.partnerId, audit.to.partnerId], [p.id, q.id])
  db.sql.prepare("INSERT INTO customer_users (email, customer, created_at) VALUES ('x@other-partner.example', ?, 1)").run(id)
  assert.equal((await correctAttribution(env, id, { partnerId: q.id }, ADMIN)).error, 'self_referral')
  assert.equal((await call(attributionRoute, 'POST', { cookie, body: { customer: id, channel: 'bogus', confirm: true } })).json.error, 'invalid_channel')
  assert.equal((await call(attributionRoute, 'POST', { cookie, body: { customer: 'nope-nope', confirm: true } })).status, 404)
})

test('before migration 0048 the pipeline still renders (attribution unavailable) and the webhook behaves exactly as today', async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort().filter((f) => f < '0048')) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_via, created_at, updated_at) VALUES ('old1', 'Old', 'UTC', '', 'admin_invite', 1, 1)").run()
  const old = { ...env, ONBOARDING_DB: { prepare: (q) => stmt(q) } }
  const v = await commercialPipeline(old)
  assert.deepEqual([v.attributionReady, v.rows.map((r) => r.id), v.rows[0].channel, v.rows[0].attributed], [false, ['old1'], 'founder', false])
  assert.deepEqual(await accrueCommission(old, 'old1', { id: 'e', created: 1 }, { id: 'in_1', amount_paid: 100 }), { accrued: false, reason: 'not_ready' })
})

test('assisted enrollments (stream B, 0047 shape): rep or founder channel, stage per business, stage counts without test businesses', async () => {
  db.sql.exec(`CREATE TABLE IF NOT EXISTS assisted_enrollments (id TEXT PRIMARY KEY, customer TEXT, business_name TEXT, owner_email TEXT, assigned_rep_email TEXT, stage TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`) // the 0047 shape (columns this view reads)
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, created_via, created_at, updated_at) VALUES ('rep1', 'Rep Sold', 'UTC', '', 'admin_invite', 1, 1), ('fdr1', 'Founder Sold', 'UTC', '', 'admin_invite', 1, 1), ('tst1', 'Test Sold', 'UTC', '', 'admin_invite', 1, 1)").run()
  markTest('tst1')
  for (const [id, c, rep, stage] of [['enr_a', 'rep1', 'rep@getshowups.com', 'invited'], ['enr_b', 'fdr1', null, 'paid'], ['enr_c', null, 'rep@getshowups.com', 'prospect'], ['enr_d', 'tst1', null, 'claimed']])
    db.sql.prepare("INSERT INTO assisted_enrollments (id, customer, business_name, owner_email, assigned_rep_email, stage, created_by, created_at, updated_at) VALUES (?, ?, 'P', 'o@p.example', ?, ?, 'founder@getshowups.com', 1, 1)").run(id, c, rep, stage)
  const v = await commercialPipeline(env)
  const row = (id) => v.rows.find((r) => r.id === id)
  assert.deepEqual([row('rep1').channel, row('rep1').rep, row('rep1').enrollmentStage], ['sales_rep', 'rep@getshowups.com', 'invited'])
  assert.deepEqual([row('fdr1').channel, row('fdr1').rep, row('fdr1').enrollmentStage], ['founder', null, 'paid'])
  assert.equal(row('tst1'), undefined)
  assert.deepEqual([v.enrollmentsReady, v.enrollmentStages], [true, { invited: 1, paid: 1, prospect: 1 }])
  assert.ok(!JSON.stringify(v).includes('o@p.example'))
})
