// Model adapters for the dashboard assistant (server/operator.js). One neutral shape, two providers:
//   workers  Workers AI binding (production today: the model every other included feature uses)
//   claude   Anthropic Messages API, only when OPERATOR_PROVIDER === 'claude' AND its own secret OPERATOR_ANTHROPIC_API_KEY
//            exists (approval). Never the receptionist's key: one feature's volume must not use up another's limits.
// Messages: { role: 'user', text } | { role: 'assistant', text, calls, native } | { role: 'tool', results: [{ id, name, text }] }.
import Anthropic from '@anthropic-ai/sdk'
import { ASSISTANT_MODEL, PRICE } from './followups/assistant.js'
import { reserveAi, worstCase } from './ai-budget.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const mockOf = (env) => (typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN) ? env.AI_API_MOCK_ORIGIN : null)

export const MODELS = {
  workers: { provider: 'workers', model: ASSISTANT_MODEL, price: { in: PRICE.inputPerM, out: PRICE.outputPerM, read: PRICE.inputPerM, write: PRICE.inputPerM } },
  claude: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'medium', price: { in: 0.1, out: 0.5, read: 0.01, write: 0.125 } },
}
export const operatorModel = (env) => (String(env.OPERATOR_PROVIDER ?? '').trim().toLowerCase() === 'claude' && env.OPERATOR_ANTHROPIC_API_KEY ? MODELS.claude : MODELS.workers)
export const operatorConfigured = (env) => operatorModel(env).provider === 'claude' || Boolean(env.AI?.run) || Boolean(mockOf(env))

// Money limits for a paid provider (Anthropic's own workspace limit is the outer guard). Both configurable; unset, zero or
// nonsense means the default, never unlimited.
const usd = (v, d) => (Number(v) > 0 && Number(v) <= 1000 ? Number(v) : d)
export const spendLimits = (env) => ({ day: usd(env.OPERATOR_DAILY_USD, 2), business: usd(env.OPERATOR_BUSINESS_DAILY_USD, 0.1) })
// Counted even when a call failed or timed out: the provider may still have billed it.
export const MIN_CHARGE_MICROS = 1000

// Today's recorded spend (UTC), all businesses and this one. Unreadable → treated as over (no unbounded spending).
export async function overBudget(env, customerId, now = Date.now()) {
  if (operatorModel(env).provider !== 'claude') return false
  const { day, business } = spendLimits(env)
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT coalesce(sum(json_extract(props, '$.costMicros')), 0) AS a, coalesce(sum(CASE WHEN customer = ?2 THEN json_extract(props, '$.costMicros') END), 0) AS b FROM events WHERE type = 'ai_ask' AND at >= ?1")
      .bind(now - (now % 86_400_000), customerId)
      .first()
    return r.a >= day * 1e6 || r.b >= business * 1e6
  } catch {
    return true
  }
}

// The owner's daily allowance is successful answers, counted from the records: a question the AI failed to answer costs none
// (money limits, the minute limit and aiAttempt still bound failures). Unreadable → treated as used up.
export const ANSWERS_PER_DAY = 20
export async function answersUsedUp(env, customerId, now = Date.now()) {
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT count(*) AS n FROM events WHERE type = 'ai_ask' AND customer = ?1 AND at >= ?2 AND json_extract(props, '$.ok') = 1")
      .bind(customerId, now - (now % 86_400_000))
      .first()
    return r.n >= ANSWERS_PER_DAY
  } catch {
    return true
  }
}

