#!/usr/bin/env node
// QA Command Center test inventory, DERIVED from the repository (never hand-maintained):
//   node scripts/qa-inventory.mjs                 → writes server/ops/qa-inventory.generated.js (structure: every node:test
//                                                   test, every Playwright test (+ its @mobile variant), every paid
//                                                   evaluation scenario, every guided human step), from the mapping
//                                                   tables below. test/qa-inventory.test.js fails when it is stale.
//   node scripts/qa-inventory.mjs --hashes dist   → writes dist/qa-hashes.json at BUILD time (package.json "build"): per
//                                                   hash key the definition hash and the hash of everything it depends
//                                                   on (static import closure under server/ functions/ src/ scripts/
//                                                   test/, npm package versions it imports, declared `covers` for browser
//                                                   tests and human journeys). The server compares a result's hashes with
//                                                   the deployed ones to tell verified from stale (server/ops/qa-freshness.js).
// Hierarchy: platform → area (AREAS) → journey (server/ops/journeys.js id, else 'other') → feature (capability id of
// server/ops/catalog.js, or null) → test. A test file missing from the tables lands in area 'unassigned' (shown as a gap).
// Hashes are per FILE for unit/browser tests (editing one test stales the tests of that file), per journey for human
// steps, per scenario for evaluations.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const OUT = 'server/ops/qa-inventory.generated.js'

export const AREAS = [
  ['auth_onboarding', 'Authentication and onboarding'],
  ['website', 'Website generation and Studio editor'],
  ['layouts', 'Mobile and desktop layouts'],
  ['business_settings', 'Services, pricing and business settings'],
  ['booking', 'Booking, calendar and appointments'],
  ['receptionist', 'AI receptionist and voice providers'],
  ['business_assistant', 'Business assistant'],
  ['admin_assistant', 'Platform admin assistant'],
  ['ads', 'Advertising, lead generation and attribution'],
  ['billing', 'Enrollment, subscriptions and billing'],
  ['partners', 'Partners and referrals'],
  ['messaging', 'Email, SMS and notifications'],
  ['security', 'Security, permissions and tenant isolation'],
  ['spending', 'Spending limits and provider usage'],
  ['platform_admin', 'Platform administration'],
  ['commercial', 'Commercial readiness'],
  ['unassigned', 'Unassigned (no area mapping yet)'],
]

