// Google Ads API adapter: OAuth helpers, accessible-account discovery, a Search campaign launch in ONE
// atomic googleAds:mutate (campaign always PAUSED, validateOnly by default), status/budget changes and
// daily metrics. Every call goes through googleFetch() with at most one jittered retry.
//
// Verified on developers.google.com / googleapis protos (2026-11-09):
//   - REST base https://googleads.googleapis.com/v26; OAuth scope https://www.googleapis.com/auth/adwords.
//   - GET  /v26/customers:listAccessibleCustomers → { resourceNames: ['customers/123'] }.
//   - POST /v26/customers/{id}/googleAds:mutate { mutateOperations, partialFailure, validateOnly };
//     atomic unless partialFailure; negative temp ids (customers/{id}/campaigns/-2) link new objects.
//   - POST /v26/customers/{id}/googleAds:search|searchStream { query } (GAQL); campaigns:mutate and
//     campaignBudgets:mutate { operations: [{ update, updateMask }] }.
//   - POST /v26/geoTargetConstants:suggest { locale, countryCode, locationNames: { names[≤25] } }.
//   - Campaign.status defaults to ENABLED when omitted → we always send PAUSED. Fields used:
//     advertisingChannelType, campaignBudget, networkSettings, maximizeConversions,
//     containsEuPoliticalAdvertising. CampaignCriterion { campaign, negative, location, keyword }.
//   - Developer tokens were sunset on 2026-09-09: access is granted per Google Cloud project (enabling the
//     Google Ads API gives Test access = test accounts only, CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION
//     otherwise). The header is ignored today and will be rejected in a future version, so we never send it
//     (verified 2026-11-11, developers.google.com/google-ads/api/docs/api-policy/developer-token).
// UNVERIFIED (conservative choices; verify against a Google Ads TEST account before any real use):
//   - Exact GoogleAdsFailure JSON layout (error.details[].errors[].errorCode.{xxxError}); mapError
//     also falls back to HTTP status so an unexpected layout still maps to a safe code.
//   - FieldMask JSON path spelling for budgets ("amountMicros"); geo suggestion targetType 'Postal Code'.
// Tests use GOOGLE_ADS_API_MOCK_ORIGIN (loopback only) — never set in production.
import { googleFetch, refreshAccessToken } from '../google-oauth.js'
import { siteOrigin } from '../auth.js'
import { failure, getConnection, loadToken, markReconnect } from './connections.js'
import { LIMITS } from './spec.js'
import { ACTIONS, DATA_MANAGER_SCOPE } from './conversions.js'
import { sandboxed, testStatus } from '../testbusiness.js'

export const GOOGLE_ADS_API_VERSION = 'v26'
export const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords'
export const ADS_STATE_COOKIE = '__Host-gsu_ads_google'
export const ADS_STATE_TTL_SECONDS = 600
export const ACCOUNT_RE = /^\d{10}$/

export const adsRedirectUri = (env) => `${siteOrigin(env)}/api/ads/google/callback`
export function googleAdsBase(env) {
  const o = env?.GOOGLE_ADS_API_MOCK_ORIGIN
  const mock = typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
  return `${mock || 'https://googleads.googleapis.com'}/${GOOGLE_ADS_API_VERSION}`
}
// Data Manager API (offline conversions since June 2026). The mock origin is a loopback-only test variable.
export function dataManagerBase(env) {
  const o = env?.DATA_MANAGER_API_MOCK_ORIGIN
  const mock = typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
  return `${mock || 'https://datamanager.googleapis.com'}/v1`
}
// Accepts 123-456-7890 or 1234567890; returns the 10-digit form or null.
export const normalizeAccountId = (v) => {
  const s = String(v ?? '').replace(/-/g, '')
  return ACCOUNT_RE.test(s) ? s : null
}

// ---------- errors ----------

// Flattens GoogleAdsFailure error codes to 'quotaError.RESOURCE_EXHAUSTED' strings.
function errorCodes(body) {
  const list = Array.isArray(body) ? body : [body]
  const out = []
  for (const b of list) {
    for (const d of b?.error?.details || []) {
      for (const e of d?.errors || []) {
        for (const [k, v] of Object.entries(e?.errorCode || {})) out.push(`${k}.${v}`)
      }
    }
  }
  return out
}

// Maps a Google Ads API failure to an allowlisted code. Provider messages are never passed through.
export function mapError(httpStatus, body) {
  const codes = errorCodes(body)
  const has = (prefix) => codes.some((c) => c.startsWith(prefix))
  const first = Array.isArray(body) ? body[0] : body
  const status = String(first?.error?.status || '')
  if (has('authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION') || has('authorizationError.DEVELOPER_TOKEN_NOT_APPROVED') || has('authorizationError.DEVELOPER_TOKEN_PROHIBITED')) {
    return failure('not_approved_for_production', { httpStatus })
  }
  if (has('authenticationError.') || httpStatus === 401 || status === 'UNAUTHENTICATED') return failure('reconnect_required', { httpStatus, reconnect: true })
  if (has('authorizationError.') || httpStatus === 403 || status === 'PERMISSION_DENIED') return failure('permission_denied', { httpStatus })
  if (has('quotaError.') || httpStatus === 429 || status === 'RESOURCE_EXHAUSTED') return failure('quota_exhausted', { httpStatus, retryable: true })
  if (codes.some((c) => c.includes('CONCURRENT_MODIFICATION')) || status === 'ABORTED') return failure('concurrent_modification', { httpStatus, retryable: true })
  if (has('internalError.') || httpStatus === 0 || httpStatus >= 500) return failure('transient', { httpStatus, retryable: true })
  // Google's error-code enum names (e.g. queryError.UNRECOGNIZED_FIELD): identifiers only, safe to log.
  return { ...failure('invalid_request', { httpStatus }), codes: codes.filter((c) => /^[A-Za-z]+\.[A-Z_]+$/.test(c)).slice(0, 3) }
}

// ---------- tokens + requests ----------

