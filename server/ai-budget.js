// One spending guard for every model call GetShowUps pays for (docs/AI_SPENDING.md). Before a call: reserve its WORST-CASE
// cost against the daily ceilings at once — the whole platform, the public share (public entry points), the business,
// and the entry point on that business — in ONE conditional UPDATE (atomic in D1: concurrent requests can never pass a
// ceiling together; all or nothing). After the call: settle to what the provider reported (the unused part is given
// back). Fails CLOSED: if the counters can't be read or written, nothing is spent (unlike request rate limits).
//
// Counters live in rate_limits: key `aib:<scope>:<UTC day>`, count = micro-dollars. Business ids only.
// Calls paid with an owner's own key, and Workers AI (free daily quota, no spend), never come here.
//
// Limits are set in Admin → "AI spending" (table ai_budget_settings, migration 0050; platform admins, reason + confirm,
// audited; read with a 30-second cache, so a change applies within 30 s, no deploy). A missing row = the default:
//   platform_micros   all businesses and entry points together, per UTC day      default $5
//   public_micros     public entry points together (receptionist chat + voice)     default $3 (owner tools keep headroom)
//   business_micros   one business, every entry point                             default $1
//   retell_minutes    Retell voice minutes per UTC day, platform-wide (browser + phone) default 60 (server/voice/customer.js)
//   openai_minutes    OpenAI realtime voice minutes per UTC day, platform-wide          default 30
//   elevenlabs_minutes ElevenLabs voice minutes per UTC day, platform-wide              default 30
//   (Every voice start checks voiceRoom(): open calls count their full 15 minutes. VOICE_PROVIDER_DAILY_MINUTES stays a
//   second, independent ceiling; the lower one wins.)
//   all_off           1 = every GetShowUps-paid model call and voice start is refused
// Stricter endpoint limits stay: each entry's own per-business ceiling (ENTRIES), the receptionist's per-conversation $1
// and RECEPTIONIST_DAILY_MICROS, the Assistant's own OPERATOR_* limits. The effective limit is always the lowest.
// Emergency switches that need no database: AI_ALL_OFF=true, AI_OFF_BUSINESSES=a,b (Cloudflare variables). Per business:
// the existing admin restriction 'ai' (Admin → business → Controls; server/restrictions.js, audited).
import { CUSTOMER_RE } from './invites.js'
import { restricted } from './restrictions.js'

const DAY = 86_400_000
const int = (v, d) => (/^\d{1,12}$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : d)
// Entry points that spend GetShowUps money, whether the public can reach them, and their per-business daily ceiling.
export const ENTRIES = {
  receptionist: { public: true, daily: (env) => int(env.RECEPTIONIST_DAILY_MICROS, 5_000_000) }, // chat, website panel, voice turns
  teach: { public: false, daily: () => 1_000_000 }, // Teach Your AI (Claude, owner)
  assistant: { public: false, daily: () => 1_000_000 }, // owner Assistant on Claude
  ads_plan: { public: false, daily: () => 1_000_000 }, // "Draft my plan" (Claude)
  ads_creative: { public: false, daily: () => 1_000_000 }, // ad images (OpenAI)
  admin_assistant: { public: false, daily: () => 500_000 }, // platform-admin Assistant (server/admin-assist/), booked on 'getshowups'
}
export const DEFAULTS = { platform_micros: 5_000_000, public_micros: 3_000_000, business_micros: 1_000_000, retell_minutes: 60, openai_minutes: 30, elevenlabs_minutes: 30, all_off: 0 }
// What an admin may set (a typo can't open the tap): ceilings up to $100 / day, Retell up to 1,000 minutes.
export const MAX = { platform_micros: 100_000_000, public_micros: 100_000_000, business_micros: 100_000_000, retell_minutes: 1000, openai_minutes: 1000, elevenlabs_minutes: 1000, all_off: 1 }
// Voice providers billed per minute and their minute setting.
export const VOICE_MINUTES = { retell: 'retell_minutes', openai: 'openai_minutes', elevenlabs: 'elevenlabs_minutes' }
const WARN_AT = 0.8

