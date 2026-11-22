// Meta (Facebook/Instagram) Marketing API adapter: OAuth helpers, account discovery, a lead-ads
// campaign launch (everything created PAUSED), status/budget changes, daily insights, and lead lookup.
//
// Verified on developers.facebook.com (2026-11-09):
//   - Latest Graph API v27.0; base https://graph.facebook.com/{version} (graph-api/changelog).
//   - Login dialog https://www.facebook.com/{version}/dialog/oauth; long-lived exchange
//     GET /oauth/access_token?grant_type=fb_exchange_token (≈60 days) (facebook-login access tokens).
//   - POST /act_{id}/campaigns: name, objective OUTCOME_LEADS, status (ACTIVE|PAUSED only at creation),
//     special_ad_categories required (enum includes NONE) (marketing-api reference ad-account/campaigns).
//   - POST /act_{id}/adsets: campaign_id, daily_budget, billing_event IMPRESSIONS, optimization_goal
//     LEAD_GENERATION (requires promoted_object.page_id), destination_type ON_AD, bid_strategy
//     LOWEST_COST_WITHOUT_CAP, status (reference ad-account/adsets).
//   - Lead retrieval GET /{leadgen_id} → field_data[{name, values}], ad_id, form_id; webhook payload
//     entry[].changes[] with field 'leadgen' and value {leadgen_id, page_id, form_id, ad_id}
//     (marketing-api/guides/lead-ads/retrieving).
//   - Errors: 190 expired token; 10 / 200–299 permissions; 4, 17, 613, 80000–80014 throttling
//     (graph-api/guides/error-handling, marketing-api rate-limiting).
// UNVERIFIED (conservative choices, verify against a test ad account before launch):
//   - targeting.geo_locations.zips [{key:'US:12345'}] (adsets page only documents countries).
//   - daily_budget in account-currency minor units (cents); insights `spend` in major units (2 decimals).
//   - adimages response shape images.{name}.hash; leadgen_forms fields; adcreatives lead-ad
//     call_to_action.value.lead_gen_form_id; leadgen_forms needs a Page access token.
//   - Video upload (advideos) is not implemented: video-only Meta specs are refused.
//   - targeting.publisher_platforms (facebook | instagram), age_min / age_max and the ad set's end_time are documented
//     targeting / ad set fields (marketing-api/audiences/reference/advanced-targeting, ad-set reference); their exact
//     acceptance with our other fields is verified only against a test ad account.
// Verification (verifyCampaign): the created objects are read back (campaign, ad set, ad) and compared with the
// approved draft: status, objective, daily budget, ZIPs, placements, age range, optimization goal, ad present. Read-only.
import { siteOrigin } from '../auth.js'
import { getCreative, getCreativeAsset } from './creative.js'
import { failure, getConnection, loadToken, markReconnect, saveToken } from './connections.js'

export const META_API_VERSION = 'v27.0'
// pages_manage_metadata is needed to subscribe a Page to leadgen webhooks (lead-ads retrieving guide).
export const META_SCOPES = [
  'ads_management',
  'ads_read',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_ads',
  'pages_manage_metadata',
  'leads_retrieval',
  'business_management',
]
export const LEAD_ACTION_TYPES = ['lead']
export const META_STATE_COOKIE = '__Host-gsu_meta_oauth'
export const META_STATE_TTL_SECONDS = 600

const version = (env) => (/^v\d{1,3}\.0$/.test(String(env?.META_API_VERSION)) ? env.META_API_VERSION : META_API_VERSION)
const mockOrigin = (env) => {
  const o = env?.META_API_MOCK_ORIGIN
  return typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
}
export const metaBase = (env) => `${mockOrigin(env) || 'https://graph.facebook.com'}/${version(env)}`
export const metaDialogUrl = (env) => `https://www.facebook.com/${version(env)}/dialog/oauth`
export const metaConfigured = (env) => Boolean(env?.META_APP_ID && env?.META_APP_SECRET)
export const metaRedirectUri = (env) => `${siteOrigin(env)}/api/ads/meta/callback`

