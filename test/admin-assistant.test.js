// The platform-admin assistant (server/admin-assist/): permission separation both ways, no contact details in any lookup,
// test data never revenue, the weekly brief's rules, prepared actions (approval required, state re-checked, existing
// audited functions), the spend ceiling, the off switch and the records-only fallback. Fictional data only
// (test/fixtures/admin-assistant-data.js); the model is scripted here (the real-model evaluation is
// scripts/admin-assistant-eval.mjs).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import * as assistApi from '../functions/api/platform/assist.js'
import * as approveApi from '../functions/api/platform/assist-approve.js'
import * as ownerAssist from '../functions/api/dashboard/assist.js'
import { TOOLS as OWNER_TOOLS } from '../server/operator-tools.js'
import { TOOL_NAMES, TOOLS, adminContext, runAdminTool } from '../server/admin-assist/tools.js'
import { weeklyBrief } from '../server/admin-assist/brief.js'
import { consequentialAsk, ownerDataAsk } from '../server/admin-assist/guard.js'
import { adminProblem, tierProblem } from '../server/admin-assist/operator.js'
import { grade, S as SCENARIOS } from '../scripts/admin-assistant-eval.mjs'
import { ADMIN_DAILY_MICROS } from '../server/admin-assist/data.js'
import { ADMIN, ENROLLMENTS, fakeTokens, seedAdminFixture } from './fixtures/admin-assistant-data.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86_400_000
let db, env, calls, script, realError, cookies
beforeEach(async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  db = { sql, prepare: (q) => stmt(q), batch: async (l) => l.map((s) => sql.prepare(s.q).run(...s.args)) }
  await seedAdminFixture(db)
  calls = []
  script = []
  env = {
    GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db, GOOGLE_TOKENS: fakeTokens(), PLATFORM_ADMIN_EMAILS: ADMIN, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    AI: { run: async (m, b) => (calls.push(b), (script.shift() || (() => say('Nothing more to add.')))(b)) },
  }
  cookies = {}
  const session = async (key, email) => {
    const token = `tok_${key}`.padEnd(43, 'x')
    sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
    cookies[key] = `__Host-gsu_session=${token}`
  }
  await session('admin', ADMIN)
  await session('owner', 'owner@blue-lagoon-pools.example')
  await session('rep', 'rep@getshowups.example')
  sql.prepare("INSERT INTO commercial_roles (email, role, granted_by, granted_at) VALUES ('rep@getshowups.example', 'sales_rep', ?, 1)").run(ADMIN)
  realError = console.error
  console.error = () => {}
})
afterEach(() => (console.error = realError))

