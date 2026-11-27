// Production verification checks (QA Command Center executor 2). They verify the DEPLOYMENT: real HTTP requests to the
// production origin (QA_PRODUCTION_ORIGIN, default the site origin; GET only, 5-second timeout, User-Agent
// GetShowUps-QA), through routing, functions/_middleware.js and the deployed build. READ-ONLY: refusals that answer
// before anything is read or written, static pages, and only an ADMIN-MARKED TEST business's public pages (never
// PoolThru, never getshowups, never a booking-times lookup, which records availability). The only rows such a request
// can add are rate-limit counters (counted per check: `rateLimited`).
// If the origin can't be reached from here (a same-zone fetch refused), the checks fall back to calling the route
// handlers in process; those results are recorded as `unverified` and labelled "in-process, not through the edge": they
// never count as production verified. A few checks read production records directly (migrations, cron heartbeat).
// Each check → { status: pass | fail | blocked | skipped | unverified, actual, rateLimited? }.
import { buildInfo, migrationStatus } from './changes.js'
import { heartbeat } from '../heartbeat.js'
import { siteOrigin } from '../auth.js'

export const UA = 'GetShowUps-QA'
const TIMEOUT_MS = 5000
const NEVER = new Set(['poolthru-llc', 'getshowups'])
export const IN_PROCESS = 'in-process, not through the edge'