// test/<name>.test.js → [area, feature (capability id | null), journey (journeys.js id | null)]
export const UNIT_MAP = {
  acceptance: ['platform_admin', 'platform.admin'],
  'account-controls': ['security', 'account.controls'],
  acquisition: ['ads', 'results.attribution'],
  'admin-assistant': ['admin_assistant', 'platform.admin', 'admin-assistant'],
  'admin-assistant-qa': ['admin_assistant', 'platform.admin', 'admin-assistant'],
  'admin-figures': ['platform_admin', 'platform.admin'],
  'ads-changes': ['ads', 'ads.google'],
  'ads-gbp': ['ads', 'ads.google'],
  'ads-google': ['ads', 'ads.google'],
  'ads-imports': ['ads', 'ads.google'],
  'ads-lsa': ['ads', 'ads.google'],
  'ads-meta': ['ads', 'ads.meta'],
  'ads-openai': ['ads', 'ads.openai'],
  'ads-recommend': ['ads', 'ads.google'],
  'ads-templates': ['ads', 'ads.google'],
  ads: ['ads', 'ads.google'],
  'ai-budget': ['spending', null],
  'ai-designer': ['website', 'website.ai', 'website-studio'],
  'ai-efficiency': ['spending', 'intelligence.studio'],
  'ai-keys': ['website', 'website.studio'],
  'assist-outage': ['business_assistant', 'assist.ask'],
  'assist-truth': ['business_assistant', 'assist.ask'],
  assist: ['business_assistant', 'assist.ask'],
  'assistant-intelligence': ['business_assistant', 'assist.ask'],
  'assisted-enrollment': ['billing', 'onboarding.selfserve'],
  auditlog: ['security', 'platform.audit'],
  automation: ['messaging', 'messaging.email', 'booking'],
  'booking-excellence': ['booking', 'calendar.google', 'booking'],
  'booking-services': ['business_settings', 'calendar.google'],
  brand: ['layouts', null],
  'business-accounts': ['billing', 'billing.lifecycle'],
  'business-details': ['business_settings', 'onboarding.selfserve'],
  'commercial-integration': ['commercial', 'commercial.attribution'],
  commercial: ['partners', 'commercial.commissions'],
  'control-center': ['platform_admin', 'platform.incidents', 'calendar-recovery'],
  coverage: ['booking', 'lead.qualify', 'booking'],
  'customer-zero-journey': ['commercial', 'lead.capture', 'booking'],
  'dashboard-excellence': ['layouts', null],
  dashboard: ['security', 'auth.google_signin', 'returning-owner'],
  'deletion-completeness': ['security', 'account.deletion'],
  deletion: ['security', 'account.deletion'],
  'deploy-safety': ['website', 'website.studio'],
  'design-composition': ['website', 'website.ai'],
  'design-recipes': ['website', 'website.ai'],
  'designer-intents': ['website', 'website.ai'],
  'designer-security': ['security', 'website.ai'],
  eligibility: ['billing', 'billing.lifecycle'],
  'email-auth': ['auth_onboarding', 'auth.email_signin'],
  enrollment: ['auth_onboarding', 'onboarding.selfserve'],
  enterprise: ['commercial', 'lead.enterprise_inquiry'],
  followups: ['messaging', 'followups.engine'],
  format: ['layouts', null],
  'founder-alerts': ['platform_admin', 'platform.alerts'],
  ghl: ['ads', 'crm.ghl'],
  'google-calls': ['ads', 'ads.google_calls'],
  'google-health': ['platform_admin', 'calendar.google'],
  'google-oauth': ['auth_onboarding', 'calendar.google', 'activation'],
  'growth-activities': ['commercial', null],
  growth: ['commercial', null],
  help: ['layouts', null],
  'intelligence-eval': ['receptionist', 'intelligence.studio'],
  intelligence: ['receptionist', 'intelligence.studio'],
  journey: ['website', 'website.hosting'],
  'legal-pages': ['website', 'website.studio'],
  'migration-0039': ['platform_admin', 'platform.database'],
  modes: ['booking', 'calendar.google'],
  notify: ['messaging', 'messaging.owner_notices'],
  onboarding: ['auth_onboarding', 'onboarding.selfserve', 'activation'],
  operations: ['platform_admin', 'platform.admin', 'invited-user'],
  operator: ['business_assistant', 'assist.ask'],
  'person-deletion': ['security', 'account.deletion'],
  phone: ['receptionist', 'phone.calls'],
  qa: ['platform_admin', 'platform.qa'],
  'qa-command-center': ['platform_admin', 'platform.qa'],
  'qa-inventory': ['platform_admin', 'platform.qa'],
  'qa-ui': ['platform_admin', 'platform.qa'],
  readiness: ['commercial', 'platform.database'],
  'receptionist-eval': ['receptionist', 'receptionist.chat', 'receptionist'],
  receptionist: ['receptionist', 'receptionist.chat', 'receptionist'],
  reconcile: ['billing', 'billing.reconcile'],
  rekey: ['security', 'platform.tokens'],
  release: ['security', 'calendar.google'],
  'render-golden': ['website', 'website.hosting'],
  review: ['platform_admin', 'platform.admin', 'admin-console'],
  'sales-attribution': ['commercial', 'commercial.attribution'],
  'sales-business': ['commercial', 'commercial.attribution'],
  'sales-funnel': ['commercial', 'commercial.attribution'],
  scale: ['platform_admin', 'platform.cron'],
  'security-headers': ['security', 'platform.admin'],
  'sessions-purge': ['security', 'auth.google_signin'],
  'setup-rules': ['auth_onboarding', 'onboarding.selfserve'],
  'site-import': ['website', 'website.studio', 'website-studio'],
  'site-starter-conversion': ['website', 'website.hosting'],
  'studio-hardening': ['website', 'website.studio'],
  'studio-inline': ['website', 'website.studio'],
  'twilio-accounts': ['messaging', 'followups.sms'],
  'ui-standards': ['layouts', null],
  unified: ['receptionist', 'intelligence.studio'],
  url: ['website', 'website.hosting'],
  'voice-admin': ['receptionist', 'receptionist.voice'],
  'voice-bench': ['receptionist', 'receptionist.voice'],
  'voice-budgets': ['spending', 'receptionist.voice'],
  'voice-core': ['receptionist', 'receptionist.voice'],
  'voice-customer': ['receptionist', 'receptionist.voice', 'receptionist'],
  'voice-elevenlabs': ['receptionist', 'receptionist.voice'],
  'voice-global': ['receptionist', 'receptionist.voice'],
  'voice-openai': ['receptionist', 'receptionist.voice'],
  'voice-promote': ['receptionist', 'receptionist.voice'],
  'voice-readiness': ['receptionist', 'receptionist.voice'],
  'voice-reliability': ['receptionist', 'receptionist.voice'],
  'voice-retell-lab': ['receptionist', 'receptionist.voice'],
  'voice-settings': ['receptionist', 'receptionist.voice'],
  'voice-testing': ['receptionist', 'receptionist.voice'],
  'website-ai': ['website', 'website.ai'],
  'website-catalog': ['website', 'website.hosting'],
  'website-flow': ['website', 'website.studio', 'website-studio'],
  'website-images': ['website', 'website.ai'],
  'website-logo': ['website', 'website.studio'],
  'website-one-editor': ['website', 'website.studio'],
  website: ['website', 'website.hosting'],
  'who-is-meant': ['business_assistant', 'assist.ask'],
  writing: ['business_assistant', 'assist.writing'],
}