// Maps a Graph error to an allowlisted code. Provider messages are never passed through.
export function mapError(httpStatus, body) {
  const e = body?.error || {}
  const code = Number(e.code)
  const sub = Number(e.error_subcode)
  if (code === 190 || code === 102) return failure('reconnect_required', { httpStatus, reconnect: true })
  // Object gone or never existed ("Unsupported get request. Object with ID ... does not exist", code 100 subcode 33).
  if (code === 100 && (sub === 33 || /does not exist/i.test(String(e.message || '')))) return { ...failure('not_found', { httpStatus }), notFound: true }
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) return failure('rate_limited', { httpStatus, retryable: true })
  if (code === 10 || (code >= 200 && code <= 299)) return failure(code === 10 ? 'app_not_approved' : 'permission_denied', { httpStatus })
  if (code === 1487225 || sub === 1487225 || /creative|policy/i.test(String(e.error_user_title || ''))) return failure('creative_rejected', { httpStatus })
  if (sub === 1487366 || sub === 2446149 || /disabled/i.test(String(e.error_user_title || ''))) return failure('account_disabled', { httpStatus })
  if (httpStatus >= 500 || code === 1 || code === 2 || e.is_transient === true) return failure('transient', { httpStatus, retryable: true })
  return failure('invalid_request', { httpStatus })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One Graph call with an 8 s timeout and a single jittered retry on retryable errors.
async function graph(env, method, path, params = {}, { token } = {}) {
  const attempt = async () => {
    const url = new URL(`${metaBase(env)}${path}`)
    const body = new URLSearchParams()
    const all = { ...params, ...(token ? { access_token: token } : {}) }
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined) continue
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      if (method === 'POST') body.set(k, s)
      else url.searchParams.set(k, s) // GET and DELETE carry their parameters on the URL
    }
    let res
    try {
      res = await fetch(url, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
        body: method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(8000),
      })
    } catch {
      return failure('transient', { retryable: true })
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.error) return mapError(res.status, data)
    return { ok: true, data }
  }
  let r = await attempt()
  // GETs retry on any retryable error; writes only when Meta throttled them (nothing was created), so a
  // timed-out create is never repeated blindly (the next launch finds it by name instead).
  if (!r.ok && r.retryable && (method === 'GET' || r.error === 'rate_limited')) {
    const delay = Number(env?.META_RETRY_DELAY_MS ?? 400 + Math.random() * 600)
    await sleep(delay)
    r = await attempt()
  }
  return r
}

// ---------- OAuth ----------

export async function exchangeCode(env, code) {
  const short = await graph(env, 'GET', '/oauth/access_token', {
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: metaRedirectUri(env),
    code,
  })
  if (!short.ok || typeof short.data.access_token !== 'string') return short.ok ? failure('invalid_request') : short
  const long = await graph(env, 'GET', '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: short.data.access_token,
  })
  if (!long.ok || typeof long.data.access_token !== 'string') return long.ok ? failure('invalid_request') : long
  const ttl = Number(long.data.expires_in) > 0 ? Number(long.data.expires_in) * 1000 : 60 * 24 * 3600 * 1000
  return { ok: true, accessToken: long.data.access_token, expiresAt: Date.now() + ttl }
}

