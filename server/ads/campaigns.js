// Campaign service: ad profile, drafts, owner approval, launch (non-spending by default), pause/resume,
// metrics sync, and the dashboard results summary. Routes stay thin and call these.
import { randomToken } from '../google-oauth.js'
import { validateSpec, dailyCeilingCents, LIMITS } from './spec.js'
import { currentApproval, remainingDailyCents } from './budget.js'
import * as meta from './meta.js'
import { stripeConfigured, getSubscription } from '../stripe.js'
import { sandboxed, testStatus } from '../testbusiness.js'
import { normalizeWebsiteUrl } from '../url.js'

const ZIP_RE = /^\d{5}$/
const OBJECTIVES = ['leads', 'bookings']
let googleAdapter = null
// Adapters are loaded lazily so a missing optional adapter never breaks the dashboard.
export async function adapter(platform) {
  if (platform === 'meta') return meta
  if (platform === 'google') return (googleAdapter ||= await import('./google.js'))
  return null
}
const PLATFORM_STATUS = { google: { paused: 'PAUSED', active: 'ENABLED' }, meta: { paused: 'PAUSED', active: 'ACTIVE' } }

// ---------- profile ----------
const list = (v, max, len) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))].filter((x) => x.length <= len).slice(0, max) : [])
// Services may be typed one per line or comma-separated ("Weekly cleaning, Repairs"): each becomes its own service.
export const splitServices = (v) => (Array.isArray(v) ? v : [v]).flatMap((x) => String(x ?? '').split(/[,\n;]+/))

export function validateProfile(body) {
  const b = body && typeof body === 'object' ? body : {}
  const errors = []
  // Optional. example.com → https://example.com; an explicit http(s):// is kept (server/url.js).
  let website = String(b.website ?? '').trim()
  if (website) {
    const [bad, url] = normalizeWebsiteUrl(website)
    if (bad) errors.push('website')
    else website = url
  }
  const industry = String(b.industry ?? '').trim().slice(0, 80)
  if (!industry) errors.push('industry')
  const services = list(splitServices(b.services), 12, 80)
  if (!services.length) errors.push('services')
  const zips = [...new Set((b.serviceArea?.zips || []).map((z) => String(z).trim()))]
  if (!zips.length || zips.length > 200 || zips.some((z) => !ZIP_RE.test(z))) errors.push('zips')
  const cities = list(splitServices(b.serviceArea?.cities), 10, 60) // "Charleston, Mount Pleasant" = two towns
  const exclusions = String(b.exclusions ?? '').trim().slice(0, 500)
  const value = b.customerValueCents == null || b.customerValueCents === '' ? null : Number(b.customerValueCents)
  if (value != null && !(Number.isInteger(value) && value >= 0 && value <= 10000000)) errors.push('customerValue')
  const objective = OBJECTIVES.includes(b.objective) ? b.objective : 'leads'
  const budget = b.monthlyBudgetCents == null || b.monthlyBudgetCents === '' ? null : Number(b.monthlyBudgetCents)
  if (budget != null && !(Number.isInteger(budget) && budget >= 15000 && budget <= 5000000)) errors.push('monthlyBudget')
  const approvedClaims = list(b.approvedClaims, 10, 90)
  if (errors.length) return { errors }
  return { profile: { website, industry, services, serviceArea: { zips, cities }, exclusions, customerValueCents: value, objective, monthlyBudgetCents: budget, approvedClaims } }
}

const rowToProfile = (r) =>
  r && {
    website: r.website,
    industry: r.industry,
    services: JSON.parse(r.services || '[]'),
    serviceArea: { zips: [], cities: [], ...JSON.parse(r.service_area || '{}') },
    exclusions: r.exclusions,
    customerValueCents: r.customer_value_cents,
    objective: r.objective,
    monthlyBudgetCents: r.monthly_budget_cents,
    approvedClaims: JSON.parse(r.approved_claims || '[]'),
  }

export async function getProfile(db, customer) {
  return rowToProfile(await db.prepare('SELECT * FROM ad_profiles WHERE customer = ?1').bind(customer).first())
}

