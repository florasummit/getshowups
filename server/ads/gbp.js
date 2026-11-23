// Google Business Profile for a business (docs/GOOGLE_ACQUISITION.md step D). Read and link only: GetShowUps lists
// the profiles the owner's Google account manages, the owner picks the business, and the verification state Google
// reports is shown. Nothing is created, nothing is written to the profile, and a listing is never called verified
// unless Google says so (Voice of Merchant). Verified on official pages 2026-11-23:
//   - access to the Business Profile APIs is granted by Google's application form (0 QPM until approved; no sandbox);
//     OAuth scope https://www.googleapis.com/auth/business.manage, a consent separate from Ads and Calendar;
//   - Account Management API  GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts (pageSize ≤ 20);
//   - Business Information API GET https://mybusinessbusinessinformation.googleapis.com/v1/{parent=accounts/*}/locations
//     with a required readMask, pageSize ≤ 100; Location.metadata (output only) carries hasVoiceOfMerchant, placeId,
//     mapsUri, duplicateLocation;
//   - Verifications API GET https://mybusinessverifications.googleapis.com/v1/{name=locations/*}/VoiceOfMerchantState
//     → hasVoiceOfMerchant, hasBusinessAuthority and one of waitForVoiceOfMerchant | verify{hasPendingVerification} |
//     resolveOwnershipConflict | complyWithGuidelines{recommendationReason}.
// GBP_ENABLED === 'true' is the switch (approval: a new Google scope + Google's API access). Off: the Ads tab shows a
// facts-only checklist and "not available yet". Tokens: encrypted in KV under ads:gbp:<customer> (connections.js);
// gbp_connections (migration 0037) holds names and the verification snapshot, never tokens.
import { googleFetch, refreshAccessToken } from '../google-oauth.js'
import { siteOrigin } from '../auth.js'
import { failure, loadToken } from './connections.js'

export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage'
export const GBP_STATE_COOKIE = '__Host-gsu_gbp'
export const GBP_STATE_TTL_SECONDS = 600
export const gbpEnabled = (env) => env?.GBP_ENABLED === 'true'
export const gbpRedirectUri = (env) => `${siteOrigin(env)}/api/ads/gbp/callback`
export const READ_MASK = 'name,title,storefrontAddress,websiteUri,phoneNumbers,regularHours,categories,serviceArea,metadata'
const HOSTS = { accounts: 'mybusinessaccountmanagement', info: 'mybusinessbusinessinformation', verify: 'mybusinessverifications' }
export const SETUP_URL = 'https://business.google.com/create'
export const STALE_MS = 24 * 3600_000

