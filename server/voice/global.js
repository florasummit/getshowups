// Global default AI voice provider (migration 0036, docs/RECEPTIONIST.md "Global default provider").
//   The provider a business's customer-facing browser voice uses is resolved as explicit business override → global
//   default → retell (server/voice/style.js getVoiceSettings). This module is the ONE action that changes the default
//   for every business that follows it, with the same honesty as a per-business switch: every inherited business is
//   checked with checkProviderSwitch (configured, customer path, eligible, voice compatible or absent, booking ready,
//   VERIFIED on the new provider by a finished test session on that business). A business that fails is never
//   switched silently: mode 'all' refuses while any is blocked; mode 'staged' PINS the blocked ones to the provider
//   they have today (an explicit override, listed by name with its blockers) and switches only the verified ones.
//   Sessions in progress stay on the provider they started with (pinned per session, server/voice/customer.js).
//   Append-only history with version checks; a global rollback undoes exactly what the version did (un-pins, moves
//   switched rows back) and reports what it could not undo. Audited (admin_audit + audit_log). Platform admins only.
import { customerFromRow } from '../auth.js'
import { emailRef } from '../auditlog.js'
import { audit } from '../platform.js'
import { isTestBusinessSql } from '../testbusiness.js'
import { isPlatformAdminEmail, providerDisabled } from './customer.js'
import { providerStatus, PROVIDERS } from './providers.js'
import { checkProviderSwitch, getVoiceSettings } from './settings.js'
import { DEFAULT_PROVIDER, PROVIDER_CAPABILITIES } from './style.js'

export const GLOBAL_MAX_BUSINESSES = 200
export const GLOBAL_MODES = ['all', 'staged']
const NO_DEFAULT = Object.freeze({ provider: DEFAULT_PROVIDER, version: 0, previous: null, mode: null, pinned: [], switched: [], setAt: null, setBy: null })

export async function globalDefaultsReady(db) {
  try {
    const r = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('receptionist_voice_defaults', 'receptionist_voice_inherit')").first()
    return Number(r?.n) === 2
  } catch {
    return false
  }
}

