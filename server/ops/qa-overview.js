// QA Command Center read side: overview, inventory tree, one test, recommendations. Everything is computed from stored
// records; a test with no result is "untested"; counts always carry their total; no percentage is computed here.
import { listCapabilities } from './registry.js'
import { AREAS, allTests, getTest } from './qa-tests.js'
import { countStates, freshness } from './qa-freshness.js'
import { testHistory } from './qa-results.js'
import { evidenceFor } from './qa-evidence.js'
import { ciTime, listExecutions, present as presentExecution } from './qa-executions.js'
import { listItems } from './qa-items.js'
import { qaSettings, spend } from './qa-spend.js'
import { dispatchConfigured, ingestConfigured } from './qa-dispatch.js'
import { JOURNEYS, journeyTitle } from './journeys.js'
import { workflowCommand } from './qa-commands.js'

const DAY = 86_400_000

export function setup(env, settings) {
  const missing = []
  if (!ingestConfigured(env)) missing.push({ id: 'ingest_token', text: 'Add QA_INGEST_TOKEN (Cloudflare secret + GitHub environment secret) so CI results can be posted. See docs/QA_CI_SETUP.md step 2.' })
  if (!dispatchConfigured(env)) missing.push({ id: 'dispatch_token', text: 'Add the Cloudflare secret QA_GITHUB_DISPATCH_TOKEN (fine-grained token, this repository only, Actions: read and write) so runs can be started from here. See docs/QA_CI_SETUP.md step 6.' })
  missing.push({ id: 'workflow', text: 'Copy docs/qa-workflow.yml to .github/workflows/qa.yml (needs Workflows permission) if it isn’t there yet. See docs/QA_CI_SETUP.md step 7.', unverifiable: true })
  const paid = env.QA_PAID_EVALS === 'true' && settings.paid_evals === 1 && settings.eval_daily_micros > 0 && settings.eval_monthly_micros > 0
  return { ciDispatch: dispatchConfigured(env), ingest: ingestConfigured(env), paidEvals: paid, productionChecks: true, missing }
}

function recommendations(tests, statuses, ctx) {
  const st = (t) => statuses.get(t.id)?.status
  const out = []
  const failed = tests.filter((t) => ['failed', 'blocked'].includes(st(t)))
  if (failed.length) out.push({ kind: 'preset', preset: 'failed', title: `Retest ${failed.length} failed or blocked test${failed.length === 1 ? '' : 's'}`, why: `${failed.length} test${failed.length === 1 ? '' : 's'} failed or were blocked at their latest result.`, count: failed.length })
  const stale = tests.filter((t) => (t.kind === 'unit' || t.kind === 'e2e') && st(t) === 'stale')
  if (stale.length) out.push({ kind: 'preset', preset: 'affected', title: `Run ${stale.length} stale test${stale.length === 1 ? '' : 's'}`, why: 'Code or test definitions they depend on changed since they last passed.', count: stale.length })
  const prod = tests.filter((t) => t.kind === 'production')
  // Checks with no result at all on this deployment (a check skipped because its feature is switched off has one).
  const onCommit = (t) => Boolean(ctx.commit && statuses.get(t.id)?.lastAny?.revision && ctx.commit.startsWith(statuses.get(t.id).lastAny.revision))
  const unchecked = prod.filter((t) => !onCommit(t)).length
  if (unchecked) out.push({ kind: 'preset', preset: 'production_verify', title: `Verify production deployment${ctx.commit ? ` ${ctx.commit.slice(0, 7)}` : ''}`, why: `${unchecked} of ${prod.length} production checks have no result on this deployment yet.`, count: prod.length })
  const uncertain = tests.filter((t) => st(t) === 'uncertain')
  if (uncertain.length) out.push({ kind: 'preset', preset: 'all_safe', title: 'Run all safe tests', why: `${uncertain.length} test${uncertain.length === 1 ? '' : 's'} passed on another commit and their impact can’t be determined: a broad run is the reliable check.`, count: tests.filter((t) => t.kind === 'unit' || t.kind === 'e2e').length })
  for (const j of JOURNEYS) {
    const steps = tests.filter((t) => t.kind === 'human' && t.journey === j.id)
    const open = steps.filter((t) => st(t) !== 'verified')
    if (open.length && out.filter((x) => x.kind === 'journey').length < 3) out.push({ kind: 'journey', journey: j.id, title: `Guided check: ${j.title}`, why: open.length === steps.length ? 'Human verification required; not verified on this deployment.' : `${open.length} of ${steps.length} steps not verified on this deployment.`, count: open.length })
  }
  const untestedAuto = tests.filter((t) => (t.kind === 'unit' || t.kind === 'e2e') && st(t) === 'untested')
  if (untestedAuto.length && !out.some((x) => x.preset === 'all_safe')) out.push({ kind: 'preset', preset: 'all_safe', title: 'Run all safe tests', why: `${untestedAuto.length} automated tests have no recorded result yet.`, count: tests.filter((t) => t.kind === 'unit' || t.kind === 'e2e').length })
  return out.slice(0, 8)
}

