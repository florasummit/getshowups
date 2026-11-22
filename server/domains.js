// Customer-owned domains for business websites.
//
// Order matters, for safety:
//   1. The owner proves control of the domain with a TXT record (_getshowups.<host> = gsu-verify=<token>).
//      Nothing is attached to hosting before this, so nobody can claim a domain they don't control.
//   2. We attach the hostname to our hosting (Cloudflare Pages custom domain API). Until the owner
//      points the CNAME at us, their existing website keeps working: no interruption before cutover.
//   3. The owner points the hostname (CNAME) at us; the certificate is issued; we confirm over HTTPS
//      that the hostname really serves this business's site before saying "connected".
// hostname is globally unique (one business per address). Apex domains outside our DNS can't be
// pointed with a CNAME, so we connect www and the owner forwards the bare domain at their registrar.
// Never touches the customer's DNS, email (MX) records, or anything else at their provider.
import { CUSTOMER_RE } from './invites.js'

const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/
const mock = (o) => (typeof o === 'string' && MOCK_RE.test(o) ? o : null)
const TIMEOUT = 8000
const DAY = 24 * 60 * 60 * 1000

export const cnameTarget = (env) => env.SITE_CNAME_TARGET || 'getshowups.pages.dev'
export const txtName = (hostname) => `_getshowups.${hostname}`
export const txtValue = (token) => `gsu-verify=${token}`

// The DNS zone the owner manages (poolthru.com for www.poolthru.com; example.co.uk for www.example.co.uk). DNS
// providers (Squarespace, GoDaddy, Namecheap, …) want the Host relative to it and append ".<zone>" themselves: typing the
// full name there produces _getshowups.www.poolthru.com.poolthru.com.
export function zoneOf(hostname) {
  const labels = String(hostname).split('.')
  return labels.slice(SECOND_LEVEL.has(labels.slice(-2).join('.')) ? -3 : -2).join('.')
}
export const relativeHost = (name, zone) => (name === zone ? '@' : name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name)
// Where a record lands when a provider appends the zone (or the hostname) to a full name typed into Host.
const doubledNames = (name, hostname) => [...new Set([`${name}.${zoneOf(hostname)}`, `${name}.${hostname}`])]

// Our own addresses (and the hosting platform's) can never be claimed by a business.
const RESERVED = [/(^|\.)getshowups\.com$/, /\.pages\.dev$/, /\.workers\.dev$/, /^localhost$/, /(^|\.)cloudflare\.com$/]
// Common two-part public suffixes, so example.co.uk counts as an apex domain.
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx', 'co.za', 'co.in', 'co.jp', 'com.sg'])

// Returns [error, { hostname, apex }].
export function normalizeHostname(input) {
  let s = String(input ?? '').trim().toLowerCase()
  if (!s || s.length > 300) return ['invalid_domain']
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '')
  if (s.includes('@')) return ['invalid_domain']
  try {
    s = new URL(`http://${s}`).hostname // IDN → punycode
  } catch {
    return ['invalid_domain']
  }
  const labels = s.split('.')
  if (s.length > 253 || labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return ['invalid_domain']
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1))) return ['invalid_domain']
  if (RESERVED.some((re) => re.test(s))) return ['reserved_domain']
  const suffix2 = labels.slice(-2).join('.')
  const apex = labels.length === 2 || (labels.length === 3 && SECOND_LEVEL.has(suffix2))
  return [null, { hostname: s, apex }]
}