let cache = { at: 0, db: null, values: null }
export const resetSettingsCache = () => (cache = { at: 0, db: null, values: null })
// → { platform_micros, public_micros, business_micros, retell_minutes, all_off, set: { key: { by, at } } }
export async function budgetSettings(env, now = Date.now()) {
  if (cache.values && cache.db === env.ONBOARDING_DB && now - cache.at < 30_000) return cache.values
  const values = { ...DEFAULTS, set: {} }
  try {
    const { results } = await env.ONBOARDING_DB.prepare('SELECT key, value, updated_by, updated_at FROM ai_budget_settings').all()
    for (const r of results) if (r.key in DEFAULTS && Number.isInteger(r.value) && r.value >= 0 && r.value <= MAX[r.key]) {
      values[r.key] = r.value
      values.set[r.key] = { by: r.updated_by, at: r.updated_at }
    }
  } catch (err) {
    // Before 0050: the defaults. Any other read error: the defaults too (they are the conservative ones).
    if (!String(err?.message).includes('no such table')) console.error('ai budget settings unreadable:', err?.name || 'error')
  }
  cache = { at: now, db: env.ONBOARDING_DB, values }
  return values
}
// Effective ceilings: the admin's settings, lowered (never raised) by the AI_*_DAILY_MICROS variables when those are set.
export async function ceilings(env, now = Date.now()) {
  const s = await budgetSettings(env, now)
  const low = (v, d) => Math.min(d, int(v, d))
  return { platform: low(env.AI_PLATFORM_DAILY_MICROS, s.platform_micros), public: low(env.AI_PUBLIC_DAILY_MICROS, s.public_micros), business: low(env.AI_BUSINESS_DAILY_MICROS, s.business_micros) }
}
const offList = (env) => new Set(String(env.AI_OFF_BUSINESSES || '').split(',').map((s) => s.trim()).filter(Boolean))
// Off for this business right now: the variables, the admin's all-off setting, or the business's 'ai' restriction.
// A restriction that can't be read counts as off (server/restrictions.js fails closed).
export async function aiOff(env, customerId, now = Date.now()) {
  if (env.AI_ALL_OFF === 'true' || offList(env).has(customerId)) return true
  if ((await budgetSettings(env, now)).all_off === 1) return true
  return restricted(env, customerId, 'ai')
}

// Admin change of one setting (the route checks the admin, same origin, reason and confirm, and audits it).
export async function setBudgetSetting(env, key, value, by, now = Date.now()) {
  if (!(key in DEFAULTS)) return { ok: false, error: 'invalid_setting' }
  const v = Number(value)
  if (!Number.isInteger(v) || v < 0 || v > MAX[key] || (key === 'all_off' && v > 1)) return { ok: false, error: 'invalid_value' }
  const before = (await budgetSettings(env, now))[key]
  try {
    await env.ONBOARDING_DB.prepare('INSERT INTO ai_budget_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_by = ?3, updated_at = ?4').bind(key, v, by, now).run()
  } catch (err) {
    return { ok: false, error: String(err?.message).includes('no such table') ? 'not_ready' : 'storage_error' }
  }
  resetSettingsCache()
  return { ok: true, before, after: v }
}

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
  if (await aiOff(env, customerId, now)) return { ok: false, reason: 'ai_off' }
  const db = env.ONBOARDING_DB
  const amount = Math.max(1, Math.ceil(Number(micros) || 0))
  const c = await ceilings(env, now)
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

// Bounded, fully accounted retries for a paid provider call. SDK clients are built with maxRetries: 0 (an SDK retry is a
// second billable attempt nobody reports); this makes at most `attempts` attempts, EACH with its own reservation:
//   success            → settled to the reported cost
//   provider refused   → an HTTP status (4xx/5xx/429) means nothing was generated: settled to 0
//   timeout / network  → no status: the provider may have billed it, so it KEEPS its worst-case reservation
// A retry happens only for transient failures and only while the budget still has room; a refused reservation ends the
// call. run(i) → { value, costMicros }. → { ok: true, value, attempts } | { ok: false, reason, error }.
export const transient = (err) => !err?.status || [408, 409, 429].includes(err.status) || err.status >= 500
export async function paidCall(env, { entry, customerId, micros, attempts = 2, retryable = transient, now }, run) {
  let last = null
  for (let i = 0; i < Math.max(1, Math.min(3, attempts)); i++) {
    const budget = await reserveAi(env, { entry, customerId, micros, now: now ?? Date.now() })
    if (!budget.ok) return { ok: false, reason: `budget_${budget.reason}`, error: last }
    try {
      const { value, costMicros } = await run(i)
      await budget.settle(costMicros)
      return { ok: true, value, attempts: i + 1 }
    } catch (err) {
      last = err
      if (err?.status) await budget.settle(0)
      if (!retryable(err)) break
    }
  }
  return { ok: false, reason: 'provider', error: last }
}

// Claude-style worst case: input tokens estimated from the request size (≈ 3.5 characters a token, rounded up) plus every
// output token allowed. Prices in micro-dollars per token.
export function worstCase({ chars, maxOutput, inPerToken, outPerToken }) {
  return Math.ceil((Number(chars) / 3.5) * inPerToken + Number(maxOutput) * outPerToken)
}