async function history(db, now) {
  const [ex, releases, runs] = await Promise.all([
    listExecutions(db, { limit: 15 }),
    db.prepare("SELECT at, details FROM audit_log WHERE action = 'platform.release' AND at >= ?1 ORDER BY seq DESC LIMIT 10").bind(now - 90 * DAY).all().catch(() => ({ results: [] })),
    db.prepare("SELECT id, kind, source, status, started_at, revision, provider, summary, journey FROM qa_runs WHERE started_at >= ?1 ORDER BY started_at DESC LIMIT 10").bind(now - 90 * DAY).all().catch(() => ({ results: [] })),
  ])
  const linked = new Set(ex.executions.map((e) => e.runId).filter(Boolean))
  const parse = (s) => {
    try {
      return JSON.parse(s || '{}')
    } catch {
      return {}
    }
  }
  const out = [
    ...ex.executions.map((e) => ({ type: 'execution', id: e.id, environment: e.environment, preset: e.preset, status: e.status, at: e.requestedAt, finishedAt: e.finishedAt, commit: e.commit, progress: e.progress })),
    ...releases.results.map((r) => ({ type: 'release', at: r.at, ...(({ commit, previous, pendingMigrations }) => ({ commit, previous, pendingMigrations }))(parse(r.details)) })),
    ...runs.results.filter((r) => !linked.has(r.id)).map((r) => ({ type: 'run', id: r.id, kind: r.kind, source: r.source, status: r.status, at: r.started_at, commit: r.revision, provider: r.provider, journey: r.journey ? journeyTitle(r.journey) : null, summary: parse(r.summary) })),
  ]
  return out.sort((a, b) => b.at - a.at).slice(0, 25)
}

export async function overview(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const { ctx, statuses, build } = await freshness(env, now)
  const tests = allTests().list
  const byClass = {}
  for (const c of ['automated', 'ai_assisted', 'human', 'authorization']) byClass[c] = countStates(tests.filter((t) => t.class === c), statuses)
  const human = tests.filter((t) => t.kind === 'human')
  const [settings, sp, defects, hist, latestEx, inProgress, ci] = await Promise.all([
    qaSettings(db),
    spend(env, now),
    listItems(db, { group: 'defects', limit: 300 }),
    history(db, now),
    listExecutions(db, { limit: 1 }),
    db.prepare("SELECT id, journey, started_at FROM qa_runs WHERE kind = 'human' AND status = 'running' ORDER BY started_at DESC LIMIT 5").all().catch(() => ({ results: [] })),
    ciTime(db, 10),
  ])
  const blockers = defects.items.filter((i) => ['critical', 'high'].includes(i.severity) && ['open', 'in_progress', 'fixed_pending_qa'].includes(i.status)).map((i) => ({ id: i.id, kind: i.kind, title: i.title, severity: i.severity, priority: i.priority, status: i.status, area: i.area, feature: i.feature, createdAt: i.createdAt, testIds: i.testIds }))
  const runs = []
  for (const r of inProgress.results) {
    const { results } = await db.prepare('SELECT count(*) AS n FROM qa_results WHERE run_id = ?1').bind(r.id).all()
    const total = JOURNEYS.find((j) => j.id === r.journey)?.steps.length ?? 0
    runs.push({ runId: r.id, journey: r.journey, title: journeyTitle(r.journey), done: results[0]?.n ?? 0, total, startedAt: r.started_at })
  }
  const uncertainE2e = tests.filter((t) => statuses.get(t.id)?.status === 'uncertain').length
  return {
    available: true,
    production: { commit: build?.commit ?? null, builtAt: build?.builtAt ?? null, deployment: null, branch: build?.branch ?? null, hashes: Boolean(ctx.hashes) },
    latest: latestEx.executions[0] ?? null,
    counts: countStates(tests, statuses),
    byClass,
    blockers,
    manual: { done: human.filter((t) => statuses.get(t.id)?.status === 'verified').length, total: human.length, inProgress: runs },
    recommended: recommendations(tests, statuses, ctx),
    freshness: {
      release: ctx.release ? { commit: ctx.release.commit ?? null, previous: ctx.release.previous ?? null, at: ctx.release.at } : null,
      stale: tests.filter((t) => statuses.get(t.id)?.status === 'stale').length,
      uncertain: uncertainE2e,
      uncertainNote: uncertainE2e ? `${uncertainE2e} tests passed on another commit and their impact can’t be determined${ctx.hashes ? '' : ' (this deployment has no change-impact hashes)'}: run the regression after a release.` : null,
      hashesAvailable: Boolean(ctx.hashes),
    },
    history: hist,
    spend: sp,
    ciTime: ci,
    setup: setup(env, settings.values),
    settings: settings.values,
  }
}

