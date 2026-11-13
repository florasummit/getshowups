// POST /api/ads/google/disconnect { confirm: true, pauseRunning?: boolean } — the owner disconnects Google Ads.
// GetShowUps stops managing and reporting the account. Campaigns already in Google Ads stay there: if any are
// running, the owner chooses to pause them first (pauseRunning) or to leave them running; we never imply they
// stopped. Approved-but-not-created campaigns go back to draft. Our stored access is deleted; nothing is revoked
// at Google (the grant can be shared with the Calendar connection).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { getConnection, forgetConnection } from '../../../../server/ads/connections.js'
import { setCampaignStatus, logAction } from '../../../../server/ads/campaigns.js'
import { adsEnabled, adsEnabledFor } from '../../../../server/ads/access.js'

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  if (!adsEnabledFor(env, customer.id)) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'adsWrite', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (body?.confirm !== true) return json(400, { error: 'confirmation_required' })
  if (!(await getConnection(env, customer.id, 'google'))) return json(404, { error: 'not_connected' })
  const db = env.ONBOARDING_DB
  const actor = `owner:${session.email}`
  try {
    const { results: running } = await db.prepare("SELECT id FROM ad_campaigns WHERE customer = ?1 AND platform = 'google' AND status = 'active' AND platform_campaign_id IS NOT NULL").bind(customer.id).all()
    if (running.length && body.pauseRunning !== true && body.leaveRunning !== true) return json(409, { error: 'campaigns_running', running: running.length })
    let paused = 0
    if (running.length && body.pauseRunning === true) {
      for (const r of running) {
        const p = await setCampaignStatus(env, customer, r.id, 'paused', actor)
        if (!p.ok) return json(502, { error: 'pause_failed', paused }) // stay connected: nothing is half-done silently
        paused++
      }
    }
    const reset = await db
      .prepare("UPDATE ad_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ?2 WHERE customer = ?1 AND platform = 'google' AND status = 'approved' AND platform_campaign_id IS NULL RETURNING id")
      .bind(customer.id, Date.now())
      .all()
    await forgetConnection(env, 'google', customer.id)
    const onGoogle = await db.prepare("SELECT count(*) AS n FROM ad_campaigns WHERE customer = ?1 AND platform = 'google' AND platform_campaign_id IS NOT NULL AND status IN ('active', 'paused')").bind(customer.id).first()
    const leftRunning = body.pauseRunning === true ? 0 : running.length
    await logAction(db, {
      customer: customer.id,
      campaignId: null,
      actor,
      kind: 'disconnect',
      reason: `Owner disconnected Google Ads${paused ? ` (paused ${paused} running campaign${paused === 1 ? '' : 's'} first)` : ''}${leftRunning ? ` (${leftRunning} left running in Google Ads)` : ''}`,
      details: { paused, leftRunning, draftsReset: reset.results?.length || 0 },
    })
    return json(200, { disconnected: true, paused, leftRunning, stillInGoogleAds: onGoogle?.n ?? 0 })
  } catch (err) {
    console.error('ads disconnect failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
