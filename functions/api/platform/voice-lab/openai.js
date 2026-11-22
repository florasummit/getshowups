// POST /api/platform/voice-lab/openai — platform admins only (same-origin); 404 unless VOICE_LAB_ENABLED=true AND
// OpenAI is configured (providerStatus(env).openai).
//   { customer, id, token } → { clientSecret, expiresAt, model, sessionConfig, greeting }
// Mints a SHORT-LIVED OpenAI Realtime client secret for ONE Lab session (server/voice/openai.js): the browser uses it
// for the WebRTC hand-shake with OpenAI and nothing else. Our permanent key never leaves the server; the session
// configuration (instructions, tools, voice, turn detection) is fixed here, not by the browser. Called again on a
// reconnect (the adapter re-mints, up to 2 times). Every call is audited (codes only).
import { json } from '../../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../../server/platform.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { labEnabled, providerStatus } from '../../../../server/voice/providers.js'
import { loadLabSession } from '../../../../server/voice/sessions.js'
import { voiceInstructions } from '../../../../server/voice/tools.js'
import { mintClientSecret } from '../../../../server/voice/openai.js'
import { getVoiceSettings, sessionVoiceFor } from '../../../../server/voice/style.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!labEnabled(env)) return json(404, { error: 'not_found' })
  const openai = providerStatus(env).openai
  if (!openai.configured) return json(404, { error: openai.reason })
  const rl = await hit(env, 'voiceLabConnect', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  const s = await loadLabSession(env, String(body?.customer || ''), body?.id, body?.token)
  if (!s) return json(404, { error: 'not_found' })
  if (s.conv.state.lab.provider !== 'openai') return json(409, { error: 'wrong_provider' })
  if (s.conv.state.endedAt || s.conv.state.lab.endedAt) return json(409, { error: 'conversation_ended' })
  const { instructions, greeting } = await voiceInstructions(env, s.customer)
  const own = sessionVoiceFor('openai', await getVoiceSettings(env.ONBOARDING_DB, s.customer.id))
  const minted = await mintClientSecret(env, { instructions, voice: s.conv.state.lab.settings?.voice || own?.voice })
  await audit(env, admin.email, 'voice_lab.openai_connect', s.customer.id, { ok: minted.ok, ...(minted.ok ? { model: minted.model } : { error: minted.error }) })
  if (!minted.ok) return json(minted.error === 'openai_not_configured' ? 404 : 502, { error: minted.error })
  return json(200, { clientSecret: minted.clientSecret, expiresAt: minted.expiresAt, model: minted.model, sessionConfig: minted.sessionConfig, greeting })
}
