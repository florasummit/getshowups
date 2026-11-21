#!/usr/bin/env node
// Creates or updates THE GetShowUps Voice Lab agent in ElevenLabs Conversational AI, with exactly what the Lab needs:
//   - seven CLIENT tools (same names/parameters as server/voice/tools.js toolsForElevenLabs(); the browser forwards
//     each call to our server, the agent executes nothing itself), attached by id (conversation_config.agent.prompt.tool_ids);
//   - prompt + first-message + language overrides ENABLED (platform_settings.overrides.conversation_config_override),
//     so every conversation runs OUR receptionist prompt and greeting (the agent's own prompt is a placeholder);
//   - authentication ON (platform_settings.auth.enable_auth: only a signed URL from our server starts a conversation)
//     with an allowlist of our hostname;
//   - the client events the browser adapter listens to, and a 15-minute conversation ceiling.
// Secrets come on STDIN only (line 1: ElevenLabs API key), never as arguments or in output. Safe to re-run:
//   - finds the agent and the tools by exact name (duplicates → stops and reports ids);
//   - without --apply it only reads (list agents, list tools) and prints what it would do;
//   - with --apply it creates missing tools / the agent once, and PATCHes existing ones (this script owns those
//     fields: dashboard edits to them are overwritten on the next --apply);
//   - it never starts conversations, buys numbers or deletes anything.
// Usage:  printf '%s\n' "$ELEVENLABS_API_KEY" | node scripts/elevenlabs-setup.mjs [--apply] [--site https://getshowups.com]
//         [--name "<agent name>"] [--voice <voice_id>] [--llm <model id>]
// The printed agent_id goes into the Pages secret ELEVENLABS_AGENT_ID (approval item, like the key).
// ElevenLabs API (elevenlabs.io/docs/api-reference, read 2026-11-21): header xi-api-key; GET /v1/convai/agents
// ?search=&page_size=&cursor= → { agents: [{ agent_id, name }], has_more, next_cursor }; POST /v1/convai/agents/create
// → { agent_id }; PATCH /v1/convai/agents/{agent_id} (partial); GET /v1/convai/tools?types=client&page_size=&cursor= →
// { tools: [{ id, tool_config }], has_more, next_cursor }; POST /v1/convai/tools and PATCH /v1/convai/tools/{tool_id}
// with { tool_config } → { id }.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { toolsForElevenLabs } from '../server/voice/tools.js'

export const AGENT_NAME = 'GetShowUps receptionist (Voice Lab)'
export const TOOL_PREFIX = 'getshowups_lab_'
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/

// What the agent says if a conversation ever starts WITHOUT our override (e.g. someone opens it in the dashboard):
// no business facts live on the ElevenLabs side, so it must not pretend to be anyone.
export const PLACEHOLDER_PROMPT = 'You are a placeholder. This agent is only used by GetShowUps with a per-conversation system prompt supplied by its server. If you are reading this text, that prompt was not supplied: say "This line is not set up yet" once, do not answer questions, do not call tools, and end the conversation.'
export const PLACEHOLDER_FIRST_MESSAGE = 'This line is not set up yet.'
// Server events the browser adapter relies on (conversation_config.conversation.client_events; some are off by default).
export const CLIENT_EVENTS = ['conversation_initiation_metadata', 'ping', 'audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_correction', 'client_tool_call', 'agent_tool_response', 'vad_score']

// Engine JSON Schema → ElevenLabs ObjectJsonSchemaProperty (literal properties: type, description, enum).
export const toolParameters = (schema) => ({
  type: 'object',
  description: '',
  required: Array.isArray(schema?.required) ? schema.required : [],
  properties: Object.fromEntries(Object.entries(schema?.properties || {}).map(([k, p]) => [k, { type: p.type, description: p.description || (p.enum ? `One of: ${p.enum.join(', ')}` : ''), ...(Array.isArray(p.enum) ? { enum: p.enum } : {}) }])),
})

// One client tool per engine tool; the name stays the engine's (the browser registers handlers under these names).
export const clientToolConfig = (t) => ({ type: 'client', name: t.name, description: t.description, expects_response: true, response_timeout_secs: 30, parameters: toolParameters(t.parameters) })

export const agentBody = ({ name, hostname, toolIds, voiceId, llm }) => ({
  name,
  tags: ['getshowups', 'voice-lab'],
  conversation_config: {
    agent: { first_message: PLACEHOLDER_FIRST_MESSAGE, language: 'en', prompt: { prompt: PLACEHOLDER_PROMPT, tool_ids: toolIds, ...(llm ? { llm } : {}) } },
    conversation: { client_events: CLIENT_EVENTS, max_duration_seconds: 900 },
    ...(voiceId ? { tts: { voice_id: voiceId } } : {}),
  },
  platform_settings: {
    auth: { enable_auth: true, allowlist: [{ hostname }] },
    overrides: { conversation_config_override: { agent: { prompt: { prompt: true }, first_message: true, language: true } } },
  },
})

