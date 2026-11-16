// Model choice for the business's own AI key: discovered from the customer's account, not hardcoded.
//   - discoverModels: the provider's model list with the customer's key (free, read-only). Anthropic reports capabilities
//     (structured outputs, effort); OpenAI reports ids only, so compatibility follows naming rules (families with
//     Structured Outputs; no audio/realtime/image/embedding/… models, no dated snapshots).
//   - The catalog is stored per key and refreshed when older than CATALOG_TTL (on view and before a request), so models
//     the provider adds appear without a GetShowUps deployment.
//   - ai_model_registry (D1, editable without deploying) holds prices, a quality rank and whether GetShowUps has TESTED
//     the model end to end. A discovered model is selectable only if it's compatible AND priced (so spend is always
//     bounded); Auto picks only 'tested' models.
//   - Selection: a chosen model is kept as long as the account offers it; if it disappears it is never silently
//     replaced. Auto never moves to a more expensive model by itself.
//   - Spend: month-to-date cost of this key's website work (tokens × registry price) plus the worst case of the next
//     request must stay within the owner's monthly limit, or the request is refused before it is sent.
import Anthropic from '@anthropic-ai/sdk'
import { providerMock } from './ai-credentials.js'

export const CATALOG_TTL = 24 * 60 * 60 * 1000
export const DEFAULT_BUDGET_CENTS = 1000
// Worst case of one request, by kind (tokens): prompt size we send and the max output we allow. The output caps are the
// ones the requests actually use (MAX_OUTPUT), so the worst case is a real bound; callers that know the prompt pass its size.
export const MAX_OUTPUT = { designer: 32_000, writer: 16_000 }
export const WORST = { designer: { input: 40_000, output: MAX_OUTPUT.designer }, writer: { input: 12_000, output: MAX_OUTPUT.writer } }
// Upper estimate of input tokens for a prompt (≈3 characters per token is conservative for English + JSON).
export const inputTokensFor = (...parts) => Math.ceil(parts.reduce((n, p) => n + String(p ?? '').length, 0) / 3) + 500
const OPENAI_OK = /^(gpt-4o|gpt-4\.1|gpt-[5-9]|o[3-9])(?:[.-][a-z0-9.]+)*$/i
const OPENAI_NO = /(audio|realtime|transcribe|tts|search|image|embedding|moderation|instruct|codex|vision|preview|deep-research|computer)/i
const DATED = /-\d{4}-\d{2}-\d{2}$/

