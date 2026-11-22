// Verified charges: what a provider's OWN records say a session cost, fetched read-only on an admin's explicit
// request and stored on the session (state.voice.charge / state.lab.charge). Never an estimate: an estimate lives in
// `estimatedMicros` (server/voice/providers.js COST_ESTIMATES) and is labelled as one; a charge here is the provider's
// number, in the unit the provider documents, with its source. Nothing converts credits to dollars.
//
// Provider records (docs read 2026-11-22):
//   Retell      GET https://api.retellai.com/v2/get-call/{call_id}, Authorization: Bearer <key> →
//               call_cost { combined_cost (cents), product_costs [{ product, unit_price (cents/s), cost (cents) }],
//               total_duration_seconds }. No balance endpoint exists: a 402 on call creation = credit balance exhausted.
//   ElevenLabs  GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}, xi-api-key →
//               metadata { call_duration_secs, cost (integer; the conversation's credits), cost_fiat (double, USD;
//               null for conversations that predate fiat cost tracking), charging { llm_charge (credits),
//               llm_price (USD), is_burst } }. The conversation id is what the browser SDK reports on connect
//               (recorded as providerSessionId); without it there is nothing to look up.
//   OpenAI      no per-session record for a project key (the organization costs API needs an admin key): unsupported.
import { elevenlabsBase } from './elevenlabs.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const retellBase = (env) => (typeof env?.RETELL_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.RETELL_API_MOCK_ORIGIN) ? env.RETELL_API_MOCK_ORIGIN : 'https://api.retellai.com')
export const CHARGE_SUPPORT = { retell: 'call_cost', elevenlabs: 'conversation', openai: null }
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/
export const REF_RE = ID_RE
const RETRY_AFTER_MS = 60 * 60 * 1000
const MAX_PER_RUN = 20
const DAY = 864e5

const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const whole = (v) => (Number.isInteger(v) && v >= 0 ? v : null)

async function get(url, headers) {
  let res
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) })
  } catch {
    return { error: 'unreachable' }
  }
  if (res.status === 401 || res.status === 403) return { error: 'auth_failed' }
  if (res.status === 404) return { error: 'not_found' }
  if (!res.ok) return { error: `http_${res.status}` }
  const body = await res.json().catch(() => null)
  return body && typeof body === 'object' ? { body } : { error: 'bad_response' }
}

// → { ok: true, charge } | { ok: false, error } — the charge record is codes and numbers only.
export async function fetchCharge(env, provider, ref, now = Date.now()) {
  if (!CHARGE_SUPPORT[provider]) return { ok: false, error: 'unsupported' }
  if (!ID_RE.test(String(ref || ''))) return { ok: false, error: 'no_reference' }
  if (provider === 'retell') {
    if (typeof env?.RETELL_API_KEY !== 'string' || !env.RETELL_API_KEY) return { ok: false, error: 'not_configured' }
    const r = await get(`${retellBase(env)}/v2/get-call/${encodeURIComponent(ref)}`, { Authorization: `Bearer ${env.RETELL_API_KEY}` })
    if (r.error) return { ok: false, error: r.error }
    const c = r.body.call_cost
    const cents = money(c?.combined_cost)
    if (cents == null) return { ok: false, error: r.body.call_status && r.body.call_status !== 'ended' ? 'not_ended' : 'no_cost_yet' }
    const products = Array.isArray(c.product_costs) ? c.product_costs.filter((p) => typeof p?.product === 'string' && money(p.cost) != null).map((p) => ({ product: p.product.slice(0, 40), cents: p.cost })).slice(0, 12) : []
    return { ok: true, charge: { provider, source: 'retell_call_cost', ref, micros: Math.round(cents * 10_000), cents, products, durationSeconds: money(c.total_duration_seconds), fetchedAt: now } }
  }
  // elevenlabs
  if (typeof env?.ELEVENLABS_API_KEY !== 'string' || !env.ELEVENLABS_API_KEY) return { ok: false, error: 'not_configured' }
  const r = await get(`${elevenlabsBase(env)}/v1/convai/conversations/${encodeURIComponent(ref)}`, { 'xi-api-key': env.ELEVENLABS_API_KEY })
  if (r.error) return { ok: false, error: r.error }
  const m = r.body.metadata
  if (!m || typeof m !== 'object') return { ok: false, error: 'bad_response' }
  const credits = whole(m.cost)
  const usd = money(m.cost_fiat)
  if (credits == null && usd == null) return { ok: false, error: r.body.status && r.body.status !== 'done' ? 'not_ended' : 'no_cost_yet' }
  const ch = m.charging && typeof m.charging === 'object' ? m.charging : {}
  return { ok: true, charge: { provider, source: 'elevenlabs_conversation', ref, credits, micros: usd == null ? null : Math.round(usd * 1e6), llmCredits: whole(ch.llm_charge), llmMicros: money(ch.llm_price) == null ? null : Math.round(ch.llm_price * 1e6), burst: ch.is_burst === true, durationSeconds: whole(m.call_duration_secs), fetchedAt: now } }
}