// Long-lived user tokens last about 60 days and have no refresh token: a still-valid token is exchanged
// (fb_exchange_token) for a new one, which replaces it (facebook-login/guides/access-tokens/get-long-lived: "You can
// not use an expired token to request a long-lived token"; the new token is a different string). Refreshed when
// under REFRESH_WITHIN_MS of expiry; an expired or refused token marks the connection reconnect_required, so the
// owner reconnects from the Ads tab. Never logs or returns a token.
export const REFRESH_WITHIN_MS = 14 * 24 * 3600 * 1000
export async function refreshToken(env, customerId, now = Date.now()) {
  const t = await loadToken(env, 'meta', customerId)
  if (!t?.accessToken) return { ok: false, error: 'not_connected' }
  if (t.expiresAt && t.expiresAt <= now) {
    await markReconnect(env, customerId, 'meta').catch(() => {})
    return failure('reconnect_required', { reconnect: true })
  }
  if (t.expiresAt && t.expiresAt - now > REFRESH_WITHIN_MS) return { ok: true, skipped: true, expiresAt: t.expiresAt }
  const r = await graph(env, 'GET', '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: t.accessToken })
  if (!r.ok || typeof r.data.access_token !== 'string') {
    if (!r.ok && r.reconnect) await markReconnect(env, customerId, 'meta').catch(() => {})
    return r.ok ? failure('invalid_request') : r
  }
  const ttl = Number(r.data.expires_in) > 0 ? Number(r.data.expires_in) * 1000 : 60 * 24 * 3600 * 1000
  const expiresAt = now + ttl
  await saveToken(env, 'meta', customerId, { accessToken: r.data.access_token, expiresAt, refreshedAt: now })
  return { ok: true, refreshed: true, expiresAt }
}

// Cron: refresh the connected businesses' tokens that are due (bounded per run). Counts only.
export async function refreshMetaTokens(env, { now = Date.now(), limit = 20 } = {}) {
  const out = { checked: 0, refreshed: 0, reconnect: 0, failed: 0 }
  if (!metaConfigured(env)) return out
  const { results } = await env.ONBOARDING_DB.prepare("SELECT customer FROM ad_connections WHERE platform = 'meta' AND status IN ('connected', 'needs_account') ORDER BY updated_at LIMIT ?1").bind(limit).all()
  for (const row of results || []) {
    out.checked += 1
    const r = await refreshToken(env, row.customer, now).catch(() => failure('transient'))
    if (r.ok && r.refreshed) out.refreshed += 1
    else if (!r.ok && r.reconnect) out.reconnect += 1
    else if (!r.ok && r.error !== 'not_connected') out.failed += 1
  }
  return out
}

// Sandbox ad accounts (Marketing API "sandbox mode": one per app, API-only, never delivers, never charges). Meta
// exposes no field that marks one, so the operator lists the ids explicitly: META_SANDBOX_AD_ACCOUNTS=act_1,act_2.
// A business connected to a listed account may create (paused), start and change campaigns there without the live
// switch, like a Google Ads test account; anything else needs ADS_LIVE_LAUNCH.
export const sandboxAdAccounts = (env) =>
  String(env?.META_SANDBOX_AD_ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^act_\d{1,30}$/.test(s))
export const isSandboxAdAccount = (env, accountId) => Boolean(accountId) && sandboxAdAccounts(env).includes(String(accountId).startsWith('act_') ? String(accountId) : `act_${accountId}`)
export async function isSandboxAccount(env, customerId) {
  const conn = await getConnection(env, customerId, 'meta')
  return conn?.status === 'connected' && isSandboxAdAccount(env, conn.account_id)
}

// Meta's official test-lead workflow (lead-ads/testing-troubleshooting): POST /{form_id}/test_leads creates a lead
// with dummy (or given) field data for that form; Meta delivers it to the leadgen webhook exactly like a real lead,
// "organic", not associated with any ad, one per form at a time (an existing one must be deleted first). Needs the
// app live with leads_retrieval (the tool refuses apps in development mode). The lead's id is remembered on the
// campaign (platform_ids.testLeadIds) so the webhook marks the resulting GetShowUps lead as test data.
const TEST_LEAD_FIELDS = (zip) => [
  { name: 'full_name', values: ['Meta Test Lead'] },
  { name: 'email', values: ['meta-test-lead@getshowups.com'] },
  { name: 'phone_number', values: ['+18435550199'] },
  ...(zip ? [{ name: 'zip_code', values: [zip] }] : []),
]
export async function createTestLead(env, customerId, row, { zip = '' } = {}) {
  const ids = idsOf(row)
  if (!ids.formId) return failure('not_launched')
  const conn = await getConnection(env, customerId, 'meta')
  const pageId = conn?.extra?.pageId
  if (conn?.status !== 'connected' || !pageId) return failure('needs_account')
  return withToken(env, customerId, async (token) => {
    const pageTok = await graph(env, 'GET', `/${pageId}`, { fields: 'access_token' }, { token })
    if (!pageTok.ok) return pageTok
    const pt = pageTok.data.access_token || token
    // One test lead per form: remove the previous one first (best effort; a refusal is reported, never hidden).
    const existing = await graph(env, 'GET', `/${ids.formId}/test_leads`, { fields: 'id', limit: 5 }, { token: pt })
    let removed = 0
    for (const o of existing.ok ? existing.data.data || [] : []) {
      const del = await graph(env, 'DELETE', `/${o.id}`, {}, { token: pt })
      if (del.ok) removed += 1
    }
    const r = await graph(env, 'POST', `/${ids.formId}/test_leads`, { field_data: TEST_LEAD_FIELDS(/^\d{5}$/.test(zip) ? zip : '') }, { token: pt })
    if (!r.ok) return r
    const leadgenId = String(r.data.id || '')
    if (!/^\d{1,30}$/.test(leadgenId)) return failure('invalid_request')
    return { ok: true, leadgenId, removed }
  })
}

// Loads this business's token; failure reconnect_required when missing/expired (marks the connection).
async function tokenFor(env, customerId) {
  const t = await loadToken(env, 'meta', customerId)
  if (!t?.accessToken || (t.expiresAt && t.expiresAt < Date.now())) {
    await markReconnect(env, customerId, 'meta').catch(() => {})
    return failure('reconnect_required', { reconnect: true })
  }
  return { ok: true, token: t.accessToken }
}

// Wraps a call so a 190 marks the business's Meta connection for reconnection.
async function withToken(env, customerId, fn) {
  const t = await tokenFor(env, customerId)
  if (!t.ok) return t
  const r = await fn(t.token)
  if (!r.ok && r.reconnect) await markReconnect(env, customerId, 'meta').catch(() => {})
  return r
}

export async function listAccountsWithToken(env, token) {
  const accounts = await graph(env, 'GET', '/me/adaccounts', { fields: 'id,name,currency,account_status', limit: 100 }, { token })
  if (!accounts.ok) return accounts
  const pages = await graph(env, 'GET', '/me/accounts', { fields: 'id,name', limit: 100 }, { token })
  if (!pages.ok) return pages
  return {
    ok: true,
    adAccounts: (accounts.data.data || []).map((a) => ({ id: String(a.id), name: String(a.name ?? ''), currency: String(a.currency ?? ''), status: Number(a.account_status) })),
    pages: (pages.data.data || []).map((p) => ({ id: String(p.id), name: String(p.name ?? '') })),
  }
}

export const listAccounts = (env, customerId) => withToken(env, customerId, (token) => listAccountsWithToken(env, token))

// ---------- campaign launch ----------

const tag = (id) => `GSU-${id}`
const META_CTA = { GET_QUOTE: 'GET_QUOTE', BOOK_NOW: 'BOOK_NOW', LEARN_MORE: 'LEARN_MORE', CONTACT_US: 'CONTACT_US' } // UNVERIFIED enum names

// Builds every create payload for a spec. ids holds known/placeholder ids for references.
export function buildPayloads(env, campaign, { adAccountId, pageId, ids = {} }) {
  const s = campaign.spec
  const name = `${tag(campaign.id)} ${s.name}`.slice(0, 380)
  const formId = ids.formId || '<form_id>'
  const payloads = {
    campaign: { name, objective: 'OUTCOME_LEADS', status: 'PAUSED', special_ad_categories: ['NONE'], buying_type: 'AUCTION' },
    adset: {
      name,
      campaign_id: ids.campaignId || '<campaign_id>',
      daily_budget: s.dailyBudgetCents, // UNVERIFIED: minor units of the ad account currency
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LEAD_GENERATION',
      destination_type: 'ON_AD',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      promoted_object: { page_id: pageId },
      targeting: {
        geo_locations: { zips: s.geo.zips.map((z) => ({ key: `US:${z}` })) }, // zips format UNVERIFIED
        age_min: s.meta.audience?.ageMin ?? 18,
        ...(s.meta.audience?.ageMax ? { age_max: s.meta.audience.ageMax } : {}),
        ...(s.meta.placements?.length ? { publisher_platforms: s.meta.placements } : {}),
      },
      ...(s.meta.endDate ? { end_time: `${s.meta.endDate}T23:59:59Z` } : {}),
      status: 'PAUSED',
    },
    leadForm: {
      name: `${tag(campaign.id)} form`,
      questions: s.meta.formQuestions.map((type) => ({ type })),
      privacy_policy: { url: `${siteOrigin(env)}/privacy`, link_text: 'Privacy policy' },
      follow_up_action_url: siteOrigin(env),
    },
    creative: {
      name,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          message: s.meta.primaryTexts[0],
          name: s.meta.headlines[0],
          ...(s.meta.description ? { description: s.meta.description } : {}),
          image_hash: (ids.imageHashes || [])[0] || '<image_hash>',
          link: siteOrigin(env),
          call_to_action: { type: META_CTA[s.meta.callToAction], value: { lead_gen_form_id: formId } },
        },
      },
    },
    ad: { name, adset_id: ids.adsetId || '<adset_id>', creative: { creative_id: ids.creativeId || '<creative_id>' }, status: 'PAUSED' },
  }
  return { adAccountId, payloads }
}