export async function saveProfile(db, customer, p, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO ad_profiles (customer, website, industry, services, service_area, exclusions, customer_value_cents, objective, monthly_budget_cents, approved_claims, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(customer) DO UPDATE SET website = ?2, industry = ?3, services = ?4, service_area = ?5, exclusions = ?6,
         customer_value_cents = ?7, objective = ?8, monthly_budget_cents = ?9, approved_claims = ?10, updated_at = ?11`,
    )
    .bind(customer, p.website, p.industry, JSON.stringify(p.services), JSON.stringify(p.serviceArea), p.exclusions, p.customerValueCents, p.objective, p.monthlyBudgetCents, JSON.stringify(p.approvedClaims), now)
    .run()
}

// ---------- campaigns ----------
const publicCampaign = (r) => ({
  id: r.id,
  platform: r.platform,
  status: r.status,
  spec: JSON.parse(r.spec),
  dailyBudgetCents: r.daily_budget_cents,
  launched: Boolean(r.platform_campaign_id),
  approvedAt: r.approved_at,
  launchedAt: r.launched_at,
  lastError: r.last_error,
  updatedAt: r.updated_at,
})

export async function listCampaigns(db, customer) {
  const { results } = await db.prepare("SELECT * FROM ad_campaigns WHERE customer = ?1 AND status <> 'removed' ORDER BY created_at DESC LIMIT 20").bind(customer).all()
  const { results: checks } = await db
    .prepare("SELECT campaign_id, status, details, at FROM ad_actions WHERE customer = ?1 AND kind = 'verify' ORDER BY at DESC LIMIT 100")
    .bind(customer)
    .all()
  return results.map((r) => {
    const v = checks.find((x) => x.campaign_id === r.id)
    let d = {}
    try {
      d = JSON.parse(v?.details || '{}')
    } catch {}
    return { ...publicCampaign(r), verification: v ? { ok: v.status === 'applied', at: v.at, failed: d.failed || [], google: d.google || null, error: d.error || null } : null }
  })
}

const getRow = (db, customer, id) => (typeof id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(id) ? db.prepare('SELECT * FROM ad_campaigns WHERE id = ?1 AND customer = ?2').bind(id, customer).first() : null)

async function logAction(db, { customer, campaignId, actor, kind, status = 'applied', reason, details = {}, id = randomToken(12) }, now = Date.now()) {
  await db
    .prepare('INSERT OR IGNORE INTO ad_actions (id, customer, campaign_id, actor, kind, status, reason, details, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(id, customer, campaignId, actor, kind, status, reason, JSON.stringify(details), now)
    .run()
}

// An open draft: never launched, not removed, still editable or about to launch (same business + platform).
const OPEN_DRAFT_SQL = "SELECT 1 FROM ad_campaigns WHERE customer = ?2 AND platform = ?3 AND platform_campaign_id IS NULL AND status IN ('draft', 'approved', 'error', 'launching')"
export async function openDraftIds(db, customerId, platform) {
  const { results } = await db
    .prepare("SELECT id FROM ad_campaigns WHERE customer = ?1 AND platform = ?2 AND platform_campaign_id IS NULL AND status IN ('draft', 'approved', 'error', 'launching')")
    .bind(customerId, platform)
    .all()
  return results.map((r) => r.id)
}

// Saves (creates or edits) a draft. Drafts may be incomplete; errors are returned for the editor.
// onlyIfNone: create only when this business has no open (unlaunched, not removed) draft for the platform. The
// check and the insert are one statement, so a double click or two tabs cannot create two drafts.
export async function saveDraft(env, customer, { id, spec, onlyIfNone = false }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const profile = await getProfile(db, customer.id)
  if (!profile) return { ok: false, error: 'profile_required' }
  if (!spec || !['google', 'meta'].includes(spec.platform)) return { ok: false, error: 'invalid_spec' }
  const [errors] = validateSpec(spec, { approvedClaims: profile.approvedClaims })
  const daily = Number.isInteger(spec.dailyBudgetCents) && spec.dailyBudgetCents > 0 ? spec.dailyBudgetCents : 500
  const body = JSON.stringify(spec).slice(0, 60000)
  if (id) {
    const row = await getRow(db, customer.id, id)
    if (!row) return { ok: false, error: 'not_found' }
    if (!['draft', 'approved', 'error'].includes(row.status) || row.platform_campaign_id) return { ok: false, error: 'not_editable' }
    if (row.platform !== spec.platform) return { ok: false, error: 'invalid_spec' }
    // Editing an approved draft returns it to draft: approval covers exactly what the owner saw.
    await db.prepare("UPDATE ad_campaigns SET spec = ?3, daily_budget_cents = ?4, status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ?5 WHERE id = ?1 AND customer = ?2").bind(id, customer.id, body, daily, now).run()
    return { ok: true, id, errors }
  }
  const count = await db.prepare("SELECT count(*) AS n FROM ad_campaigns WHERE customer = ?1 AND status <> 'removed'").bind(customer.id).first()
  if ((count?.n ?? 0) >= 10) return { ok: false, error: 'too_many_campaigns' }
  const newId = randomToken(12)
  const inserted = await db
    .prepare(
      `INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, created_at, updated_at)
       SELECT ?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?6
       WHERE ?7 = 0 OR NOT EXISTS (${OPEN_DRAFT_SQL})
       RETURNING id`,
    )
    .bind(newId, customer.id, spec.platform, body, daily, now, onlyIfNone ? 1 : 0)
    .first()
  if (!inserted) return { ok: false, error: 'draft_exists' }
  return { ok: true, id: newId, errors }
}

// Owner approval of one campaign: strict validation against the approved budget's remaining room.
export async function approveCampaign(env, customer, id, ownerEmail, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await getRow(db, customer.id, id)
  if (!row) return { ok: false, error: 'not_found' }
  if (!['draft', 'error'].includes(row.status) || row.platform_campaign_id) return { ok: false, error: 'not_editable' }
  if (!(await currentApproval(db, customer.id))) return { ok: false, error: 'budget_approval_required' }
  const profile = await getProfile(db, customer.id)
  const [errors, spec] = validateSpec(JSON.parse(row.spec), { approvedClaims: profile?.approvedClaims || [], ceilingDailyCents: await remainingDailyCents(db, customer.id, id) })
  if (errors.length) return { ok: false, error: 'invalid_spec', errors }
  if (spec.platform === 'meta') {
    for (const cid of [...spec.meta.imageCreativeIds, ...spec.meta.videoCreativeIds]) {
      const c = await db.prepare("SELECT 1 AS x FROM ad_creatives WHERE id = ?1 AND customer = ?2 AND status = 'approved'").bind(cid, customer.id).first()
      if (!c) return { ok: false, error: 'creative_not_approved' }
    }
  }
  await db
    .prepare("UPDATE ad_campaigns SET status = 'approved', spec = ?3, daily_budget_cents = ?4, approved_by = ?5, approved_at = ?6, last_error = NULL, updated_at = ?6 WHERE id = ?1 AND customer = ?2")
    .bind(id, customer.id, JSON.stringify(spec), spec.dailyBudgetCents, ownerEmail, now)
    .run()
  await logAction(db, { customer: customer.id, campaignId: id, actor: `owner:${ownerEmail}`, kind: 'approve', reason: 'Owner approved campaign', details: { dailyBudgetCents: spec.dailyBudgetCents } }, now)
  return { ok: true }
}

// Live launch needs: ADS_LIVE_LAUNCH === 'true' (operator switch, requires human approval to set),
// a connected account, and an approved campaign. Otherwise a non-spending check runs
// (Google validateOnly / Meta dry run) and nothing is created.
export const liveLaunchEnabled = (env) => env.ADS_LIVE_LAUNCH === 'true'

// Live operation for one business (and one campaign, by its created_at): the operator switch is on AND
// the business is not a test business AND the campaign was not created while it was one
// (server/testbusiness.js). A test business therefore stays on Google Ads test accounts forever.
export async function liveFor(env, customerId, createdAt = Date.now()) {
  if (!liveLaunchEnabled(env)) return false
  return !sandboxed(await testStatus(env, customerId), createdAt)
}

// Sandbox: without ADS_LIVE_LAUNCH, Google campaigns may still be created (paused), resumed and have
// their budget changed when the connected account is a Google Ads TEST account (Google's own flag,
// checked live; test accounts never serve ads or spend). The adapter enforces the same rule again
// right before each change, so this cannot be bypassed from here.
// Returns 'live', 'sandbox' (verified Google Ads test account: never serves or spends) or null.
async function serveMode(env, platform, customerId, a, row) {
  if (await liveFor(env, customerId, row.created_at)) return 'live'
  return platform === 'google' && typeof a.isTestAccount === 'function' && (await a.isTestAccount(env, customerId)) ? 'sandbox' : null
}

// Access rule: once billing is configured, starting LIVE ads needs an active or trialing subscription.
// Before billing exists (pilot) this is not enforced. Pausing is always allowed. Sandbox (Google Ads
// test account) launches/resumes skip it: they cannot spend, and pilots such as PoolThru are never billed.
export async function billingAllowsAds(env, customerId) {
  if (!stripeConfigured(env)) return true
  const sub = await getSubscription(env.ONBOARDING_DB, customerId)
  return ['active', 'trialing'].includes(sub?.status)
}

export async function launch(env, customer, id, ownerEmail, { live = false } = {}, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await getRow(db, customer.id, id)
  if (!row) return { ok: false, error: 'not_found' }
  const spec = JSON.parse(row.spec)
  const a = await adapter(row.platform)
  if (!a) return { ok: false, error: 'platform_unavailable' }
  const campaign = { id: row.id, spec, createdAt: row.created_at, platformIds: JSON.parse(row.platform_ids || '{}'), platform_ids: row.platform_ids }
  if (!live) {
    // Validation path: never spends, never creates objects.
    const r = row.platform === 'google' ? await a.launchCampaign(env, customer.id, campaign, { validateOnly: true }) : await a.launchCampaign(env, customer.id, campaign, { dryRun: true })
    await logAction(db, { customer: customer.id, campaignId: id, actor: `owner:${ownerEmail}`, kind: 'validate', status: r.ok ? 'applied' : 'failed', reason: r.ok ? 'Validation passed (nothing created, no spend)' : `Validation failed: ${r.error}` }, now)
    return r.ok ? { ok: true, validated: true, live: false } : { ok: false, error: r.error }
  }
  const mode = await serveMode(env, row.platform, customer.id, a, row)
  if (!mode) return { ok: false, error: 'live_launch_disabled' }
  if (mode === 'live' && !(await billingAllowsAds(env, customer.id))) return { ok: false, error: 'subscription_required' }
  if (row.status !== 'approved') return { ok: false, error: 'approval_required' }
  // Re-check the ceiling at launch time (another campaign may have been approved meanwhile).
  if (row.daily_budget_cents > (await remainingDailyCents(db, customer.id, id))) return { ok: false, error: 'exceeds_approved_budget' }
  const claimed = await db.prepare("UPDATE ad_campaigns SET status = 'launching', updated_at = ?3 WHERE id = ?1 AND customer = ?2 AND status = 'approved' RETURNING id").bind(id, customer.id, now).first()
  if (!claimed) return { ok: false, error: 'approval_required' }
  const r = row.platform === 'google' ? await a.launchCampaign(env, customer.id, campaign, { validateOnly: false }) : await a.launchCampaign(env, customer.id, campaign, { dryRun: false })
  const ids = JSON.stringify(r.platformIds || campaign.platformIds || {})
  if (!r.ok) {
    await db.prepare("UPDATE ad_campaigns SET status = 'error', platform_ids = ?3, last_error = ?4, updated_at = ?5 WHERE id = ?1 AND customer = ?2").bind(id, customer.id, ids, r.error, now).run()
    await logAction(db, { customer: customer.id, campaignId: id, actor: `owner:${ownerEmail}`, kind: 'launch', status: 'failed', reason: `Launch failed: ${r.error}` }, now)
    return { ok: false, error: r.error }
  }
  // Created PAUSED on the platform. Delivery starts only when the owner presses Resume.
  await db
    .prepare("UPDATE ad_campaigns SET status = 'paused', platform_campaign_id = ?3, platform_ids = ?4, launched_at = ?5, last_error = NULL, updated_at = ?5 WHERE id = ?1 AND customer = ?2")
    .bind(id, customer.id, r.platformCampaignId || null, ids, now)
    .run()
  await logAction(db, { customer: customer.id, campaignId: id, actor: `owner:${ownerEmail}`, kind: 'launch', reason: 'Created on the platform, paused' }, now)
  // Read it straight back from Google (best effort; the daily cron re-checks).
  let verification = null
  if (row.platform === 'google') {
    const fresh = await getRow(db, customer.id, id)
    const v = await verifyAndRecord(env, fresh, now).catch(() => ({ ok: false, error: 'storage_error' }))
    verification = v.ok ? { ok: v.failed.length === 0, failed: v.failed } : { ok: false, error: v.error }
  }
  return { ok: true, live: true, status: 'paused', verification }
}

export async function setCampaignStatus(env, customer, id, target, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await getRow(db, customer.id, id)
  if (!row) return { ok: false, error: 'not_found' }
  if (!['paused', 'active'].includes(target)) return { ok: false, error: 'invalid_status' }
  if (!row.platform_campaign_id && !JSON.parse(row.platform_ids || '{}').campaignId) return { ok: false, error: 'not_launched' }
  const a = await adapter(row.platform)
  if (target === 'active') {
    const mode = await serveMode(env, row.platform, customer.id, a, row)
    if (!mode) return { ok: false, error: 'live_launch_disabled' }
    if (row.status !== 'paused') return { ok: false, error: 'invalid_status' }
    if (mode === 'live' && !(await billingAllowsAds(env, customer.id))) return { ok: false, error: 'subscription_required' }
    const approval = await currentApproval(db, customer.id)
    if (!approval) return { ok: false, error: 'budget_approval_required' }
    if (row.daily_budget_cents > (await remainingDailyCents(db, customer.id, id))) return { ok: false, error: 'exceeds_approved_budget' }
    const month = await db.prepare('SELECT coalesce(sum(spend_cents),0) AS s FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2').bind(customer.id, new Date(now).toISOString().slice(0, 8) + '01').first()
    if ((month?.s ?? 0) >= approval.monthly_cents) return { ok: false, error: 'monthly_budget_reached' }
  }
  const r = await a.setStatus(env, customer.id, row, PLATFORM_STATUS[row.platform][target])
  if (!r.ok) {
    await logAction(db, { customer: customer.id, campaignId: id, actor, kind: target === 'active' ? 'resume' : 'pause', status: 'failed', reason: `Platform error: ${r.error}` }, now)
    return { ok: false, error: r.error }
  }
  await db.prepare('UPDATE ad_campaigns SET status = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(id, customer.id, target, now).run()
  await logAction(db, { customer: customer.id, campaignId: id, actor, kind: target === 'active' ? 'resume' : 'pause', reason: target === 'active' ? 'Resumed' : 'Paused' }, now)
  return { ok: true, status: target }
}

// Owner changes the daily budget of a launched campaign. Never above the owner-approved ceiling; the
// platform change is allowed only where serving is allowed (live switch, or a verified test account).
export async function setCampaignBudget(env, customer, id, dailyCents, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const row = await getRow(db, customer.id, id)
  if (!row) return { ok: false, error: 'not_found' }
  if (!Number.isInteger(dailyCents) || dailyCents <= 0) return { ok: false, error: 'invalid_budget' }
  if (!row.platform_campaign_id) return { ok: false, error: 'not_launched' }
  if (!['paused', 'active'].includes(row.status)) return { ok: false, error: 'invalid_status' }
  if (!(await currentApproval(db, customer.id))) return { ok: false, error: 'budget_approval_required' }
  if (dailyCents > (await remainingDailyCents(db, customer.id, id))) return { ok: false, error: 'exceeds_approved_budget' }
  const a = await adapter(row.platform)
  if (!(await serveMode(env, row.platform, customer.id, a, row))) return { ok: false, error: 'live_launch_disabled' }
  const r = await a.setDailyBudget(env, customer.id, row, dailyCents)
  if (!r.ok) {
    await logAction(db, { customer: customer.id, campaignId: id, actor, kind: 'budget', status: 'failed', reason: `Platform error: ${r.error}` }, now)
    return { ok: false, error: r.error }
  }
  await db.prepare('UPDATE ad_campaigns SET daily_budget_cents = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(id, customer.id, dailyCents, now).run()
  await logAction(db, { customer: customer.id, campaignId: id, actor, kind: 'budget', reason: `Daily budget set to ${dailyCents} cents`, details: { dailyCents } }, now)
  return { ok: true, dailyBudgetCents: dailyCents }
}

// Reads a created campaign back from Google and records the result (ad_actions kind 'verify'); keeps our
// status in step with Google when the owner changed it in Google Ads (paused/enabled/removed). Read-only on
// Google. Never raises a budget or resumes anything.
export async function verifyAndRecord(env, row, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const a = await adapter(row.platform)
  if (!a?.verifyCampaign) return { ok: false, error: 'platform_unavailable' }
  const r = await a.verifyCampaign(env, row.customer, row)
  if (!r.ok) {
    await logAction(db, { customer: row.customer, campaignId: row.id, actor: 'system', kind: 'verify', status: 'failed', reason: `Couldn't read the campaign from Google (${r.error})`, details: { error: r.error } }, now)
    return r
  }
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name)
  await logAction(
    db,
    {
      customer: row.customer,
      campaignId: row.id,
      actor: 'system',
      kind: 'verify',
      status: failed.length ? 'failed' : 'applied',
      reason: failed.length ? `Checked on Google: ${failed.length} difference(s): ${failed.join(', ')}` : `Checked on Google: all ${r.checks.length} checks match`,
      details: { failed, google: r.google },
    },
    now,
  )
  // Reconcile: Google is the source of truth for whether the campaign runs.
  const g = r.google?.status
  const next = !r.found || g === 'REMOVED' ? 'error' : g === 'ENABLED' ? 'active' : g === 'PAUSED' ? 'paused' : null
  if (next && next !== row.status && ['paused', 'active'].includes(row.status)) {
    await db
      .prepare('UPDATE ad_campaigns SET status = ?3, last_error = ?4, updated_at = ?5 WHERE id = ?1 AND customer = ?2')
      .bind(row.id, row.customer, next, next === 'error' ? 'removed_on_google' : null, now)
      .run()
    await logAction(db, { customer: row.customer, campaignId: row.id, actor: 'system', kind: 'reconcile', reason: `Google Ads shows this campaign as ${next === 'error' ? 'removed' : g.toLowerCase()}; updated to match` }, now)
  }
  return { ok: true, failed, google: r.google }
}