const withTimeout = async (p, ms) => {
  let timer
  try {
    return await Promise.race([p, new Promise((_, no) => (timer = setTimeout(() => no(new Error('ai_timeout')), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

// Workers AI models answer in one of two shapes.
export function readWorkers(res) {
  const m = res?.choices?.[0]?.message
  const raw = m?.tool_calls?.length ? m.tool_calls : res?.tool_calls || []
  const calls = raw.map((c, i) => {
    const f = c.function || c
    let args = f.arguments ?? {}
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}')
      } catch {
        args = null
      }
    }
    return { id: c.id || `call_${i}`, name: String(f.name || ''), args }
  })
  const text = m?.content ?? (typeof res?.response === 'string' ? res.response : '')
  const u = res?.usage || {}
  return { calls, text: String(text || '').replace(/<think>[^]*?<\/think>/g, '').trim(), usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0, read: 0, write: 0 } }
}

async function workers(env, m, { system, messages, tools, mustLook, maxTokens }, ms) {
  const out = [{ role: 'system', content: system.join('\n\n') }]
  for (const x of messages) {
    if (x.role === 'tool') for (const r of x.results) out.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.text })
    else if (x.calls?.length) out.push({ role: 'assistant', content: x.text || '', tool_calls: x.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) })
    else out.push({ role: x.role, content: x.text })
  }
  const body = { messages: out, ...(tools ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: mustLook ? 'required' : 'auto' } : {}), max_tokens: maxTokens, temperature: 0.2, ...(m.extra || {}) }
  const mock = mockOf(env)
  if (mock) {
    const res = await fetch(`${mock}/ai/run/${m.model}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) })
    if (!res.ok) throw new Error('ai_http')
    return readWorkers(await res.json())
  }
  return readWorkers(await withTimeout(env.AI.run(m.model, body), ms))
}

async function claude(env, m, { system, messages, tools, allTools, maxTokens, customerId }, ms) {
  // One spending guard (server/ai-budget.js): the call's worst case is reserved first; refused → treated like the
  // provider's own limit (the assistant answers from records without a model).
  const budget = await reserveAi(env, { entry: 'assistant', customerId, micros: worstCase({ chars: JSON.stringify([system, messages, allTools]).length, maxOutput: maxTokens, inPerToken: m.price.write, outPerToken: m.price.out }) })
  if (!budget.ok) throw Object.assign(new Error('ai_budget'), { budget: budget.reason })
  let settled = false
  try {
  // No SDK retries (an SDK retry is an unreported billable attempt): server/operator.js retries once itself, and every
  // attempt comes back here for its own reservation.
  const anthropic = env.ANTHROPIC_CLIENT || new Anthropic({ apiKey: env.OPERATOR_ANTHROPIC_API_KEY.trim(), maxRetries: 0, timeout: ms })
  const out = messages.map((x) =>
    x.role === 'tool'
      ? { role: 'user', content: x.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) }
      : { role: x.role, content: x.native || x.text },
  )
  // Tools + the fixed instructions are the cached prefix; what changes per turn comes after it.
  const res = await anthropic.messages.create({
    model: m.model,
    max_tokens: maxTokens,
    output_config: { effort: m.effort },
    system: [{ type: 'text', text: system[0], cache_control: { type: 'ephemeral' } }, ...(system[1] ? [{ type: 'text', text: system[1] }] : [])],
    tools: allTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    ...(tools ? {} : { tool_choice: { type: 'none' } }),
    messages: out,
  })
  const u = res.usage || {}
  const usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0 }
  await budget.settle(costOf(m, usage))
  settled = true
  if (res.stop_reason === 'refusal') return { calls: [], text: '', usage, native: res.content }
  return { cut: res.stop_reason === 'max_tokens', calls: res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })), text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), usage, native: res.content }
  } catch (err) {
    // A request the provider refused (HTTP status) cost nothing; a timeout keeps its worst case (it may have been billed).
    if (!settled && err?.status) await budget.settle(0)
    throw err
  }
}

// Why the provider refused, as a code (its message is never shown or stored):
//   quota        the included model's daily free allowance is used up (Workers AI 4006); returns at 00:00 UTC
//   setup        the provider refuses this account or key (auth, credit): needs the platform owner, retrying won't help
//   timeout | busy | unavailable   may work in a moment
export function providerReason(err) {
  const m = String(err?.message || '')
  if (/^4006\b|daily free allocation/i.test(m)) return 'quota'
  if (m === 'ai_budget') return 'quota'
  if (m === 'ai_timeout' || /Timeout/.test(err?.name || '')) return 'timeout'
  if ([401, 402, 403].includes(err?.status) || /credit balance|billing|spend(ing)? limit|usage limit/i.test(m) || /^(10000|5018)\b/.test(m)) return 'setup'
  if (err?.status === 429 || err?.status === 529 || /^3040\b|capacity/i.test(m)) return 'busy'
  return 'unavailable'
}

// → { calls, text, usage, native? }. Throws Error('ai_timeout') or a provider error.
export const chat = (env, m, req, ms) => (m.provider === 'claude' ? claude : workers)(env, m, req, ms)
export const costOf = (m, u) => u.in * m.price.in + u.out * m.price.out + u.read * m.price.read + u.write * m.price.write
