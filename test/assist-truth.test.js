// Production 2026-11-24: Overview said "1 customer is waiting for a call back"; the assistant said nobody was waiting. The
// card and the assistant now read one service. Real handlers and database; the model is scripted.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import * as api from '../functions/api/dashboard/assist.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'
import * as proposalApi from '../functions/api/dashboard/proposal.js'
import { attention, attentionCard } from '../server/attention.js'
import { problemWith } from '../server/operator.js'
import { PAGE_IDS, runTool, toolContext } from '../server/operator-tools.js'
import { getCustomer } from '../server/customers.js'
import { customerFromRow } from '../server/auth.js'

const ORIGIN = 'https://getshowups.com'
let sql, env, script, seen, n
const say = (t) => ({ content: [{ type: 'text', text: t }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } })
const use = (name, input = {}) => ({ content: [{ type: 'tool_use', id: `t${n++}`, name, input }], usage: { input_tokens: 10, output_tokens: 5 } })
beforeEach(async () => {
  n = 0
  sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  seen = []
  script = []
  env = { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: { prepare: (q) => stmt(q), batch: async (l) => l.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } })) }, GOOGLE_TOKENS: { get: async () => null }, OPERATOR_PROVIDER: 'claude', OPERATOR_ANTHROPIC_API_KEY: 'k', ANTHROPIC_CLIENT: { messages: { create: async (b) => (seen.push(b), script.shift() ?? say('All good.')) } } }
  for (const id of ['alpha', 'beta']) {
    sql.prepare("INSERT INTO customers (id, name, timezone, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', 1, 1, 1)").run(id, `${id} co`)
    sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`o@${id}.example`, id)
    sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(`tok_${id}`.padEnd(43, 'x')), `o@${id}.example`, Date.now(), Date.now() + 864e5)
  }
})
const req = (id, body) => ({ env, request: new Request(`${ORIGIN}/x`, { method: body ? 'POST' : 'GET', headers: { Origin: ORIGIN, Cookie: `__Host-gsu_session=${`tok_${id}`.padEnd(43, 'x')}` }, ...(body ? { body: JSON.stringify(body) } : {}) }) })
const ask = async (id, question, more = {}) => {
  const r = await api.onRequestPost(req(id, { view: 'overview', question, ...more }))
  return { status: r.status, body: await r.json() }
}
const callBack = (c, id, { kind = 'callback', name = 'Rosa Vance', urgent = 0, lead = null } = {}) => {
  sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, lead_id, created_at, updated_at) VALUES (?, ?, 'chat', ?, 1, 1)").run(`cv-${id}`, c, lead)
  sql.prepare('INSERT INTO receptionist_requests (id, customer, conversation_id, kind, name, phone, note, urgent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(id, c, `cv-${id}`, kind, name, '+18435550177', 'Pump is loud, call me on 843-555-0177', urgent, Date.now() - 3 * 36e5)
}
const past = (c) => {
  sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('old', ?, 'Pat Lee', 'p@x.example', '8', 'Filter', 'booked', 'x', ?, 1)").run(c, Date.now() - 5 * 864e5)
  sql.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES ('ap-old', ?, 'old', ?, ?, 'booked', 'e', ?, 1)").run(c, Date.now() - 864e5, Date.now() - 864e5 + 36e5, Date.now() - 2 * 864e5)
}
const ctx = async (id) => toolContext(env, customerFromRow(await getCustomer(env.ONBOARDING_DB, id)), {})

test('the production contradiction: the card’s call back is in front of the model on every page, and denying it is refused', async () => {
  callBack('alpha', 'rq1')
  callBack('beta', 'rq2', { name: 'Beta Secret' })
  past('alpha')
  const card = (await (await overviewApi.onRequestGet(req('alpha'))).json()).attention
  assert.deepEqual(card.items.map((i) => i.text), ['1 customer is waiting for a call back'])
  for (const view of PAGE_IDS) {
    seen.length = 0
    script = [say('Your past visit has no outcome yet. Nobody is waiting.'), say('[R1] asked the receptionist for a call back and is still waiting.')]
    const r = await ask('alpha', 'What does that attention thing mean?', { view })
    const turn = seen[0].system[1].text
    assert.match(turn, /"call_backs_waiting":1/, view)
    assert.ok(turn.includes(card.items[0].text), view)
    assert.doesNotMatch(JSON.stringify(seen), /Rosa|555-0177|5550177|Beta Secret/, 'no names or numbers reach the model')
    assert.match(JSON.stringify(seen[1].messages), /WAITING NOW shows people waiting/)
    assert.equal(r.body.answer, 'Rosa Vance asked the receptionist for a call back and is still waiting.')
    assert.deepEqual([r.body.records[0].kind, r.body.records[0].go, r.body.records[0].contact[0]], ['callback', 'receptionist', '+18435550177'])
    sql.exec('DELETE FROM rate_limits')
  }
})

