// /api/dashboard/ai-rules — Teach Your AI (server/intelligence/). Session business only; 404 unless studioAccess()
// (AI_STUDIO_BUSINESSES + migration 0033). POST is same-origin and rate-limited.
//   GET → state (records summary, draft + stamp, live version, history, plain-language summaries, problems, platform
//         rules, choices, how the voice provider is affected, suggestions)
//   POST { action: 'save', config, baseUpdatedAt }            → draft saved (409 conflict / 422 invalid_config)
//   POST { action: 'teach', text }                            → a PROPOSAL (nothing saved)
//   POST { action: 'apply', ops, baseUpdatedAt }              → proposal ops re-applied to the CURRENT draft, validated, saved
//   POST { action: 'simulate', lines, use: 'draft'|'live', config? } → text simulation (nothing stored or sent)
//   POST { action: 'publish', baseUpdatedAt, confirm: true }  → new live version (409 / 422)
//   POST { action: 'rollback', version, liveVersion, confirm: true } → that version published again as a new one
//   POST { action: 'reset', baseUpdatedAt }                   → draft = live rules
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { getSettings, receptionistReady } from '../../../server/receptionist/engine.js'
import { AFTER_HOURS, EMERGENCY_ACTIONS, ESCALATION_ACTIONS, ESCALATION_WHEN, INTAKE, PLATFORM_RULES, PRICING, STYLES, validateConfig } from '../../../server/intelligence/schema.js'
import { loadRules, liveRules, publishDraft, resetDraft, rollbackTo, saveDraft } from '../../../server/intelligence/store.js'
import { recordsFor, rulesLiveFor, studioAccess } from '../../../server/intelligence/access.js'
import { track } from '../../../server/events.js'
import { propose, applyOps, OP_KINDS } from '../../../server/intelligence/teach.js'
import { simulate, SIM_LIMITS } from '../../../server/intelligence/simulate.js'
import { recommendations } from '../../../server/intelligence/recommend.js'
import { voiceAdapter } from '../../../server/intelligence/providers.js'

const CHOICES = { intake: Object.fromEntries(Object.entries(INTAKE).map(([id, i]) => [id, { label: i.label, platform: Boolean(i.platform), visitOnly: Boolean(i.visitOnly) }])), afterHours: AFTER_HOURS, pricing: PRICING, emergencyActions: EMERGENCY_ACTIONS, escalationWhen: ESCALATION_WHEN, escalationActions: ESCALATION_ACTIONS, styles: STYLES }
const stampOf = (v) => (v === null || v === undefined ? null : Number.isSafeInteger(v) ? v : NaN)