// ---------- DNS (read-only, DNS-over-HTTPS) ----------
// DNS over HTTPS (JSON): Cloudflare's resolver (the one we always used) and Google's as a second opinion. The two
// disagree when a record was changed and one resolver still caches the old answer (seen live on www.poolthru.com,
// 2026-11-22: Cloudflare kept answering the old Squarespace target for days while Google and the authoritative
// servers answered ours), or when a provider publishes two conflicting records. Both resolvers are public data.
const TYPE_CODE = { TXT: 16, CNAME: 5, A: 1, NS: 2 }
async function resolverLookup(env, resolver, name, type) {
  const m = mock(env.DNS_API_MOCK_ORIGIN)
  const base = resolver === 'google' ? (m ? `${m}/resolve` : 'https://dns.google/resolve') : m ? `${m}/dns-query` : 'https://cloudflare-dns.com/dns-query'
  try {
    const res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return { ok: false }
    const body = await res.json()
    const answers = (body.Answer || []).filter((a) => a.type === TYPE_CODE[type])
    return { ok: true, values: answers.map((a) => String(a.data).replace(/^"|"$/g, '').replace(/"\s*"/g, '').replace(/\.$/, '').toLowerCase()) }
  } catch {
    return { ok: false }
  }
}
// The lookup every check used so far (Cloudflare's resolver); unchanged behaviour for TXT proof and record diagnosis.
const dnsLookup = (env, name, type) => resolverLookup(env, 'cloudflare', name, type)
// Both resolvers at once. → { cloudflare, google, any(value), all(value), split(value) }
export async function dnsViews(env, name, type) {
  const [cloudflare, google] = await Promise.all([resolverLookup(env, 'cloudflare', name, type), resolverLookup(env, 'google', name, type)])
  const has = (r, v) => Boolean(r.ok && r.values.includes(v))
  return { cloudflare, google, any: (v) => has(cloudflare, v) || has(google, v), all: (v) => has(cloudflare, v) && has(google, v), split: (v) => has(cloudflare, v) !== has(google, v) && cloudflare.ok && google.ok }
}

// Where the zone's nameservers are, so instructions can name the DNS provider (public data; only well-known hosts).
const NS_PROVIDERS = [
  ['squarespace', 'Squarespace Domains', /googledomains\.com$|squarespacedns\.com$|(^|\.)squarespace\.com$/],
  ['cloudflare', 'Cloudflare', /ns\.cloudflare\.com$/],
  ['godaddy', 'GoDaddy', /domaincontrol\.com$/],
  ['namecheap', 'Namecheap', /registrar-servers\.com$/],
  ['wix', 'Wix', /wixdns\.net$/],
  ['google_cloud', 'Google Cloud DNS', /googledomains\.com$|google\.com$/],
  ['route53', 'Amazon Route 53', /awsdns/],
  ['hover', 'Hover', /hover\.com$/],
  ['ionos', 'IONOS', /ui-dns\./],
  ['bluehost', 'Bluehost', /bluehost\.com$/],
  ['hostgator', 'HostGator', /hostgator\.com$/],
]
export function nsProviderOf(nameservers = []) {
  for (const ns of nameservers) {
    const hit = NS_PROVIDERS.find(([, , re]) => re.test(String(ns).toLowerCase()))
    if (hit) return { id: hit[0], name: hit[1] }
  }
  return nameservers.length ? { id: 'other', name: null } : null
}
export async function zoneProvider(env, hostname) {
  const ns = await dnsLookup(env, zoneOf(hostname), 'NS')
  return ns.ok ? nsProviderOf(ns.values) : null
}

