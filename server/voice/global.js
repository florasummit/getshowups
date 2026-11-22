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
import { isPlatformAdminEmail, providerDailyMinutes, providerDisabled, VOICE_SESSION_MAX_MS, voiceConcurrentLimit, voiceDailyMinutes } from './customer.js'
import { providerStatus, PROVIDERS } from './providers.js'
import { checkProviderSwitch, getVoiceSettings } from './settings.js'
import { DEFAULT_PROVIDER, PROVIDER_CAPABILITIES } from './style.js'
import { testPageFor } from './testing.js'

export const GLOBAL_MAX_BUSINESSES = 200
export const GLOBAL_MODES = ['all', 'staged']
const DAY = 864e5
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
        pinned.push({ customer: b.id, version: 1, provider: s.provider })
      } else {
        pinned.push({ customer: b.id, version: s.version, provider: s.provider })
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

// ---------- pin origin: rollout-generated pins vs deliberate overrides ----------
// Every override is a settings row without an inherit row. Which of them a staged rollout (or a rollback that kept a
// business) created is read from the defaults history: each version lists the businesses it pinned with the settings
// version it saw and the provider it pinned them to (older entries: the provider the default had before that version).
// A business is still a rollout pin when it is an override on exactly that provider and no admin switch happened since
// the pin (an admin switch stamps `previous.at`). Everything else is a deliberate override (an admin chose it).
export async function globalHistory(db) {
  try {
    const { results } = await db.prepare('SELECT version, provider, previous, mode, pinned, switched, set_at FROM receptionist_voice_defaults ORDER BY version ASC LIMIT 500').all()
    return (results || []).map((r) => ({ version: Number(r.version) || 0, provider: r.provider, previous: r.previous, mode: r.mode, pinned: list(r.pinned), switched: list(r.switched), setAt: Number(r.set_at) || 0 }))
  } catch {
    return []
  }
}
export function pinOrigins(history) {
  const map = new Map()
  for (const v of history) for (const p of v.pinned) if (p?.customer) map.set(p.customer, { provider: p.provider || v.previous, version: Number(p.version) || 0, globalVersion: v.version, setAt: v.setAt })
  return map
}
// 'inherited' | 'pin' | 'override' for a business's resolved settings.
export function overrideKind(s, origin) {
  if (s.inherited) return 'inherited'
  if (origin && s.voiceProvider === origin.provider && !(Number(s.previous?.at) > origin.setAt)) return 'pin'
  return 'override'
}

// ---------- provider-level verification ----------
// Evidence that the provider works on the PRODUCTION path (customer-facing voice sessions, admin tests or real
// customers; Lab sessions do not count) in the last 30 days: finished sessions with audio both ways, the availability
// and booking tools both succeeding through our server (a simulated booking on a test business counts), and a clean
// end. Performed on a designated test business, it stands for the provider; it never stands for a business's own test.
// Outcome codes of a session whose connection failed (src/voice/elevenlabs.js disconnectInfo and src/voice/openai.js);
// a session carrying a disconnect record did not end cleanly whatever its outcome says.
const FAIL_OUTCOMES = new Set(['connect_failed', 'reconnect_failed', 'connection_lost', 'disconnected', 'microphone', 'no_microphone', 'connect_timeout', 'provider_refused', 'closed_before_start', 'socket_closed', 'socket_error', 'payload_too_large', 'provider_error', 'provider_closed', 'page_closed', 'rate_limited', 'sdp_failed'])
const connectionFailed = (v) => FAIL_OUTCOMES.has(v.outcome) || Boolean(v.disconnect)
export async function providerVerification(env, provider, now = Date.now()) {
  let rows = []
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT id, customer, state FROM receptionist_conversations WHERE created_at > ?1 AND json_extract(state, '$.voice.provider') = ?2 ORDER BY created_at DESC LIMIT 100").bind(now - 30 * DAY, provider).all()
    rows = r.results || []
  } catch {
    rows = []
  }
  const out = { ok: false, provider, sessions: 0, finished: 0, audio: false, tools: false, booking: false, cleanEnd: false, businesses: [], lastAt: null, missing: [], latest: null }
  for (const row of rows) {
    let s
    try {
      s = JSON.parse(row.state || '{}')
    } catch {
      continue
    }
    const v = s.voice?.provider === provider ? s.voice : null
    if (!v) continue
    out.sessions += 1
    if (!v.endedAt) continue
    out.finished += 1
    out.lastAt = Math.max(out.lastAt || 0, v.endedAt)
    if (!out.businesses.includes(row.customer)) out.businesses.push(row.customer)
    const m = v.metrics || {}
    const tools = s.tools || []
    const audio = m.micLive === 1 && m.audioReceived === 1
    const availability = tools.some((t) => t.name === 'find_available_times' && t.ok)
    const booking = tools.some((t) => t.name === 'book_appointment' && t.ok)
    const clean = !connectionFailed(v)
    // The newest finished session, as a record the console can explain (what it showed, what it did not, why): codes
    // and counts only. Rows come newest first. A connection failure carries the adapter's disconnect record (phase,
    // code, WebSocket close code, the provider's reason text).
    if (!out.latest) {
      const names = tools.map((t) => t.name)
      const path = !clean ? 'connection' : !audio ? 'audio' : !names.length ? 'no_tools' : !availability ? (names.includes('check_service_area') || names.includes('request_coverage') ? 'area' : 'no_availability') : !booking ? 'no_booking' : 'ok'
      out.latest = { id: row.id, customer: row.customer, startedAt: v.startedAt || null, endedAt: v.endedAt, durationSeconds: m.durationSeconds ?? (v.startedAt ? Math.round((v.endedAt - v.startedAt) / 1000) : null), test: Boolean(v.test), audio, availability, booking, cleanEnd: clean, outcome: v.outcome || null, disconnect: v.disconnect || null, tools: tools.map((t) => ({ name: t.name, ok: t.ok !== false })), failures: [], path }
    }
    // One session must show all of it at once (not audio in one and tools in another).
    if (audio && availability && booking && clean) {
      out.audio = true
      out.tools = true
      out.booking = true
      out.cleanEnd = true
    }
  }
  // Why a tool of the latest session failed (receptionist_events detail codes, e.g. request_coverage zip_missing).
  if (out.latest) {
    try {
      const { results } = await env.ONBOARDING_DB.prepare('SELECT kind, detail FROM receptionist_events WHERE conversation_id = ?1 AND ok = 0 ORDER BY at').bind(out.latest.id).all()
      out.latest.failures = (results || []).map((e) => ({ tool: e.kind, code: e.detail || 'failed' })).slice(0, 10)
    } catch {
      out.latest.failures = []
    }
  }
  if (!out.finished) out.missing.push('session')
  if (!out.audio) out.missing.push('audio')
  if (!out.tools) out.missing.push('tools')
  if (!out.booking) out.missing.push('booking')
  if (!out.cleanEnd) out.missing.push('clean_end')
  out.ok = out.missing.length === 0
  out.safeguards = { concurrentSessions: voiceConcurrentLimit(env), businessMinutesPerDay: voiceDailyMinutes(env), providerMinutesPerDay: providerDailyMinutes(env), sessionMaxMinutes: VOICE_SESSION_MAX_MS / 60000 }
  return out
}