const say = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 4000, completion_tokens: 60 } })
const callTool = (name, args = {}) => () => ({ choices: [{ message: { content: '', tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 3500, completion_tokens: 20 } })
const req = (mod, method, who, body, origin = ORIGIN, path = '/api/platform/assist') =>
  mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ env, request: new Request(`${ORIGIN}${path}`, { method, headers: { Origin: origin, ...(who ? { Cookie: cookies[who] } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }) })
const ask = async (who, body, origin) => {
  const r = await req(assistApi, 'POST', who, body, origin)
  return { status: r.status, body: await r.json() }
}
const approve = async (who, body, origin) => {
  const r = await req(approveApi, 'POST', who, body, origin, '/api/platform/assist-approve')
  return { status: r.status, body: await r.json() }
}
const PRIVATE = [/Bank ending/, /owner@/, /8435550/, /Fictional Owner/, /Prefers calls/, /Jordan/, /customer\.example/, /poolpros\.example/, /tradealliance\.example/, /poolpros01/, /riverbend\.example/, /harbor\.example/]

// ---------- permission separation ----------
test('only platform admins reach the admin assistant: owner, sales rep, signed out and cross-origin are refused', async () => {
  for (const who of ['owner', 'rep']) {
    assert.equal((await req(assistApi, 'GET', who)).status, 403)
    assert.equal((await ask(who, { question: 'What needs me this week?' })).status, 403)
    assert.equal((await approve(who, { proposal: { type: 'run_reconciliation', before: {} }, confirm: true })).status, 403)
  }
  assert.equal((await req(assistApi, 'GET', null)).status, 401)
  assert.equal((await ask('admin', { question: 'What needs me this week?' }, 'https://evil.example')).status, 403)
  assert.equal((await approve('admin', { proposal: { type: 'run_reconciliation', before: {} }, confirm: true }, 'https://evil.example')).status, 403)
  assert.equal(calls.length, 0)
})

test('the owner assistant never gains platform tools, and the admin assistant never runs owner tools', async () => {
  const owner = new Set(OWNER_TOOLS.map((t) => t.name))
  assert.deepEqual(TOOL_NAMES.filter((n) => owner.has(n) && n !== 'no_lookup_needed'), [])
  for (const f of ['server/operator.js', 'server/operator-tools.js', 'functions/api/dashboard/assist.js', 'server/assist.js', 'server/assist-plain.js']) assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /admin-assist/, f)
  for (const f of readdirSync(new URL('../server/admin-assist/', import.meta.url))) assert.doesNotMatch(readFileSync(new URL(`../server/admin-assist/${f}`, import.meta.url), 'utf8'), /from '[^']*(operator-tools|\/operator|\.\.\/proposals)\.js'/, f)
  // An owner session on the owner assistant is answered for its own business only: no admin tool is ever offered.
  env.AI_ASSIST_ENABLED = 'true'
  script.push(() => say('ok'))
  await ownerAssist.onRequestPost({ env, request: new Request(`${ORIGIN}/api/dashboard/assist`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookies.owner }, body: JSON.stringify({ question: 'How many businesses are on the platform?' }) }) })
  for (const b of calls) for (const t of b.tools || []) assert.ok(!TOOL_NAMES.includes(t.function.name) || t.function.name === 'no_lookup_needed', t.function.name)
})

// ---------- lookups ----------
test('every lookup names its source and period and never returns contact details or customer text', async () => {
  const c = adminContext(env, {})
  for (const t of TOOLS.filter((x) => !x.name.startsWith('prepare_') && x.name !== 'no_lookup_needed')) {
    for (const args of [{}, { which: 'paying' }, { name: 'harbor' }, { period: 'yesterday' }, { stage: 'stuck' }]) {
      const r = await runAdminTool(c, t.name, args)
      assert.ok(r.source, `${t.name} source`)
      assert.ok(r.period, `${t.name} period`)
      const text = JSON.stringify(r)
      for (const re of PRIVATE) assert.doesNotMatch(text, re, `${t.name} ${JSON.stringify(args)}`)
      assert.doesNotMatch(text, /Blue Lagoon|Sunnyside|Harbor Pool|Coastal Electric/, `${t.name}: names are references`)
    }
  }
})

test('test mode is never revenue, and test businesses are never counted', async () => {
  const c = adminContext(env, {})
  const b = await runAdminTool(c, 'billing', { period: 'this_month' })
  assert.match(b.billing_mode, /test mode/i)
  assert.equal(b.payments_in_period.live_payments, 0)
  assert.match(b.payments_in_period.live_revenue, /none/)
  assert.equal(b.payments_in_period.failed_payments, 1) // the test business's failure is left out
  assert.equal(b.subscriptions_by_status.active, 5) // sandbox-test-co's subscription is not counted
  const n = await runAdminTool(c, 'platform_numbers')
  assert.equal(n.billing.revenue, 'none (test mode is never revenue)')
  assert.equal(n.customers.total, 9)
  const all = await runAdminTool(c, 'business_health', { which: 'all' })
  assert.equal(all.excluded_test_businesses, 1)
  assert.ok(!all.businesses.some((x) => c.refs.get(x.ref).id === 'sandbox-test-co'))
  const paying = await runAdminTool(c, 'business_health', { which: 'paying' })
  assert.ok(paying.businesses.every((x) => /TEST mode/.test(x.billing)))
  // An enrollment the owner hasn't claimed is not a paying customer yet, whatever its subscription says.
  assert.deepEqual(paying.businesses.map((x) => c.refs.get(x.ref).id).sort(), ['blue-lagoon-pools', 'coastal-electric', 'pine-ridge-plumbing', 'sunny-side-spa'])
  const p = await runAdminTool(c, 'partners')
  const pros = p.partners.find((x) => x.referred_businesses === 2)
  assert.equal(pros.commission_owed_live, 'none (live billing off)')
  assert.equal(pros.test_mode_commission_not_owed, '199.60 USD')
  const sys = await runAdminTool(c, 'system_health')
  assert.equal(sys.open_incidents.length, 2)
  assert.equal(sys.open_incidents_on_test_businesses, 1)
})

