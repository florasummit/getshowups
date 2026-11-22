// Retell in the Voice Lab (platform admins, admin-marked TEST businesses, dry-run by default): the PRODUCTION path, not
// a second one. Our server creates a Retell web call for the Lab session's business with the same shared agent and
// custom-LLM socket customers use (server/receptionist/voice.js); the only differences are the call row's provider
// ('retell-lab', so the socket may answer a test business that is not released for customer voice while the Lab is on,
// and the Lab's minute budget counts it) and that the conversation is the Lab session (dry-run honoured by the engine).
// RETELL_API_KEY never leaves the server; the browser gets Retell's per-call access token only.
// Billing: Retell charges per minute of call on the GetShowUps Retell account (price per the Retell plan; not measured
// here). A session starts only on the admin's explicit Start, one Lab call at a time, ≤ 15 minutes, within the daily budget.
import { CUSTOMER_RE } from '../invites.js'
import { getVoiceSettings, sessionVoiceFor } from './style.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const retellBase = (env) => (typeof env.RETELL_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.RETELL_API_MOCK_ORIGIN) ? env.RETELL_API_MOCK_ORIGIN : 'https://api.retellai.com')
export const RETELL_LAB_MAX_CONNECTS = 3

// → { ok, accessToken, callId, transport?, iceServers?, connectionsLeft } | { ok: false, httpStatus, error }
export async function connectRetellLab(env, { customer, conv }, now = Date.now()) {
  const lab = conv.state?.lab
  if (!lab || lab.provider !== 'retell') return { ok: false, httpStatus: 409, error: 'wrong_provider' }
  if (conv.state.endedAt || lab.endedAt) return { ok: false, httpStatus: 409, error: 'conversation_ended' }
  if (!CUSTOMER_RE.test(customer.id)) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const connects = Number(lab.retellConnects || 0)
  if (connects >= RETELL_LAB_MAX_CONNECTS) return { ok: false, httpStatus: 429, error: 'reconnect_limit' }
  // Voice for this Lab call: the admin's candidate voice (validated at session start) or the business's own settings.
  const override = lab.settings?.voice ? { voice_id: lab.settings.voice } : sessionVoiceFor('retell', await getVoiceSettings(env.ONBOARDING_DB, customer.id))
  let res
  try {
    res = await fetch(`${retellBase(env)}/v3/create-web-call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: env.RETELL_AGENT_ID, agent_version: /^(latest|latest_published|\d{1,6})$/.test(env.RETELL_AGENT_VERSION || '') ? (/^\d+$/.test(env.RETELL_AGENT_VERSION) ? Number(env.RETELL_AGENT_VERSION) : env.RETELL_AGENT_VERSION) : 'latest', metadata: { business: customer.id, conversation: conv.id, lab: true }, ...(override ? { agent_override: { agent: override } } : {}) }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false, httpStatus: 502, error: 'voice_unreachable' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || typeof body.call_id !== 'string' || typeof body.access_token !== 'string') {
    console.error('retell lab call: status', res.status)
    return { ok: false, httpStatus: 502, error: res.status === 402 ? 'voice_billing' : `voice_http_${res.status}` }
  }
  const callId = body.call_id.slice(0, 80)
  // The Lab's call row becomes Retell's call (the socket routes by that id; the minute budget keeps counting one row).
  lab.retellConnects = connects + 1
  lab.callId = callId
  await env.ONBOARDING_DB.batch([
    env.ONBOARDING_DB.prepare('UPDATE receptionist_calls SET call_id = ?3, ended_at = NULL WHERE conversation_id = ?1 AND customer = ?2').bind(conv.id, customer.id, callId),
    env.ONBOARDING_DB.prepare('UPDATE receptionist_conversations SET state = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(conv.id, customer.id, JSON.stringify(conv.state), now),
  ])
  return { ok: true, accessToken: body.access_token, callId, transport: typeof body.transport === 'string' ? body.transport : undefined, iceServers: Array.isArray(body.ice_servers) ? body.ice_servers : undefined, connectionsLeft: RETELL_LAB_MAX_CONNECTS - lab.retellConnects }
}
