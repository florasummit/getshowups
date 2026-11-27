// Customer-facing voice sessions, ONE routing layer for every provider (docs/RECEPTIONIST.md "Voice management").
//
// A customer (or a platform admin testing a candidate provider on a TEST business) starts a browser voice session:
//   1. the business is identified by the public route (bookableCustomer);  2. its ACTIVE provider comes from
//   receptionist_voice_settings (never from the browser; an admin test override is honoured only for a platform admin
//   on an admin-marked test business);  3. the provider must be configured and not switched off;  4. the business's
//   receptionist configuration + voice settings are applied;  5. the provider-specific session is created (Retell web
//   call | OpenAI short-lived client secret | ElevenLabs signed URL);  6. the browser connects;  7. every tool runs on
//   our server through runVoiceTool, bound to this conversation's business;  8. the session is tracked
//   (conv.state.voice + a receptionist_calls row) and ended;  9. limits bound every session.
// A session is PINNED to the provider it started with (reconnects re-read conv.state.voice.provider, never the
// business's current setting), so an admin switch affects new sessions only. There is no fallback: if the active
// provider cannot start, the customer gets a clear error and can keep typing.
import { randomToken } from '../google-oauth.js'
import { emailRef } from '../auditlog.js'
import { startConversation, loadConversation, conversationToken } from '../receptionist/engine.js'
import { startVoiceCall, voiceAllowedFor, voiceStatus } from '../receptionist/voice.js'
import { testStatus } from '../testbusiness.js'
import { mintClientSecret } from './openai.js'
import { fetchSignedUrl, elevenlabsOverrides, elevenlabsDynamicVariables, elevenlabsClientToolNames, SIGNED_URL_TTL_MS } from './elevenlabs.js'
import { providerStatus, estimateMicros, PROVIDERS } from './providers.js'
import { cleanMetrics, cleanDisconnect, providerMinutesToday } from './sessions.js'
import { providerDailyLimit, testDailyMinutes, testMinutesToday, SESSION_CEILING_MS } from './budgets.js'
import { REF_RE } from './charges.js'
import { runVoiceTool, appendVoiceTranscript, voiceInstructions, TOOL_KINDS_SET } from './tools.js'
import { getVoiceSettings, sessionVoiceFor } from './style.js'
import { adminEmails } from '../platform.js'
import { aiOff, retellRoom } from '../ai-budget.js'
export const isPlatformAdminEmail = (env, email) => adminEmails(env).includes(String(email || '').toLowerCase())

export const VOICE_SESSION_MAX_MS = SESSION_CEILING_MS
export const MAX_CONNECTS = 3
// Bounds (env, each with a default): concurrent sessions per business, minutes per business per UTC day (every
// provider), minutes per provider per day across the platform for the providers billed per minute to GetShowUps.
const num = (v, dflt, max) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt
}
export const voiceConcurrentLimit = (env) => num(env?.RECEPTIONIST_VOICE_CONCURRENT, 3, 20)
export const voiceDailyMinutes = (env) => num(env?.RECEPTIONIST_VOICE_DAILY_MINUTES, 120, 1440)
export const providerDailyMinutes = (env) => num(env?.VOICE_PROVIDER_DAILY_MINUTES, 600, 10_000)
// Emergency off switch per provider for customer sessions (comma-separated ids); the Lab is unaffected.
export const providerDisabled = (env, provider) =>
  String(env?.VOICE_PROVIDERS_DISABLED || '')
    .split(',')
    .map((s) => s.trim())
    .includes(provider)

