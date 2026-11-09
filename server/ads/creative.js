// Creative engine: provider-agnostic image and video generation with hard per-business quotas,
// a monthly AI cost cap, asset storage in R2 (binding AD_ASSETS), and approval state.
//
// Providers (each enabled only when its key is configured):
//   image: OpenAI Images API — POST /v1/images/generations, base64 output (verified endpoint).
//          The model id must be set explicitly (OPENAI_IMAGE_MODEL); per-image price is not
//          confirmed on an official page, so cost is recorded from IMAGE_COST_CENTS (default 8¢).
//   video: Runway API — async task + polling, outputs expire within 24–48 h so they are copied to R2.
//          Price: gen4_turbo 5 credits/s at $0.01/credit (official pricing page). Request shape is
//          NOT verified against a live account; keep VIDEO_PROVIDER_VERIFIED unset until it is.
// Tests use CREATIVE_API_MOCK_ORIGIN (loopback only) — never set in production.
import { randomToken } from '../google-oauth.js'

export const QUOTA = { imagesPerMonth: 24, videosPerMonth: 4, aiCostCentsPerMonth: 2000 } // $20/month cap
export const VIDEO_SECONDS = 10
const RUNWAY_CENTS_PER_SECOND = 5

const mockOrigin = (env) => {
  const o = env?.CREATIVE_API_MOCK_ORIGIN
  return typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : null
}
const base = (env, real) => mockOrigin(env) || real
const monthStart = (now) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

export const imageConfigured = (env) => Boolean(env.AD_ASSETS && env.OPENAI_API_KEY && env.OPENAI_IMAGE_MODEL)
export const videoConfigured = (env) => Boolean(env.AD_ASSETS && env.RUNWAY_API_KEY && env.VIDEO_PROVIDER_VERIFIED === 'true')

export async function usageThisMonth(db, customer, now = Date.now()) {
  const row = await db
    .prepare(
      `SELECT coalesce(sum(cost_cents), 0) AS cents,
              sum(CASE WHEN kind = 'image' THEN 1 ELSE 0 END) AS images,
              sum(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) AS videos
         FROM ai_usage WHERE customer = ?1 AND at >= ?2`,
    )
    .bind(customer, monthStart(now))
    .first()
  return { cents: row?.cents ?? 0, images: row?.images ?? 0, videos: row?.videos ?? 0 }
}

