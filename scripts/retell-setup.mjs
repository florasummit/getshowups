#!/usr/bin/env node
// Creates or updates THE GetShowUps voice agent in Retell: a Custom LLM agent whose LLM is our receptionist engine
// (Retell's dashboard only offers Single-Prompt / Conversational Flow; the API supports custom-llm).
//
// Secrets come on STDIN only (line 1: Retell API key, line 2: the WebSocket secret also stored as RETELL_WS_SECRET),
// never as arguments or in output. Safe to re-run:
//   - finds the agent by exact name (no duplicates; two matches → stops and reports them);
//   - without --apply it only reads (list voices, list agents) and prints what it would do;
//   - with --apply it creates the agent once, or updates the existing agent's DRAFT (never publishes);
//   - it never starts calls, buys numbers or publishes;
//   - --tuned adds the PROPOSED turn-taking/data settings (TUNED_SETTINGS below) and is accepted ONLY together with
//     --test-agent <name>: a second, separately named agent for tests. The live agent (AGENT_NAME) never gets them
//     from this script; without --tuned an agent keeps Retell's defaults;
//   - --endpointing-ms <n> (with --tuned, test agent only) switches speech recognition to Retell's custom mode with an
//     explicit end-of-turn silence (custom_stt_config, Deepgram; min 10 ms).
// Retell API (docs.retellai.com, read 2026-11-16 and 2026-11-21): POST /create-agent, POST /v2/list-agents,
// PATCH /update-agent/{id}, GET /list-voices; Bearer auth; custom-llm response_engine { type: 'custom-llm', llm_websocket_url }.
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const AGENT_NAME = 'GetShowUps receptionist'
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/

// PROPOSED turn-taking, end-of-turn, call-length and data settings (docs/RECEPTIONIST.md "Latency: where the time goes"
// and docs/COMMS_RELIABILITY.md §Retell agent settings; field names, ranges and defaults from
// docs.retellai.com/api-references/create-agent, read 2026-11-21). NOT measured live yet: the test agent exists so the
// defaults and this profile can be compared call for call. Retell has no separate "end of turn" field: end-of-turn
// detection is responsiveness (how soon after the caller stops the agent answers), the STT endpointing
// (custom_stt_config.endpointing_ms, see --endpointing-ms) and interruption_sensitivity (how easily the caller cuts in).
export const TUNED_SETTINGS = Object.freeze({
  responsiveness: 1, //                  Retell default 1 (fastest end-of-turn → answer); kept explicit
  interruption_sensitivity: 0.8, //      default 1: laptop-speaker echo / job-site noise cut the agent off mid-sentence
  enable_backchannel: false, //          default off; kept off (backchannels over browser echo read as interruptions)
  stt_mode: 'fast', //                   default fast (kept explicit; 'accurate' adds end-of-turn delay)
  denoising_mode: 'noise-and-background-speech-cancellation', // default noise-cancellation; TV/crew voices in the background
  reminder_trigger_ms: 10000, //         default 10 s: Retell's "are you there" (our REMINDER text) after this silence
  reminder_max_count: 2, //              default 1
  end_call_after_silence_ms: 60000, //   default 600000 (10 min of a silent, billed call)
  max_call_duration_ms: 900000, //       default 3600000 (1 h); a booking call needs minutes
  data_storage_setting: 'everything_except_pii', // default 'everything' (transcripts, recordings, logs at Retell)
  data_storage_retention_days: 30, //    default unset = kept forever at Retell
  opt_in_signed_url: true, //            log/recording URLs signed (expire after 24 h by default)
})
// Custom end-of-turn silence (ms) → Retell's custom STT mode. Only with --tuned on a test agent; unmeasured.
export const endpointingSettings = (ms) => (Number.isInteger(ms) && ms >= 10 && ms <= 3000 ? { stt_mode: 'custom', custom_stt_config: { provider: 'deepgram', endpointing_ms: ms } } : null)