// Short-lived access token for the business's stored Ads grant. Never stored or logged.
export async function accessToken(env, customerId) {
  const tok = await loadToken(env, 'google', customerId)
  if (!tok?.refreshToken) {
    await markReconnect(env, customerId, 'google')
    return failure('reconnect_required', { reconnect: true })
  }
  const r = await refreshAccessToken(env, tok.refreshToken)
  if (r.ok) return { ok: true, token: r.accessToken }
  if (r.error === 'invalid_grant') {
    await markReconnect(env, customerId, 'google')
    return failure('reconnect_required', { httpStatus: r.httpStatus, reconnect: true })
  }
  if (r.httpStatus === 0 || r.httpStatus >= 500) return failure('transient', { httpStatus: r.httpStatus, retryable: true })
  console.error('Google Ads token refresh failed:', r.httpStatus, r.error)
  return failure('invalid_request', { httpStatus: r.httpStatus })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const retryDelay = (env) => {
  const base = env?.GOOGLE_ADS_RETRY_MS != null && Number(env.GOOGLE_ADS_RETRY_MS) >= 0 ? Number(env.GOOGLE_ADS_RETRY_MS) : 1000
  return base + Math.floor(Math.random() * base) // jitter: base..2×base
}

// One HTTP call. Returns { ok: true, data } or a failure(). Retries once on a retryable failure
// unless retry is false (used where a lost response could have applied a change).
async function call(env, token, method, path, { body, loginCustomerId, retry = true } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId
  for (let attempt = 0; ; attempt++) {
    let result
    try {
      const res = await googleFetch(env, `${googleAdsBase(env)}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      result = res.ok ? { ok: true, data } : mapError(res.status, data)
    } catch {
      result = failure('transient', { httpStatus: 0, retryable: true })
    }
    if (result.ok || !result.retryable || !retry || attempt >= 1) {
      // Status, our code and Google's error-code enum names (never Google's message or the payload), so a refused
      // query can be diagnosed from the logs: e.g. queryError.UNRECOGNIZED_FIELD.
      if (!result.ok) console.error('Google Ads request failed:', method, path.split('?')[0].replace(/\d{6,}/g, '<id>'), result.httpStatus, result.error, ...(result.codes?.length ? [result.codes.slice(0, 2).join(' ')] : []))
      return result
    }
    await sleep(retryDelay(env))
  }
}

// Runs fn(token, conn) for a connected business; marks the connection when Google says reconnect.
async function withAccount(env, customerId, fn, { needAccount = true } = {}) {
  const conn = await getConnection(env, customerId, 'google')
  if (!conn) return failure('not_connected')
  if (needAccount && (conn.status !== 'connected' || !ACCOUNT_RE.test(String(conn.account_id || '')))) return failure('needs_account')
  const t = await accessToken(env, customerId)
  if (!t.ok) return t
  const r = await fn(t.token, conn)
  if (!r.ok && r.reconnect) await markReconnect(env, customerId, 'google')
  return r
}
const login = (conn) => normalizeAccountId(conn?.extra?.loginCustomerId) || undefined

// ---------- accounts ----------

export async function listAccountsWithToken(env, token) {
  const r = await call(env, token, 'GET', '/customers:listAccessibleCustomers')
  if (!r.ok) return r
  const ids = (r.data.resourceNames || []).map((n) => String(n).replace(/^customers\//, '')).filter((id) => ACCOUNT_RE.test(id))
  return { ok: true, accounts: [...new Set(ids)] }
}

// Accessible customer ids (10 digits) for the business's grant. Works before an account is chosen.
export async function listAccounts(env, customerId) {
  const t = await accessToken(env, customerId)
  if (!t.ok) return t
  const r = await listAccountsWithToken(env, t.token)
  if (!r.ok && r.reconnect) await markReconnect(env, customerId, 'google')
  return r
}

// Name, currency and test-account flag of one account (best effort; null fields when unreadable).
// customer.test_account is Google's own flag: test accounts never serve ads and are never charged.
export async function describeAccountWithToken(env, token, accountId, loginCustomerId) {
  const r = await call(env, token, 'POST', `/customers/${accountId}/googleAds:search`, {
    body: { query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.test_account FROM customer LIMIT 1' },
    loginCustomerId,
  })
  const c = r.ok ? r.data.results?.[0]?.customer : null
  return {
    name: typeof c?.descriptiveName === 'string' ? c.descriptiveName.slice(0, 120) : null,
    currency: /^[A-Z]{3}$/.test(c?.currencyCode || '') ? c.currencyCode : null,
    testAccount: typeof c?.testAccount === 'boolean' ? c.testAccount : null,
  }
}

// Whether Google can bill this account (read-only, best effort). Ad payments are set up and collected by Google in
// Google Ads; GetShowUps never sees payment details. 'ready' | 'pending' | 'missing' | 'unknown' (couldn't read:
// e.g. our API access level doesn't allow billing reads).
export async function billingStatusWithToken(env, token, accountId, loginCustomerId) {
  const r = await call(env, token, 'POST', `/customers/${accountId}/googleAds:search`, { body: { query: 'SELECT billing_setup.status FROM billing_setup' }, loginCustomerId })
  if (!r.ok) return 'unknown'
  const states = (r.data.results || []).map((x) => x.billingSetup?.status)
  if (states.some((x) => x === 'APPROVED' || x === 'APPROVED_HELD')) return 'ready'
  if (states.includes('PENDING')) return 'pending'
  return 'missing'
}

// Every advertiser account this Google sign-in can use, found automatically: the directly accessible
// accounts plus the client accounts under any accessible manager (customer_client hierarchy, any depth).
// Manager accounts can't hold campaigns and are left out. `via` = the manager to call through
// (login-customer-id) or null for direct access; it stays server-side and is never shown to the owner.
// testAccount is Google's own flag (null when Google didn't say). Read-only. Bounded: ≤10 roots.
const HIERARCHY =
  'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.test_account FROM customer_client LIMIT 500'
export async function listSelectableAccountsWithToken(env, token) {
  const roots = await listAccountsWithToken(env, token)
  if (!roots.ok) return roots
  const found = new Map()
  let firstError = null
  for (const root of roots.accounts.slice(0, 10)) {
    const r = await call(env, token, 'POST', `/customers/${root}/googleAds:search`, { body: { query: HIERARCHY }, loginCustomerId: root })
    if (!r.ok) {
      firstError ||= r
      continue
    }
    for (const x of r.data.results || []) {
      const c = x.customerClient || {}
      const id = String(c.id || '')
      if (!ACCOUNT_RE.test(id) || c.manager === true) continue
      const direct = id === root
      const prev = found.get(id)
      if (prev && (prev.via === null || !direct)) continue // keep direct access, else the first manager seen
      found.set(id, {
        id,
        name: typeof c.descriptiveName === 'string' && c.descriptiveName.trim() ? c.descriptiveName.slice(0, 120) : null,
        currency: /^[A-Z]{3}$/.test(c.currencyCode || '') ? c.currencyCode : null,
        testAccount: typeof c.testAccount === 'boolean' ? c.testAccount : null,
        via: direct ? null : root,
      })
    }
  }
  if (!found.size && firstError) return firstError
  return { ok: true, accounts: [...found.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id)) }
}

// ---------- test-account guard ----------
// Without the operator switch ADS_LIVE_LAUNCH, every change that could make a campaign serve (create
// for real, resume, budget change) is allowed ONLY on a Google Ads test account, verified fresh from
// Google right before the change. Unknown → refused (fails closed). Pausing is never blocked.
const liveSwitch = (env) => env.ADS_LIVE_LAUNCH === 'true'
async function testAccountOk(env, token, conn) {
  const about = await describeAccountWithToken(env, token, conn.account_id, login(conn))
  return about.testAccount === true
}
// The live switch never applies to a test business or to a campaign created while it was one.
async function guardServing(env, token, conn, createdAt) {
  if (liveSwitch(env) && !sandboxed(await testStatus(env, conn.customer), createdAt)) return null
  return (await testAccountOk(env, token, conn)) ? null : failure('test_account_required')
}

// True only when the business's connected account is a Google Ads test account (read from Google now).
export async function isTestAccount(env, customerId) {
  const r = await withAccount(env, customerId, async (token, conn) => ({ ok: true, test: await testAccountOk(env, token, conn) }))
  return r.ok && r.test === true
}

// ---------- reading ----------

const centsFromMicros = (m) => Math.round(Number(m || 0) / 10000)
// Campaigns in the connected account with status, daily budget and last-30-day metrics, read live
// from Google. Read-only. Our own campaigns are recognised by their [gsu:<id>] name tag.
export async function readCampaigns(env, customerId) {
  return withAccount(env, customerId, async (token, conn) => {
    const query =
      "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING LAST_30_DAYS"
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:searchStream`, { body: { query }, loginCustomerId: login(conn) })
    if (!r.ok) return r
    const byId = new Map()
    for (const batch of Array.isArray(r.data) ? r.data : [r.data]) {
      for (const x of batch?.results || []) {
        const id = String(x.campaign?.id || '')
        if (!/^\d{1,20}$/.test(id)) continue
        const m = x.metrics || {}
        const c = byId.get(id) || {
          id,
          name: String(x.campaign?.name || '').slice(0, 250),
          status: ['ENABLED', 'PAUSED'].includes(x.campaign?.status) ? x.campaign.status : 'OTHER',
          dailyBudgetCents: x.campaignBudget?.amountMicros != null ? centsFromMicros(x.campaignBudget.amountMicros) : null,
          spendMicros: 0,
          clicks: 0,
          impressions: 0,
          conversions: 0,
        }
        c.spendMicros += Number(m.costMicros || 0)
        c.clicks += Number(m.clicks || 0)
        c.impressions += Number(m.impressions || 0)
        c.conversions += Number(m.conversions || 0)
        byId.set(id, c)
      }
    }
    const campaigns = [...byId.values()].map(({ spendMicros, ...c }) => ({ ...c, spendCents: centsFromMicros(spendMicros), gsuId: c.name.match(/\[gsu:([A-Za-z0-9_-]{1,40})\]$/)?.[1] || null }))
    return { ok: true, testAccount: await testAccountOk(env, token, conn), campaigns }
  })
}

// ---------- import of the account's own campaigns (read-only) ----------

const CHANNELS = ['SEARCH', 'LOCAL_SERVICES', 'PERFORMANCE_MAX', 'DISPLAY', 'VIDEO', 'SHOPPING', 'DEMAND_GEN', 'MULTI_CHANNEL', 'HOTEL', 'SMART', 'LOCAL', 'TRAVEL']
const idList = (ids) => ids.map((x) => String(x).replace(/\D/g, '')).filter(Boolean).join(', ')
const text = (v, n = 250) => (typeof v === 'string' ? v.slice(0, n) : '')
const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
// Date-only strings from Google ("2026-11-23"); anything else → null.
const ymd = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)

