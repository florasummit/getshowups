// Plans: what a run WOULD do (scope, environment, estimate, prerequisites, approvals, duplicate notice). No side
// effects. The plan id is a hash of the normalized request + the deployed commit, so /run can tell a plan that changed.
//   smoke              quick CI subset: journey-linked browser tests + the core safety unit files
//   all_safe           every free automated test in CI (all unit + all browser tests)
//   regression         all_safe + the paid evaluations (only with includePaid and the QA budget; else listed as excluded)
//   affected           stale + uncertain automated tests (code they depend on changed, or impact unknown)
//   failed             failed / blocked tests of the chosen environment (retest)
//   manual_continue    guided human steps not verified on this deployment
//   production_verify  every production check (read-only, cron executor)
import { sha256Hex } from '../google-oauth.js'
import { linkedTests } from './journeys.js'
import { allTests, estimate } from './qa-tests.js'
import { freshness } from './qa-freshness.js'
import { dispatchConfigured, ingestConfigured } from './qa-dispatch.js'
import { spend } from './qa-spend.js'

export const PRESETS = ['all_safe', 'smoke', 'regression', 'affected', 'failed', 'manual_continue', 'production_verify']
export const SMOKE_UNIT_FILES = ['test/release.test.js', 'test/dashboard.test.js', 'test/booking-services.test.js', 'test/security-headers.test.js', 'test/ai-budget.test.js', 'test/qa.test.js']
const ID = /^[a-z0-9:._-]{3,120}$/

const envFor = (t) => (t.kind === 'production' ? 'production' : t.kind === 'human' ? 'manual' : 'ci')

function normalize(b) {
  const list = (v, n = 500) => (Array.isArray(v) ? [...new Set(v.map(String))].filter((x) => ID.test(x)).slice(0, n).sort() : [])
  return {
    preset: PRESETS.includes(b?.preset) ? b.preset : null,
    tests: list(b?.tests, 2000),
    journeys: list(b?.journeys, 50),
    areas: list(b?.areas, 30),
    features: list(b?.features, 80),
    environment: ['ci', 'production', 'manual'].includes(b?.environment) ? b.environment : null,
    includePaid: b?.includePaid === true,
  }
}

function select(n, fresh) {
  const all = allTests().list
  const st = (t) => fresh.statuses.get(t.id)?.status || 'untested'
  const picked = new Set()
  const add = (arr) => arr.forEach((t) => picked.add(t))
  const smokeE2e = new Set(linkedTests().map((lt) => `${lt.spec}\u0000${lt.title}`))
  switch (n.preset) {
    case 'smoke':
      add(all.filter((t) => (t.kind === 'unit' && SMOKE_UNIT_FILES.includes(t.file)) || (t.kind === 'e2e' && !t.mobile && [...smokeE2e].some((k) => { const [spec, title] = k.split('\u0000'); return t.file.endsWith(`/${spec}`) && t.title.startsWith(title) }))))
      break
    case 'all_safe':
      add(all.filter((t) => t.kind === 'unit' || t.kind === 'e2e'))
      break
    case 'regression':
      add(all.filter((t) => t.kind === 'unit' || t.kind === 'e2e' || t.kind === 'eval'))
      break
    case 'affected':
      add(all.filter((t) => (t.kind === 'unit' || t.kind === 'e2e') && ['stale', 'uncertain'].includes(st(t))))
      break
    case 'failed':
      add(all.filter((t) => ['failed', 'blocked'].includes(st(t)) && (!n.environment || envFor(t) === n.environment)))
      break
    case 'manual_continue':
      add(all.filter((t) => t.kind === 'human' && st(t) !== 'verified'))
      break
    case 'production_verify':
      add(all.filter((t) => t.kind === 'production'))
      break
    default:
  }
  const byId = allTests().byId
  for (const id of n.tests) if (byId.has(id)) picked.add(byId.get(id))
  if (n.journeys.length) add(all.filter((t) => n.journeys.includes(t.journey)))
  if (n.areas.length) add(all.filter((t) => n.areas.includes(t.area)))
  if (n.features.length) add(all.filter((t) => n.features.includes(t.feature)))
  return [...picked]
}

