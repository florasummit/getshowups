// GET /api/dashboard/ads — everything the Ads screen needs for the signed-in business (read-only).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { getProfile, listCampaigns, adResults, liveFor } from '../../../../server/ads/campaigns.js'
import { adsHold, HOLD_REASONS, runningOnHold } from '../../../../server/ads/holds.js'
import { currentApproval, remainingDailyCents } from '../../../../server/ads/budget.js'
import { dailyCeilingCents } from '../../../../server/ads/spec.js'
import { imageConfigured, videoConfigured, usageThisMonth, QUOTA } from '../../../../server/ads/creative.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { internalEmails } from '../../../../server/testdata.js'
import { listAssets } from '../../../../server/assets.js'
import { isSandboxAdAccount } from '../../../../server/ads/meta.js'
import { gbpEnabled, gbpReadiness, gbpStatus, refreshGbp } from '../../../../server/ads/gbp.js'

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const db = env.ONBOARDING_DB
  const id = session.customer.id
  try {
    const [profile, campaigns, results, approval, remaining, usage, conns, creatives] = await Promise.all([
      getProfile(db, id),
      listCampaigns(db, id),
      adResults(db, id, Date.now(), internalEmails(env)),
      currentApproval(db, id),
      remainingDailyCents(db, id),
      usageThisMonth(db, id),
      db.prepare('SELECT platform, account_id, account_name, currency, status, extra FROM ad_connections WHERE customer = ?1').bind(id).all(),
      db.prepare("SELECT id, kind, status, prompt, error, created_at FROM ad_creatives WHERE customer = ?1 AND status <> 'rejected' ORDER BY created_at DESC LIMIT 24").bind(id).all(),
    ])
    // The owner's website photos (ids only) so a Meta ad can use one as its image (approved explicitly, never a logo).
    const photos = await listAssets(db, id).then((list) => list.filter((a) => !a.logo).map((a) => ({ id: a.id }))).catch(() => [])
    const live = await liveFor(env, id) // false for a test business, whatever ADS_LIVE_LAUNCH says
    const hold = await adsHold(env, id)
    const stuck = hold ? await runningOnHold(env, id) : null
    const connections = Object.fromEntries(
      conns.results.map((c) => {
        const extra = JSON.parse(c.extra || '{}')
        return [
          c.platform,
          {
            accountId: c.account_id,
            accountName: c.account_name,
            currency: c.currency,
            status: c.status,
            testAccount: extra.testAccount === true,
            // Meta: the connected Page (the lead form and ads belong to it) and whether the ad account is one the
            // operator listed as a sandbox (API-only, never delivers, never charges).
            ...(c.platform === 'meta' ? { pageName: extra.pageName || null, pageId: extra.pageId || null, sandboxAccount: isSandboxAdAccount(env, c.account_id) } : {}),
          },
        ]
      }),
    )
    return json(200, {
      profile,
      hold: hold ? { reason: hold.reason, text: HOLD_REASONS[hold.reason], stillRunning: stuck?.running ?? 0, unreachable: stuck?.unreachable ?? false } : null,
      campaigns,
      results,
      budget: approval ? { monthlyCents: approval.monthly_cents, dailyCeilingCents: dailyCeilingCents(approval.monthly_cents), remainingDailyCents: remaining, approvedAt: approval.approved_at } : null,
      connections,
      creatives: creatives.results.map((c) => ({ id: c.id, kind: c.kind, status: c.status, prompt: c.prompt, error: c.error, createdAt: c.created_at })),
      photos,
      quota: { ...QUOTA, used: usage },
      capabilities: {
        ai: Boolean(env.ANTHROPIC_API_KEY),
        images: imageConfigured(env),
        videos: videoConfigured(env),
        // Google Ads access belongs to the Google Cloud project behind our OAuth client (no developer token).
        google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        meta: Boolean(env.META_APP_ID && env.META_APP_SECRET),
        // Google Business Profile: a separate Google scope and Google's API access approval (GBP_ENABLED).
        gbp: gbpEnabled(env),
        liveLaunch: live,
        // Google Ads test account connected: campaigns can be created (paused), resumed and changed
        // there without the live switch. Re-verified with Google before every change.
        sandbox: !live && connections.google?.status === 'connected' && connections.google.testAccount === true,
        // Meta sandbox ad account connected (META_SANDBOX_AD_ACCOUNTS): same rule, re-read from the connection before every change.
        metaSandbox: !live && connections.meta?.status === 'connected' && connections.meta.sandboxAccount === true,
      },
      bookingUrl: `${new URL(env.GOOGLE_REDIRECT_URI).origin}/book/${id}`,
      // The linked Business Profile (names + Google's verification state, refreshed at most daily) and, without one,
      // the facts-only checklist. Never tokens.
      businessProfile: await refreshGbp(env, id)
        .then(() => gbpStatus(env, id))
        .catch(() => null),
      businessProfileReadiness: gbpReadiness({ enabled: gbpEnabled(env), connected: false }),
    })
  } catch (err) {
    console.error('ads overview failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
