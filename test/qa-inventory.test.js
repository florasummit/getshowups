// QA Command Center inventory (scripts/qa-inventory.mjs → server/ops/qa-inventory.generated.js): derived from the
// repository, never stale, explicit mappings that point at real areas / capabilities / journeys, every test file
// counted, stable unique ids, hashes that change exactly when what a test depends on changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { AREAS, E2E_MAP, JOURNEY_MAP, OUT, UNIT_MAP, closure, computeHashes, isPrivatePath, titlesOf, writeGenerated } from '../scripts/qa-inventory.mjs'
import { allTests, matchResult, estimate } from '../server/ops/qa-tests.js'
import { JOURNEYS } from '../server/ops/journeys.js'
import { listCapabilities } from '../server/ops/registry.js'
import '../server/ops/catalog.js'

test('the generated inventory is current (regenerate: node scripts/qa-inventory.mjs)', async () => {
  assert.equal(readFileSync(new URL(`../${OUT}`, import.meta.url), 'utf8'), await writeGenerated(), `${OUT} is stale: run node scripts/qa-inventory.mjs`)
})

test('every test file is in the inventory; every mapping names a real area, capability and journey', () => {
  const areas = new Set(AREAS.map(([id]) => id))
  const caps = new Set(listCapabilities().map((c) => c.id))
  const journeys = new Set(JOURNEYS.map((j) => j.id))
  for (const [name, [area, feature, journey]] of Object.entries(UNIT_MAP)) {
    assert.ok(areas.has(area), `${name}: area ${area}`)
    assert.ok(feature === null || caps.has(feature), `${name}: capability ${feature}`)
    assert.ok(journey == null || journeys.has(journey), `${name}: journey ${journey}`)
  }
  for (const [name, [area, feature, journey]] of Object.entries(E2E_MAP)) {
    assert.ok(areas.has(area), `${name}: area ${area}`)
    assert.ok(feature === null || caps.has(feature), `${name}: capability ${feature}`)
    assert.ok(journey == null || journeys.has(journey), `${name}: journey ${journey}`)
  }
  for (const j of JOURNEYS) assert.ok(JOURNEY_MAP[j.id], `journey ${j.id} has an area`)
  const { list } = allTests()
  const files = new Set(list.map((t) => t.file).filter(Boolean))
  for (const f of readdirSync(new URL('./', import.meta.url)).filter((x) => x.endsWith('.test.js'))) assert.ok(files.has(`test/${f}`) || !titlesOf(readFileSync(new URL(f, import.meta.url), 'utf8')).length, `test/${f} missing`)
  for (const f of readdirSync(new URL('./e2e/', import.meta.url)).filter((x) => x.endsWith('.spec.js'))) assert.ok(files.has(`test/e2e/${f}`), `test/e2e/${f} missing`)
  // Today every file is mapped: a new unmapped file shows up as Unassigned (a gap), never silently.
  assert.deepEqual(list.filter((t) => t.area === 'unassigned').map((t) => t.file), [])
})

test('ids are unique and URL-safe; classes and kinds from the fixed vocabularies; hierarchy complete', () => {
  const { list } = allTests()
  assert.equal(new Set(list.map((t) => t.id)).size, list.length)
  for (const t of list) {
    assert.match(t.id, /^[a-z0-9:._-]{3,160}$/, t.id)
    assert.ok(['automated', 'ai_assisted', 'human', 'authorization'].includes(t.class), t.id)
    assert.ok(['unit', 'e2e', 'eval', 'human', 'production'].includes(t.kind), t.id)
    assert.ok(t.area && t.journey, t.id)
  }
  const by = (k) => list.filter((t) => t.kind === k).length
  assert.ok(by('unit') > 1000 && by('e2e') > 250 && by('human') >= 30 && by('production') >= 50, 'derived from the repository')
  // Paid evaluations are always "authorization required"; the transcript check is AI-assisted, voice quality human.
  assert.ok(list.filter((t) => t.kind === 'eval').every((t) => t.class === 'authorization'))
  assert.equal(allTests().byId.get('human:receptionist.transcript').class, 'ai_assisted')
  assert.equal(allTests().byId.get('human:receptionist.voice-quality').class, 'human')
  // @mobile browser tests have a phone variant.
  assert.ok(list.some((t) => t.kind === 'e2e' && t.mobile && t.id.endsWith('.mobile')))
})

