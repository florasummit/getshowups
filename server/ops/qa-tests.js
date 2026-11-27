// QA Command Center inventory at runtime: the generated repository inventory (scripts/qa-inventory.mjs →
// qa-inventory.generated.js) + the production checks (./qa-production.js) + one production check per registered
// capability. Also: matching CI/eval report results to inventory ids, and duration / cost ESTIMATES (labelled
// approximate; never presented as measurements).
import './catalog.js'
import { listCapabilities } from './registry.js'
import { JOURNEYS } from './journeys.js'
import { AREAS, GROUPS, TESTS } from './qa-inventory.generated.js'
import { PROD_CHECKS } from './qa-production-checks.js'

export const CLASSES = ['automated', 'ai_assisted', 'human', 'authorization']
export const KINDS = ['unit', 'e2e', 'eval', 'human', 'production']
export { AREAS }

// Capability id prefix → area (a capability's production check sits in the area of what it serves).
const CAP_AREA = { auth: 'auth_onboarding', onboarding: 'auth_onboarding', website: 'website', calendar: 'booking', showup: 'booking', lead: 'ads', results: 'ads', ads: 'ads', crm: 'ads', billing: 'billing', account: 'security', messaging: 'messaging', followups: 'messaging', receptionist: 'receptionist', phone: 'receptionist', intelligence: 'receptionist', conversations: 'receptionist', assist: 'business_assistant', commercial: 'partners', platform: 'platform_admin' }
export const capabilityArea = (id) => CAP_AREA[String(id).split('.')[0]] || 'platform_admin'

// Estimates (approximate, shown as such): CI job setup, per unit-test file, browser server start, per browser test,
// per human step, per paid evaluation scenario (worst case, micro-dollars), production check batch (one cron interval).
export const EST = { ciSetupMs: 150_000, unitFileMs: 1_500, e2eSetupMs: 150_000, e2eTestMs: 8_000, humanStepMs: 120_000, evalScenarioMs: 15_000, prodWaitMs: 300_000, prodCheckMs: 1_000 }
export const EVAL_COST = { admin_eval: 50_000, receptionist_eval: 1_500_000 } // admin: per scenario; receptionist: the whole 100-scenario run

let cache = null
export function allTests() {
  if (cache) return cache
  const steps = new Map(JOURNEYS.flatMap((j) => j.steps.map((s) => [`human:${j.id}.${s.id}`, { action: s.action, expected: s.expected, ask: s.ask || [], assisted: s.assisted || null }])))
  const list = TESTS.map(([id, title, group, over]) => {
    const g = GROUPS[group] || {}
    const t = { id, title, mobile: false, ...g, ...(over || {}) }
    t.h = t.h ?? (t.kind === 'human' ? group : t.kind === 'eval' && t.suite === 'admin_eval' ? id : t.file)
    if (t.kind === 'human') t.steps = steps.get(id) || null
    return t
  })
  for (const c of PROD_CHECKS) list.push({ id: c.id, title: c.title, kind: 'production', file: null, area: c.area, journey: 'other', feature: c.feature, class: 'automated', h: null, impact: 'deployment', expected: c.expected, mobile: false })
  for (const c of listCapabilities()) list.push({ id: `prod:cap:${c.id}`, title: `${c.name}: configuration and recent activity`, kind: 'production', file: null, area: capabilityArea(c.id), journey: 'other', feature: c.id, class: 'automated', h: null, impact: 'deployment', expected: 'Configured as intended; real activity seen recently where a check exists', mobile: false })
  const byId = new Map(list.map((t) => [t.id, t]))
  cache = { list, byId }
  return cache
}
export const getTest = (id) => allTests().byId.get(String(id)) || null
export const resetTestsCache = () => (cache = null)

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
let index = null
function matchIndex() {
  if (index) return index
  const exact = new Map()
  const patterns = new Map()
  for (const t of allTests().list) {
    if (!t.file || (t.kind !== 'unit' && t.kind !== 'e2e')) continue
    const key = `${t.file}\u0000${t.title}\u0000${t.mobile ? 'm' : 'd'}`
    if (t.pattern) {
      const re = new RegExp(`^${t.title.split(/\$\{[^}]*\}/).map(escapeRe).join('.*')}$`)
      if (!patterns.has(t.file)) patterns.set(t.file, [])
      patterns.get(t.file).push({ re, t })
    } else if (!exact.has(key)) exact.set(key, t)
  }
  index = { exact, patterns }
  return index
}
// A report result → its inventory test (or null). file: repo-relative or absolute path ending in test/…; project
// 'mobile' selects the @mobile variant. Eval results name their testId directly.
export function matchResult({ file, title, project = null, testId = null }) {
  if (testId) {
    const t = getTest(testId)
    return t && t.kind === 'eval' ? t : null
  }
  const f = String(file || '').replace(/\\/g, '/')
  const at = f.lastIndexOf('test/')
  if (at < 0 && !/\.spec\.js$/.test(f)) return null
  let rel = at < 0 ? f : f.slice(at)
  if (!rel.startsWith('test/e2e/') && /\.spec\.js$/.test(rel)) rel = `test/e2e/${rel.split('/').pop()}`
  const mobile = project === 'mobile' ? 'm' : 'd'
  const { exact, patterns } = matchIndex()
  const hit = exact.get(`${rel}\u0000${title}\u0000${mobile}`)
  if (hit) return hit
  for (const p of patterns.get(rel) || []) if (p.re.test(String(title)) && Boolean(p.t.mobile) === (mobile === 'm')) return p.t
  return null
}

// Estimate for a set of tests on an environment. → { ms, usdMicros, approximate: true, basis }
export function estimate(tests, environment) {
  if (environment === 'production') return { ms: EST.prodWaitMs + tests.length * EST.prodCheckMs, usdMicros: 0, approximate: true, basis: 'Runs in the background within ≈ 5 minutes (cron), ≈ 1 s per check' }
  if (environment === 'manual') return { ms: tests.length * EST.humanStepMs, usdMicros: 0, approximate: true, basis: '≈ 2 minutes per guided step' }
  const unitFiles = new Set(tests.filter((t) => t.kind === 'unit').map((t) => t.file))
  const e2e = tests.filter((t) => t.kind === 'e2e')
  const admin = tests.filter((t) => t.suite === 'admin_eval')
  const recept = tests.some((t) => t.suite === 'receptionist_eval')
  const ms = (tests.length ? EST.ciSetupMs : 0) + unitFiles.size * EST.unitFileMs + (e2e.length ? EST.e2eSetupMs + e2e.length * EST.e2eTestMs : 0) + admin.length * EST.evalScenarioMs + (recept ? 100 * EST.evalScenarioMs : 0)
  const usdMicros = admin.length * EVAL_COST.admin_eval + (recept ? EVAL_COST.receptionist_eval : 0)
  return { ms, usdMicros, approximate: true, basis: 'CI setup ≈ 2.5 min + ≈ 1.5 s per unit-test file + browser server ≈ 2.5 min + ≈ 8 s per browser test; paid evaluations at their worst-case cost' }
}
