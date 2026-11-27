#!/usr/bin/env node
// Posts one test run to the Control Center (POST /api/qa/runs). Reuses Playwright's own JSON reporter and node:test's
// reporter API (scripts/qa-node-reporter.mjs); no new test engine. Usage:
//   PLAYWRIGHT_JSON_OUTPUT_NAME=qa-report.json npx playwright test --reporter=list,json
//   QA_INGEST_URL=https://getshowups.com QA_INGEST_TOKEN=... node scripts/qa-report.mjs qa-report.json [--source ci|local] [--provider mocked|real]
//   node scripts/qa-report.mjs qa-report.json --dry-run      # print the summary, send nothing
// QA Command Center additions (all optional):
//   --unit qa-unit.json        node:test results (scripts/qa-node-reporter.mjs)
//   --eval eval.json           paid evaluation results (scripts/admin-assistant-eval.mjs --qa-json), with costs
//   --hashes qa-hashes.json    definition/dependency hashes (scripts/qa-inventory.mjs --hashes <dir>; default
//                              dist/qa-hashes.json when present)
//   --execution qx_…           the QA Command Center execution this run belongs to (dispatched runs)
//   --started                  only report that the dispatched run started (GITHUB_RUN_ID, GITHUB_SHA)
//   --out body.json            write the request body instead of sending it (for Admin → QA → Import)
// The e2e suite runs against MOCKED providers, so --provider defaults to 'mocked'. Nothing is sent unless both
// QA_INGEST_URL and QA_INGEST_TOKEN are set (off by default). Error text is redacted again on the server.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const VALUED = new Set(['source', 'provider', 'unit', 'eval', 'hashes', 'execution', 'out'])
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.has(args[i - 1].replace(/^--/, ''))))
const unitFile = flag('unit', null)
const evalFile = flag('eval', null)
const executionId = flag('execution', process.env.QA_EXECUTION_ID || null) || null
const started = args.includes('--started')
// With only --execution, an empty report is posted: the execution then finishes as partial instead of waiting to expire.
if (!file && !unitFile && !evalFile && !started && !executionId) {
  console.error('usage: node scripts/qa-report.mjs [<playwright-json>] [--execution qx_…] [--unit qa-unit.json] [--eval eval.json] [--hashes qa-hashes.json] [--execution qx_…] [--started] [--source ci|local] [--provider mocked|real] [--dry-run] [--out body.json]')
  process.exit(2)
}
const readJson = (f) => (f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)

let revision = process.env.GITHUB_SHA || null
if (!revision) {
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {}
}
const artifactsUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null

async function send(body) {
  if (flag('out', null)) {
    writeFileSync(flag('out'), `${JSON.stringify(body)}\n`)
    console.log(`qa-report: body written to ${flag('out')}`)
    process.exit(0)
  }
  if (args.includes('--dry-run')) process.exit(0)
  const url = process.env.QA_INGEST_URL
  const token = process.env.QA_INGEST_TOKEN
  if (!url || !token) {
    console.log('qa-report: QA_INGEST_URL / QA_INGEST_TOKEN not set; nothing sent')
    process.exit(0)
  }
  const res = await fetch(`${url.replace(/\/$/, '')}/api/qa/runs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  console.log('qa-report: server answered', res.status, JSON.stringify(await res.json().catch(() => ({}))))
  process.exit(res.ok ? 0 : 1)
}

if (started) {
  if (!executionId) {
    console.error('qa-report: --started needs --execution')
    process.exit(2)
  }
  await send({ executionId, event: 'started', ghRunId: process.env.GITHUB_RUN_ID || null, revision })
}

const results = []
const report = file ? readJson(file) : null
const walk = (suite, fileName) => {
  const f = suite.file || fileName
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const last = (t.results || []).at(-1) || {}
      results.push({ file: spec.file || f, title: spec.title, project: t.projectName, status: t.status === 'flaky' ? 'passed' : last.status || t.status, durationMs: last.duration, error: last.error?.message || null })
    }
  }
  for (const s of suite.suites || []) walk(s, f)
}
for (const s of report?.suites || []) walk(s, s.file)
// Playwright reports spec files relative to testDir (test/e2e).
for (const r of results) if (r.file && !r.file.includes('/')) r.file = `test/e2e/${r.file}`
const unit = readJson(unitFile)
for (const r of unit?.results || []) results.push({ ...r, kind: 'unit' })
const ev = readJson(evalFile)
for (const r of ev?.results || []) results.push({ ...r, kind: 'eval' })
const hashes = { ...(readJson(flag('hashes', existsSync('dist/qa-hashes.json') ? 'dist/qa-hashes.json' : null))?.hashes || {}), ...(ev?.hashes || {}) }

// Replay key: one stored run per CI run attempt (the server also dedupes identical bodies by hash).
const runKey = process.env.GITHUB_RUN_ID ? `gh:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT || '1'}` : undefined
const body = {
  runKey,
  revision,
  source: flag('source', process.env.CI ? 'ci' : 'local'),
  provider: flag('provider', evalFile && !file && !unitFile ? 'real' : 'mocked'),
  artifactsUrl,
  startedAt: Date.parse(report?.stats?.startTime) || ev?.startedAt || undefined,
  results,
  ...(executionId ? { executionId } : {}),
  ...(Object.keys(hashes).length ? { hashes } : {}),
}
const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})
console.log(`qa-report: ${results.length} results`, counts, `revision ${String(revision).slice(0, 7)}`, body.provider, executionId ? `execution ${executionId}` : '')
await send(body)