const dayStart = (now) => now - (now % 86_400_000)
// Minutes used today. A call row never ended (the browser went away before its end was recorded) counts at most the
// session ceiling, never "until now": production 2026-11-22, two such rows on one test business would have used up
// its whole daily budget (120 min) within two hours and refused every further test with voice_limit.
export async function businessMinutesToday(env, customerId, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare('SELECT COALESCE(SUM(CASE WHEN ended_at IS NULL THEN MIN(?3, created_at + ?4) ELSE ended_at END - created_at), 0) AS ms FROM receptionist_calls WHERE customer = ?1 AND created_at >= ?2').bind(customerId, dayStart(now), now, VOICE_SESSION_MAX_MS).first()
  return Math.ceil(Number(r?.ms || 0) / 60_000)
}
// Minutes of one provider today, every kind of session (Lab Retell rows included): server/voice/sessions.js.
export { providerMinutesToday }
async function openSessions(env, customerId, now) {
  const r = await env.ONBOARDING_DB.prepare('SELECT count(*) AS n FROM receptionist_calls WHERE customer = ?1 AND ended_at IS NULL AND created_at > ?2').bind(customerId, now - VOICE_SESSION_MAX_MS).first()
  return Number(r?.n || 0)
}

// 'available' | 'testing' | 'not_configured' for customers of this business, by its active provider.
export async function customerVoiceStatus(env, customerId) {
  const prefs = await getVoiceSettings(env.ONBOARDING_DB, customerId)
  if (prefs.provider === 'retell') return voiceStatus(env, customerId)
  return providerStatus(env)[prefs.provider]?.configured && !providerDisabled(env, prefs.provider) ? 'available' : 'not_configured'
}

// Who may test a candidate provider on the customer path: a platform admin, on an admin-marked test business.
// → { ok, admin: { email, ref } } | { ok: false, error }
export async function testOverrideAllowed(env, customer, sessionEmail) {
  if (!isPlatformAdminEmail(env, sessionEmail)) return { ok: false, error: 'test_not_allowed' }
  const t = await testStatus(env, customer.id)
  if (!t.test || t.unreadable) return { ok: false, error: 'not_test_business' }
  return { ok: true, admin: { email: sessionEmail, ref: await emailRef(sessionEmail) } }
}