export function productionOrigin(env) {
  const o = String(env.QA_PRODUCTION_ORIGIN || '')
  if (/^https:\/\/[a-z0-9.-]+$/i.test(o) || /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o)) return o
  try {
    const s = siteOrigin(env)
    return /^https:\/\/|^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(s) ? s : null
  } catch {
    return null
  }
}
export async function edgeGet(origin, path) {
  return fetch(`${origin}${path}`, { method: 'GET', headers: { 'User-Agent': UA, Accept: 'application/json, text/html' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
}

// One admin-marked test business (never PoolThru / getshowups), or null.
export async function testBusiness(env) {
  try {
    const { results } = await env.ONBOARDING_DB.prepare("SELECT t.customer FROM test_businesses t JOIN customers c ON c.id = t.customer WHERE t.is_test = 1 AND c.status = 'active' ORDER BY t.customer LIMIT 10").all()
    return results.map((r) => r.customer).find((id) => !NEVER.has(id)) || null
  } catch {
    return null
  }
}

const expect = (want) => (res) => (res.status === want ? { status: 'pass', actual: `HTTP ${res.status}` } : { status: 'fail', actual: `HTTP ${res.status} (expected ${want})` })
const inProcess = (load, method, path, want, init = {}, params = {}) => async (env) => {
  const mod = await load()
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(`${siteOrigin(env)}${path}`, { method, ...init }), env, params, waitUntil: () => {} })
  return { status: 'unverified', actual: `${IN_PROCESS}: HTTP ${res.status}${res.status === want ? ' as expected' : ` (expected ${want})`}` }
}
// An edge check: `edge(ctx)` through HTTP; `fallback(env)` when the edge can't be reached (labelled), or none.
const http = (def) => ({ ...def, http: true })
const JSON_POST = (origin) => ({ headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })

export const PROD_CHECKS = [
  http({
    id: 'prod:build-commit', title: 'The edge serves this deployment’s build (build.json)', area: 'platform_admin', feature: 'platform.admin', expected: 'build.json from the production origin with the deployed commit',
    edge: async (ctx, env) => {
      const res = await edgeGet(ctx.origin, '/build.json')
      const j = res.ok ? await res.json().catch(() => null) : null
      const mine = (await buildInfo(env))?.commit || null
      if (!j?.commit) return { status: 'fail', actual: `HTTP ${res.status}: no build.json commit at the edge` }
      if (mine && j.commit !== mine) return { status: 'fail', actual: `edge serves ${j.commit.slice(0, 7)}, this deployment built ${mine.slice(0, 7)} (a deploy in progress, or a rollback)` }
      return { status: 'pass', actual: `edge commit ${j.commit.slice(0, 7)}, built ${j.builtAt}` }
    },
    fallback: async (env) => {
      const b = await buildInfo(env)
      return b?.commit ? { status: 'unverified', actual: `${IN_PROCESS}: build.json commit ${b.commit.slice(0, 7)}` } : { status: 'fail', actual: 'build.json missing or without a commit' }
    },
  }),
  http({
    id: 'prod:edge-headers', title: 'Signed-in areas can’t be framed; HTTPS is enforced (middleware)', area: 'security', feature: 'platform.admin', expected: 'X-Frame-Options DENY on /dashboard (+ HSTS on https)',
    edge: async (ctx) => {
      const res = await edgeGet(ctx.origin, '/dashboard')
      const xfo = res.headers.get('X-Frame-Options')
      const hsts = res.headers.get('Strict-Transport-Security')
      const bad = [xfo !== 'DENY' && `X-Frame-Options ${xfo || 'missing'}`, ctx.origin.startsWith('https:') && !hsts && 'HSTS missing'].filter(Boolean)
      return bad.length ? { status: 'fail', actual: bad.join('; ') } : { status: 'pass', actual: `HTTP ${res.status}, X-Frame-Options DENY${hsts ? ', HSTS' : ''}` }
    },
    fallback: async () => ({ status: 'blocked', actual: 'needs the edge (middleware headers can’t be checked in process)' }),
  }),
  http({ id: 'prod:homepage', title: 'Homepage loads', area: 'commercial', feature: 'platform.admin', expected: 'HTTP 200', edge: async (ctx) => expect(200)(await edgeGet(ctx.origin, '/')), fallback: async () => ({ status: 'blocked', actual: 'needs the edge' }) }),
  http({ id: 'prod:dashboard-signed-out', title: 'Dashboard refuses a signed-out visitor', area: 'security', feature: 'auth.google_signin', expected: 'HTTP 401', edge: async (ctx) => expect(401)(await edgeGet(ctx.origin, '/api/dashboard/me')), fallback: inProcess(() => import('../../functions/api/dashboard/me.js'), 'GET', '/api/dashboard/me', 401) }),
  http({ id: 'prod:platform-signed-out', title: 'Platform console refuses a signed-out visitor', area: 'security', feature: 'platform.admin', expected: 'HTTP 401', edge: async (ctx) => expect(401)(await edgeGet(ctx.origin, '/api/platform/me')), fallback: inProcess(() => import('../../functions/api/platform/me.js'), 'GET', '/api/platform/me', 401) }),
  http({ id: 'prod:qa-signed-out', title: 'QA Command Center refuses a signed-out visitor', area: 'security', feature: 'platform.qa', expected: 'HTTP 401', edge: async (ctx) => expect(401)(await edgeGet(ctx.origin, '/api/platform/qa/overview')), fallback: inProcess(() => import('../../functions/api/platform/qa/overview.js'), 'GET', '/api/platform/qa/overview', 401) }),
  http({ id: 'prod:admin-api-unauthorized', title: 'Admin API refuses a request without its token', area: 'security', feature: 'platform.admin', expected: 'HTTP 401', edge: async (ctx) => expect(401)(await edgeGet(ctx.origin, '/api/admin/google-health')), fallback: inProcess(() => import('../../functions/api/admin/google-health.js'), 'GET', '/api/admin/google-health', 401) }),
  http({
    id: 'prod:test-site', title: 'A test business’s public website renders', area: 'website', feature: 'website.hosting', expected: 'HTTP 200 for an admin-marked test business’s site', rateLimited: true,
    edge: async (ctx) => {
      if (!ctx.testBusiness) return { status: 'skipped', actual: 'no admin-marked test business' }
      const res = await edgeGet(ctx.origin, `/p/${ctx.testBusiness}`)
      return res.status === 200 ? { status: 'pass', actual: `HTTP 200 (${ctx.testBusiness})`, rateLimited: true } : { status: res.status === 404 ? 'blocked' : 'fail', actual: `HTTP ${res.status}${res.status === 404 ? ': the test business has no published site' : ''}`, rateLimited: true }
    },
    fallback: async () => ({ status: 'blocked', actual: 'needs the edge' }),
  }),
  http({
    id: 'prod:test-booking-page', title: 'A test business’s booking page loads', area: 'booking', feature: 'calendar.google', expected: 'HTTP 200 for /book/<test business> (the page only; no times are looked up)',
    edge: async (ctx) => (ctx.testBusiness ? expect(200)(await edgeGet(ctx.origin, `/book/${ctx.testBusiness}`)) : { status: 'skipped', actual: 'no admin-marked test business' }),
    fallback: async () => ({ status: 'blocked', actual: 'needs the edge' }),
  }),
  // Production records, read directly.
  {
    id: 'prod:migrations', title: 'Every migration in this build is applied', area: 'platform_admin', feature: 'platform.database', expected: 'No pending migration',
    run: async (env) => {
      const m = await migrationStatus(env, await buildInfo(env))
      if (!m) return { status: 'blocked', actual: 'build.json has no migration list' }
      const pending = m.filter((x) => x.applied === false).map((x) => x.file)
      return pending.length ? { status: 'fail', actual: `pending: ${pending.slice(0, 5).join(', ')}` } : { status: 'pass', actual: `${m.length} migrations, none pending` }
    },
  },
  {
    id: 'prod:qa-hashes', title: 'QA change-impact hashes match this deployment', area: 'platform_admin', feature: 'platform.qa', expected: 'qa-hashes.json for the deployed commit',
    run: async (env) => {
      const [b, h] = await Promise.all([buildInfo(env), (await import('./qa-freshness.js')).deployedHashes(env)])
      if (!h) return { status: 'fail', actual: 'qa-hashes.json missing: change impact is uncertain' }
      return h.commit && b?.commit && h.commit !== b.commit ? { status: 'fail', actual: 'hashes are from another commit' } : { status: 'pass', actual: `${Object.keys(h.hashes || {}).length} hash keys` }
    },
  },
  {
    id: 'prod:cron-heartbeat', title: 'The five-minute job is running', area: 'platform_admin', feature: 'platform.cron', expected: 'Last run under 20 minutes ago',
    run: async (env) => {
      const h = await heartbeat(env.ONBOARDING_DB)
      return h.status === 'ok' ? { status: 'pass', actual: `last run ${h.ageSeconds} s ago` } : { status: h.status === 'stale' ? 'fail' : 'blocked', actual: h.status === 'stale' ? `last run ${Math.round(h.ageSeconds / 60)} min ago` : 'no run recorded' }
    },
  },
  // Refusals of writes need a POST, which production verification never sends to the edge: in process only, labelled.
  { id: 'prod:write-signed-out', title: 'Owner writes refuse a signed-out visitor (in process)', area: 'security', feature: 'assist.writing', expected: 'HTTP 401', run: async (env) => inProcess(() => import('../../functions/api/dashboard/write.js'), 'POST', '/api/dashboard/write', 401, JSON_POST(siteOrigin(env)))(env) },
  { id: 'prod:chat-cross-site', title: 'Receptionist chat refuses another site (in process)', area: 'security', feature: 'receptionist.chat', expected: 'HTTP 403', run: inProcess(() => import('../../functions/api/receptionist/[customer]/chat.js'), 'POST', '/api/receptionist/poolthru-llc/chat', 403, JSON_POST('https://evil.example'), { customer: 'poolthru-llc' }) },
]

// The batch context: can the origin be reached (probe = GET /build.json)? → { mode: 'edge' | 'in_process', origin, testBusiness }
export async function edgeContext(env) {
  const origin = productionOrigin(env)
  const tb = await testBusiness(env)
  if (!origin) return { mode: 'in_process', origin: null, testBusiness: tb, why: 'no production origin configured' }
  try {
    const res = await edgeGet(origin, '/build.json')
    return { mode: 'edge', origin, testBusiness: tb, probe: res.status }
  } catch (err) {
    return { mode: 'in_process', origin, testBusiness: tb, why: err?.name === 'TimeoutError' ? 'timeout' : 'unreachable' }
  }
}
export async function runCheck(c, env, ctx) {
  if (!c.http) return c.run(env)
  if (ctx.mode === 'edge') return c.edge(ctx, env)
  return c.fallback(env)
}