// Every campaign in the connected account that is not removed, with the settings Google reports: type, status,
// serving status, budget (null when shared or unreadable), bidding, networks, dates; for Search campaigns also
// targeting (locations as geo target names when resolvable, languages, ad schedules), negative keywords, ad groups,
// keywords, responsive search ads and their final URLs, and conversion goals. Read-only (search/searchStream only).
// Detail queries are best effort: a failing one leaves `partial: true` and the campaign list still returns.
// Our own campaigns (name tag [gsu:<id>]) are reported with gsuId so the caller can leave them out.
export async function readAccountCampaigns(env, customerId, { maxDetail = 25 } = {}) {
  return withAccount(env, customerId, async (token, conn) => {
    const q = (query) => call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:searchStream`, { body: { query }, loginCustomerId: login(conn) })
    const list = await q(
      'SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.geo_target_type_setting.positive_geo_target_type, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != \'REMOVED\' ORDER BY campaign.id LIMIT 200',
    )
    if (!list.ok) return list
    const campaigns = []
    for (const x of rowsOf(list.data)) {
      const c = x.campaign || {}
      const id = String(c.id || '')
      if (!/^\d{1,20}$/.test(id)) continue
      const channel = CHANNELS.includes(c.advertisingChannelType) ? c.advertisingChannelType : 'OTHER'
      const b = x.campaignBudget || {}
      campaigns.push({
        externalId: id,
        name: text(c.name),
        gsuId: text(c.name).match(/\[gsu:([A-Za-z0-9_-]{1,40})\]$/)?.[1] || null,
        status: ['ENABLED', 'PAUSED', 'REMOVED'].includes(c.status) ? c.status : 'OTHER',
        servingStatus: typeof c.servingStatus === 'string' ? c.servingStatus.slice(0, 40) : null,
        channelType: channel,
        channelSubType: typeof c.advertisingChannelSubType === 'string' && c.advertisingChannelSubType !== 'UNSPECIFIED' ? c.advertisingChannelSubType.slice(0, 60) : null,
        bidding: typeof c.biddingStrategyType === 'string' ? c.biddingStrategyType.slice(0, 60) : null,
        // Google reports 'yyyy-MM-dd HH:mm:ss' in the account's time zone (campaign.start_date_time / end_date_time).
        startDate: ymd(String(c.startDateTime || '').slice(0, 10)),
        endDate: ymd(String(c.endDateTime || '').slice(0, 10)),
        networks: { googleSearch: c.networkSettings?.targetGoogleSearch === true, searchPartners: c.networkSettings?.targetSearchNetwork === true, display: c.networkSettings?.targetContentNetwork === true },
        geoTargetType: typeof c.geoTargetTypeSetting?.positiveGeoTargetType === 'string' ? c.geoTargetTypeSetting.positiveGeoTargetType : null,
        dailyBudgetCents: b.amountMicros != null && b.explicitlyShared !== true ? centsFromMicros(b.amountMicros) : null,
        sharedBudget: b.explicitlyShared === true,
        locations: [],
        locationIds: [],
        languages: 0,
        adSchedules: 0,
        negativeKeywords: [],
        adGroups: [],
        keywords: [],
        ads: [],
        finalUrls: [],
        conversionGoals: [],
      })
    }
    let partial = false
    // Details for the Search campaigns (the ones the owner can read like a draft), newest ids first, bounded.
    const detail = campaigns.filter((c) => c.channelType === 'SEARCH').slice(0, maxDetail)
    if (detail.length) {
      const by = new Map(detail.map((c) => [c.externalId, c]))
      const ids = idList(detail.map((c) => c.externalId))
      const [crit, groups, kws, ads, goals] = await Promise.all([
        q(`SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.keyword.text, campaign_criterion.language.language_constant FROM campaign_criterion WHERE campaign.id IN (${ids}) AND campaign_criterion.status != 'REMOVED' LIMIT 2000`),
        q(`SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id IN (${ids}) AND ad_group.status != 'REMOVED' LIMIT 500`),
        q(`SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status FROM ad_group_criterion WHERE campaign.id IN (${ids}) AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED' LIMIT 5000`),
        q(`SELECT campaign.id, ad_group.id, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.id IN (${ids}) AND ad_group_ad.status != 'REMOVED' LIMIT 500`),
        q(`SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.id IN (${ids}) LIMIT 2000`),
      ])
      const cid = (x) => String(x.campaign?.id || '')
      if (crit.ok) {
        for (const x of rowsOf(crit.data)) {
          const c = by.get(cid(x))
          const k = x.campaignCriterion || {}
          if (!c) continue
          if (k.type === 'LOCATION' && !k.negative && k.location?.geoTargetConstant) c.locationIds.push(lastId(k.location.geoTargetConstant))
          else if (k.type === 'KEYWORD' && k.negative && k.keyword?.text) c.negativeKeywords.push(text(k.keyword.text, 80).toLowerCase())
          else if (k.type === 'LANGUAGE') c.languages++
          else if (k.type === 'AD_SCHEDULE') c.adSchedules++
        }
      } else partial = true
      if (groups.ok) {
        for (const x of rowsOf(groups.data)) by.get(cid(x))?.adGroups.push({ id: String(x.adGroup?.id || ''), name: text(x.adGroup?.name, 120), status: text(x.adGroup?.status, 20) })
      } else partial = true
      if (kws.ok) {
        for (const x of rowsOf(kws.data)) {
          const c = by.get(cid(x))
          const k = x.adGroupCriterion?.keyword
          if (c && k?.text && c.keywords.length < 200) c.keywords.push({ text: text(k.text, 80).toLowerCase(), match: text(k.matchType, 12), adGroupId: String(x.adGroup?.id || '') })
        }
      } else partial = true
      if (ads.ok) {
        for (const x of rowsOf(ads.data)) {
          const c = by.get(cid(x))
          const ad = x.adGroupAd?.ad || {}
          if (!c || c.ads.length >= 20) continue
          const rsa = ad.responsiveSearchAd || {}
          c.ads.push({ id: String(ad.id || ''), type: text(ad.type, 40), status: text(x.adGroupAd?.status, 20), approval: text(x.adGroupAd?.policySummary?.approvalStatus, 30), headlines: (rsa.headlines || []).map((t) => text(t.text, 30)).filter(Boolean), descriptions: (rsa.descriptions || []).map((t) => text(t.text, 90)).filter(Boolean), finalUrls: (ad.finalUrls || []).map((u) => text(u, 500)).filter(Boolean) })
          for (const u of ad.finalUrls || []) if (typeof u === 'string' && !c.finalUrls.includes(u) && c.finalUrls.length < 10) c.finalUrls.push(u.slice(0, 500))
        }
      } else partial = true
      if (goals.ok) {
        for (const x of rowsOf(goals.data)) {
          const c = by.get(cid(x))
          const g = x.campaignConversionGoal || {}
          if (c && g.biddable !== false && c.conversionGoals.length < 20) c.conversionGoals.push({ category: text(g.category, 40), origin: text(g.origin, 40) })
        }
      } else partial = true
      // Location names (read-only constants): "Charleston, South Carolina, United States" instead of an id.
      const geoIds = [...new Set(detail.flatMap((c) => c.locationIds))].slice(0, 200)
      if (geoIds.length) {
        const geo = await q(`SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.id IN (${idList(geoIds)})`)
        if (geo.ok) {
          const names = new Map(rowsOf(geo.data).map((x) => [String(x.geoTargetConstant?.id || ''), { name: text(x.geoTargetConstant?.canonicalName || x.geoTargetConstant?.name, 120), type: text(x.geoTargetConstant?.targetType, 30) }]))
          for (const c of detail) c.locations = c.locationIds.map((id) => names.get(id) || { name: `Location ${id}`, type: '' })
        } else partial = true
      }
    }
    return { ok: true, testAccount: await testAccountOk(env, token, conn), campaigns, partial }
  })
}

