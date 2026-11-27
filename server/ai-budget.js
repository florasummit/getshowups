// One spending guard for every model call GetShowUps pays for (docs/AI_SPENDING.md). Before a call: reserve its WORST-CASE
// cost against three daily ceilings at once — the whole platform, the business, and the entry point on that business —
// with one conditional UPDATE each (atomic in D1: concurrent requests can never pass a ceiling together). After the call:
// settle to what the provider reported (the unused part is given back). Fails CLOSED: if the counters can't be read or
// written, nothing is spent (unlike request rate limits, which fail open).
//
// Counters live in rate_limits (no migration): key `aib:<scope>:<UTC day>`, count = micro-dollars. Business ids only.
// Calls paid with an owner's own key, and Workers AI (free daily quota, no spend), never come here.
//
// Emergency switches (no deploy needed, take effect on the next request):
//   AI_ALL_OFF=true              every GetShowUps-paid model call is refused (customers get the booking/contact fallback)
//   AI_OFF_BUSINESSES=a,b        the same for the listed businesses only
// Ceilings (micro-dollars per UTC day; positive integers override the defaults):
//   AI_PLATFORM_DAILY_MICROS     all businesses and entry points together           default $25
//   AI_PUBLIC_DAILY_MICROS       public entry points together (receptionist)         default $15: owner tools keep headroom
//   AI_BUSINESS_DAILY_MICROS     one business, every entry point                     default $6
//   per entry and business: ENTRY_DAILY below (receptionist keeps RECEPTIONIST_DAILY_MICROS)
import { CUSTOMER_RE } from './invites.js'

const DAY = 86_400_000
const int = (v, d) => (/^\d{1,12}$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : d)
// Entry points that spend GetShowUps money, whether the public can reach them, and their per-business daily ceiling.
export const ENTRIES = {
  receptionist: { public: true, daily: (env) => int(env.RECEPTIONIST_DAILY_MICROS, 5_000_000) }, // chat, website panel, voice turns
  teach: { public: false, daily: () => 1_000_000 }, // Teach Your AI (Claude, owner)
  assistant: { public: false, daily: () => 1_000_000 }, // owner Assistant on Claude
  ads_plan: { public: false, daily: () => 1_000_000 }, // "Draft my plan" (Claude)
  ads_creative: { public: false, daily: () => 1_000_000 }, // ad images (OpenAI)
}
export const ceilings = (env) => ({
  platform: int(env.AI_PLATFORM_DAILY_MICROS, 25_000_000),
  public: int(env.AI_PUBLIC_DAILY_MICROS, 15_000_000),
  business: int(env.AI_BUSINESS_DAILY_MICROS, 6_000_000),
})
const offList = (env) => new Set(String(env.AI_OFF_BUSINESSES || '').split(',').map((s) => s.trim()).filter(Boolean))
// Off for this business right now (emergency switches): checked before any reservation, also by callers that only gate.
export const aiOff = (env, customerId) => env.AI_ALL_OFF === 'true' || offList(env).has(customerId)

const dayKey = (now) => new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
const keysFor = (entry, customerId, now) => {
  const d = dayKey(now)
  return [
    [`aib:platform:${d}`, 'platform'],
    ...(ENTRIES[entry].public ? [[`aib:public:${d}`, 'public']] : []),
    [`aib:biz:${customerId}:${d}`, 'business'],
    [`aib:entry:${entry}:${customerId}:${d}`, 'entry'],
  ]
}

// Today's counter rows exist (created once per worker and day, so a reservation is ONE round trip afterwards).
const made = new Set()
async function ensureRows(db, keys, now) {
  const missing = keys.filter(([k]) => !made.has(k))
  if (!missing.length) return
  const expires = (Math.floor(now / DAY) + 3) * DAY // kept 2 days past the day for the admin view; purged with rate_limits
  await db.prepare(`INSERT OR IGNORE INTO rate_limits (key, win, count, expires_at) VALUES ${missing.map((_, i) => `(?${i + 3}, ?1, 0, ?2)`).join(', ')}`).bind(Math.floor(now / DAY), expires, ...missing.map(([k]) => k)).run()
  if (made.size > 5000) made.clear()
  for (const [k] of missing) made.add(k)
}