// ---------- promotion to 100% ----------
// The per-business checklist, split for a platform-wide promotion: provider-level verification (above) stands in for
// the business's own test session, which becomes a WARNING the admin acknowledges explicitly; what the promotion
// cannot change about a business (its booking setup is the same on every provider) is a warning too; everything that
// is a real incompatibility with the target stays a BLOCKER (credentials, customer path, switched off, a voice chosen on
// another provider, a voice not in the target's catalog, the tool set).
const WARNING_CODES = { test_session_required: 'unverified', booking_not_ready: 'booking_not_ready' }
const IGNORED_CODES = new Set(['no_change'])

// The promotion checklist (nothing changes). Scope: every business that follows the default or sits on a rollout pin;
// deliberate overrides only with `includeOverrides`; suspended businesses are excluded (reported, never switched).
// → { ok, provider, current, checks, blockers, verification, businesses, counts, summary, warnings, consequences }
//   businesses[].status: promote (switches/follows the target) | blocked (technical blocker, by name) | excluded
//   businesses[].kind: inherited | pin | override;  businesses[].action: follow | release_pin | replace_override | none
export async function checkGlobalPromotion(env, { provider, includeOverrides = false }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const current = await getGlobalDefault(db)
  const target = provider || current.provider
  const checks = []
  const blockers = []
  const add = (id, ok, note, code = id) => {
    checks.push({ id, ok, note })
    if (!ok) blockers.push(code)
  }
  const counts = { total: 0, usingTarget: 0, inherited: 0, pins: 0, overrides: 0, inScope: 0, promote: 0, blocked: 0, excluded: 0, unverified: 0, willChange: 0, pinsToRelease: 0, overridesToReplace: 0 }
  const base = { provider: target, includeOverrides: Boolean(includeOverrides), current: { provider: current.provider, version: current.version }, businesses: [], counts, warnings: [], consequences: [], verification: null }
  if (!PROVIDERS.includes(target)) return { ...base, ok: false, checks: [{ id: 'provider', ok: false, note: 'Unknown provider.' }], blockers: ['invalid_provider'] }
  const cap = PROVIDER_CAPABILITIES[target]
  const status = providerStatus(env)[target]
  add('ready', await globalDefaultsReady(db), 'Global default storage is available (migration 0036).', 'not_ready')
  add('configuration', Boolean(status.configured), status.configured ? `${cap.name} is configured on this platform.` : `${cap.name} is not configured (credentials missing).`, 'not_configured')
  add('customer_path', cap.customers, cap.customers ? `${cap.name} has the customer-facing browser voice path.` : `${cap.name} has no customer-facing path.`, 'no_customer_path')
  add('enabled', !providerDisabled(env, target), providerDisabled(env, target) ? `${cap.name} is switched off for customers (VOICE_PROVIDERS_DISABLED).` : `${cap.name} is not switched off.`, 'disabled')
  const verification = status.configured ? await providerVerification(env, target, now) : { ok: false, provider: target, sessions: 0, finished: 0, businesses: [], lastAt: null, missing: ['session', 'audio', 'tools', 'booking', 'clean_end'] }
  const MISSING = { session: 'no finished production-path session', audio: 'audio both ways not measured', tools: 'the availability tool did not succeed', booking: 'no booking (simulated or real) went through', clean_end: 'no session ended cleanly' }
  add('verification', verification.ok, verification.ok ? `${cap.name} is verified on the production path: ${verification.finished} finished session(s) in the last 30 days with audio both ways, the availability and booking tools through our server and a clean end (on ${verification.businesses.join(', ')}).` : `Test ${cap.name} before switching businesses: ${verification.missing.map((m) => MISSING[m]).join('; ')}. A test session on a test business (Test ${cap.name} in the console): say hello, ask for times, book (dry run), hang up.`, 'provider_not_verified')
  add('phone_routing', true, 'No phone line is connected to GetShowUps; phone routing is unaffected.')
  add('fallback', true, 'No automatic provider fallback exists: a session that cannot connect fails visibly, it is never moved to another provider.')
  const all = await globalBusinesses(env)
  add('scale', all.length <= GLOBAL_MAX_BUSINESSES, all.length <= GLOBAL_MAX_BUSINESSES ? `${all.length} business${all.length === 1 ? '' : 'es'} checked one by one.` : `More than ${GLOBAL_MAX_BUSINESSES} businesses: a promotion is refused (switch in groups instead).`, 'too_many_businesses')
  const origins = pinOrigins(await globalHistory(db))
  const businesses = []
  counts.total = all.length
  const platformOk = blockers.length === 0
  for (const b of all) {
    const cur = await getVoiceSettings(db, b.customer.id)
    const kind = overrideKind(cur, origins.get(b.customer.id))
    const row = { id: b.customer.id, name: b.customer.name, test: b.test, receptionist: b.receptionist, provider: cur.provider, inherited: cur.inherited, kind, voice: cur.voiceId ? { id: cur.voiceId, name: cur.voiceName, provider: cur.voiceProvider } : null, blockers: [], warnings: [], facts: [], notes: [] }
    if (cur.provider === target) counts.usingTarget += 1
    counts[kind === 'inherited' ? 'inherited' : kind === 'pin' ? 'pins' : 'overrides'] += 1
    const inScope = kind !== 'override' || includeOverrides === true
    if (!inScope) {
      businesses.push({ ...row, status: 'excluded', action: 'none', reason: 'override_not_included' })
      counts.excluded += 1
      continue
    }
    if (b.customer.status !== 'active') {
      businesses.push({ ...row, status: 'excluded', action: 'none', reason: 'suspended' })
      counts.excluded += 1
      continue
    }
    counts.inScope += 1
    const action = kind === 'pin' ? 'release_pin' : kind === 'override' ? 'replace_override' : 'follow'
    if (!platformOk) {
      businesses.push({ ...row, status: 'blocked', action, blockers: [], reason: 'platform' })
      counts.blocked += 1
      continue
    }
    const voiceOnTarget = Boolean(cur.voiceId) && cur.voiceProvider === target
    const c = await checkProviderSwitch(env, b.customer, { provider: target, voiceId: voiceOnTarget ? cur.voiceId : '', useDefaultVoice: !cur.voiceId }, now)
    for (const code of c.blockers) {
      if (IGNORED_CODES.has(code)) continue
      if (WARNING_CODES[code]) row.warnings.push(WARNING_CODES[code])
      else row.blockers.push(code)
    }
    row.facts = c.checks.filter((x) => x.ok && ['configuration', 'eligibility', 'tools', 'voice', 'booking'].includes(x.id)).map((x) => x.note)
    row.notes = c.checks.filter((x) => !x.ok).map((x) => x.note)
    if (!b.receptionist) row.warnings.push('receptionist_off')
    if (row.warnings.includes('unverified')) counts.unverified += 1
    if (row.blockers.length) {
      businesses.push({ ...row, status: 'blocked', action })
      counts.blocked += 1
      continue
    }
    businesses.push({ ...row, status: 'promote', action })
    counts.promote += 1
    if (cur.provider !== target) counts.willChange += 1
    if (kind === 'pin') counts.pinsToRelease += 1
    if (kind === 'override') counts.overridesToReplace += 1
  }
  if (platformOk) {
    const change = target !== current.provider || counts.pinsToRelease > 0 || counts.overridesToReplace > 0 || businesses.some((x) => x.status === 'promote' && x.kind === 'inherited' && x.voice && x.voice.provider !== target)
    add('change', change, change ? `${counts.willChange} business${counts.willChange === 1 ? '' : 'es'} change provider; ${counts.pinsToRelease} rollout pin${counts.pinsToRelease === 1 ? '' : 's'} released; ${counts.overridesToReplace} deliberate override${counts.overridesToReplace === 1 ? '' : 's'} replaced.` : `Every business in scope already follows ${cap.name}: nothing to promote.`, 'no_change')
    add('compatibility', counts.blocked === 0, counts.blocked === 0 ? `Every business in scope is compatible with ${cap.name} (configuration, tools, voice, eligibility checked one by one).` : `${counts.blocked} business${counts.blocked === 1 ? ' is' : 'es are'} blocked by a technical incompatibility (listed by name): a 100% promotion is refused until resolved.`, 'businesses_blocked')
  }
  const warnings = []
  if (counts.unverified > 0) warnings.push({ code: 'unverified', count: counts.unverified, note: `${counts.unverified} business${counts.unverified === 1 ? ' has' : 'es have'} no finished ${cap.name} test session of ${counts.unverified === 1 ? 'its' : 'their'} own (provider-level verification and the automated compatibility checks stand in). A human listen on each business is recommended, not required; acknowledge explicitly to promote.` })
  const bookingWarn = businesses.filter((x) => x.status === 'promote' && x.warnings.includes('booking_not_ready')).length
  if (bookingWarn) warnings.push({ code: 'booking_not_ready', count: bookingWarn, note: `${bookingWarn} business${bookingWarn === 1 ? '' : 'es'} cannot book on any provider yet (calendar not connected or hours not confirmed); the promotion does not change that.` })
  const rxOff = businesses.filter((x) => x.status === 'promote' && x.warnings.includes('receptionist_off')).length
  if (rxOff) warnings.push({ code: 'receptionist_off', count: rxOff, note: `${rxOff} business${rxOff === 1 ? ' has' : 'es have'} the receptionist off: no customer sessions until the owner turns it on; the provider still changes for later.` })
  const summary = { total: counts.total, usingTarget: counts.usingTarget, pinsToRelease: counts.pinsToRelease, overridesToReplace: counts.overridesToReplace, overridesUntouched: businesses.filter((x) => x.status === 'excluded' && x.reason === 'override_not_included').length, suspended: businesses.filter((x) => x.status === 'excluded' && x.reason === 'suspended').length, blocked: counts.blocked, willChange: counts.willChange, newProvider: target, previousProvider: current.provider }
  const consequences = [
    `NEW customer-facing browser conversations of every promoted business use ${cap.name} from the moment the promotion is confirmed; conversations in progress continue on the provider they started with and are not interrupted.`,
    'Telephone routing is unchanged (no provider has a phone line here).',
    `Provider-specific behaviour and costs may differ on ${cap.name}; usage limits per business and per provider stay in force.`,
    'No automatic fallback: if a session cannot connect, it fails visibly on the promoted provider.',
    counts.pinsToRelease ? `${counts.pinsToRelease} rollout pin${counts.pinsToRelease === 1 ? '' : 's'} ${counts.pinsToRelease === 1 ? 'is' : 'are'} released: those businesses follow the global default again (no permanent ${cap.name} override is created).` : 'No rollout pins to release.',
    counts.overridesToReplace ? `${counts.overridesToReplace} deliberate override${counts.overridesToReplace === 1 ? '' : 's'} ${counts.overridesToReplace === 1 ? 'is' : 'are'} replaced (previous provider kept for the rollback).` : summary.overridesUntouched ? `${summary.overridesUntouched} deliberate override${summary.overridesUntouched === 1 ? '' : 's'} ${summary.overridesUntouched === 1 ? 'is' : 'are'} untouched (not included).` : 'No deliberate overrides.',
    'Owners’ voices, personalities and paces are kept where they apply; a voice chosen on another provider blocks that business (never substituted).',
    summary.suspended ? `${summary.suspended} suspended business${summary.suspended === 1 ? ' is' : 'es are'} excluded from the checks and writes (no sessions while suspended); one that follows the default follows the new default when reactivated.` : null,
    'Rollback is available for future sessions: it restores the previous default, the released pins and the replaced overrides; it cannot restore conversations already held or charges already made.',
  ]
  return { ok: blockers.length === 0, provider: target, includeOverrides: Boolean(includeOverrides), current: base.current, checks, blockers, verification, businesses, counts, summary, warnings, consequences: consequences.filter(Boolean) }
}