test('AI spending: recorded costs by feature for the period, own keys apart, ceilings for today', async () => {
  const r = await runAdminTool(adminContext(env, {}), 'ai_spending', { period: 'yesterday' })
  assert.deepEqual(r.paid_by_getshowups.owner_assistant, { uses: 6, cost: '$0.0126' })
  assert.deepEqual(r.paid_by_getshowups.receptionist, { uses: 3, cost: '$0.0135' })
  assert.equal(r.total, '$0.0381')
  assert.equal(r.today_admin_assistant.daily_ceiling, '$0.5000')
})

// ---------- the weekly brief ----------
test('the brief: urgent → important → FYI, each with the page that resolves it; test businesses never appear', async () => {
  const b = await weeklyBrief(env)
  const ids = b.items.map((i) => i.id)
  assert.deepEqual(b.items.map((i) => i.level), [...b.items.map((i) => i.level)].sort((x, y) => ['urgent', 'important', 'fyi'].indexOf(x) - ['urgent', 'important', 'fyi'].indexOf(y)))
  for (const id of ['calendar_disconnected:coastal-electric', 'incident:inc_coastal_cal']) assert.equal(b.items.find((i) => i.id === id)?.level, 'urgent', id)
  for (const id of ['reconciliation:mismatch', `enrollment_stale:${ENROLLMENTS.oak}`, `enrollment_paid:${ENROLLMENTS.lakeside}`, `enrollment_invite_expired:${ENROLLMENTS.harbor}`, 'invite_expiring:invRiverbend0001', 'setup_stalled:maple-street-hvac', 'incidents:minor']) assert.equal(b.items.find((i) => i.id === id)?.level, 'important', id)
  for (const id of ['no_recent_bookings:pine-ridge-plumbing', 'acquisition:followups', 'billing:test_mode']) assert.equal(b.items.find((i) => i.id === id)?.level, 'fyi', id)
  // One item per problem: an unclaimed enrollment's setup, payment and invitation flags are the enrollment's item only.
  assert.ok(!ids.some((i) => /^(calendar_disconnected|setup_stalled|checkout_abandoned|no_owner):(harbor|oak|lakeside)/.test(i)), ids.join(' '))
  assert.ok(!ids.some((i) => i.startsWith('setup_stalled:coastal') || i.startsWith('setup_stalled:riverbend')))
  assert.doesNotMatch(JSON.stringify(b), /Sandbox Test Co|sandbox-test-co|inc_sandbox/)
  for (const i of b.items) assert.match(i.href, /^\/admin(\/(control|sales|growth))?([?#].*)?$/, i.id)
  for (const re of PRIVATE) assert.doesNotMatch(JSON.stringify(b), re)
  assert.equal(calls.length, 0) // no model
  // Test-mode billing moves no money: never an item of its own, never urgent; counted once in the test-mode item.
  assert.ok(!ids.some((i) => /^(past_due|cancel_scheduled|subscription_ended):/.test(i)), ids.join(' '))
  assert.ok(!b.items.some((i) => i.level === 'urgent' && /test/i.test(`${i.title} ${i.detail}`)))
  assert.match(b.items.find((i) => i.id === 'billing:test_mode').detail, /test mode only \(not real money\): 1 failed payment, 1 scheduled cancellation/)
  // Spend near the ceiling is an item of its own.
  db.sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES ('x1', 'admin_ai_ask', NULL, ?, ?)").run(Date.now(), JSON.stringify({ ok: true, costMicros: ADMIN_DAILY_MICROS * 0.85 }))
  assert.ok((await weeklyBrief(env)).items.some((i) => i.id === 'ai:admin' && i.level === 'important'))
})

test('in live billing, a live subscription’s failed payment is urgent; a test-mode one still is not', async () => {
  env.STRIPE_LIVE_ENABLED = 'true'
  db.sql.prepare("UPDATE subscription_modes SET livemode = 1 WHERE customer = 'sunny-side-spa'").run()
  const b = await weeklyBrief(env)
  assert.equal(b.items.find((i) => i.id === 'past_due:sunny-side-spa')?.level, 'urgent')
  assert.ok(!b.items.some((i) => i.id === 'cancel_scheduled:pine-ridge-plumbing')) // Pine Ridge's subscription is test mode
  assert.match(b.items.find((i) => i.id === 'billing:test_mode').detail, /1 scheduled cancellation/)
})

test('GET returns the brief with the assistant off; POST and approve are 404 when off', async () => {
  env.ADMIN_ASSIST_ENABLED = 'false'
  const g = await req(assistApi, 'GET', 'admin')
  const body = await g.json()
  assert.equal(g.status, 200)
  assert.equal(body.enabled, false)
  assert.ok(body.brief.items.length > 5)
  assert.equal((await ask('admin', { question: 'What needs me this week?' })).status, 404)
  assert.equal((await approve('admin', { proposal: { type: 'run_reconciliation', before: { lastAt: null } }, confirm: true })).status, 404)
  assert.equal(calls.length, 0)
})

// ---------- the conversation ----------
test('a question: lookups, an answer in references with names filled in, recorded cost without the question', async () => {
  script.push(callTool('business_health', { which: 'needs_attention' }), (b) => {
    const tool = b.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' ')
    const ref = [...tool.matchAll(/"ref":"(B\d+)"[^}]*payment failed/g)][0]?.[1]
    return say(`[${ref}] has a failed payment in test mode. Check billing with the owner on Overview.`)
  })
  const r = await ask('admin', { question: 'Who has a payment problem?' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.kind, 'answer')
  assert.match(r.body.answer, /^Sunnyside Day Spa has a failed payment in test mode/)
  assert.match(r.body.raw, /^\[B\d+\]/)
  assert.ok(r.body.sources.some((s) => s.tool === 'business_health' && s.period))
  assert.match(calls[0].messages[0].content, /THIS WEEK/)
  assert.equal(calls[0].tool_choice, 'required')
  for (const re of PRIVATE) for (const b of calls) assert.doesNotMatch(JSON.stringify(b), re)
  const ev = db.sql.prepare("SELECT props, customer FROM events WHERE type = 'admin_ai_ask'").all()
  assert.equal(ev.length, 1)
  assert.equal(ev[0].customer, null)
  const props = JSON.parse(ev[0].props)
  assert.equal(props.ok, true)
  assert.ok(props.costMicros > 0)
  assert.doesNotMatch(ev[0].props, /payment problem|Sunnyside/)
})

test('fixed answers without the model: consequential actions and owners’ private records', async () => {
  for (const q of ['Refund Sunnyside’s last payment', 'Suspend Pine Ridge Plumbing', 'please delete the Sandbox Test Co account', 'Turn on live billing', 'Email all owners about the holidays', 'Pause Coastal’s ads']) {
    const r = await ask('admin', { question: q })
    assert.equal(r.body.kind, 'not_here', q)
    assert.match(r.body.answer, /I can prepare only/)
  }
  for (const q of ['What’s the phone number of the owner of Blue Lagoon Pools?', 'Show me the chat transcripts for Coastal Electric', 'What did the customer say in their message?']) assert.equal((await ask('admin', { question: q })).body.kind, 'private', q)
  for (const q of ['Could you give Sunnyside a 50% discount this month?', 'Write and send an email to all owners about holiday hours']) assert.equal((await ask('admin', { question: q })).body.kind, 'not_here', q)
  // "yes" in the chat does nothing: the card's Approve button does.
  for (const q of ['yes do it', 'ok go ahead', 'Approve']) assert.match((await ask('admin', { question: q })).body.answer, /press Approve on the card/, q)
  assert.equal(calls.length, 0)
  for (const q of ['Resend Harbor’s invitation', 'Mark Oak Tree Cleaning as abandoned', 'Run the billing reconciliation', 'Mark Sandbox as not a test business', 'Which paying customers might churn?', 'How many businesses have a phone line?', 'Did anyone cancel this month?']) assert.equal(consequentialAsk(q) || ownerDataAsk(q), null, q)
})

test('a checked answer: invented numbers, typed names, claims of having done something and test-mode money are refused', () => {
  const shown = new Set(['B1'])
  const facts = '{"failed_payments":1,"cost":"$0.0126"}'
  assert.match(adminProblem('[B1] had 7 failed payments.', { facts, shown, live: false }), /not in what you looked up: 7/)
  assert.match(adminProblem('[B2] is fine.', { facts, shown, live: false }), /not looked up: B2/)
  assert.match(adminProblem('Sunnyside Day Spa is late.', { facts, shown, live: false, names: ['Sunnyside Day Spa'] }), /types a name/)
  assert.match(adminProblem('I’ve resent the invitation.', { facts, shown, live: false }), /says something was done/)
  assert.match(adminProblem('Revenue this month was $0.0126.', { facts, shown, live: false }), /test mode/)
  assert.equal(adminProblem('[B1] has 1 failed payment, in test mode. The resend is ready to approve.', { facts, shown, live: false, prepared: 1 }), null)
  assert.match(adminProblem('The resend is ready to approve.', { facts, shown, live: false, prepared: 0 }), /Nothing was prepared/)
  assert.match(adminProblem(Array.from({ length: 8 }, (_, i) => `- line ${i + 1}`).join('\n'), { facts: '1 2 3 4 5 6 7 8', shown, live: false }), /Too many lines/)
  assert.match(adminProblem('Use weekly_brief next time.', { facts, shown, live: false }), /tools/)
})

test('follow-ups: earlier answers are replayed with their lookups, and an answer that doubts them is refused', async () => {
  script.push(callTool('business_health', { ref: 'B1' }), () => say('[B1] is waiting on its calendar. I also need to correct my last message: I listed those without looking them up.'), () => say('[B1] is waiting on its calendar.'))
  const r = await ask('admin', { question: 'What’s holding the first one up?', refs: { B1: 'maple-street-hvac' }, history: [{ q: 'Which businesses haven’t finished setup?', a: '- [B1]: calendar not connected.', looked: ['business_health', 'not_a_tool', 'prepare_test_mark'] }] })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.equal(r.body.answer, 'Maple Street HVAC is waiting on its calendar.')
  const replay = calls[0].messages.find((m) => m.role === 'assistant').content
  assert.match(replay, /written from these lookups, read from the records at the time: business_health\.\)$/) // unknown and prepare tools never replayed
  assert.match(calls.at(-1).messages.at(-1).content, /doubts or corrects an earlier answer/)
})

test('churn: only businesses with a churn signal may be listed', async () => {
  script.push(callTool('business_health', { which: 'paying' }), (b) => {
    const tool = b.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' ')
    const busy = /"ref":"(B\d+)"[^}]*?"churn_signals":\[\]/.exec(tool)[1]
    const risky = /"ref":"(B\d+)"[^}]*?"churn_signals":\["payment failed"/.exec(tool)[1]
    return say(`- [${risky}]: payment failed, in test mode.\n- [${busy}]: no signals.`)
  }, (b) => {
    const tool = b.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' ')
    return say(`- [${/"ref":"(B\d+)"[^}]*?"churn_signals":\["payment failed"/.exec(tool)[1]}]: payment failed, in test mode. The others show no signal.`)
  })
  const r = await ask('admin', { question: 'Which paying customers might churn?' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.doesNotMatch(r.body.answer, /Blue Lagoon/)
  assert.match(calls.at(-1).messages.at(-1).content, /has no churn signal/)
  const at = await runAdminTool(adminContext(env, {}), 'business_health', { which: 'at_risk' })
  assert.ok(at.businesses.length && at.businesses.every((x) => x.churn_signals.length), JSON.stringify(at.businesses.map((x) => x.churn_signals)))
})

