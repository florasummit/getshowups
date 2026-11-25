// /api/platform/controls — running the platform without a terminal (platform admins; every write same-origin, with a
// reason and confirm, audited).
//   GET                 → { requests, deletions, deletionEnabled, recoveryDays }
//   GET ?customer=<id>  → { sessions, restrictions, features, costs }   (counts and codes)
//   POST { action, customer, reason, confirm: true }:
//     end_sessions (members signed out everywhere; platform admins keep theirs) · restrict | unrestrict (feature)
//     resolve_closure (a closing request was handled) · undo_deletion (within its recovery window)
import { json } from '../../../server/google-oauth.js'
import { adminEmails, audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { cancelDeletion, closures, deletionEnabled, recoveryDays, setClosureRequest } from '../../../server/deletion.js'
import { FEATURES, listRestrictions, setRestriction } from '../../../server/restrictions.js'
import { providerCosts } from '../../../server/business-accounts.js'
import { enforceAdsHold } from '../../../server/ads/holds.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const id = new URL(request.url).searchParams.get('customer')
  try {
    if (id === null) return json(200, { ...(await closures(env.ONBOARDING_DB)), deletionEnabled: deletionEnabled(env), recoveryDays: recoveryDays(env) })
    if (!CUSTOMER_RE.test(id)) return json(400, { error: 'invalid_customer' })
    const [s, restrictions, costs] = await Promise.all([
      env.ONBOARDING_DB.prepare('SELECT count(*) AS n FROM sessions s JOIN customer_users u ON u.email = s.email WHERE u.customer = ?1 AND s.expires_at > ?2').bind(id, Date.now()).first(),
      listRestrictions(env.ONBOARDING_DB, id),
      providerCosts(env, id).catch(() => null),
    ])
    return json(200, { sessions: s.n, restrictions, features: FEATURES, costs: costs && { days: costs.days, totalMicros: costs.totalMicros } })
  } catch (err) {
    console.error('platform controls failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const b = (await request.json().catch(() => null)) || {}
  const id = String(b.customer || '').toLowerCase()
  const reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!CUSTOMER_RE.test(id) || !['end_sessions', 'restrict', 'unrestrict', 'resolve_closure', 'undo_deletion'].includes(b.action)) return json(400, { error: 'invalid_request' })
  if (b.confirm !== true || reason.length < 5) return json(400, { error: 'reason_required' })
  const db = env.ONBOARDING_DB
  try {
    if (!(await db.prepare('SELECT 1 AS x FROM customers WHERE id = ?1').bind(id).first())) return json(404, { error: 'not_found' })
    if (b.action === 'end_sessions') {
      const keep = adminEmails(env)
      const r = await db.prepare(`DELETE FROM sessions WHERE email IN (SELECT email FROM customer_users WHERE customer = ?1)${keep.length ? ` AND lower(email) NOT IN (${keep.map((_, i) => `?${i + 2}`).join(', ')})` : ''}`).bind(id, ...keep).run()
      await audit(env, admin.email, 'customer.sessions_ended', id, { reason, ended: r.meta.changes })
      return json(200, { ok: true, ended: r.meta.changes })
    }
    if (b.action === 'restrict' || b.action === 'unrestrict') {
      if (!Object.hasOwn(FEATURES, b.feature)) return json(400, { error: 'invalid_feature' })
      if (!(await listRestrictions(db, id)).ready) return json(409, { error: 'not_available_yet' })
      await setRestriction(db, id, b.feature, b.action === 'restrict', reason, admin.email)
      // Ads switched off: whatever runs is paused now (the cron sweep retries), never left running unmanaged.
      const ads = b.action === 'restrict' && b.feature === 'ads' ? await enforceAdsHold(env, id, { actor: `admin:${admin.email}` }).catch(() => ({ paused: 0, failed: -1 })) : null
      await audit(env, admin.email, `customer.feature_${b.action}ed`, id, { feature: b.feature, reason, ...(ads ? { adsPaused: ads.paused, adsFailed: ads.failed } : {}) })
      return json(200, { ok: true, ...(await listRestrictions(db, id)), ...(ads ? { ads: { paused: ads.paused, failed: ads.failed } } : {}) })
    }
    const r = b.action === 'resolve_closure' ? await setClosureRequest(env, id, 'resolved', { type: 'admin', id: admin.email }) : await cancelDeletion(env, id, { type: 'admin', id: admin.email })
    if (!r.ok) return json(409, { error: r.error })
    await audit(env, admin.email, b.action === 'resolve_closure' ? 'customer.closure_resolved' : 'customer.deletion_undone', id, { reason })
    return json(200, { ok: true })
  } catch (err) {
    console.error('platform control failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
