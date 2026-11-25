// ChatGPT Ads (OpenAI Ads API) adapter: connect with the advertiser's own API key, location lookup, a chat-card
// campaign (campaign → ad group → ad, ALL created PAUSED), read-back verification, pause/resume, daily budget and
// daily insights. The third adapter behind campaigns.js adapter(); budgets, approvals, holds, attribution and
// results are the shared engine's, never re-implemented here.
//
// Verified on developers.openai.com/ads (API reference + openapi.json v2.3.0, read 2026-11-24):
//   - Base https://api.ads.openai.com/v1; `Authorization: Bearer <Ads API key>`; "Each Ads API key is scoped to one ad
//     account" (created in Ads Manager → Settings). Partner OAuth (AdsOAuth) exists but its client registration is not
//     public, so v1 stores the advertiser's key (encrypted, KV ads:openai:<business>), like the other ads tokens.
//   - GET /ad_account → id, name, status, timezone, currency_code, review (the read-only key check).
//   - POST /campaigns {name, status active|paused, budget {daily_spend_limit_micros ≥ 1,000,000}, bidding_type
//     impressions|clicks|conversions, targeting {locations {countries, include[{id}]}}, landing_page_configuration
//     {query_string_template}}; POST /ad_groups {campaign_id, name, status, context_hints[], bidding_config
//     {billing_event_type}}; POST /ads {ad_group_id, name, status, creative {type chat_card, title 3–50, body ≤100,
//     target_url}}. Every create takes an Idempotency-Key ("the existing object is returned instead of creating a
//     duplicate"), so a retried launch never duplicates anything. POST /campaigns/{id}/pause|activate.
//     "A campaign pause prevents its child ads from serving."
//   - GET /geo_lookup/search?q= → market (metro) and region ids. Location targeting is country / region / market
//     ONLY: there is no ZIP, radius or city targeting. Owners are told (the ad reaches the whole area).
//   - GET /campaigns/{id}/insights?time_granularity=daily&time_ranges[]={"type":"date_range",...} → rows with
//     readable_time, impressions, clicks, spend (major units), conversions.
//   - No sandbox or test ad account exists: every created object is real (paused). Creating an ad submits it for review.
// UNVERIFIED until a real ad account is connected (docs/OPENAI_ADS.md lists the check):
//   - the exact error body shape (codes are mapped from HTTP status only, provider text is never passed through);
//   - readable_time's format for daily rows (YYYY-MM-DD is taken from it, else the row is skipped);
//   - whether paused objects can be created before a payment method is added.
import { failure, getConnection, loadToken, markReconnect, saveToken, upsertConnection } from './connections.js'

