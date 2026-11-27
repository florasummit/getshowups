// QA Command Center: labels and pure helpers (no DOM, no fetch; unit-tested in test/qa-ui.test.js).
// Rules the UI keeps: a test with no result is "Untested"; a share is never shown without its counts; an AI
// assessment is labelled and never counts as a pass; times are shown in the viewer's own time zone with its label.
import { humanDateTime, plural } from '../../lib/format.js'

// Status of a test against the CURRENT production deployment (from the server's freshness rules).
export const TEST_STATUS = {
  verified: ['ok', 'Verified', 'Passed on the current release'],
  verified_ci_only: ['info', 'CI only', 'Passed in CI on this release; not yet checked in production'],
  stale: ['warn', 'Stale', 'Passed before, but its code or definition changed since'],
  failed: ['bad', 'Failed', 'The latest result on this release failed'],
  blocked: ['warn', 'Blocked', 'Could not be run; see the reason on the result'],
  uncertain: ['warn', 'Impact unknown', 'We cannot tell whether recent changes affect it; a broader run is recommended'],
  untested: ['neutral', 'Untested', 'No result recorded'],
}
export const STATUS_ORDER = ['failed', 'blocked', 'stale', 'uncertain', 'untested', 'verified_ci_only', 'verified']

// One recorded result (append-only rows).
export const RESULT = {
  pass: ['ok', 'Pass'],
  fail: ['bad', 'Fail'],
  blocked: ['warn', 'Blocked'],
  skipped: ['neutral', 'Skipped'],
  unverified: ['neutral', 'Unverified'],
  retest_required: ['warn', 'Retest required'],
  not_tested: ['neutral', 'Not tested'],
}
export const MANUAL_RESULTS = ['pass', 'fail', 'blocked', 'skipped', 'unverified', 'retest_required']

export const EXEC_STATUS = {
  queued: ['info', 'Queued'],
  dispatched: ['info', 'Sent to CI'],
  running: ['info', 'Running'],
  passed: ['ok', 'Passed'],
  failed: ['bad', 'Failed'],
  partial: ['warn', 'Partly done'],
  cancelled: ['neutral', 'Cancelled'],
  refused: ['neutral', 'Not started'],
  expired: ['warn', 'Timed out'],
}
export const ACTIVE = ['queued', 'dispatched', 'running']
export const isActive = (s) => ACTIVE.includes(s)

export const CLASS = {
  automated: ['neutral', 'Automated'],
  ai_assisted: ['info', 'AI-assisted'],
  human: ['warn', 'Needs a person'],
  authorization: ['warn', 'Needs approval'],
}

export const ENV = { ci: 'CI (test copy)', production: 'Production (read-only)', manual: 'Manual', local: 'Local or imported' }

export const PRESETS = [
  ['all_safe', 'Run all safe tests', 'Every automated test that costs nothing and changes nothing real.'],
  ['smoke', 'Quick smoke tests', 'A few minutes: the main pages and journeys still work.'],
  ['regression', 'Comprehensive regression', 'Everything automated and safe, including slower browser journeys.'],
  ['affected', 'Tests affected by recent changes', 'Stale tests and tests whose code changed since their last pass.'],
  ['failed', 'Retest failed tests', 'Only the tests whose latest result failed.'],
  ['production_verify', 'Verify the current production deployment', 'Read-only checks against the live site.'],
]

// Defects and backlog share one table; the kind decides which list and which statuses apply.
export const KINDS = {
  bug: 'Bug',
  regression: 'Regression',
  feature: 'Feature request',
  ux: 'UX or design',
  ai: 'AI or conversation',
  performance: 'Performance',
  cost: 'Cost',
  tech_debt: 'Technical debt',
  observation: 'Observation or note',
}
export const DEFECT_KINDS = ['bug', 'regression']
export const BACKLOG_KINDS = Object.keys(KINDS).filter((k) => !DEFECT_KINDS.includes(k))
export const isDefect = (kind) => DEFECT_KINDS.includes(kind)

export const DEFECT_STATUS = {
  open: ['bad', 'Open'],
  in_progress: ['info', 'In progress'],
  fixed_pending_qa: ['warn', 'Fixed, awaiting retest'],
  verified: ['ok', 'Verified by retest'],
  wont_fix: ['neutral', 'Won’t fix'],
}
// "verified" comes only from a passing retest recorded after the fix: it is never offered as a manual choice.
export const DEFECT_CHOICES = ['open', 'in_progress', 'fixed_pending_qa', 'wont_fix']
export const BACKLOG_STATUS = {
  inbox: ['info', 'Inbox'],
  under_review: ['neutral', 'Under review'],
  planned: ['info', 'Planned'],
  in_progress: ['info', 'In progress'],
  awaiting_qa: ['warn', 'Awaiting QA'],
  released: ['ok', 'Released'],
  deferred: ['neutral', 'Deferred'],
}
export const statusMap = (kind) => (isDefect(kind) ? DEFECT_STATUS : BACKLOG_STATUS)