// test/e2e/<name>.spec.js → [area, feature, journey, covers (source paths the browser test exercises; null = impact
// can't be determined → 'uncertain')]
const F = 'functions/api/'
export const E2E_MAP = {
  acceptance: ['platform_admin', 'platform.admin', null, [`${F}acceptance`, 'server/acceptance.js', 'src/admin']],
  account: ['business_settings', 'account.controls', null, [`${F}dashboard/people.js`, 'src/dashboard/AccountSettings.jsx', `${F}dashboard/account.js`]],
  'admin-assistant': ['admin_assistant', 'platform.admin', 'admin-assistant', ['server/admin-assist', `${F}platform/assist.js`, 'src/admin/AdminAssistant.jsx']],
  'admin-layout': ['layouts', 'platform.admin', null, ['src/admin']],
  admin: ['platform_admin', 'platform.admin', 'admin-console', ['src/admin/Admin.jsx', `${F}platform/overview.js`, `${F}platform/invites.js`]],
  'ads-openai': ['ads', 'ads.openai', null, ['server/ads/openai.js', `${F}dashboard/ads`]],
  ads: ['ads', 'ads.google', null, ['server/ads', `${F}dashboard/ads`, `${F}ads`]],
  'ai-writing': ['business_assistant', 'assist.writing', null, ['server/writing.js', `${F}dashboard/write.js`]],
  app: ['auth_onboarding', 'onboarding.selfserve', 'activation', null],
  ask: ['business_assistant', 'assist.ask', null, null],
  assistant: ['business_assistant', 'assist.ask', null, ['server/operator.js', `${F}dashboard/assist.js`, `${F}dashboard/insights.js`]],
  automation: ['messaging', 'messaging.email', 'booking', ['server/messages.js', `${F}appointment/confirm.js`]],
  'booking-excellence': ['booking', 'calendar.google', 'booking', ['src/booking', `${F}book`]],
  booking: ['booking', 'calendar.google', 'booking', ['src/booking', `${F}book`, 'server/booking.js']],
  'business-details': ['business_settings', 'onboarding.selfserve', null, [`${F}dashboard/profile.js`, `${F}dashboard/hours.js`]],
  commercial: ['partners', 'commercial.commissions', null, ['src/admin/Commercial.jsx', `${F}platform/partners.js`, `${F}platform/commercial.js`]],
  'control-center': ['platform_admin', 'platform.incidents', 'calendar-recovery', ['src/admin/Control.jsx', 'src/admin/control', `${F}platform/control.js`]],
  coverage: ['booking', 'lead.qualify', 'booking', ['server/coverage.js', 'server/zipcode.js', `${F}book`]],
  'dashboard-excellence': ['layouts', null, null, ['src/dashboard/Home.jsx']],
  'dashboard-receptionist': ['receptionist', 'receptionist.chat', null, ['src/dashboard/Receptionist.jsx']],
  deletion: ['security', 'account.deletion', null, ['server/deletion.js', `${F}dashboard/account.js`]],
  designer: ['website', 'website.ai', 'website-studio', ['server/ai-designer.js', `${F}dashboard/website`]],
  'email-signin': ['auth_onboarding', 'auth.email_signin', null, ['server/email-auth.js', `${F}auth`]],
  enrollment: ['billing', 'onboarding.selfserve', null, ['server/enrollment.js', `${F}platform`]],
  enterprise: ['commercial', 'lead.enterprise_inquiry', null, ['server/enterprise.js', `${F}enterprise`]],
  flagship: ['layouts', null, null, ['src/components', 'src/content']],
  followups: ['messaging', 'followups.engine', null, ['server/followups', `${F}dashboard/followups`]],
  help: ['layouts', null, null, ['src/content/help.js', 'src/dashboard/Help.jsx']],
  home: ['commercial', null, null, ['src/components', 'src/content']],
  import: ['website', 'website.studio', 'website-studio', ['server/site-import.js', 'server/website-import.js', `${F}dashboard/website/import.js`]],
  journey: ['auth_onboarding', 'onboarding.selfserve', 'activation', null],
  'load-errors': ['layouts', null, null, null],
  modes: ['booking', 'calendar.google', null, ['server/booking.js', `${F}book`]],
  onboarding: ['auth_onboarding', 'calendar.google', 'activation', [`${F}google`, `${F}admin`, 'src/dashboard/Setup.jsx']],
  phone: ['receptionist', 'phone.calls', null, ['server/telephony', `${F}dashboard/phone.js`]],
  'qa-center': ['platform_admin', 'platform.qa', null, ['src/admin/control/qa', 'src/admin/control/qa-api.js', 'src/admin/control/qa-lib.js', 'src/admin/Qa.jsx', `${F}platform/qa`]],
  privacy: ['security', null, null, ['src/legal/Privacy.jsx', 'vite.config.js']],
  quality: ['layouts', null, null, null],
  'receptionist-voice': ['receptionist', 'receptionist.voice', 'receptionist', ['server/voice', `${F}dashboard/receptionist`]],
  receptionist: ['receptionist', 'receptionist.chat', 'receptionist', ['server/receptionist', `${F}receptionist`]],
  review: ['platform_admin', 'platform.admin', 'admin-console', ['server/ops', `${F}platform/review.js`, 'src/admin/Review.jsx']],
  selfserve: ['billing', 'billing.stripe', 'activation', null],
  'session-expired': ['security', 'auth.google_signin', null, ['server/auth.js', 'src/lib/api.js']],
  'site-layout': ['layouts', 'website.hosting', null, ['server/site-render-v2.js', 'server/site-render.js', 'server/site-designed.js']],
  site: ['commercial', null, null, ['src/components', 'src/content']],
  'studio-editor': ['website', 'website.studio', 'website-studio', ['src/dashboard/SiteStudio.jsx', `${F}dashboard/website`]],
  'studio-hardening': ['website', 'website.studio', null, ['src/dashboard/SiteStudio.jsx']],
  'teach-ai': ['receptionist', 'intelligence.studio', null, ['server/intelligence', `${F}dashboard/ai-rules.js`, 'src/dashboard/TeachAI.jsx']],
  tour: ['layouts', null, null, null],
  'voice-lab': ['receptionist', 'receptionist.voice', null, ['server/voice', `${F}platform/voice-lab`, 'src/admin/VoiceLab.jsx']],
  'voice-mic': ['receptionist', 'receptionist.voice', null, ['src/voice', 'server/voice/customer.js']],
  'voice-rollout': ['receptionist', 'receptionist.voice', null, ['server/voice/global.js', `${F}platform/voice-provider.js`, 'src/admin/GlobalProvider.jsx']],
  'website-flow': ['website', 'website.studio', 'website-studio', null],
  'website-journey': ['website', 'website.studio', 'website-studio', null],
  website: ['website', 'website.hosting', null, ['src/dashboard/WebsiteTab.jsx', `${F}dashboard/website`]],
  'works-with': ['commercial', null, null, ['src/components', 'src/content']],
}
// Shared by every browser test: the harness. Part of every browser test's dependency hash.
const E2E_HARNESS = ['test/e2e/test.js', 'test/e2e/helpers.js', 'test/e2e/fixtures.env', 'test/e2e/mock-google.mjs', 'test/e2e/serve.sh', 'playwright.config.js']
// Human journeys (server/ops/journeys.js) → area + what the steps exercise.
export const JOURNEY_MAP = {
  activation: ['auth_onboarding', ['src/dashboard/Setup.jsx', 'server/onboarding.js', 'server/stripe.js', `${F}dashboard`]],
  booking: ['booking', ['src/booking', `${F}book`, 'server/booking.js', 'server/messages.js']],
  'returning-owner': ['booking', ['src/dashboard/Home.jsx', `${F}dashboard/outcome.js`, `${F}auth`]],
  'invited-user': ['auth_onboarding', ['server/accounts.js', `${F}invite.js`, `${F}dashboard/accept-invite.js`]],
  'calendar-recovery': ['booking', ['server/calendar.js', 'server/ops/incidents.js']],
  'admin-console': ['platform_admin', ['src/admin', 'server/ops']],
  receptionist: ['receptionist', ['server/receptionist', 'server/voice', `${F}receptionist`]],
  'website-studio': ['website', ['src/dashboard/SiteStudio.jsx', 'server/ai-designer.js', 'server/site-render-v2.js', `${F}dashboard/website`]],
  'admin-assistant': ['admin_assistant', ['server/admin-assist', `${F}platform/assist.js`]],
  'admin-assistant-qa': ['admin_assistant', ['server/admin-assist', `${F}platform/assist.js`, 'server/ops']],
}

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const sha = (s) => createHash('sha256').update(s).digest('hex')
const short = (s) => sha(s).slice(0, 12)
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '')
// Stable test id: kind + file + a hash of the exact title (a renamed test is a new test; its history stays under the old id).
export const titleId = (kind, base, title) => `${kind}:${base}:${sha(title).slice(0, 10)}`