export const OPENAI_ADS_BASE = 'https://api.ads.openai.com/v1'
// Off unless exactly 'true' (approval). Off: routes 404, drafts refused, the adapter is unavailable.
export const openaiAdsEnabled = (env) => env?.OPENAI_ADS_ENABLED === 'true'
// Paused-only verification (approval): these businesses may CREATE paused objects in their real ChatGPT Ads account
// without ADS_LIVE_LAUNCH, to prove the integration end to end. Starting, resuming or raising a budget still needs the
// live switch. There is no OpenAI sandbox, so this is the only no-spend path.
export const verifyBusinesses = (env) =>
  String(env?.OPENAI_ADS_VERIFY_BUSINESSES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
const mockOrigin = (env) => {
  const o = env?.OPENAI_ADS_API_MOCK_ORIGIN
  return typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
}
export const openaiBase = (env) => (mockOrigin(env) ? `${mockOrigin(env)}/openai-ads/v1` : OPENAI_ADS_BASE)

export const LIMITS = { title: [3, 50], body: 100, contextHints: 10, contextHint: 200, locations: 25 }
export const KEY_RE = /^[A-Za-z0-9_.:-]{20,300}$/
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const MICROS = 10_000 // 1 cent = 10,000 micros

// HTTP status → allowlisted code. Provider messages can echo account data and are never passed through.
export function mapError(httpStatus) {
  if (httpStatus === 401) return failure('reconnect_required', { httpStatus, reconnect: true })
  if (httpStatus === 403) return failure('permission_denied', { httpStatus })
  if (httpStatus === 404) return { ...failure('not_found', { httpStatus }), notFound: true }
  if (httpStatus === 409) return failure('conflict', { httpStatus })
  if (httpStatus === 429) return failure('rate_limited', { httpStatus, retryable: true })
  if (httpStatus >= 500 || httpStatus === 0) return failure('transient', { httpStatus, retryable: true })
  return failure('invalid_request', { httpStatus })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One call with an 8 s timeout. GETs retry once on retryable errors; writes only carry an Idempotency-Key and are
// retried by the next launch (same key → the same object), never blindly here.
async function api(env, method, path, { key, body, query, idem } = {}) {
  const attempt = async () => {
    const url = new URL(`${openaiBase(env)}${path}`)
    for (const [k, v] of Object.entries(query || {})) for (const x of [].concat(v)) url.searchParams.append(k, typeof x === 'object' ? JSON.stringify(x) : String(x))
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idem ? { 'Idempotency-Key': idem } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      })
    } catch {
      return failure('transient', { retryable: true })
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return mapError(res.status)
    return { ok: true, data }
  }
  let r = await attempt()
  if (!r.ok && r.retryable && method === 'GET') {
    await sleep(Number(env?.OPENAI_ADS_RETRY_DELAY_MS ?? 400 + Math.random() * 600))
    r = await attempt()
  }
  return r
}

// ---------- connection (the advertiser's own key) ----------

const accountView = (a) => ({ id: String(a?.id ?? ''), name: String(a?.name ?? a?.account_name ?? '').slice(0, 120), currency: String(a?.currency_code ?? '').slice(0, 8), status: String(a?.status ?? '').slice(0, 40), timezone: String(a?.timezone ?? '').slice(0, 64) })

// Validates the key with a read-only call BEFORE anything is stored; an invalid key is never saved. Stores the key
// encrypted (KV) and only non-secret account facts in ad_connections. Returns the account, never the key.
export async function connectWithKey(env, customerId, apiKey, now = Date.now()) {
  const key = String(apiKey ?? '').trim()
  if (!KEY_RE.test(key)) return failure('invalid_key_format')
  const r = await api(env, 'GET', '/ad_account', { key })
  if (!r.ok) return r.error === 'reconnect_required' ? failure('invalid_key', { httpStatus: 401 }) : r
  const account = accountView(r.data)
  if (!ID_RE.test(account.id)) return failure('invalid_request')
  const prior = await getConnection(env, customerId, 'openai')
  // A different ad account than before: campaigns created in the old one are never acted on through the new key.
  const accountChanged = Boolean(prior?.account_id && prior.account_id !== account.id)
  await saveToken(env, 'openai', customerId, { apiKey: key, last4: key.slice(-4), accountId: account.id })
  await upsertConnection(env, customerId, 'openai', { accountId: account.id, accountName: account.name, currency: account.currency, extra: { last4: key.slice(-4), timezone: account.timezone, accountStatus: account.status, connectedAt: now }, status: 'connected' }, now)
  return { ok: true, account, last4: key.slice(-4), accountChanged }
}

async function withKey(env, customerId, fn, { accountId } = {}) {
  const conn = await getConnection(env, customerId, 'openai')
  if (!conn) return failure('not_connected')
  if (conn.status === 'reconnect_required') return failure('reconnect_required', { reconnect: true })
  const t = await loadToken(env, 'openai', customerId)
  if (!t?.apiKey) return failure('reconnect_required', { reconnect: true })
  // Every key belongs to exactly one ad account: an object created under another account is never touched.
  if (accountId && t.accountId !== accountId) return failure('account_changed')
  const r = await fn(t.apiKey, conn)
  if (!r.ok && r.reconnect) await markReconnect(env, customerId, 'openai')
  return r
}

