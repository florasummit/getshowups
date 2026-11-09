// POST /api/platform/invite-action — { id, action: "resend" | "revoke" }.
// Resend issues a fresh link and invalidates the old one.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { resendInvite, revokeInvite } from '../../../server/accounts.js'
import { emailConfigured, flushOutbox } from '../../../server/email.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const { id, action } = (await request.json().catch(() => ({}))) || {}
  if (typeof id !== 'string') return json(400, { error: 'invalid_request' })
  if (action === 'revoke') {
    const customer = await revokeInvite(env.ONBOARDING_DB, id)
    if (!customer) return json(404, { error: 'not_found' })
    await audit(env, admin.email, 'invite.revoke', customer, { inviteId: id })
    return json(200, { ok: true })
  }
  if (action === 'resend') {
    const invite = await resendInvite(env, { id, actor: admin.email })
    if (!invite) return json(404, { error: 'not_found' })
    const row = await env.ONBOARDING_DB.prepare('SELECT customer FROM account_invites WHERE id = ?1').bind(invite.id).first()
    await audit(env, admin.email, 'invite.resend', row.customer, { previousInviteId: id, inviteId: invite.id })
    const delivery = await flushOutbox(env)
    return json(200, { inviteId: invite.id, url: invite.url, expiresAt: new Date(invite.expiresAt).toISOString(), email: emailConfigured(env) ? (delivery.sent > 0 ? 'sent' : 'queued') : 'not_configured' })
  }
  return json(400, { error: 'invalid_action' })
}