// Cron: re-check created campaigns at most once a day each (oldest first).
export async function verifyLaunched(env, { now = Date.now(), limit = 10 } = {}) {
  const db = env.ONBOARDING_DB
  const { results } = await db
    .prepare(
      `SELECT c.* FROM ad_campaigns c WHERE c.platform = 'google' AND c.platform_campaign_id IS NOT NULL AND c.status IN ('paused', 'active')
       AND coalesce((SELECT max(a.at) FROM ad_actions a WHERE a.campaign_id = c.id AND a.kind = 'verify'), 0) < ?1
       ORDER BY coalesce((SELECT max(a.at) FROM ad_actions a WHERE a.campaign_id = c.id AND a.kind = 'verify'), 0) LIMIT ?2`,
    )
    .bind(now - 86400000, limit)
    .all()
  let checked = 0
  let failed = 0
  for (const row of results) {
    const r = await verifyAndRecord(env, row, now)
    if (r.ok) checked++
    else failed++
  }
  return { checked, failed }
}

// A lower budget approval must also hold for campaigns already running: each running campaign above
// its share is lowered on Google (a reduction is always safe); if that fails it is paused instead.
export async function enforceApproval(env, customerId, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const approval = await currentApproval(db, customerId)
  if (!approval) return { lowered: 0, paused: 0 }
  const ceiling = dailyCeilingCents(approval.monthly_cents)
  const { results } = await db.prepare("SELECT * FROM ad_campaigns WHERE customer = ?1 AND status = 'active' AND platform_campaign_id IS NOT NULL").bind(customerId).all()
  const total = results.reduce((n, r) => n + r.daily_budget_cents, 0)
  if (total <= ceiling) return { lowered: 0, paused: 0 }
  let lowered = 0
  let paused = 0
  for (const row of results) {
    const target = Math.floor((row.daily_budget_cents * ceiling) / total)
    const a = await adapter(row.platform)
    const r = target >= LIMITS.minDailyBudgetCents ? await a.setDailyBudget(env, customerId, row, target) : { ok: false, error: 'below_minimum' }
    if (r.ok) {
      await db.prepare('UPDATE ad_campaigns SET daily_budget_cents = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2').bind(row.id, customerId, target, now).run()
      await logAction(db, { customer: customerId, campaignId: row.id, actor, kind: 'budget', reason: `Daily budget lowered to ${target} cents to fit the new approved budget`, details: { dailyCents: target } }, now)
      lowered++
      continue
    }
    const p = await a.setStatus(env, customerId, row, PLATFORM_STATUS[row.platform].paused)
    if (p.ok) {
      await db.prepare("UPDATE ad_campaigns SET status = 'paused', updated_at = ?3 WHERE id = ?1 AND customer = ?2").bind(row.id, customerId, now).run()
      await logAction(db, { customer: customerId, campaignId: row.id, actor, kind: 'pause', reason: 'Paused: it no longer fits the new approved budget' }, now)
      paused++
    } else {
      await logAction(db, { customer: customerId, campaignId: row.id, actor, kind: 'budget', status: 'failed', reason: `Couldn't lower or pause the campaign on Google (${p.error}); pause it in Google Ads` }, now)
    }
  }
  return { lowered, paused, failed: results.length - lowered - paused }
}

