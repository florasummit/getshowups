// AI website usage policy, enforced on the server per business and per UTC day.
//   - Full generations ("three new designs") and AI revisions ("describe a change") have separate allowances.
//   - Only successful AI results count; failed requests and template fallbacks are free. Manual edits are
//     never limited.
//   - A 30-day AI cost ceiling per business (from recorded token cost) caps runaway spend; past it,
//     generation uses the standard layouts and revisions are refused.
//   - Abuse protection: the `websiteAi` burst rule (server/ratelimit.js) limits attempts per business.
// Tiers: testing = a platform admin is signed in, or the business is listed in AI_TESTING_BUSINESSES;
// paying = website hosting is active (subscribed, trialing, past due, or a pilot exempt from billing);
// starter = everyone else (self-serve before payment).
import { adminEmails } from './platform.js'
import { hostingStatus, isHosted } from './website.js'

export const TIERS = {
  testing: { generations: 200, revisions: 400, monthlyCostMicros: 10_000_000 },
  paying: { generations: 20, revisions: 40, monthlyCostMicros: 2_000_000 },
  starter: { generations: 5, revisions: 10, monthlyCostMicros: 500_000 },
}
const DAY = 24 * 60 * 60 * 1000
export const dayOf = (now) => Math.floor(now / DAY)
export const resetsAt = (now) => (dayOf(now) + 1) * DAY

const testingIds = (env) =>
  String(env.AI_TESTING_BUSINESSES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export async function tierFor(env, customer, email) {
  if (email && adminEmails(env).includes(String(email).toLowerCase())) return 'testing'
  if (testingIds(env).includes(customer.id)) return 'testing'
  return isHosted(await hostingStatus(env.ONBOARDING_DB, customer.id)) ? 'paying' : 'starter'
}

// { tier, generation: { used, limit, remaining }, revision: {...}, resetsAt, monthlyCapReached }
export async function aiUsage(env, customer, email, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const tier = await tierFor(env, customer, email)
  const t = TIERS[tier]
  const [rows, cost] = await Promise.all([
    db.prepare('SELECT kind, count FROM website_ai_usage WHERE customer = ?1 AND day = ?2').bind(customer.id, dayOf(now)).all(),
    db.prepare("SELECT coalesce(sum(cost_micros), 0) AS c FROM website_generations WHERE customer = ?1 AND source = 'ai' AND created_at >= ?2").bind(customer.id, now - 30 * DAY).first(),
  ])
  const used = Object.fromEntries(rows.results.map((r) => [r.kind, r.count]))
  const part = (kind, limit) => ({ used: used[kind] ?? 0, limit, remaining: Math.max(0, limit - (used[kind] ?? 0)) })
  return {
    tier,
    generation: part('generation', t.generations),
    revision: part('revision', t.revisions),
    resetsAt: resetsAt(now),
    monthlyCapReached: (cost?.c ?? 0) >= t.monthlyCostMicros,
  }
}

export async function recordAiUse(db, customerId, kind, now = Date.now()) {
  await db
    .prepare('INSERT INTO website_ai_usage (customer, day, kind, count) VALUES (?1, ?2, ?3, 1) ON CONFLICT(customer, day, kind) DO UPDATE SET count = count + 1')
    .bind(customerId, dayOf(now), kind)
    .run()
}
