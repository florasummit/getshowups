// QA history (migration 0032): automated Playwright runs + guided human QA, on the journey ids of ./journeys.js.
// Automated: scripts/qa-report.mjs posts a run (revision, source, provider, artifacts URL, per-test results); only
// registry-linked tests and failures are stored (bounded). Human: an observer (platform admin) records each step's
// observed result, status, context answers, and separate defects/improvements; timed journeys (activation) get
// server-side step times. Never fabricated: an activation measurement exists only when an observer finished a run.
import { randomToken } from '../google-oauth.js'
import { emailRef } from '../auditlog.js'
import { listIncidents } from './incidents.js'
import { JOURNEYS, RESULT_STATES, journey as journeyDef, linkedTests, matchTest, testId } from './journeys.js'

const DAY = 86400000
export const AUTOMATED_RETENTION_MS = 90 * DAY
export const HUMAN_RETENTION_MS = 365 * DAY
export const MAX_RESULTS = 400

// Free text from people or test output: strip ANSI/control chars, redact emails, phone numbers and bearer/secret-like
// tokens, cap length.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const printable = (s) => [...s].filter((ch) => ch >= ' ' || ch === '\n' || ch === '\t').join('')
export function redact(s, max = 500) {
  // Order matters: tokens first (they contain digit runs), then emails, then phone numbers.
  return printable(String(s ?? '').replace(ANSI, ''))
    .replace(/\b(Bearer\s+)?[A-Za-z0-9_-]{32,}/g, '[token]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]')
    .slice(0, max)
}

export async function qaReady(db) {
  try {
    await db.prepare('SELECT 1 FROM qa_runs LIMIT 1').first()
    return true
  } catch {
    return false
  }
}

const STATUS_MAP = { passed: 'pass', expected: 'pass', failed: 'fail', unexpected: 'fail', timedOut: 'fail', interrupted: 'blocked', skipped: 'not_tested' }

