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
async function dnsLookup(env, name, type) {
  const base = mock(env.DNS_API_MOCK_ORIGIN) ? `${env.DNS_API_MOCK_ORIGIN}/dns-query` : 'https://cloudflare-dns.com/dns-query'
  try {
    const res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return { ok: false }
    const body = await res.json()
    const answers = (body.Answer || []).filter((a) => a.type === (type === 'TXT' ? 16 : 5))
    return { ok: true, values: answers.map((a) => String(a.data).replace(/^"|"$/g, '').replace(/"\s*"/g, '').replace(/\.$/, '').toLowerCase()) }
  } catch {
    return { ok: false }
  }
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
    records: !r.verified_at
      ? [{ type: 'TXT', name: txtName(r.hostname), value: txtValue(r.verify_token) }]
      : r.attached_at
        ? [{ type: 'CNAME', name: r.hostname, value: cnameTarget(env) }]
        : [],
    verifiedAt: r.verified_at,
    connectedAt: r.connected_at,
    checkedAt: r.checked_at,
    url: r.status === 'connected' ? `https://${r.hostname}` : null,
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

export async function claimDomain(env, customerId, input, now = Date.now()) {
  const [error, parsed] = normalizeHostname(input)
  if (error) return { ok: false, error }
  if (parsed.apex) return { ok: false, error: 'apex_domain', suggestion: `www.${parsed.hostname}` }
  const db = env.ONBOARDING_DB
  const mine = await db.prepare("SELECT hostname FROM website_domains WHERE customer = ?1 AND status <> 'removed'").bind(customerId).first()
  if (mine && mine.hostname !== parsed.hostname) return { ok: false, error: 'already_has_domain' }
  if (mine) return { ok: true, domain: await domainFor(env, customerId) }
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  // Insert, or take over a removed row; an active claim by another business is never changed.
  const row = await db
    .prepare(
      `INSERT INTO website_domains (hostname, customer, verify_token, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?4)
       ON CONFLICT(hostname) DO UPDATE SET customer = ?2, verify_token = ?3, status = 'pending', detail = NULL, verified_at = NULL,
         attached_at = NULL, connected_at = NULL, checked_at = NULL, created_at = ?4, updated_at = ?4
       WHERE website_domains.status = 'removed'
       RETURNING hostname`,
    )
    .bind(parsed.hostname, customerId, token, now)
    .first()
  if (!row) return { ok: false, error: 'domain_in_use' }
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
      const stale = now - r.created_at > 14 * DAY
      await set(db, hostname, { status: stale ? 'needs_attention' : 'pending', detail: stale ? 'not_verified' : 'waiting_for_record' }, now)
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

  const cname = await dnsLookup(env, hostname, 'CNAME')
  const pointed = cname.ok && cname.values.includes(cnameTarget(env))
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
    await set(db, hostname, { status: 'connected', detail: null, connected_at: r.connected_at || now }, now)
    return 'connected'
  }
  // Was connected, now isn't: say so (the site keeps serving wherever DNS still reaches us).
  if (r.status === 'connected' || r.status === 'needs_attention') {
    await set(db, hostname, { status: 'needs_attention', detail: pointed ? 'certificate_pending' : 'dns_changed' }, now)
    return 'needs_attention'
  }
  await set(db, hostname, { status: 'securing', detail: pointed ? 'certificate_pending' : 'waiting_for_cname' }, now)
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
