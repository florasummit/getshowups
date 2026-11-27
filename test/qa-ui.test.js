// QA Command Center UI helpers (src/admin/control/qa-lib.js): the honesty rules the screens rely on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFECT_CHOICES,
  MANUAL_RESULTS,
  QA_TABS,
  countRows,
  countTotal,
  countsLine,
  duration,
  filterTree,
  ideaContext,
  isDefect,
  qaTabOf,
  rollup,
  scopeText,
  selectionState,
  share,
  stamp,
  testIdsUnder,
  toggleSelection,
  usd,
} from '../src/admin/control/qa-lib.js'
import { normalizeInventory, normalizeOverview, setupText } from '../src/admin/control/qa-api.js'

const tree = {
  id: 'platform',
  kind: 'platform',
  title: 'GetShowUps',
  children: [
    {
      id: 'booking',
      kind: 'area',
      title: 'Booking',
      children: [
        {
          id: 'j-book',
          kind: 'journey',
          title: 'Customer books a visit',
          children: [
            { id: 't1', kind: 'test', title: 'shows open times', file: 'test/booking.test.js', class: 'automated', status: 'verified' },
            { id: 't2', kind: 'test', title: 'refuses a forged lead', file: 'test/booking.test.js', class: 'automated', status: 'failed' },
            { id: 't3', kind: 'test', title: 'owner sees the booking', class: 'human' },
          ],
        },
      ],
    },
    { id: 'unassigned', kind: 'area', title: 'Unassigned', children: [{ id: 't4', kind: 'test', title: 'orphan', class: 'automated', status: 'stale' }] },
  ],
}

test('a share is never shown without its counts, and an empty denominator is not 0%', () => {
  assert.equal(share(3, 12), '3 of 12 (25%)')
  assert.equal(share(0, 0), 'none recorded')
  assert.equal(share(5, undefined), 'none recorded')
})

test('counts: fixed order, zero rows dropped, total from the server when it sent one', () => {
  assert.deepEqual(countRows({ verified: 2, failed: 1, untested: 0 }), [['failed', 1], ['verified', 2]])
  assert.equal(countTotal({ verified: 2, failed: 1 }), 3)
  assert.equal(countTotal({ verified: 2, total: 10 }), 10)
  assert.equal(countsLine({}), 'No tests')
  assert.equal(countsLine({ failed: 1, untested: 4 }), '1 failed · 4 untested')
})

test('rollup: a test with no status counts as untested, never as verified', () => {
  const c = rollup(tree)
  assert.equal(c.total, 4)
  assert.equal(c.untested, 1)
  assert.equal(c.verified, 1)
  assert.equal(c.failed, 1)
  assert.equal(c.stale, 1)
})

test('filterTree keeps matching tests and their ancestors only; filters combine', () => {
  const failed = filterTree(tree, { status: 'failed' })
  assert.deepEqual(testIdsUnder(failed), ['t2'])
  assert.deepEqual(testIdsUnder(filterTree(tree, { status: 'untested' })), ['t3'])
  assert.deepEqual(testIdsUnder(filterTree(tree, { cls: 'human' })), ['t3'])
  // An ancestor title matches the whole branch.
  assert.deepEqual(testIdsUnder(filterTree(tree, { q: 'books a visit' })), ['t1', 't2', 't3'])
  assert.deepEqual(testIdsUnder(filterTree(tree, { q: 'forged', status: 'verified' })), [])
  assert.equal(filterTree(tree, { q: 'nothing like this' }), null)
  // Filtered branches drop the server rollup (it would describe tests that are hidden).
  assert.equal(filterTree({ ...tree, counts: { total: 4 } }, { status: 'failed' }).counts, undefined)
})

test('selection: a branch toggles every test under it; partial selection is reported', () => {
  const ids = testIdsUnder(tree.children[0])
  let s = toggleSelection(new Set(), ids, true)
  assert.equal(selectionState(s, ids), 'all')
  s = toggleSelection(s, ['t2'], false)
  assert.equal(selectionState(s, ids), 'some')
  assert.equal(selectionState(new Set(), ids), 'none')
})

test('URL → QA screen; earlier Testing links land on Manual', () => {
  assert.equal(qaTabOf({}), 'overview')
  assert.equal(qaTabOf({ tab: 'runs' }), 'runs')
  assert.equal(qaTabOf({ tab: 'nope' }), 'overview')
  assert.equal(qaTabOf({ journey: 'booking' }), 'manual')
  assert.equal(qaTabOf({ for: 'e2e-cc' }), 'manual')
  assert.equal(qaTabOf({ test: 'x', tab: 'runs' }), 'tests')
  assert.equal(qaTabOf({ exec: 'x' }), 'runs')
  assert.equal(qaTabOf({ item: 'x' }), 'defects')
  assert.equal(qaTabOf({ item: 'x', list: 'backlog' }), 'backlog')
  assert.deepEqual(QA_TABS.map(([id]) => id), ['overview', 'tests', 'runs', 'manual', 'defects', 'backlog'])
})

