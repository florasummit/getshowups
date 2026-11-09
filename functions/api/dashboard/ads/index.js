// GET /api/dashboard/ads — everything the Ads screen needs for the signed-in business (read-only).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { getProfile, listCampaigns, adResults, liveLaunchEnabled } from '../../../../server/ads/campaigns.js'
import { currentApproval, remainingDailyCents } from '../../../../server/ads/budget.js'
import { dailyCeilingCents } from '../../../../server/ads/spec.js'
import { imageConfigured, videoConfigured, usageThisMonth, QUOTA } from '../../../../server/ads/creative.js'

export async function onRequestGet({ request, env }) {
  if (env.ADS_ENABLED !== 'true') return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  try {
    const [profile, campaigns, results, approval, remaining, usage, conns, creatives] = await Promise.all([
      getProfile(db, id),
      listCampaigns(db, id),
      adResults(db, id),
      currentApproval(db, id),
      remainingDailyCents(db, id),
      usageThisMonth(db, id),
      db.prepare('SELECT platform, account_id, account_name, currency, status FROM ad_connections WHERE customer = ?1').bind(id).all(),
      db.prepare("SELECT id, kind, status, prompt, error, created_at FROM ad_creatives WHERE customer = ?1 AND status <> 'rejected' ORDER BY created_at DESC LIMIT 24").bind(id).all(),
    ])
    const connections = Object.fromEntries(conns.results.map((c) => [c.platform, { accountId: c.account_id, accountName: c.account_name, currency: c.currency, status: c.status }]))
    return json(200, {
      profile,
      campaigns,
      results,
      budget: approval ? { monthlyCents: approval.monthly_cents, dailyCeilingCents: dailyCeilingCents(approval.monthly_cents), remainingDailyCents: remaining, approvedAt: approval.approved_at } : null,
      connections,
      creatives: creatives.results.map((c) => ({ id: c.id, kind: c.kind, status: c.status, prompt: c.prompt, error: c.error, createdAt: c.created_at })),
      quota: { ...QUOTA, used: usage },
      capabilities: {
        ai: Boolean(env.ANTHROPIC_API_KEY),
        images: imageConfigured(env),
        videos: videoConfigured(env),
        google: Boolean(env.GOOGLE_ADS_DEVELOPER_TOKEN || env.GOOGLE_ADS_API_MOCK_ORIGIN),
        meta: Boolean(env.META_APP_ID && env.META_APP_SECRET),
        liveLaunch: liveLaunchEnabled(env),
      },
      bookingUrl: `${new URL(env.GOOGLE_REDIRECT_URI).origin}/book/${id}`,
    })
  } catch (err) {
    console.error('ads overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
