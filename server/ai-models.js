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
// Worst case of one request, by kind (tokens): prompt size we send and the max output we allow.
export const WORST = { designer: { input: 40_000, output: 32_000 }, writer: { input: 12_000, output: 16_000 } }
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
  const { results } = await db.prepare('SELECT model, status, quality, input_per_m, output_per_m, retires_at FROM ai_model_registry WHERE provider = ?1').bind(provider).all()
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
export const worstCase = (c, kind) => costOf(c, WORST[kind].input, WORST[kind].output)

// Month-to-date spend (USD) of this key's AI website work, from recorded tokens × registry prices.
export async function monthSpend(db, customer, provider, now = Date.now()) {
  const d = new Date(now)
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const { results } = await db.prepare("SELECT model, input_tokens, output_tokens FROM website_generations WHERE customer = ?1 AND created_at >= ?2 AND model LIKE ?3").bind(customer, start, `${provider}:%`).all()
  const reg = await registry(db, provider)
  let usd = 0
  for (const r of results) {
    const id = String(r.model).slice(provider.length + 1)
    // The provider may answer with a dated snapshot of the model we asked for: price by the longest registry prefix.
    const price = reg.get(id) || [...reg.entries()].filter(([k]) => id.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1]
    usd += costOf(price, r.input_tokens || 0, r.output_tokens || 0) ?? 0
  }
  return usd
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
  const fits = (id) => spent + (worstCase(reg.get(id), kind) ?? Infinity) <= budgetUsd
  const selection = row?.model || 'auto'
  if (selection !== 'auto') {
    if (!offered.has(selection)) return { ok: false, error: 'model_unavailable', model: selection }
    if (!fits(selection)) return { ok: false, error: 'budget_reached', spent, budgetUsd }
    return { ok: true, model: selection, auto: false }
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
  return { ok: true, model: pick.id, auto: true }
}

export const claudeFallbackFor = (id) => (/^claude-(opus-5|sonnet-5-5|fable-5)/.test(id) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {})