// body: { revision, source: 'ci'|'local', provider: 'mocked'|'real', artifactsUrl?, startedAt?, results: [{ file, title,
// project?, status, durationMs?, error? }] } → stored run id. Validated, bounded, redacted.
export const MAX_REPORT_AGE_MS = 7 * DAY
// runKey: the caller's replay key (CI: gh:<run id>:<attempt>); without one, `bodyHash` (SHA-256 of the raw body) is used.
export async function ingestAutomatedRun(db, body, now = Date.now(), { bodyHash = null } = {}) {
  const results = Array.isArray(body?.results) ? body.results.slice(0, 5000) : null
  if (!results) return { error: 'invalid_request' }
  if (!results.every((r) => r && typeof r === 'object' && typeof r.file === 'string' && typeof r.title === 'string' && r.file.length <= 300 && r.title.length <= 500)) return { error: 'invalid_request' }
  if (body.runKey != null && !/^[A-Za-z0-9._:-]{4,80}$/.test(String(body.runKey))) return { error: 'invalid_request' }
  // Stale reports are refused (a replayed old body never becomes "the latest run").
  if (Number.isInteger(body.startedAt) && body.startedAt < now - MAX_REPORT_AGE_MS) return { error: 'stale_report' }
  const runKey = body.runKey != null ? `key:${body.runKey}` : bodyHash ? `sha:${bodyHash}` : null
  if (runKey) {
    const seen = await db.prepare('SELECT id, status, summary FROM qa_runs WHERE run_key = ?1').bind(runKey).first()
    if (seen) return { id: seen.id, status: seen.status, counts: parse(seen.summary), duplicate: true }
  }
  const source = ['ci', 'local'].includes(body.source) ? body.source : null
  const provider = ['mocked', 'real'].includes(body.provider) ? body.provider : null
  if (!source || !provider) return { error: 'invalid_request' }
  const revision = /^[a-f0-9]{7,40}$/.test(String(body.revision || '')) ? body.revision : null
  const artifactsUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(String(body.artifactsUrl || '')) ? body.artifactsUrl : null
  const id = `qa_${randomToken(9)}`
  const counts = { pass: 0, fail: 0, blocked: 0, not_tested: 0, total: 0 }
  const rows = new Map()
  for (const r of results) {
    const status = STATUS_MAP[r?.status] || 'blocked'
    counts[status]++
    counts.total++
    const linked = matchTest(r?.file, r?.title)
    const targets = linked.length ? linked : status === 'fail' ? [{ id: `unlinked:${String(r.file || '').split('/').pop().replace(/\.spec\.js$/, '')}:${String(r.title || '').slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, journey: null }] : []
    for (const t of targets) {
      const key = `${t.id}${r.project ? `@${String(r.project).slice(0, 12)}` : ''}`
      const prev = rows.get(key)
      // One row per test (+ project); a failure wins over a pass of the same test.
      if (prev && prev.status === 'fail') continue
      rows.set(key, { test_id: key, journey: t.journey, status, observed: status === 'fail' ? redact(r.error) : null, ms: Number.isFinite(r.durationMs) ? Math.round(r.durationMs) : null })
    }
  }
  const status = counts.fail ? 'failed' : counts.blocked ? 'blocked' : 'passed'
  const started = Number.isInteger(body.startedAt) && body.startedAt <= now ? body.startedAt : now
  const ins = await db
    .prepare("INSERT OR IGNORE INTO qa_runs (id, kind, source, revision, provider, status, summary, artifacts_url, started_at, finished_at, run_key) VALUES (?1, 'automated', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
    .bind(id, source, revision, provider, status, JSON.stringify(counts), artifactsUrl, started, now, runKey)
    .run()
  // Concurrent replay of the same key: the other request stored it; this one stores nothing.
  if ((ins?.meta?.changes ?? 0) === 0) {
    const seen = await db.prepare('SELECT id, status, summary FROM qa_runs WHERE run_key = ?1').bind(runKey).first()
    return { id: seen?.id ?? null, status: seen?.status ?? status, counts: parse(seen?.summary), duplicate: true }
  }
  for (const r of [...rows.values()].slice(0, MAX_RESULTS)) {
    await db.prepare('INSERT OR IGNORE INTO qa_results (run_id, test_id, journey, status, observed, ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(id, r.test_id, r.journey, r.status, r.observed, r.ms, now).run()
  }
  return { id, status, counts, stored: Math.min(rows.size, MAX_RESULTS) }
}

// ---------- guided human QA ----------
export async function startHumanRun(db, { journey, customer = null, provider = 'mocked', testerEmail }, now = Date.now()) {
  const j = journeyDef(journey)
  if (!j) return { error: 'invalid_journey' }
  if (!['mocked', 'real'].includes(provider)) return { error: 'invalid_request' }
  const id = `qh_${randomToken(9)}`
  await db
    .prepare("INSERT INTO qa_runs (id, kind, source, journey, customer, provider, status, tester, summary, started_at) VALUES (?1, 'human', 'human', ?2, ?3, ?4, 'running', ?5, '{}', ?6)")
    .bind(id, j.id, customer, provider, await emailRef(testerEmail), now)
    .run()
  return { id }
}

const runRow = (db, id) => db.prepare("SELECT * FROM qa_runs WHERE id = ?1 AND kind = 'human'").bind(id).first()

export async function recordStep(db, { run, step, status, observed = '', answers = {} }, now = Date.now()) {
  const r = await runRow(db, String(run || ''))
  if (!r) return { error: 'not_found' }
  if (r.status !== 'running') return { error: 'run_finished' }
  const j = journeyDef(r.journey)
  const s = j?.steps.find((x) => x.id === step)
  if (!s) return { error: 'invalid_step' }
  if (!RESULT_STATES.includes(status)) return { error: 'invalid_status' }
  const a = {}
  for (const [k, v] of Object.entries(answers && typeof answers === 'object' ? answers : {}).slice(0, 10)) if (/^\d$/.test(k)) a[k] = redact(v, 300)
  // Timed journeys: time since the previous recorded step (or the run start), measured on the server clock.
  const prev = await db.prepare('SELECT max(at) AS at FROM qa_results WHERE run_id = ?1 AND test_id <> ?2').bind(r.id, `${r.journey}.${step}`).first()
  const ms = j.timed ? now - (prev?.at || r.started_at) : null
  await db
    .prepare(
      `INSERT INTO qa_results (run_id, test_id, journey, step, status, observed, answers, ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (run_id, test_id) DO UPDATE SET status = ?5, observed = ?6, answers = ?7`,
    )
    .bind(r.id, `${r.journey}.${step}`, r.journey, step, status, redact(observed), JSON.stringify(a).slice(0, 2048), ms, now)
    .run()
  return { ok: true, ms }
}

export async function addFinding(db, { run, step = null, type, severity = null, text }, now = Date.now()) {
  const r = await runRow(db, String(run || ''))
  if (!r) return { error: 'not_found' }
  if (!['defect', 'improvement'].includes(type)) return { error: 'invalid_type' }
  if (severity !== null && !['critical', 'high', 'medium', 'low'].includes(severity)) return { error: 'invalid_severity' }
  const t = redact(text, 1000).trim()
  if (!t) return { error: 'text_required' }
  if (step !== null && !journeyDef(r.journey)?.steps.some((s) => s.id === step)) return { error: 'invalid_step' }
  const id = `qf_${randomToken(9)}`
  await db.prepare('INSERT INTO qa_findings (id, run_id, journey, step, type, severity, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(id, r.id, r.journey, step, type, type === 'defect' ? severity || 'medium' : null, t, now).run()
  return { id }
}

export async function finishHumanRun(db, { run }, now = Date.now()) {
  const r = await runRow(db, String(run || ''))
  if (!r) return { error: 'not_found' }
  if (r.status !== 'running') return { error: 'run_finished' }
  const j = journeyDef(r.journey)
  const { results } = await db.prepare('SELECT step, status, ms FROM qa_results WHERE run_id = ?1').bind(r.id).all()
  const counts = { pass: 0, fail: 0, blocked: 0, not_tested: 0 }
  for (const x of results) counts[x.status]++
  counts.not_tested += (j?.steps.length || 0) - results.length
  const status = counts.fail ? 'failed' : counts.blocked || counts.not_tested ? 'blocked' : 'passed'
  const summary = { ...counts, ...(j?.timed ? { totalMs: now - r.started_at, targetMinutes: j.targetMinutes, splits: Object.fromEntries(results.map((x) => [x.step, x.ms])) } : {}) }
  await db.prepare("UPDATE qa_runs SET status = ?2, summary = ?3, finished_at = ?4 WHERE id = ?1 AND status = 'running'").bind(r.id, status, JSON.stringify(summary), now).run()
  return { status, summary }
}

// ---------- read side ----------
const parse = (s) => {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}
const presentRun = (r) => ({ id: r.id, kind: r.kind, source: r.source, revision: r.revision, journey: r.journey, customer: r.customer, provider: r.provider, status: r.status, summary: parse(r.summary), artifactsUrl: r.artifacts_url, startedAt: r.started_at, finishedAt: r.finished_at })

export async function qaOverview(db, now = Date.now()) {
  if (!(await qaReady(db))) return null
  const { results: runs } = await db.prepare('SELECT * FROM qa_runs ORDER BY started_at DESC LIMIT 30').all()
  const automated = runs.filter((r) => r.kind === 'automated').map(presentRun)
  const human = runs.filter((r) => r.kind === 'human').map(presentRun)
  // Journeys whose latest automated result for a linked test failed.
  const { results: latest } = await db
    .prepare(
      `SELECT q.test_id, q.journey, q.status, q.at FROM qa_results q JOIN qa_runs r ON r.id = q.run_id
        WHERE r.kind = 'automated' AND q.at = (SELECT max(at) FROM qa_results q2 WHERE q2.test_id = q.test_id) AND q.at >= ?1`,
    )
    .bind(now - 30 * DAY)
    .all()
  const failedJourneys = [...new Set(latest.filter((x) => x.status === 'fail' && x.journey).map((x) => x.journey))]
  const activation = human.filter((r) => r.journey === 'activation' && r.finishedAt)
  return {
    automated: automated.slice(0, 10),
    human: human.slice(0, 10),
    failedJourneys,
    activation: activation.length
      ? { measured: true, runs: activation.length, latest: { id: activation[0].id, status: activation[0].status, totalMinutes: Math.round((activation[0].summary.totalMs || 0) / 6000) / 10, targetMinutes: 20, provider: activation[0].provider, finishedAt: activation[0].finishedAt } }
      : { measured: false, runs: 0 },
    journeys: JOURNEYS.map((j) => ({ id: j.id, title: j.title, audience: j.audience, timed: Boolean(j.timed), targetMinutes: j.targetMinutes ?? null, note: j.note ?? null, steps: j.steps, tests: j.tests.map((t) => ({ id: testId(j.id, t), ...t })) })),
    linkedTests: linkedTests().length,
  }
}

export async function runDetail(db, id) {
  const r = await db.prepare('SELECT * FROM qa_runs WHERE id = ?1').bind(String(id)).first()
  if (!r) return null
  const { results } = await db.prepare("SELECT test_id, journey, step, status, observed, answers, ms, at FROM qa_results WHERE run_id = ?1 ORDER BY status = 'fail' DESC, at").bind(r.id).all()
  const { results: findings } = await db.prepare('SELECT id, journey, step, type, severity, text, created_at FROM qa_findings WHERE run_id = ?1 ORDER BY created_at').bind(r.id).all()
  // Related incidents: open incidents on a feature used by a journey that failed in this run.
  const features = new Set(results.filter((x) => x.status === 'fail' && x.journey).flatMap((x) => journeyDef(x.journey)?.steps.map((s) => s.feature) || []))
  const related = features.size ? (await listIncidents(db, { status: 'open', limit: 200 })).filter((i) => features.has(i.feature)).slice(0, 20) : []
  return { run: presentRun(r), results: results.map((x) => ({ ...x, answers: parse(x.answers) })), findings, related }
}

export async function testHistory(db, testIdValue, limit = 10) {
  const { results } = await db
    .prepare('SELECT q.run_id, q.status, q.observed, q.ms, q.at, r.revision, r.provider, r.source FROM qa_results q JOIN qa_runs r ON r.id = q.run_id WHERE q.test_id = ?1 ORDER BY q.at DESC LIMIT ?2')
    .bind(String(testIdValue).slice(0, 120), Math.min(limit, 50))
    .all()
  return results
}

export async function purgeQa(db, now = Date.now()) {
  if (!(await qaReady(db))) return { ready: false }
  const old = "(kind = 'automated' AND started_at < ?1) OR (kind = 'human' AND started_at < ?2)"
  await db.prepare(`DELETE FROM qa_results WHERE run_id IN (SELECT id FROM qa_runs WHERE ${old})`).bind(now - AUTOMATED_RETENTION_MS, now - HUMAN_RETENTION_MS).run()
  await db.prepare(`DELETE FROM qa_findings WHERE run_id IN (SELECT id FROM qa_runs WHERE ${old})`).bind(now - AUTOMATED_RETENTION_MS, now - HUMAN_RETENTION_MS).run()
  const r = await db.prepare(`DELETE FROM qa_runs WHERE ${old}`).bind(now - AUTOMATED_RETENTION_MS, now - HUMAN_RETENTION_MS).run()
  return { ready: true, purged: r?.meta?.changes ?? 0 }
}
