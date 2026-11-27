// POST /api/platform/assist-approve { proposal, confirm: true } — the platform admin approves ONE change the admin
// assistant prepared (server/admin-assist/proposals.js). Platform admins only, same-origin, rate limited; it re-reads the
// records (409 stale when they changed) and runs only through the existing audited functions. Off with the assistant
// (ADMIN_ASSIST_ENABLED=false → 404).
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { applyAdminProposal } from '../../../server/admin-assist/proposals.js'
import { adminAssistOn } from '../../../server/admin-assist/index.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!adminAssistOn(env)) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'adminAssistApprove', admin.email)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  try {
    const r = await applyAdminProposal(env, admin, body)
    if (!r.ok) return json(r.status, { error: r.error })
    return json(200, { ok: true, state: r.state, already: Boolean(r.already) })
  } catch (err) {
    console.error('admin approve failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
