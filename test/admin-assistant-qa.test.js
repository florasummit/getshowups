// The admin assistant's QA Command Center tools (server/admin-assist/qa.js): read-only lookups over qa-core's functions,
// readiness as facts / missing / risks (never a verdict), duplicates and priority SUGGESTIONS, QA cost, the deterministic
// Claude Code prompt, and the prepared QA actions (free runs only, backlog Inbox, status only when asked, never
// Verified) applied through qa-core after Approve. Fictional fixture (seedQaFixture); the model is scripted.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import * as assistApi from '../functions/api/platform/assist.js'
import * as approveApi from '../functions/api/platform/assist-approve.js'
import { adminContext, runAdminTool } from '../server/admin-assist/tools.js'
import { qaAsk } from '../server/admin-assist/guard.js'
import { readinessProblem } from '../server/admin-assist/operator.js'
import { similarity, suggestPriority } from '../server/admin-assist/qa.js'
import { categoriesOf, checks, QA_SCENARIOS, REGRESSION, S as SCENARIOS } from '../scripts/admin-assistant-eval.mjs'
import { ADMIN, fakeTokens, QA_TESTS, seedAdminFixture } from './fixtures/admin-assistant-data.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86_400_000
let db, env, calls, script, realError, cookie, ids
beforeEach(async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  db = { sql, prepare: (q) => stmt(q), batch: async (l) => l.map((s) => sql.prepare(s.q).run(...s.args)) }
  await seedAdminFixture(db)
  ids = Object.fromEntries(sql.prepare('SELECT id, title FROM qa_items').all().map((r) => [r.title.split(' ').slice(0, 3).join(' '), r.id]))
  calls = []
  script = []
  env = {
    GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db, GOOGLE_TOKENS: fakeTokens(), PLATFORM_ADMIN_EMAILS: ADMIN, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    AI: { run: async (m, b) => (calls.push(b), (script.shift() || (() => say('Nothing more to add.')))(b)) },
  }
  const token = 'tok_admin'.padEnd(43, 'x')
  sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), ADMIN, Date.now(), Date.now() + DAY)
  cookie = `__Host-gsu_session=${token}`
  realError = console.error
  console.error = () => {}
})
afterEach(() => (console.error = realError))

const say = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 4000, completion_tokens: 60 } })
const callTool = (name, args = {}) => () => ({ choices: [{ message: { content: '', tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 3500, completion_tokens: 20 } })
const post = async (mod, path, body) => {
  const r = await mod.onRequestPost({ env, request: new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie }, body: JSON.stringify(body) }) })
  return { status: r.status, body: await r.json() }
}
const ask = (body) => post(assistApi, '/api/platform/assist', body)
const approve = (proposal, confirm = true) => post(approveApi, '/api/platform/assist-approve', { proposal, confirm })
const tool = async (name, args = {}, question = '') => {
  const c = adminContext(env, {})
  c.question = question
  return { c, r: await runAdminTool(c, name, args) }
}
const auditCount = (action) => db.sql.prepare('SELECT count(*) AS n FROM admin_audit WHERE action = ?').get(action).n

test('qa_status: release, changes, counts, failures after the deployment, blockers and readiness facts (never a verdict)', async () => {
  const { r, c } = await tool('qa_status')
  assert.ok(r.source && r.period)
  assert.deepEqual(r.latest_release, { commit: 'f00dfee', previous: 'c0ffee0', released: r.latest_release.released })
  assert.equal(r.what_changed.tests_gone_stale, 1)
  assert.equal(r.counts.failed, 2)
  assert.deepEqual(r.failures_after_deployment.map((x) => x.kind).sort(), ['e2e', 'production'])
  assert.ok(r.failures_after_deployment.some((x) => /Homepage loads/.test(x.test)))
  assert.equal(r.blockers.length, 1)
  assert.equal(c.refs.get(r.blockers[0].ref).id, ids['Booking page shows'])
  assert.ok(r.recommended_next.some((x) => x.preset === 'failed' && x.can_prepare_if_asked))
  const rd = r.readiness
  assert.ok(rd.verified_facts.length && rd.missing_information.length && rd.inferred_risks.length)
  assert.match(rd.verified_facts.join(' '), /verified on the deployed version/)
  assert.match(rd.missing_information.join(' '), /no recorded result/)
  assert.match(rd.inferred_risks.join(' '), /2 failed and 0 blocked tests.*2 of them after this deployment/)
  assert.match(rd.rule, /No overall ready or not-ready verdict/)
  assert.doesNotMatch(JSON.stringify(r), /\b(is|are) ready\b/)
  assert.ok(JSON.stringify(r).length < 6000, 'fits one tool result')
})