async function state(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const records = await recordsFor(env, customer, now)
  const rules = await loadRules(db, customer.id, records)
  const receptionist = (await receptionistReady(db)) ? await getSettings(db, customer.id) : { enabled: false }
  return {
    records: { name: records.name, industry: records.industry, services: records.services, towns: records.towns, zipCount: records.zips.length, zips: records.zips.slice(0, 60), visit: records.visit, hoursConfirmed: records.hoursConfirmed },
    ...rules,
    platformRules: PLATFORM_RULES,
    choices: CHOICES,
    status: { receptionistOn: Boolean(receptionist.enabled), rulesLive: rulesLiveFor(env, customer.id), provider: voiceAdapter().plan(env, { customerId: customer.id, version: rules.liveVersion }) },
    suggestions: await recommendations(db, customer.id, rules.live || rules.draft, records, now),
    limits: SIM_LIMITS,
  }
}

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
  try {
    return json(200, await state(env, session.customer))
  } catch (err) {
    console.error('ai-rules load failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  if (!(await studioAccess(env, customer))) return json(404, { error: 'not_found' })
  const raw = await request.text().catch(() => '')
  if (raw.length > 64_000) return json(413, { error: 'too_large' })
  let b
  try {
    b = JSON.parse(raw)
  } catch {
    b = null
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json(400, { error: 'invalid_request' })
  const rl = await hit(env, b.action === 'teach' ? 'aiRulesTeach' : 'aiRulesWrite', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const db = env.ONBOARDING_DB
  const now = Date.now()
  try {
    const records = await recordsFor(env, customer, now)
    const current = await loadRules(db, customer.id, records)
    const base = stampOf(b.baseUpdatedAt)
    const conflict = async () => json(409, { error: 'conflict', ...(await state(env, customer, now)) })

    if (b.action === 'save' || b.action === 'apply') {
      if (Number.isNaN(base)) return json(400, { error: 'invalid_request' })
      // apply: the proposal's operations, re-applied server-side to the CURRENT draft (never a config from the page).
      let candidate
      if (b.action === 'apply') {
        if (!Array.isArray(b.ops) || b.ops.length > 30 || !b.ops.every((o) => o && OP_KINDS.includes(o.kind) && o.kind !== 'refuse')) return json(400, { error: 'invalid_request' })
        if (base !== current.draftUpdatedAt) return conflict()
        candidate = applyOps(current.draft, b.ops.map((o) => ({ kind: o.kind, item: o.item, other: o.other, value: typeof o.value === 'string' ? o.value.slice(0, 300) : undefined, phrase: typeof o.phrase === 'string' ? o.phrase.slice(0, 120) : undefined }))).config
      } else candidate = b.config
      const v = validateConfig(candidate, records)
      if (v.errors.length) return json(422, { error: 'invalid_config', errors: v.errors })
      const saved = await saveDraft(db, customer.id, v.config, { expect: base, now })
      if (!saved.ok) return conflict()
      return json(200, { ok: true, ...(await state(env, customer, now)) })
    }

    if (b.action === 'teach') {
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (!text || text.length > 1200) return json(400, { error: 'invalid_request' })
      let asked = false
      const started = Date.now()
      const p = await propose(env, text, current.draft, records, { allowModel: async () => (asked = !(await hit(env, 'aiRulesTeachModel', customer.id)).limited) })
      // Cost and latency of the model call (numbers and codes only; never what the owner typed).
      if (asked && p.ok) await track(env, 'ai_teach_model', { customer: customer.id, props: { costMicros: p.costMicros, ms: Date.now() - started, ...(p.modelError ? { error: p.modelError } : {}) } })
      if (!p.ok) return json(400, { error: p.error })
      return json(200, { proposal: { source: p.source, ops: p.ops, changes: p.changes, notes: p.notes, refused: p.refused, conflicts: p.conflicts, warnings: p.warnings, notUnderstood: p.notUnderstood, approvable: p.approvable } })
    }

    if (b.action === 'simulate') {
      const lines = Array.isArray(b.lines) ? b.lines.filter((l) => typeof l === 'string' && l.trim()).slice(0, SIM_LIMITS.lines) : []
      if (!lines.length) return json(400, { error: 'invalid_request' })
      let config
      if (b.use === 'live') {
        const live = await liveRules(db, customer.id)
        if (!live) return json(409, { error: 'nothing_published' })
        config = validateConfig(live.config, records).config
      } else if (b.config !== undefined) {
        const v = validateConfig(b.config, records)
        if (v.errors.length) return json(422, { error: 'invalid_config', errors: v.errors })
        config = v.config
      } else config = current.draft
      return json(200, { simulation: simulate(config, records, lines) })
    }

    if (b.action === 'publish') {
      if (b.confirm !== true) return json(400, { error: 'confirmation_required' })
      if (Number.isNaN(base) || base === null) return json(400, { error: 'invalid_request' })
      const r = await publishDraft(env, customer.id, records, { expect: base, by: session.email, now })
      if (r.conflict) return conflict()
      if (!r.ok) return json(422, { error: r.error, errors: r.errors })
      return json(200, { ok: true, version: r.version, ...(await state(env, customer, now)) })
    }

    if (b.action === 'rollback') {
      if (b.confirm !== true) return json(400, { error: 'confirmation_required' })
      if (!Number.isSafeInteger(b.version) || b.version < 1) return json(400, { error: 'invalid_request' })
      const expectLive = stampOf(b.liveVersion)
      if (Number.isNaN(expectLive)) return json(400, { error: 'invalid_request' })
      const r = await rollbackTo(env, customer.id, records, { version: b.version, expectLive, by: session.email, now })
      if (r.conflict) return conflict()
      if (!r.ok) return json(r.error === 'not_found' ? 404 : 422, { error: r.error, errors: r.errors })
      return json(200, { ok: true, version: r.version, ...(await state(env, customer, now)) })
    }

    if (b.action === 'reset') {
      if (Number.isNaN(base)) return json(400, { error: 'invalid_request' })
      const r = await resetDraft(db, customer.id, { expect: base, now })
      if (r.conflict) return conflict()
      if (!r.ok) return json(409, { error: r.error })
      return json(200, { ok: true, ...(await state(env, customer, now)) })
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('ai-rules failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