// Optimizer pause hook (cron).
export async function pauseForOptimizer(env, row) {
  const a = await adapter(row.platform)
  return a ? a.setStatus(env, row.customer, row, PLATFORM_STATUS[row.platform].paused) : { ok: false }
}

// Pulls the last 3 days of metrics for launched campaigns (cron). Upserts ad_metrics_daily.
export async function syncMetrics(env, now = Date.now(), limit = 25) {
  const db = env.ONBOARDING_DB
  const { results } = await db.prepare("SELECT * FROM ad_campaigns WHERE status IN ('active', 'paused') AND platform_campaign_id IS NOT NULL ORDER BY updated_at LIMIT ?1").bind(limit).all()
  const since = new Date(now - 3 * 86400000).toISOString().slice(0, 10)
  const until = new Date(now).toISOString().slice(0, 10)
  let synced = 0
  let failed = 0
  for (const row of results) {
    const a = await adapter(row.platform)
    const r = await a.fetchDailyMetrics(env, row.customer, row, since, until)
    if (!r.ok) {
      failed++
      continue
    }
    for (const m of r.rows) {
      await db
        .prepare(
          `INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(campaign_id, date) DO UPDATE SET spend_cents = ?4, impressions = ?5, clicks = ?6, conversions = ?7, fetched_at = ?8`,
        )
        .bind(row.id, row.customer, m.date, m.spendCents, m.impressions, m.clicks, m.conversions, now)
        .run()
    }
    synced++
  }
  return { synced, failed }
}