// Daily Google-reported metrics for several campaigns of the connected account (by Google campaign id).
export async function fetchAccountMetrics(env, customerId, externalIds, sinceYmd, untilYmd) {
  if (!YMD.test(sinceYmd) || !YMD.test(untilYmd) || sinceYmd > untilYmd) return failure('invalid_request')
  const ids = idList(externalIds)
  if (!ids) return { ok: true, rows: [] }
  return withAccount(env, customerId, async (token, conn) => {
    const query = `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.id IN (${ids}) AND segments.date BETWEEN '${sinceYmd}' AND '${untilYmd}'`
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:searchStream`, { body: { query }, loginCustomerId: login(conn) })
    if (!r.ok) return r
    const rows = []
    for (const x of rowsOf(r.data)) {
      const date = String(x.segments?.date || '')
      const id = String(x.campaign?.id || '')
      if (!YMD.test(date) || !/^\d{1,20}$/.test(id)) continue
      const m = x.metrics || {}
      rows.push({ externalId: id, date, spendCents: centsFromMicros(m.costMicros), impressions: int(m.impressions), clicks: int(m.clicks), conversions: Number(m.conversions || 0) })
    }
    return { ok: true, rows }
  })
}

// Calls Google reports for the connected account (call_view, read-only): when, how long, answered or missed, which campaign
// and where the number was shown. The caller's area code is never selected. Setup: whether call reporting is on and how many
// phone numbers are on ads. The setup reads are best effort (null = not known).
export async function readCalls(env, customerId, sinceYmd, { limit = 1000 } = {}) {
  if (!YMD.test(sinceYmd)) return failure('invalid_request')
  return withAccount(env, customerId, async (token, conn) => {
    const q = (query) => call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:searchStream`, { body: { query }, loginCustomerId: login(conn) })
    const r = await q(`SELECT call_view.resource_name, call_view.start_call_date_time, call_view.call_duration_seconds, call_view.call_status, call_view.call_tracking_display_location, campaign.id FROM call_view WHERE call_view.start_call_date_time >= '${sinceYmd} 00:00:00' ORDER BY call_view.start_call_date_time DESC LIMIT ${Number(limit)}`)
    if (!r.ok) return r
    const [cust, onAccount, onCampaigns, onGroups] = await Promise.all([
      q('SELECT customer.time_zone, customer.call_reporting_setting.call_reporting_enabled FROM customer LIMIT 1'),
      q("SELECT customer_asset.asset FROM customer_asset WHERE customer_asset.field_type = 'CALL' AND customer_asset.status = 'ENABLED'"),
      q("SELECT campaign_asset.asset FROM campaign_asset WHERE campaign_asset.field_type = 'CALL' AND campaign_asset.status = 'ENABLED'"),
      q("SELECT ad_group_asset.asset FROM ad_group_asset WHERE ad_group_asset.field_type = 'CALL' AND ad_group_asset.status = 'ENABLED'"),
    ])
    const c = cust.ok ? rowsOf(cust.data)[0]?.customer : null
    const calls = []
    for (const x of rowsOf(r.data)) {
      const v = x.callView || {}
      const id = lastId(v.resourceName)
      if (!/^[A-Za-z0-9_~-]{1,80}$/.test(id || '') || !/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(v.startCallDateTime || '')) continue
      calls.push({
        id,
        localTime: v.startCallDateTime.slice(0, 19),
        seconds: v.callDurationSeconds == null ? null : int(v.callDurationSeconds),
        status: ['RECEIVED', 'MISSED'].includes(v.callStatus) ? v.callStatus : 'UNKNOWN',
        shownOn: ['AD', 'LANDING_PAGE'].includes(v.callTrackingDisplayLocation) ? v.callTrackingDisplayLocation : null,
        campaignExternalId: /^\d{1,20}$/.test(String(x.campaign?.id || '')) ? String(x.campaign.id) : null,
      })
    }
    return {
      ok: true,
      calls,
      accountId: String(conn.account_id),
      timeZone: text(c?.timeZone, 60) || null,
      reporting: c ? c.callReportingSetting?.callReportingEnabled === true : null,
      numbersOnAds: onAccount.ok && onCampaigns.ok && onGroups.ok ? new Set([...rowsOf(onGroups.data).map((x) => x.adGroupAsset?.asset), ...rowsOf(onAccount.data).map((x) => x.customerAsset?.asset), ...rowsOf(onCampaigns.data).map((x) => x.campaignAsset?.asset)].filter(Boolean)).size : null,
    }
  })
}

