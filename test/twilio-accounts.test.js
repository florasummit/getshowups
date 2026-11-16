// Twilio architecture: ONE parent account, ONE subaccount per business (server/followups/twilio.js, provisioning.js).
// Covers: subaccount creation (idempotent, recovered after a lost response, token sealed), sending under the
// business's own subaccount, webhook signatures per subaccount + tenant isolation, both registration paths (low-volume
// standard with an EIN; sole proprietor without one) step by step with the submit/charge gates, unknown outcomes,
// provider-reported approval only, usage, account deletion, and behaviour before migration 0025.
// Twilio is mocked; no real network, nothing submitted, nothing bought.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { twilioSignature } from '../server/followups/transport.js'
import { smsReadiness, registrationOf } from '../server/followups/settings.js'
import { ensureSubaccount, syncUsage, closeSubaccount, subaccountAuth } from '../server/followups/twilio.js'
import { runStep, syncRegistration, provisioningState, POLICIES } from '../server/followups/provisioning.js'
import * as textingApi from '../functions/api/dashboard/followups/texting.js'
import * as platformApi from '../functions/api/platform/messaging.js'
import * as inboundApi from '../functions/api/sms/twilio/inbound.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const PARENT = `AC${'f'.repeat(32)}`
const PARENT_TOKEN = 'parent_SECRET_token_0000'
const PRIMARY = `BU${'9'.repeat(32)}`
const SECRETS = [PARENT_TOKEN, KEY, 'subtok_']
const DAY = 864e5

function d1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.some((s) => f.startsWith(s))) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
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

let env, db, kv, calls, tw, origFetch, origError, logs, responses
let n = 0
const sid = (prefix) => `${prefix}${(++n).toString(16).padStart(32, '0')}`

// A Twilio stand-in for every host we call. Records host, method, path, which account's credentials were used, params.
function twilioMock(url, init) {
  const u = new URL(url)
  const host = u.hostname.split('.')[0]
  const auth = atob(String(init.headers?.Authorization || '').replace('Basic ', '')).split(':')
  const params = init.method === 'GET' ? u.searchParams : new URLSearchParams(String(init.body || ''))
  const call = { host, method: init.method, path: u.pathname, as: auth[0], token: auth[1], params }
  calls.push(call)
  if (tw.fail?.(call)) return tw.fail(call)
  const p = u.pathname
  const ok = (body) => [200, body]
  if (host === 'api') {
    if (p === '/2010-04-01/Accounts.json' && init.method === 'GET') return ok({ accounts: tw.accounts.filter((a) => a.friendly_name === params.get('FriendlyName')) })
    if (p === '/2010-04-01/Accounts.json') {
      const a = { sid: sid('AC'), auth_token: `subtok_${n}_${'x'.repeat(20)}`, owner_account_sid: PARENT, friendly_name: params.get('FriendlyName'), status: 'active' }
      tw.accounts.push(a)
      return [201, a]
    }
    if (/^\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\.json$/.test(p)) return ok({ status: params.get('Status') })
    if (p.endsWith('/Addresses.json')) return [201, { sid: sid('AD') }]
    if (p.includes('/AvailablePhoneNumbers/US/Local.json')) return ok({ available_phone_numbers: [{ phone_number: '+18435550999' }] })
    if (p.endsWith('/IncomingPhoneNumbers.json')) return [201, { sid: sid('PN'), phone_number: params.get('PhoneNumber') }]
    if (p.endsWith('/Usage/Records/ThisMonth.json')) return ok({ usage_records: [{ category: 'sms', count: '42', price: '-0.47', price_unit: 'usd' }] })
    if (p.endsWith('/Messages.json')) return [201, { sid: sid('SM') }]
  }
  if (host === 'trusthub') {
    if (p === '/v1/CustomerProfiles' || p === '/v1/TrustProducts') return [201, { sid: sid('BU'), status: 'draft' }]
    if (p === '/v1/EndUsers') return [201, { sid: sid('IT') }]
    if (p === '/v1/SupportingDocuments') return [201, { sid: sid('RD'), status: 'DRAFT' }]
    if (p.endsWith('/EntityAssignments')) return [201, { sid: sid('BV') }]
    if (p.endsWith('/Evaluations')) return [201, { status: tw.evaluation, results: tw.evaluation === 'compliant' ? [] : [{ fields: [{ object_field: 'business_registration_number', passed: false }] }] }]
    if (/^\/v1\/(CustomerProfiles|TrustProducts)\/BU[0-9a-f]{32}$/.test(p)) return ok({ status: init.method === 'GET' ? tw.profileStatus : params.get('Status') })
  }
  if (host === 'messaging') {
    if (p === '/v1/a2p/BrandRegistrations') return [201, { sid: sid('BN'), status: 'PENDING', brand_type: params.get('BrandType') || 'STANDARD' }]
    if (/^\/v1\/a2p\/BrandRegistrations\/BN[0-9a-f]{32}$/.test(p)) return ok({ status: tw.brandStatus })
    if (p.endsWith('/SmsOtp')) return [201, {}]
    if (p === '/v1/Services') return [201, { sid: sid('MG') }]
    if (/\/Compliance\/Usa2p$/.test(p)) return [201, { sid: sid('QE'), campaign_status: 'IN_PROGRESS' }]
    if (/\/Compliance\/Usa2p\/QE[0-9a-f]{32}$/.test(p)) return ok({ campaign_status: tw.campaignStatus })
    if (p.endsWith('/PhoneNumbers')) return [201, { sid: sid('PN') }]
  }
  throw new Error(`unexpected twilio ${init.method} ${host} ${p}`)
}

