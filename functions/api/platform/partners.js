// POST /api/platform/partners — referral partner admin (server/partners.js, server/partner-payouts.js). Actions:
//   create { name, contactEmail?, payoutReference?, terms?, effectiveFrom? } (status invited)
//   details { id, name?, contactEmail?, payoutReference? } · status { id, to, confirm? (ended) } · pause | resume { id }
//   terms { id, terms, effectiveFrom? } (a new version) · agreement { title, versionLabel, body?, url? } (a new version)
//   accept { id, agreementId, acceptedAt?, evidence? } (recorded by the admin) · payout { id, paidOn, methodLabel, … }
//   payout_reverse { id, payoutId, note?, confirm: true }
// Platform admins only, same-origin, audited (ids, statuses, terms, labels; never a contact address or payout text).
// Partners get no login and no access. Nothing here initiates a payment; nothing accrues unless REFERRALS_ENABLED.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { savePartner } from '../../../server/partners.js'
import { recordPayout, reversePayout } from '../../../server/partner-payouts.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_request' })
  try {
    const r = body.action === 'payout' ? await recordPayout(env, body, admin.email) : body.action === 'payout_reverse' ? await reversePayout(env, body, admin.email) : await savePartner(env, body, admin.email)
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    if (r.audit) await audit(env, admin.email, r.audit.action, null, r.audit.details)
    const { audit: _audit, ok: _ok, ...rest } = r
    return json(200, { ok: true, ...rest })
  } catch (err) {
    if (String(err?.message).includes('no such table')) return json(409, { error: 'not_ready' })
    console.error('partner save failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