// Root (apex) domain of a www hostname: where it points and whether it forwards to the canonical www address. The apex
// is never attached here (apex CNAME/ALIAS and HTTPS forwarding depend on the DNS provider); this only tells the owner,
// honestly, what visitors who type the bare domain get. Read-only; nothing stored; two resolvers + one HTTPS request.
//   state: 'forwards' (https://apex/… → https://www…, path kept; keepsQuery says whether ?… survives)
//          'forwards_http' (only plain http forwards; https fails: no certificate at the forwarding service)
//          'points_here' (CNAME/ALIAS to our target: hosting would need the apex attached too; not supported yet)
//          'other' (serves something else) · 'none' (no records) · 'unreachable' (lookup failed)
export const APEX_PROBE_PATH = '/.well-known/getshowups-apex'
export async function apexStatus(env, hostname, { fetchFn = globalThis.fetch } = {}) {
  if (!hostname.startsWith('www.')) return null
  const apex = hostname.slice(4)
  const canonical = `https://${hostname}`
  const [a, cname] = await Promise.all([dnsViews(env, apex, 'A'), dnsViews(env, apex, 'CNAME')])
  const records = { a: [...new Set([...(a.cloudflare.values || []), ...(a.google.values || [])])], cname: [...new Set([...(cname.cloudflare.values || []), ...(cname.google.values || [])])] }
  if (!a.cloudflare.ok && !a.google.ok) return { apex, canonical, state: 'unreachable', records, keepsPath: null, keepsQuery: null }
  if (records.cname.includes(cnameTarget(env))) return { apex, canonical, state: 'points_here', records, keepsPath: null, keepsQuery: null }
  if (!records.a.length && !records.cname.length) return { apex, canonical, state: 'none', records, keepsPath: null, keepsQuery: null }
  const m = mock(env.DNS_API_MOCK_ORIGIN)
  const probe = async (scheme) => {
    try {
      const url = m ? `${m}/__apex/${scheme}/${apex}${APEX_PROBE_PATH}?gsu=1` : `${scheme}://${apex}${APEX_PROBE_PATH}?gsu=1`
      const res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      const loc = res.headers.get('location') || ''
      if (![301, 302, 307, 308].includes(res.status) || !loc) return { ok: true, forwards: false, status: res.status }
      let to
      try {
        to = new URL(loc, `${scheme}://${apex}/`)
      } catch {
        return { ok: true, forwards: false, status: res.status }
      }
      const toCanonical = to.origin === canonical
      return { ok: true, forwards: toCanonical, permanent: res.status === 301 || res.status === 308, keepsPath: toCanonical && to.pathname === APEX_PROBE_PATH, keepsQuery: toCanonical && to.searchParams.get('gsu') === '1', target: to.origin }
    } catch {
      return { ok: false }
    }
  }
  const https = await probe('https')
  if (https.ok && https.forwards) return { apex, canonical, state: 'forwards', permanent: https.permanent, keepsPath: https.keepsPath, keepsQuery: https.keepsQuery, records }
  const http = await probe('http')
  if (http.ok && http.forwards) return { apex, canonical, state: 'forwards_http', permanent: http.permanent, keepsPath: http.keepsPath, keepsQuery: http.keepsQuery, records }
  return { apex, canonical, state: 'other', target: https.target || http.target || null, records, keepsPath: null, keepsQuery: null }
}

// Which website platform a hostname's CNAME currently points at, so the owner is told to CHANGE that existing record
// (providers allow one www record) instead of adding a second one. Only well-known targets are named; anything else is
// shown as the raw target. Public DNS data only.
const PLATFORMS = [
  ['squarespace', 'Squarespace', /(^|\.)squarespace\.com$/],
  ['wix', 'Wix', /(^|\.)wixdns\.net$|(^|\.)wix\.com$/],
  ['shopify', 'Shopify', /(^|\.)myshopify\.com$|(^|\.)shopify\.com$/],
  ['godaddy', 'GoDaddy', /(^|\.)secureserver\.net$|(^|\.)godaddysites\.com$/],
  ['wordpress', 'WordPress.com', /(^|\.)wordpress\.com$|(^|\.)wp\.com$/],
  ['weebly', 'Weebly', /(^|\.)weebly\.com$/],
]
export function platformOf(target) {
  const t = String(target || '').toLowerCase()
  const hit = PLATFORMS.find(([, , re]) => re.test(t))
  return hit ? { id: hit[0], name: hit[1] } : null
}
// What the hostname points to right now (CNAME), read-only. null when unknown (lookup failed); target null = no CNAME.
export async function currentPointer(env, hostname) {
  const c = await dnsLookup(env, hostname, 'CNAME')
  if (!c.ok) return null
  const target = c.values[0] || null
  return { target, ours: target === cnameTarget(env), platform: platformOf(target) }
}