// The precondition guard of a promotion batch: the new default version is inserted with provider NULL (a NOT NULL
// violation, so the whole batch rolls back) unless every business in scope still has the settings version and
// inheritance the checklist saw. Evaluated first, inside the transaction.
const GUARDED_INSERT = `INSERT INTO receptionist_voice_defaults (version, provider, previous, mode, pinned, switched, set_by, set_at)
  VALUES (?1, CASE WHEN (SELECT count(*) FROM json_each(?9) j
                          WHERE coalesce((SELECT s.version FROM receptionist_voice_settings s WHERE s.customer = json_extract(j.value, '$.customer')), 0) = json_extract(j.value, '$.version')
                            AND (SELECT count(*) FROM receptionist_voice_inherit i WHERE i.customer = json_extract(j.value, '$.customer')) = json_extract(j.value, '$.inherit')) = ?10 THEN ?2 ELSE NULL END,
          ?3, ?4, ?5, ?6, ?7, ?8)`

// Promote the target to 100% of the businesses in scope in ONE action: admin, checklist (every blocker refuses: all or
// nothing), the unverified-businesses warning acknowledged explicitly, confirmation, current version; one guarded batch
// (new default version + released pins + replaced overrides + moved rows); audited once per promotion and once per
// business. Rollout pins and included overrides are released into FOLLOWING the default (an inherit row), never into a
// permanent override on the new provider. → { ok, global, check, applied, distribution } | { ok: false, error, check? }
export async function promoteGlobalProvider(env, admin, { provider, includeOverrides = false, acknowledgeUnverified = false, confirm = false, version }, now = Date.now()) {
  if (!isPlatformAdminEmail(env, admin?.email)) return { ok: false, error: 'not_platform_admin' }
  const db = env.ONBOARDING_DB
  const cur = await getGlobalDefault(db)
  const target = provider || cur.provider
  const check = await checkGlobalPromotion(env, { provider: target, includeOverrides }, now)
  const detail = { from: cur.provider, to: target, includeOverrides: Boolean(includeOverrides), counts: check.counts, blockers: check.blockers }
  if (!check.ok) {
    await audit(env, admin.email, 'receptionist.global_promotion_blocked', null, { ...detail, outcome: 'blocked' }).catch(() => {})
    return { ok: false, error: 'blocked', check }
  }
  if (check.counts.unverified > 0 && acknowledgeUnverified !== true) return { ok: false, error: 'acknowledgement_required', check }
  if (confirm !== true) return { ok: false, error: 'confirmation_required', check }
  if (Number(version) !== cur.version) return { ok: false, error: 'stale', check, version: cur.version }
  const by = await emailRef(admin.email)
  const next = cur.version + 1
  const expected = []
  const switched = []
  const stmts = []
  const applied = { promoted: 0, pinsReleased: 0, overridesReplaced: 0, moved: 0, excluded: check.counts.excluded, total: check.counts.total }
  for (const b of check.businesses) {
    if (b.status !== 'promote') continue
    const s = await getVoiceSettings(db, b.id)
    expected.push({ customer: b.id, version: s.version, inherit: s.inherited && s.version > 0 ? 1 : 0 })
    applied.promoted += 1
    if (b.kind === 'inherited') {
      if (s.version > 0 && s.voiceProvider !== target) {
        stmts.push(db.prepare('UPDATE receptionist_voice_settings SET provider = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE customer = ?1 AND version = ?5').bind(b.id, target, by, now, s.version))
        switched.push({ customer: b.id, version: s.version + 1, from: s.voiceProvider, kind: 'inherited' })
        applied.moved += 1
      }
      continue
    }
    // A rollout pin or an included override: its row moves to the target and the business FOLLOWS the default again.
    stmts.push(db.prepare('UPDATE receptionist_voice_settings SET provider = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE customer = ?1 AND version = ?5').bind(b.id, target, by, now, s.version))
    stmts.push(db.prepare('INSERT OR IGNORE INTO receptionist_voice_inherit (customer, updated_at) VALUES (?1, ?2)').bind(b.id, now))
    switched.push({ customer: b.id, version: s.version + 1, from: s.voiceProvider, kind: b.kind })
    if (b.kind === 'pin') applied.pinsReleased += 1
    else applied.overridesReplaced += 1
  }
  stmts.unshift(db.prepare(GUARDED_INSERT).bind(next, target, cur.provider, 'all', '[]', JSON.stringify(switched), by, now, JSON.stringify(expected), expected.length))
  try {
    await db.batch(stmts)
  } catch {
    // The version row exists (a concurrent change won), a business changed under the checklist, or storage failed:
    // nothing was applied.
    await audit(env, admin.email, 'receptionist.global_promotion_blocked', null, { ...detail, outcome: 'stale' }).catch(() => {})
    return { ok: false, error: 'stale', check, version: (await getGlobalDefault(db)).version }
  }
  await audit(env, admin.email, 'receptionist.global_provider_promoted', null, { ...detail, version: next, applied, acknowledgedUnverified: check.counts.unverified, outcome: 'success' }).catch(() => {})
  for (const m of switched) await audit(env, admin.email, 'receptionist.provider_promoted', m.customer, { from: m.from, to: target, kind: m.kind, globalVersion: next, outcome: 'success' }).catch(() => {})
  return { ok: true, global: await getGlobalDefault(db), check, applied, distribution: await providerDistribution(env) }
}