// Voice minutes (billed by each provider per minute, separate from the model spend above), platform-wide per UTC day:
// finished calls count their length, a call still open counts its FULL 15-minute ceiling (it may run that long), so a
// start is allowed only when even every open call running to its ceiling plus this one stays within the provider's
// minutes. Lab and customer sessions both count (Retell Lab rows are 'retell-lab').
export const VOICE_CALL_MAX_MIN = 15
export const RETELL_CALL_MAX_MIN = VOICE_CALL_MAX_MIN
export async function voiceRoom(env, provider, now = Date.now()) {
  const key = VOICE_MINUTES[provider]
  if (!key) return { ok: false, used: null, cap: 0 }
  const cap = (await budgetSettings(env, now))[key]
  const day = now - (now % DAY)
  try {
    const r = await env.ONBOARDING_DB.prepare(
      'SELECT COALESCE(SUM(CASE WHEN ended_at IS NULL THEN ?3 ELSE MIN(ended_at - created_at, ?3) END), 0) AS ms FROM receptionist_calls WHERE provider IN (?4, ?5) AND created_at >= ?1 AND created_at <= ?2',
    )
      .bind(day, now, VOICE_CALL_MAX_MIN * 60_000, provider, provider === 'retell' ? 'retell-lab' : provider)
      .first()
    const used = Math.ceil(Number(r?.ms || 0) / 60_000)
    return { ok: used + VOICE_CALL_MAX_MIN <= cap, used, cap }
  } catch {
    return { ok: false, used: null, cap } // unreadable → no new paid call (fails closed)
  }
}
export const retellRoom = (env, now = Date.now()) => voiceRoom(env, 'retell', now)

// Provider usage reconciliation: what the providers' OWN records say today's voice sessions cost (recorded by
// server/voice/charges.js recordCharges, hourly by cron and on an admin's request), next to our per-minute estimate
// for the same priced sessions. OpenAI has no per-session charge record (only an organization-admin costs API).
export const PER_MINUTE_ESTIMATE = { retell: 70_000, openai: 80_000, elevenlabs: 80_000 }
export async function voiceReconciliation(env, now = Date.now()) {
  const day = now - (now % DAY)
  try {
    const { results } = await env.ONBOARDING_DB.prepare(
      `SELECT coalesce(json_extract(state, '$.voice.provider'), json_extract(state, '$.lab.provider')) AS provider,
              count(*) AS sessions,
              sum(CASE WHEN coalesce(json_extract(state, '$.voice.charge.micros'), json_extract(state, '$.lab.charge.micros')) IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              coalesce(sum(coalesce(json_extract(state, '$.voice.charge.micros'), json_extract(state, '$.lab.charge.micros'))), 0) AS verified,
              coalesce(sum(CASE WHEN coalesce(json_extract(state, '$.voice.charge.micros'), json_extract(state, '$.lab.charge.micros')) IS NOT NULL
                           THEN coalesce(json_extract(state, '$.voice.charge.durationSeconds'), json_extract(state, '$.lab.charge.durationSeconds'), 0) END), 0) AS priced_seconds
         FROM receptionist_conversations WHERE created_at >= ?1 AND channel = 'voice'
        GROUP BY 1`,
    )
      .bind(day)
      .all()
    const out = {}
    for (const r of results) {
      if (!PER_MINUTE_ESTIMATE[r.provider]) continue
      const estimated = Math.ceil(Number(r.priced_seconds) / 60) * PER_MINUTE_ESTIMATE[r.provider]
      out[r.provider] = { sessions: Number(r.sessions), priced: Number(r.priced), verifiedMicros: Number(r.verified), estimatedMicros: estimated, drift: Number(r.priced) > 0 && Number(r.verified) > estimated * 1.25 }
    }
    return out
  } catch {
    return null
  }
}

// Today's spend for the platform admin (business ids and micro-dollars only), with near-limit warnings.
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
  const [c, s, retell, openai, elevenlabs, reconciled] = await Promise.all([ceilings(env, now), budgetSettings(env, now), voiceRoom(env, 'retell', now), voiceRoom(env, 'openai', now), voiceRoom(env, 'elevenlabs', now), voiceReconciliation(env, now)])
  const voice = { retell, openai, elevenlabs }
  const platform = get(`aib:platform:${d}`)
  const pub = get(`aib:public:${d}`)
  const near = (used, cap) => (cap > 0 && used >= cap ? 'reached' : cap > 0 && used >= cap * WARN_AT ? 'near' : null)
  const minutesWarning = (scope, v) => (v.used == null || v.used + VOICE_CALL_MAX_MIN > v.cap ? { scope, state: 'reached' } : near(v.used, v.cap) && { scope, state: 'near' })
  const warnings = [
    near(platform, c.platform) && { scope: 'platform', state: near(platform, c.platform) },
    near(pub, c.public) && { scope: 'public', state: near(pub, c.public) },
    ...businesses.filter((b) => near(b.micros, c.business)).map((b) => ({ scope: 'business', customer: b.customer, state: near(b.micros, c.business) })),
    ...Object.entries(voice).map(([p, v]) => minutesWarning(p, v)),
    ...Object.entries(reconciled || {})
      .filter(([, r]) => r.drift)
      .map(([p]) => ({ scope: 'drift', provider: p, state: 'reached' })),
  ].filter(Boolean)
  return {
    day: d,
    platform,
    public: pub,
    businesses,
    entries,
    ceilings: c,
    retell,
    voice,
    reconciled,
    settings: Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, s[k]])),
    changed: s.set,
    max: MAX,
    warnings,
    off: { all: env.AI_ALL_OFF === 'true' || s.all_off === 1, variable: env.AI_ALL_OFF === 'true', businesses: [...offList(env)] },
  }
}
