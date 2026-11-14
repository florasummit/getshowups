// POST /api/dashboard/account — { action: 'delete', confirm: true, name: '<business name as shown>' }
// Permanently deletes the signed-in business (server/deletion.js): services stop and members lose access at once,
// ads are paused, billing ends, integrations are disconnected and the data is erased by a retryable workflow.
// There is no undo. Only when ACCOUNT_DELETION_ENABLED is exactly 'true' (approval); otherwise 404.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { deletionEnabled, requestDeletion } from '../../../server/deletion.js'

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export async function onRequestPost({ request, env }) {
  if (!deletionEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (body?.action !== 'delete') return json(400, { error: 'invalid_request' })
  if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
  if (norm(body.name) !== norm(session.customer.name)) return json(400, { error: 'name_mismatch' })
  try {
    const r = await requestDeletion(env, session.customer.id, { type: 'owner', id: session.email })
    if (!r.ok) return json(r.error === 'not_found' ? 404 : 409, { error: r.error })
    return json(202, { deleting: true, status: r.status })
  } catch (err) {
    console.error('account deletion request failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