async function seed(id) {
  const t = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)")
    .run(id, `${id} Co`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'pool', '', '[]', '[]', ?)").run(id, t)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}

beforeEach(() => {
  db = d1()
  kv = new Map()
  calls = []
  responses = []
  tw = { accounts: [], evaluation: 'compliant', profileStatus: 'in-review', brandStatus: 'IN_REVIEW', campaignStatus: 'IN_PROGRESS', fail: null }
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    TOKEN_ENCRYPTION_KEY: KEY,
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), list: async () => ({ keys: [] }) },
    TWILIO_ACCOUNT_SID: PARENT,
    TWILIO_AUTH_TOKEN: PARENT_TOKEN,
    TWILIO_PRIMARY_PROFILE_SID: PRIMARY,
    TWILIO_PROFILE_EMAIL: 'texting@getshowups.example',
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (!/^https:\/\/(api|trusthub|messaging)\.twilio\.com\//.test(u)) throw new Error(`unexpected ${u}`)
    const [status, body] = twilioMock(u, init)
    return new Response(JSON.stringify(body), { status })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const all = [...responses, ...logs].join('\n')
  for (const s of SECRETS) assert.ok(!all.includes(s), `secret leaked: ${s.slice(0, 6)}`)
})

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { cookie, body, raw, headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9', ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = ORIGIN
  const waits = []
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, params: {}, waitUntil: (p) => waits.push(p) })
  await Promise.all(waits)
  const text = await res.clone().text()
  responses.push(text)
  return { status: res.status, json: () => JSON.parse(text), text }
}

const LLC = { legalName: 'Alpha Pools LLC', businessType: 'llc', ein: '12-3456789', street: '1 King St', city: 'Charleston', region: 'SC', postalCode: '29401', website: 'alphapools.example.com', firstName: 'Pat', lastName: 'Alpha', repTitle: 'Owner', repJobPosition: 'CEO', industry: 'PROFESSIONAL', contactEmail: 'pat@alpha.example', contactPhone: '843-555-0123' }
const SOLE = { ...LLC, legalName: 'Sam Beta', businessType: 'sole_proprietor', ein: '', repTitle: '', repJobPosition: '', firstName: 'Sam', lastName: 'Beta', contactEmail: 'sam@beta.example', contactPhone: '843-555-0124' }
// The owner enters the facts and explicitly approves submission (nothing reaches Twilio before this).
async function ownerApproves(id, details) {
  const owner = await session(`owner@${id}.example`)
  assert.equal((await call(textingApi, 'POST', '/api/dashboard/followups/texting', { cookie: owner, body: { action: 'save', details } })).status, 200)
  assert.equal((await call(textingApi, 'POST', '/api/dashboard/followups/texting', { cookie: owner, body: { action: 'approve', confirm: true } })).status, 200)
}
const admin = () => session('staff@getshowups.com')
const step = async (id, s, extra = {}) => call(platformApi, 'POST', '/api/platform/messaging', { cookie: await admin(), body: { customer: id, action: 'provision', step: s, confirm: true, ...extra } })
const after = (i) => calls.slice(i)