test('report results map to inventory ids: exact titles, template titles, mobile project, evals; unknown → null', () => {
  const t = allTests().list.find((x) => x.kind === 'unit' && x.file === 'test/qa.test.js')
  assert.equal(matchResult({ file: '/runner/work/repo/test/qa.test.js', title: t.title })?.id, t.id)
  const e = allTests().list.find((x) => x.kind === 'e2e' && x.mobile)
  const desktop = allTests().byId.get(e.id.replace(/\.mobile$/, ''))
  assert.equal(matchResult({ file: e.file.split('/').pop(), title: e.title, project: 'mobile' })?.id, e.id)
  assert.equal(matchResult({ file: e.file, title: e.title, project: 'desktop' })?.id, desktop.id)
  const pattern = allTests().list.find((x) => x.pattern && x.kind === 'unit')
  if (pattern) assert.equal(matchResult({ file: pattern.file, title: pattern.title.replace(/\$\{[^}]*\}/g, 'x') })?.id, pattern.id)
  assert.equal(matchResult({ kind: 'eval', testId: 'eval:admin:week' })?.id, 'eval:admin:week')
  assert.equal(matchResult({ testId: 'unit:qa:nope' }), null)
  assert.equal(matchResult({ file: 'test/qa.test.js', title: 'no such test' }), null)
})

test('hashes: per file definition + import closure (+ npm versions); browser tests without covers have no deps hash', async () => {
  const h = await computeHashes()
  assert.match(h['test/qa.test.js'].def, /^[a-f0-9]{12}$/)
  assert.match(h['test/qa.test.js'].deps, /^[a-f0-9]{12}$/)
  assert.equal(h['test/e2e/app.spec.js'].deps, null, 'no declared covers → impact uncertain')
  assert.ok(h['journey:booking'].deps && h['eval:admin:week'].def)
  const c = closure(['test/qa.test.js'])
  assert.ok(c.files.has('server/ops/qa.js') && c.files.has('functions/api/qa/runs.js'), 'static imports followed')})

test('estimates are labelled approximate; paid evaluations carry their worst-case cost; free runs cost $0', () => {
  const list = allTests().list
  const free = estimate(list.filter((t) => t.kind === 'unit').slice(0, 50), 'ci')
  assert.equal(free.usdMicros, 0)
  assert.equal(free.approximate, true)
  const paid = estimate(list.filter((t) => t.suite === 'admin_eval').slice(0, 3), 'ci')
  assert.equal(paid.usdMicros, 150_000)
  assert.ok(estimate(list.filter((t) => t.kind === 'production'), 'production').ms >= 300_000)
})

test('confidential paths (Research Vault) never enter the inventory or the published hashes', async () => {
  for (const p of ['server/research/records.js', 'functions/api/research/index.js', 'src/admin/research/Vault.jsx', 'test/research.test.js', 'test/research-vault.test.js', 'test/e2e/research-vault.spec.js', 'test/vault_models.test.js', 'docs/research/x.md']) assert.equal(isPrivatePath(p), true, p)
  for (const p of ['test/qa-inventory.test.js', 'test/admin-assistant.test.js', 'test/e2e/qa-center.spec.js', 'server/ops/qa-tests.js', 'test/reconcile.test.js']) assert.equal(isPrivatePath(p), false, p)
  const hashes = await computeHashes()
  assert.deepEqual(Object.keys(hashes).filter(isPrivatePath), [])
  for (const v of Object.values(hashes)) assert.deepEqual(Object.keys(v).sort(), ['def', 'deps'], 'only two short fingerprints per entry')
  assert.ok(Object.keys(hashes).every((k) => /^(test\/|scripts\/|journey:|eval:)/.test(k)), 'only repository-relative test ids')
})