// The actual provider distribution now: how many businesses resolve to each provider, and how (following | pin | override).
export async function providerDistribution(env) {
  const db = env.ONBOARDING_DB
  const [all, history] = await Promise.all([globalBusinesses(env), globalHistory(db)])
  const origins = pinOrigins(history)
  const byProvider = Object.fromEntries(PROVIDERS.map((p) => [p, 0]))
  const byKind = { inherited: 0, pin: 0, override: 0 }
  const businesses = []
  for (const b of all) {
    const s = await getVoiceSettings(db, b.customer.id)
    const kind = overrideKind(s, origins.get(b.customer.id))
    byProvider[s.provider] = (byProvider[s.provider] || 0) + 1
    byKind[kind] += 1
    businesses.push({ id: b.customer.id, provider: s.provider, kind })
  }
  return { total: all.length, byProvider, byKind, businesses }
}

// Undo the current global version: the default returns to `previous`; businesses pinned by that version follow the
// default again (if nobody changed them since); rows the version moved go back (if unchanged since, or if no voice was
// chosen on the new provider meanwhile; a business whose owner chose a voice on the new provider since is pinned there
// instead of having its voice substituted); rollout pins and overrides a promotion released are restored as such
// (`switched[].kind`). Guarded like a promotion (all or nothing). Reported.
// → { ok, global, undone: { unpinned, moved, pinsRestored, overridesRestored, kept: [{ id, reason }] } } | { ok: false, error }
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
  const expected = []
  const undone = { unpinned: 0, moved: 0, pinsRestored: 0, overridesRestored: 0, kept: [] }
  const pinnedNow = []
  for (const p of cur.pinned) {
    const s = await getVoiceSettings(db, p.customer)
    if (s.inherited) continue // already following again
    if (s.version !== p.version) {
      undone.kept.push({ id: p.customer, reason: 'changed_since' })
      continue
    }
    expected.push({ customer: p.customer, version: s.version, inherit: 0 })
    stmts.push(db.prepare('INSERT OR IGNORE INTO receptionist_voice_inherit (customer, updated_at) VALUES (?1, ?2)').bind(p.customer, now))
    undone.unpinned += 1
  }
  for (const m of cur.switched) {
    const s = await getVoiceSettings(db, m.customer)
    if (!s.inherited) continue // became an override since: not ours to change
    const back = m.kind === 'pin' || m.kind === 'override' ? m.from || target : target
    if (s.version === m.version || !(s.voiceId && s.voiceProvider === cur.provider)) {
      expected.push({ customer: m.customer, version: s.version, inherit: 1 })
      stmts.push(db.prepare('UPDATE receptionist_voice_settings SET provider = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE customer = ?1 AND version = ?5').bind(m.customer, back, by, now, s.version))
      if (m.kind === 'pin' || m.kind === 'override') {
        // Released by a promotion: back to the override it was; a rollout pin stays recognisable as one.
        stmts.push(db.prepare('DELETE FROM receptionist_voice_inherit WHERE customer = ?1').bind(m.customer))
        if (m.kind === 'pin') {
          pinnedNow.push({ customer: m.customer, version: s.version + 1, provider: back })
          undone.pinsRestored += 1
        } else undone.overridesRestored += 1
      } else undone.moved += 1
    } else {
      // The owner chose a voice on the new provider meanwhile: keep them there explicitly rather than drop the voice.
      expected.push({ customer: m.customer, version: s.version, inherit: 1 })
      stmts.push(db.prepare('DELETE FROM receptionist_voice_inherit WHERE customer = ?1').bind(m.customer))
      pinnedNow.push({ customer: m.customer, version: s.version, provider: cur.provider })
      undone.kept.push({ id: m.customer, reason: 'voice_on_new_provider' })
    }
  }
  stmts.unshift(db.prepare(GUARDED_INSERT).bind(cur.version + 1, target, cur.provider, 'rollback', JSON.stringify(pinnedNow), '[]', by, now, JSON.stringify(expected), expected.length))
  try {
    await db.batch(stmts)
  } catch {
    return { ok: false, error: 'stale', version: (await getGlobalDefault(db)).version }
  }
  await audit(env, admin.email, 'receptionist.global_provider_rolled_back', null, { from: cur.provider, to: target, version: cur.version + 1, undone: { unpinned: undone.unpinned, moved: undone.moved, pinsRestored: undone.pinsRestored, overridesRestored: undone.overridesRestored, kept: undone.kept.length }, outcome: 'success' }).catch(() => {})
  for (const k of undone.kept) await audit(env, admin.email, 'receptionist.provider_pinned', k.id, { provider: cur.provider, globalVersion: cur.version + 1, reason: k.reason, outcome: 'success' }).catch(() => {})
  return { ok: true, global: await getGlobalDefault(db), undone }
}

