// POST /api/platform/voice-lab/session — platform admins only (same-origin); 404 unless VOICE_LAB_ENABLED=true.
//   { action: 'start', provider, customer, dryRun }   → { session }  (a TEST business only; dry-run by default)
//   { action: 'transcript', customer, id, token, lines }  → appends what was said (text only)
//   { action: 'end', customer, id, token, metrics, outcome } → { summary }
// Provider connection details (ephemeral keys, signed URLs) are issued by the provider adapters' own routes
// (functions/api/platform/voice-lab/<provider>.js), which load the session the same way and never expose our keys.
import { json } from '../../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../../server/platform.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { labEnabled } from '../../../../server/voice/providers.js'
import { startLabSession, loadLabSession, endLabSession } from '../../../../server/voice/sessions.js'
import { appendVoiceTranscript } from '../../../../server/voice/tools.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!labEnabled(env)) return json(404, { error: 'not_found' })
  const body = await request.json().catch(() => ({}))
  if (body?.action === 'start') {
    const rl = await hit(env, 'voiceLabStart', admin.email)
    if (rl.limited) return tooManyJson(rl.retryAfter)
    const r = await startLabSession(env, admin, { customer: String(body.customer || ''), provider: String(body.provider || ''), dryRun: body.dryRun !== false, settings: body.settings && typeof body.settings === 'object' ? body.settings : {} })
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    await audit(env, admin.email, 'voice_lab.session_started', r.session.customer.id, { provider: r.session.provider, dryRun: r.session.dryRun, ...r.session.settings })
    return json(200, { session: r.session })
  }
  const s = await loadLabSession(env, String(body?.customer || ''), body?.id, body?.token)
  if (!s) return json(404, { error: 'not_found' })
  if (body.action === 'transcript') return json(200, await appendVoiceTranscript(env, s.customer, s.conv, body.lines))
  if (body.action === 'end') {
    const r = await endLabSession(env, s, { metrics: body.metrics, outcome: body.outcome })
    await audit(env, admin.email, 'voice_lab.session_ended', s.customer.id, { provider: s.conv.state.lab.provider, outcome: r.summary.outcome, booked: r.summary.booked, simulated: r.summary.simulated })
    return json(200, r)
  }
  return json(400, { error: 'invalid_action' })
}
