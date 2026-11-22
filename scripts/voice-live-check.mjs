// Live check of the customer-facing voice path against the REAL providers, without a browser and without production
// data: an in-memory D1 (every migration), a seeded TEST business, Google mocked (free/busy + event creation), the real
// provider keys from macOS Keychain, and the very same server functions the public routes call
// (server/voice/customer.js: startCustomerVoiceSession → provider session → customerVoiceTool → endCustomerVoiceSession).
// The "caller" is synthesized speech (macOS `say`) streamed as PCM into the provider; the receptionist's audio is
// received and counted; every tool the model calls runs through our runner (dry run: nothing is created).
//
//   node scripts/voice-live-check.mjs openai|elevenlabs [--keychain-account <acct>] [--keychain-service <svc>]
//
// Prints a JSON report: greeting heard, each caller line and the receptionist's answers, tools called (name, ok,
// simulated), audio bytes in/out, latency, estimated cost, and whether the session would count as EVIDENCE for
// activation (audio both ways + availability + booking tools). Keys are never printed. Bounded: one session,
// at most ~90 s, the daily/concurrency limits of the customer path apply.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { encrypt } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { startCustomerVoiceSession, customerVoiceTool, endCustomerVoiceSession, customerVoiceTranscript, providerEvidence, loadCustomerVoiceSession } from '../server/voice/customer.js'