// ---------- results ----------
// Spend comes from the platforms; leads/bookings/jobs from our own records for attributed leads only.
// Revenue is the owner-reported booking value; there is no verified payment or incremental figure.
export async function adResults(db, customer, now = Date.now()) {
  const since = now - 30 * 86400000
  const sinceDay = new Date(since).toISOString().slice(0, 10)
  const one = (sql, ...a) => db.prepare(sql).bind(customer, ...a).first()
  const spend = await one('SELECT coalesce(sum(spend_cents),0) AS s, count(*) AS n, coalesce(sum(clicks),0) AS c FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2', sinceDay)
  const leads = await one(
    `SELECT count(*) AS n, coalesce(sum(CASE WHEN l.status <> 'unqualified' THEN 1 ELSE 0 END),0) AS q FROM lead_attribution a JOIN leads l ON l.id = a.lead_id
      WHERE a.customer = ?1 AND a.source IN ('google_ads','meta_lead_form','meta_ad_click') AND a.created_at >= ?2`,
    since,
  )
  const appts = await one(
    `SELECT count(*) AS booked,
            coalesce(sum(CASE WHEN o.work = 'completed' THEN 1 ELSE 0 END),0) AS completed,
            coalesce(sum(CASE WHEN o.work = 'completed' THEN o.value_cents ELSE 0 END),0) AS value,
            coalesce(sum(CASE WHEN o.work = 'completed' AND o.value_cents IS NOT NULL THEN 1 ELSE 0 END),0) AS valued
       FROM lead_attribution a JOIN appointments p ON p.lead_id = a.lead_id LEFT JOIN appointment_outcomes o ON o.appointment_id = p.id
      WHERE a.customer = ?1 AND a.source IN ('google_ads','meta_lead_form','meta_ad_click') AND a.created_at >= ?2 AND p.status <> 'cancelled'`,
    since,
  )
  const approval = await currentApproval(db, customer)
  const hasSpend = (spend?.n ?? 0) > 0
  const per = (n) => (hasSpend && n > 0 ? Math.round(spend.s / n) : null)
  const { results: actions } = await db.prepare('SELECT kind, status, reason, at FROM ad_actions WHERE customer = ?1 ORDER BY at DESC LIMIT 10').bind(customer).all()
  return {
    spendCents: hasSpend ? spend.s : null,
    qualifiedLeads: leads?.q ?? 0,
    leads: leads?.n ?? 0,
    booked: appts?.booked ?? 0,
    completedJobs: appts?.completed ?? 0,
    reportedRevenueCents: (appts?.valued ?? 0) > 0 ? appts.value : null,
    verifiedPaymentsCents: null,
    incrementalRevenueCents: null,
    costPerQualifiedLeadCents: per(leads?.q ?? 0),
    costPerBookingCents: per(appts?.booked ?? 0),
    costPerCompletedJobCents: per(appts?.completed ?? 0),
    approvedMonthlyCents: approval?.monthly_cents ?? null,
    dailyCeilingCents: approval ? dailyCeilingCents(approval.monthly_cents) : null,
    actions,
  }
}