const mockOrigin = (env) => {
  const o = env?.GBP_API_MOCK_ORIGIN
  return typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
}
const base = (env, host) => {
  const mock = mockOrigin(env)
  return mock ? `${mock}/gbp/${HOSTS[host]}` : `https://${HOSTS[host]}.googleapis.com`
}
const text = (v, n = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const LOCATION_RE = /^locations\/\d{1,30}$/
const ACCOUNT_RE = /^accounts\/\d{1,30}$/

// Google's HTTP answers → allowlisted codes. Google's message is never passed through.
export function mapError(status) {
  if (status === 401) return failure('reconnect_required', { httpStatus: status, reconnect: true })
  if (status === 403) return failure('permission_denied', { httpStatus: status })
  if (status === 429) return failure('quota_exhausted', { httpStatus: status, retryable: true })
  if (status === 404) return failure('not_found', { httpStatus: status })
  if (status === 0 || status >= 500) return failure('transient', { httpStatus: status, retryable: true })
  return failure('invalid_request', { httpStatus: status })
}

// One GET with the owner's token (8 s timeout via googleFetch, one retry on a retryable answer). Read-only.
async function get(env, token, host, path) {
  for (let attempt = 0; ; attempt++) {
    let result
    try {
      const res = await googleFetch(env, `${base(env, host)}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
      const data = await res.json().catch(() => ({}))
      result = res.ok ? { ok: true, data } : mapError(res.status)
    } catch {
      result = failure('transient', { httpStatus: 0, retryable: true })
    }
    if (result.ok || !result.retryable || attempt >= 1) {
      if (!result.ok) console.error('Business Profile request failed:', host, path.split('?')[0].replace(/\d{4,}/g, '<id>'), result.httpStatus, result.error)
      return result
    }
  }
}

// ---------- storage (gbp_connections) ----------

const ready = new WeakSet()
export async function gbpReady(db) {
  if (!db) return false
  if (ready.has(db)) return true
  try {
    const ok = Number((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'gbp_connections'").first())?.n) === 1
    if (ok) ready.add(db)
    return ok
  } catch {
    return false
  }
}
export async function getGbp(env, customerId) {
  if (!(await gbpReady(env.ONBOARDING_DB))) return null
  const r = await env.ONBOARDING_DB.prepare('SELECT * FROM gbp_connections WHERE customer = ?1').bind(customerId).first()
  if (!r) return null
  let extra = {}
  let verification = null
  try {
    extra = JSON.parse(r.extra || '{}')
    verification = r.verification ? JSON.parse(r.verification) : null
  } catch {}
  return { ...r, extra, verification }
}
export async function upsertGbp(env, customerId, { accountName = null, locationName = null, title = null, verification = null, extra = {}, status }, now = Date.now()) {
  await env.ONBOARDING_DB.prepare(
    `INSERT INTO gbp_connections (customer, account_name, location_name, title, verification, extra, status, connected_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(customer) DO UPDATE SET account_name = ?2, location_name = ?3, title = ?4, verification = ?5, extra = ?6, status = ?7, updated_at = ?8`,
  )
    .bind(customerId, accountName, locationName, title, verification ? JSON.stringify(verification) : null, JSON.stringify(extra), status, now)
    .run()
}
export async function markGbpReconnect(env, customerId) {
  if (!(await gbpReady(env.ONBOARDING_DB))) return
  await env.ONBOARDING_DB.prepare("UPDATE gbp_connections SET status = 'reconnect_required', updated_at = ?2 WHERE customer = ?1").bind(customerId, Date.now()).run()
}

// Short-lived access token for the stored Business Profile grant. Never stored or logged.
export async function accessToken(env, customerId) {
  const tok = await loadToken(env, 'gbp', customerId)
  if (!tok?.refreshToken) {
    await markGbpReconnect(env, customerId)
    return failure('reconnect_required', { reconnect: true })
  }
  const r = await refreshAccessToken(env, tok.refreshToken)
  if (r.ok) return { ok: true, token: r.accessToken }
  if (r.error === 'invalid_grant') {
    await markGbpReconnect(env, customerId)
    return failure('reconnect_required', { httpStatus: r.httpStatus, reconnect: true })
  }
  if (r.httpStatus === 0 || r.httpStatus >= 500) return failure('transient', { httpStatus: r.httpStatus, retryable: true })
  return failure('invalid_request', { httpStatus: r.httpStatus })
}

// ---------- reading Google (token in hand) ----------

export async function listAccountsWithToken(env, token) {
  const r = await get(env, token, 'accounts', '/v1/accounts?pageSize=20')
  if (!r.ok) return r
  const accounts = (r.data.accounts || []).filter((a) => ACCOUNT_RE.test(String(a.name || ''))).map((a) => ({ name: a.name, accountName: text(a.accountName, 120), type: text(a.type, 30) }))
  return { ok: true, accounts }
}

const normalizeLocation = (l, account) => {
  const addr = l.storefrontAddress || {}
  const m = l.metadata || {}
  return {
    name: l.name,
    account,
    title: text(l.title, 160),
    locality: text(addr.locality, 80),
    region: text(addr.administrativeArea, 40),
    postalCode: text(addr.postalCode, 12),
    serviceArea: Boolean(l.serviceArea && (l.serviceArea.businessType || l.serviceArea.places)),
    website: typeof l.websiteUri === 'string' && l.websiteUri.length > 0,
    phone: typeof l.phoneNumbers?.primaryPhone === 'string' && l.phoneNumbers.primaryPhone.length > 0,
    hours: Array.isArray(l.regularHours?.periods) && l.regularHours.periods.length > 0,
    category: text(l.categories?.primaryCategory?.displayName, 80) || null,
    placeId: text(m.placeId, 120) || null,
    mapsUri: typeof m.mapsUri === 'string' && /^https:\/\/(www\.google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl)/.test(m.mapsUri) ? m.mapsUri.slice(0, 300) : null,
    hasVoiceOfMerchant: m.hasVoiceOfMerchant === true,
    duplicate: Boolean(m.duplicateLocation),
  }
}
export async function listLocationsWithToken(env, token, account) {
  if (!ACCOUNT_RE.test(String(account || ''))) return failure('invalid_request')
  const r = await get(env, token, 'info', `/v1/${account}/locations?readMask=${encodeURIComponent(READ_MASK)}&pageSize=100`)
  if (!r.ok) return r
  return { ok: true, locations: (r.data.locations || []).filter((l) => LOCATION_RE.test(String(l.name || ''))).map((l) => normalizeLocation(l, account)) }
}
// Every location the owner's Google account manages, across its first five accounts.
export async function discoverWithToken(env, token) {
  const a = await listAccountsWithToken(env, token)
  if (!a.ok) return a
  const locations = []
  let firstError = null
  for (const acc of a.accounts.slice(0, 5)) {
    const l = await listLocationsWithToken(env, token, acc.name)
    if (!l.ok) {
      firstError ||= l
      continue
    }
    for (const x of l.locations) locations.push({ ...x, accountName: acc.accountName })
  }
  if (!locations.length && firstError) return firstError
  return { ok: true, accounts: a.accounts.length, locations }
}
// Google's word on whether this listing has a verified owner, as one of a few plain states.
export async function voiceOfMerchantWithToken(env, token, locationName) {
  if (!LOCATION_RE.test(String(locationName || ''))) return failure('invalid_request')
  const r = await get(env, token, 'verify', `/v1/${locationName}/VoiceOfMerchantState`)
  if (!r.ok) return r
  const d = r.data || {}
  let state = 'unknown'
  if (d.hasVoiceOfMerchant === true) state = 'verified'
  else if (d.verify) state = d.verify.hasPendingVerification === true ? 'pending_verification' : 'needs_verification'
  else if (d.resolveOwnershipConflict) state = 'ownership_conflict'
  else if (d.complyWithGuidelines) state = d.complyWithGuidelines.recommendationReason === 'BUSINESS_LOCATION_SUSPENDED' ? 'suspended' : d.complyWithGuidelines.recommendationReason === 'BUSINESS_LOCATION_DISABLED' ? 'disabled' : 'guidelines'
  else if (d.waitForVoiceOfMerchant) state = 'waiting'
  return { ok: true, verification: { state, verified: d.hasVoiceOfMerchant === true, authority: d.hasBusinessAuthority === true, checkedAt: Date.now() } }
}

// ---------- the business's link ----------

// Lists the locations the stored grant reaches (fresh from Google) and which one is linked.
export async function listLocations(env, customerId) {
  const t = await accessToken(env, customerId)
  if (!t.ok) return t
  const d = await discoverWithToken(env, t.token)
  if (!d.ok) {
    if (d.reconnect) await markGbpReconnect(env, customerId)
    return d
  }
  return { ok: true, token: t.token, locations: d.locations, accounts: d.accounts }
}

// The owner picks one of the locations their Google account manages (validated against Google's list, never a typed
// name); its verification state is read and stored with the snapshot (never a claim beyond what Google returned).
export async function selectLocation(env, customerId, locationName, { token = null, locations = null } = {}, now = Date.now()) {
  if (!(await gbpReady(env.ONBOARDING_DB))) return failure('not_ready')
  if (!LOCATION_RE.test(String(locationName || ''))) return failure('invalid_request')
  let list = locations
  let tok = token
  if (!list) {
    const r = await listLocations(env, customerId)
    if (!r.ok) return r
    list = r.locations
    tok = r.token
  }
  const loc = list.find((l) => l.name === locationName)
  if (!loc) return failure('location_not_accessible')
  const v = await voiceOfMerchantWithToken(env, tok, loc.name)
  const verification = v.ok ? v.verification : { state: 'unknown', verified: loc.hasVoiceOfMerchant, authority: null, checkedAt: now, error: v.error }
  const { name, account, title, accountName, ...rest } = loc
  void accountName
  await upsertGbp(env, customerId, { accountName: account, locationName: name, title, verification, extra: { ...rest, choices: list.length }, status: 'connected' }, now)
  return { ok: true, location: publicLocation(loc), verification }
}

export const publicLocation = (l) => ({ name: l.name, title: l.title, place: [l.locality, l.region].filter(Boolean).join(', '), category: l.category, verified: l.hasVoiceOfMerchant, duplicate: l.duplicate })

// Re-reads the linked location's verification state when the snapshot is older than a day (best effort).
export async function refreshGbp(env, customerId, now = Date.now()) {
  const row = await getGbp(env, customerId)
  if (!row || row.status !== 'connected' || !row.location_name) return row
  if (row.verification?.checkedAt && now - row.verification.checkedAt < STALE_MS) return row
  const t = await accessToken(env, customerId)
  if (!t.ok) return getGbp(env, customerId)
  const v = await voiceOfMerchantWithToken(env, t.token, row.location_name)
  if (v.ok) await env.ONBOARDING_DB.prepare('UPDATE gbp_connections SET verification = ?2, updated_at = ?3 WHERE customer = ?1').bind(customerId, JSON.stringify(v.verification), now).run()
  else if (v.reconnect) await markGbpReconnect(env, customerId)
  return getGbp(env, customerId)
}

export const VERIFICATION_LABEL = {
  verified: 'Verified',
  pending_verification: 'Verification pending',
  needs_verification: 'Needs verification',
  ownership_conflict: 'Ownership conflict',
  suspended: 'Suspended by Google',
  disabled: 'Disabled by Google',
  guidelines: 'Needs attention on Google',
  waiting: 'Being reviewed by Google',
  unknown: 'Unknown',
}
// What the Ads tab shows. Never tokens; names, the verification snapshot and what is missing on the profile.
export async function gbpStatus(env, customerId) {
  const row = await getGbp(env, customerId)
  if (!row) return null
  const x = row.extra || {}
  const missing = row.status === 'connected' ? [...(!x.website ? ['website'] : []), ...(!x.phone ? ['phone'] : []), ...(!x.hours ? ['hours'] : []), ...(!x.category ? ['category'] : [])] : []
  return {
    status: row.status,
    title: row.title,
    place: [x.locality, x.region].filter(Boolean).join(', '),
    category: x.category || null,
    mapsUri: x.mapsUri || null,
    verification: row.verification ? { state: row.verification.state, label: VERIFICATION_LABEL[row.verification.state] || VERIFICATION_LABEL.unknown, verified: row.verification.verified === true, checkedAt: row.verification.checkedAt || null } : null,
    missing,
    choices: x.choices ?? null,
    updatedAt: row.updated_at,
  }
}
// true / false when a link exists (Google's word), null when none.
export async function gbpVerified(env, customerId) {
  const row = await getGbp(env, customerId)
  return row && row.status === 'connected' ? row.verification?.verified === true : null
}

// For a business without a linked profile: what Google needs, as facts, with Google's own setup. GetShowUps never
// creates a listing (duplicates are the owner's problem for months) and never claims verification.
export function gbpReadiness({ enabled, connected = false }) {
  return {
    canCreateHere: false,
    available: enabled,
    items: [
      { id: 'exists', label: 'Does a listing already exist?', detail: 'Search your business name on Google Maps first. If a listing is there, claim it instead of creating a second one.' },
      { id: 'eligible', label: 'Eligible: you meet customers in person or at their homes', detail: 'Service-area businesses qualify; the address can stay hidden.' },
      { id: 'account', label: 'The Google account that should own it', detail: 'Use the business’s Google account; ownership can be shared later.' },
      { id: 'create', label: 'Create or claim it with Google', detail: 'Business name, category, service area, phone and website, entered by you in Google’s own setup.' },
      { id: 'verify', label: 'Verification by Google', detail: 'Google decides the method (video, phone, postcard or email) and the timing; nobody can skip it.' },
      { id: 'connect', label: connected ? 'Linked to GetShowUps' : 'Then connect it here', detail: enabled ? 'Connect with the same Google account; GetShowUps reads the listing and its verification state.' : 'Connecting here opens once Google approves GetShowUps’ Business Profile access.' },
    ],
    setupUrl: SETUP_URL,
  }
}