const provider = process.argv[2]
if (!['openai', 'elevenlabs'].includes(provider)) {
  console.error('usage: node scripts/voice-live-check.mjs openai|elevenlabs [--keychain-account a] [--keychain-service s]')
  process.exit(2)
}
const opt = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const keychain = (service, account) => execFileSync('security', ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'], { encoding: 'utf8' }).trim()
const key = keychain(opt('--keychain-service', provider === 'openai' ? 'getshowups-demo-openai-api-key' : 'getshowups-elevenlabs-api-key-v2'), opt('--keychain-account', provider === 'openai' ? 'florasummit' : 'getshowups-elevenlabs'))
const AGENT_ID = provider === 'elevenlabs' ? opt('--agent-id', 'agent_8901m80mefhme349tzxvbeh9hrjd') : ''

// ---------- in-memory platform ----------
const sql = new DatabaseSync(':memory:')
for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
const db = { prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) sql.prepare(s.q).run(...s.args) } }
const kv = new Map()
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const BIZ = 'harness-pools'
const t0 = Date.now()
sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, 'Harness Pools', 'America/New_York', '29401,29403', '08:00', '18:00', '1,2,3,4,5', ?, ?, ?)").run(BIZ, t0, t0, t0)
sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0100', 'Pool service', 'Family-run pool care in Charleston.', ?, ?, ?)").run(BIZ, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }, { name: 'Green pool cleanup', price: '' }]), JSON.stringify(['Charleston']), t0)
sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, updated_at) VALUES (?, 1, 'ai_first', 'Thanks for calling Harness Pools, this is the receptionist. How can I help?', ?)").run(BIZ, t0)
sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, 'harness', ?)").run(BIZ, t0)
kv.set(`google:${BIZ}`, JSON.stringify({ customer: BIZ, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
const env = {
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: KEY, ADMIN_API_TOKEN: 'a'.repeat(40),
  PLATFORM_ADMIN_EMAILS: 'harness@getshowups.example', ONBOARDING_DB: db,
  GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
  RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-not-used-by-voice-providers',
  ...(provider === 'openai' ? { OPENAI_API_KEY: key } : { ELEVENLABS_API_KEY: key, ELEVENLABS_AGENT_ID: AGENT_ID }),
}
// Google mocked; everything else (the provider) goes to the real network.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.mock', scope: 'x', expires_in: 3600 })
  if (u.endsWith('/freeBusy')) return json(200, { calendars: { primary: { busy: [] } } })
  if (u.includes('/events?sendUpdates=all')) return json(200, { id: JSON.parse(init.body).id })
  return realFetch(url, init)
}

// ---------- the caller: synthesized speech → PCM16 mono at the provider's rate ----------
const rate = provider === 'openai' ? 24000 : 16000
const tmp = mkdtempSync(join(tmpdir(), 'voice-live-'))
const speak = (text) => {
  const f = join(tmp, `${Math.random().toString(36).slice(2)}.wav`)
  execFileSync('say', ['-o', f, `--data-format=LEI16@${rate}`, text])
  const wav = readFileSync(f)
  // WAV: find the 'data' chunk (the header length varies).
  let i = 12
  while (i + 8 <= wav.length) {
    const id = wav.toString('ascii', i, i + 4)
    const len = wav.readUInt32LE(i + 4)
    if (id === 'data') return wav.subarray(i + 8, i + 8 + len)
    i += 8 + len + (len % 2)
  }
  throw new Error('no data chunk')
}
const silence = (ms) => Buffer.alloc(Math.round((rate * ms) / 1000) * 2)
// The caller's script, adaptive: the opening lines, then answers chosen from what the receptionist last said (a
// confirmation question → yes; a repeated detail question → the detail), until a booking tool returned booked.
const OPENING = [
  'Hi, I am calling about weekly pool care. How much is it per month?',
  'Great. I am in two nine four zero three. What times do you have available this week?',
  'Yes please, book the first one. My name is Harness Caller and my phone number is eight four three, five five five, zero one zero one.',
]
const MAX_TURNS = 8
const nextLine = (turn, lastReceptionist, booked) => {
  if (booked) return null
  if (turn < OPENING.length) return OPENING[turn]
  const r = String(lastReceptionist || '').toLowerCase()
  if (/zip/.test(r)) return 'Two nine four zero three.'
  if (/phone|number/.test(r)) return 'Eight four three, five five five, zero one zero one.'
  if (/name/.test(r)) return 'Harness Caller. H A R N E S S.'
  if (/email/.test(r)) return 'No email, thanks. Just book it.'
  return 'Yes, that works. Please book it.'
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- the session, through the customer-path server functions ----------
const customer = customerFromRow(await getCustomer(db, BIZ))
const admin = { email: 'harness@getshowups.example', ref: 'ref:harness' }
const started = await startCustomerVoiceSession(env, customer, { test: { provider, voiceId: '', admin } })
if (!started.ok) {
  console.log(JSON.stringify({ provider, ok: false, error: started.error }))
  process.exit(1)
}
const session = await loadCustomerVoiceSession(env, customer, started.conversationId, started.token)
const report = { provider, ok: false, greeting: null, exchanges: [], tools: [], audioBytesIn: 0, audioBytesOut: 0, firstAudioMs: null, errors: [] }
const transcriptLines = []
const t1 = Date.now()
let lastUserText = ''
const runTool = async (name, input) => {
  const r = await customerVoiceTool(env, session, name, input, lastUserText)
  report.tools.push({ name, ok: r.ok !== false, simulated: Boolean(r.simulated), ...(r.ok === false ? { error: r.error } : {}), ...(r.options ? { options: r.options.length } : {}), ...(r.booked ? { booked: true } : {}) })
  return r
}

if (provider === 'openai') {
  const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', { headers: { Authorization: `Bearer ${started.clientSecret}` } })
  const send = (o) => ws.send(JSON.stringify(o))
  let responseDone = null
  const waitResponse = () => new Promise((r) => { responseDone = r })
  const transcripts = new Map()
  let heardAudioAt = null
  let turnSentAt = null
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(String(e?.message || 'ws error'))) })
  ws.onmessage = async (m) => {
    const ev = JSON.parse(m.data)
    if (ev.type === 'error') report.errors.push(String(ev.error?.code || ev.error?.message || 'error').slice(0, 120))
    if (ev.type === 'response.output_audio.delta') {
      report.audioBytesOut += Buffer.from(ev.delta, 'base64').length
      if (!heardAudioAt) heardAudioAt = Date.now()
      if (turnSentAt && report.firstAudioMs == null) report.firstAudioMs = Date.now() - turnSentAt
    }
    if (ev.type === 'response.output_audio_transcript.delta') transcripts.set(ev.item_id, (transcripts.get(ev.item_id) || '') + ev.delta)
    if (ev.type === 'response.output_audio_transcript.done') {
      const text = ev.transcript || transcripts.get(ev.item_id) || ''
      transcriptLines.push({ who: 'receptionist', text, at: Date.now() })
      if (!report.greeting) report.greeting = text
      else report.exchanges.push({ receptionist: text })
    }
    if (ev.type === 'conversation.item.input_audio_transcription.completed') {
      lastUserText = ev.transcript || lastUserText
      transcriptLines.push({ who: 'customer', text: ev.transcript, at: Date.now() })
      report.exchanges.push({ customerHeardAs: ev.transcript })
    }
    if (ev.type === 'response.function_call_arguments.done') {
      let input = {}
      try { input = JSON.parse(ev.arguments || '{}') } catch {}
      const result = await runTool(ev.name, input)
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result) } })
      send({ type: 'response.create' })
    }
    if (ev.type === 'response.done' && !(ev.response?.output || []).some((o) => o.type === 'function_call')) responseDone?.()
  }
  await open
  const config = { ...started.sessionConfig }
  delete config.model
  send({ type: 'session.update', session: config })
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `The call has just connected. Open the call now with this greeting, then wait for the caller: "${started.greeting.replace(/"/g, "'")}"` }] } })
  send({ type: 'response.create' })
  await Promise.race([waitResponse(), sleep(15000)])
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const line = nextLine(turn, transcriptLines.filter((l) => l.who === 'receptionist').at(-1)?.text, report.tools.some((t) => t.booked))
    if (!line) break
    report.exchanges.push({ callerSaid: line })
    const pcm = Buffer.concat([speak(line), silence(1200)])
    turnSentAt = Date.now()
    for (let i = 0; i < pcm.length; i += 4800) {
      send({ type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + 4800).toString('base64') })
      report.audioBytesIn += Math.min(4800, pcm.length - i)
      await sleep(80)
    }
    await Promise.race([waitResponse(), sleep(25000)])
    await sleep(500)
  }
  ws.close()
} else {
  const ws = new WebSocket(started.signedUrl)
  const send = (o) => ws.send(JSON.stringify(o))
  let agentDone = null
  const waitAgent = () => new Promise((r) => { agentDone = r })
  let turnSentAt = null
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(String(e?.message || 'ws error'))) })
  ws.onclose = (e) => { if (e.code !== 1000) report.errors.push(`closed ${e.code} ${e.reason || ''}`.trim()) }
  ws.onmessage = async (m) => {
    const ev = JSON.parse(m.data)
    if (ev.type === 'ping') send({ type: 'pong', event_id: ev.ping_event?.event_id })
    if (ev.type === 'audio') {
      report.audioBytesOut += Buffer.from(ev.audio_event?.audio_base_64 || '', 'base64').length
      if (turnSentAt && report.firstAudioMs == null) report.firstAudioMs = Date.now() - turnSentAt
    }
    if (ev.type === 'agent_response') {
      const text = ev.agent_response_event?.agent_response || ''
      transcriptLines.push({ who: 'receptionist', text, at: Date.now() })
      if (!report.greeting) report.greeting = text
      else report.exchanges.push({ receptionist: text })
      agentDone?.()
    }
    if (ev.type === 'user_transcript') {
      lastUserText = ev.user_transcription_event?.user_transcript || lastUserText
      transcriptLines.push({ who: 'customer', text: lastUserText, at: Date.now() })
      report.exchanges.push({ customerHeardAs: lastUserText })
    }
    if (ev.type === 'client_tool_call') {
      const c = ev.client_tool_call
      const result = await runTool(c.tool_name, c.parameters || {})
      send({ type: 'client_tool_result', tool_call_id: c.tool_call_id, result: JSON.stringify(result), is_error: false })
    }
  }
  await open
  const o = started.overrides
  send({ type: 'conversation_initiation_client_data', conversation_config_override: { agent: { prompt: { prompt: o.agent.prompt.prompt }, language: o.agent.language }, ...(o.tts ? { tts: { ...(o.tts.voiceId ? { voice_id: o.tts.voiceId } : {}), ...(o.tts.speed ? { speed: o.tts.speed } : {}) } } : {}) }, dynamic_variables: started.dynamicVariables })
  await Promise.race([waitAgent(), sleep(15000)])
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const line = nextLine(turn, transcriptLines.filter((l) => l.who === 'receptionist').at(-1)?.text, report.tools.some((t) => t.booked))
    if (!line) break
    report.exchanges.push({ callerSaid: line })
    const pcm = Buffer.concat([speak(line), silence(1200)])
    turnSentAt = Date.now()
    for (let i = 0; i < pcm.length; i += 3200) {
      send({ user_audio_chunk: pcm.subarray(i, i + 3200).toString('base64') })
      report.audioBytesIn += Math.min(3200, pcm.length - i)
      await sleep(80)
    }
    await Promise.race([waitAgent(), sleep(25000)])
    await sleep(1500) // the agent may speak twice (acknowledgement, then the answer after a tool)
  }
  ws.close(1000, 'done')
}

await customerVoiceTranscript(env, session, transcriptLines)
const ended = await endCustomerVoiceSession(env, session, { metrics: { micLive: report.audioBytesIn > 0 ? 1 : 0, audioReceived: report.audioBytesOut > 0 ? 1 : 0, firstResponseMs: report.firstAudioMs ?? undefined, audioSeconds: Math.round((Date.now() - t1) / 1000) }, outcome: report.tools.some((t) => t.booked) ? 'booked_simulated' : 'ended' })
const evidence = await providerEvidence(env, BIZ, provider)
report.durationSeconds = ended.voice.metrics.durationSeconds
report.estimatedMicros = ended.voice.estimatedMicros
report.evidence = evidence
report.ok = evidence.ok && report.errors.length === 0
rmSync(tmp, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