export { logAction }

// Advertising results for the main Overview (last 30 days). Real recorded data only:
//   - spend and clicks come from platform daily metrics; null (unavailable) until any are recorded;
//   - leads, bookings and show-ups are leads attributed to this business's OWN campaigns
//     (lead_attribution), excluding test-marked leads; bookings exclude pending reservations and
//     cancelled appointments, show-ups are appointments marked 'showed';
//   - cost per booking / per show-up only when there is spend AND a count to divide by.
export async function adSummary(db, customerId, now = Date.now()) {
  const since = now - 30 * 86400000
  const sinceDay = new Date(since).toISOString().slice(0, 10)
  const m = await db
    .prepare('SELECT count(*) AS n, coalesce(sum(spend_cents), 0) AS s, coalesce(sum(clicks), 0) AS c FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2')
    .bind(customerId, sinceDay)
    .first()
  const f = await db
    .prepare(
      `SELECT count(DISTINCT a.lead_id) AS leads,
              count(DISTINCT CASE WHEN p.status IN ('booked', 'showed', 'no_show') THEN p.id END) AS booked,
              count(DISTINCT CASE WHEN p.status = 'showed' THEN p.id END) AS showed
         FROM lead_attribution a
         LEFT JOIN appointments p ON p.lead_id = a.lead_id AND p.customer = a.customer
        WHERE a.customer = ?1 AND a.source IN ('google_ads', 'meta_ad_click', 'meta_lead_form') AND a.created_at >= ?2
          AND a.lead_id NOT IN (SELECT lead_id FROM test_marks WHERE customer = ?1 AND is_test = 1)`,
    )
    .bind(customerId, since)
    .first()
  const measured = (m?.n ?? 0) > 0
  const per = (n) => (measured && n > 0 ? Math.round(m.s / n) : null)
  const conn = await db.prepare("SELECT extra FROM ad_connections WHERE customer = ?1 AND platform = 'google'").bind(customerId).first()
  const booked = f?.booked ?? 0
  const showed = f?.showed ?? 0
  return {
    spendCents: measured ? m.s : null,
    clicks: measured ? m.c : null,
    leads: f?.leads ?? 0,
    booked,
    showed,
    costPerBookingCents: per(booked),
    costPerShowUpCents: per(showed),
    // Results come from a Google Ads TEST account: real API data, but no real ads ran (labelled in the UI).
    testAccount: JSON.parse(conn?.extra || '{}').testAccount === true,
  }
}
