// POST /api/platform/voice-lab/tool — platform admins only (same-origin); 404 unless VOICE_LAB_ENABLED=true.
//   { customer, id, token, name, input, userText } → the tool's result, exactly what the voice model is told.
// The ONLY way a Lab voice model acts: the browser adapter receives the provider's function call and forwards it here;
// our server runs the engine's tool bound to the Lab session's business, with every guard, in dry-run unless the
// session was started live. The provider never holds our keys and never executes anything itself.
import { json } from '../../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../../server/platform.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { labEnabled } from '../../../../server/voice/providers.js'
import { loadLabSession } from '../../../../server/voice/sessions.js'
import { runVoiceTool, VOICE_TOOL_NAMES } from '../../../../server/voice/tools.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!labEnabled(env)) return json(404, { error: 'not_found' })
  const body = await request.json().catch(() => ({}))
  if (!VOICE_TOOL_NAMES.includes(body?.name)) return json(400, { error: 'unknown_tool' })
  const rl = await hit(env, 'voiceLabTool', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const s = await loadLabSession(env, String(body.customer || ''), body.id, body.token)
  if (!s) return json(404, { error: 'not_found' })
  const result = await runVoiceTool(env, { customer: s.customer, conv: s.conv, userText: body.userText, dryRun: s.conv.state.lab.dryRun !== false, provider: s.conv.state.lab.provider }, body.name, body.input)
  return json(200, { result })
}
