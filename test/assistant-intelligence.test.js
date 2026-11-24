// The intelligence foundation (docs/INTELLIGENCE.md): whole records, checked claims, prepared changes with a life of their own,
// one person across records, one definition, feedback as codes. No model.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { fit, keep } from '../server/fit.js'
import { claimProblem } from '../server/claims.js'
import { addProposal, withdrawProposals } from '../server/proposal-set.js'
import { unanswered } from '../server/insights.js'
import { listThreads } from '../server/followups/engine.js'
import { named, runTool, toolContext } from '../server/operator-tools.js'
import { getCustomer } from '../server/customers.js'
import { customerFromRow } from '../server/auth.js'
import * as feedback from '../functions/api/dashboard/assist-feedback.js'

const DAY = 864e5
let sql, env
beforeEach(async () => {
  sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  env = { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: { prepare: (q) => stmt(q) }, GOOGLE_TOKENS: { get: async () => null } }
  for (const id of ['alpha', 'beta']) {
    sql.prepare("INSERT INTO customers (id, name, timezone, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', 1, 1, 1)").run(id, id)
    sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`o@${id}.example`, id)
    sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(`tok_${id}`.padEnd(43, 'x')), `o@${id}.example`, Date.now(), Date.now() + DAY)
  }
})
const lead = (c, id, o = {}) => sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'x', ?, 1)").run(id, c, o.name || id, o.email || `${id}@x.example`, o.phone || '', o.need || 'Help', o.status || 'new', Date.now() - (o.ago ?? 2) * DAY)
const ctx = async (id) => toolContext(env, customerFromRow(await getCustomer(env.ONBOARDING_DB, id)), {})

test('a large result loses whole records, says how many, and stays readable; text ends with a marker', () => {
  const v = { total: 60, items: Array.from({ length: 60 }, (_, i) => ({ ref: `L${i}`, asked_for: 'x'.repeat(90) })), note: 'kept' }
  const out = JSON.parse(fit(v, 2500))
  const left = out.items.at(-1)
  assert.deepEqual([out.total, out.note, out.items.length - 1 + left.left_out], [60, 'kept', 60])
  assert.ok(fit(v, 2500).length <= 2500)
  assert.equal(v.items.length, 60)
  assert.equal(fit({ a: 1 }, 50), '{"a":1}')
  assert.equal(JSON.parse(fit({ a: 'y'.repeat(500) }, 100)).error, 'too_large')
  assert.match(keep('word '.repeat(50), 60), /word \(text continues\)$/)
  assert.equal(keep('short', 60), 'short')
})