// Local Services leads Google reports for the connected account (read-only; local_services_lead is a report resource
// that returns data only when the account holds a Local Services campaign). Contact details are NOT selected.
// creation_date_time is "YYYY-MM-DD HH:MM:SS" in the account time zone; we keep it as the account's calendar instant.
const LEAD_TYPES = ['BOOKING', 'COUPON', 'MESSAGE', 'PHONE_CALL']
const LEAD_STATUSES = ['NEW', 'ACTIVE', 'BOOKED', 'DECLINED', 'CONSUMER_DECLINED', 'EXPIRED', 'DISABLED', 'WIPED_OUT']
export async function readLocalServicesLeads(env, customerId, sinceYmd, { limit = 500 } = {}) {
  if (!YMD.test(sinceYmd)) return failure('invalid_request')
  return withAccount(env, customerId, async (token, conn) => {
    const query = `SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.lead_status, local_services_lead.lead_charged, local_services_lead.credit_details.credit_state, local_services_lead.category_id, local_services_lead.creation_date_time, local_services_lead.campaign FROM local_services_lead WHERE local_services_lead.creation_date_time >= '${sinceYmd} 00:00:00' ORDER BY local_services_lead.creation_date_time DESC LIMIT ${Math.min(Math.max(1, limit), 1000)}`
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:searchStream`, { body: { query }, loginCustomerId: login(conn) })
    if (!r.ok) return r
    const leads = []
    for (const x of rowsOf(r.data)) {
      const l = x.localServicesLead || {}
      const id = String(l.id || '')
      const created = Date.parse(String(l.creationDateTime || '').replace(' ', 'T') + 'Z')
      if (!/^\d{1,20}$/.test(id) || !Number.isFinite(created)) continue
      leads.push({
        id,
        type: LEAD_TYPES.includes(l.leadType) ? l.leadType : 'UNKNOWN',
        status: LEAD_STATUSES.includes(l.leadStatus) ? l.leadStatus : 'UNKNOWN',
        charged: l.leadCharged === true,
        creditState: ['CREDITED', 'PENDING'].includes(l.creditDetails?.creditState) ? l.creditDetails.creditState : null,
        categoryId: text(l.categoryId, 80) || null,
        campaignExternalId: lastId(l.campaign) || null,
        createdAt: created,
      })
    }
    return { ok: true, leads }
  })
}

// ---------- launch ----------

const tagged = (campaign) => `${campaign.spec.name} [gsu:${campaign.id}]`.slice(0, 250)
const gaqlString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const lastId = (rn) => String(rn || '').split('/').pop() || null

async function findExisting(env, token, accountId, loginCustomerId, name) {
  const r = await call(env, token, 'POST', `/customers/${accountId}/googleAds:search`, {
    body: { query: `SELECT campaign.resource_name, campaign.id, campaign.status, campaign.campaign_budget FROM campaign WHERE campaign.name = ${gaqlString(name)} AND campaign.status != 'REMOVED' LIMIT 1` },
    loginCustomerId,
  })
  if (!r.ok) return r
  const c = r.data.results?.[0]?.campaign
  return { ok: true, campaign: c?.resourceName ? c : null }
}

// ZIP codes → geo target constant resource names (≤25 names per suggest call).
async function resolveZips(env, token, zips) {
  const out = []
  for (let i = 0; i < zips.length; i += 25) {
    const names = zips.slice(i, i + 25)
    const r = await call(env, token, 'POST', '/geoTargetConstants:suggest', { body: { locale: 'en', countryCode: 'US', locationNames: { names } } })
    if (!r.ok) return r
    for (const zip of names) {
      const hit = (r.data.geoTargetConstantSuggestions || []).find(
        (s) => s.searchTerm === zip && s.geoTargetConstant?.resourceName && (!s.geoTargetConstant.targetType || s.geoTargetConstant.targetType === 'Postal Code'),
      )
      if (!hit) return failure('geo_unresolved')
      out.push(hit.geoTargetConstant.resourceName)
    }
  }
  return { ok: true, geo: [...new Set(out)] }
}

// The mutateOperations for one campaign. Only the campaign gates serving and it is always PAUSED;
// child objects are ENABLED so resuming later is a single, owner-approved campaign status change.
export function buildOperations(accountId, campaign, geo) {
  const s = campaign.spec
  const g = s.google
  const name = tagged(campaign)
  const cust = `customers/${accountId}`
  const budget = `${cust}/campaignBudgets/-1`
  const camp = `${cust}/campaigns/-2`
  const adGroup = `${cust}/adGroups/-3`
  return [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${name} budget`, amountMicros: String(s.dailyBudgetCents * 10000), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: camp,
          name,
          status: 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget: budget,
          // Maximize clicks within the budget: no conversion data reaches Google yet (see docs/STATUS.md), so
          // conversion-based bidding would optimize toward nothing. Switching later is a separate owner decision.
          targetSpend: {},
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          // Local service: show to people located in (not just searching about) the target ZIP codes.
          geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        },
      },
    },
    ...geo.map((geoTargetConstant) => ({ campaignCriterionOperation: { create: { campaign: camp, location: { geoTargetConstant } } } })),
    ...g.negativeKeywords.map((text) => ({ campaignCriterionOperation: { create: { campaign: camp, negative: true, keyword: { text, matchType: 'PHRASE' } } } })),
    { adGroupOperation: { create: { resourceName: adGroup, campaign: camp, name: `${name} ad group`, status: 'ENABLED', type: 'SEARCH_STANDARD' } } },
    ...g.keywords.map((k) => ({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: k.text, matchType: k.match } } } })),
    {
      adGroupAdOperation: {
        create: {
          adGroup,
          status: 'ENABLED',
          ad: {
            finalUrls: [s.finalUrl],
            responsiveSearchAd: {
              headlines: g.headlines.map((text) => ({ text })),
              descriptions: g.descriptions.map((text) => ({ text })),
              ...(g.path1 ? { path1: g.path1 } : {}),
              ...(g.path2 ? { path2: g.path2 } : {}),
            },
          },
        },
      },
    },
  ]
}

