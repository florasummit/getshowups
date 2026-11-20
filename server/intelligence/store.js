// AI rules storage (migration 0033): one draft per business + append-only published versions + a live pointer.
// Every write carries the version stamp it saw (draft_updated_at for draft/publish, live_version for rollback): a stale
// page gets { conflict: true }, never a silent overwrite. Nothing here runs before 0033 is applied (rulesReady).
import { emailRef, recordEvent } from '../auditlog.js'
import { defaultConfig, describeConfig, diffConfigs, validateConfig } from './schema.js'

export const RULES_TABLES = ['ai_rules', 'ai_rule_versions']
const ready = new WeakSet()
export async function rulesReady(db) {
  if (!db) return false
  if (ready.has(db)) return true
  try {
    const r = await db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('ai_rules', 'ai_rule_versions')`).first()
    const ok = Number(r?.n) === RULES_TABLES.length
    if (ok) ready.add(db)
    return ok
  } catch {
    return false
  }
}

const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
// Monotonic stamp: never repeats the previous one, even within the same millisecond.
const stampAfter = (prev, now) => Math.max(now, (Number(prev) || 0) + 1)

// The owner's view: draft (stored, or a fresh default — not saved until the first save), live version, history.
export async function loadRules(db, customerId, records) {
  const row = await db.prepare('SELECT * FROM ai_rules WHERE customer = ?1').bind(customerId).first()
  const { results: versions } = await db.prepare('SELECT version, note, created_at FROM ai_rule_versions WHERE customer = ?1 ORDER BY version DESC LIMIT 50').bind(customerId).all()
  const liveRow = row?.live_version ? await db.prepare('SELECT config FROM ai_rule_versions WHERE customer = ?1 AND version = ?2').bind(customerId, row.live_version).first() : null
  // A stored draft is re-validated against today's records (a town removed in Settings shows up as a problem).
  const draftRaw = row ? parse(row.draft) : null
  const draft = validateConfig(draftRaw || defaultConfig(records), records)
  const live = liveRow ? validateConfig(parse(liveRow.config), records).config : null
  return {
    draft: draft.config,
    errors: draft.errors,
    warnings: draft.warnings,
    draftUpdatedAt: row?.draft_updated_at ?? null,
    saved: Boolean(row),
    liveVersion: row?.live_version ?? null,
    live,
    hasDraftChanges: live ? diffConfigs(live, draft.config).length > 0 : Boolean(row),
    changesSinceLive: live ? diffConfigs(live, draft.config) : row ? ['First version.'] : [],
    versions: versions.map((v) => ({ version: v.version, note: v.note, createdAt: v.created_at })),
    describe: { draft: describeConfig(draft.config, records), live: live ? describeConfig(live, records) : null },
  }
}

// The published config the receptionist uses (or null). Never the draft.
export async function liveRules(db, customerId) {
  const r = await db
    .prepare('SELECT v.version, v.config FROM ai_rules r JOIN ai_rule_versions v ON v.customer = r.customer AND v.version = r.live_version WHERE r.customer = ?1')
    .bind(customerId)
    .first()
  const config = r ? parse(r.config) : null
  return config ? { version: r.version, config } : null
}

// Save a VALIDATED config as the draft. expect = the draft_updated_at the page loaded (null = no draft row yet).
export async function saveDraft(db, customerId, config, { expect = null, now = Date.now() } = {}) {
  const body = JSON.stringify(config)
  if (expect === null || expect === undefined) {
    const stamp = now
    const r = await db.prepare('INSERT INTO ai_rules (customer, draft, draft_updated_at, live_version, updated_at) VALUES (?1, ?2, ?3, NULL, ?3) ON CONFLICT(customer) DO NOTHING').bind(customerId, body, stamp).run()
    return r?.meta?.changes > 0 ? { ok: true, draftUpdatedAt: stamp } : { ok: false, conflict: true }
  }
  const stamp = stampAfter(expect, now)
  const r = await db.prepare('UPDATE ai_rules SET draft = ?2, draft_updated_at = ?3, updated_at = ?3 WHERE customer = ?1 AND draft_updated_at = ?4').bind(customerId, body, stamp, expect).run()
  return r?.meta?.changes > 0 ? { ok: true, draftUpdatedAt: stamp } : { ok: false, conflict: true }
}

// Publish the stored draft (exactly what the owner saw: expect must match). The version row and the live pointer are
// written in one batch, both conditional on the stamp, so a concurrent save can't slip a different draft in.
export async function publishDraft(env, customerId, records, { expect, by, now = Date.now() }) {
  const db = env.ONBOARDING_DB
  const row = await db.prepare('SELECT * FROM ai_rules WHERE customer = ?1').bind(customerId).first()
  if (!row || row.draft_updated_at !== expect) return { ok: false, conflict: true }
  const { config, errors } = validateConfig(parse(row.draft), records)
  if (errors.length) return { ok: false, error: 'invalid_config', errors }
  const prev = row.live_version ? await liveRules(db, customerId) : null
  const max = await db.prepare('SELECT coalesce(max(version), 0) AS v FROM ai_rule_versions WHERE customer = ?1').bind(customerId).first()
  const version = Number(max?.v || 0) + 1
  const note = (prev ? diffConfigs(validateConfig(prev.config, records).config, config) : ['First version.']).join(' ').slice(0, 600) || 'No changes.'
  const ref = await emailRef(by || 'owner')
  await db.batch([
    db
      .prepare('INSERT INTO ai_rule_versions (customer, version, config, note, published_by, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM ai_rules WHERE customer = ?1 AND draft_updated_at = ?7)')
      .bind(customerId, version, JSON.stringify(config), note, ref, now, expect),
    db.prepare('UPDATE ai_rules SET live_version = ?2, updated_at = ?3 WHERE customer = ?1 AND draft_updated_at = ?4 AND EXISTS (SELECT 1 FROM ai_rule_versions WHERE customer = ?1 AND version = ?2)').bind(customerId, version, now, expect),
  ])
  const live = await db.prepare('SELECT live_version FROM ai_rules WHERE customer = ?1').bind(customerId).first()
  if (live?.live_version !== version) return { ok: false, conflict: true }
  await recordEvent(db, { type: 'ai_rules.published', actorType: 'owner', actor: by || 'owner', customer: customerId, capability: 'intelligence.studio', resource: { type: 'ai_rules', id: `${customerId}:v${version}` }, outcome: 'success', details: { version } }).catch(() => {})
  return { ok: true, version, note }
}

// Go back to an older version: published again as a NEW version (history stays append-only). The draft is left as it
// is (nothing the owner typed is lost); the page offers "Discard draft changes" to match the live rules.
export async function rollbackTo(env, customerId, records, { version, expectLive, by, now = Date.now() }) {
  const db = env.ONBOARDING_DB
  const row = await db.prepare('SELECT * FROM ai_rules WHERE customer = ?1').bind(customerId).first()
  if (!row || (row.live_version ?? null) !== (expectLive ?? null)) return { ok: false, conflict: true }
  const old = await db.prepare('SELECT config FROM ai_rule_versions WHERE customer = ?1 AND version = ?2').bind(customerId, version).first()
  if (!old) return { ok: false, error: 'not_found' }
  const { config, errors } = validateConfig(parse(old.config), records)
  if (errors.length) return { ok: false, error: 'invalid_config', errors }
  const max = await db.prepare('SELECT coalesce(max(version), 0) AS v FROM ai_rule_versions WHERE customer = ?1').bind(customerId).first()
  const next = Number(max?.v || 0) + 1
  const ref = await emailRef(by || 'owner')
  await db.batch([
    db
      .prepare('INSERT INTO ai_rule_versions (customer, version, config, note, published_by, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM ai_rules WHERE customer = ?1 AND live_version IS ?7)')
      .bind(customerId, next, JSON.stringify(config), `Went back to version ${version}.`, ref, now, expectLive ?? null),
    db.prepare('UPDATE ai_rules SET live_version = ?2, updated_at = ?3 WHERE customer = ?1 AND live_version IS ?4 AND EXISTS (SELECT 1 FROM ai_rule_versions WHERE customer = ?1 AND version = ?2)').bind(customerId, next, now, expectLive ?? null),
  ])
  const live = await db.prepare('SELECT live_version FROM ai_rules WHERE customer = ?1').bind(customerId).first()
  if (live?.live_version !== next) return { ok: false, conflict: true }
  await recordEvent(db, { type: 'ai_rules.rolled_back', actorType: 'owner', actor: by || 'owner', customer: customerId, capability: 'intelligence.studio', resource: { type: 'ai_rules', id: `${customerId}:v${next}` }, outcome: 'success', details: { from: version, version: next } }).catch(() => {})
  return { ok: true, version: next }
}

// Discard draft changes: the draft becomes the live config again.
export async function resetDraft(db, customerId, { expect, now = Date.now() }) {
  const live = await liveRules(db, customerId)
  if (!live) return { ok: false, error: 'nothing_published' }
  return saveDraft(db, customerId, live.config, { expect, now })
}