export async function discoverModels(env, provider, apiKey) {
  const mock = providerMock(env)
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15000, ...(mock ? { baseURL: `${mock}/anthropic` } : {}) })
    const out = []
    try {
      for await (const m of client.models.list({ limit: 100 })) {
        const caps = m.capabilities || {}
        const structured = caps.structured_outputs?.supported === true
        out.push({ id: m.id, label: m.display_name || m.id, compatible: structured, effort: caps.effort?.supported === true, maxOutput: m.max_tokens ?? null, reason: structured ? null : 'no_structured_outputs' })
        if (out.length >= 200) break
      }
      return { ok: true, models: out }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'invalid_key' }
      return { ok: false, error: 'provider_unavailable' }
    }
  }
  try {
    const res = await fetch(`${mock ? `${mock}/openai` : 'https://api.openai.com'}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) })
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'invalid_key' }
    if (!res.ok) return { ok: false, error: 'provider_unavailable' }
    const body = await res.json()
    const models = (body.data || [])
      .map((m) => String(m.id || ''))
      .filter((id) => id && !DATED.test(id))
      .slice(0, 300)
      .map((id) => {
        const compatible = OPENAI_OK.test(id) && !OPENAI_NO.test(id)
        return { id, label: id, compatible, effort: false, maxOutput: null, reason: compatible ? null : 'not_a_text_model' }
      })
    return { ok: true, models }
  } catch {
    return { ok: false, error: 'provider_unavailable' }
  }
}

export async function registry(db, provider) {
  const { results } = await db.prepare('SELECT model, status, quality, input_per_m, output_per_m, max_output, retires_at FROM ai_model_registry WHERE provider = ?1').bind(provider).all()
  return new Map(results.map((r) => [r.model, r]))
}

// The selectable list: discovered ∩ compatible, with registry status/price. Unknown (unpriced) models are shown but
// disabled, so a new model is visible the day the provider releases it and selectable once it's priced.
export function choices(catalog, reg) {
  return (catalog || [])
    .map((m) => {
      const r = reg.get(m.id)
      const status = !m.compatible ? 'incompatible' : !r ? 'unpriced' : r.status === 'blocked' ? 'blocked' : r.status
      return { id: m.id, label: m.label, status, selectable: status === 'tested' || status === 'supported', quality: r?.quality ?? 0, inputPerM: r?.input_per_m ?? null, outputPerM: r?.output_per_m ?? null, retiresAt: r?.retires_at ?? null }
    })
    .filter((c) => c.status !== 'incompatible')
    .sort((a, b) => Number(b.selectable) - Number(a.selectable) || b.quality - a.quality || (a.outputPerM ?? 1e9) - (b.outputPerM ?? 1e9) || a.id.localeCompare(b.id))
}

export const costOf = (c, input, output) => (c ? (input * c.input_per_m + output * c.output_per_m) / 1e6 : null) // USD
// The output cap a request uses: ours for the kind, lowered to the model's own ceiling (registry, or what the provider
// reported in the catalog). The budget's worst case uses the same number, so it is a true bound.
export const outputCap = (kind, regRow, catalogRow) => Math.min(MAX_OUTPUT[kind], regRow?.max_output || Infinity, catalogRow?.maxOutput || Infinity)

// kind: 'designer' | 'writer', optionally with the measured prompt size and output cap: { kind, input, output }.
export const worstCase = (c, kind) => {
  const k = typeof kind === 'string' ? { kind } : kind
  return costOf(c, Math.max(k.input || 0, WORST[k.kind].input), k.output ?? WORST[k.kind].output)
}

const monthStart = (now) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
// The provider may answer with a dated snapshot of the model we asked for: price by the longest registry prefix.
export const priceFor = (reg, model) => {
  const id = String(model).replace(/^[a-z]+:/, '')
  return reg.get(id) || [...reg.entries()].filter(([k]) => id.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1] || null
}
const micros = (usd) => Math.ceil(usd * 1e6)

// Atomically reserves `worstUsd` for one request if month-to-date spend (all providers, reservations included) plus it
// stays within the limit. One INSERT … SELECT … WHERE statement, so two concurrent requests can't both pass on the same
// headroom. Returns the reservation id, or null when the limit would be crossed.
export async function reserveUsage(db, customer, provider, model, kind, worstUsd, budgetUsd, now = Date.now()) {
  const id = crypto.randomUUID().replaceAll('-', '')
  const r = await db
    .prepare(
      `INSERT INTO ai_key_usage (id, customer, provider, model, kind, state, cost_micros, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'reserved', ?6, ?7
       WHERE (SELECT coalesce(sum(cost_micros), 0) FROM ai_key_usage WHERE customer = ?2 AND created_at >= ?8) + ?6 <= ?9
       RETURNING id`,
    )
    .bind(id, customer, provider, `${provider}:${model}`.slice(0, 80), kind, micros(worstUsd), now, monthStart(now), micros(budgetUsd))
    .first()
  return r?.id ?? null
}

// Errors that mean the provider refused the request before doing work (auth, bad request, rate limit): not billed.
const NOT_BILLED = new Set(['invalid_key', 'provider_rejected', 'provider_rate_limited', 'provider_billing'])

// After the request: the reservation becomes the estimated cost of the tokens the provider reported. With no usage report
// (timeout, dropped connection) it keeps the worst case, because the provider may still have billed it.
export async function settleUsage(db, reservation, provider, result) {
  if (!reservation) return
  const usage = result?.usage
  let q
  if (usage) {
    // A failed result may not name the model: price by the one reserved.
    const reserved = result.model ? null : await db.prepare('SELECT model FROM ai_key_usage WHERE id = ?1').bind(reservation).first()
    const price = priceFor(await registry(db, provider), result.model || reserved?.model || '')
    q = db
      .prepare("UPDATE ai_key_usage SET state = 'settled', model = coalesce(?2, model), input_tokens = ?3, output_tokens = ?4, ok = ?5, cost_micros = coalesce(?6, cost_micros) WHERE id = ?1")
      .bind(reservation, result.model ? String(result.model).slice(0, 80) : null, usage.input || 0, usage.output || 0, result.ok ? 1 : 0, price ? micros(costOf(price, usage.input || 0, usage.output || 0)) : null)
  } else if (NOT_BILLED.has(result?.error)) q = db.prepare("UPDATE ai_key_usage SET state = 'settled', cost_micros = 0 WHERE id = ?1").bind(reservation)
  else q = db.prepare("UPDATE ai_key_usage SET state = 'unknown' WHERE id = ?1").bind(reservation)
  await q.run().catch(() => null)
}

// Month-to-date estimated spend (USD) of this business's AI website work on its own keys (reservations included).
export async function monthSpend(db, customer, _provider, now = Date.now()) {
  const r = await db.prepare('SELECT coalesce(sum(cost_micros), 0) AS c FROM ai_key_usage WHERE customer = ?1 AND created_at >= ?2').bind(customer, monthStart(now)).first()
  return (r?.c || 0) / 1e6
}

// Refreshes the stored catalog if it is older than CATALOG_TTL (or `force`). Keeps the old catalog if the provider is
// unreachable. Returns the catalog.
export async function refreshCatalog(env, customer, cred, { force = false, now = Date.now() } = {}) {
  const row = await env.ONBOARDING_DB.prepare('SELECT catalog, catalog_at FROM ai_credentials WHERE customer = ?1').bind(customer).first()
  const stored = row?.catalog ? JSON.parse(row.catalog) : null
  if (!force && stored && now - (row.catalog_at || 0) < CATALOG_TTL) return stored
  const d = await discoverModels(env, cred.provider, cred.apiKey)
  if (!d.ok) return stored || []
  await env.ONBOARDING_DB.prepare('UPDATE ai_credentials SET catalog = ?2, catalog_at = ?3 WHERE customer = ?1').bind(customer, JSON.stringify(d.models), now).run()
  return d.models
}

// Which model to use for the next request (and whether the budget allows it).
// Returns { ok, model, auto } or { ok: false, error: 'model_unavailable' | 'no_tested_model' | 'budget_reached', … }.
export async function resolveModel(env, customer, cred, kind = 'designer', now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await db.prepare('SELECT model, auto_model, monthly_budget_cents FROM ai_credentials WHERE customer = ?1').bind(customer).first()
  const catalog = await refreshCatalog(env, customer, cred, { now })
  const reg = await registry(db, cred.provider)
  const list = choices(catalog, reg)
  const offered = new Map(list.filter((c) => c.selectable).map((c) => [c.id, c]))
  const budgetUsd = (row?.monthly_budget_cents ?? DEFAULT_BUDGET_CENTS) / 100
  const spent = await monthSpend(db, customer, cred.provider, now)
  const k = typeof kind === 'string' ? { kind } : kind
  const capFor = (id) => outputCap(k.kind, reg.get(id), (catalog || []).find((c) => c.id === id))
  const worstFor = (id) => worstCase(reg.get(id), { ...k, output: capFor(id) }) ?? Infinity
  const fits = (id) => spent + worstFor(id) <= budgetUsd
  // The decisive check: an atomic reservation of the worst case (the reads above only choose the model).
  const reserve = async (id, auto) => {
    const reservation = await reserveUsage(db, customer, cred.provider, id, k.kind, worstFor(id), budgetUsd, now)
    if (!reservation) return { ok: false, error: 'budget_reached', spent, budgetUsd }
    return { ok: true, model: id, auto, maxOutput: capFor(id), reservation }
  }
  const selection = row?.model || 'auto'
  if (selection !== 'auto') {
    if (!offered.has(selection)) return { ok: false, error: 'model_unavailable', model: selection }
    if (!fits(selection)) return { ok: false, error: 'budget_reached', spent, budgetUsd }
    return reserve(selection, false)
  }
  // Auto: tested models only, within budget; best quality, then cheapest. Never more expensive than the previous pick.
  const prev = row?.auto_model ? reg.get(row.auto_model) : null
  const ceiling = prev ? prev.output_per_m : Infinity
  const candidates = [...offered.values()].filter((c) => c.status === 'tested' && (c.outputPerM ?? Infinity) <= ceiling)
  if (!candidates.length) return { ok: false, error: prev ? 'model_unavailable' : 'no_tested_model', model: row?.auto_model ?? null }
  const affordable = candidates.filter((c) => fits(c.id))
  if (!affordable.length) return { ok: false, error: 'budget_reached', spent, budgetUsd }
  const keep = affordable.find((c) => c.id === row?.auto_model)
  const pick = keep && !affordable.some((c) => c.quality > keep.quality) ? keep : affordable.sort((a, b) => b.quality - a.quality || a.outputPerM - b.outputPerM)[0]
  if (pick.id !== row?.auto_model) await db.prepare('UPDATE ai_credentials SET auto_model = ?2, updated_at = ?3 WHERE customer = ?1').bind(customer, pick.id, now).run()
  return reserve(pick.id, true)
}
// Own-key requests never use Anthropic's server-side refusal fallback (owner decision 2026-11-16): the model the owner
// chose (or Auto reserved) is the only model that runs, so the reserved worst case is the most a request can cost.