// What a session's provider record is looked up by: Retell's call id (the receptionist_calls row), ElevenLabs'
// conversation id (reported by the browser SDK, recorded as providerSessionId).
export const chargeRef = (provider, v) => (provider === 'retell' ? v?.callId : provider === 'elevenlabs' ? v?.providerSessionId : null) || null

// Fetches and records charges for recent finished sessions that have none yet (or whose last attempt failed more than
// an hour ago). Bounded per run; one business only when `customer` is given (never another business's rows).
// → { candidates, recorded, errors: [{ id, error }], skipped: { unsupported, no_reference } }
export async function recordCharges(env, { customer = null, limit = MAX_PER_RUN, now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  const n = Math.min(Math.max(1, limit | 0), MAX_PER_RUN)
  const { results } = await db
    .prepare(
      `SELECT id, customer, state FROM receptionist_conversations
        WHERE created_at > ?1 ${customer ? 'AND customer = ?3' : ''}
          AND (json_extract(state, '$.voice.provider') IN ('retell', 'elevenlabs') OR json_extract(state, '$.lab.provider') IN ('retell', 'elevenlabs'))
        ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(now - 30 * DAY, n * 3, ...(customer ? [customer] : []))
    .all()
  const out = { candidates: 0, recorded: 0, errors: [], skipped: { unsupported: 0, no_reference: 0 } }
  let done = 0
  for (const row of results || []) {
    if (done >= n) break
    let s
    try {
      s = JSON.parse(row.state || '{}')
    } catch {
      continue
    }
    const key = s.voice?.provider ? 'voice' : 'lab'
    const v = s[key]
    if (!v?.endedAt) continue
    if (v.charge?.micros != null || v.charge?.credits != null) continue
    if (v.charge?.error && now - (v.charge.fetchedAt || 0) < RETRY_AFTER_MS) continue
    out.candidates += 1
    const ref = chargeRef(v.provider, v)
    if (!ref) {
      out.skipped.no_reference += 1
      continue
    }
    done += 1
    const r = await fetchCharge(env, v.provider, ref, now)
    v.charge = r.ok ? r.charge : { provider: v.provider, error: r.error, fetchedAt: now }
    if (r.ok) out.recorded += 1
    else out.errors.push({ id: row.id, error: r.error })
    await db.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(row.id, row.customer, JSON.stringify(s), now).run()
  }
  return out
}

// Provider balances, read on an admin's explicit request only (nothing here is monitored continuously, and nothing is
// claimed for a provider whose API has no such read).
//   elevenlabs  GET /v1/user/subscription → character_count / character_limit = the plan's credits used and allowed in
//               the current billing period (the pool Agents conversations draw from), next_character_count_reset_unix.
//   retell      no balance endpoint; create-web-call answers 402 when the credit balance is exhausted (voice_billing).
//   openai      no balance read for a project key; the costs API needs an organization admin key.
export async function providerBalances(env, now = Date.now()) {
  const out = {
    retell: { supported: false, note: 'Retell has no balance endpoint. A 402 on call creation means the credit balance is exhausted (code voice_billing).' },
    openai: { supported: false, note: 'OpenAI exposes no balance to a project key; the organization costs API needs an admin key.' },
    elevenlabs: { supported: true, fetchedAt: now },
  }
  if (typeof env?.ELEVENLABS_API_KEY !== 'string' || !env.ELEVENLABS_API_KEY) return { ...out, elevenlabs: { supported: true, error: 'not_configured', fetchedAt: now } }
  const r = await get(`${elevenlabsBase(env)}/v1/user/subscription`, { 'xi-api-key': env.ELEVENLABS_API_KEY })
  if (r.error) return { ...out, elevenlabs: { supported: true, error: r.error, fetchedAt: now } }
  const b = r.body
  const used = whole(b.character_count)
  const limit = whole(b.character_limit)
  if (used == null || limit == null) return { ...out, elevenlabs: { supported: true, error: 'bad_response', fetchedAt: now } }
  out.elevenlabs = { supported: true, source: 'elevenlabs_subscription', creditsUsed: used, creditsLimit: limit, creditsLeft: Math.max(0, limit - used), tier: typeof b.tier === 'string' ? b.tier.slice(0, 40) : null, resetAt: Number.isFinite(b.next_character_count_reset_unix) ? b.next_character_count_reset_unix * 1000 : null, fetchedAt: now }
  return out
}
