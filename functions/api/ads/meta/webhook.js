// Meta lead-ads webhook.
// GET: subscription handshake (hub.mode=subscribe + hub.verify_token === META_WEBHOOK_VERIFY_TOKEN → echo hub.challenge).
// POST: X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256(raw body, META_APP_SECRET), checked in constant time.
// Each leadgen change is ingested once (meta_lead_events.leadgen_id is the idempotency key): the
// business is found by its connected Page id, the lead is fetched with that business's token, and a
// GetShowUps lead + attribution row (no personal data in details) are created. Always 200 after a
// valid signature so Meta does not retry events we deliberately ignore.
import { hitByIp, tooManyJson } from '../../../../server/ratelimit.js'
import { json, timingSafeEqual } from '../../../../server/google-oauth.js'
import { customerFromRow } from '../../../../server/auth.js'
import { createLead, validateLead } from '../../../../server/booking.js'
import { fetchLead, metaConfigured } from '../../../../server/ads/meta.js'

const enc = new TextEncoder()
const NUM = /^\d{1,30}$/

async function signatureOk(env, raw, header) {
  const m = /^sha256=([0-9a-f]{64})$/.exec(String(header || ''))
  if (!m) return false
  const key = await crypto.subtle.importKey('raw', enc.encode(env.META_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw))
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqual(hex, m[1])
}

export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams
  const expected = env.META_WEBHOOK_VERIFY_TOKEN
  if (!expected || p.get('hub.mode') !== 'subscribe' || !timingSafeEqual(String(p.get('hub.verify_token') || ''), expected)) {
    return new Response('forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const challenge = String(p.get('hub.challenge') || '')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return new Response('bad request', { status: 400 })
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
}

// Business whose connected Meta Page is pageId (one Page belongs to one business here).
async function businessForPage(db, pageId) {
  return db
    .prepare(
      `SELECT c.*, ss.appointment_mode FROM ad_connections a
         JOIN customers c ON c.id = a.customer
         LEFT JOIN service_settings ss ON ss.customer = c.id
        WHERE a.platform = 'meta' AND a.status = 'connected' AND json_extract(a.extra, '$.pageId') = ?1
        LIMIT 1`,
    )
    .bind(pageId)
    .first()
}

function leadFromFields(f) {
  const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' ')
  return { name, email: f.email, phone: f.phone_number || f.phone, need: 'Facebook lead form', zip: String(f.zip_code || f.post_code || f.zip || '').slice(0, 5) }
}

async function ingest(env, change, now) {
  const db = env.ONBOARDING_DB
  const v = change?.value || {}
  const leadgenId = String(v.leadgen_id ?? '')
  const pageId = String(v.page_id ?? '')
  if (change?.field !== 'leadgen' || !NUM.test(leadgenId) || !NUM.test(pageId)) return 'skipped'
  const row = await businessForPage(db, pageId)
  if (!row) return 'ignored' // not a Page any business connected; nothing recorded
  const customer = customerFromRow(row)
  const claimed = await db
    .prepare("INSERT OR IGNORE INTO meta_lead_events (leadgen_id, customer, status, received_at) VALUES (?1, ?2, 'received', ?3)")
    .bind(leadgenId, customer.id, now)
    .run()
  if (!claimed.meta?.changes) return 'duplicate'
  const mark = (status, leadId = null) => db.prepare('UPDATE meta_lead_events SET status = ?2, lead_id = ?3 WHERE leadgen_id = ?1').bind(leadgenId, status, leadId).run()

  const fetched = await fetchLead(env, customer.id, leadgenId)
  if (!fetched.ok) {
    console.error('Meta lead fetch failed:', fetched.httpStatus, fetched.error)
    await mark('failed')
    return 'failed'
  }
  // Lead forms do not collect a service address, so validation uses the address-free rules.
  const [error, lead] = validateLead(leadFromFields(fetched.fields), 'at_business')
  if (error) {
    console.error('Meta lead rejected:', error)
    await mark('failed')
    return 'failed'
  }
  const created = await createLead(env, customer, lead, now)
  const adId = fetched.adId || (NUM.test(String(v.ad_id ?? '')) ? String(v.ad_id) : null)
  const formId = fetched.formId || (NUM.test(String(v.form_id ?? '')) ? String(v.form_id) : null)
  const campaign = adId
    ? await db
        .prepare("SELECT id FROM ad_campaigns WHERE customer = ?1 AND platform = 'meta' AND json_extract(platform_ids, '$.adId') = ?2 LIMIT 1")
        .bind(customer.id, adId)
        .first()
    : null
  await db
    .prepare("INSERT OR IGNORE INTO lead_attribution (lead_id, customer, source, campaign_id, details, created_at) VALUES (?1, ?2, 'meta_lead_form', ?3, ?4, ?5)")
    .bind(created.id, customer.id, campaign?.id ?? null, JSON.stringify({ leadgenId, adId, formId }), now)
    .run()
  await mark('created', created.id)
  return 'created'
}

export async function onRequestPost({ request, env }) {
  if (!metaConfigured(env)) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'metaWebhook', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const raw = await request.arrayBuffer()
  if (raw.byteLength > 256 * 1024) return json(413, { error: 'too_large' })
  if (!(await signatureOk(env, raw, request.headers.get('X-Hub-Signature-256')))) return json(401, { error: 'invalid_signature' })
  let body
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return json(400, { error: 'invalid_body' })
  }
  if (body?.object !== 'page') return json(200, { ok: true, processed: 0 })
  const now = Date.now()
  const results = []
  for (const entry of (body.entry || []).slice(0, 50)) {
    for (const change of (entry?.changes || []).slice(0, 50)) {
      try {
        results.push(await ingest(env, change, now))
      } catch (err) {
        console.error('Meta lead ingest error:', err?.name || 'error')
        results.push('failed')
      }
    }
  }
  return json(200, { ok: true, processed: results.filter((r) => r === 'created').length })
}