// Start: → { ok, provider, conversationId, token, ...provider payload } | { ok: false, error, httpStatus }
//   retell     accessToken, callId, transport, iceServers           (the browser runs Retell's SDK)
//   openai     clientSecret, expiresAt, sessionConfig, greeting     (src/voice/openai.js)
//   elevenlabs signedUrl, expiresAt, overrides, dynamicVariables, clientTools (src/voice/elevenlabs.js)
export async function startCustomerVoiceSession(env, customer, { existing = null, attribution = null, test = null } = {}, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const prefs = await getVoiceSettings(db, customer.id)
  const provider = test?.provider || prefs.provider
  if (!PROVIDERS.includes(provider)) return { ok: false, error: 'invalid_provider', httpStatus: 400 }
  if (!providerStatus(env)[provider].configured) return { ok: false, error: 'voice_not_configured', httpStatus: 503 }
  if (providerDisabled(env, provider)) return { ok: false, error: 'voice_unavailable', httpStatus: 503 }
  // Retell keeps its release gate for customers (RECEPTIONIST_VOICE_BUSINESSES); admin tests are not gated by it.
  if (provider === 'retell' && !test && !voiceAllowedFor(env, customer.id)) return { ok: false, error: 'voice_not_available', httpStatus: 403 }
  if ((await openSessions(env, customer.id, now)) >= voiceConcurrentLimit(env)) return { ok: false, error: 'voice_busy', httpStatus: 429 }
  // Emergency AI switches (server/ai-budget.js): no voice session starts while AI is off for this business or everyone.
  if (await aiOff(env, customer.id, now)) return { ok: false, error: 'voice_limit', httpStatus: 429 }
  if ((await businessMinutesToday(env, customer.id, now)) >= voiceDailyMinutes(env)) return { ok: false, error: 'voice_limit', httpStatus: 429 }
  // Per-provider ceiling (server/voice/budgets.js: OpenAI/ElevenLabs by default, Retell only with its own switch).
  const providerCap = providerDailyLimit(env, provider)
  if (providerCap != null && (await providerMinutesToday(env, provider, now)) >= providerCap) return { ok: false, error: 'voice_limit', httpStatus: 429 }
  // Retell, platform-wide (server/ai-budget.js retellRoom, admin-set retell_minutes, default 60): open calls count their
  // full 15-minute ceiling, so the day's minutes can't be passed by calls already running.
  if (provider === 'retell' && !(await retellRoom(env, now)).ok) return { ok: false, error: 'voice_limit', httpStatus: 429 }
  // Test usage of this business today (admin tests + Lab calls): capped on its own, so testing never spends more
  // than VOICE_TEST_DAILY_MINUTES per business per day.
  if (test && (await testMinutesToday(env, customer.id, now)) >= testDailyMinutes(env)) return { ok: false, error: 'test_limit', httpStatus: 429 }
  const conv = existing && !existing.state?.endedAt ? existing : { ...(await startConversation(env, customer, 'voice', now, { attribution })), state: {} }
  const state = conv.state || {}
  if (state.voice && !state.voice.endedAt && state.voice.callId) {
    // A Retell call ends through its socket (receptionist_calls.ended_at), not through voice-session 'end'.
    const row = await db.prepare('SELECT ended_at FROM receptionist_calls WHERE call_id = ?1 AND customer = ?2').bind(state.voice.callId, customer.id).first().catch(() => null)
    if (row?.ended_at) state.voice.endedAt = Number(row.ended_at)
  }
  if (state.voice && !state.voice.endedAt && now - state.voice.startedAt < VOICE_SESSION_MAX_MS) return { ok: false, error: 'voice_in_progress', httpStatus: 409 }
  // A retry on the same conversation keeps the previous attempt's record (how it ended, its disconnect record): the
  // console's session history and the diagnosis of a dropped call must not vanish because the caller tried again.
  if (state.voice) state.voiceHistory = [...(state.voiceHistory || []), summary(state.voice)].slice(-5)
  const settings = test?.voiceId ? { voice: test.voiceId } : null
  const voice = { provider, startedAt: now, connects: 0, test: Boolean(test), by: test?.admin?.ref || null, settings }
  let payload
  if (provider === 'retell') {
    const r = await startVoiceCall(env, customer, now, { id: conv.id, state }, attribution, settings?.voice ? { voice_id: settings.voice } : sessionVoiceFor('retell', prefs), { test: Boolean(test) })
    if (!r.ok) return { ok: false, error: r.error, httpStatus: 502 }
    voice.callId = r.callId
    payload = { accessToken: r.accessToken, callId: r.callId, transport: r.transport, iceServers: r.iceServers }
  } else {
    voice.callId = `web_${randomToken(12)}`
    await db.prepare('INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(voice.callId, customer.id, conv.id, provider, now).run()
    const c = await connectProvider(env, customer, provider, voice, prefs, now)
    if (!c.ok) {
      await db.prepare('UPDATE receptionist_calls SET ended_at = ?2 WHERE call_id = ?1').bind(voice.callId, now).run()
      return c
    }
    payload = c.payload
  }
  state.voice = voice
  await db.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(conv.id, customer.id, JSON.stringify(state), now).run()
  // The conversation's token authorizes every later request of this session (tools, transcript, end). A loaded
  // conversation carries none (the token is derived, never stored), so it is derived again here: without it a
  // "Talk again" on the same conversation handed the page no token and the retry could never report, end or run a
  // tool (production 2026-11-22: two such sessions stayed open).
  const token = existing ? await conversationToken(env, conv.id) : conv.token
  return { ok: true, provider, conversationId: conv.id, token, ...payload }
}

// Provider connection for a session (first connect and reconnects): bounded, pinned to the session's provider.
async function connectProvider(env, customer, provider, voice, prefs, now) {
  if (voice.connects >= MAX_CONNECTS) return { ok: false, error: 'reconnect_limit', httpStatus: 429 }
  voice.connects += 1
  voice.lastConnectAt = now
  const v = await voiceInstructions(env, customer, now)
  if (provider === 'openai') {
    const own = sessionVoiceFor('openai', prefs)
    const minted = await mintClientSecret(env, { instructions: v.instructions, voice: voice.settings?.voice || own?.voice })
    if (!minted.ok) return { ok: false, error: minted.error === 'openai_not_configured' ? 'voice_not_configured' : 'voice_unreachable', httpStatus: 502 }
    return { ok: true, payload: { clientSecret: minted.clientSecret, expiresAt: minted.expiresAt, sessionConfig: minted.sessionConfig, greeting: v.greeting } }
  }
  if (provider === 'elevenlabs') {
    const signed = await fetchSignedUrl(env)
    if (!signed.ok) return { ok: false, error: signed.error === 'elevenlabs_not_configured' ? 'voice_not_configured' : 'voice_unreachable', httpStatus: 502 }
    const tts = voice.settings?.voice ? { voiceId: voice.settings.voice } : sessionVoiceFor('elevenlabs', prefs)
    return { ok: true, payload: { signedUrl: signed.signedUrl, expiresAt: now + SIGNED_URL_TTL_MS, overrides: elevenlabsOverrides({ ...v, tts }), dynamicVariables: elevenlabsDynamicVariables(customer, { dryRun: Boolean(voice.test) }, v.greeting), clientTools: elevenlabsClientToolNames() } }
  }
  return { ok: false, error: 'invalid_provider', httpStatus: 400 }
}

// The session for (business, conversation, token): never another business's; must be a voice session not yet over.
export async function loadCustomerVoiceSession(env, customer, id, token) {
  const conv = await loadConversation(env, customer, String(id || ''), String(token ?? ''))
  if (!conv || !conv.state?.voice) return null
  return { customer, conv }
}

// Reconnect (OpenAI re-mint / ElevenLabs new signed URL), same provider as the session started with.
export async function reconnectCustomerVoiceSession(env, { customer, conv }, now = Date.now()) {
  const voice = conv.state.voice
  if (voice.endedAt || conv.state.endedAt) return { ok: false, error: 'conversation_ended', httpStatus: 409 }
  if (now - voice.startedAt > VOICE_SESSION_MAX_MS) return { ok: false, error: 'session_expired', httpStatus: 409 }
  if (voice.provider === 'retell') return { ok: false, error: 'wrong_provider', httpStatus: 409 }
  const c = await connectProvider(env, customer, voice.provider, voice, await getVoiceSettings(env.ONBOARDING_DB, customer.id), now)
  await env.ONBOARDING_DB.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(conv.id, customer.id, JSON.stringify(conv.state), now).run()
  if (!c.ok) return c
  return { ok: true, provider: voice.provider, connection: voice.connects, connectionsLeft: MAX_CONNECTS - voice.connects, ...c.payload }
}

// A tool call from the provider: run by our server, bound to this conversation's business; admin TEST sessions are
// dry-run (every guard runs, nothing is created); customer sessions are real (the receptionist's real bookings).
export async function customerVoiceTool(env, { customer, conv }, name, input, userText, now = Date.now()) {
  const voice = conv.state.voice
  if (voice.endedAt || conv.state.endedAt) return { ok: false, error: 'conversation_ended' }
  if (now - voice.startedAt > VOICE_SESSION_MAX_MS) return { ok: false, error: 'session_expired' }
  return runVoiceTool(env, { customer, conv, userText, dryRun: Boolean(voice.test), provider: voice.provider }, name, input, now)
}

export const customerVoiceTranscript = (env, { customer, conv }, lines, now = Date.now()) => appendVoiceTranscript(env, customer, conv, lines, now)

// End of the voice part (the conversation itself stays open: the customer can keep typing). Metrics are numbers only;
// `outcome` is a code (ended | a failure code such as provider_refused); `disconnect` is the adapter's record of how
// the connection ended when it did not end cleanly (cleanDisconnect: codes, the WebSocket close code, the provider's
// reason text), the evidence a dropped call is diagnosed from.
// The provider's own id of a session (ElevenLabs' conversation id, reported by the browser SDK on connect): what a
// verified charge is looked up by later (server/voice/charges.js). Well-formed ids only; recorded once.
export async function recordProviderSession(env, { customer, conv }, providerSessionId, now = Date.now()) {
  const voice = conv.state.voice
  const id = String(providerSessionId || '')
  if (!REF_RE.test(id)) return { ok: false, error: 'invalid_reference' }
  if (voice.providerSessionId && voice.providerSessionId !== id) return { ok: false, error: 'already_recorded' }
  if (voice.providerSessionId === id) return { ok: true, already: true }
  voice.providerSessionId = id
  await env.ONBOARDING_DB.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(conv.id, customer.id, JSON.stringify(conv.state), now).run()
  return { ok: true }
}

export async function endCustomerVoiceSession(env, { customer, conv }, { metrics = {}, outcome = null, disconnect = null, providerSessionId = null } = {}, now = Date.now()) {
  const voice = conv.state.voice
  if (voice.endedAt) return { ok: true, already: true, voice: summary(voice) }
  if (!voice.providerSessionId && REF_RE.test(String(providerSessionId || ''))) voice.providerSessionId = String(providerSessionId)
  const seconds = Math.max(0, Math.round((now - voice.startedAt) / 1000))
  voice.metrics = { ...cleanMetrics(voice.metrics), ...cleanMetrics(metrics), durationSeconds: seconds }
  voice.endedAt = now
  voice.estimatedMicros = estimateMicros(voice.provider, seconds)
  if (typeof outcome === 'string' && /^[a-z_]{1,32}$/.test(outcome)) voice.outcome = outcome
  const dc = cleanDisconnect(disconnect)
  if (dc) voice.disconnect = dc
  // What the tools did, from the engine's own events (Retell runs them server-side; the others through runVoiceTool).
  if (!conv.state.tools?.length) {
    const { results } = await env.ONBOARDING_DB.prepare('SELECT kind, ok, detail, at FROM receptionist_events WHERE conversation_id = ?1 AND customer = ?2 ORDER BY id').bind(conv.id, customer.id).all()
    const tools = results.filter((e) => TOOL_KINDS_SET.has(e.kind)).map((e) => ({ name: e.kind, ok: e.ok === 1, at: e.at, ...(String(e.detail || '').endsWith('_simulated') ? { simulated: true } : {}) }))
    if (tools.length) conv.state.tools = tools.slice(-60)
  }
  await env.ONBOARDING_DB.batch([
    env.ONBOARDING_DB.prepare('UPDATE receptionist_calls SET ended_at = ?3 WHERE call_id = ?1 AND customer = ?2 AND ended_at IS NULL').bind(voice.callId, customer.id, now),
    env.ONBOARDING_DB.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(conv.id, customer.id, JSON.stringify(conv.state), now),
  ])
  return { ok: true, voice: summary(voice) }
}
const summary = (v) => ({ provider: v.provider, startedAt: v.startedAt, endedAt: v.endedAt || null, test: Boolean(v.test), metrics: v.metrics || {}, estimatedMicros: v.estimatedMicros ?? null, outcome: v.outcome || null, disconnect: v.disconnect || null, providerSessionId: v.providerSessionId || null, charge: v.charge || null })

// The voice sessions of ONE business, newest first, as the admin console's test history: provider, kind (admin test
// on the customer path | Lab | customer), timing, the adapter's audio evidence, whether the availability and booking
// tools succeeded, the outcome code, the cost estimate, and whether the session counts as activation evidence.
// Codes, counts and times only: no transcript, no customer details, no model internals.
export async function voiceSessionHistory(env, customerId, { limit = 20, now = Date.now() } = {}) {
  let rows = []
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT id, state, outcome, created_at FROM receptionist_conversations WHERE customer = ?1 AND (json_extract(state, '$.voice.provider') IS NOT NULL OR json_extract(state, '$.lab.provider') IS NOT NULL) ORDER BY created_at DESC LIMIT ?2").bind(customerId, Math.min(Math.max(1, limit | 0), 50)).all()
    rows = r.results || []
  } catch {
    rows = []
  }
  const out = []
  for (const row of rows) {
    let s
    try {
      s = JSON.parse(row.state || '{}')
    } catch {
      continue
    }
    const v = s.voice?.provider ? s.voice : s.lab?.provider ? s.lab : null
    if (!v) continue
    const tools = s.tools || []
    const availability = tools.some((t) => t.name === 'find_available_times' && t.ok)
    const booking = tools.some((t) => t.name === 'book_appointment' && t.ok)
    const entry = (x, id, withTools) => {
      const m = x.metrics || {}
      const audio = m.micLive === 1 && m.audioReceived === 1
      const endedAt = x.endedAt || null
      return {
        id,
        provider: x.provider,
        kind: s.lab?.provider ? 'lab' : x.test ? 'test' : 'customer',
        dryRun: s.lab?.provider ? s.lab.dryRun !== false : Boolean(x.test),
        startedAt: x.startedAt || row.created_at,
        endedAt,
        inProgress: !endedAt && now - (x.startedAt || row.created_at) < VOICE_SESSION_MAX_MS,
        audio: { micLive: m.micLive === 1, audioReceived: m.audioReceived === 1 },
        tools: withTools ? { availability, booking, count: tools.length } : { availability: false, booking: false, count: 0 },
        outcome: x.outcome || (withTools ? row.outcome : null) || null,
        disconnect: x.disconnect || null,
        charge: x.charge || null,
        booked: withTools && Boolean(s.booked),
        simulated: withTools && Boolean(s.booked?.simulated),
        estimatedMicros: x.estimatedMicros ?? null,
        evidence: withTools && Boolean(endedAt) && audio && availability && booking && now - endedAt <= 30 * 864e5,
      }
    }
    out.push(entry(v, row.id, true))
    // Earlier attempts in the same conversation (a retry after a dropped call), newest first; their tools are not
    // separable from the conversation's, so they carry their own ending only.
    const earlier = Array.isArray(s.voiceHistory) ? s.voiceHistory : []
    for (let i = earlier.length - 1; i >= 0; i--) if (earlier[i]?.provider) out.push(entry(earlier[i], `${row.id}#${i + 1}`, false))
  }
  return out
}