function launchable(campaign) {
  const s = campaign?.spec
  if (typeof campaign?.id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(campaign.id)) return 'invalid_spec'
  if (s?.platform !== 'google' || !s.google || !Array.isArray(s.geo?.zips) || !s.geo.zips.length) return 'invalid_spec'
  if (!Number.isInteger(s.dailyBudgetCents) || s.dailyBudgetCents < LIMITS.minDailyBudgetCents) return 'invalid_spec'
  return null
}

const existingResult = (c, validateOnly) => ({
  ok: true,
  existing: true,
  validateOnly,
  platformCampaignId: String(c.id || lastId(c.resourceName)),
  platformIds: { campaign: c.resourceName, budget: c.campaignBudget || null },
})

// Non-spending by default (validateOnly: Google validates the whole request, creates nothing).
// With validateOnly false everything is created in one atomic mutate with the campaign PAUSED.
// A campaign already named with our id is returned instead of creating a duplicate.
export async function launchCampaign(env, customerId, campaign, { validateOnly = true } = {}) {
  const invalid = launchable(campaign)
  if (invalid) return failure(invalid)
  return withAccount(env, customerId, async (token, conn) => {
    const accountId = conn.account_id
    const loginCustomerId = login(conn)
    if (validateOnly === false) {
      const blocked = await guardServing(env, token, conn, campaign.createdAt)
      if (blocked) return blocked
    }
    const name = tagged(campaign)
    const found = await findExisting(env, token, accountId, loginCustomerId, name)
    if (!found.ok) return found
    if (found.campaign) return existingResult(found.campaign, validateOnly)
    const geo = await resolveZips(env, token, campaign.spec.geo.zips)
    if (!geo.ok) return geo
    const body = { mutateOperations: buildOperations(accountId, campaign, geo.geo), partialFailure: false, validateOnly: validateOnly !== false }
    const path = `/customers/${accountId}/googleAds:mutate`
    let r = await call(env, token, 'POST', path, { body, loginCustomerId, retry: false })
    if (!r.ok && r.retryable) {
      // The outcome may be unknown (e.g. a 5xx after commit): look again before retrying once.
      if (!body.validateOnly) {
        const again = await findExisting(env, token, accountId, loginCustomerId, name)
        if (again.ok && again.campaign) return existingResult(again.campaign, false)
      }
      await sleep(retryDelay(env))
      r = await call(env, token, 'POST', path, { body, loginCustomerId, retry: false })
    }
    if (!r.ok) return r
    if (body.validateOnly) return { ok: true, validateOnly: true, existing: false, operations: body.mutateOperations.length }
    const results = r.data.mutateOperationResponses || []
    const pick = (k) => results.find((x) => x[k]?.resourceName)?.[k].resourceName || null
    const campaignRn = pick('campaignResult')
    if (!campaignRn) return failure('invalid_request')
    return {
      ok: true,
      validateOnly: false,
      existing: false,
      platformCampaignId: lastId(campaignRn),
      platformIds: { campaign: campaignRn, budget: pick('campaignBudgetResult'), adGroup: pick('adGroupResult'), ad: pick('adGroupAdResult') },
    }
  })
}

// ---------- changes on a launched campaign ----------

const idsOf = (row) => {
  if (row?.platformIds && typeof row.platformIds === 'object') return row.platformIds
  try {
    return JSON.parse(row?.platform_ids || '{}') || {}
  } catch {
    return {}
  }
}
// Resolves the campaign/budget resource names of a row, only inside the business's own account.
function resources(conn, row, customerId) {
  if (row?.customer !== undefined && row.customer !== customerId) return null
  const ids = idsOf(row)
  const cust = `customers/${conn.account_id}/`
  // Created in another Google Ads account (the owner switched accounts): never act on this one by id.
  if (typeof ids.campaign === 'string' && !ids.campaign.startsWith(cust)) return { otherAccount: true }
  const campaignId = String(row?.platform_campaign_id || row?.platformCampaignId || lastId(ids.campaign) || '')
  if (!/^\d{1,20}$/.test(campaignId)) return null
  const budget = typeof ids.budget === 'string' && ids.budget.startsWith(`${cust}campaignBudgets/`) ? ids.budget : null
  return { campaignId, campaign: `${cust}campaigns/${campaignId}`, budget }
}

export async function setStatus(env, customerId, row, status) {
  if (!['PAUSED', 'ENABLED'].includes(status)) return failure('invalid_request')
  return withAccount(env, customerId, async (token, conn) => {
    const res = resources(conn, row, customerId)
    if (res?.otherAccount) return failure('account_changed')
    if (!res) return failure('not_launched')
    if (status === 'ENABLED') {
      const blocked = await guardServing(env, token, conn, row.created_at)
      if (blocked) return blocked
    }
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/campaigns:mutate`, {
      body: { operations: [{ update: { resourceName: res.campaign, status }, updateMask: 'status' }] },
      loginCustomerId: login(conn),
    })
    return r.ok ? { ok: true, status } : r
  })
}

// Caller enforces the owner-approved ceiling (server/ads/budget.js); this only applies the value.
export async function setDailyBudget(env, customerId, row, dailyCents) {
  if (!Number.isInteger(dailyCents) || dailyCents < LIMITS.minDailyBudgetCents) return failure('invalid_request')
  return withAccount(env, customerId, async (token, conn) => {
    const res = resources(conn, row, customerId)
    if (res?.otherAccount) return failure('account_changed')
    if (!res?.budget) return failure('not_launched')
    const blocked = await guardServing(env, token, conn, row.created_at)
    if (blocked) return blocked
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/campaignBudgets:mutate`, {
      body: { operations: [{ update: { resourceName: res.budget, amountMicros: String(dailyCents * 10000) }, updateMask: 'amountMicros' }] },
      loginCustomerId: login(conn),
    })
    return r.ok ? { ok: true, dailyBudgetCents: dailyCents } : r
  })
}