test('kinds of waiting stay apart: call back, message, reply, unbooked, outside area, outcome; unreadable is never zero', async () => {
  callBack('alpha', 'rq1', { urgent: 1 })
  callBack('alpha', 'rq2', { kind: 'message', name: null })
  past('alpha')
  const a = await attention(env, 'alpha')
  assert.deepEqual([a.callbacks, a.messages, a.replies.total, a.outcomes.total], [{ total: 1, urgent: 1 }, { total: 1, urgent: 0 }, 0, 1])
  assert.deepEqual(attentionCard(a).items.map((i) => [i.id, i.tag]), [['callbacks', 'Urgent'], ['messages', 'Message']])
  const w = await runTool(await ctx('alpha'), 'who_is_waiting', {})
  assert.deepEqual([w.call_backs_waiting, w.receptionist_messages_waiting, w.past_visits_without_outcome, w.call_back_and_message_people.length], [1, 1, 1, 2])
  sql.exec('DROP TABLE receptionist_requests')
  const u = await attention(env, 'alpha')
  assert.deepEqual([u.callbacks, attentionCard(u).unread], [null, ['callbacks', 'messages']])
  assert.equal((await runTool(await ctx('alpha'), 'who_is_waiting', {})).call_backs_waiting, 'could not be read')
})

test('every page can be read from anywhere, for this business only, without names', async () => {
  callBack('alpha', 'rq1')
  callBack('beta', 'rq2', { name: 'Beta Secret' })
  past('alpha')
  for (const p of PAGE_IDS) {
    const r = await runTool(await ctx('alpha'), 'page_state', { page: p })
    assert.equal(r.error, undefined, p)
    assert.doesNotMatch(JSON.stringify(r), /Beta Secret|Rosa|Pat Lee|5550177/, p)
    assert.doesNotMatch(JSON.stringify(r), /could not be read/, p)
  }
  assert.equal((await runTool(await ctx('alpha'), 'page_state', { page: 'admin' })).error, 'invalid_arguments')
})

