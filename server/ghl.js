// GoHighLevel (HighLevel API v2) — one-way sync of GetShowUps leads into a business's GHL
// sub-account, plus optional SMS follow-up through a GHL workflow the owner chooses.
//
// Ownership: GetShowUps is the source of truth for leads, bookings, outcomes, and email. GHL gets a
// copy: one contact and one opportunity per lead, moved through owner-mapped pipeline stages. When
// the owner sets smsVia='ghl', GHL workflows own SMS and GetShowUps sends none (smsHandledByGhl).
//
// Auth: a Private Integration Token (PIT) for the sub-account (location). PITs are static (rotate
// every 90 days) and do not support webhooks, so nothing flows back from GHL.
//
// Verified on marketplace.gohighlevel.com/docs (2026-11-09):
//   POST /contacts/upsert                       → { new, contact: { id, ... }, traceId }   scope contacts.write
//   POST /opportunities                         (pipelineId, locationId, name, status, contactId; pipelineStageId,
//                                                monetaryValue optional) → { opportunity: { id } }  scope opportunities.write
//   PUT  /opportunities/{id}                    (pipelineStageId, status open|won|lost|abandoned, monetaryValue)
//   POST /contacts/{contactId}/workflow/{wfId}  body { eventStartTime? } → { succeeded }    scope contacts.write
//   GET  /opportunities/pipelines?locationId=   → { pipelines: [{ id, name, stages: [...] }] }  scope opportunities.readonly
//   Endpoint pages list the Version header as "v3"; older PIT examples show 2021-07-28 (GHL_API_VERSION overrides).
// UNVERIFIED: the create-opportunity response shape ({ opportunity: { id } } assumed, `id` also accepted);
// the pipelines stages[].id field; whether OAuth-app rate limits (100 req/10 s, 200k/day) apply to PITs.
import { decrypt, encrypt } from './google-oauth.js'
import { recipientAllowed } from './email.js'

export const GHL_BASE = 'https://services.leadconnectorhq.com'
export const GHL_VERSION = 'v3'
const TIMEOUT_MS = 8000
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const STAGES = ['new', 'booked', 'showed', 'noShow', 'completed']
// Our stage → GHL opportunity status.
const STATUS = { new: 'open', booked: 'open', showed: 'open', completed: 'won', noShow: 'lost' }

export function ghlBase(env) {
  const o = env?.GHL_API_MOCK_ORIGIN
  return typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) ? o : GHL_BASE
}