// ---------- owner-approved changes to the account's own (imported) campaigns ----------

// The campaign and budget resources of one of the account's own campaigns, read fresh (never from a stored id alone),
// with Google's current status and budget so the owner's approval covers what is actually there.
async function importedResources(env, token, conn, externalId) {
  if (!/^\d{1,20}$/.test(String(externalId || ''))) return failure('invalid_request')
  const r = await call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:search`, {
    body: { query: `SELECT campaign.resource_name, campaign.id, campaign.status, campaign.campaign_budget, campaign.advertising_channel_type, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${String(externalId).replace(/\D/g, '')} LIMIT 1` },
    loginCustomerId: login(conn),
  })
  if (!r.ok) return r
  const row = r.data.results?.[0]
  if (!row?.campaign?.resourceName) return failure('not_found')
  return { ok: true, campaign: row.campaign.resourceName, status: row.campaign.status, channel: row.campaign.advertisingChannelType, budget: row.campaignBudget?.resourceName || row.campaign.campaignBudget || null, shared: row.campaignBudget?.explicitlyShared === true, dailyBudgetCents: row.campaignBudget?.amountMicros != null ? centsFromMicros(row.campaignBudget.amountMicros) : null }
}

// Pause or enable one of the account's own campaigns. Enabling goes through the same serving guard as our own
// campaigns (live switch, or a verified test account); pausing is never blocked. Returns Google's status read back.
export async function setImportedStatus(env, customerId, externalId, status) {
  if (!['PAUSED', 'ENABLED'].includes(status)) return failure('invalid_request')
  return withAccount(env, customerId, async (token, conn) => {
    const res = await importedResources(env, token, conn, externalId)
    if (!res.ok) return res
    if (status === 'ENABLED') {
      const blocked = await guardServing(env, token, conn, 0)
      if (blocked) return blocked
    }
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/campaigns:mutate`, { body: { operations: [{ update: { resourceName: res.campaign, status }, updateMask: 'status' }] }, loginCustomerId: login(conn) })
    if (!r.ok) return r
    const back = await importedResources(env, token, conn, externalId)
    return { ok: true, status, google: back.ok ? { status: back.status, dailyBudgetCents: back.dailyBudgetCents } : null }
  })
}

// Change the daily budget of one of the account's own campaigns (its own, non-shared budget only). A raise goes
// through the serving guard; a reduction is always allowed. Returns Google's budget read back.
export async function setImportedBudget(env, customerId, externalId, dailyCents) {
  if (!Number.isInteger(dailyCents) || dailyCents < LIMITS.minDailyBudgetCents) return failure('invalid_request')
  return withAccount(env, customerId, async (token, conn) => {
    const res = await importedResources(env, token, conn, externalId)
    if (!res.ok) return res
    if (!res.budget || res.shared) return failure('shared_budget')
    if (res.dailyBudgetCents != null && dailyCents > res.dailyBudgetCents) {
      const blocked = await guardServing(env, token, conn, 0)
      if (blocked) return blocked
    }
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/campaignBudgets:mutate`, { body: { operations: [{ update: { resourceName: res.budget, amountMicros: String(dailyCents * 10000) }, updateMask: 'amountMicros' }] }, loginCustomerId: login(conn) })
    if (!r.ok) return r
    const back = await importedResources(env, token, conn, externalId)
    return { ok: true, dailyBudgetCents: dailyCents, google: back.ok ? { status: back.status, dailyBudgetCents: back.dailyBudgetCents } : null }
  })
}

// ---------- conversion tracking ----------

// Makes sure the account has GetShowUps' upload-click conversion actions (found by name; only missing ones are
// created). Returns { ok, actions: { booked, lead, completed } } with numeric ids. Google Ads API.
export async function ensureConversionActions(env, customerId) {
  return withAccount(env, customerId, async (token, conn) => {
    const names = Object.values(ACTIONS).map((a) => gaqlString(a.name)).join(', ')
    const found = await call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:search`, {
      body: { query: `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.name IN (${names})` },
      loginCustomerId: login(conn),
    })
    if (!found.ok) return found
    const ids = {}
    for (const x of found.data.results || []) {
      const kind = Object.keys(ACTIONS).find((k) => ACTIONS[k].name === x.conversionAction?.name)
      if (kind && x.conversionAction?.type === 'UPLOAD_CLICKS' && x.conversionAction.status !== 'REMOVED') ids[kind] = String(x.conversionAction.id)
    }
    const missing = Object.keys(ACTIONS).filter((k) => !ids[k])
    if (missing.length) {
      const r = await call(env, token, 'POST', `/customers/${conn.account_id}/conversionActions:mutate`, {
        body: {
          operations: missing.map((k) => ({
            create: { name: ACTIONS[k].name, type: 'UPLOAD_CLICKS', category: ACTIONS[k].category, status: 'ENABLED', primaryForGoal: ACTIONS[k].primary, countingType: 'ONE_PER_CLICK', valueSettings: { defaultValue: 0, alwaysUseDefaultValue: false } },
          })),
        },
        loginCustomerId: login(conn),
        retry: false,
      })
      if (!r.ok) return r
      ;(r.data.results || []).forEach((x, i) => (ids[missing[i]] = lastId(x.resourceName)))
    }
    return { ok: true, actions: ids }
  })
}

