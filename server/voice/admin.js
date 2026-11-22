// Admin Console entry point for voice-provider management (docs/RECEPTIONIST.md "Voice management" → "Admin
// Console"). Platform admins manage the provider of ANY business from /admin/voice-providers, without being a member of
// it. Everything here is a narrow view over the same functions the dashboard control uses (server/voice/settings.js
// providerOverview / checkProviderSwitch / switchProvider / rollbackProvider), so the readiness requirements, the
// atomic write and the audit records are identical. What an admin gets to see of a business: its name, id, status,
// test mark, whether the receptionist is on, its provider/voice configuration, provider readiness and the voice-session
// history as codes/counts/times. Never transcripts, leads, appointments or contact details.
import { customerFromRow } from '../auth.js'
import { getCustomer } from '../customers.js'
import { CUSTOMER_RE } from '../invites.js'
import { isTestBusinessSql, testStatus } from '../testbusiness.js'
import { voiceSessionHistory } from './customer.js'
import { getVoiceSettings, providerOverview, voiceSettingsReady } from './settings.js'
import { PERSONALITIES, PACES, PROVIDER_CAPABILITIES } from './style.js'

export const HISTORY_LIMIT = 20

// The business picker: every business (deleted ones excluded), with what matters for voice. Names and ids only.
export async function listVoiceBusinesses(env, limit = 200) {
  const db = env.ONBOARDING_DB
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.status, ${isTestBusinessSql('c.id')} AS is_test,
              (SELECT enabled FROM receptionist_settings rs WHERE rs.customer = c.id) AS receptionist,
              (SELECT provider FROM receptionist_voice_settings v WHERE v.customer = c.id) AS provider
         FROM customers c
        WHERE NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.customer = c.id)
        ORDER BY c.name COLLATE NOCASE
        LIMIT ?1`,
    )
    .bind(Math.min(Math.max(1, limit | 0), 500))
    .all()
    // Before a table exists (0016 deletions, 0026 receptionist, 0035 voice): the plain list, every business on today's defaults.
    .catch(async () => ({ results: (await db.prepare('SELECT id, name, status, 0 AS is_test, NULL AS receptionist, NULL AS provider FROM customers ORDER BY name COLLATE NOCASE LIMIT ?1').bind(limit).all()).results }))
  return results.map((r) => ({ id: r.id, name: r.name, status: r.status || 'active', test: Number(r.is_test) === 1, receptionist: Number(r.receptionist) === 1, provider: r.provider || 'retell', providerName: PROVIDER_CAPABILITIES[r.provider || 'retell']?.name || r.provider }))
}

// The business an admin selected, as the server's customer object (what every voice function expects).
// Validates the id before any lookup; a business being or already deleted (account_deletions tombstone) is not managed here.
export async function loadVoiceBusiness(env, id) {
  const cid = String(id || '').toLowerCase()
  if (!CUSTOMER_RE.test(cid)) return { error: 'invalid_customer', httpStatus: 400 }
  const customer = customerFromRow(await getCustomer(env.ONBOARDING_DB, cid))
  if (!customer) return { error: 'not_found', httpStatus: 404 }
  const deleted = await env.ONBOARDING_DB.prepare('SELECT 1 AS d FROM account_deletions WHERE customer = ?1').bind(cid).first().catch(() => null)
  if (deleted) return { error: 'not_found', httpStatus: 404 }
  return { customer }
}

// Everything the console shows for one business. The provider view is providerOverview (the same states, evidence
// and blockers the dashboard control shows); the history is voiceSessionHistory (codes only).
export async function adminVoiceView(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const [ready, prefs, t, rs, overview, history] = await Promise.all([
    voiceSettingsReady(db),
    getVoiceSettings(db, customer.id),
    testStatus(env, customer.id).catch(() => ({ test: true, unreadable: true })),
    db.prepare('SELECT enabled FROM receptionist_settings WHERE customer = ?1').bind(customer.id).first().catch(() => null),
    providerOverview(env, customer, now),
    voiceSessionHistory(env, customer.id, { limit: HISTORY_LIMIT, now }),
  ])
  return {
    business: { id: customer.id, name: customer.name, status: customer.status, test: Boolean(t.test), testUnreadable: Boolean(t.unreadable), receptionist: Number(rs?.enabled) === 1, hoursConfirmed: Boolean(customer.hoursConfirmed) },
    ready,
    // The configuration as stored (admins see the provider; the voice/personality/pace are what the owner chose).
    voice: { provider: prefs.provider, providerName: PROVIDER_CAPABILITIES[prefs.provider]?.name || prefs.provider, voiceId: prefs.voiceId, voiceName: prefs.voiceName, personality: PERSONALITIES[prefs.personality]?.name || prefs.personality, pace: PACES[prefs.pace]?.name || prefs.pace, version: prefs.version, updatedAt: prefs.updatedAt ?? null },
    providers: { ...overview, version: prefs.version, previous: prefs.previous ? { provider: prefs.previous.provider, voiceName: prefs.previous.voiceName || null, at: prefs.previous.at } : null },
    history,
  }
}