const list = (json) => {
  try {
    const v = JSON.parse(json || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
// The current global default (newest version). No row (or no table yet) = retell, version 0.
export async function getGlobalDefault(db) {
  try {
    const r = await db.prepare('SELECT version, provider, previous, mode, pinned, switched, set_by, set_at FROM receptionist_voice_defaults ORDER BY version DESC LIMIT 1').first()
    if (!r) return { ...NO_DEFAULT }
    return { provider: PROVIDERS.includes(r.provider) ? r.provider : DEFAULT_PROVIDER, version: Number(r.version) || 0, previous: r.previous, mode: r.mode, pinned: list(r.pinned), switched: list(r.switched), setAt: Number(r.set_at) || null, setBy: r.set_by }
  } catch {
    return { ...NO_DEFAULT }
  }
}

// Every business the default may concern (deleted ones excluded), as the server's customer object plus the facts the
// console shows. Bounded: a platform with more than GLOBAL_MAX_BUSINESSES businesses refuses a global switch
// (`too_many_businesses`) rather than check a truncated list.
export async function globalBusinesses(env) {
  const db = env.ONBOARDING_DB
  const { results } = await db
    .prepare(
      `SELECT c.*, coalesce(cs.automations, 1) AS automations, ss.appointment_mode, ${isTestBusinessSql('c.id')} AS is_test,
              (SELECT enabled FROM receptionist_settings rs WHERE rs.customer = c.id) AS receptionist
         FROM customers c
         LEFT JOIN customer_settings cs ON cs.customer = c.id
         LEFT JOIN service_settings ss ON ss.customer = c.id
        WHERE NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.customer = c.id)
        ORDER BY c.name COLLATE NOCASE
        LIMIT ?1`,
    )
    .bind(GLOBAL_MAX_BUSINESSES + 1)
    .all()
  return results.map((r) => ({ customer: customerFromRow(r), test: Number(r.is_test) === 1, receptionist: Number(r.receptionist) === 1 }))
}

// The global checklist (nothing changes): platform-level checks on the provider, then every inherited business through
// the per-business checklist. → { ok, provider, current, checks, blockers, businesses, counts, consequences }
//   businesses[].status: switch (verified: follows the new default) | pinned (blocked: stays on today's provider as an
//   explicit override in a staged rollout) | override (explicit provider of its own: untouched)
export async function checkGlobalSwitch(env, { provider }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const current = await getGlobalDefault(db)
  const checks = []
  const blockers = []
  const add = (id, ok, note, code = id) => {
    checks.push({ id, ok, note })
    if (!ok) blockers.push(code)
  }
  const base = { provider, current: { provider: current.provider, version: current.version }, businesses: [], counts: { total: 0, inherited: 0, overrides: 0, switch: 0, pinned: 0 }, consequences: [] }
  if (!PROVIDERS.includes(provider)) return { ...base, ok: false, checks: [{ id: 'provider', ok: false, note: 'Unknown provider.' }], blockers: ['invalid_provider'] }
  const cap = PROVIDER_CAPABILITIES[provider]
  const status = providerStatus(env)[provider]
  add('ready', await globalDefaultsReady(db), 'Global default storage is available (migration 0036).', 'not_ready')
  add('configuration', Boolean(status.configured), status.configured ? `${cap.name} is configured on this platform.` : `${cap.name} is not configured (credentials missing).`, 'not_configured')
  add('customer_path', cap.customers, cap.customers ? `${cap.name} has the customer-facing browser voice path.` : `${cap.name} has no customer-facing path.`, 'no_customer_path')
  add('enabled', !providerDisabled(env, provider), providerDisabled(env, provider) ? `${cap.name} is switched off for customers (VOICE_PROVIDERS_DISABLED).` : `${cap.name} is not switched off.`, 'disabled')
  add('change', current.provider !== provider, current.provider !== provider ? `The global default changes from ${PROVIDER_CAPABILITIES[current.provider].name} to ${cap.name}.` : `${cap.name} already is the global default.`, 'no_change')
  add('phone_routing', true, 'No phone line is connected to GetShowUps; phone routing is unaffected.')
  const all = await globalBusinesses(env)
  add('scale', all.length <= GLOBAL_MAX_BUSINESSES, all.length <= GLOBAL_MAX_BUSINESSES ? `${all.length} business${all.length === 1 ? '' : 'es'} checked one by one.` : `More than ${GLOBAL_MAX_BUSINESSES} businesses: a global switch is refused (switch in groups instead).`, 'too_many_businesses')
  const businesses = []
  const counts = { total: all.length, inherited: 0, overrides: 0, switch: 0, pinned: 0 }
  if (blockers.length === 0) {
    for (const b of all) {
      const cur = await getVoiceSettings(db, b.customer.id)
      const row = { id: b.customer.id, name: b.customer.name, test: b.test, receptionist: b.receptionist, provider: cur.provider, inherited: cur.inherited, blockers: [], voice: cur.voiceId ? { id: cur.voiceId, name: cur.voiceName, provider: cur.voiceProvider } : null }
      if (!cur.inherited) {
        counts.overrides += 1
        businesses.push({ ...row, status: 'override' })
        continue
      }
      counts.inherited += 1
      // The business's own checklist on the new provider: a voice chosen on this provider must be in its catalog, a
      // voice chosen on another provider blocks (never substituted), no voice = the provider's default.
      const voiceOnTarget = Boolean(cur.voiceId) && cur.voiceProvider === provider
      const c = await checkProviderSwitch(env, b.customer, { provider, voiceId: voiceOnTarget ? cur.voiceId : '', useDefaultVoice: !cur.voiceId }, now)
      const bl = c.blockers.filter((x) => x !== 'no_change')
      if (bl.length) counts.pinned += 1
      else counts.switch += 1
      businesses.push({ ...row, status: bl.length ? 'pinned' : 'switch', blockers: bl, checks: c.checks.filter((x) => !x.ok).map((x) => x.note) })
    }
  }
  const consequences = [
    `New customer voice sessions of every business that follows the global default use ${cap.name} from the moment the change is confirmed; sessions already in progress stay on the provider they started with.`,
    `${counts.switch} verified business${counts.switch === 1 ? '' : 'es'} switch now; ${counts.pinned} unverified business${counts.pinned === 1 ? '' : 'es'} ${counts.pinned === 1 ? 'is' : 'are'} pinned to today's provider as an explicit override (staged rollout) until verified and activated individually; ${counts.overrides} business${counts.overrides === 1 ? '' : 'es'} with an explicit provider of their own are untouched.`,
    `Businesses created later follow the new default.`,
    'Owners’ voices, personalities and paces are kept where they apply to the new provider; a voice chosen on another provider blocks that business (it is pinned, never substituted).',
    'Website chat, bookings, calendar, phone settings and conversation history are unaffected.',
    'The previous default and every pin are recorded for a global rollback.',
  ]
  return { ok: blockers.length === 0, provider, current: base.current, checks, blockers, businesses, counts, consequences }
}

// Change the global default: admin, checklist, mode ('all' needs zero blocked businesses; 'staged' pins them),
// confirmation, current version; ONE batch (new default version + pins + moved rows); audited.
// → { ok, global, check, applied: { switched, pinned, overrides } } | { ok: false, error, check? }
export async function switchGlobalProvider(env, admin, { provider, mode = 'staged', confirm = false, version }, now = Date.now()) {
  if (!isPlatformAdminEmail(env, admin?.email)) return { ok: false, error: 'not_platform_admin' }
  const db = env.ONBOARDING_DB
  const check = await checkGlobalSwitch(env, { provider }, now)
  const cur = await getGlobalDefault(db)
  const detail = { from: cur.provider, to: provider, mode, counts: check.counts, blockers: check.blockers }
  if (!check.ok) {
    await audit(env, admin.email, 'receptionist.global_provider_blocked', null, { ...detail, outcome: 'blocked' }).catch(() => {})
    return { ok: false, error: 'blocked', check }
  }
  if (!GLOBAL_MODES.includes(mode)) return { ok: false, error: 'invalid_mode', check }
  if (mode === 'all' && check.counts.pinned > 0) {
    await audit(env, admin.email, 'receptionist.global_provider_blocked', null, { ...detail, outcome: 'blocked', reason: 'unverified_businesses' }).catch(() => {})
    return { ok: false, error: 'blocked', reason: 'unverified_businesses', check }
  }
  if (confirm !== true) return { ok: false, error: 'confirmation_required', check }
  if (Number(version) !== cur.version) return { ok: false, error: 'stale', check, version: cur.version }
  const by = await emailRef(admin.email)
  const next = cur.version + 1
  const pinned = []
  const switched = []
  const stmts = []
  for (const b of check.businesses) {
    if (b.status === 'override') continue
    const s = await getVoiceSettings(db, b.id)
    if (!s.inherited) continue // changed under our feet: now an override, leave it
    if (b.status === 'pinned') {
      if (s.version === 0) {
        // No settings row yet: create one on today's provider (the provider's own defaults), as the explicit override.
        stmts.push(db.prepare('INSERT INTO receptionist_voice_settings (customer, provider, voice_id, voice_name, personality, pace, language, previous, version, updated_by, updated_at) SELECT ?1, ?2, NULL, NULL, ?3, ?4, ?5, NULL, 1, ?6, ?7 WHERE NOT EXISTS (SELECT 1 FROM receptionist_voice_settings WHERE customer = ?1)').bind(b.id, s.provider, s.personality, s.pace, s.language, by, now))
        pinned.push({ customer: b.id, version: 1 })
      } else {
        pinned.push({ customer: b.id, version: s.version })
      }
      stmts.push(db.prepare('DELETE FROM receptionist_voice_inherit WHERE customer = ?1').bind(b.id))
    } else if (s.version > 0) {
      // Verified and following the default: its row moves to the new provider (voice already validated there or absent).
      stmts.push(db.prepare('UPDATE receptionist_voice_settings SET provider = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE customer = ?1 AND version = ?5').bind(b.id, provider, by, now, s.version))
      switched.push({ customer: b.id, version: s.version + 1 })
    }
  }
  stmts.unshift(db.prepare('INSERT INTO receptionist_voice_defaults (version, provider, previous, mode, pinned, switched, set_by, set_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(next, provider, cur.provider, mode, JSON.stringify(pinned), JSON.stringify(switched), by, now))
  try {
    await db.batch(stmts)
  } catch {
    // The version row already exists (a concurrent change won) or storage failed: nothing was applied.
    await audit(env, admin.email, 'receptionist.global_provider_blocked', null, { ...detail, outcome: 'stale' }).catch(() => {})
    return { ok: false, error: 'stale', check, version: (await getGlobalDefault(db)).version }
  }
  const applied = { switched: switched.length, pinned: pinned.length, overrides: check.counts.overrides }
  await audit(env, admin.email, 'receptionist.global_provider_switched', null, { ...detail, version: next, applied, outcome: 'success' }).catch(() => {})
  for (const p of pinned) await audit(env, admin.email, 'receptionist.provider_pinned', p.customer, { provider: check.businesses.find((b) => b.id === p.customer)?.provider || cur.provider, globalVersion: next, blockers: check.businesses.find((b) => b.id === p.customer)?.blockers || [], outcome: 'success' }).catch(() => {})
  return { ok: true, global: await getGlobalDefault(db), check, applied }
}

// Undo the current global version: the default returns to `previous`; businesses pinned by that version follow the
// default again (if nobody changed them since); rows the version moved go back (if unchanged since; a business whose
// owner chose a voice on the new provider since is pinned there instead of having its voice substituted). Reported.
// → { ok, global, undone: { unpinned, moved, kept: [{ id, reason }] } } | { ok: false, error }
export async function rollbackGlobalProvider(env, admin, { confirm = false, version }, now = Date.now()) {
  if (!isPlatformAdminEmail(env, admin?.email)) return { ok: false, error: 'not_platform_admin' }
  const db = env.ONBOARDING_DB
  const cur = await getGlobalDefault(db)
  if (cur.version === 0 || !cur.previous || cur.mode === 'rollback') return { ok: false, error: 'nothing_to_roll_back' }
  if (confirm !== true) return { ok: false, error: 'confirmation_required', previous: cur.previous }
  if (Number(version) !== cur.version) return { ok: false, error: 'stale', version: cur.version }
  const target = cur.previous
  const by = await emailRef(admin.email)
  const stmts = []
  const undone = { unpinned: 0, moved: 0, kept: [] }
  const pinnedNow = []
  for (const p of cur.pinned) {
    const s = await getVoiceSettings(db, p.customer)
    if (s.inherited) continue // already following again
    if (s.version !== p.version) {
      undone.kept.push({ id: p.customer, reason: 'changed_since' })
      continue
    }
    stmts.push(db.prepare('INSERT OR IGNORE INTO receptionist_voice_inherit (customer, updated_at) VALUES (?1, ?2)').bind(p.customer, now))
    undone.unpinned += 1
  }
  for (const m of cur.switched) {
    const s = await getVoiceSettings(db, m.customer)
    if (!s.inherited) continue // became an override since: not ours to change
    if (s.version === m.version || !(s.voiceId && s.voiceProvider === cur.provider)) {
      stmts.push(db.prepare('UPDATE receptionist_voice_settings SET provider = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE customer = ?1 AND version = ?5').bind(m.customer, target, by, now, s.version))
      undone.moved += 1
    } else {
      // The owner chose a voice on the new provider meanwhile: keep them there explicitly rather than drop the voice.
      stmts.push(db.prepare('DELETE FROM receptionist_voice_inherit WHERE customer = ?1').bind(m.customer))
      pinnedNow.push({ customer: m.customer, version: s.version })
      undone.kept.push({ id: m.customer, reason: 'voice_on_new_provider' })
    }
  }
  stmts.unshift(db.prepare('INSERT INTO receptionist_voice_defaults (version, provider, previous, mode, pinned, switched, set_by, set_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(cur.version + 1, target, cur.provider, 'rollback', JSON.stringify(pinnedNow), '[]', by, now))
  try {
    await db.batch(stmts)
  } catch {
    return { ok: false, error: 'stale', version: (await getGlobalDefault(db)).version }
  }
  await audit(env, admin.email, 'receptionist.global_provider_rolled_back', null, { from: cur.provider, to: target, version: cur.version + 1, undone: { unpinned: undone.unpinned, moved: undone.moved, kept: undone.kept.length }, outcome: 'success' }).catch(() => {})
  for (const k of undone.kept) await audit(env, admin.email, 'receptionist.provider_pinned', k.id, { provider: cur.provider, globalVersion: cur.version + 1, reason: k.reason, outcome: 'success' }).catch(() => {})
  return { ok: true, global: await getGlobalDefault(db), undone }
}

// What the console shows above the business list: the current default, who follows it, who overrides it.
export async function globalOverview(env) {
  const db = env.ONBOARDING_DB
  const [current, ready, all] = await Promise.all([getGlobalDefault(db), globalDefaultsReady(db), globalBusinesses(env)])
  let inherited = 0
  let overrides = 0
  for (const b of all) {
    const s = await getVoiceSettings(db, b.customer.id)
    if (s.inherited) inherited += 1
    else overrides += 1
  }
  const status = providerStatus(env)
  return {
    ready,
    current: { provider: current.provider, name: PROVIDER_CAPABILITIES[current.provider]?.name || current.provider, version: current.version, previous: current.previous, mode: current.mode, setAt: current.setAt, pinned: current.pinned.length, switched: current.switched.length, canRollBack: current.version > 0 && Boolean(current.previous) && current.mode !== 'rollback' },
    counts: { total: all.length, inherited, overrides },
    providers: PROVIDERS.map((id) => ({ id, name: PROVIDER_CAPABILITIES[id].name, configured: Boolean(status[id].configured), enabled: !providerDisabled(env, id), customerPath: PROVIDER_CAPABILITIES[id].customers })),
  }
}