test('subaccount: one per business, token sealed at rest, idempotent, recovered after a lost response; never shared', async () => {
  await seed('alpha')
  await seed('beta')
  const a = await ensureSubaccount(env, 'alpha')
  assert.equal(a.ok, true)
  assert.equal(a.created, true)
  const create = calls.find((c) => c.path === '/2010-04-01/Accounts.json' && c.method === 'POST')
  assert.equal(create.as, PARENT, 'created by the parent account')
  assert.equal(create.params.get('FriendlyName'), 'GetShowUps alpha')
  const row = db.sql.prepare('SELECT * FROM sms_accounts WHERE customer = ?').get('alpha')
  assert.ok(row.auth_token_enc.startsWith('v1.') && !row.auth_token_enc.includes('subtok_'), 'token stored sealed, never in clear')
  assert.equal((await subaccountAuth(env, 'alpha')).token, tw.accounts[0].auth_token)
  // Idempotent: no second subaccount.
  const before = tw.accounts.length
  assert.deepEqual(await ensureSubaccount(env, 'alpha'), { ok: true, accountSid: a.accountSid, created: false })
  assert.equal(tw.accounts.length, before)
  // Lost response: Twilio created it but we never stored it → adopted by FriendlyName, not created again.
  tw.accounts.push({ sid: sid('AC'), auth_token: `subtok_lost_${'y'.repeat(20)}`, owner_account_sid: PARENT, friendly_name: 'GetShowUps beta', status: 'active' })
  const b = await ensureSubaccount(env, 'beta')
  assert.deepEqual([b.ok, b.created], [true, false])
  assert.notEqual(b.accountSid, a.accountSid)
  // A subaccount owned by another parent is never adopted.
  db.sql.prepare("DELETE FROM sms_accounts WHERE customer = 'beta'").run()
  tw.accounts.at(-1).owner_account_sid = `AC${'1'.repeat(32)}`
  assert.equal((await ensureSubaccount(env, 'beta')).created, true)
  // Credentials missing → nothing happens.
  assert.equal((await ensureSubaccount({ ...env, TWILIO_AUTH_TOKEN: '' }, 'gamma')).error, 'provider_not_configured')
})

test('sending: always under the business’s own subaccount; a business without one never texts', async () => {
  await seed('alpha')
  db.sql.prepare("INSERT INTO sms_registrations (customer, legal_name, status, approved_at, sender_phone, updated_at) VALUES ('alpha', 'x', 'approved', 1, '+18435550100', 1)").run()
  assert.ok(smsReadiness(env, await registrationOf(db, 'alpha')).reasons.includes('no_account'))
  await ensureSubaccount(env, 'alpha')
  const ready = smsReadiness(env, await registrationOf(db, 'alpha'))
  assert.equal(ready.ok, true)
  const { sendTwilio } = await import('../server/followups/transport.js')
  const r = await sendTwilio({ ...env, MESSAGES_LIVE: 'true', SMS_LIVE: 'true' }, { to: '843-555-0142', text: 'alpha Co: hi', sender: ready.sender })
  assert.equal(r.ok, true)
  const sent = calls.at(-1)
  assert.equal(sent.path, `/2010-04-01/Accounts/${ready.sender.accountSid}/Messages.json`)
  assert.equal(sent.as, PARENT, 'parent credentials on the subaccount path (allowed for v2010 resources)')
  // Suspended/closed subaccount → not ready.
  db.sql.prepare("UPDATE sms_accounts SET status = 'closed' WHERE customer = 'alpha'").run()
  assert.ok(smsReadiness(env, await registrationOf(db, 'alpha')).reasons.includes('no_account'))
})

