#!/usr/bin/env node
// Posts one Playwright run to the Control Center (POST /api/qa/runs). Reuses Playwright's own JSON reporter; no new
// browser engine. Usage:
//   PLAYWRIGHT_JSON_OUTPUT_NAME=qa-report.json npx playwright test --reporter=list,json
//   QA_INGEST_URL=https://getshowups.com QA_INGEST_TOKEN=... node scripts/qa-report.mjs qa-report.json [--source ci|local] [--provider mocked|real]
//   node scripts/qa-report.mjs qa-report.json --dry-run      # print the summary, send nothing
// The e2e suite runs against MOCKED providers, so --provider defaults to 'mocked'. Nothing is sent unless both
// QA_INGEST_URL and QA_INGEST_TOKEN are set (off by default). Error text is redacted again on the server.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
if (!file) {
  console.error('usage: node scripts/qa-report.mjs <playwright-json> [--source ci|local] [--provider mocked|real] [--dry-run]')
  process.exit(2)
}
const report = JSON.parse(readFileSync(file, 'utf8'))
const results = []
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
for (const s of report.suites || []) walk(s, s.file)

let revision = process.env.GITHUB_SHA || null
if (!revision) {
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {}
}
const artifactsUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
const body = { revision, source: flag('source', process.env.CI ? 'ci' : 'local'), provider: flag('provider', 'mocked'), artifactsUrl, startedAt: Date.parse(report.stats?.startTime) || undefined, results }
const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {})
console.log(`qa-report: ${results.length} results`, counts, `revision ${String(revision).slice(0, 7)}`, body.provider)
if (args.includes('--dry-run')) process.exit(0)
const url = process.env.QA_INGEST_URL
const token = process.env.QA_INGEST_TOKEN
if (!url || !token) {
  console.log('qa-report: QA_INGEST_URL / QA_INGEST_TOKEN not set; nothing sent')
  process.exit(0)
}
const res = await fetch(`${url.replace(/\/$/, '')}/api/qa/runs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
console.log('qa-report: server answered', res.status, JSON.stringify(await res.json().catch(() => ({}))))
process.exit(res.ok ? 0 : 1)