// Owner location search (markets = metro areas, regions = states). Read-only, through the business's own key.
export async function searchLocations(env, customerId, q) {
  const query = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (query.length < 2) return failure('invalid_request')
  return withKey(env, customerId, async (key) => {
    const r = await api(env, 'GET', '/geo_lookup/search', { key, query: { q: query, limit: 10 } })
    if (!r.ok) return r
    const results = (r.data.results || [])
      .filter((x) => ID_RE.test(String(x?.id ?? '')) && ['market', 'region', 'country'].includes(String(x?.type)))
      .map((x) => ({ id: String(x.id), name: String(x.canonical_name || x.name || '').slice(0, 120), type: String(x.type), countryCode: String(x.country_code || '').slice(0, 2) }))
    return { ok: true, results }
  })
}

export async function isSandboxAccount() {
  return false // OpenAI has no sandbox or test ad account (see header)
}

// ---------- campaign ----------

const tag = (id) => `[gsu:${id}]`
export const trackingTemplate = (campaignId) => `utm_source=openai&utm_medium=paid&utm_campaign=${campaignId}`

function checkLaunchable(campaign) {
  const s = campaign?.spec
  if (s?.platform !== 'openai' || !s.openai || !s.finalUrl) return 'invalid_spec'
  if (!Array.isArray(s.openai.locations) || !s.openai.locations.length) return 'invalid_spec'
  return null
}

// Every create payload for a spec (pure; the dry run returns exactly these). ids carries the parents once created.
export function buildPayloads(campaign, ids = {}) {
  const s = campaign.spec
  const o = s.openai
  const name = `${tag(campaign.id)} ${s.name}`.slice(0, 200)
  return {
    campaign: {
      name,
      status: 'paused',
      bidding_type: 'clicks',
      budget: { daily_spend_limit_micros: s.dailyBudgetCents * MICROS },
      targeting: { locations: { include: o.locations.map((l) => ({ id: l.id })) } },
      landing_page_configuration: { query_string_template: trackingTemplate(campaign.id) },
    },
    adGroup: {
      campaign_id: ids.campaignId || '<campaign_id>',
      name: `${tag(campaign.id)} ad group`,
      status: 'paused',
      context_hints: o.contextHints,
      bidding_config: { billing_event_type: 'click' },
    },
    ad: {
      ad_group_id: ids.adGroupId || '<ad_group_id>',
      name: `${tag(campaign.id)} ad`,
      status: 'paused',
      creative: { type: 'chat_card', title: o.title, body: o.body, target_url: s.finalUrl },
    },
  }
}

export async function launchCampaign(env, customerId, campaign, { dryRun = true } = {}) {
  const invalid = checkLaunchable(campaign)
  if (invalid) return failure(invalid)
  if (dryRun) return { ok: true, dryRun: true, payloads: buildPayloads(campaign) }
  return withKey(env, customerId, async (key, conn) => {
    const ids = { ...(campaign.platformIds || {}) }
    if (ids.accountId && ids.accountId !== conn.account_id) return { ...failure('account_changed'), platformIds: ids }
    ids.accountId = conn.account_id
    const fail = (r) => ({ ...r, platformIds: ids })
    // Same campaign + step → same Idempotency-Key: a lost response is answered with the existing object.
    const create = async (k, path, payload) => {
      if (ids[k]) return { ok: true }
      const r = await api(env, 'POST', path, { key, body: payload, idem: `gsu-${campaign.id}-${k}` })
      if (!r.ok) return r
      const id = String(r.data?.id ?? '')
      if (!ID_RE.test(id)) return failure('invalid_request')
      ids[k] = id
      // Never accept anything running: pause it at once and stop (the id is kept, so the owner sees and can remove it).
      if (r.data?.status && r.data.status !== 'paused') {
        await api(env, 'POST', `${path}/${encodeURIComponent(id)}/pause`, { key })
        return failure('not_paused')
      }
      return { ok: true }
    }
    let r = await create('campaignId', '/campaigns', buildPayloads(campaign, ids).campaign)
    if (!r.ok) return fail(r)
    r = await create('adGroupId', '/ad_groups', buildPayloads(campaign, ids).adGroup)
    if (!r.ok) return fail(r)
    r = await create('adId', '/ads', buildPayloads(campaign, ids).ad)
    if (!r.ok) return fail(r)
    return { ok: true, dryRun: false, platformCampaignId: ids.campaignId, platformIds: ids }
  })
}