export async function setupElevenLabsAgent({ apiKey, site = 'https://getshowups.com', name = AGENT_NAME, voiceId = '', llm = '', apply = false, base = 'https://api.elevenlabs.io', log = () => {} }) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(apiKey || '')) return { ok: false, error: 'elevenlabs_api_key_missing' }
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) return { ok: false, error: 'invalid_site' }
  if (voiceId && !/^[A-Za-z0-9_-]{6,80}$/.test(voiceId)) return { ok: false, error: 'invalid_voice' }
  if (llm && !/^[A-Za-z0-9._:-]{3,80}$/.test(llm)) return { ok: false, error: 'invalid_llm' }
  const hostname = new URL(site).hostname
  const api = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { 'xi-api-key': apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) })
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data }
  }
  const pages = async (p, key) => {
    const items = []
    let cursor = null
    for (let page = 0; page < 20; page++) {
      const r = await api('GET', `${p}&page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      if (!r.ok) return { error: r.status === 401 ? 'elevenlabs_auth_failed' : `list_http_${r.status}` }
      items.push(...(Array.isArray(r.data?.[key]) ? r.data[key] : []))
      if (!r.data?.has_more || !r.data?.next_cursor) break
      cursor = r.data.next_cursor
    }
    return { items }
  }

  const wanted = toolsForElevenLabs().map(clientToolConfig)
  const tools = await pages('/v1/convai/tools?types=client', 'tools')
  if (tools.error) return { ok: false, error: tools.error }
  const byName = new Map()
  for (const t of tools.items) if (t?.tool_config?.type === 'client' && wanted.some((w) => w.name === t.tool_config.name)) byName.set(t.tool_config.name, [...(byName.get(t.tool_config.name) || []), t.id])
  const dupes = [...byName.entries()].filter(([, ids]) => ids.length > 1)
  if (dupes.length) return { ok: false, error: 'duplicate_tools', tools: Object.fromEntries(dupes) }

  const agents = await pages(`/v1/convai/agents?search=${encodeURIComponent(name)}`, 'agents')
  if (agents.error) return { ok: false, error: agents.error }
  const matches = agents.items.filter((a) => a?.name === name).map((a) => a.agent_id)
  if (matches.length > 1) return { ok: false, error: 'duplicate_agents', agentIds: matches }

  const plan = { tools: wanted.map((w) => ({ name: w.name, action: byName.has(w.name) ? 'update' : 'create' })), agent: matches.length ? 'update' : 'create' }
  if (!apply) {
    log(`would ${plan.agent} "${name}" for ${hostname} (overrides: prompt/first_message/language; auth on; ${wanted.length} client tools: ${plan.tools.filter((t) => t.action === 'create').length} to create, ${plan.tools.filter((t) => t.action === 'update').length} to update${voiceId ? `; voice ${voiceId}` : ''}${llm ? `; llm ${llm}` : ''})`)
    return { ok: true, dryRun: true, agentId: matches[0] || null, action: plan.agent, tools: plan.tools }
  }

  const toolIds = []
  for (const w of wanted) {
    const existing = byName.get(w.name)?.[0]
    const r = existing ? await api('PATCH', `/v1/convai/tools/${encodeURIComponent(existing)}`, { tool_config: w }) : await api('POST', '/v1/convai/tools', { tool_config: w })
    if (!r.ok || typeof r.data?.id !== 'string') return { ok: false, error: `${existing ? 'update' : 'create'}_tool_http_${r.status}`, tool: w.name, detail: r.data?.detail }
    toolIds.push(r.data.id)
  }
  const body = agentBody({ name, hostname, toolIds, voiceId, llm })
  const r = matches.length ? await api('PATCH', `/v1/convai/agents/${encodeURIComponent(matches[0])}`, body) : await api('POST', '/v1/convai/agents/create', body)
  if (!r.ok || !/^[A-Za-z0-9_-]{6,80}$/.test(r.data?.agent_id || '')) return { ok: false, error: `${matches.length ? 'update' : 'create'}_agent_http_${r.status}`, detail: r.data?.detail }
  log(`${matches.length ? 'updated' : 'created'} ${r.data.agent_id} with ${toolIds.length} client tools → set ELEVENLABS_AGENT_ID=${r.data.agent_id}`)
  return { ok: true, agentId: r.data.agent_id, toolIds, action: matches.length ? 'updated' : 'created' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2)
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d)
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const [apiKey] = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((s) => s.trim())
  const mock = process.env.ELEVENLABS_API_MOCK_ORIGIN
  const r = await setupElevenLabsAgent({ apiKey, site: opt('--site', 'https://getshowups.com'), name: opt('--name', AGENT_NAME), voiceId: opt('--voice', ''), llm: opt('--llm', ''), apply: a.includes('--apply'), base: typeof mock === 'string' && MOCK_RE.test(mock) ? mock : 'https://api.elevenlabs.io', log: (l) => console.log(l) })
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
}