// ---------- monitoring ----------
// What happened on the current default's provider since the current version was set, from the session records that
// exist (codes, counts, measurements): sessions, businesses, connection failures (sessions that ended with a connection
// outcome), tool and booking failures (the engine's own tool outcomes), usage and the cost estimate. Nothing is
// invented: a figure the records cannot give is null (shown as unavailable). Bounded to the newest 500 sessions.
export async function globalRolloutStatus(env, current, now = Date.now()) {
  if (!current || current.version === 0 || !current.setAt) return null
  let rows = []
  let unavailable = false
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT customer, state FROM receptionist_conversations WHERE created_at >= ?1 AND json_extract(state, '$.voice.provider') = ?2 ORDER BY created_at DESC LIMIT 500").bind(current.setAt, current.provider).all()
    rows = r.results || []
  } catch {
    unavailable = true
  }
  const out = { provider: current.provider, since: current.setAt, version: current.version, mode: current.mode, sessions: 0, finished: 0, inProgress: 0, businesses: 0, connectionFailures: 0, toolFailures: 0, bookingFailures: 0, bookings: 0, minutes: 0, estimatedMicros: 0, truncated: rows.length >= 500, unavailable }
  if (unavailable) return { ...out, sessions: null, finished: null, inProgress: null, businesses: null, connectionFailures: null, toolFailures: null, bookingFailures: null, bookings: null, minutes: null, estimatedMicros: null }
  const seen = new Set()
  for (const row of rows) {
    let s
    try {
      s = JSON.parse(row.state || '{}')
    } catch {
      continue
    }
    const v = s.voice?.provider === current.provider ? s.voice : null
    if (!v) continue
    out.sessions += 1
    seen.add(row.customer)
    if (v.endedAt) out.finished += 1
    else if (now - (v.startedAt || 0) < VOICE_SESSION_MAX_MS) out.inProgress += 1
    if (connectionFailed(v)) out.connectionFailures += 1
    const tools = s.tools || []
    out.toolFailures += tools.filter((t) => !t.ok).length
    out.bookingFailures += tools.filter((t) => t.name === 'book_appointment' && !t.ok).length
    if (s.booked) out.bookings += 1
    const m = v.metrics || {}
    out.minutes += (Number(m.durationSeconds) || 0) / 60
    out.estimatedMicros += Number(v.estimatedMicros) || 0
  }
  out.businesses = seen.size
  out.minutes = Math.round(out.minutes * 10) / 10
  return out
}

