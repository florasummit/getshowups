// Platform change history for Business Review: releases, configuration switches and migrations.
//   buildInfo(env)       dist/build.json (written at build time: commit + tables per migration), via env.ASSETS
//   migrationStatus      which migrations production has applied (their tables exist) and which are pending
//   recordChanges(env)   cron: records a 'platform.release' event when the deployed commit changes and a
//                        'platform.config' event when a release switch / configured service changes (names only,
//                        never values of secrets)
import { recordEvent } from '../auditlog.js'

// Release switches and services whose on/off state matters operationally. Only whether each is set (or 'true').
export const SWITCHES = [
  'STRIPE_LIVE_ENABLED', 'MESSAGES_LIVE', 'ADS_ENABLED', 'ADS_LIVE_LAUNCH', 'ADS_AUTOMATION_ENABLED', 'ADS_CONVERSIONS_ENABLED',
  'GHL_ENABLED', 'ACCOUNT_DELETION_ENABLED', 'RETENTION_SCHEDULE_ENABLED',
]
export const SERVICES = {
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  resend: ['RESEND_API_KEY', 'EMAIL_FROM'],
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  cloudflare_domains: ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_PAGES_PROJECT'],
  workers_ai: ['AI'],
  meta: ['META_APP_ID', 'META_APP_SECRET'],
}

export async function buildInfo(env) {
  try {
    if (!env.ASSETS?.fetch) return null
    const r = await env.ASSETS.fetch(new Request('https://assets.local/build.json'))
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

export function configSnapshot(env) {
  const switches = Object.fromEntries(SWITCHES.map((k) => [k, env[k] === 'true']))
  const services = Object.fromEntries(Object.entries(SERVICES).map(([name, keys]) => [name, keys.every((k) => Boolean(env[k]))]))
  const stripeMode = !services.stripe ? 'off' : String(env.STRIPE_SECRET_KEY).startsWith('sk_live_') || String(env.STRIPE_SECRET_KEY).startsWith('rk_live_') ? 'live_key' : 'test_key'
  return { switches, services, stripeMode }
}

export async function migrationStatus(env, build) {
  if (!build?.migrations) return null
  const { results } = await env.ONBOARDING_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  const have = new Set(results.map((r) => r.name))
  return build.migrations.map((m) => ({ file: m.file, applied: m.tables.length ? m.tables.every((t) => have.has(t)) : null, missing: m.tables.filter((t) => !have.has(t)) }))
}

const lastDetails = async (db, action) => {
  const r = await db.prepare('SELECT details FROM audit_log WHERE action = ?1 ORDER BY seq DESC LIMIT 1').bind(action).first()
  return r ? JSON.parse(r.details) : null
}

export async function recordChanges(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const out = { release: false, config: false }
  const build = await buildInfo(env)
  if (build?.commit) {
    const prev = await lastDetails(db, 'platform.release')
    if (prev?.commit !== build.commit) {
      const migrations = await migrationStatus(env, build)
      const pending = (migrations || []).filter((m) => m.applied === false).map((m) => m.file)
      await recordEvent(db, { type: 'platform.release', actor: 'system:release', capability: 'platform.release', resource: { type: 'commit', id: build.commit.slice(0, 40) }, outcome: 'info', details: { commit: build.commit.slice(0, 40), previous: prev?.commit ?? null, builtAt: build.builtAt, pendingMigrations: pending }, at: now })
      out.release = true
    }
  }
  const snap = configSnapshot(env)
  const prev = await lastDetails(db, 'platform.config')
  if (JSON.stringify(prev) !== JSON.stringify(snap)) {
    await recordEvent(db, { type: 'platform.config', actor: 'system:release', capability: 'platform.release', resource: { type: 'config', id: 'production' }, outcome: 'info', details: snap, at: now })
    out.config = true
  }
  return out
}