// Inventory tree: area → journey → feature → tests. Without a filter it stops at features (counts only).
export async function inventory(env, { area = null, q = null, status = null, cls = null, kind = null, detail = false } = {}, now = Date.now()) {
  const { statuses } = await freshness(env, now)
  const all = allTests().list
  const needle = q ? String(q).toLowerCase().slice(0, 80) : null
  const filtered = all.filter((t) => (!area || t.area === area) && (!status || statuses.get(t.id)?.status === status) && (!cls || t.class === cls) && (!kind || t.kind === kind) && (!needle || `${t.title} ${t.id} ${t.file || ''}`.toLowerCase().includes(needle)))
  const leaves = detail || Boolean(area || q || status || cls || kind)
  const caps = new Map(listCapabilities().map((c) => [c.id, c.name]))
  const leaf = (t) => {
    const s = statuses.get(t.id) || { status: 'untested', last: null, lastPass: null }
    return { id: t.id, title: t.title, kind: t.kind, file: t.file, class: t.class, area: t.area, journey: t.journey, feature: t.feature, mobile: Boolean(t.mobile), impact: t.impact, ...(t.blocked ? { blocked: t.blocked } : {}), status: s.status, last: s.last, lastPass: s.lastPass, lastAny: s.lastAny ?? null, ...(t.steps ? { steps: t.steps } : {}) }
  }
  const areas = []
  for (const a of AREAS) {
    const inArea = filtered.filter((t) => t.area === a.id)
    if (!inArea.length || a.id === 'unassigned') continue
    const journeys = []
    for (const jid of [...new Set(inArea.map((t) => t.journey))].sort((x, y) => (x === 'other') - (y === 'other') || x.localeCompare(y))) {
      const inJ = inArea.filter((t) => t.journey === jid)
      const features = []
      for (const fid of [...new Set(inJ.map((t) => t.feature ?? null))]) {
        const inF = inJ.filter((t) => (t.feature ?? null) === fid)
        features.push({ id: fid, name: fid ? caps.get(fid) || fid : 'General', counts: countStates(inF, statuses), testCount: inF.length, ...(leaves ? { tests: inF.map(leaf) } : {}) })
      }
      journeys.push({ id: jid, title: jid === 'other' ? `Other ${a.title.split(',')[0].toLowerCase()} tests` : journeyTitle(jid), counts: countStates(inJ, statuses), features })
    }
    areas.push({ id: a.id, title: a.title, counts: countStates(inArea, statuses), journeys })
  }
  const unassigned = filtered.filter((t) => t.area === 'unassigned')
  // Coverage gaps: capabilities with no automated test and no human result in 90 days; human steps never recorded
  // whose feature has no automated test.
  const autoFeatures = new Set(all.filter((t) => (t.kind === 'unit' || t.kind === 'e2e') && t.feature).map((t) => t.feature))
  const recentHuman = new Set(all.filter((t) => t.kind === 'human' && (statuses.get(t.id)?.lastPass?.at ?? 0) > now - 90 * DAY).map((t) => t.feature))
  const gaps = []
  for (const c of listCapabilities()) if (!autoFeatures.has(c.id) && !recentHuman.has(c.id)) gaps.push({ kind: 'capability', id: c.id, title: c.name, area: allTests().byId.get(`prod:cap:${c.id}`)?.area ?? null, why: 'No automated test maps to it and no human result in the last 90 days.' })
  for (const t of all.filter((x) => x.kind === 'human' && !statuses.get(x.id)?.last && !autoFeatures.has(x.feature))) gaps.push({ kind: 'journey_step', id: t.id, title: t.title, area: t.area, why: 'Human step never recorded; no automated test covers its feature.' })
  return {
    generatedAt: new Date(now).toISOString(),
    platform: { id: 'getshowups', title: 'GetShowUps', counts: countStates(filtered, statuses) },
    areas,
    unassigned: { counts: countStates(unassigned, statuses), files: [...new Set(unassigned.map((t) => t.file).filter(Boolean))], ...(leaves ? { tests: unassigned.map(leaf) } : {}) },
    gaps,
    areaList: AREAS.filter((a) => a.id !== 'unassigned').map((a) => ({ id: a.id, title: a.title })),
    totals: countStates(all, statuses),
  }
}

export async function testDetail(env, id, now = Date.now()) {
  const t = getTest(id)
  if (!t) return null
  const db = env.ONBOARDING_DB
  const { statuses, ctx } = await freshness(env, now)
  const hist = await testHistory(db, t.id, 50)
  const evidence = await evidenceFor(db, 'result', hist.filter((h) => h.source === 'qa').map((h) => h.id))
  const { results } = await db.prepare("SELECT id, kind, title, status, severity FROM qa_items WHERE test_ids LIKE ?1 ORDER BY updated_at DESC LIMIT 20").bind(`%"${t.id}"%`).all()
  const s = statuses.get(t.id) || { status: 'untested' }
  return {
    test: { ...t, pattern: undefined, status: s.status, last: s.last ?? null, lastPass: s.lastPass ?? null, hashes: t.h && ctx.hashes ? ctx.hashes[t.h] ?? null : null, command: workflowCommand(t) },
    history: hist,
    items: results,
    evidence,
  }
}
export { presentExecution }