const idsOf = (row) => (typeof row?.platform_ids === 'string' ? JSON.parse(row.platform_ids || '{}') : row?.platformIds || {})
// Shared status vocabulary (campaigns.js reconcile): ENABLED | PAUSED | REMOVED.
const normStatus = (s) => (s === 'active' ? 'ENABLED' : s === 'paused' ? 'PAUSED' : s === 'archived' ? 'REMOVED' : s || null)

// Reads campaign, ad group and ad back and compares them with the approved draft. Read-only.
export async function verifyCampaign(env, customerId, row) {
  const ids = idsOf(row)
  if (!ids.campaignId) return failure('not_launched')
  const spec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec
  return withKey(
    env,
    customerId,
    async (key) => {
      const camp = await api(env, 'GET', `/campaigns/${encodeURIComponent(ids.campaignId)}`, { key })
      if (!camp.ok) return camp.notFound ? { ok: true, found: false, remote: null, checks: [{ name: 'campaign exists on ChatGPT Ads', ok: false }] } : camp
      const [group, ad] = await Promise.all([
        ids.adGroupId ? api(env, 'GET', `/ad_groups/${encodeURIComponent(ids.adGroupId)}`, { key }) : Promise.resolve({ ok: true, data: null }),
        ids.adId ? api(env, 'GET', `/ads/${encodeURIComponent(ids.adId)}`, { key }) : Promise.resolve({ ok: true, data: null }),
      ])
      if (!group.ok && !group.notFound) return group
      if (!ad.ok && !ad.notFound) return ad
      const c = camp.data || {}
      const g = group.ok ? group.data : null
      const a = ad.ok ? ad.data : null
      const o = spec.openai || {}
      const remote = {
        status: normStatus(c.status),
        dailyBudgetCents: c.budget?.daily_spend_limit_micros != null ? Math.round(Number(c.budget.daily_spend_limit_micros) / MICROS) : null,
        locations: (c.targeting?.locations?.include || []).map((l) => String(l.id)),
        tracking: c.landing_page_configuration?.query_string_template ?? null,
        adGroupStatus: g ? normStatus(g.status) : null,
        adStatus: a ? normStatus(a.status) : null,
        review: a?.review_status ? String(a.review_status).slice(0, 40) : null,
        servingIssues: (Array.isArray(c.serving_issues) ? c.serving_issues : []).map((x) => String(x?.code ?? x).slice(0, 80)).slice(0, 10),
      }
      const ours = row.status === 'active' ? 'ENABLED' : 'PAUSED'
      const same = (x, y) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i])
      const checks = [
        { name: 'campaign exists on ChatGPT Ads', ok: true },
        { name: 'campaign status', ok: remote.status === ours },
        { name: 'daily budget', ok: remote.dailyBudgetCents === spec.dailyBudgetCents },
        { name: 'locations', ok: same(remote.locations, (o.locations || []).map((l) => l.id)) },
        { name: 'tracking parameters', ok: remote.tracking === trackingTemplate(row.id) },
        { name: 'ad group exists', ok: Boolean(g) },
        { name: 'context hints', ok: Boolean(g) && same((g.context_hints || []).map(String), o.contextHints || []) },
        { name: 'ad exists', ok: Boolean(a) },
        { name: 'ad text', ok: Boolean(a) && a.creative?.title === o.title && a.creative?.body === o.body },
        { name: 'landing page', ok: Boolean(a) && a.creative?.target_url === spec.finalUrl },
      ]
      return { ok: true, found: true, remote, checks }
    },
    { accountId: ids.accountId },
  )
}

