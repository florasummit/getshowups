// POST /api/platform/voice-lab/elevenlabs — platform admins only (same-origin); 404 unless VOICE_LAB_ENABLED=true
// AND ElevenLabs is configured (ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID; providerStatus(env).elevenlabs).
//   { customer, id, token } → { signedUrl, expiresAt, overrides, dynamicVariables, clientTools, connection, connectionsLeft }
// One call per connection of an ElevenLabs Lab session (the first connect and each reconnect): our server asks
// ElevenLabs for a short-lived signed URL with the permanent key (server-only) and hands the browser that URL plus
// the per-conversation overrides (OUR prompt + greeting, no secrets) and the client tool names to register. Nothing
// the agent does reaches a business except through /api/platform/voice-lab/tool.
import { json } from '../../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../../server/platform.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { labEnabled, providerStatus } from '../../../../server/voice/providers.js'
import { loadLabSession } from '../../../../server/voice/sessions.js'
import { connectElevenLabs } from '../../../../server/voice/elevenlabs.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!labEnabled(env)) return json(404, { error: 'not_found' })
  if (!providerStatus(env).elevenlabs.configured) return json(404, { error: 'elevenlabs_not_configured' })
  const rl = await hit(env, 'voiceLabConnect', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  const s = await loadLabSession(env, String(body?.customer || ''), body?.id, body?.token)
  if (!s) return json(404, { error: 'not_found' })
  const r = await connectElevenLabs(env, s)
  if (!r.ok) return json(r.httpStatus || 502, { error: r.error })
  const { signedUrl, expiresAt, overrides, dynamicVariables, clientTools, connection, connectionsLeft } = r
  return json(200, { signedUrl, expiresAt, overrides, dynamicVariables, clientTools, connection, connectionsLeft })
}