// Sends conversion events for one conversion action through the Data Manager API (events:ingest). Needs the
// business's Google sign-in to include the Data Manager scope; otherwise nothing is sent ('scope_missing').
// Fast-fail: all events are imported or none. Returns { ok, requestId } or a failure().
export async function ingestConversions(env, customerId, actionId, events, { validateOnly = false } = {}) {
  if (!/^\d{1,20}$/.test(String(actionId)) || !Array.isArray(events) || !events.length || events.length > 2000) return failure('invalid_request')
  const stored = await loadToken(env, 'google', customerId)
  if (!String(stored?.scope || '').split(' ').includes(DATA_MANAGER_SCOPE)) return failure('scope_missing')
  return withAccount(env, customerId, async (token, conn) => {
    const destination = {
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: conn.account_id },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: login(conn) || conn.account_id },
      productDestinationId: String(actionId),
    }
    let res
    try {
      res = await googleFetch(env, `${dataManagerBase(env)}/events:ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ destinations: [destination], events, validateOnly }),
      })
    } catch {
      return failure('transient', { retryable: true })
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok) return { ok: true, requestId: typeof data.requestId === 'string' ? data.requestId.slice(0, 120) : null }
    if (res.status === 429 || res.status >= 500) return failure(res.status === 429 ? 'quota_exhausted' : 'transient', { retryable: true, httpStatus: res.status })
    if (res.status === 401) return failure('reconnect_required', { reconnect: true, httpStatus: 401 })
    if (res.status === 403) return failure('permission_denied', { httpStatus: 403 })
    return failure('invalid_request', { httpStatus: res.status })
  })
}

// ---------- read-back verification ----------

const rowsOf = (data) => (Array.isArray(data) ? data : [data]).flatMap((b) => b?.results || [])
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// Reads one created campaign back from Google (read-only) and compares it with the approved spec:
// paused/enabled status, daily budget, Search-only network, location targeting (people in the area),
// locations, negative keywords, one ad group, keywords + match types, the responsive search ad and its
// final URL. Returns { ok, google: {status, ...}, checks: [{ name, ok }] }; no tokens or account data.
export async function verifyCampaign(env, customerId, row) {
  return withAccount(env, customerId, async (token, conn) => {
    const res = resources(conn, row, customerId)
    if (res?.otherAccount) return failure('account_changed')
    if (!res) return failure('not_launched')
    const spec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec
    const q = (query) => call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:searchStream`, { body: { query }, loginCustomerId: login(conn) })
    const id = res.campaignId
    const [c, crit, kw, ads] = await Promise.all([
      q(
        `SELECT campaign.id, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.geo_target_type_setting.positive_geo_target_type, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${id}`,
      ),
      q(`SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.keyword.text FROM campaign_criterion WHERE campaign.id = ${id}`),
      q(`SELECT ad_group.id, ad_group.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE`),
      q(`SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.id = ${id}`),
    ])
    for (const r of [c, crit, kw, ads]) if (!r.ok) return r
    const camp = rowsOf(c.data)[0]
    if (!camp) return { ok: true, found: false, google: null, checks: [{ name: 'campaign exists on Google', ok: false }] }
    const cr = rowsOf(crit.data).map((x) => x.campaignCriterion || {})
    const locations = cr.filter((x) => x.type === 'LOCATION' && !x.negative).length
    const negatives = cr.filter((x) => x.type === 'KEYWORD' && x.negative).map((x) => String(x.keyword?.text || '').toLowerCase())
    const kws = rowsOf(kw.data)
    const keywords = kws.map((x) => `${String(x.adGroupCriterion?.keyword?.text || '').toLowerCase()}|${x.adGroupCriterion?.keyword?.matchType}`)
    const adGroups = new Set([...kws, ...rowsOf(ads.data)].map((x) => String(x.adGroup?.id || '')).filter(Boolean))
    const ad = rowsOf(ads.data)[0]?.adGroupAd
    const rsa = ad?.ad?.responsiveSearchAd || {}
    const texts = (list) => (list || []).map((t) => t.text)
    const g = spec.google || {}
    const google = {
      status: camp.campaign?.status || null,
      dailyBudgetCents: camp.campaignBudget?.amountMicros != null ? centsFromMicros(camp.campaignBudget.amountMicros) : null,
      bidding: camp.campaign?.biddingStrategyType || null,
      adGroups: adGroups.size,
      keywords: keywords.length,
      negatives: negatives.length,
      locations,
      ads: rowsOf(ads.data).length,
      adReview: ad?.policySummary?.approvalStatus || null,
    }
    const checks = [
      { name: 'campaign exists on Google', ok: true },
      { name: 'status matches', ok: google.status === (row.status === 'active' ? 'ENABLED' : 'PAUSED') },
      { name: 'Search ads only', ok: camp.campaign?.advertisingChannelType === 'SEARCH' && camp.campaign?.networkSettings?.targetGoogleSearch === true && !camp.campaign?.networkSettings?.targetContentNetwork && !camp.campaign?.networkSettings?.targetSearchNetwork },
      { name: 'daily budget', ok: google.dailyBudgetCents === row.daily_budget_cents },
      { name: 'people in your area', ok: camp.campaign?.geoTargetTypeSetting?.positiveGeoTargetType === 'PRESENCE' },
      { name: 'service area', ok: locations === new Set(spec.geo?.zips || []).size },
      { name: 'excluded searches', ok: same(negatives, (g.negativeKeywords || []).map((x) => x.toLowerCase())) },
      { name: 'one ad group', ok: adGroups.size === 1 },
      { name: 'keywords', ok: same(keywords, (g.keywords || []).map((k) => `${k.text.toLowerCase()}|${k.match}`)) },
      { name: 'ad text', ok: same(texts(rsa.headlines), g.headlines || []) && same(texts(rsa.descriptions), g.descriptions || []) },
      { name: 'landing page', ok: (ad?.ad?.finalUrls || [])[0] === spec.finalUrl },
    ]
    return { ok: true, found: true, google, checks }
  })
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

// Daily rows for one campaign: money in cents of the account currency (cost_micros / 10,000, rounded).
export async function fetchDailyMetrics(env, customerId, row, sinceYmd, untilYmd) {
  if (!YMD.test(sinceYmd) || !YMD.test(untilYmd) || sinceYmd > untilYmd) return failure('invalid_request')
  return withAccount(env, customerId, async (token, conn) => {
    const res = resources(conn, row, customerId)
    if (res?.otherAccount) return failure('account_changed')
    if (!res) return failure('not_launched')
    const query = `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE campaign.id = ${res.campaignId} AND segments.date BETWEEN '${sinceYmd}' AND '${untilYmd}'`
    const r = await call(env, token, 'POST', `/customers/${conn.account_id}/googleAds:searchStream`, { body: { query }, loginCustomerId: login(conn) })
    if (!r.ok) return r
    const byDate = new Map()
    for (const batch of Array.isArray(r.data) ? r.data : [r.data]) {
      for (const x of batch?.results || []) {
        const date = String(x.segments?.date || '')
        if (!YMD.test(date)) continue
        const m = x.metrics || {}
        const d = byDate.get(date) || { date, micros: 0, impressions: 0, clicks: 0, conversions: 0 }
        d.micros += Number(m.costMicros || 0)
        d.impressions += Number(m.impressions || 0)
        d.clicks += Number(m.clicks || 0)
        d.conversions += Number(m.conversions || 0)
        byDate.set(date, d)
      }
    }
    const rows = [...byDate.values()]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ date: d.date, spendCents: Math.round(d.micros / 10000), impressions: d.impressions, clicks: d.clicks, conversions: d.conversions }))
    return { ok: true, rows }
  })
}