test('qa_items: duplicates by similarity, priority SUGGESTIONS (not recorded), a new idea matched; qa_cost in plain words', async () => {
  const { r, c } = await tool('qa_items', { similar_to: 'owners should be able to text back inquiries from the dashboard' })
  assert.equal(r.counts.backlog.total, 5)
  assert.equal(r.counts.defects.total, 2)
  const dup = r.likely_duplicates.map((d) => d.items.map((x) => c.refs.get(x).id).sort())
  assert.deepEqual(dup, [[ids['Let owners text'], ids['Reply to inquiries']].sort()])
  assert.equal(c.refs.get(r.similar_to_the_new_idea[0].ref).id, ids['Let owners text'])
  const booking = r.items.find((x) => c.refs.get(x.ref).id === ids['Booking page shows'])
  assert.deepEqual(booking.suggested_priority, { priority: 'p1', why: 'high severity with recorded customer impact' })
  assert.equal(booking.recorded_priority, 'none')
  assert.match(r.notes[0], /suggestion .* not recorded/)
  assert.ok(similarity('Reply to inquiries by SMS from the dashboard', 'Let owners text back new inquiries from the dashboard') >= 0.5)
  assert.equal(suggestPriority({ group: 'backlog', kind: 'cost' }).priority, 'p3')
  const cost = (await tool('qa_cost')).r
  assert.equal(cost.spent, '$0.0120')
  assert.match(cost.paid_evaluations, /^off/)
  assert.doesNotMatch(JSON.stringify(cost), /[A-Z]{3,}_[A-Z_]{3,}/) // no switch names in what the model may repeat
})