// paused → campaign only ("a campaign pause prevents its child ads from serving"). active → ad, ad group, campaign.
export async function setStatus(env, customerId, row, status) {
  if (!['paused', 'active'].includes(status)) return failure('invalid_request')
  const ids = idsOf(row)
  if (!ids.campaignId) return failure('not_launched')
  const order = status === 'paused' ? [['campaigns', ids.campaignId]] : [['ads', ids.adId], ['ad_groups', ids.adGroupId], ['campaigns', ids.campaignId]].filter(([, id]) => id)
  return withKey(
    env,
    customerId,
    async (key) => {
      for (const [kind, id] of order) {
        const r = await api(env, 'POST', `/${kind}/${encodeURIComponent(id)}/${status === 'paused' ? 'pause' : 'activate'}`, { key })
        if (!r.ok) return r
      }
      return { ok: true, status }
    },
    { accountId: ids.accountId },
  )
}

export async function setDailyBudget(env, customerId, row, cents) {
  if (!Number.isInteger(cents) || cents < 100) return failure('invalid_request') // OpenAI minimum: $1.00 a day
  const ids = idsOf(row)
  if (!ids.campaignId) return failure('not_launched')
  return withKey(
    env,
    customerId,
    async (key) => {
      const r = await api(env, 'POST', `/campaigns/${encodeURIComponent(ids.campaignId)}`, { key, body: { budget: { daily_spend_limit_micros: cents * MICROS } } })
      return r.ok ? { ok: true, dailyBudgetCents: cents } : r
    },
    { accountId: ids.accountId },
  )
}

const YMD = /^\d{4}-\d{2}-\d{2}$/
export async function fetchDailyMetrics(env, customerId, row, sinceYmd, untilYmd) {
  if (!YMD.test(sinceYmd) || !YMD.test(untilYmd)) return failure('invalid_request')
  const ids = idsOf(row)
  if (!ids.campaignId) return failure('not_launched')
  return withKey(
    env,
    customerId,
    async (key, conn) => {
      const timezone = conn.extra?.timezone || 'UTC'
      const r = await api(env, 'GET', `/campaigns/${encodeURIComponent(ids.campaignId)}/insights`, {
        key,
        query: {
          aggregation_level: 'campaign',
          time_granularity: 'daily',
          'time_ranges[]': { type: 'date_range', since: sinceYmd, until: untilYmd, timezone },
          'fields[]': ['readable_time', 'impressions', 'clicks', 'spend', 'conversions'],
        },
      })
      if (!r.ok) return r
      const rows = (r.data.data || [])
        .map((d) => ({
          date: String(d.readable_time || '').slice(0, 10),
          spendCents: Math.round(Number(d.spend || 0) * 100),
          impressions: Number(d.impressions || 0),
          clicks: Number(d.clicks || 0),
          conversions: Number(d.conversions || 0),
        }))
        .filter((x) => YMD.test(x.date) && [x.spendCents, x.impressions, x.clicks, x.conversions].every(Number.isFinite))
      return { ok: true, rows }
    },
    { accountId: ids.accountId },
  )
}

// A starter draft from the business's own records (the owner edits everything before approval).
export function starterSpec({ name = '', services = [], zips = [], dailyBudgetCents = 1000 } = {}) {
  const biz = String(name).replace(/\s+/g, ' ').trim()
  const first = String(services[0] || '').replace(/\s+/g, ' ').trim()
  const fit = (t, max) => (t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, ''))
  return {
    platform: 'openai',
    name: fit(`ChatGPT · ${first || biz || 'Bookings'}`, 120),
    dailyBudgetCents,
    geo: { zips: zips.slice(0, 200) },
    openai: {
      title: fit(biz || 'Book online', LIMITS.title[1]),
      body: fit(first ? `${first}. See open times and book online.` : 'See open times and book online.', LIMITS.body),
      contextHints: [first, ...services.slice(1, 3)].filter(Boolean).map((s) => fit(String(s), LIMITS.contextHint)),
      locations: [],
    },
  }
}