// ---------- hosting provider (Cloudflare Pages custom domains) ----------
export const providerConfigured = (env) => Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_PAGES_PROJECT)
async function provider(env, method, hostname) {
  const base = mock(env.CLOUDFLARE_API_MOCK_ORIGIN) || 'https://api.cloudflare.com'
  const root = `${base}/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/pages/projects/${encodeURIComponent(env.CF_PAGES_PROJECT)}/domains`
  try {
    const res = await fetch(method === 'POST' ? root : `${root}/${encodeURIComponent(hostname)}`, {
      method,
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ name: hostname }) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, result: body.result || null }
  } catch {
    return { ok: false, status: 0, result: null }
  }
}
export async function attachDomain(env, hostname) {
  const r = await provider(env, 'POST', hostname)
  if (r.ok) return { ok: true }
  // Already in the project (e.g. a retried attach): fine if it is really there.
  const again = await provider(env, 'GET', hostname)
  return again.ok ? { ok: true } : { ok: false, error: 'provider_error' }
}
export async function providerStatus(env, hostname) {
  const r = await provider(env, 'GET', hostname)
  if (!r.ok) return { ok: false, missing: r.status === 404 }
  return { ok: true, status: r.result?.status, validation: r.result?.validation_data?.status, verification: r.result?.verification_data?.status }
}
export async function detachDomain(env, hostname) {
  const r = await provider(env, 'DELETE', hostname)
  return r.ok || r.status === 404 ? { ok: true } : { ok: false, error: 'provider_error' }
}

// ---------- records ----------
const view = (env, r) =>
  r && {
    hostname: r.hostname,
    status: r.status,
    detail: r.detail,
    // Step 1 asks only for the TXT record. The CNAME (which moves the address to us) is shown only once
    // hosting is ready for it, so an existing website is never interrupted early.
    step: !r.verified_at ? 'verify' : !r.attached_at ? 'activate' : 'point',
    // name: the full DNS name; host: what to type in the provider's Host/Name field (relative to zone).
    records: (!r.verified_at
      ? [{ type: 'TXT', name: txtName(r.hostname), value: txtValue(r.verify_token) }]
      : r.attached_at
        ? [{ type: 'CNAME', name: r.hostname, value: cnameTarget(env) }]
        : []
    ).map((x) => ({ ...x, host: relativeHost(x.name, zoneOf(r.hostname)), zone: zoneOf(r.hostname) })),
    verifiedAt: r.verified_at,
    connectedAt: r.connected_at,
    checkedAt: r.checked_at,
    url: r.status === 'connected' ? `https://${r.hostname}` : null,
    apexName: r.hostname.startsWith('www.') ? r.hostname.slice(4) : null,
  }

export async function domainFor(env, customerId) {
  const r = await env.ONBOARDING_DB.prepare("SELECT * FROM website_domains WHERE customer = ?1 AND status <> 'removed' ORDER BY created_at DESC LIMIT 1").bind(customerId).first()
  return view(env, r)
}

// Public routing: which business serves this hostname (only once ownership is proven and attached).
export async function customerForHost(db, hostname) {
  const r = await db.prepare("SELECT customer, verify_token, status FROM website_domains WHERE hostname = ?1 AND status IN ('securing', 'connected', 'needs_attention') AND attached_at IS NOT NULL").bind(hostname).first()
  return r && CUSTOMER_RE.test(r.customer) ? r : null
}

export async function connectedHost(db, customerId) {
  const r = await db.prepare("SELECT hostname FROM website_domains WHERE customer = ?1 AND status = 'connected'").bind(customerId).first()
  return r?.hostname || null
}

// A business that disconnects and reconnects the same hostname keeps its verification value for this long, so the TXT
// record it already added keeps working. Ownership itself is never carried over: verified_at/attached_at are reset and
// the record must be found again. Another business always gets a new random value (an old record proves nothing for it).
export const TOKEN_REUSE_MS = 30 * DAY

