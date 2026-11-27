// Minimal fixed-window rate limiting in D1: one atomic upsert per request. Keys use a SHA-256 of the
// client IP (or customer id), never the raw value. Fails open on storage errors so a database hiccup
// cannot lock real customers out; abuse protection is best effort, booking integrity is not affected.
import { json, page, sha256Hex } from './google-oauth.js'

export const RULES = {
  login: { limit: 20, windowSec: 600 }, //           /api/auth/google/start  (per IP)
  loginCallback: { limit: 30, windowSec: 600 }, //   /api/auth/google/callback (per IP)
  authEmailStatus: { limit: 120, windowSec: 600 }, // GET /api/auth/email (per IP; is email sign-in offered)
  authEmailStart: { limit: 10, windowSec: 600 }, //  POST /api/auth/email/start (per IP)
  authEmailPerAddress: { limit: 5, windowSec: 3600 }, // POST /api/auth/email/start (per address hash, known or not: no inbox flooding)
  authEmailSendAll: { limit: 300, windowSec: 3600 }, // sign-in emails actually sent (everyone together: cost and abuse ceiling)
  authEmailVerify: { limit: 30, windowSec: 600 }, // POST /api/auth/email/verify (per IP)
  authEmailCode: { limit: 5, windowSec: 900 }, //    code guesses per address hash (reset by a new request, which ends the old code)
  connect: { limit: 30, windowSec: 600 }, //         /api/google/oauth/start (per IP)
  bookView: { limit: 60, windowSec: 600 }, //        GET /api/book/:id (per IP; each view calls Google)
  bookLead: { limit: 10, windowSec: 600 }, //        POST lead (per IP)
  bookLeadPerBusiness: { limit: 100, windowSec: 3600 }, // POST lead (per business, caps spam floods)
  bookEvent: { limit: 120, windowSec: 600 }, //       POST /api/book/:id/event (per IP; booking-page funnel stages, codes only)
  bookArea: { limit: 60, windowSec: 600 }, //        GET /api/book/:id/area (per IP; a ZIP lookup in our own records, no Google call: its own allowance, so it never uses up page views)
  siteForm: { limit: 5, windowSec: 600 }, //         POST website contact/quote form (per IP)
  siteFormPerBusiness: { limit: 60, windowSec: 3600 }, // POST website form (per business, caps spam floods)
  enterpriseToken: { limit: 60, windowSec: 600 }, //  GET /api/enterprise/inquiry (per IP; the form token)
  enterpriseInquiry: { limit: 5, windowSec: 3600 }, // POST /api/enterprise/inquiry (per IP)
  enterpriseInquiryTotal: { limit: 100, windowSec: 3600 }, // POST /api/enterprise/inquiry (all visitors, caps spam floods)
  websitePreview: { limit: 600, windowSec: 600 }, // POST editor live preview (per business; renders only, no AI)
  bookAppointment: { limit: 15, windowSec: 600 }, // POST appointment (per IP)
  pageView: { limit: 120, windowSec: 600 }, //       GET /api/page/:id (per IP; public landing page)
  enrollment: { limit: 120, windowSec: 600 }, //     GET /api/enrollment (per IP; public homepage + sign-in page)
  referralLink: { limit: 60, windowSec: 600 }, //   GET /r/<code> (per IP; a redirect, no lookup)
  invitePeek: { limit: 30, windowSec: 600 }, //      GET /api/invite (per IP)
  claimPeek: { limit: 30, windowSec: 600 }, //       GET /api/claim (per IP; ownership invitation preview)
  claimAccept: { limit: 10, windowSec: 600 }, //     POST /api/claim (per IP; claiming an assisted business)
  enrollmentWrite: { limit: 120, windowSec: 600 }, // POST /api/enrollments (per staff email)
  enrollmentPayment: { limit: 20, windowSec: 3600 }, // payment links created or emailed (per enrollment; each reads Stripe)
  confirm: { limit: 30, windowSec: 600 }, //         GET/POST /api/appointment/confirm (per IP)
  unsubscribe: { limit: 30, windowSec: 600 }, //     GET/POST /api/messages/unsubscribe (per IP)
  adsConnect: { limit: 20, windowSec: 600 }, //     GET /api/ads/{google,meta}/start (per IP)
  adsCallback: { limit: 30, windowSec: 600 }, //    GET /api/ads/{google,meta}/callback (per IP)
  metaWebhook: { limit: 600, windowSec: 600 }, //   POST /api/ads/meta/webhook (per IP, before signature check)
  emailWebhook: { limit: 600, windowSec: 600 }, //  POST /api/email/webhook (per IP, before signature check)
  adsPlan: { limit: 6, windowSec: 3600 }, //        POST /api/dashboard/ads/plan (per business; each call may use AI)
  adsCreative: { limit: 12, windowSec: 3600 }, //    POST /api/dashboard/ads/creative generate (per business)
  adsWrite: { limit: 60, windowSec: 600 }, //        other ads writes (per business)
  adsKey: { limit: 10, windowSec: 3600 }, //         POST /api/ads/openai/key save (per business; each validates with OpenAI)
  adsGeo: { limit: 60, windowSec: 600 }, //          GET /api/ads/openai/locations (per business; each asks OpenAI)
  accountWrite: { limit: 40, windowSec: 600 }, //    account, people, availability, integrations writes (per business)
  accountInvite: { limit: 10, windowSec: 86400 }, // invitations an owner creates (per business and day)
  accountExport: { limit: 6, windowSec: 3600 }, //    GET /api/dashboard/export (per business)
  billingRead: { limit: 60, windowSec: 600 }, //      GET billing details (per business; each reads Stripe)
  cron: { limit: 30, windowSec: 600 }, //            POST /api/cron/run (per IP; the scheduler calls every 5 min)
  voiceCatalog: { limit: 60, windowSec: 600 }, //    GET /api/dashboard/receptionist/voices (per business; cached catalog, refresh hits the provider)
  domain: { limit: 30, windowSec: 600 }, //          POST /api/dashboard/domain (per business; each check does DNS lookups)
  assetUpload: { limit: 40, windowSec: 3600 }, //    POST /api/dashboard/website/assets (per business)
  aiKey: { limit: 10, windowSec: 3600 }, //         POST /api/dashboard/ai-key save (per business; each validates with the provider)
  siteImport: { limit: 6, windowSec: 3600 }, //    POST website import start (per business; each reads up to 12 pages)
  smsWebhook: { limit: 1200, windowSec: 600 }, //  POST /api/sms/twilio/* (per IP, before signature check)
  phoneWebhook: { limit: 1200, windowSec: 600 }, // POST /api/phone/twilio/* (per IP, before signature check)
  phoneCallsPerLine: { limit: 60, windowSec: 3600 }, // incoming calls per business line (loop / flood guard)
  phoneVerifyCall: { limit: 6, windowSec: 86400 }, // verification calls per business per day (each one is a paid call)
  phoneWrite: { limit: 60, windowSec: 600 }, //     POST /api/dashboard/phone (per business)
  smsInboundPerSender: { limit: 300, windowSec: 3600 }, // inbound texts per business sender (spike guard)
  followupWrite: { limit: 120, windowSec: 600 }, //  POST /api/dashboard/followups/* (per business)
  revenueWrite: { limit: 120, windowSec: 600 }, //   POST /api/dashboard/revenue (per business)
  coverageWrite: { limit: 120, windowSec: 600 }, //  POST /api/dashboard/coverage (per business)
  receptionistChat: { limit: 40, windowSec: 600 }, //  POST /api/receptionist/:id/chat (per IP; each turn calls the model)
  receptionistPerBusiness: { limit: 600, windowSec: 3600 }, // receptionist chat turns per business (flood cap)
  receptionistVoice: { limit: 6, windowSec: 600 }, //  POST /api/receptionist/:id/voice (per IP; each starts a paid call)
  receptionistVoicePerBusiness: { limit: 60, windowSec: 3600 }, // voice calls started per business
  receptionistVoiceConnect: { limit: 30, windowSec: 600 }, // POST /api/receptionist/:id/voice-connect (per IP; reconnects re-mint)
  receptionistVoiceTool: { limit: 600, windowSec: 600 }, // POST /api/receptionist/:id/voice-tool (per IP)
  receptionistVoiceSession: { limit: 300, windowSec: 600 }, // POST /api/receptionist/:id/voice-session (per IP; transcript batches + end)
  receptionistSocket: { limit: 120, windowSec: 600 }, // GET /api/receptionist/llm/:call (per IP, before the call lookup)
  aiRulesWrite: { limit: 240, windowSec: 600 }, //   POST /api/dashboard/ai-rules save/simulate/publish/rollback (per business)
  assistMessage: { limit: 40, windowSec: 600 }, //  POST /api/dashboard/assist, insights, proposal (per business; no model needed)
  aiAskBurst: { limit: 5, windowSec: 60 }, //       POST /api/dashboard/assist (per business)
  aiAttempt: { limit: 60, windowSec: 86400 }, //    POST /api/dashboard/assist attempts that may reach a model (per business and day; abuse ceiling: the 20 answers a day are counted from successful ones)
  aiAskAll: { limit: 25, windowSec: 86400 }, //     the same, all businesses together: the included model shares one small daily allowance (docs/ASSISTANT_PROGRESS.md)
  adminAssist: { limit: 8, windowSec: 60 }, //      POST /api/platform/assist questions that may reach the model (per platform admin)
  adminAssistDay: { limit: 150, windowSec: 86400 }, // the same, per admin and day (abuse ceiling; money: server/admin-assist/data.js ADMIN_DAILY_MICROS)
  adminAssistApprove: { limit: 30, windowSec: 600 }, // POST /api/platform/assist-approve (per platform admin)
  acceptancePair: { limit: 5, windowSec: 600 }, //   POST /api/acceptance/pair (per IP)
  acceptancePairAll: { limit: 20, windowSec: 600 }, // the same, everyone together
  acceptanceSession: { limit: 90, windowSec: 600 }, // POST /api/acceptance/session (per IP; the runner polls while it waits)
  acceptanceAdmin: { limit: 10, windowSec: 600 }, //  POST /api/platform/acceptance (per admin: code guesses)
  acceptanceRefused: { limit: 20, windowSec: 3600 }, // audit rows for refused test-session writes (per business)
  aiWriteBurst: { limit: 10, windowSec: 60 }, //    POST /api/dashboard/write (per business)
  aiWrite: { limit: 40, windowSec: 86400 }, //      POST /api/dashboard/write (per business and day; cost cap)
  aiRulesTeachModel: { limit: 60, windowSec: 86400 }, // teach requests that reach the model (per business and day; cost cap)
  aiRulesTeach: { limit: 30, windowSec: 3600 }, //   POST /api/dashboard/ai-rules teach (per business; may call the model)
  health: { limit: 60, windowSec: 600 }, //          GET /api/health (per IP)
  qaIngest: { limit: 30, windowSec: 600 }, //        POST /api/qa/runs (per IP; bearer QA_INGEST_TOKEN)
  qaWrite: { limit: 600, windowSec: 600 }, //        POST /api/platform/qa (per admin; guided human QA)
  qaCenterWrite: { limit: 300, windowSec: 600 }, //  POST /api/platform/qa/* results, items, settings, evidence, import (per admin)
  qaCenterRun: { limit: 20, windowSec: 600 }, //     POST /api/platform/qa/run + cancel (per admin; starts CI / production checks)
  supportDiagnose: { limit: 6, windowSec: 600 }, //  POST /api/platform/inspector calendar diagnosis (per business)
  aiBudgetAdmin: { limit: 30, windowSec: 600 }, //   POST /api/platform/ai-spend limit changes (per admin)
  researchRead: { limit: 300, windowSec: 600 }, //   GET /api/research/vault (per researcher)
  researchWrite: { limit: 240, windowSec: 600 }, //  POST /api/research/vault (per researcher; sliders evaluate here, server-side)
  alertTest: { limit: 3, windowSec: 3600 }, //       POST /api/platform/alerts test email (per admin)
  voiceLabStart: { limit: 30, windowSec: 3600 }, //  POST /api/platform/voice-lab/session start (per admin)
  voiceLabTool: { limit: 600, windowSec: 600 }, //   POST /api/platform/voice-lab/tool (per admin)
  voiceLabConnect: { limit: 90, windowSec: 3600 }, // POST /api/platform/voice-lab/{openai,elevenlabs} (one provider connect/reconnect each, per admin)
  voiceProviderAdmin: { limit: 60, windowSec: 600 }, // POST /api/platform/voice-provider check/switch/rollback (per admin)
  websiteExport: { limit: 10, windowSec: 600 }, //   GET static website download (per business; renders every page)
  websiteAi: { limit: 30, windowSec: 600 }, //      POST website generate/revise attempts (per business; burst guard,
  //                                                   daily allowances are in server/ai-usage.js)
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

// Gives one use back when it turned out to buy nothing (the provider refused the call). Never throws, never below zero.
export async function unhit(env, rule, subject, now = Date.now()) {
  const win = Math.floor(now / (RULES[rule].windowSec * 1000))
  await env.ONBOARDING_DB.prepare('UPDATE rate_limits SET count = count - 1 WHERE key = ?1 AND win = ?2 AND count > 0').bind(`${rule}:${await sha256Hex(subject)}`, win).run().catch(() => null)
}

// Starts a rule's count for this subject over (a new sign-in code replaces the old one, so its guesses start again).
export async function resetHit(env, rule, subject) {
  await env.ONBOARDING_DB.prepare('DELETE FROM rate_limits WHERE key = ?1').bind(`${rule}:${await sha256Hex(subject)}`).run().catch(() => null)
}

export const hitByIp = (env, rule, request) => hit(env, rule, clientIp(request))

export const tooManyJson = (retryAfter) => {
  const res = json(429, { error: 'rate_limited' })
  res.headers.set('Retry-After', String(retryAfter))
  return res
}

export const tooManyPage = (retryAfter) =>
  page(429, 'Too many attempts', 'Please wait a few minutes and try again.', { 'Retry-After': String(retryAfter) })