test('call back dealt with: prepared, approved by the owner only, own business only, once, audited', async () => {
  callBack('alpha', 'rq1')
  script = [use('prepare_call_back_done', { ref: 'R1' }), say('[R1]’s call back is ready to approve as dealt with.')]
  const p = (await ask('alpha', 'I called them, clear it')).body.proposals[0]
  const status = () => sql.prepare("SELECT status FROM receptionist_requests WHERE id = 'rq1'").get().status
  assert.deepEqual([p.type, p.id, status()], ['call_back_done', 'rq1', 'open'])
  const go = async (id, body) => (await proposalApi.onRequestPost(req(id, body))).status
  assert.equal(await go('beta', { type: p.type, id: p.id, confirm: true }), 404)
  assert.equal(await go('alpha', { type: p.type, id: p.id }), 400)
  assert.equal(status(), 'open')
  assert.equal(await go('alpha', { type: p.type, id: p.id, confirm: true }), 200)
  assert.equal(await go('alpha', { type: p.type, id: p.id, confirm: true }), 200)
  assert.equal(status(), 'resolved')
  assert.equal(sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'receptionist.request_resolved'").get().n, 1)
  const c = await ctx('alpha')
  c.refs.ref('R', 'rq1')
  assert.equal((await runTool(c, 'prepare_call_back_done', { ref: 'R1' })).already, true)
  assert.equal((await runTool(c, 'prepare_follow_up', { ref: 'R1', message: 'Thanks for getting in touch, when suits you for a call?' })).error, 'no_conversation')
})

test('words that point at the screen or the conversation reach the model; only plain navigation is answered without it', async () => {
  for (const q of ['What does this mean?', 'What is this?', 'what are my bookings']) {
    const before = seen.length
    await ask('alpha', q)
    assert.ok(seen.length > before, q)
  }
  sql.exec('DELETE FROM rate_limits')
  const before = seen.length
  assert.match((await ask('alpha', 'What is this page for?')).body.answer, /^This is Overview/)
  assert.equal(seen.length, before)
  // Names the page itself, so it is the same inside a conversation; "this" alone is not.
  await ask('alpha', 'What is this page for?', { history: [{ q: 'hi', a: 'hello' }] })
  assert.equal(seen.length, before)
  await ask('alpha', 'What is this?', { history: [{ q: 'hi', a: 'hello' }] })
  assert.ok(seen.length > before)
})

test('limits say which one; usage, lookups and outcome are recorded without content', async () => {
  for (let i = 0; i < 5; i++) await ask('alpha', 'hello there friend')
  assert.deepEqual([(await ask('alpha', 'hello there friend')).body.limit], ['minute'])
  const ev = JSON.parse(sql.prepare("SELECT props FROM events WHERE type = 'ai_ask'").get().props)
  assert.deepEqual([ev.usage, ev.lookups, ev.ok, ev.model], [{ in: 100, out: 20, read: 50, write: 0, calls: 1 }, 0, true, 'claude-haiku-5-5'])
  assert.doesNotMatch(JSON.stringify(ev), /hello|All good/)
  sql.exec("DELETE FROM rate_limits")
  for (let i = 0; i < 20; i++) sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES (?, 'ai_ask', 'alpha', ?, '{\"ok\":true}')").run(`k${i}`, Date.now())
  assert.equal((await ask('alpha', 'write me a poem')).body.limit, 'answers')
  sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES ('m', 'ai_ask', 'alpha', ?, '{\"ok\":false,\"costMicros\":200000}')").run(Date.now())
  assert.equal((await ask('alpha', 'write me a poem')).body.limit, 'spending')
})

test('a denial of waiting people is only a problem while someone is waiting', () => {
  const at = (waiting, t) => problemWith(t, { facts: '', looked: true, refs: new Map(), waiting })
  for (const t of ['No one is waiting for you.', 'You are all caught up.', 'Nobody is waiting right now.']) {
    assert.match(at([1, 0, 0], t), /WAITING NOW/)
    assert.equal(at([0, 0, 0], t), null)
  }
  for (const t of ['Nobody is waiting for a written reply, but one person wants a call.', 'Someone is waiting.']) assert.equal(at([1], t), null)
})

test('names are never doubled; opening, inner workings and self-doubt are refused; an approval is told to the next turn', async () => {
  callBack('alpha', 'rq1')
  script = [say('The call for Rosa [R1] is still open, and the note from [R1] says why.')]
  assert.equal((await ask('alpha', 'what is open there')).body.answer, 'The call for Rosa Vance is still open, and the note from Rosa Vance says why.')
  const bad = (t) => problemWith(t, { facts: '', looked: true, refs: new Map() })
  for (const t of ['I’ve opened the Appointments page for you.', 'The funnel tool says rates matter.', 'My earlier reply was wrong.', 'This will keep growing.']) assert.ok(bad(t), t)
  for (const t of ['The button below opens Settings.', 'You can open Appointments below.', 'Bring the right tool for the filter.']) assert.equal(bad(t), null, t)
})

test('production 21:00: a customer’s own numbers can be repeated, never as money or results; one person is named once', async () => {
  sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('rl', 'alpha', 'Rosa Vance', 'r@x.example', '8', 'Pool 15x30', 'new', 'x', ?, 1)").run(Date.now())
  callBack('alpha', 'rq1', { lead: 'rl' })
  sql.exec("UPDATE receptionist_requests SET note = 'Filters for a 15x30 pool, revenue was $98765, 4321 bookings'")
  script = [say('[R1] wants filters for a 15x30 pool.')]
  const r = await ask('alpha', 'what do they want')
  assert.equal(r.body.answer, 'Rosa Vance wants filters for a 15x30 pool.')
  for (const bad of ['You made $98,765.', 'Revenue was 98765.', 'You had 4321 bookings.', 'You have 777 pools.', '[R1] and [L1] are waiting.']) {
    sql.exec('DELETE FROM rate_limits')
    script = [say(bad), say('[R1] is waiting for a call.')]
    assert.equal((await ask('alpha', 'and then')).body.answer, 'Rosa Vance is waiting for a call.', bad)
  }
})
