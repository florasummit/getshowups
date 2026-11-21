// POST /api/platform/voice-lab/retell — platform admins only (same-origin); 404 unless VOICE_LAB_ENABLED=true AND
// Retell is configured (providerStatus(env).retell).
//   { customer, id, token } → { accessToken, callId, transport?, iceServers?, connectionsLeft }
// Creates the Retell web call for ONE Lab session on an admin-marked test business (server/voice/retell.js): the same
// shared agent and custom-LLM socket customers use; our API key never leaves the server. Audited (codes only).
import { json } from '../../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../../server/platform.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { labEnabled, providerStatus } from '../../../../server/voice/providers.js'
import { loadLabSession } from '../../../../server/voice/sessions.js'
import { connectRetellLab } from '../../../../server/voice/retell.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!labEnabled(env)) return json(404, { error: 'not_found' })
  const retell = providerStatus(env).retell
  if (!retell.configured) return json(404, { error: retell.reason })
  const rl = await hit(env, 'voiceLabConnect', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => ({}))
  const s = await loadLabSession(env, String(body?.customer || ''), body?.id, body?.token)
  if (!s) return json(404, { error: 'not_found' })
  const r = await connectRetellLab(env, s)
  await audit(env, admin.email, 'voice_lab.retell_connect', s.customer.id, { ok: r.ok, ...(r.ok ? { connectionsLeft: r.connectionsLeft } : { error: r.error }) })
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  return json(200, { accessToken: r.accessToken, callId: r.callId, transport: r.transport, iceServers: r.iceServers, connectionsLeft: r.connectionsLeft })
}