// Test titles from a file: test('…'), test.skip("…"), test(`… ${x} …`). Template titles become patterns (`${…}` → any).
const TITLE_RE = /^\s*test(?:\.(?:skip|only|fixme|fail))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gm
export function titlesOf(src) {
  const out = []
  for (const m of src.matchAll(TITLE_RE)) {
    const raw = m[2].replace(/\\(['"`\\])/g, '$1')
    out.push({ title: raw, pattern: m[1] === '`' && raw.includes('${') })
  }
  return out
}

function testsOfFile(kind, rel, base, [area, feature, journey], extra = {}) {
  const seen = new Set()
  const out = []
  for (const { title, pattern } of titlesOf(read(rel))) {
    const id = titleId(kind === 'unit' ? 'unit' : 'e2e', base, title)
    if (seen.has(id)) continue
    seen.add(id)
    const t = { id, title, kind, file: rel, area, journey: journey || 'other', feature: feature || null, class: 'automated', h: rel, ...extra }
    if (pattern) t.pattern = true
    out.push(t)
    if (kind === 'e2e' && /@mobile/.test(title)) out.push({ ...t, id: `${id}.mobile`, mobile: true })
  }
  return out
}

// The admin-assistant scenarios (the eval script imports node:sqlite). At build time a missing module must never fail
// the deployment build: the scenarios' hashes are then left out (their results show as uncertain).
async function evalScenarios(strict) {
  try {
    return (await import('./admin-assistant-eval.mjs')).S
  } catch (err) {
    if (strict) throw err
    console.warn('qa-inventory: evaluation scenarios unavailable:', err?.code || err?.name)
    return []
  }
}

export async function buildInventory({ strict = true } = {}) {
  const { JOURNEYS } = await import('../server/ops/journeys.js')
  const tests = []
  const files = {}
  for (const f of readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.test.js')).sort()) {
    const base = f.replace(/\.test\.js$/, '')
    const map = UNIT_MAP[base] || ['unassigned', null, null]
    const rel = `test/${f}`
    files[rel] = { kind: 'unit', area: map[0], feature: map[1] ?? null, journey: map[2] ?? null, impact: 'deps' }
    tests.push(...testsOfFile('unit', rel, base, map, { impact: 'deps' }))
  }
  for (const f of readdirSync(path.join(ROOT, 'test/e2e')).filter((x) => x.endsWith('.spec.js')).sort()) {
    const base = f.replace(/\.spec\.js$/, '')
    const map = E2E_MAP[base] || ['unassigned', null, null, null]
    const rel = `test/e2e/${f}`
    const impact = map[3] ? 'declared' : 'uncertain'
    files[rel] = { kind: 'e2e', area: map[0], feature: map[1] ?? null, journey: map[2] ?? null, impact, covers: map[3] || null }
    tests.push(...testsOfFile('e2e', rel, base, map, { impact }))
  }
  // Journey-linked browser tests (journeys.js `tests`) belong to that journey even when their file maps elsewhere.
  for (const j of JOURNEYS) {
    for (const lt of j.tests) for (const t of tests) if (t.kind === 'e2e' && t.file.endsWith(`/${lt.spec}`) && t.title.startsWith(lt.title)) t.journey = j.id
  }
  // Guided human steps.
  for (const j of JOURNEYS) {
    const [area] = JOURNEY_MAP[j.id] || ['unassigned']
    for (const s of j.steps) tests.push({ id: `human:${j.id}.${s.id}`, title: s.title, kind: 'human', file: null, area, journey: j.id, feature: s.feature, class: s.assisted ? 'ai_assisted' : 'human', h: `journey:${j.id}`, impact: JOURNEY_MAP[j.id] ? 'declared' : 'uncertain' })
  }
  // Paid evaluations: never automatic (class authorization; the QA budget + QA_PAID_EVALS gate them).
  const S = await evalScenarios(strict)
  for (const s of S) tests.push({ id: `eval:admin:${s.id}`, title: s.q, kind: 'eval', file: 'scripts/admin-assistant-eval.mjs', area: 'admin_assistant', journey: 'admin-assistant', feature: 'platform.admin', class: 'authorization', h: `eval:admin:${s.id}`, impact: 'deps', suite: 'admin_eval' })
  tests.push({ id: 'eval:receptionist:real', title: 'Receptionist: 100 scenarios on the real model', kind: 'eval', file: 'scripts/receptionist-eval.mjs', area: 'receptionist', journey: 'receptionist', feature: 'receptionist.chat', class: 'authorization', h: 'scripts/receptionist-eval.mjs', impact: 'deps', suite: 'receptionist_eval' })
  return { areas: AREAS.map(([id, title]) => ({ id, title })), files, tests }
}

// Compact form: GROUPS hold what tests share (file, area, feature, journey, class, impact, hash key); TESTS are
// [id, title, group, overrides?]. server/ops/qa-tests.js expands them.
const SHARED = ['kind', 'file', 'area', 'journey', 'feature', 'class', 'h', 'impact', 'suite']
export async function writeGenerated() {
  const inv = await buildInventory()
  const groups = {}
  const rows = []
  for (const t of inv.tests) {
    const key = t.kind === 'human' ? t.h : t.kind === 'eval' ? `${t.suite}` : t.file
    const g = Object.fromEntries(SHARED.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]))
    if (t.kind === 'eval' || t.kind === 'human') delete g.h
    groups[key] ??= g
    const over = {}
    for (const [k, v] of Object.entries(t)) if (!['id', 'title'].includes(k) && JSON.stringify(groups[key][k]) !== JSON.stringify(v) && !(k === 'h' && (t.kind === 'eval' || t.kind === 'human'))) over[k] = v
    rows.push(Object.keys(over).length ? [t.id, t.title, key, over] : [t.id, t.title, key])
  }
  return [
    '// GENERATED by scripts/qa-inventory.mjs — do not edit. Regenerate: node scripts/qa-inventory.mjs',
    '// (test/qa-inventory.test.js fails when this file is stale). Structure only: hashes are computed at build time',
    '// into dist/qa-hashes.json. Rows: [id, title, group, overrides?].',
    `export const AREAS = ${JSON.stringify(inv.areas)}`,
    `export const GROUPS = ${JSON.stringify(groups)}`,
    `export const TESTS = [\n${rows.map((r) => JSON.stringify(r)).join(',\n')},\n]`,
    '',
  ].join('\n')
}

// ---------- hashes (build time) ----------
const fileHash = new Map()
const hashFile = (rel) => {
  if (!fileHash.has(rel)) fileHash.set(rel, existsSync(path.join(ROOT, rel)) ? short(read(rel)) : 'missing')
  return fileHash.get(rel)
}
const IMPORT_RE = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g
let lock = null
const pkgVersion = (name) => {
  if (!lock) lock = existsSync(path.join(ROOT, 'package-lock.json')) ? JSON.parse(read('package-lock.json')) : { packages: {} }
  const top = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
  return lock.packages?.[`node_modules/${top}`]?.version || null
}
const resolveRel = (from, spec) => {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  for (const c of [base, `${base}.js`, `${base}.jsx`, `${base}/index.js`]) if (existsSync(path.join(ROOT, c)) && statSync(path.join(ROOT, c)).isFile()) return c
  return null
}
const closureMemo = new Map()
// Every repository file reachable by static or literal dynamic import from `start` (incl. itself), plus npm packages.
export function closure(starts) {
  const files = new Set()
  const pkgs = new Set()
  const stack = [...starts]
  while (stack.length) {
    const rel = stack.pop()
    if (files.has(rel)) continue
    files.add(rel)
    if (!/\.(m?js|jsx)$/.test(rel)) continue
    if (!closureMemo.has(rel)) {
      const deps = []
      for (const m of read(rel).matchAll(IMPORT_RE)) {
        const spec = m[1] || m[2] || m[3]
        if (spec.startsWith('.')) {
          const r = resolveRel(rel, spec)
          if (r) deps.push(r)
        } else if (!spec.startsWith('node:')) deps.push(`npm:${spec}`)
      }
      closureMemo.set(rel, deps)
    }
    for (const d of closureMemo.get(rel)) {
      if (d.startsWith('npm:')) pkgs.add(d.slice(4))
      else stack.push(d)
    }
  }
  return { files, pkgs }
}
const expand = (p) => {
  const abs = path.join(ROOT, p)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return [p]
  return readdirSync(abs, { recursive: true }).map((f) => path.posix.join(p, String(f))).filter((f) => /\.(m?js|jsx|css)$/.test(f) && statSync(path.join(ROOT, f)).isFile())
}
const depsHash = (starts) => {
  const { files, pkgs } = closure(starts)
  const parts = [...files].sort().map((f) => `${f}:${hashFile(f)}`)
  for (const p of [...pkgs].sort()) parts.push(`npm:${p}@${pkgVersion(p)}`)
  return short(parts.join('\n'))
}

export async function computeHashes() {
  const inv = await buildInventory({ strict: false })
  const { JOURNEYS } = await import('../server/ops/journeys.js')
  const S = await evalScenarios(false)
  const out = {}
  for (const [rel, f] of Object.entries(inv.files)) {
    if (f.kind === 'unit') out[rel] = { def: hashFile(rel), deps: depsHash([rel]) }
    else out[rel] = { def: hashFile(rel), deps: f.covers ? depsHash([rel, ...E2E_HARNESS, ...f.covers.flatMap(expand)]) : null }
  }
  for (const j of JOURNEYS) {
    const covers = JOURNEY_MAP[j.id]?.[1]
    out[`journey:${j.id}`] = { def: short(JSON.stringify(j.steps)), deps: covers ? depsHash(covers.flatMap(expand)) : null }
  }
  const evalDeps = depsHash(['scripts/admin-assistant-eval.mjs', 'functions/api/platform/assist.js', 'test/fixtures/admin-assistant-data.js'])
  for (const s of S) out[`eval:admin:${s.id}`] = { def: short(JSON.stringify(s, (k, v) => (v instanceof RegExp ? String(v) : v))), deps: evalDeps }
  out['scripts/receptionist-eval.mjs'] = { def: hashFile('scripts/receptionist-eval.mjs'), deps: depsHash(['scripts/receptionist-eval.mjs']) }
  return out
}

const main = import.meta.url === new URL(`file://${process.argv[1]}`).href
if (main) {
  const i = process.argv.indexOf('--hashes')
  if (i >= 0) {
    const dir = process.argv[i + 1] || 'dist'
    if (!existsSync(path.join(ROOT, dir))) throw new Error(`${dir}/ missing: run after vite build`)
    // Never fails the build: without the file the QA Command Center reports change impact as uncertain.
    try {
      const hashes = await computeHashes()
      let commit = process.env.CF_PAGES_COMMIT_SHA || null
      if (!commit) {
        try {
          commit = (await import('node:child_process')).execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        } catch {}
      }
      writeFileSync(path.join(ROOT, dir, 'qa-hashes.json'), JSON.stringify({ commit, hashes }))
      console.log(`qa-hashes.json: ${Object.keys(hashes).length} keys`)
    } catch (err) {
      console.warn('qa-hashes.json not written:', err?.message)
    }
  } else {
    const body = await writeGenerated()
    writeFileSync(path.join(ROOT, OUT), body)
    console.log(`${OUT}: written`)
  }
}
