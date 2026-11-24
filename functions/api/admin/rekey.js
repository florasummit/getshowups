// POST /api/admin/rekey (Bearer ADMIN_API_TOKEN): re-encrypt stored secrets with the current key during a rotation
// (docs/KEY_ROTATION.md). Refused unless TOKEN_ENCRYPTION_KEY_PREVIOUS is set. Counts only; audited.
import { isAdmin, json, missingConfig } from '../../../server/google-oauth.js'
import { recordEvent } from '../../../server/auditlog.js'
import { rekey } from '../../../server/rekey.js'

export async function onRequestPost({ request, env }) {
  if (missingConfig(env).length) return json(503, { error: 'not_configured' })
  if (!(await isAdmin(request, env))) return json(401, { error: 'unauthorized' })
  if (!env.TOKEN_ENCRYPTION_KEY_PREVIOUS) return json(409, { error: 'no_rotation_in_progress' })
  const r = await rekey(env)
  await recordEvent(env.ONBOARDING_DB, { type: 'security.rekey', actor: 'system:admin', capability: 'platform.security', outcome: r.unreadable ? 'failure' : 'success', resource: { type: 'key', id: 'token_encryption' }, details: r })
  return json(200, r)
}