// Evidence that a provider works for THIS business, from finished sessions of the last 30 days (customer-path tests
// and Lab sessions): audio both ways (the adapter's own measurement) and the booking tools run through our server.
// → { ok, sessions, audio, tools, lastAt, missing: [] }
export async function providerEvidence(env, customerId, provider, now = Date.now()) {
  let rows = []
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT state FROM receptionist_conversations WHERE customer = ?1 AND created_at > ?2 AND (json_extract(state, '$.voice.provider') = ?3 OR json_extract(state, '$.lab.provider') = ?3) ORDER BY created_at DESC LIMIT 30").bind(customerId, now - 30 * 864e5, provider).all()
    rows = r.results || []
  } catch {
    rows = []
  }
  const out = { ok: false, sessions: 0, audio: false, tools: false, lastAt: null, missing: [] }
  for (const row of rows) {
    let s
    try {
      s = JSON.parse(row.state || '{}')
    } catch {
      continue
    }
    const v = s.voice?.provider === provider ? s.voice : s.lab?.provider === provider ? s.lab : null
    if (!v?.endedAt) continue
    out.sessions += 1
    out.lastAt = Math.max(out.lastAt || 0, v.endedAt)
    const m = v.metrics || {}
    if (m.micLive === 1 && m.audioReceived === 1) out.audio = true
    const tools = s.tools || []
    if (tools.some((t) => t.name === 'find_available_times' && t.ok) && tools.some((t) => t.name === 'book_appointment' && t.ok)) out.tools = true
  }
  if (!out.sessions) out.missing.push('session')
  if (!out.audio) out.missing.push('audio')
  if (!out.tools) out.missing.push('tools')
  out.ok = out.missing.length === 0
  return out
}