export async function makePlan(env, body, now = Date.now()) {
  const n = normalize(body)
  const fresh = await freshness(env, now)
  const chosen = select(n, fresh)
  const kinds = new Set(chosen.map(envFor))
  const environment = n.environment || (n.preset === 'failed' && kinds.size > 1 ? 'ci' : kinds.size === 1 ? [...kinds][0] : 'ci')
  const excluded = []
  const tests = []
  for (const t of chosen) {
    if (envFor(t) !== environment) excluded.push({ id: t.id, why: t.kind === 'human' ? 'human_required' : t.kind === 'production' ? 'production_only' : 'ci_only' })
    else if (t.class === 'authorization' && !n.includePaid) excluded.push({ id: t.id, why: 'authorization_required' })
    // The 100-scenario real-model receptionist run isn't wired into the workflow: run it locally and import the report.
    else if (t.suite === 'receptionist_eval') excluded.push({ id: t.id, why: 'local_only' })
    else tests.push(t)
  }
  const commit = fresh.ctx.commit
  const est = estimate(tests, environment)
  const paid = tests.filter((t) => t.class === 'authorization')
  const prerequisites = []
  const approvals = []
  let refusal = null
  if (environment === 'ci') {
    prerequisites.push({ id: 'dispatch_token', ok: dispatchConfigured(env), text: dispatchConfigured(env) ? 'CI can be started from here (QA_GITHUB_DISPATCH_TOKEN set).' : 'QA_GITHUB_DISPATCH_TOKEN is not set (docs/QA_CI_SETUP.md step 6).' })
    prerequisites.push({ id: 'ingest_token', ok: ingestConfigured(env), text: ingestConfigured(env) ? 'Results can be posted back (QA_INGEST_TOKEN set).' : 'QA_INGEST_TOKEN is not set: results could not come back (docs/QA_CI_SETUP.md step 2).' })
    prerequisites.push({ id: 'workflow', ok: null, text: 'The qa.yml workflow can’t be checked from here; a missing workflow makes the start fail visibly.' })
    if (!dispatchConfigured(env)) refusal = { code: 'ci_not_configured', text: 'CI dispatch is not set up: QA_GITHUB_DISPATCH_TOKEN is missing.' }
    else if (!ingestConfigured(env)) refusal = { code: 'ingest_not_configured', text: 'Results can’t come back: QA_INGEST_TOKEN is missing.' }
  }
  if (environment === 'production') prerequisites.push({ id: 'read_only', ok: true, text: 'Read-only checks run by the five-minute job; nothing outside QA records changes.' })
  if (environment === 'manual') prerequisites.push({ id: 'guided', ok: true, text: 'You record each step; use an admin-marked test business where a step needs one.' })
  if (paid.length) {
    const s = await spend(env, now)
    const ok = s.paidEnabled && s.availableMicros >= est.usdMicros
    approvals.push({ id: 'qa_budget', granted: ok, text: `Paid evaluations (${paid.length}): up to $${(est.usdMicros / 1e6).toFixed(2)} from the QA budget ($${(s.availableMicros / 1e6).toFixed(2)} left this month).${s.paidReasons.length ? ` Not allowed now: ${s.paidReasons.join('; ')}.` : ''}` })
    if (!ok && !refusal) refusal = { code: s.paidEnabled ? 'budget_month' : 'paid_off', text: s.paidEnabled ? 'Not enough QA budget left this month for this run.' : `Paid evaluations are off: ${s.paidReasons.join('; ')}.` }
  }
  if (!tests.length && !refusal) refusal = { code: 'empty_scope', text: 'Nothing to run in this environment for that selection.' }
  // Duplicate notice: tests whose latest result already passed on this commit in this environment.
  const dup = tests.filter((t) => {
    const s = fresh.statuses.get(t.id)
    return s?.last?.status === 'pass' && s.last.environment === (environment === 'manual' ? 'manual' : environment) && commit && s.last.revision && commit.startsWith(s.last.revision)
  })
  const lastDup = dup.map((t) => fresh.statuses.get(t.id).last).sort((a, b) => b.at - a.at)[0]
  const duplicate = dup.length ? { count: dup.length, of: tests.length, revision: commit, environment, at: lastDup?.at ?? null, text: `${dup.length} of these ${tests.length} tests already passed on this commit${environment === 'ci' ? ' in CI' : environment === 'production' ? ' in production' : ''}. Confirm to run them again.` } : null
  const count = (k) => Object.fromEntries(k.map((x) => [x, 0]))
  const byKind = count(['unit', 'e2e', 'eval', 'human', 'production'])
  const byClass = count(['automated', 'ai_assisted', 'human', 'authorization'])
  for (const t of tests) {
    byKind[t.kind]++
    byClass[t.class]++
  }
  const planId = `qp_${(await sha256Hex(JSON.stringify({ n, environment, commit, ids: tests.map((t) => t.id).sort() }))).slice(0, 16)}`
  return {
    planId,
    environment,
    preset: n.preset,
    includePaid: n.includePaid,
    commit,
    deployment: null,
    scope: {
      tests: tests.length,
      byKind,
      byClass,
      sample: tests.slice(0, 20).map((t) => ({ id: t.id, title: t.title })),
      journeys: [...new Set(tests.map((t) => t.journey).filter((j) => j && j !== 'other'))],
      files: { unit: [...new Set(tests.filter((t) => t.kind === 'unit').map((t) => t.file))].length, e2e: [...new Set(tests.filter((t) => t.kind === 'e2e').map((t) => t.file))].length },
      excluded: excluded.slice(0, 50),
      excludedCount: excluded.length,
    },
    estimate: est,
    prerequisites,
    approvals,
    duplicate,
    runnable: !refusal,
    refusal,
    _tests: tests,
  }
}
export const publicPlan = ({ _tests, ...p }) => p