export async function setupAgent({ apiKey, wsSecret, site = 'https://getshowups.com', voiceId = 'retell-Cimo', name = AGENT_NAME, apply = false, tuned = false, endpointingMs = null, base = 'https://api.retellai.com', log = () => {} }) {
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(apiKey || '')) return { ok: false, error: 'retell_api_key_missing' }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(wsSecret || '')) return { ok: false, error: 'ws_secret_missing' }
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) return { ok: false, error: 'invalid_site' }
  if (typeof name !== 'string' || !/^[\w .()-]{3,80}$/.test(name)) return { ok: false, error: 'invalid_agent_name' }
  // The tuned profile is for a TEST agent only: the live agent is never changed by it.
  if (tuned && name === AGENT_NAME) return { ok: false, error: 'tuned_needs_test_agent', note: 'Pass --test-agent "<name>" (not the live agent) to try the tuned profile.' }
  if (endpointingMs !== null && (!tuned || !endpointingSettings(endpointingMs))) return { ok: false, error: 'invalid_endpointing' }
  const api = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) })
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data }
  }
  const wsUrl = `${site.replace(/^https/, 'wss')}/api/receptionist/llm/${wsSecret}`
  const shownUrl = `${site.replace(/^https/, 'wss')}/api/receptionist/llm/<secret>`

  const voices = await api('GET', '/list-voices')
  if (!voices.ok) return { ok: false, error: voices.status === 401 ? 'retell_auth_failed' : `list_voices_http_${voices.status}` }
  if (!Array.isArray(voices.data) || !voices.data.some((v) => v?.voice_id === voiceId)) return { ok: false, error: 'voice_not_found', voices: (voices.data || []).slice(0, 12).map((v) => `${v.voice_id} (${v.voice_name}, ${v.provider})`) }

  // Exact-name match across pages (the API's query is a substring match).
  const matches = []
  let key = null
  for (let page = 0; page < 20; page++) {
    const r = await api('POST', `/v2/list-agents?limit=200${key ? `&pagination_key=${encodeURIComponent(key)}` : ''}`, { query: name })
    if (!r.ok) return { ok: false, error: `list_agents_http_${r.status}` }
    for (const a of r.data?.items || []) if (a?.agent_name === name) matches.push(a.agent_id)
    if (!r.data?.has_more || !r.data?.pagination_key) break
    key = r.data.pagination_key
  }
  if (matches.length > 1) return { ok: false, error: 'duplicate_agents', agentIds: matches }
  const settings = tuned ? { ...TUNED_SETTINGS, ...(endpointingMs !== null ? endpointingSettings(endpointingMs) : {}) } : {}
  const body = { agent_name: name, voice_id: voiceId, language: 'en-US', response_engine: { type: 'custom-llm', llm_websocket_url: wsUrl }, ...settings }
  const settingsNote = tuned ? ` (TEST agent) with tuned settings ${JSON.stringify(settings)}` : ' with Retell default turn-taking settings'
  if (!apply) {
    log(`${matches.length ? `would update the draft of ${matches[0]} → ${shownUrl}` : `would create "${name}" (voice ${voiceId}) → ${shownUrl}`}${settingsNote}`)
    return { ok: true, dryRun: true, agentId: matches[0] || null, action: matches.length ? 'update' : 'create', tuned, name }
  }
  const r = matches.length ? await api('PATCH', `/update-agent/${encodeURIComponent(matches[0])}`, body) : await api('POST', '/create-agent', body)
  if (!r.ok || !/^agent_[A-Za-z0-9]{6,80}$/.test(r.data?.agent_id || '')) return { ok: false, error: `${matches.length ? 'update' : 'create'}_agent_http_${r.status}` }
  log(`${matches.length ? 'updated draft of' : 'created'} ${r.data.agent_id} "${name}" (version ${r.data.version}, published: ${Boolean(r.data.is_published)}) → ${shownUrl}`)
  return { ok: true, agentId: r.data.agent_id, version: r.data.version, published: Boolean(r.data.is_published), action: matches.length ? 'updated' : 'created', tuned, name }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2)
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d)
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const [apiKey, wsSecret] = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((s) => s.trim())
  const mock = process.env.RETELL_API_MOCK_ORIGIN
  const r = await setupAgent({
    apiKey,
    wsSecret,
    site: opt('--site', 'https://getshowups.com'),
    voiceId: opt('--voice', 'retell-Cimo'),
    name: opt('--test-agent', AGENT_NAME),
    apply: a.includes('--apply'),
    tuned: a.includes('--tuned'),
    endpointingMs: a.includes('--endpointing-ms') ? Number(opt('--endpointing-ms', '')) : null,
    base: typeof mock === 'string' && MOCK_RE.test(mock) ? mock : 'https://api.retellai.com',
    log: (l) => console.log(l),
  })
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
}