const kvKey = (customerId) => `ghl:${customerId}`
const fail = (error, extra = {}) => ({ ok: false, error, ...extra })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One request with timeout and a single jittered retry on 429/5xx/network. Never throws.
async function call(env, token, method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(`${ghlBase(env)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: env?.GHL_API_VERSION || GHL_VERSION,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      if (attempt === 0) {
        await sleep(200 + Math.floor(Math.random() * 300))
        continue
      }
      return fail('network_error')
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(200 + Math.floor(Math.random() * 300))
      continue
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok) return { ok: true, data }
    if (res.status === 401 || res.status === 403) return fail('invalid_token', { httpStatus: res.status })
    if (res.status === 429) return fail('rate_limited', { httpStatus: 429 })
    if (res.status === 404) return fail('not_found', { httpStatus: 404 })
    if (res.status >= 500) return fail('provider_error', { httpStatus: res.status })
    return fail('rejected', { httpStatus: res.status })
  }
  return fail('provider_error')
}

// ---------- config ----------

export async function getGhlConfig(env, customerId) {
  if (env.GHL_ENABLED !== 'true') return null // release switch: off → no sync, no SMS hand-off
  try {
    const raw = await env.GOOGLE_TOKENS.get(kvKey(customerId))
    if (!raw) return null
    const cfg = JSON.parse(await decrypt(env, raw))
    return cfg?.customer === customerId ? cfg : null
  } catch {
    return null
  }
}

// Public view of the config: never includes the token.
export function publicConfig(cfg) {
  if (!cfg) return { connected: false }
  return {
    connected: true,
    locationId: cfg.locationId,
    pipelineId: cfg.pipelineId,
    stageIds: cfg.stageIds,
    workflowId: cfg.workflowId || null,
    smsVia: cfg.smsVia,
    savedAt: cfg.savedAt,
  }
}

// Returns [error, normalized] for owner input.
export function validateGhlInput(body) {
  const b = body && typeof body === 'object' ? body : {}
  const token = typeof b.token === 'string' ? b.token.trim() : ''
  if (token.length < 20 || token.length > 512 || /\s/.test(token)) return ['invalid_token_format']
  if (!ID_RE.test(String(b.locationId || ''))) return ['invalid_location']
  if (!ID_RE.test(String(b.pipelineId || ''))) return ['invalid_pipeline']
  const stageIds = {}
  for (const s of STAGES) {
    const v = b.stageIds?.[s]
    if (!ID_RE.test(String(v || ''))) return ['invalid_stages']
    stageIds[s] = String(v)
  }
  if (b.workflowId != null && b.workflowId !== '' && !ID_RE.test(String(b.workflowId))) return ['invalid_workflow']
  const smsVia = b.smsVia ?? 'getshowups'
  if (!['getshowups', 'ghl'].includes(smsVia)) return ['invalid_sms_via']
  if (smsVia === 'ghl' && !b.workflowId) return ['workflow_required_for_sms']
  return [null, { token, locationId: String(b.locationId), pipelineId: String(b.pipelineId), stageIds, workflowId: b.workflowId ? String(b.workflowId) : null, smsVia }]
}

// Verifies the token with one read (pipelines for the location), checks the pipeline exists, then
// stores everything encrypted. Returns { ok, config } or { ok:false, error }.
export async function saveGhlConfig(env, customerId, input, now = Date.now()) {
  const [error, cfg] = validateGhlInput(input)
  if (error) return fail(error)
  const r = await call(env, cfg.token, 'GET', `/opportunities/pipelines?locationId=${encodeURIComponent(cfg.locationId)}`)
  if (!r.ok) return fail(r.error === 'not_found' ? 'invalid_location' : r.error)
  const pipelines = Array.isArray(r.data?.pipelines) ? r.data.pipelines : []
  if (!pipelines.some((p) => p?.id === cfg.pipelineId)) return fail('pipeline_not_found')
  const stored = { ...cfg, customer: customerId, savedAt: now }
  try {
    await env.GOOGLE_TOKENS.put(kvKey(customerId), await encrypt(env, JSON.stringify(stored)))
  } catch {
    return fail('storage_error')
  }
  return { ok: true, config: publicConfig(stored) }
}

export async function deleteGhlConfig(env, customerId) {
  try {
    await (env.GOOGLE_TOKENS.delete ? env.GOOGLE_TOKENS.delete(kvKey(customerId)) : env.GOOGLE_TOKENS.put(kvKey(customerId), ''))
    return { ok: true }
  } catch {
    return fail('storage_error')
  }
}

// True when the owner moved SMS follow-up to a GHL workflow; the GetShowUps scheduler must then
// skip its own SMS channel for this business so leads never get duplicate texts.
export async function smsHandledByGhl(env, customerId) {
  const cfg = await getGhlConfig(env, customerId)
  return Boolean(cfg && cfg.smsVia === 'ghl' && cfg.workflowId)
}

// ---------- sync ----------

const getLink = (db, customer, entity, leadId) =>
  db.prepare('SELECT ghl_id FROM ghl_links WHERE customer = ?1 AND entity = ?2 AND local_id = ?3').bind(customer, entity, leadId).first()
const putLink = (db, customer, entity, leadId, ghlId, now) =>
  db
    .prepare(
      `INSERT INTO ghl_links (customer, entity, local_id, ghl_id, synced_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(customer, entity, local_id) DO UPDATE SET ghl_id = ?4, synced_at = ?5`,
    )
    .bind(customer, entity, leadId, ghlId, now)
    .run()

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/)
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') }
}

// Copies one lead into GHL: upsert contact, create the opportunity once, enroll in the owner's
// workflow once. Idempotent (ghl_links). Never throws; returns { ok, skipped? } or { ok:false, error }.
export async function syncLead(env, customerId, leadId, now = Date.now()) {
  try {
    const cfg = await getGhlConfig(env, customerId)
    if (!cfg) return { ok: true, skipped: 'not_connected' }
    const db = env.ONBOARDING_DB
    const lead = await db.prepare('SELECT * FROM leads WHERE id = ?1 AND customer = ?2').bind(leadId, customerId).first()
    if (!lead) return fail('lead_not_found')
    const address = await db
      .prepare('SELECT street, city, state, zip FROM lead_addresses WHERE lead_id = ?1 AND customer = ?2')
      .bind(leadId, customerId)
      .first()
      .catch(() => null)

    let contactId = (await getLink(db, customerId, 'contact', leadId))?.ghl_id
    const hadContact = Boolean(contactId)
    if (!contactId) {
      const r = await call(env, cfg.token, 'POST', '/contacts/upsert', {
        locationId: cfg.locationId,
        ...splitName(lead.name),
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        source: 'GetShowUps',
        ...(address ? { address1: address.street, city: address.city, state: address.state, postalCode: address.zip } : lead.zip ? { postalCode: lead.zip } : {}),
      })
      if (!r.ok) return fail(r.error)
      contactId = r.data?.contact?.id
      if (typeof contactId !== 'string' || !contactId) return fail('unexpected_response')
      await putLink(db, customerId, 'contact', leadId, contactId, now)
    }

    if (!(await getLink(db, customerId, 'opportunity', leadId))) {
      const stage = lead.status === 'booked' ? 'booked' : 'new'
      const r = await call(env, cfg.token, 'POST', '/opportunities', {
        locationId: cfg.locationId,
        pipelineId: cfg.pipelineId,
        pipelineStageId: cfg.stageIds[stage],
        name: `${lead.name}: ${String(lead.need).slice(0, 60)}`,
        status: STATUS[stage],
        contactId,
      })
      if (!r.ok) return fail(r.error)
      const oppId = r.data?.opportunity?.id || r.data?.id
      if (typeof oppId !== 'string' || !oppId) return fail('unexpected_response')
      await putLink(db, customerId, 'opportunity', leadId, oppId, now)
    }

    // Workflow enrollment once per lead (tracked as a link row keyed by the workflow), and only for
    // recipients allowed in the current messaging mode: a GHL workflow may text the lead.
    if (cfg.workflowId && lead.status !== 'unqualified') {
      const enrollKey = `${leadId}:wf:${cfg.workflowId}`
      if (!(await getLink(db, customerId, 'contact', enrollKey))) {
        if (!recipientAllowed(env, lead.email) && !recipientAllowed(env, lead.phone)) return { ok: true, skipped: 'test_mode', contactCreated: !hadContact }
        const r = await call(env, cfg.token, 'POST', `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(cfg.workflowId)}`, {})
        if (!r.ok) return fail(r.error)
        await putLink(db, customerId, 'contact', enrollKey, cfg.workflowId, now)
      }
    }
    return { ok: true }
  } catch (err) {
    console.error('ghl: sync lead failed:', err?.name)
    return fail('storage_error')
  }
}

// Moves the lead's opportunity to a stage: 'new' | 'booked' | 'showed' | 'noShow' | 'completed'.
// monetaryValueCents (optional) is the owner-reported job value.
export async function syncStage(env, customerId, leadId, stage, monetaryValueCents, now = Date.now()) {
  try {
    if (!STAGES.includes(stage)) return fail('invalid_stage')
    if (monetaryValueCents != null && (!Number.isInteger(monetaryValueCents) || monetaryValueCents < 0)) return fail('invalid_value')
    const cfg = await getGhlConfig(env, customerId)
    if (!cfg) return { ok: true, skipped: 'not_connected' }
    const db = env.ONBOARDING_DB
    let opp = await getLink(db, customerId, 'opportunity', leadId)
    if (!opp) {
      const created = await syncLead(env, customerId, leadId, now)
      if (!created.ok) return created
      opp = await getLink(db, customerId, 'opportunity', leadId)
      if (!opp) return fail('not_synced')
    }
    const r = await call(env, cfg.token, 'PUT', `/opportunities/${encodeURIComponent(opp.ghl_id)}`, {
      pipelineStageId: cfg.stageIds[stage],
      status: STATUS[stage],
      ...(monetaryValueCents != null ? { monetaryValue: monetaryValueCents / 100 } : {}),
    })
    if (!r.ok) return fail(r.error)
    await putLink(db, customerId, 'opportunity', leadId, opp.ghl_id, now)
    return { ok: true }
  } catch (err) {
    console.error('ghl: sync stage failed:', err?.name)
    return fail('storage_error')
  }
}