test('“what needs me”: every listed item is tier-labelled, one per line, and a stated urgent count matches', async () => {
  // Unlabelled bullets, then a count that doesn't match the Urgent lines, then a correct answer.
  script.push(
    () => say('Two urgent items:\n- Coastal calendar and its incident.\n- Reconciliation mismatch.\n- Oak Tree is stuck.'),
    () => say('Two urgent items:\n- Urgent: Coastal calendar and its incident.\n- Important: Reconciliation mismatch, test mode, no real money.'),
    () => say('Two urgent items:\n- Urgent: Coastal calendar disconnected.\n- Urgent: Coastal incident open.\n- Important: Reconciliation mismatch, test mode, no real money.'),
  )
  const r = await ask('admin', { question: 'What needs me this week?' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.match(r.body.answer, /- Urgent: Coastal calendar disconnected\.\n- Urgent: Coastal incident open\./)
  const backs = calls.slice(1).map((b) => b.messages.at(-1).content)
  assert.match(backs[0], /Label every listed item with its tier/)
  assert.match(backs[1], /says Two urgent but lists 1 line/)
  // Pure rule: a follow-up that isn't about the list may use plain bullets; any answer that mentions "urgent" may not.
  assert.equal(tierProblem('- one\n- two', 'Which enrollments are stuck?'), null)
  assert.match(tierProblem('The urgent one:\n- one', 'Is anything broken?'), /Label every listed item/)
  assert.equal(tierProblem('- FYI: one\n- Important: two', 'what needs me'), null)
})

test('“what needs me” cut off: the retry asks for fewer items (urgent + top 3 important + one count line), then it is accepted', async () => {
  const cut = { choices: [{ message: { content: '- Urgent: one\n- Urgent: two\n- Important: three' }, finish_reason: 'length' }], usage: { prompt_tokens: 3000, completion_tokens: 1600 } }
  script.push(
    (b) => (assert.equal(b.max_tokens, 1600), cut),
    () => say('- Urgent: [B2]’s calendar is disconnected; ask the owner to reconnect it (Overview).\n- Important: Oak Tree Cleaning’s payment link is unpaid (Sales).'),
  )
  const r = await ask('admin', { question: 'What needs me this week?' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.match(calls[1].messages.at(-1).content, /list fewer items\. Give every urgent item and at most the 3 most important others, one line each under 30 words, then one closing line/)
  // The brief in front of the model names the business apart from the issue (no "…: Coastal Electric" titles).
  assert.match(calls[0].messages[0].content, /- urgent: \[B\d+\] — Calendar disconnected\./)
  assert.doesNotMatch(calls[0].messages[0].content, /serving business/)
})

test('the grader reads tiers from the labels: unlabelled fails, Urgent test-mode billing fails, a mismatched count fails', () => {
  const week = SCENARIOS.find((x) => x.id === 'week')
  const g = (answer) => grade(week, { status: 200, body: { kind: 'answer', answer, evidence: [], proposals: [] } }, '')
  const run5 = 'One urgent item:\n- Urgent: Coastal Electric: calendar disconnected; ask the owner to reconnect (Overview).\n- Important: Billing records don’t match Stripe for 1 real business; Stripe is in test mode, so no real money is affected (Overview).'
  assert.deepEqual(g(run5), [])
  assert.ok(g('Two urgent items:\n- Coastal Electric: calendar disconnected.\n- Reconciliation mismatch.').some((w) => /without a tier label/.test(w)))
  assert.ok(g('Two urgent items:\n- Urgent: Coastal Electric calendar and incident.').some((w) => /says Two urgent but labels 1/.test(w)))
  assert.ok(g('- Urgent: Coastal Electric calendar.\n- Urgent: Sunnyside payment failed in test mode.').some((w) => /Urgent line is about test-mode billing/.test(w)))
})

test('the model failing or failing its checks: the records are shown, never a guess', async () => {
  env.AI.run = async () => {
    throw new Error('3040: capacity')
  }
  const r = await ask('admin', { question: 'How are we doing?' })
  assert.equal(r.body.kind, 'records')
  assert.ok(['busy', 'unavailable'].includes(r.body.aiOut))
  assert.ok(r.body.brief.items.length > 5)
  env.AI.run = async (m, b) => (calls.push(b), say('We have 4,812 customers.'))
  const u = await ask('admin', { question: 'How many customers do we have?' })
  assert.equal(u.body.kind, 'records')
  assert.equal(u.body.aiOut, 'unchecked')
  assert.ok(calls.length >= 3) // first draft + two corrections, then the records
  assert.match(calls.at(-1).messages.at(-1).content, /\[check by the application\].*4,812/)
})

test('in test mode, an answer about money or paying customers always says so (added by the application)', async () => {
  script.push(callTool('billing', { period: 'this_month' }), () => say('Four subscriptions are active and one payment failed.'))
  const r = await ask('admin', { question: 'How many customers are paying?' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.match(r.body.answer, /Billing is in Stripe test mode: nobody pays real money yet/)
})

test('a change nobody asked for is never prepared, even when the model tries', async () => {
  script.push(callTool('prepare_run_reconciliation'), () => say('Billing reconciliation found 1 issue on a real business; it is on Overview.'))
  const r = await ask('admin', { question: 'What needs me this week?' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.deepEqual(r.body.proposals, [])
  assert.match(calls[1].messages.find((m) => m.role === 'tool').content, /did not ask for this change/)
})

test('on Claude (production), every call reserves the admin_assistant budget on the GetShowUps business', async () => {
  env.OPERATOR_PROVIDER = 'claude'
  env.OPERATOR_ANTHROPIC_API_KEY = 'sk-ant-test-not-a-key'
  const replies = [
    { content: [{ type: 'tool_use', id: 't1', name: 'billing', input: { period: 'this_month' } }], stop_reason: 'tool_use', usage: { input_tokens: 3000, output_tokens: 20 } },
    { content: [{ type: 'text', text: 'One payment failed this month, in test mode.' }], stop_reason: 'end_turn', usage: { input_tokens: 3200, output_tokens: 20 } },
  ]
  env.ANTHROPIC_CLIENT = { messages: { create: async () => replies.shift() } }
  const r = await ask('admin', { question: 'Did any payment fail this month?' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  const keys = db.sql.prepare("SELECT key, count FROM rate_limits WHERE key LIKE 'aib:%'").all()
  assert.ok(keys.some((k) => k.key.startsWith('aib:entry:admin_assistant:getshowups:') && k.count > 0), JSON.stringify(keys))
  assert.ok(keys.some((k) => k.key.startsWith('aib:biz:getshowups:')))
  // The spending guard switched off for GetShowUps → no model call, the records instead.
  env.AI_OFF_BUSINESSES = 'getshowups'
  env.ANTHROPIC_CLIENT = { messages: { create: async () => assert.fail('no call when the guard refuses') } }
  const off = await ask('admin', { question: 'Did any payment fail this month?' })
  assert.equal(off.body.kind, 'records')
})

test('the spend ceiling: at the admin assistant’s daily ceiling no model is called and the records are shown', async () => {
  db.sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES ('x1', 'admin_ai_ask', NULL, ?, ?)").run(Date.now(), JSON.stringify({ ok: true, costMicros: ADMIN_DAILY_MICROS }))
  const r = await ask('admin', { question: 'What needs me this week?' })
  assert.equal(r.body.kind, 'records')
  assert.equal(r.body.aiOut, 'spending')
  assert.equal(calls.length, 0)
})

// ---------- prepared actions ----------
const prepared = async (tool, args, refs = {}) => {
  const c = adminContext(env, refs)
  await runAdminTool(c, 'enrollments', {})
  await runAdminTool(c, 'business_health', { which: 'all' })
  const r = await runAdminTool(c, tool, args(c))
  return { c, r, p: c.proposals[0] }
}
const refOf = (c, id) => [...c.refs].find(([, v]) => v.id === id)?.[0]
const auditCount = (action) => db.sql.prepare('SELECT count(*) AS n FROM admin_audit WHERE action = ?').get(action).n

test('preparing changes nothing; Approve needs confirm, re-checks the records and uses the audited functions', async () => {
  const stage = () => db.sql.prepare('SELECT stage FROM assisted_enrollments WHERE id = ?').get(ENROLLMENTS.oak).stage
  const { r, p } = await prepared('prepare_mark_abandoned', (c) => ({ ref: refOf(c, ENROLLMENTS.oak) }))
  assert.equal(r.prepared, true)
  assert.equal(stage(), 'payment_sent') // nothing happened yet
  assert.equal((await approve('admin', { proposal: p })).body.error, 'confirmation_required')
  // Changed meanwhile → stale, nothing done.
  db.sql.prepare("UPDATE assisted_enrollments SET stage = 'prospect' WHERE id = ?").run(ENROLLMENTS.oak)
  assert.deepEqual(await approve('admin', { proposal: p, confirm: true }), { status: 409, body: { error: 'stale' } })
  db.sql.prepare("UPDATE assisted_enrollments SET stage = 'payment_sent' WHERE id = ?").run(ENROLLMENTS.oak)
  const ok = await approve('admin', { proposal: p, confirm: true })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(stage(), 'abandoned')
  assert.equal(auditCount('enrollment.abandoned'), 1)
  assert.equal((await approve('admin', { proposal: p, confirm: true })).body.already, true) // a second press changes nothing
  assert.equal(auditCount('enrollment.abandoned'), 1)
})

test('resend an invitation: a business’s owner invitation and an enrollment’s ownership invitation', async () => {
  const { p } = await prepared('prepare_resend_invitation', (c) => ({ ref: refOf(c, 'riverbend-landscaping') }))
  assert.equal(p.type, 'resend_invitation')
  assert.deepEqual(p.target, { kind: 'business', id: 'riverbend-landscaping' })
  const ok = await approve('admin', { proposal: p, confirm: true })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(auditCount('invite.resend'), 1)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM account_invites WHERE customer = 'riverbend-landscaping' AND revoked_at IS NULL AND accepted_at IS NULL").get().n, 1)
  assert.equal((await approve('admin', { proposal: p, confirm: true })).status, 409) // the reviewed invitation was replaced
  // Harbor's business reference leads to its enrollment (an ownership invitation, never a plain owner invite).
  const h = await prepared('prepare_resend_invitation', (c) => ({ ref: refOf(c, 'harbor-pool-care') }))
  assert.deepEqual(h.p.target, { kind: 'enrollment', id: ENROLLMENTS.harbor })
  // A business with an owner has nothing to resend.
  const b = await prepared('prepare_resend_invitation', (c) => ({ ref: refOf(c, 'blue-lagoon-pools') }))
  assert.equal(b.r.prepared, false)
  assert.equal(b.c.proposals.length, 0)
})

test('test marks, tracking codes and reconciliation; never for real-by-definition businesses; unknown types refused', async () => {
  const t = await prepared('prepare_test_mark', (c) => ({ ref: refOf(c, 'blue-lagoon-pools'), test: true }))
  assert.equal((await approve('admin', { proposal: t.p, confirm: true })).status, 200)
  assert.equal(db.sql.prepare("SELECT is_test FROM test_businesses WHERE customer = 'blue-lagoon-pools'").get().is_test, 1)
  assert.equal(auditCount('customer.test_mark'), 1)
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('poolthru-llc', 'PoolThru', 'America/New_York', 1, 1)").run()
  const pt = await prepared('prepare_test_mark', (c) => ({ ref: c.ref('B', 'poolthru-llc', 'PoolThru'), test: true }))
  assert.equal(pt.r.prepared, false)
  assert.equal((await approve('admin', { proposal: { type: 'test_mark', target: { kind: 'business', id: 'poolthru-llc' }, before: { test: false }, after: { test: true } }, confirm: true })).status, 403)
  const code = await prepared('prepare_code_status', () => ({ code: 'out-01', status: 'followed_up' }))
  assert.equal(code.p.before.status, 'sent')
  assert.equal((await approve('admin', { proposal: code.p, confirm: true })).status, 200)
  assert.equal(db.sql.prepare("SELECT status FROM acquisition_codes WHERE code = 'out-01'").get().status, 'followed_up')
  assert.equal(auditCount('acquisition.code_updated'), 1)
  const rec = await prepared('prepare_run_reconciliation', () => ({}))
  assert.equal(rec.p.type, 'run_reconciliation')
  for (const type of ['suspend', 'delete_account', 'refund', 'send_email']) assert.equal((await approve('admin', { proposal: { type, target: { kind: 'business', id: 'sunny-side-spa' }, before: {} }, confirm: true })).status, 400, type)
})