test('what is said about a person must match the record; true, negated, general and several-person sentences pass', () => {
  const now = Date.parse('2026-11-24T20:00:00Z')
  const facts = new Map([
    ['R1', { kind: 'callback', at: now - 26 * 36e5, urgent: true, waiting: true }],
    ['R2', { kind: 'message', at: now - 30 * 36e5, urgent: false, waiting: true }],
    ['L1', { kind: 'inquiry', at: now - 5 * DAY, sender: 'owner', sentAt: 1, waiting: true }],
    ['L2', { kind: 'inquiry', at: now - DAY, waiting: true }],
    ['A1', { kind: 'appointment', at: now - DAY, confirmed: false }],
  ])
  const bad = (t) => claimProblem(t, facts, { now, tz: 'America/New_York' })
  for (const t of ['[R2] is urgent.', '[R2] asked for a phone call.', '[R1] is waiting for a written reply.', '[A1] has confirmed.', 'The message to [L1] was sent automatically.', '[A1] was here last week.', '[R1] has waited the longest.', '[R2] is the oldest item waiting.', '[R1] came in last week.', '[L2] is not a real job.', 'I’d leave it: [L2] looks odd.', 'Nothing has been sent to [L1].', 'No message has gone out to [L1] or [L2].', '[R2] left a note; it may affect [A1]’s visit.', 'Check [R2]’s note before [A1].']) assert.match(String(bad(t)), /About \[/, t)
  for (const t of ['[R2] is not urgent.', '[R1] is urgent.', '[R2] left a message.', '[R1] asked for a call back.', '[A1] has not confirmed.', 'Ask [A1] whether they have confirmed.', '[A1] was here yesterday.', '[R2] has waited longest of the two.', '[L1] has been waiting longest of all items.', 'Both [R1] and [R2] want calls.', 'Call backs are urgent in general.', 'The owner wrote to [L1].', 'Nothing has been sent to [L2].', 'Nothing has been sent to [L1] since Monday.', '[R2] left a note. It names no visit.', 'Part of the text from [L2] looks odd; the request is a liner quote.']) assert.equal(bad(t), null, t)
})

test('prepared changes: own ids, the newer replaces the older, withdrawing touches only what is named, several need a name', () => {
  const c = { pending: [{ id: 'p_aaaaaaaa1', type: 'follow_up', ref: 'L1' }, { id: 'p_aaaaaaaa2', type: 'outcome', ref: 'A1' }], proposals: [], withdrawn: new Set() }
  assert.equal(withdrawProposals(c, {}).error, 'which_one')
  assert.equal(c.withdrawn.size, 0)
  assert.equal(withdrawProposals(c, { which: 'P9' }).error, 'not_waiting')
  assert.deepEqual(withdrawProposals(c, { which: 'P2' }), { withdrawn: 1, still_waiting: 1, note: 'Nothing was changed.' })
  const id = addProposal(c, { type: 'follow_up', ref: 'L1', message: 'newer' })
  assert.deepEqual([[...c.withdrawn].sort(), c.proposals.map((p) => p.pid)], [['p_aaaaaaaa1', 'p_aaaaaaaa2'], [id]])
  addProposal(c, { type: 'follow_up', ref: 'L2', message: 'other' })
  assert.equal(withdrawProposals(c, { which: '[L2]' }).still_waiting, 1)
  assert.equal(withdrawProposals(c, {}).withdrawn, 1)
  assert.equal(withdrawProposals(c, {}).error, 'nothing_waiting')
  const d = { pending: [{ id: 'p_aaaaaaaa1', type: 'x', ref: 'L1' }, { id: 'p_aaaaaaaa2', type: 'y', ref: 'L2' }], proposals: [], withdrawn: new Set() }
  assert.equal(withdrawProposals(d, { all: true }).withdrawn, 2)
})

test('one person across records: exact phone or email in this business only; a shared name is nobody', async () => {
  lead('alpha', 'one', { name: 'Sam Poe', phone: '(843) 555-0199' })
  lead('alpha', 'two', { name: 'S. Poe', phone: '+18435550199' })
  lead('alpha', 'three', { name: 'Sam Poe', phone: '8435550000' })
  lead('beta', 'four', { name: 'Sam Poe', phone: '8435550199' })
  const c = await ctx('alpha')
  const ref = c.refs.ref('L', 'one')
  const r = await runTool(c, 'get_lead', { ref })
  assert.deepEqual(r.same_contact.map((x) => c.refs.id(x).id), ['two'])
  assert.equal((await runTool(c, 'get_lead', { ref: c.refs.ref('L', 'three') })).same_contact, undefined)
})

test('names are matched by their words, not letter by letter; unpaid is calculated', async () => {
  for (const [t, n, ok] of [['n frost', 'N. Frost', true], ['n frost', 'Nell Frost', true], ['frost', 'Nell Frost', true], ['nell', 'Nell Frost', true], ['jose', 'José Núñez', true], ['rost', 'Nell Frost', false], ['n froster', 'Nell Frost', false], ['', 'Nell', false]]) assert.equal(named(t, n), ok, t)
  for (const [id, paid] of [['p1', 9000], ['p2', null]]) {
    lead('alpha', id, { status: 'booked', ago: 6 })
    sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES (?, 'alpha', ?, ?, ?, 'showed', ?, 1, 1)").run(`a-${id}`, id, Date.now() - 3 * DAY - (paid || 1), Date.now(), `e${id}`)
    if (paid) sql.prepare("INSERT INTO revenue_entries (customer, appointment_id, kind, amount_cents, recorded_by, recorded_at) VALUES ('alpha', ?, 'paid', ?, 'ref:x', 1)").run(`a-${id}`, paid)
  }
  const c = await ctx('alpha')
  const l = await runTool(c, 'list_appointments', { state: 'happened_no_payment' })
  assert.deepEqual([l.total, l.items[0].paid_recorded], [1, 'none recorded'])
  assert.equal((await runTool(c, 'business_numbers', { period: 'last_30_days' })).visits_happened_without_recorded_payment, 1)
  assert.equal((await runTool(c, 'find_person', { name: 'P1' })).matches, 1)
  assert.match((await runTool(c, 'find_person', { name: 'Rival Pools' })).note, /only have this business/)
})

test('who sent the last message is read from the record', async () => {
  for (const [id, author, want] of [['o1', 'owner', /by the owner/], ['o2', 'auto', /automatic message/]]) {
    lead('alpha', id)
    sql.prepare("INSERT INTO lead_threads (lead_id, customer, source, stage, last_outbound_at, created_at, updated_at) VALUES (?, 'alpha', 'website_form', 'contacted', ?, 1, 1)").run(id, Date.now())
    sql.prepare("INSERT INTO thread_messages (id, customer, lead_id, direction, channel, author, body, status, created_at, updated_at) VALUES (?, 'alpha', ?, 'out', 'email', ?, 'x', 'sent', ?, 1)").run(`m${id}`, id, author, Date.now())
    const c = await ctx('alpha')
    assert.match((await runTool(c, 'get_lead', { ref: c.refs.ref('L', id) })).message_sent_through_getshowups, want)
  }
})

test('one definition: unanswered and test records count the same for suggestions, the inbox and the assistant', async () => {
  lead('alpha', 'real')
  lead('alpha', 'tst', { email: 'x@getshowups.com' })
  lead('alpha', 'noshow')
  for (const id of ['real', 'tst', 'noshow']) sql.prepare("INSERT INTO lead_threads (lead_id, customer, source, stage, needs_owner, created_at, updated_at) VALUES (?, 'alpha', 'website_form', 'new', 'needs_reply', ?, 1)").run(id, Date.now())
  sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES ('a1', 'alpha', 'noshow', ?, ?, 'no_show', 'e', 1, 1)").run(Date.now() - DAY, Date.now() - DAY + 36e5)
  const c = await ctx('alpha')
  const list = await runTool(c, 'list_leads', { which: 'unanswered' })
  assert.deepEqual([await unanswered(env, c.customer), list.total], [1, 1])
  assert.equal((await listThreads(env, 'alpha')).counts.needsYou, (await runTool(c, 'who_is_waiting', {})).conversations_needing_the_owner)
})

test('feedback: the owner’s own answer, codes only, newest reason wins, nothing else changes', async () => {
  sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES ('ai_ask:abcdefgh12', 'ai_ask', 'alpha', 1, '{\"ok\":true,\"tools\":[],\"model\":\"m\"}')").run()
  const go = async (c, body, origin = 'https://getshowups.com') => (await feedback.onRequestPost({ env, request: new Request('https://getshowups.com/x', { method: 'POST', headers: { Origin: origin, Cookie: `__Host-gsu_session=${`tok_${c}`.padEnd(43, 'x')}` }, body: JSON.stringify(body) }) })).status
  const ok = { id: 'ai_ask:abcdefgh12', reason: 'wrong_fact', text: 'secret words' }
  assert.deepEqual([await go('beta', ok), await go('alpha', ok, 'https://evil.example'), await go('alpha', { ...ok, reason: 'x' }), await go('alpha', { ...ok, id: "ai_ask:' OR 1" })], [404, 403, 400, 400])
  assert.deepEqual([await go('alpha', ok), await go('alpha', { ...ok, reason: 'missing' })], [200, 200])
  const rows = sql.prepare("SELECT props FROM events WHERE type = 'ai_feedback'").all()
  assert.equal(rows.length, 1)
  assert.equal(JSON.parse(rows[0].props).reason, 'missing')
  assert.doesNotMatch(rows[0].props, /secret/)
})

test('a change prepared while the AI is out has an id too; the browser test stand-in knows the instructions by their first words', async () => {
  const { withoutModel } = await import('../server/assist.js')
  const { PROPOSAL_ID } = await import('../server/proposal-set.js')
  const { INSTRUCTIONS } = await import('../server/operator-instructions.js')
  sql.exec("UPDATE customers SET service_zips = '29401' WHERE id = 'alpha'")
  const c = customerFromRow(await getCustomer(env.ONBOARDING_DB, 'alpha'))
  const r = await withoutModel(env, c, { question: 'add 29464 to my zip codes', view: 'settings', refs: {}, history: [] })
  assert.match(r.proposals[0].pid, PROPOSAL_ID)
  assert.ok(INSTRUCTIONS.startsWith('You work inside GetShowUps for the owner'))
  assert.match(readFileSync(new URL('./e2e/mock-google.mjs', import.meta.url), 'utf8'), /You work inside GetShowUps for the owner/)
})

test('acceptance sign-in and run agree: only a named, server-marked test business; the refusal says who, why and what to use', async () => {
  const { ALLOWED, explain, verdict } = await import('../scripts/acceptance/accounts.mjs')
  const me = (id, testBusiness, email = 'x@y.example') => ({ email, customer: id ? { id, name: `${id} name` } : null, testBusiness })
  assert.deepEqual(ALLOWED.map((id) => verdict(me(id, true))), ['ok', 'ok'])
  assert.deepEqual([verdict({}), verdict(me(null, false)), verdict(me('poolthru-llc', false)), verdict(me('poolthru-llc', true)), verdict(me('gsu-journey-test', false)), verdict(me('gsu-journey-test', undefined))], ['signed_out', 'no_business', 'real_business', 'not_allowed', 'real_business', 'real_business'])
  assert.match(explain(me('poolthru-llc', false), 'real_business'), /x@y.example.*Google accepted it.*not a test business.*gsu-journey-test/)
})

test('the specification names only files that exist, and the instructions stay within their budget', async () => {
  const doc = readFileSync(new URL('../docs/INTELLIGENCE.md', import.meta.url), 'utf8')
  for (const [, f] of doc.matchAll(/`((?:server|test|scripts|functions|src|docs)\/[\w./-]+\.(?:js|mjs|md))`/g)) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f)
  const { INSTRUCTIONS } = await import('../server/operator-instructions.js')
  assert.ok(INSTRUCTIONS.split(/\s+/).length <= 1300)
})