// What the console shows above the business list: the current default, who follows it, who sits on a rollout pin, who
// overrides it deliberately, how the current version was applied, and the rollout status since then.
// Also: the provider-level verification of the current default (the same record providerVerification gives the
// promotion checklist: finished production-path sessions, never claimed) and the test page an admin opens to produce
// it (server/voice/testing.js testPageFor: the first eligible test business, or why there is none).
export async function globalOverview(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const [current, ready, distribution] = await Promise.all([getGlobalDefault(db), globalDefaultsReady(db), providerDistribution(env)])
  const status = providerStatus(env)
  const [rollout, verification, testPage] = await Promise.all([
    globalRolloutStatus(env, current, now),
    status[current.provider]?.configured ? providerVerification(env, current.provider, now) : { ok: false, provider: current.provider, sessions: 0, finished: 0, businesses: [], lastAt: null, missing: ['session', 'audio', 'tools', 'booking', 'clean_end'], latest: null },
    testPageFor(env, current.provider),
  ])
  return {
    ready,
    current: { provider: current.provider, name: PROVIDER_CAPABILITIES[current.provider]?.name || current.provider, version: current.version, previous: current.previous, mode: current.mode, setAt: current.setAt, pinned: current.pinned.length, switched: current.switched.length, canRollBack: current.version > 0 && Boolean(current.previous) && current.mode !== 'rollback' },
    counts: { total: distribution.total, inherited: distribution.byKind.inherited, overrides: distribution.byKind.pin + distribution.byKind.override, pins: distribution.byKind.pin, independent: distribution.byKind.override, usingDefault: distribution.byProvider[current.provider] || 0, byProvider: distribution.byProvider },
    verification: { ok: verification.ok, sessions: verification.sessions, finished: verification.finished, businesses: verification.businesses, lastAt: verification.lastAt, missing: verification.missing, latest: verification.latest || null },
    // Per business: inherited | pin (a rollout left it on the previous provider) | override (business-specific).
    kinds: Object.fromEntries(distribution.businesses.map((b) => [b.id, b.kind])),
    testPage,
    rollout,
    providers: PROVIDERS.map((id) => ({ id, name: PROVIDER_CAPABILITIES[id].name, configured: Boolean(status[id].configured), enabled: !providerDisabled(env, id), customerPath: PROVIDER_CAPABILITIES[id].customers })),
  }
}