test('inventory: areas → journeys → features → tests become one node tree; unloaded features stay unloaded', () => {
  const inv = normalizeInventory({
    generatedAt: '2026-11-27T15:10:00.000Z',
    areas: [
      {
        id: 'booking',
        title: 'Booking',
        counts: { verified: 1, total: 3 },
        journeys: [
          { id: 'booking', title: 'Customer books', counts: { total: 2 }, features: [{ id: 'calendar.google', name: 'Calendar', counts: { total: 2 }, tests: [{ id: 'e2e:a', title: 'A', status: 'verified', class: 'automated' }, { id: 'human:b', title: 'B', class: 'human' }] }] },
          { id: 'other', title: 'Other booking tests', counts: { total: 1 }, features: [{ id: 'x', name: 'X', testCount: 1 }] },
        ],
      },
    ],
    unassigned: { counts: { untested: 3, total: 3 }, files: ['test/schema-limits.js'] },
    gaps: [{ kind: 'capability', id: 'phone.calls', title: 'Phone calls', area: 'receptionist', why: 'No test' }],
  })
  const [area] = inv.areas
  assert.equal(area.kind, 'area')
  assert.deepEqual(testIdsUnder(area), ['e2e:a', 'human:b'])
  assert.equal(area.children[0].runnable, true)
  assert.equal(area.children[1].runnable, false, 'an "Other …" group is not a journey id to run')
  assert.equal(area.children[1].children[0].children, null, 'a feature whose tests were not sent is not empty, it is not loaded')
  assert.equal(area.children[1].children[0].testCount, 1)
  assert.deepEqual(inv.areaList, [{ id: 'booking', title: 'Booking' }])
  assert.equal(inv.gaps.length, 1)
  assert.equal(normalizeInventory(null), null)
})

test('overview: money arrives in micro-dollars and is never invented when missing', () => {
  const o = normalizeOverview({ spend: { spentMicros: 412000, budgetMicros: 3000000, availableMicros: 2588000, paidEnabled: false }, setup: { missing: [{ id: 'x', text: 'Add the secret.' }] } })
  assert.equal(o.spend.spent, 0.412)
  assert.equal(o.spend.budget, 3)
  assert.equal(o.spend.reserved, null)
  assert.equal(o.spend.paidEnabled, false)
  assert.equal(setupText(o.setup.missing[0]), 'Add the secret.')
  assert.equal(normalizeOverview({}).spend, null)
  assert.deepEqual(normalizeOverview({}).blockers, [])
})

test('money and time: unknown stays unknown, free is said, durations are rounded', () => {
  assert.equal(usd(null), 'Unknown')
  assert.equal(usd(0), 'Free')
  assert.equal(usd(0, { free: false }), '$0.00')
  assert.equal(usd(2.5), '$2.50')
  assert.equal(usd(0.125), '$0.125')
  assert.equal(duration(null), 'Unknown')
  assert.equal(duration(30_000), '30 s')
  assert.equal(duration(4 * 60_000), 'about 4 min')
  assert.equal(stamp(null), '—')
  assert.match(stamp(Date.UTC(2026, 10, 26, 15, 0)), /Nov 26/)
})

test('statuses: six manual results; "verified" is never a manual defect choice', () => {
  assert.deepEqual(MANUAL_RESULTS, ['pass', 'fail', 'blocked', 'skipped', 'unverified', 'retest_required'])
  assert.ok(!DEFECT_CHOICES.includes('verified'))
  assert.ok(isDefect('bug') && isDefect('regression') && !isDefect('feature'))
})

test('scope text and idea context', () => {
  assert.equal(scopeText({ scope: { preset: 'smoke' } }), 'Quick smoke tests')
  assert.equal(scopeText({ scope: { tests: ['a', 'b'], journeys: ['j'] } }), '2 tests + 1 journey')
  assert.equal(scopeText({}), 'Run')
  assert.deepEqual(ideaContext({ test: 't1' }).testIds, ['t1'])
  assert.equal(ideaContext({}).note, '')
})

test('every QA request goes through the one client module (no fetch or api() in the QA screens)', () => {
  for (const f of ['Overview', 'Tests', 'Runs', 'Manual', 'Items', 'QaCenter', 'Settings', 'parts', 'hooks']) {
    const src = readFileSync(new URL(`../src/admin/control/qa/${f}.jsx`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\bfetch\(|from '\.\.\/\.\.\/\.\.\/lib\/api\.js'/, `${f}.jsx must use ../qa-api.js`)
  }
})

test('import preview: says exactly what a report will record, refuses what is not a report', async () => {
  const { previewReport } = await import('../src/admin/control/qa-lib.js')
  const p = previewReport({
    source: 'local',
    provider: 'real',
    revision: '54a9422e1f0c3b7d9a2e6f4b8c1d0e3f5a7b9c2d',
    hashes: { 'eval:admin:week': { def: 'a1b2c3d4', deps: 'b2c3d4e5' } },
    results: [
      { kind: 'eval', testId: 'eval:admin:week', status: 'passed', costMicros: 120000, model: 'claude-opus-5-5' },
      { kind: 'eval', testId: 'eval:admin:cost', status: 'failed', costMicros: 80000, model: 'claude-opus-5-5' },
      { kind: 'unit', file: 'test/x.test.js', title: 't', status: 'skipped' },
    ],
  })
  assert.equal(p.tests, 3)
  assert.deepEqual(p.byStatus, { pass: 1, fail: 1, blocked: 0, skipped: 1 })
  assert.deepEqual(p.byKind, { eval: 2, unit: 1 })
  assert.equal(p.costUsd, 0.2)
  assert.equal(p.environment, 'local')
  assert.equal(p.provider, 'real')
  assert.deepEqual(p.models, ['claude-opus-5-5'])
  assert.equal(p.hashes, 1)
  // No cost in the file → unknown, never $0.
  assert.equal(previewReport({ results: [{ status: 'passed' }] }).costUsd, null)
  assert.equal(previewReport({ results: [{ status: 'passed' }], revision: 'not a sha' }).revision, null)
  assert.match(previewReport({ suites: [] }).error, /raw Playwright report/)
  assert.match(previewReport([]).error, /JSON object/)
  assert.match(previewReport({ results: [] }).error, /no results/)
})