export const SEVERITY = ['critical', 'high', 'medium', 'low']
export const PRIORITY = { p1: 'Urgent', p2: 'High', p3: 'Normal', p4: 'Low' }

// Areas from the founder's coverage list (the server's inventory decides which exist; these are only labels).
export const AREA_LABEL = {
  auth: 'Authentication and onboarding',
  website: 'Website and Studio editor',
  layout: 'Mobile and desktop layouts',
  services: 'Services, pricing and settings',
  booking: 'Booking, calendar and appointments',
  receptionist: 'AI receptionist and voice',
  assistant: 'Business assistant',
  admin_assistant: 'Platform admin assistant',
  ads: 'Advertising, leads and attribution',
  billing: 'Enrollment, subscriptions and billing',
  partners: 'Partners and referrals',
  messaging: 'Email, texts and notifications',
  security: 'Security, permissions and isolation',
  spend: 'Spending limits and provider usage',
  admin: 'Platform administration',
  commercial: 'Commercial readiness',
  unassigned: 'Unassigned (no area mapped)',
}
export const areaLabel = (id, title) => title || AREA_LABEL[id] || id

// "3 of 12" with the share only when there is a denominator; never a bare percentage.
export function share(n, total) {
  const a = Number(n) || 0
  const t = Number(total) || 0
  if (!t) return 'none recorded'
  return `${a} of ${t} (${Math.round((a / t) * 100)}%)`
}

// Counts object → [[status, n]] in a fixed order, zero entries dropped; total = the sum unless the server sent one.
export function countRows(counts = {}) {
  return STATUS_ORDER.filter((s) => Number(counts[s]) > 0).map((s) => [s, Number(counts[s])])
}
export const countTotal = (counts = {}) => (Number.isFinite(Number(counts.total)) ? Number(counts.total) : STATUS_ORDER.reduce((n, s) => n + (Number(counts[s]) || 0), 0))
export function countsLine(counts = {}) {
  const rows = countRows(counts)
  if (!rows.length) return 'No tests'
  return rows.map(([s, n]) => `${n} ${TEST_STATUS[s][1].toLowerCase().replace('ci only', 'CI only')}`).join(' · ')
}

// ---------- inventory tree ----------
// Node: { id, kind: platform|area|journey|feature|test, title, children?, counts?, status? (tests) }.
export const isTest = (n) => !!n && (n.kind === 'test' || (!n.kind && !n.children))
export function testsUnder(node) {
  if (!node) return []
  if (isTest(node)) return [node]
  return (node.children || []).flatMap(testsUnder) // children: null = not loaded yet
}
export const testIdsUnder = (node) => testsUnder(node).map((t) => t.id)

// Counts for a node: the server's rollup when present, else computed from its tests (status missing = untested).
export function rollup(node) {
  if (node?.counts) return node.counts
  const c = { total: 0 }
  for (const t of testsUnder(node)) {
    const s = TEST_STATUS[t.status] ? t.status : 'untested'
    c[s] = (c[s] || 0) + 1
    c.total += 1
  }
  return c
}

// Prune a tree to the tests matching every filter; branches with no matching test disappear.
// q matches the test title, file, id or any ancestor title (so "booking" keeps the whole booking area).
export function filterTree(node, { q = '', status = '', cls = '' } = {}, trail = '') {
  if (!node) return null
  const needle = q.trim().toLowerCase()
  const path = `${trail} ${node.title || ''}`.toLowerCase()
  if (isTest(node)) {
    if (status && (TEST_STATUS[node.status] ? node.status : 'untested') !== status) return null
    if (cls && node.class !== cls) return null
    if (needle && !`${path} ${node.file || ''} ${node.id || ''}`.toLowerCase().includes(needle)) return null
    return node
  }
  const filtered = !!(needle || status || cls)
  if (!node.children) return filtered ? null : node
  const children = node.children.map((c) => filterTree(c, { q, status, cls }, path)).filter(Boolean)
  if (!children.length) return null
  return { ...node, children, counts: filtered ? undefined : node.counts }
}

// Flatten the tests of a tree (for the manual list and lookups).
export const allTests = (tree) => (Array.isArray(tree) ? tree.flatMap(testsUnder) : testsUnder(tree))

// ---------- formatting ----------
export function tzLabel(ms = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || ''
  } catch {
    return ''
  }
}
// "Thu, Nov 26, 3:00 PM PST" in the viewer's time zone (stored values are UTC ms).
export function stamp(ms) {
  if (!ms) return '—'
  const t = humanDateTime(ms)
  const z = tzLabel(ms)
  return z ? `${t} ${z}` : t
}
export function duration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return 'Unknown'
  const s = Math.round(Number(ms) / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `about ${m} min`
  return `about ${Math.round((m / 60) * 10) / 10} h`
}
// Dollars (the API's estimate.usd / spend) → "$0.00"; 0 is "Free"; missing is "Unknown" (never a guessed 0).
export function usd(v, { free = true } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return 'Unknown'
  const n = Number(v)
  if (n === 0 && free) return 'Free'
  return n > 0 && n < 1 ? `$${n.toFixed(3).replace(/0$/, '')}` : `$${n.toFixed(2)}`
}
export const sha = (s) => (s ? String(s).slice(0, 7) : '—')
export const countOf = (n, word, words) => plural(n, word, words)