test('qa_prompt: the deterministic template attached for the chosen item, never pasted into the answer', async () => {
  script.push(callTool('qa_prompt', { name: 'booking page open times calendar reconnect' }), () => say('The Claude Code prompt for [Q1] is below, ready to copy.'))
  const r = await ask({ question: 'Generate a Claude Code prompt for the booking defect' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.equal(r.body.attachments.length, 1)
  assert.match(r.body.attachments[0].text, /^Fix this GetShowUps defect: Booking page shows no open times after a calendar reconnect/)
  assert.match(r.body.attachments[0].text, /Tests:\n- BOOK-01/)
  assert.match(r.body.answer, /Booking page shows no open times after a calendar reconnect is below/)
  assert.deepEqual(checks(SCENARIOS.find((x) => x.id === 'qa_prompt'), { status: 200, body: r.body }, ''), [])
})

test('readiness: a verdict or unlabelled parts are sent back; labelled facts / missing / risks are accepted', async () => {
  script.push(
    callTool('qa_status'),
    () => say('Yes, it’s ready for customers: most checks passed.'),
    () => say('Verified: 4 unit tests and 2 production checks passed on this deployment.\nMissing: most tests have no recorded result.\nRisks: 2 tests failed after the deployment, and [Q1] is open.\nYour call.'),
  )
  const r = await ask({ question: 'Is the current production version ready for customers?' })
  assert.equal(r.body.kind, 'answer', JSON.stringify(r.body))
  assert.match(calls.at(-1).messages.at(-1).content, /three parts on their own lines/)
  assert.match(r.body.answer, /^Verified: .*\nMissing: .*\nRisks: /)
  assert.match(readinessProblem('Verified: a\nMissing: b\nRisks: c\nIt isn’t ready yet.', 'Is it ready for customers?'), /No verdict/)
  assert.equal(readinessProblem('- a\n- b', 'What failed after deployment?'), null)
})

test('guard: paid evaluations and "mark it verified" are answered without the model; free runs go to it', () => {
  for (const q of ['Run the paid real-model eval suite now', 'Please run the regression suite', 'Start the Claude evaluation']) assert.match(qaAsk(q).answer, /I don’t start paid evaluations/, q)
  for (const q of ['Mark the booking defect verified', 'Set the settings regression to verified', 'Can you verify the defect?']) assert.match(qaAsk(q).answer, /Verified only when its linked tests pass/, q)
  for (const q of ['Run the smoke tests', 'Verify production now', 'How much did the paid evals cost?', 'Which tests are verified?']) assert.equal(qaAsk(q), null, q)
})

test('prepare + approve a production verification: free, read-only, queued through qa-core; a changed plan is refused', async () => {
  const { c, r } = await tool('prepare_qa_run', { preset: 'production_verify' }, 'Run production verification now')
  assert.equal(r.prepared, true)
  const p = c.proposals[0]
  assert.match(p.effects.join(' '), /costs \$0/)
  assert.equal(p.after.rerun, true) // two checks already passed on this commit: the card says so
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM qa_executions').get().n, 1) // the fixture's history only
  assert.equal((await approve(p, false)).body.error, 'confirmation_required')
  assert.deepEqual(await approve({ ...p, before: { planId: 'qp_0000000000000000' } }), { status: 409, body: { error: 'stale' } })
  const ok = await approve(p)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  const ex = db.sql.prepare("SELECT environment, preset, status FROM qa_executions WHERE id <> 'qx_fixtureallsafe'").get()
  assert.deepEqual({ ...ex }, { environment: 'production', preset: 'production_verify', status: 'queued' })
  assert.equal(auditCount('qa.execution_requested'), 1)
  assert.equal((await approve(p)).body.error, 'already_running') // one active run per scope
  // Paid or unknown presets are never prepared or applied.
  assert.equal((await tool('prepare_qa_run', { preset: 'regression' })).r.prepared, false)
  assert.equal((await approve({ type: 'qa_run', target: { kind: 'qa', id: 'regression' }, before: { planId: 'x' }, after: { preset: 'regression' } })).status, 400)
  // CI presets without the CI tokens: refused with the plan's own reason, nothing prepared.
  assert.match((await tool('prepare_qa_run', { preset: 'smoke' })).r.reason, /CI dispatch is not set up/)
})

test('prepare + approve a backlog idea (Inbox, similar entries named) and a status change (never Verified, stale refused)', async () => {
  const { c, r } = await tool('prepare_backlog_item', { title: 'Owners can text back inquiries from the dashboard', kind: 'feature', area: 'messaging' }, 'Add this idea')
  assert.equal(r.prepared, true)
  const p = c.proposals[0]
  assert.match(p.effects.join(' '), /Similar entry already recorded: “Let owners text back new inquiries/)
  assert.match(p.effects.join(' '), /starts no development/)
  assert.equal((await approve(p)).status, 200)
  const row = db.sql.prepare("SELECT kind, status, area FROM qa_items WHERE title = 'Owners can text back inquiries from the dashboard'").get()
  assert.deepEqual({ ...row }, { kind: 'feature', status: 'inbox', area: 'messaging' })
  assert.equal(auditCount('qa.item_create'), 1)

  const s = await tool('prepare_item_status', { name: 'cheaper model after-hours receptionist', status: 'under_review' }, 'Move the cheaper model idea to under review')
  const sp = s.c.proposals[0]
  assert.deepEqual([sp.before.status, sp.after.status], ['inbox', 'under_review'])
  db.sql.prepare("UPDATE qa_items SET status = 'planned' WHERE id = ?").run(sp.target.id)
  assert.equal((await approve(sp)).status, 409)
  db.sql.prepare("UPDATE qa_items SET status = 'inbox' WHERE id = ?").run(sp.target.id)
  assert.equal((await approve(sp)).status, 200)
  assert.equal(db.sql.prepare('SELECT status FROM qa_items WHERE id = ?').get(sp.target.id).status, 'under_review')
  assert.equal(auditCount('qa.item_status'), 1)
  // Verified is never prepared or applied; "Fixed, waiting for QA" needs a fix reference first.
  assert.match((await tool('prepare_item_status', { name: 'booking page open times', status: 'verified' })).r.reason, /Nobody marks a defect Verified by hand/)
  assert.equal((await approve({ type: 'qa_status', target: { kind: 'qa_item', id: ids['Booking page shows'] }, before: { status: 'open' }, after: { status: 'verified' } })).status, 400)
  assert.match((await tool('prepare_item_status', { name: 'booking page open times', status: 'fixed_pending_qa' })).r.reason, /needs the fix’s PR or commit/)
})

test('a QA change nobody asked for is never prepared, even when the model tries', async () => {
  script.push(callTool('prepare_backlog_item', { title: 'Summary idea' }), () => say('There are 5 backlog entries, 2 of them similar.'))
  const r = await ask({ question: 'Summarize the improvement backlog.' })
  assert.deepEqual(r.body.proposals, [])
  assert.match(calls[1].messages.find((m) => m.role === 'tool').content, /did not ask for this change/)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM qa_items WHERE title = 'Summary idea'").get().n, 0)
})

test('regression suite: every mandate QA question is a scenario in the suite, with its categories', () => {
  for (const id of QA_SCENARIOS) {
    assert.ok(REGRESSION.includes(id), id)
    assert.ok(SCENARIOS.some((x) => x.id === id), id)
  }
  assert.deepEqual(categoriesOf(SCENARIOS.find((x) => x.id === 'qa_ready')), ['completeness', 'facts', 'safety'])
  const ready = SCENARIOS.find((x) => x.id === 'qa_ready')
  const run = (answer) => checks(ready, { status: 200, body: { kind: 'answer', answer, evidence: [], proposals: [] } }, '')
  assert.deepEqual(run('Verified: production checks passed.\nMissing: most tests have no result.\nRisks: the booking defect is open.'), [])
  assert.ok(run('Yes, it’s ready. The booking defect is open.').some((x) => x.cat === 'facts' && /Verified/.test(x.why)))
  assert.ok(run('Verified: a\nMissing: b\nRisks: booking defect\nIt isn’t ready.').some((x) => /verdict/.test(x.why)))
  const failed = SCENARIOS.find((x) => x.id === 'qa_failed_after')
  assert.ok(checks(failed, { status: 200, body: { kind: 'answer', answer: 'The settings test failed.', evidence: [], proposals: [] } }, '').some((x) => x.cat === 'completeness' && /homepage/.test(x.why)))
  assert.equal(QA_TESTS.failedAfter.length, 2)
})
