// POST /api/platform/status — { customer, status: "active" | "suspended", reason? }.
// Manual only (there is no automatic suspension). Suspension pauses the public booking page and,
// immediately, every running ad campaign (server/ads/holds.js; read back from Google). The owner keeps
// dashboard, billing, and reactivation access. Reactivation never restarts ads: the owner does that.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { track } from '../../../server/events.js'
import { deletionStatus } from '../../../server/deletion.js'
import { enforceAdsHold } from '../../../server/ads/holds.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const customer = String(body?.customer || '').toLowerCase()
  const status = body?.status
  if (!CUSTOMER_RE.test(customer) || !['active', 'suspended'].includes(status)) return json(400, { error: 'invalid_request' })
  const reason = String(body?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (body?.confirm !== true || reason.length < 5) return json(400, { error: 'reason_required' })
  // A business being closed or deleted is never put back online from here (the owner, or "Undo closing", does that).
  if (status === 'active' && (await deletionStatus(env.ONBOARDING_DB, customer))) return json(409, { error: 'being_deleted' })
  // Suspended while its owner is closing it: undoing the closing must not lift the suspension.
  if (status === 'suspended') await env.ONBOARDING_DB.prepare("UPDATE account_deletions SET report = json_set(report, '$.wasStatus', 'suspended') WHERE customer = ?1 AND status = 'in_progress'").bind(customer).run().catch((err) => (String(err?.message).includes('no such table') ? null : Promise.reject(err)))
  const row = await env.ONBOARDING_DB.prepare('UPDATE customers SET status = ?2, updated_at = ?3 WHERE id = ?1 RETURNING id')
    .bind(customer, status, Date.now())
    .first()
  if (!row) return json(404, { error: 'not_found' })
  let ads = null
  if (status === 'suspended') {
    ads = await enforceAdsHold(env, customer, { actor: `admin:${admin.email}` }).catch((err) => {
      console.error('suspend: ads pause failed:', err?.name)
      return { hold: 'suspended', paused: 0, verified: 0, failed: -1 } // the cron sweep retries
    })
  }
  await audit(env, admin.email, `customer.${status === 'suspended' ? 'suspend' : 'reactivate'}`, customer, { reason, ...(ads ? { adsPaused: ads.paused, adsVerified: ads.verified, adsFailed: ads.failed } : {}) })
  await track(env, status === 'suspended' ? 'account_suspended' : 'account_reactivated', { customer })
  return json(200, { customer, status, ...(ads ? { ads: { paused: ads.paused, verified: ads.verified, failed: ads.failed } } : {}) })
}
