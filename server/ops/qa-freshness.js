// Freshness / change impact: each test's status against the CURRENT production deployment.
//   verified          passed, and what it depends on is identical to the deployed code (hashes), or (no hashes) it
//                     passed on the deployed commit itself; production checks: passed on this deployment's commit
//   verified_ci_only  as verified, but only in CI/local while its feature's production check hasn't passed on this
//                     deployment (CI verification ≠ production verification)
//   stale             passed before, but its definition or dependencies changed since (or a person asked for a retest)
//   failed / blocked  the latest decisive result
//   untested          no result at all
//   uncertain         passed on another commit and its impact can't be determined (no hashes, or a browser test with no
//                     declared source list): a broader regression run is recommended. Never silently "verified".
// Hashes come from the deployment's own dist/qa-hashes.json (scripts/qa-inventory.mjs --hashes, at build time).
import { buildInfo } from './changes.js'
import { allTests } from './qa-tests.js'
import { latestByTest } from './qa-results.js'

export const TEST_STATES = ['verified', 'verified_ci_only', 'stale', 'failed', 'blocked', 'untested', 'uncertain']
export const emptyCounts = () => ({ verified: 0, verified_ci_only: 0, stale: 0, failed: 0, blocked: 0, untested: 0, uncertain: 0, total: 0 })

let hashCache = { key: null, value: null, at: 0 }
export async function deployedHashes(env, now = Date.now()) {
  if (hashCache.key === env.ASSETS && now - hashCache.at < 60_000) return hashCache.value
  let value = null
  try {
    if (env.ASSETS?.fetch) {
      const r = await env.ASSETS.fetch(new Request('https://assets.local/qa-hashes.json'))
      // Pages serves index.html for unknown paths: only a JSON body with `hashes` counts.
      if (r.ok) {
        const j = await r.json().catch(() => null)
        value = j && typeof j.hashes === 'object' ? j : null
      }
    }
  } catch {
    value = null
  }
  hashCache = { key: env.ASSETS, value, at: now }
  return value
}
export const resetHashCache = () => (hashCache = { key: null, value: null, at: 0 })

// The status of one test. ctx: { commit, releaseAt, hashes (map|null), prodPassed: Set of features }
export function statusOf(t, decisive, pass, ctx) {
  if (!decisive) return 'untested'
  if (decisive.status === 'fail') return 'failed'
  if (decisive.status === 'blocked') return 'blocked'
  if (decisive.status === 'retest_required') return 'stale'
  const onCommit = Boolean(ctx.commit && pass.revision && pass.revision.length >= 7 && ctx.commit.startsWith(pass.revision))
  let fresh
  if (t.kind === 'production') return onCommit ? 'verified' : 'stale'
  const cur = t.h && ctx.hashes ? ctx.hashes[t.h] : null
  if (cur && cur.deps && pass.defHash && pass.depsHash) fresh = cur.def === pass.defHash && cur.deps === pass.depsHash ? 'verified' : 'stale'
  else if (cur && !cur.deps && pass.defHash && cur.def !== pass.defHash) fresh = 'stale'
  else if (onCommit) fresh = 'verified'
  else if (t.kind === 'human' && ctx.releaseAt && pass.at >= ctx.releaseAt) fresh = 'verified'
  else fresh = 'uncertain'
  if (fresh === 'verified' && (pass.environment === 'ci' || pass.environment === 'local') && t.feature && ctx.prodChecked.has(t.feature) && !ctx.prodPassed.has(t.feature)) return 'verified_ci_only'
  return fresh
}

// → { ctx, statuses: Map testId → { status, last, lastPass } }
export async function freshness(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const [build, hashes, latest] = await Promise.all([buildInfo(env), deployedHashes(env, now), latestByTest(db)])
  const release = await db
    .prepare("SELECT at, details FROM audit_log WHERE action = 'platform.release' ORDER BY seq DESC LIMIT 1")
    .first()
    .catch(() => null)
  let rel = null
  try {
    rel = release ? { ...JSON.parse(release.details), at: release.at } : null
  } catch {
    rel = null
  }
  const commit = build?.commit || rel?.commit || null
  const tests = allTests().list
  // Features whose production check (prod:cap:<feature>) passed on THIS deployment.
  const prodPassed = new Set()
  const prodChecked = new Set()
  for (const t of tests) {
    if (!t.id.startsWith('prod:cap:')) continue
    prodChecked.add(t.feature)
    const p = latest.pass.get(t.id)
    const d = latest.decisive.get(t.id)
    if (p && d?.id === p.id && commit && p.revision && commit.startsWith(p.revision)) prodPassed.add(t.feature)
  }
  const ctx = { commit, releaseAt: rel && rel.commit === commit ? rel.at : null, release: rel, hashes: hashes?.hashes || null, hashesCommit: hashes?.commit || null, prodPassed, prodChecked }
  const statuses = new Map()
  const brief = (r) => (r ? { resultId: r.id, status: r.status, at: r.at, environment: r.environment, revision: r.revision } : null)
  for (const t of tests) {
    const d = latest.decisive.get(t.id) || null
    const p = latest.pass.get(t.id) || null
    statuses.set(t.id, { status: statusOf(t, d, p || d, ctx), last: brief(d), lastPass: brief(p), lastAny: brief(latest.any.get(t.id)) })
  }
  return { ctx, statuses, build }
}

export function countStates(tests, statuses) {
  const c = emptyCounts()
  for (const t of tests) {
    c[statuses.get(t.id)?.status || 'untested']++
    c.total++
  }
  return c
}