export async function claimDomain(env, customerId, input, now = Date.now()) {
  const [error, parsed] = normalizeHostname(input)
  if (error) return { ok: false, error }
  if (parsed.apex) return { ok: false, error: 'apex_domain', suggestion: `www.${parsed.hostname}` }
  const db = env.ONBOARDING_DB
  const mine = await db.prepare("SELECT hostname FROM website_domains WHERE customer = ?1 AND status <> 'removed'").bind(customerId).first()
  if (mine && mine.hostname !== parsed.hostname) return { ok: false, error: 'already_has_domain' }
  if (mine) return { ok: true, domain: await domainFor(env, customerId) }
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  // One atomic statement: insert, or take over a removed row. An active claim (any business) is never changed, and a
  // business never ends up with two active domains even when requests race.
  const row = await db
    .prepare(
      `INSERT INTO website_domains (hostname, customer, verify_token, status, created_at, updated_at)
         SELECT ?1, ?2, ?3, 'pending', ?4, ?4
          WHERE NOT EXISTS (SELECT 1 FROM website_domains o WHERE o.customer = ?2 AND o.status <> 'removed' AND o.hostname <> ?1)
       ON CONFLICT(hostname) DO UPDATE SET
         verify_token = CASE WHEN website_domains.customer = ?2 AND website_domains.updated_at >= ?5 THEN website_domains.verify_token ELSE ?3 END,
         customer = ?2, status = 'pending', detail = NULL, verified_at = NULL,
         attached_at = NULL, connected_at = NULL, checked_at = NULL, created_at = ?4, updated_at = ?4
       WHERE website_domains.status = 'removed'
       RETURNING hostname`,
    )
    .bind(parsed.hostname, customerId, token, now, now - TOKEN_REUSE_MS)
    .first()
  if (!row) {
    // Lost a race or refused: say why, from what is stored now.
    const cur = await db.prepare("SELECT hostname, customer FROM website_domains WHERE (hostname = ?1 OR customer = ?2) AND status <> 'removed'").bind(parsed.hostname, customerId).all()
    if (cur.results.some((r) => r.hostname === parsed.hostname && r.customer === customerId)) return { ok: true, domain: await domainFor(env, customerId) }
    return { ok: false, error: cur.results.some((r) => r.customer === customerId) ? 'already_has_domain' : 'domain_in_use' }
  }
  return { ok: true, domain: await domainFor(env, customerId) }
}

const set = (db, hostname, fields, now) => {
  const keys = Object.keys(fields)
  return db
    .prepare(`UPDATE website_domains SET ${keys.map((k, i) => `${k} = ?${i + 3}`).join(', ')}, checked_at = ?2, updated_at = ?2 WHERE hostname = ?1`)
    .bind(hostname, now, ...keys.map((k) => fields[k]))
    .run()
}

