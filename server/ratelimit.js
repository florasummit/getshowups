// Minimal fixed-window rate limiting in D1: one atomic upsert per request. Keys use a SHA-256 of the
// client IP (or customer id), never the raw value. Fails open on storage errors so a database hiccup
// cannot lock real customers out; abuse protection is best effort, booking integrity is not affected.
import { json, page, sha256Hex } from './google-oauth.js'

export const RULES = {
  login: { limit: 20, windowSec: 600 }, //           /api/auth/google/start  (per IP)
  loginCallback: { limit: 30, windowSec: 600 }, //   /api/auth/google/callback (per IP)
  connect: { limit: 30, windowSec: 600 }, //         /api/google/oauth/start (per IP)
  bookView: { limit: 60, windowSec: 600 }, //        GET /api/book/:id (per IP; each view calls Google)
  bookLead: { limit: 10, windowSec: 600 }, //        POST lead (per IP)
  bookLeadPerBusiness: { limit: 100, windowSec: 3600 }, // POST lead (per business, caps spam floods)
  bookAppointment: { limit: 15, windowSec: 600 }, // POST appointment (per IP)
  pageView: { limit: 120, windowSec: 600 }, //       GET /api/page/:id (per IP; public landing page)
  invitePeek: { limit: 30, windowSec: 600 }, //      GET /api/invite (per IP)
  confirm: { limit: 30, windowSec: 600 }, //         GET/POST /api/appointment/confirm (per IP)
  adsConnect: { limit: 20, windowSec: 600 }, //     GET /api/ads/{google,meta}/start (per IP)
  adsCallback: { limit: 30, windowSec: 600 }, //    GET /api/ads/{google,meta}/callback (per IP)
  metaWebhook: { limit: 600, windowSec: 600 }, //   POST /api/ads/meta/webhook (per IP, before signature check)
  adsPlan: { limit: 6, windowSec: 3600 }, //        POST /api/dashboard/ads/plan (per business; each call may use AI)
  adsCreative: { limit: 12, windowSec: 3600 }, //    POST /api/dashboard/ads/creative generate (per business)
  adsWrite: { limit: 60, windowSec: 600 }, //        other ads writes (per business)
  cron: { limit: 30, windowSec: 600 }, //            POST /api/cron/run (per IP; the scheduler calls every 5 min)
  domain: { limit: 30, windowSec: 600 }, //          POST /api/dashboard/domain (per business; each check does DNS lookups)
  assetUpload: { limit: 40, windowSec: 3600 }, //    POST /api/dashboard/website/assets (per business)
  websiteGenerate: { limit: 10, windowSec: 86400 }, // POST website generate (per business; one AI request each)
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'local'

// Returns { limited: false } or { limited: true, retryAfter } (seconds).
export async function hit(env, rule, subject, now = Date.now()) {
  const { limit, windowSec } = RULES[rule]
  const windowMs = windowSec * 1000
  const win = Math.floor(now / windowMs)
  const expiresAt = (win + 1) * windowMs
  try {
    const db = env.ONBOARDING_DB
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, win, count, expires_at) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(key) DO UPDATE SET count = CASE WHEN win = ?2 THEN count + 1 ELSE 1 END, win = ?2, expires_at = ?3
         RETURNING count`,
      )
      .bind(`${rule}:${await sha256Hex(subject)}`, win, expiresAt)
      .first()
    if (Math.random() < 0.02) await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?1').bind(now).run()
    if (row && row.count > limit) return { limited: true, retryAfter: Math.max(1, Math.ceil((expiresAt - now) / 1000)) }
  } catch (err) {
    console.error('rate limit unavailable:', rule, err?.message)
  }
  return { limited: false }
}

export const hitByIp = (env, rule, request) => hit(env, rule, clientIp(request))

export const tooManyJson = (retryAfter) => {
  const res = json(429, { error: 'rate_limited' })
  res.headers.set('Retry-After', String(retryAfter))
  return res
}

export const tooManyPage = (retryAfter) =>
  page(429, 'Too many attempts', 'Please wait a few minutes and try again.', { 'Retry-After': String(retryAfter) })
