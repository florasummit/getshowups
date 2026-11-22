// Voice Lab sessions (shared interface, owned by the orchestrator). A session is one receptionist conversation
// (channel 'voice', existing receptionist_conversations table) on a TEST business, started by a platform admin, with a
// receptionist_calls row whose provider says which adapter ran it ('openai' | 'elevenlabs' | 'retell'). No new tables.
//
// Guards: Lab switched on (VOICE_LAB_ENABLED), platform admin (checked by the route), the business is an
// admin-marked test business (never a real customer), dry-run by default (nothing booked, nothing sent), and a daily
// minute ceiling across the Lab. State the Lab keeps lives in conversation.state.lab (codes, counts and timings only).
import { randomToken } from '../google-oauth.js'
import { CUSTOMER_RE } from '../invites.js'
import { getCustomer } from '../customers.js'
import { customerFromRow } from '../auth.js'
import { testStatus } from '../testbusiness.js'
import { startConversation, loadConversation, endConversation, receptionistReady } from '../receptionist/engine.js'
import { emailRef } from '../auditlog.js'
import { PROVIDERS, labEnabled, labDailyMinutes, labSettings, providerStatus, estimateMicros } from './providers.js'
import { labVoiceFor } from './settings.js'
import { TOOL_KINDS_SET } from './tools.js'

export const LAB_SESSION_MAX_MS = 15 * 60 * 1000
const TOOL_KINDS = TOOL_KINDS_SET

// Minutes of Lab calls started today (UTC), from receptionist_calls rows of Lab conversations.
export async function labMinutesToday(env, now = Date.now()) {
  const day = now - (now % 86_400_000)
  // Lab rows only: 'lab_…' call ids (Retell Lab calls take Retell's id but keep provider 'retell-lab'); customer
  // sessions on OpenAI/ElevenLabs ('web_…', server/voice/customer.js) have their own ceilings.
  const r = await env.ONBOARDING_DB.prepare("SELECT COALESCE(SUM(COALESCE(ended_at, ?2) - created_at), 0) AS ms FROM receptionist_calls WHERE (provider = 'retell-lab' OR (provider IN ('openai', 'elevenlabs') AND call_id LIKE 'lab_%')) AND created_at >= ?1").bind(day, now).first()
  return Math.ceil(Number(r?.ms || 0) / 60_000)
}

// One Lab call at a time across the platform: an un-ended Lab call younger than the session ceiling blocks a new one
// (Stop ends it; an abandoned one ages out after LAB_SESSION_MAX_MS).
export async function labBusy(env, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare("SELECT count(*) AS n FROM receptionist_calls WHERE (provider = 'retell-lab' OR (provider IN ('openai', 'elevenlabs') AND call_id LIKE 'lab_%')) AND ended_at IS NULL AND created_at > ?1").bind(now - LAB_SESSION_MAX_MS).first()
  return Number(r?.n || 0) > 0
}

// → { ok, session } | { ok: false, error, httpStatus }. `admin` = { email } from requirePlatformAdmin.
export async function startLabSession(env, admin, { customer: customerId, provider, dryRun = true, settings = {} }, now = Date.now()) {
  if (!labEnabled(env)) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (!PROVIDERS.includes(provider)) return { ok: false, httpStatus: 400, error: 'invalid_provider' }
  if (!providerStatus(env)[provider].configured) return { ok: false, httpStatus: 409, error: `${provider}_not_configured` }
  if (!CUSTOMER_RE.test(String(customerId || ''))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  if (!(await receptionistReady(env.ONBOARDING_DB))) return { ok: false, httpStatus: 503, error: 'receptionist_unavailable' }
  const row = await getCustomer(env.ONBOARDING_DB, customerId)
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  const t = await testStatus(env, customerId)
  if (!t.test || t.unreadable) return { ok: false, httpStatus: 403, error: 'not_test_business' }
  if ((await labMinutesToday(env, now)) >= labDailyMinutes(env)) return { ok: false, httpStatus: 429, error: 'lab_daily_limit' }
  if (await labBusy(env, now)) return { ok: false, httpStatus: 409, error: 'lab_busy' }
  const customer = customerFromRow(row)
  const conv = await startConversation(env, customer, 'voice', now)
  const callId = `lab_${randomToken(12)}`
  const by = await emailRef(admin.email)
  const chosen = labSettings(provider, settings)
  if (chosen.voice && provider !== 'openai') {
    const ok = await labVoiceFor(env, provider, chosen.voice, now)
    if (!ok) return { ok: false, httpStatus: 400, error: 'voice_unknown' }
  }
  const lab = { provider, dryRun: dryRun !== false, by, startedAt: now, callId, metrics: {}, settings: chosen }
  await env.ONBOARDING_DB.batch([
    env.ONBOARDING_DB.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(conv.id, customer.id, JSON.stringify({ lab }), now),
    env.ONBOARDING_DB.prepare('INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(callId, customer.id, conv.id, provider === 'retell' ? 'retell-lab' : provider, now),
  ])
  return { ok: true, session: { id: conv.id, token: conv.token, callId, customer: { id: customer.id, name: customer.name, timezone: customer.timezone }, provider, dryRun: lab.dryRun, settings: lab.settings, startedAt: now } }
}

// The Lab session for (business, conversation id, token) — never another business's, never a customer's chat.
export async function loadLabSession(env, customerId, id, token) {
  if (!labEnabled(env) || !CUSTOMER_RE.test(String(customerId || ''))) return null
  const row = await getCustomer(env.ONBOARDING_DB, customerId)
  if (!row) return null
  const customer = customerFromRow(row)
  // The token is always checked here: loadConversation skips the check for an undefined token (server-internal
  // callers), so a request body that leaves it out must not load someone else's session.
  const conv = await loadConversation(env, customer, id, String(token ?? ''))
  if (!conv || !conv.state?.lab) return null
  return { customer, conv }
}

// Metrics the adapter measured in the browser or the server (numbers only; codes only): kept on the conversation and
// shown in the Lab. Unknown keys are dropped; strings never stored.
// micLive / audioReceived (0|1): the adapter heard the caller's microphone and received the agent's audio — the
// evidence of audio both ways that production readiness asks for (server/voice/customer.js providerEvidence).
const METRIC_KEYS = ['firstResponseMs', 'medianResponseMs', 'p95ResponseMs', 'turns', 'interruptions', 'toolCalls', 'toolFailures', 'repeatedQuestions', 'reconnects', 'audioSeconds', 'inputTokens', 'outputTokens', 'providerCostMicros', 'micLive', 'audioReceived']
export const cleanMetrics = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {}).filter(([k, v]) => METRIC_KEYS.includes(k) && Number.isFinite(v) && v >= 0).map(([k, v]) => [k, Math.round(v)]))