test('webhooks: signed by the subaccount that owns the number; another business’s subaccount or an unknown account is refused', async () => {
  await seed('alpha')
  await seed('beta')
  for (const id of ['alpha', 'beta']) {
    await ensureSubaccount(env, id)
    db.sql.prepare("INSERT INTO sms_registrations (customer, legal_name, status, approved_at, sender_phone, updated_at) VALUES (?, 'x', 'approved', 1, ?, 1)").run(id, id === 'alpha' ? '+18435550100' : '+18435550200')
  }
  const acct = (id) => db.sql.prepare('SELECT account_sid FROM sms_accounts WHERE customer = ?').get(id).account_sid
  const token = (id) => tw.accounts.find((a) => a.sid === acct(id)).auth_token
  const post = async (fields, signWith) => {
    const params = new URLSearchParams(fields)
    const sig = await twilioSignature(signWith, `${ORIGIN}/api/sms/twilio/inbound`, params)
    return call(inboundApi, 'POST', '/api/sms/twilio/inbound', { raw: params.toString(), headers: { 'X-Twilio-Signature': sig, 'Content-Type': 'application/x-www-form-urlencoded' } })
  }
  const msg = (n, to, account) => ({ AccountSid: account, From: '+18435550142', To: to, Body: 'Hi there', MessageSid: `SM${String(n).padStart(32, '0')}` })
  // Alpha's subaccount, alpha's number, alpha's token → accepted and routed to alpha.
  const inbound = (id) => db.sql.prepare("SELECT count(*) AS n FROM thread_messages WHERE customer = ? AND direction = 'in'").get(id).n
  assert.equal((await post(msg(1, '+18435550100', acct('alpha')), token('alpha'))).status, 200)
  assert.equal(inbound('alpha'), 1)
  // Signed with beta's token while claiming alpha's account → refused.
  assert.equal((await post(msg(2, '+18435550100', acct('alpha')), token('beta'))).status, 403)
  // Beta's subaccount (validly signed) naming ALPHA's number → not routed to alpha (tenant isolation).
  assert.equal((await post(msg(3, '+18435550100', acct('beta')), token('beta'))).status, 200)
  assert.equal(inbound('alpha'), 1)
  assert.equal(inbound('beta'), 0)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'sms.inbound_unrouted' AND details LIKE '%account_mismatch%'").get().n, 1)
  // Signed as the PARENT account naming alpha's number → verified but routed nowhere (numbers live in subaccounts).
  assert.equal((await post(msg(5, '+18435550100', PARENT), PARENT_TOKEN)).status, 200)
  assert.equal(inbound('alpha'), 1)
  // Unknown account → refused; nothing recorded.
  assert.equal((await post(msg(4, '+18435550100', `AC${'e'.repeat(32)}`), PARENT_TOKEN)).status, 403)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM thread_messages WHERE direction = 'in'").get().n, 1)
})