function checkLaunchable(campaign) {
  const s = campaign?.spec
  if (s?.platform !== 'meta' || !s.meta) return 'invalid_spec'
  if (s.meta.destination !== 'instant_form') return 'unsupported_destination' // website lead ads need a pixel; not supported yet
  if (!s.meta.imageCreativeIds?.length) return 'image_required' // video upload not implemented
  return null
}

// Non-spending by default: dryRun returns the payloads it would send. When not a dry run, every object
// is created PAUSED, resuming from campaign.platformIds so a retried launch never duplicates objects.
export async function launchCampaign(env, customerId, campaign, { dryRun = true } = {}) {
  const invalid = checkLaunchable(campaign)
  if (invalid) return failure(invalid)
  const conn = await getConnection(env, customerId, 'meta')
  const adAccountId = conn?.account_id
  const pageId = conn?.extra?.pageId
  if (dryRun) {
    const built = buildPayloads(env, campaign, { adAccountId: adAccountId || '<ad_account_id>', pageId: pageId || '<page_id>' })
    return { ok: true, dryRun: true, ...built }
  }
  if (conn?.status !== 'connected' || !adAccountId || !pageId) return failure('needs_account')

  return withToken(env, customerId, async (token) => {
    const ids = { ...(campaign.platformIds || {}) }
    const fail = (r) => ({ ...r, platformIds: ids })
    const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`

    // Looks up an object we created earlier (name starts with our tag) so a lost response never duplicates it.
    const findTagged = async (path) => {
      const r = await graph(env, 'GET', path, { fields: 'id,name', limit: 200 }, { token })
      if (!r.ok) return r
      const found = (r.data.data || []).find((o) => String(o.name || '').startsWith(`${tag(campaign.id)} `))
      return { ok: true, id: found ? String(found.id) : null }
    }
    const create = async (key, lookupPath, createPath, payloadKey) => {
      if (ids[key]) return { ok: true }
      if (lookupPath) {
        const f = await findTagged(lookupPath)
        if (!f.ok) return f
        if (f.id) {
          ids[key] = f.id
          return { ok: true }
        }
      }
      const r = await graph(env, 'POST', createPath, buildPayloads(env, campaign, { adAccountId, pageId, ids }).payloads[payloadKey], { token })
      if (!r.ok) return r
      ids[key] = String(r.data.id)
      return { ok: true }
    }

    // 1. Campaign, 2. Ad set (both PAUSED).
    let r = await create('campaignId', `/${acct}/campaigns`, `/${acct}/campaigns`, 'campaign')
    if (!r.ok) return fail(r)
    r = await create('adsetId', `/${ids.campaignId}/adsets`, `/${acct}/adsets`, 'adset')
    if (!r.ok) return fail(r)
    // 3. Images (owner-approved creatives only).
    if (!ids.imageHashes?.length) {
      const hashes = []
      for (const creativeId of campaign.spec.meta.imageCreativeIds) {
        const row = await getCreative(env.ONBOARDING_DB, customerId, creativeId)
        const asset = row?.status === 'approved' ? await getCreativeAsset(env, customerId, creativeId) : null
        if (!asset || asset.kind !== 'image') return fail(failure('creative_unavailable'))
        let bin = ''
        for (const b of asset.bytes) bin += String.fromCharCode(b)
        const up = await graph(env, 'POST', `/${acct}/adimages`, { bytes: btoa(bin) }, { token })
        if (!up.ok) return fail(up)
        const hash = Object.values(up.data.images || {})[0]?.hash
        if (typeof hash !== 'string') return fail(failure('invalid_request'))
        hashes.push(hash)
      }
      ids.imageHashes = hashes
    }
    // 4. Instant lead form (UNVERIFIED: requires a Page access token).
    if (!ids.formId) {
      const pageTok = await graph(env, 'GET', `/${pageId}`, { fields: 'access_token' }, { token })
      if (!pageTok.ok) return fail(pageTok)
      const form = await graph(env, 'POST', `/${pageId}/leadgen_forms`, buildPayloads(env, campaign, { adAccountId, pageId, ids }).payloads.leadForm, { token: pageTok.data.access_token || token })
      if (!form.ok) return fail(form)
      ids.formId = String(form.data.id)
    }
    // 5. Creative, 6. Ad (PAUSED).
    r = await create('creativeId', null, `/${acct}/adcreatives`, 'creative')
    if (!r.ok) return fail(r)
    r = await create('adId', `/${ids.adsetId}/ads`, `/${acct}/ads`, 'ad')
    if (!r.ok) return fail(r)
    return { ok: true, dryRun: false, platformCampaignId: ids.campaignId, platformIds: ids }
  })
}

const idsOf = (row) => (typeof row?.platform_ids === 'string' ? JSON.parse(row.platform_ids || '{}') : row?.platformIds || {})

// Reads a created campaign back from Meta and compares it with the approved draft. Read-only. Returns
// { ok, found, remote: { status: 'ENABLED'|'PAUSED'|'REMOVED', dailyBudgetCents, zips, placements, ageMin, ageMax,
// objective, adStatus }, checks: [{ name, ok }] }. A missing campaign is found: false (not an error): the owner
// deleted it in Ads Manager. Statuses are normalized to the shared vocabulary used for Google (campaigns.js reconcile).
const normStatus = (s) => (s === 'ACTIVE' ? 'ENABLED' : s === 'PAUSED' ? 'PAUSED' : ['DELETED', 'ARCHIVED'].includes(s) ? 'REMOVED' : s || null)
export async function verifyCampaign(env, customerId, row) {
  const ids = idsOf(row)
  if (!ids.campaignId) return failure('not_launched')
  const spec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec
  return withToken(env, customerId, async (token) => {
    const camp = await graph(env, 'GET', `/${ids.campaignId}`, { fields: 'id,name,status,objective,effective_status' }, { token })
    if (!camp.ok) return camp.notFound ? { ok: true, found: false, remote: null, checks: [{ name: 'campaign exists on Meta', ok: false }] } : camp
    const [adset, ad] = await Promise.all([
      ids.adsetId ? graph(env, 'GET', `/${ids.adsetId}`, { fields: 'id,status,daily_budget,targeting,optimization_goal,end_time' }, { token }) : Promise.resolve({ ok: true, data: null }),
      ids.adId ? graph(env, 'GET', `/${ids.adId}`, { fields: 'id,status' }, { token }) : Promise.resolve({ ok: true, data: null }),
    ])
    if (!adset.ok && !adset.notFound) return adset
    if (!ad.ok && !ad.notFound) return ad
    const set = adset.ok ? adset.data : null
    const t = set?.targeting || {}
    const m = spec.meta || {}
    const remote = {
      status: normStatus(camp.data.status),
      objective: camp.data.objective || null,
      dailyBudgetCents: set && set.daily_budget != null ? Number(set.daily_budget) : null,
      zips: (t.geo_locations?.zips || []).map((z) => String(z.key || '').replace(/^US:/, '')),
      placements: Array.isArray(t.publisher_platforms) ? t.publisher_platforms : null,
      ageMin: t.age_min ?? null,
      ageMax: t.age_max ?? null,
      optimizationGoal: set?.optimization_goal || null,
      endTime: set?.end_time || null,
      adStatus: ad.ok && ad.data ? normStatus(ad.data.status) : null,
    }
    const ours = { status: row.status === 'active' ? 'ENABLED' : 'PAUSED' }
    const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
    const checks = [
      { name: 'campaign exists on Meta', ok: true },
      { name: 'campaign status', ok: remote.status === ours.status },
      { name: 'objective is leads', ok: remote.objective === 'OUTCOME_LEADS' },
      { name: 'ad set exists', ok: Boolean(set) },
      { name: 'daily budget', ok: remote.dailyBudgetCents === spec.dailyBudgetCents },
      { name: 'ZIP codes', ok: sameSet(remote.zips, spec.geo?.zips || []) },
      { name: 'placements', ok: m.placements?.length ? sameSet(remote.placements || [], m.placements) : !remote.placements || remote.placements.length === 0 || sameSet(remote.placements, ['facebook', 'instagram']) },
      { name: 'age range', ok: (remote.ageMin ?? 18) === (m.audience?.ageMin ?? 18) && (remote.ageMax ?? null) === (m.audience?.ageMax ?? null) },
      { name: 'optimized for leads', ok: remote.optimizationGoal === 'LEAD_GENERATION' },
      { name: 'end date', ok: m.endDate ? String(remote.endTime || '').startsWith(m.endDate) : true },
      { name: 'ad exists', ok: Boolean(ad.ok && ad.data) },
      { name: 'ad not running while the campaign is paused', ok: !(ours.status === 'PAUSED' && remote.adStatus === 'ENABLED' && remote.status === 'ENABLED') },
    ]
    return { ok: true, found: true, remote, checks }
  })
}

// PAUSED stops delivery at the campaign. ACTIVE turns on ad, ad set, then campaign (all were PAUSED).
export async function setStatus(env, customerId, row, status) {
  if (!['PAUSED', 'ACTIVE'].includes(status)) return failure('invalid_request')
  const ids = idsOf(row)
  if (!ids.campaignId) return failure('not_launched')
  const order = status === 'PAUSED' ? [ids.campaignId] : [ids.adId, ids.adsetId, ids.campaignId].filter(Boolean)
  return withToken(env, customerId, async (token) => {
    for (const id of order) {
      const r = await graph(env, 'POST', `/${id}`, { status }, { token })
      if (!r.ok) return r
    }
    return { ok: true, status }
  })
}

export async function setDailyBudget(env, customerId, row, cents) {
  if (!Number.isInteger(cents) || cents <= 0) return failure('invalid_request')
  const ids = idsOf(row)
  if (!ids.adsetId) return failure('not_launched')
  return withToken(env, customerId, async (token) => {
    const r = await graph(env, 'POST', `/${ids.adsetId}`, { daily_budget: cents }, { token })
    return r.ok ? { ok: true, dailyBudgetCents: cents } : r
  })
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

export async function fetchDailyMetrics(env, customerId, row, sinceYmd, untilYmd) {
  if (!YMD.test(sinceYmd) || !YMD.test(untilYmd)) return failure('invalid_request')
  const ids = idsOf(row)
  if (!ids.campaignId) return failure('not_launched')
  return withToken(env, customerId, async (token) => {
    const r = await graph(
      env,
      'GET',
      `/${ids.campaignId}/insights`,
      { fields: 'spend,impressions,clicks,actions', time_increment: 1, level: 'campaign', time_range: { since: sinceYmd, until: untilYmd } },
      { token },
    )
    if (!r.ok) return r
    const rows = (r.data.data || []).map((d) => ({
      date: String(d.date_start),
      spendCents: Math.round(parseFloat(d.spend || '0') * 100), // UNVERIFIED for zero-decimal currencies
      impressions: Number(d.impressions || 0),
      clicks: Number(d.clicks || 0),
      conversions: (d.actions || []).filter((a) => LEAD_ACTION_TYPES.includes(a.action_type)).reduce((n, a) => n + Number(a.value || 0), 0),
    }))
    return { ok: true, rows: rows.filter((x) => YMD.test(x.date)) }
  })
}

// Fetches one lead (for the webhook). Returns only the fields GetShowUps needs.
export async function fetchLead(env, customerId, leadgenId) {
  if (!/^\d{1,30}$/.test(String(leadgenId))) return failure('invalid_request')
  return withToken(env, customerId, async (token) => {
    const r = await graph(env, 'GET', `/${leadgenId}`, { fields: 'field_data,ad_id,form_id,created_time' }, { token })
    if (!r.ok) return r
    const fields = Object.fromEntries((r.data.field_data || []).map((f) => [String(f.name), String(f.values?.[0] ?? '')]))
    return { ok: true, fields, adId: r.data.ad_id ? String(r.data.ad_id) : null, formId: r.data.form_id ? String(r.data.form_id) : null }
  })
}