// Selection in the tree: toggling a branch selects or clears every test under it.
export function toggleSelection(selected, ids, on) {
  const next = new Set(selected)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}
export function selectionState(selected, ids) {
  if (!ids.length) return 'none'
  const n = ids.filter((id) => selected.has(id)).length
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some'
}

// The deterministic "note an idea" default: what screen it came from becomes context, never a claim of work started.
export function ideaContext(params = {}) {
  if (params.test) return { testIds: [params.test], note: 'Noted from a test page.' }
  if (params.exec) return { note: `Noted while viewing run ${params.exec}.` }
  if (params.item) return { note: `Noted while viewing item ${params.item}.` }
  return { note: '' }
}

// ---------- QA screens (URL → screen) ----------
export const QA_TABS = [
  ['overview', 'Overview'],
  ['tests', 'Tests'],
  ['runs', 'Runs'],
  ['manual', 'Manual'],
  ['defects', 'Defects'],
  ['backlog', 'Backlog'],
]
// Which QA screen a URL shows. Links from the earlier Testing tab (?view=qa&journey=…, ?for=…) land on Manual.
export function qaTabOf(p = {}) {
  if (p.test) return 'tests'
  if (p.exec) return 'runs'
  if (p.item) return p.list === 'backlog' ? 'backlog' : 'defects'
  if (QA_TABS.some(([id]) => id === p.tab)) return p.tab
  if (p.journey || p.for) return 'manual'
  return 'overview'
}

// What a run covered, in words ("Quick smoke tests", "42 tests", "3 tests + 1 journey"). The server sends the preset
// at the top level and scope.tests as a count (or a list).
export function scopeText(x) {
  if (x?.title) return x.title
  const s = x?.scope || {}
  const preset = x?.preset || s.preset
  if (preset) return PRESETS.find(([id]) => id === preset)?.[1] || preset
  const n = Array.isArray(s.tests) ? s.tests.length : Number(s.tests) || 0
  const j = Array.isArray(s.journeys) ? s.journeys.length : 0
  return [n ? plural(n, 'test') : '', j ? plural(j, 'journey') : ''].filter(Boolean).join(' + ') || 'Run'
}

// ---------- importing a report (Runs → Import a report) ----------
// What an uploaded report (scripts/qa-report.mjs --out, scripts/admin-assistant-eval.mjs --qa-json) WILL record, read
// from the file in the browser before anything is sent. The server re-validates, matches tests to the inventory and
// stores it as a local run; this preview never claims more than the file says.
export const MAX_REPORT_BYTES = 2_000_000
const REPORT_STATUS = { passed: 'pass', expected: 'pass', flaky: 'pass', pass: 'pass', failed: 'fail', unexpected: 'fail', timedOut: 'fail', fail: 'fail', interrupted: 'blocked', blocked: 'blocked', skipped: 'skipped', todo: 'skipped', cancelled: 'skipped' }
export function previewReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { error: 'This file isn’t a QA report (expected a JSON object).' }
  if (!Array.isArray(report.results)) return { error: report.suites ? 'This is a raw Playwright report. Convert it first with scripts/qa-report.mjs --out.' : 'This file has no results list, so there is nothing to record.' }
  if (!report.results.length) return { error: 'The report has no results.' }
  const byStatus = { pass: 0, fail: 0, blocked: 0, skipped: 0 }
  const byKind = {}
  const models = new Set()
  let costMicros = 0
  let costKnown = false
  for (const r of report.results) {
    byStatus[REPORT_STATUS[r?.status] || 'blocked'] += 1
    const k = r?.kind || 'e2e'
    byKind[k] = (byKind[k] || 0) + 1
    if (r?.model) models.add(String(r.model))
    if (Number.isFinite(r?.costMicros) && r.costMicros >= 0) {
      costKnown = true
      costMicros += r.costMicros
    }
  }
  const revision = /^[a-f0-9]{7,40}$/.test(String(report.revision || '')) ? report.revision : null
  return {
    tests: report.results.length,
    byStatus,
    byKind,
    revision,
    provider: report.provider === 'real' ? 'real' : 'mocked',
    environment: 'local',
    costUsd: costKnown ? costMicros / 1e6 : null,
    models: [...models],
    startedAt: Number.isFinite(report.startedAt) ? report.startedAt : null,
    hashes: report.hashes && typeof report.hashes === 'object' ? Object.keys(report.hashes).length : 0,
  }
}

// People are stored as references, never emails ("ref:<hash>"); automatic actors as "system:<name>".
export const who = (ref) => {
  const r = String(ref || '')
  if (!r) return 'unknown'
  if (r.startsWith('system:')) return 'automatic'
  if (r.startsWith('ref:')) return `admin ${r.slice(4, 12)}`
  return r
}