// One verification pass. Safe to repeat; each step only moves forward when it is proven.
export async function checkDomain(env, hostname, { now = Date.now(), probe = probeSite } = {}) {
  const db = env.ONBOARDING_DB
  const r = await db.prepare("SELECT * FROM website_domains WHERE hostname = ?1 AND status <> 'removed'").bind(hostname).first()
  if (!r) return null

  if (!r.verified_at) {
    const txt = await dnsLookup(env, txtName(hostname), 'TXT')
    if (!txt.ok) {
      await set(db, hostname, { detail: 'dns_unreachable' }, now)
      return r.status
    }
    if (!txt.values.includes(txtValue(r.verify_token))) {
      // Tell the owner what is wrong, not just "waiting": a different verification value at the right name, or our
      // record at a doubled name (the provider appended the domain to a full name typed into Host).
      let detail = txt.values.some((v) => v.startsWith('gsu-verify=')) ? 'wrong_value' : null
      if (!detail) {
        for (const name of doubledNames(txtName(hostname), hostname)) {
          const d = await dnsLookup(env, name, 'TXT')
          if (d.ok && d.values.includes(txtValue(r.verify_token))) {
            detail = 'record_doubled'
            break
          }
        }
      }
      const stale = now - r.created_at > 14 * DAY
      await set(db, hostname, { status: stale ? 'needs_attention' : 'pending', detail: detail || (stale ? 'not_verified' : 'waiting_for_record') }, now)
      return stale ? 'needs_attention' : 'pending'
    }
    await set(db, hostname, { verified_at: now, status: 'verifying', detail: null }, now)
    r.verified_at = now
  }

  if (!r.attached_at) {
    if (!providerConfigured(env)) {
      await set(db, hostname, { status: 'verifying', detail: 'activation_pending' }, now)
      return 'verifying'
    }
    const a = await attachDomain(env, hostname)
    if (!a.ok) {
      await set(db, hostname, { status: 'verifying', detail: 'provider_error' }, now)
      return 'verifying'
    }
    await set(db, hostname, { attached_at: now, status: 'securing', detail: 'waiting_for_cname' }, now)
  }

  const views = await dnsViews(env, hostname, 'CNAME')
  const target = cnameTarget(env)
  const pointed = views.any(target)
  const split = pointed && views.split(target) // one public resolver still answers the old record
  const p = providerConfigured(env) ? await providerStatus(env, hostname) : { ok: false }
  const active = p.ok && p.status === 'active'
  if (p.ok && ['blocked', 'error'].includes(p.status)) {
    await set(db, hostname, { status: 'needs_attention', detail: 'provider_error' }, now)
    return 'needs_attention'
  }
  // Connected = DNS points at us, hosting reports the domain active with its certificate validated, and
  // (when reachable from our servers) an HTTPS request returns this business's site check.
  const certified = p.ok && p.validation === 'active' && p.verification === 'active'
  if (pointed && active && ((await probe(hostname, r.verify_token)) || certified)) {
    await set(db, hostname, { status: 'connected', detail: split ? 'dns_inconsistent' : null, connected_at: r.connected_at || now }, now)
    return 'connected'
  }
  // Was connected, now isn't: say so (the site keeps serving wherever DNS still reaches us).
  if (r.status === 'connected' || r.status === 'needs_attention') {
    await set(db, hostname, { status: 'needs_attention', detail: pointed ? 'certificate_pending' : 'dns_changed' }, now)
    return 'needs_attention'
  }
  // Not pointed yet: same doubled-Host mistake for the CNAME? Pointed at one resolver only: the change is propagating.
  let detail = pointed ? (split ? 'propagating' : 'certificate_pending') : 'waiting_for_cname'
  if (!pointed) {
    for (const name of doubledNames(hostname, hostname)) {
      const d = await dnsLookup(env, name, 'CNAME')
      if (d.ok && d.values.includes(cnameTarget(env))) {
        detail = 'cname_doubled'
        break
      }
    }
  }
  await set(db, hostname, { status: 'securing', detail }, now)
  return 'securing'
}

// Confirms over HTTPS that the hostname serves this business (middleware answers the check path).
export async function probeSite(hostname, token) {
  try {
    const res = await fetch(`https://${hostname}/.well-known/getshowups-site`, { signal: AbortSignal.timeout(TIMEOUT), redirect: 'manual' })
    return res.ok && (await res.text()).trim() === token.slice(0, 12)
  } catch {
    return false
  }
}

// Owner disconnects: removed from hosting first (so the hostname stops serving), content untouched.
export async function disconnectDomain(env, customerId, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const r = await db.prepare("SELECT * FROM website_domains WHERE customer = ?1 AND status <> 'removed'").bind(customerId).first()
  if (!r) return { ok: false, error: 'not_found' }
  if (r.attached_at) {
    if (!providerConfigured(env)) return { ok: false, error: 'provider_unavailable' }
    const d = await detachDomain(env, r.hostname)
    if (!d.ok) return { ok: false, error: d.error }
  }
  await db.prepare("UPDATE website_domains SET status = 'removed', detail = NULL, attached_at = NULL, updated_at = ?2 WHERE hostname = ?1").bind(r.hostname, now).run()
  return { ok: true }
}

// Cron: a few due checks per run (bounded network work). In-progress domains every 10 minutes,
// connected domains daily.
export async function checkDueDomains(env, { now = Date.now(), limit = 10, probe } = {}) {
  const { results } = await env.ONBOARDING_DB.prepare(
    `SELECT hostname FROM website_domains
      WHERE (status IN ('pending', 'verifying', 'securing') AND coalesce(checked_at, 0) < ?1)
         OR (status IN ('connected', 'needs_attention') AND coalesce(checked_at, 0) < ?2)
      ORDER BY coalesce(checked_at, 0) LIMIT ?3`,
  )
    .bind(now - 10 * 60 * 1000, now - DAY, limit)
    .all()
  const counts = {}
  for (const { hostname } of results) {
    const s = await checkDomain(env, hostname, { now, probe })
    counts[s] = (counts[s] || 0) + 1
  }
  return counts
}