// → { ok: true, reserved, settle(actualMicros) } | { ok: false, reason: 'ai_off' | 'platform' | 'public' | 'business' | 'entry' | 'unavailable' }
// micros = the call's worst case (input estimate + max output). ALL ceilings are checked and charged by one statement, so
// concurrent requests can never pass a ceiling together and a refusal charges nothing. settle() never throws.
export async function reserveAi(env, { entry, customerId, micros, now = Date.now(), retried = false }) {
  if (!ENTRIES[entry] || !CUSTOMER_RE.test(customerId || '')) return { ok: false, reason: 'unavailable' }
  if (aiOff(env, customerId)) return { ok: false, reason: 'ai_off' }
  const db = env.ONBOARDING_DB
  const amount = Math.max(1, Math.ceil(Number(micros) || 0))
  const c = ceilings(env)
  const limit = { platform: c.platform, public: c.public, business: c.business, entry: ENTRIES[entry].daily(env) }
  const keys = keysFor(entry, customerId, now)
  const list = keys.map((_, i) => `?${i * 2 + 2}`).join(', ')
  const over = keys.map((_, i) => `(r.key = ?${i * 2 + 2} AND r.count + ?1 > ?${i * 2 + 3})`).join(' OR ')
  const args = [amount, ...keys.flatMap(([k, scope]) => [k, limit[scope]])]
  let charged
  try {
    await ensureRows(db, keys, now)
    const r = await db.prepare(`UPDATE rate_limits SET count = count + ?1 WHERE key IN (${list}) AND (SELECT count(*) FROM rate_limits WHERE key IN (${list})) = ${keys.length} AND NOT EXISTS (SELECT 1 FROM rate_limits r WHERE ${over}) RETURNING key`).bind(...args).all()
    charged = r.results.length
    if (charged && charged !== keys.length) throw new Error('partial')
  } catch (err) {
    console.error('ai budget unavailable:', err?.message === 'partial' ? 'partial' : err?.name || 'error')
    made.clear()
    return { ok: false, reason: 'unavailable' }
  }
  if (!charged) {
    // Refused: name the ceiling that was reached (one read, only on refusal).
    const rows = (await db.prepare(`SELECT key, count FROM rate_limits WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...keys.map(([k]) => k)).all().catch(() => ({ results: [] }))).results
    // A counter row this worker believed existed is gone (purged, or another database): create it and try once more.
    if (rows.length < keys.length && !retried) {
      made.clear()
      return reserveAi(env, { entry, customerId, micros, now, retried: true })
    }
    const hit = keys.find(([k, scope]) => Number(rows.find((x) => x.key === k)?.count ?? 0) + amount > limit[scope])
    return { ok: false, reason: hit ? hit[1] : 'unavailable' }
  }
  let settled = false
  const keyList = keys.map(([k]) => k)
  return {
    ok: true,
    reserved: amount,
    // The provider's reported cost replaces the reservation (the unused part is given back). A call that cost MORE than
    // reserved is counted in full, so the next reservation sees it; that happens only when an estimate was wrong.
    settle: async (actual) => {
      if (settled) return
      settled = true
      const diff = Math.max(0, Math.ceil(Number(actual) || 0)) - amount
      if (!diff) return
      try {
        await db.prepare(`UPDATE rate_limits SET count = max(0, count + ?1) WHERE key IN (${keyList.map((_, i) => `?${i + 2}`).join(', ')})`).bind(diff, ...keyList).run()
      } catch (err) {
        console.error('ai budget settle failed:', err?.name || 'error')
      }
    },
  }
}

// Claude-style worst case: input tokens estimated from the request size (≈ 3.5 characters a token, rounded up) plus every
// output token allowed. Prices in micro-dollars per token.
export function worstCase({ chars, maxOutput, inPerToken, outPerToken }) {
  return Math.ceil((Number(chars) / 3.5) * inPerToken + Number(maxOutput) * outPerToken)
}

// Today's spend for the platform admin (business ids and micro-dollars only).
export async function spendToday(env, now = Date.now()) {
  const d = dayKey(now)
  const { results } = await env.ONBOARDING_DB.prepare("SELECT key, count FROM rate_limits WHERE key LIKE 'aib:%' AND key LIKE ?1 LIMIT 500").bind(`%:${d}`).all()
  const get = (k) => Number(results.find((r) => r.key === k)?.count || 0)
  const businesses = results
    .filter((r) => r.key.startsWith('aib:biz:'))
    .map((r) => ({ customer: r.key.split(':')[2], micros: Number(r.count) }))
    .sort((a, b) => b.micros - a.micros)
    .slice(0, 20)
  const entries = {}
  for (const r of results.filter((x) => x.key.startsWith('aib:entry:'))) {
    const e = r.key.split(':')[2]
    entries[e] = (entries[e] || 0) + Number(r.count)
  }
  return { day: d, platform: get(`aib:platform:${d}`), public: get(`aib:public:${d}`), businesses, entries, ceilings: ceilings(env), off: { all: env.AI_ALL_OFF === 'true', businesses: [...offList(env)] } }
}