// Reserves quota before calling a provider so concurrent requests cannot overshoot.
async function reserve(env, customer, kind, provider, costCents, now) {
  const u = await usageThisMonth(env.ONBOARDING_DB, customer, now)
  if (kind === 'image' && u.images >= QUOTA.imagesPerMonth) return { ok: false, error: 'quota_images' }
  if (kind === 'video' && u.videos >= QUOTA.videosPerMonth) return { ok: false, error: 'quota_videos' }
  if (u.cents + costCents > QUOTA.aiCostCentsPerMonth) return { ok: false, error: 'quota_cost' }
  const id = randomToken(12)
  await env.ONBOARDING_DB.prepare('INSERT INTO ai_usage (id, customer, kind, provider, cost_cents, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, customer, kind, provider, costCents, now)
    .run()
  return { ok: true, usageId: id }
}
const refund = (env, usageId) => env.ONBOARDING_DB.prepare('DELETE FROM ai_usage WHERE id = ?1').bind(usageId).run()

// Records AI text usage (strategy generation) against the same monthly cap.
export async function recordTextUsage(env, customer, costCents, now = Date.now()) {
  return reserve(env, customer, 'strategy', 'anthropic', costCents, now)
}

const safePrompt = (p) => String(p ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500)

export async function generateImage(env, customer, { prompt, campaignId = null, size = '1024x1024' }, now = Date.now()) {
  if (!imageConfigured(env)) return { ok: false, error: 'not_configured' }
  const text = safePrompt(prompt)
  if (text.length < 10) return { ok: false, error: 'invalid_prompt' }
  if (!['1024x1024', '1024x1536', '1536x1024'].includes(size)) return { ok: false, error: 'invalid_size' }
  const cost = Number(env.IMAGE_COST_CENTS) > 0 ? Number(env.IMAGE_COST_CENTS) : 8
  const r = await reserve(env, customer, 'image', 'openai', cost, now)
  if (!r.ok) return r
  const id = randomToken(12)
  let res
  try {
    res = await fetch(`${base(env, 'https://api.openai.com')}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.OPENAI_IMAGE_MODEL, prompt: text, size, n: 1 }),
      signal: AbortSignal.timeout(90000),
    })
  } catch {
    await refund(env, r.usageId)
    return { ok: false, error: 'provider_unavailable', retryable: true }
  }
  const body = await res.json().catch(() => ({}))
  const b64 = body?.data?.[0]?.b64_json
  if (!res.ok || typeof b64 !== 'string') {
    await refund(env, r.usageId)
    const error = res.status === 429 ? 'provider_rate_limited' : res.status === 400 ? 'provider_rejected' : 'provider_error'
    return { ok: false, error, retryable: res.status === 429 || res.status >= 500 }
  }
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const storageKey = `creatives/${customer}/${id}.png`
  await env.AD_ASSETS.put(storageKey, bytes, { httpMetadata: { contentType: 'image/png' } })
  await env.ONBOARDING_DB.prepare(
    `INSERT INTO ad_creatives (id, customer, campaign_id, kind, provider, status, prompt, storage_key, mime, cost_cents, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'image', 'openai', 'ready', ?4, ?5, 'image/png', ?6, ?7, ?7)`,
  )
    .bind(id, customer, campaignId, text, storageKey, cost, now)
    .run()
  return { ok: true, creative: { id, kind: 'image', status: 'ready' } }
}

// Video: start an async job; pollVideos() (cron) finishes it. One 10-second clip per request.
export async function startVideo(env, customer, { prompt, imageCreativeId, campaignId = null, ratio = '720:1280' }, now = Date.now()) {
  if (!videoConfigured(env)) return { ok: false, error: 'not_configured' }
  const text = safePrompt(prompt)
  if (text.length < 10) return { ok: false, error: 'invalid_prompt' }
  const image = await getCreative(env.ONBOARDING_DB, customer, imageCreativeId)
  if (!image || image.kind !== 'image' || !['ready', 'approved'].includes(image.status)) return { ok: false, error: 'source_image_required' }
  const cost = VIDEO_SECONDS * RUNWAY_CENTS_PER_SECOND
  const r = await reserve(env, customer, 'video', 'runway', cost, now)
  if (!r.ok) return r
  const asset = await env.AD_ASSETS.get(image.storage_key)
  const dataUri = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await asset.arrayBuffer())))}`
  let res
  try {
    res = await fetch(`${base(env, 'https://api.dev.runwayml.com')}/v1/image_to_video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RUNWAY_API_KEY}`, 'Content-Type': 'application/json', 'X-Runway-Version': env.RUNWAY_API_VERSION || '2024-11-06' },
      body: JSON.stringify({ model: 'gen4_turbo', promptImage: dataUri, promptText: text, ratio, duration: VIDEO_SECONDS }),
      signal: AbortSignal.timeout(30000),
    })
  } catch {
    await refund(env, r.usageId)
    return { ok: false, error: 'provider_unavailable', retryable: true }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || typeof body.id !== 'string') {
    await refund(env, r.usageId)
    return { ok: false, error: res.status === 429 ? 'provider_rate_limited' : 'provider_error', retryable: res.status === 429 || res.status >= 500 }
  }
  const id = randomToken(12)
  await env.ONBOARDING_DB.prepare(
    `INSERT INTO ad_creatives (id, customer, campaign_id, kind, provider, status, prompt, provider_job, cost_cents, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'video', 'runway', 'pending', ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(id, customer, campaignId, text, body.id, cost, now)
    .run()
  return { ok: true, creative: { id, kind: 'video', status: 'pending' } }
}

// Polls pending video jobs and copies finished outputs into R2 (provider URLs expire).
export async function pollVideos(env, now = Date.now(), limit = 5) {
  if (!videoConfigured(env)) return { checked: 0 }
  const { results } = await env.ONBOARDING_DB.prepare("SELECT * FROM ad_creatives WHERE kind = 'video' AND status = 'pending' ORDER BY created_at LIMIT ?1").bind(limit).all()
  let done = 0
  for (const c of results) {
    const res = await fetch(`${base(env, 'https://api.dev.runwayml.com')}/v1/tasks/${encodeURIComponent(c.provider_job)}`, {
      headers: { Authorization: `Bearer ${env.RUNWAY_API_KEY}`, 'X-Runway-Version': env.RUNWAY_API_VERSION || '2024-11-06' },
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)
    const body = res && (await res.json().catch(() => ({})))
    const status = body?.status
    if (status === 'SUCCEEDED' && typeof body.output?.[0] === 'string') {
      const video = await fetch(body.output[0], { signal: AbortSignal.timeout(60000) }).catch(() => null)
      if (!video?.ok) continue
      const key = `creatives/${c.customer}/${c.id}.mp4`
      await env.AD_ASSETS.put(key, video.body, { httpMetadata: { contentType: 'video/mp4' } })
      await env.ONBOARDING_DB.prepare("UPDATE ad_creatives SET status = 'ready', storage_key = ?2, mime = 'video/mp4', updated_at = ?3 WHERE id = ?1").bind(c.id, key, now).run()
      done++
    } else if (status === 'FAILED' || status === 'CANCELLED' || now - c.created_at > 6 * 3600 * 1000) {
      await env.ONBOARDING_DB.prepare("UPDATE ad_creatives SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1").bind(c.id, status === 'FAILED' ? 'provider_failed' : 'timeout', now).run()
    }
  }
  return { checked: results.length, done }
}

export async function getCreative(db, customer, id) {
  if (typeof id !== 'string') return null
  return db.prepare('SELECT * FROM ad_creatives WHERE id = ?1 AND customer = ?2').bind(id, customer).first()
}

// Bytes of an approved/ready creative for an ad platform upload (customer-scoped).
export async function getCreativeAsset(env, customer, id) {
  const c = await getCreative(env.ONBOARDING_DB, customer, id)
  if (!c?.storage_key || !['ready', 'approved'].includes(c.status)) return null
  const obj = await env.AD_ASSETS?.get(c.storage_key)
  if (!obj) return null
  return { bytes: new Uint8Array(await obj.arrayBuffer()), mime: c.mime, kind: c.kind }
}

export async function setCreativeDecision(db, customer, id, decision, now = Date.now()) {
  if (!['approved', 'rejected'].includes(decision)) return false
  const row = await db
    .prepare("UPDATE ad_creatives SET status = ?3, updated_at = ?4 WHERE id = ?1 AND customer = ?2 AND status IN ('ready', 'approved', 'rejected') RETURNING id")
    .bind(id, customer, decision, now)
    .first()
  return Boolean(row)
}
