// Model adapters for the dashboard assistant (server/operator.js). One neutral shape, two providers:
//   workers  Workers AI binding (production today: the model every other included feature uses)
//   claude   Anthropic Messages API, only when OPERATOR_PROVIDER === 'claude' AND its own secret OPERATOR_ANTHROPIC_API_KEY
//            exists (approval). Never the receptionist's key: one feature's volume must not use up another's limits.
// Messages: { role: 'user', text } | { role: 'assistant', text, calls, native } | { role: 'tool', results: [{ id, name, text }] }.
import Anthropic from '@anthropic-ai/sdk'
import { ASSISTANT_MODEL, PRICE } from './followups/assistant.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const mockOf = (env) => (typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN) ? env.AI_API_MOCK_ORIGIN : null)

export const MODELS = {
  workers: { provider: 'workers', model: ASSISTANT_MODEL, price: { in: PRICE.inputPerM, out: PRICE.outputPerM, read: PRICE.inputPerM, write: PRICE.inputPerM } },
  claude: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low', price: { in: 0.1, out: 0.5, read: 0.01, write: 0.125 } },
}
export const operatorModel = (env) => (env.OPERATOR_PROVIDER === 'claude' && env.OPERATOR_ANTHROPIC_API_KEY ? MODELS.claude : MODELS.workers)
export const operatorConfigured = (env) => operatorModel(env).provider === 'claude' || Boolean(env.AI?.run) || Boolean(mockOf(env))

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

async function claude(env, m, { system, messages, tools, allTools, maxTokens }, ms) {
  const anthropic = env.ANTHROPIC_CLIENT || new Anthropic({ apiKey: env.OPERATOR_ANTHROPIC_API_KEY, maxRetries: 1, timeout: ms })
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
  if (res.stop_reason === 'refusal') return { calls: [], text: '', usage, native: res.content }
  return { calls: res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })), text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), usage, native: res.content }
}

// → { calls, text, usage, native? }. Throws Error('ai_timeout') or a provider error.
export const chat = (env, m, req, ms) => (m.provider === 'claude' ? claude : workers)(env, m, req, ms)
export const costOf = (m, u) => u.in * m.price.in + u.out * m.price.out + u.read * m.price.read + u.write * m.price.write
