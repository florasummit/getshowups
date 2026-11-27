// node:test reporter for the QA Command Center: one JSON document { results: [{ kind: 'unit', file, title, status,
// durationMs, error }] } for the top-level tests (subtests belong to their test). Used next to the normal reporter:
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//               --test-reporter=./scripts/qa-node-reporter.mjs --test-reporter-destination=qa-unit.json 'test/*.test.js'
// scripts/qa-report.mjs --unit qa-unit.json posts it (error text is redacted again on the server).
import path from 'node:path'

export default async function* qaReporter(source) {
  const results = []
  const cwd = process.cwd()
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue
    const d = ev.data || {}
    if (d.nesting !== 0 || d.details?.type === 'suite') continue
    const err = ev.type === 'test:fail' ? d.details?.error?.cause?.message || d.details?.error?.message || 'failed' : null
    results.push({
      kind: 'unit',
      file: d.file ? path.relative(cwd, d.file).split(path.sep).join('/') : null,
      title: d.name,
      status: ev.type === 'test:fail' ? 'failed' : d.skip ? 'skipped' : d.todo ? 'todo' : 'passed',
      durationMs: Math.round(d.details?.duration_ms ?? 0),
      error: err ? String(err).slice(0, 1000) : null,
    })
  }
  yield `${JSON.stringify({ results })}\n`
}
