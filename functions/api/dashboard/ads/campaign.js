// POST /api/dashboard/ads/campaign — owner actions on one campaign.
//   { action: 'save', id?, spec }      edit a draft (returns validation errors for the editor)
//   { action: 'approve', id }         owner approval (strict validation, within approved budget)
//   { action: 'validate', id }        non-spending platform check (Google validateOnly / Meta dry run)
//   { action: 'launch', id, confirm } create on the platform, PAUSED (needs ADS_LIVE_LAUNCH)
//   { action: 'pause' | 'resume', id } pause any time; resume needs ADS_LIVE_LAUNCH and budget room
//   { action: 'remove', id }          remove a draft that was never launched
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { saveDraft, approveCampaign, launch, setCampaignStatus, logAction } from '../../../../server/ads/campaigns.js'

const STATUS = { not_found: 404, live_launch_disabled: 409, approval_required: 409, budget_approval_required: 409, exceeds_approved_budget: 409, monthly_budget_reached: 409, not_editable: 409, not_launched: 409, needs_account: 409, profile_required: 409, too_many_campaigns: 409, creative_not_approved: 409, subscription_required: 402 }

export async function onRequestPost({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  const rl = await hit(env, 'adsWrite', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  const actor = `owner:${session.email}`
  let r
  try {
    switch (body?.action) {
      case 'save':
        r = await saveDraft(env, customer, { id: body.id, spec: body.spec })
        break
      case 'approve':
        r = await approveCampaign(env, customer, body.id, session.email)
        break
      case 'validate':
        r = await launch(env, customer, body.id, session.email, { live: false })
        break
      case 'launch':
        if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
        r = await launch(env, customer, body.id, session.email, { live: true })
        break
      case 'pause':
      case 'resume':
        r = await setCampaignStatus(env, customer, body.id, body.action === 'pause' ? 'paused' : 'active', actor)
        break
      case 'remove': {
        const row = await env.ONBOARDING_DB.prepare("UPDATE ad_campaigns SET status = 'removed', updated_at = ?3 WHERE id = ?1 AND customer = ?2 AND platform_campaign_id IS NULL AND status IN ('draft','approved','error') RETURNING id").bind(String(body.id), customer.id, Date.now()).first()
        if (row) await logAction(env.ONBOARDING_DB, { customer: customer.id, campaignId: row.id, actor, kind: 'remove', reason: 'Owner removed a draft' })
        r = row ? { ok: true } : { ok: false, error: 'not_editable' }
        break
      }
      default:
        return json(400, { error: 'invalid_request' })
    }
  } catch (err) {
    console.error('ads campaign action failed:', body?.action, err?.message)
    return json(503, { error: 'storage_error' })
  }
  if (!r.ok) return json(STATUS[r.error] || 400, { error: r.error, ...(r.errors ? { errors: r.errors } : {}) })
  const { ok: _ok, ...rest } = r
  return json(200, rest)
}