test('low-volume standard (EIN): every step in order in the business’s subaccount; submits and charges need the switch AND an explicit approval', async () => {
  await seed('alpha')
  // Nothing before the owner approved.
  assert.equal((await step('alpha', 'subaccount')).json().error, 'details_missing')
  await ownerApproves('alpha', LLC)
  const st = (await provisioningState(env, 'alpha'))
  assert.deepEqual([st.path, st.next, st.submitEnabled], ['low_volume_standard', 'subaccount', false])
  // Out of order → refused.
  assert.equal((await step('alpha', 'customer_profile')).json().error, 'needs_subaccount')
  assert.equal((await step('alpha', 'subaccount')).status, 200)
  const sub = db.sql.prepare("SELECT account_sid FROM sms_accounts WHERE customer = 'alpha'").get().account_sid

  let i = calls.length
  assert.equal((await step('alpha', 'customer_profile')).status, 200)
  const prof = after(i)
  assert.ok(prof.filter((c) => c.host === 'trusthub').every((c) => c.as === sub), 'trust hub calls use the subaccount’s own credentials')
  const created = prof.find((c) => c.path === '/v1/CustomerProfiles')
  assert.equal(created.params.get('PolicySid'), POLICIES.secondary)
  assert.equal(created.params.get('Email'), 'texting@getshowups.example')
  const biz = JSON.parse(prof.find((c) => c.params.get('Type') === 'customer_profile_business_information').params.get('Attributes'))
  assert.deepEqual(biz, { business_identity: 'direct_customer', business_industry: 'PROFESSIONAL', business_name: 'Alpha Pools LLC', business_regions_of_operation: 'USA_AND_CANADA', business_registration_identifier: 'EIN', business_registration_number: '12-3456789', business_type: 'Limited Liability Corporation', website_url: 'https://alphapools.example.com' })
  const rep = JSON.parse(prof.find((c) => c.params.get('Type') === 'authorized_representative_1').params.get('Attributes'))
  assert.deepEqual([rep.first_name, rep.last_name, rep.business_title, rep.job_position, rep.phone_number], ['Pat', 'Alpha', 'Owner', 'CEO', '+18435550123'])
  const addr = prof.find((c) => c.path.endsWith('/Addresses.json'))
  assert.equal(addr.path, `/2010-04-01/Accounts/${sub}/Addresses.json`)
  assert.deepEqual([addr.params.get('Street'), addr.params.get('City'), addr.params.get('Region'), addr.params.get('PostalCode'), addr.params.get('IsoCountry')], ['1 King St', 'Charleston', 'SC', '29401', 'US'])
  assert.ok(prof.some((c) => c.path.endsWith('/EntityAssignments') && c.params.get('ObjectSid') === PRIMARY), 'linked to GetShowUps’s primary ISV profile')
  assert.equal(prof.filter((c) => c.params.get('Status')).length, 0, 'drafted and evaluated, NOT submitted')
  // Re-running a done step changes nothing.
  i = calls.length
  assert.equal((await step('alpha', 'customer_profile')).json().already, true)
  assert.equal(calls.length, i)

  // Submitting: switched off by default; then needs an explicit approval for that step.
  assert.equal((await step('alpha', 'submit_profile', { approve: true })).json().error, 'submission_disabled')
  env.TWILIO_REGISTRATION_SUBMIT = 'true'
  assert.equal((await step('alpha', 'submit_profile')).json().error, 'approval_required')
  assert.equal((await step('alpha', 'submit_profile', { approve: true })).status, 200)
  assert.equal(calls.at(-1).params.get('Status'), 'pending-review')
  assert.equal(db.sql.prepare("SELECT status FROM sms_registrations WHERE customer = 'alpha'").get().status, 'pending')

  i = calls.length
  assert.equal((await step('alpha', 'a2p_bundle')).status, 200)
  const bundle = after(i)
  assert.equal(bundle.find((c) => c.path === '/v1/TrustProducts').params.get('PolicySid'), POLICIES.a2p)
  assert.deepEqual(JSON.parse(bundle.find((c) => c.params.get('Type') === 'us_a2p_messaging_profile_information').params.get('Attributes')), { company_type: 'private' })
  assert.equal((await step('alpha', 'submit_bundle', { approve: true })).status, 200)

  assert.equal((await step('alpha', 'brand', { approve: true })).status, 200)
  const brand = calls.at(-1)
  assert.deepEqual([brand.host, brand.path, brand.params.get('SkipAutomaticSecVet'), brand.params.get('BrandType')], ['messaging', '/v1/a2p/BrandRegistrations', 'true', null])
  // Messaging Service only after Twilio reports the brand APPROVED.
  assert.equal((await step('alpha', 'messaging_service')).json().error, 'brand_not_approved')
  tw.brandStatus = 'APPROVED'
  await call(platformApi, 'POST', '/api/platform/messaging', { cookie: await admin(), body: { customer: 'alpha', action: 'sync', confirm: true } })
  assert.equal((await step('alpha', 'messaging_service')).status, 200)
  assert.equal(calls.at(-1).params.get('InboundRequestUrl'), 'https://getshowups.com/api/sms/twilio/inbound')

  assert.equal((await step('alpha', 'campaign', { approve: true })).status, 200)
  const camp = calls.at(-1)
  assert.equal(camp.params.get('UsAppToPersonUsecase'), 'LOW_VOLUME')
  assert.ok(camp.params.getAll('MessageSamples').length >= 2 && camp.params.getAll('MessageSamples').every((s) => s.startsWith('alpha Co:')))
  assert.match(camp.params.get('MessageFlow'), /getshowups\.com\/book\/alpha/)
  assert.equal(camp.params.get('HasEmbeddedLinks'), 'true')

  // Not approved until Twilio says the campaign is VERIFIED; no number → still can't text.
  assert.equal(smsReadiness(env, await registrationOf(db, 'alpha')).ok, false)
  assert.equal((await step('alpha', 'phone_number', { approve: true })).status, 200)
  const buy = calls.find((c) => c.path.endsWith('/IncomingPhoneNumbers.json'))
  assert.equal(buy.path, `/2010-04-01/Accounts/${sub}/IncomingPhoneNumbers.json`, 'the number belongs to the business’s subaccount')
  assert.ok(calls.find((c) => c.path.includes('/AvailablePhoneNumbers/')).params.get('AreaCode') === '843', 'local to the business')
  const reg = db.sql.prepare("SELECT status, sender_phone, messaging_service FROM sms_registrations WHERE customer = 'alpha'").get()
  assert.deepEqual([reg.status, reg.sender_phone, reg.messaging_service?.slice(0, 2)], ['pending', '+18435550999', 'MG'])
  assert.deepEqual(smsReadiness(env, await registrationOf(db, 'alpha')).reasons, ['registration_pending'])
  tw.campaignStatus = 'VERIFIED'
  assert.equal((await syncRegistration(env, 'alpha')).status, 'approved')
  assert.equal(smsReadiness(env, await registrationOf(db, 'alpha')).ok, true, 'texting ready only after Twilio verified the campaign')
  // Every admin action is in the permanent audit log.
  assert.ok(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'sms.provision'").get().n >= 9)
  // The admin view has steps and statuses only — no tokens, no EIN, no contact details.
  const view = await call(platformApi, 'GET', '/api/platform/messaging?customer=alpha', { cookie: await admin() })
  assert.equal(view.json().provisioning.next, null)
  assert.ok(!view.text.includes('3456789') && !view.text.includes('pat@alpha') && !view.text.includes('subtok_'))
})

test('sole proprietor (no EIN): starter profile, sole-proprietor trust bundle, SOLE_PROPRIETOR brand with the owner’s one-time code, SOLE_PROPRIETOR campaign', async () => {
  await seed('beta')
  await ownerApproves('beta', SOLE)
  env.TWILIO_REGISTRATION_SUBMIT = 'true'
  assert.equal((await provisioningState(env, 'beta')).path, 'sole_proprietor')
  await step('beta', 'subaccount')
  let i = calls.length
  await step('beta', 'customer_profile')
  const prof = after(i)
  assert.equal(prof.find((c) => c.path === '/v1/CustomerProfiles').params.get('PolicySid'), POLICIES.starter)
  assert.deepEqual(JSON.parse(prof.find((c) => c.params.get('Type') === 'starter_customer_profile_information').params.get('Attributes')), { email: 'sam@beta.example', first_name: 'Sam', last_name: 'Beta', phone_number: '+18435550124' })
  assert.ok(!prof.some((c) => c.params.get('Type') === 'customer_profile_business_information' || c.params.get('Type') === 'authorized_representative_1'), 'no EIN business info for a sole proprietor')
  await step('beta', 'submit_profile', { approve: true })
  i = calls.length
  await step('beta', 'a2p_bundle')
  const bundle = after(i)
  assert.equal(bundle.find((c) => c.path === '/v1/TrustProducts').params.get('PolicySid'), POLICIES.soleProp)
  assert.deepEqual(JSON.parse(bundle.find((c) => c.params.get('Type') === 'sole_proprietor_information').params.get('Attributes')), { brand_name: 'Sam Beta', vertical: 'PROFESSIONAL', mobile_phone_number: '+18435550124' })
  await step('beta', 'submit_bundle', { approve: true })
  await step('beta', 'brand', { approve: true })
  assert.equal(calls.at(-1).params.get('BrandType'), 'SOLE_PROPRIETOR')
  // The owner didn't answer the code in time → ask Twilio to text a new one.
  const otp = await call(platformApi, 'POST', '/api/platform/messaging', { cookie: await admin(), body: { customer: 'beta', action: 'resend_otp', confirm: true } })
  assert.equal(otp.status, 200)
  assert.match(calls.at(-1).path, /^\/v1\/a2p\/BrandRegistrations\/BN[0-9a-f]{32}\/SmsOtp$/)
  tw.brandStatus = 'APPROVED'
  await syncRegistration(env, 'beta')
  await step('beta', 'messaging_service')
  await step('beta', 'campaign', { approve: true })
  assert.equal(calls.at(-1).params.get('UsAppToPersonUsecase'), 'SOLE_PROPRIETOR')
})

test('unknown outcomes are never repeated blindly; a noncompliant profile is never submitted; provider rejection is recorded as Twilio reports it', async () => {
  await seed('alpha')
  await ownerApproves('alpha', LLC)
  env.TWILIO_REGISTRATION_SUBMIT = 'true'
  await step('alpha', 'subaccount')
  // Twilio times out while creating the profile: recorded as unknown, the step stops.
  tw.fail = (c) => (c.path === '/v1/CustomerProfiles' ? [503, { code: 20503 }] : null)
  assert.equal((await step('alpha', 'customer_profile')).json().error, 'unknown_outcome')
  tw.fail = null
  const i = calls.length
  assert.equal((await step('alpha', 'customer_profile')).json().error, 'unknown_outcome', 'not re-sent until an admin checked Twilio')
  assert.equal(calls.length, i)
  assert.deepEqual((await provisioningState(env, 'alpha')).unknown, ['customer_profile'])
  assert.equal((await call(platformApi, 'POST', '/api/platform/messaging', { cookie: await admin(), body: { customer: 'alpha', action: 'clear_unknown', kind: 'customer_profile', confirm: true } })).status, 200)
  // Evaluation fails (e.g. the EIN doesn't match): the failing field is shown; nothing is submitted.
  tw.evaluation = 'noncompliant'
  assert.equal((await step('alpha', 'customer_profile')).json().error, 'profile_noncompliant')
  assert.equal(db.sql.prepare("SELECT detail FROM sms_provider_objects WHERE customer = 'alpha' AND kind = 'profile_evaluation'").get().detail, 'business_registration_number')
  assert.equal((await step('alpha', 'submit_profile', { approve: true })).json().error, 'needs_customer_profile')
  tw.evaluation = 'compliant'
  assert.equal((await step('alpha', 'customer_profile')).status, 200, 'resumes where it stopped (objects already created are reused)')
  assert.equal(calls.filter((c) => c.path === '/v1/CustomerProfiles').length, 2, 'one lost attempt + one real profile; no third')
  await step('alpha', 'submit_profile', { approve: true })
  tw.profileStatus = 'twilio-rejected'
  const r = await syncRegistration(env, 'alpha')
  assert.deepEqual([r.status, r.note], ['rejected', 'profile_rejected'])
})

test('usage per subaccount and account deletion close only that business’s subaccount; admin-only actions', async () => {
  await seed('alpha')
  await ensureSubaccount(env, 'alpha')
  const sub = db.sql.prepare("SELECT account_sid FROM sms_accounts WHERE customer = 'alpha'").get().account_sid
  assert.deepEqual((await syncUsage(env, 'alpha')).count, 42)
  assert.deepEqual({ ...db.sql.prepare("SELECT usage_count, usage_micros FROM sms_accounts WHERE customer = 'alpha'").get() }, { usage_count: 42, usage_micros: 470000 })
  assert.equal(calls.at(-1).path, `/2010-04-01/Accounts/${sub}/Usage/Records/ThisMonth.json`)
  assert.equal((await closeSubaccount(env, 'alpha')).ok, true)
  assert.deepEqual([calls.at(-1).path, calls.at(-1).params.get('Status')], [`/2010-04-01/Accounts/${sub}.json`, 'closed'])
  assert.notEqual(calls.at(-1).path, `/2010-04-01/Accounts/${PARENT}.json`, 'never the parent account')
  // Owners can't run provider actions.
  const owner = await session('owner@alpha.example')
  assert.equal((await call(platformApi, 'POST', '/api/platform/messaging', { cookie: owner, body: { customer: 'alpha', action: 'provision', step: 'subaccount', confirm: true } })).status, 403)
})

test('before migration 0025: no business can text (no_account), owner details still save, provisioning reports not ready', async () => {
  db = d1({ skip: ['0025'] })
  env.ONBOARDING_DB = db
  await seed('alpha')
  await ownerApproves('alpha', LLC)
  assert.ok(smsReadiness(env, await registrationOf(db, 'alpha')).reasons.includes('no_account'))
  assert.equal((await runStep(env, 'alpha', 'subaccount')).error, 'not_ready')
  assert.deepEqual(await provisioningState(env, 'alpha'), { ready: false })
  assert.equal(calls.length, 0, 'no Twilio call')
})