export async function endLabSession(env, { customer, conv }, { metrics = {}, outcome = null } = {}, now = Date.now()) {
  const lab = conv.state.lab
  const seconds = Math.max(0, Math.round((now - lab.startedAt) / 1000))
  lab.metrics = { ...cleanMetrics(lab.metrics), ...cleanMetrics(metrics), durationSeconds: seconds }
  lab.endedAt = now
  lab.estimatedMicros = estimateMicros(lab.provider, seconds)
  if (typeof outcome === 'string' && /^[a-z_]{1,32}$/.test(outcome)) lab.outcome = outcome
  // Retell runs the engine on our server (no browser tool events): read what the tools did from the engine's own
  // receptionist_events for this conversation, so the Lab summary is the same for every provider.
  if (!conv.state.tools?.length) {
    const { results } = await env.ONBOARDING_DB.prepare('SELECT kind, ok, detail, at FROM receptionist_events WHERE conversation_id = ?1 AND customer = ?2 ORDER BY id').bind(conv.id, customer.id).all()
    const tools = results.filter((e) => TOOL_KINDS.has(e.kind)).map((e) => ({ name: e.kind, ok: e.ok === 1, at: e.at, ...(String(e.detail || '').endsWith('_simulated') ? { simulated: true } : {}) }))
    if (tools.length) conv.state.tools = tools.slice(-60)
  }
  await env.ONBOARDING_DB.prepare('UPDATE receptionist_calls SET ended_at = ?3 WHERE call_id = ?1 AND customer = ?2').bind(lab.callId, customer.id, now).run()
  await endConversation(env, customer, conv, now)
  return { ok: true, summary: labSummary(conv) }
}

// What the Lab shows for a session: codes, counts, timings, the customer-visible log; never model internals.
export function labSummary(conv) {
  const lab = conv.state.lab || {}
  return {
    id: conv.id,
    provider: lab.provider,
    dryRun: lab.dryRun !== false,
    startedAt: lab.startedAt,
    endedAt: lab.endedAt || null,
    status: conv.status,
    outcome: lab.outcome || conv.outcome || null,
    booked: Boolean(conv.state.booked),
    simulated: Boolean(conv.state.booked?.simulated),
    tools: conv.state.tools || [],
    metrics: lab.metrics || {},
    estimatedMicros: lab.estimatedMicros ?? null,
    log: (conv.state.log || []).map((l) => ({ who: l.who, text: l.text, at: l.at })),
  }
}

export async function listLabSessions(env, limit = 20) {
  if (!labEnabled(env)) return []
  const { results } = await env.ONBOARDING_DB.prepare("SELECT c.id, c.customer, c.state, c.status, c.outcome, c.created_at FROM receptionist_conversations c JOIN receptionist_calls k ON k.conversation_id = c.id AND k.customer = c.customer WHERE (k.provider = 'retell-lab' OR (k.provider IN ('openai', 'elevenlabs') AND k.call_id LIKE 'lab_%')) ORDER BY c.created_at DESC LIMIT ?1").bind(Math.min(Math.max(1, limit | 0), 100)).all()
  return results.map((r) => labSummary({ ...r, state: JSON.parse(r.state || '{}') })).map((s, i) => ({ ...s, customer: results[i].customer }))
}
