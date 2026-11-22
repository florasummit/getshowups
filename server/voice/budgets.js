// Voice spending limits (docs/RECEPTIONIST.md "Cost controls"): the switches that bound provider time per day, read
// here and ENFORCED where sessions start (server/voice/customer.js startCustomerVoiceSession, server/voice/sessions.js
// startLabSession). Every limit fails closed: at the ceiling the start is refused with a code (voice_limit,
// test_limit, lab_daily_limit) and the caller/admin is told; nothing waits, nothing queues.
//
//   VOICE_PROVIDER_DAILY_MINUTES            minutes per provider per UTC day, platform-wide, for the providers billed
//                                           per minute to GetShowUps (OpenAI, ElevenLabs; default 600, max 10,000)
//   VOICE_PROVIDER_DAILY_MINUTES_<PROVIDER> the same for ONE provider (OPENAI | ELEVENLABS | RETELL). Retell is the
//                                           production voice path and is NOT capped unless this is set for it.
//   VOICE_TEST_DAILY_MINUTES                minutes of TEST usage per business per UTC day (admin test sessions on the
//                                           customer path + Lab calls on that business; default 30, max 600)
//   VOICE_LAB_DAILY_MINUTES                 Lab calls per day across the Lab (server/voice/providers.js, default 60)
//   RECEPTIONIST_VOICE_DAILY_MINUTES        every session of one business per day (server/voice/customer.js, 120)
// Minutes are summed from receptionist_calls rows; an ended row counts its full length, a row never ended (the browser
// went away before its end was recorded) counts at most the session ceiling.
import { PROVIDERS } from './providers.js'

// One session may run at most this long (reconnects are refused after it; the providers' own ceilings match).
export const SESSION_CEILING_MS = 15 * 60 * 1000
export const WARN_AT = 0.8 // a budget at or above this share of its limit is "near exhaustion"

const num = (v, dflt, max) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt
}
export const dayStart = (now) => now - (now % 86_400_000)

// → minutes per day for this provider, or null = not capped (Retell without its own switch).
export function providerDailyLimit(env, provider) {
  if (!PROVIDERS.includes(provider)) return null
  const own = env?.[`VOICE_PROVIDER_DAILY_MINUTES_${provider.toUpperCase()}`]
  if (own !== undefined && own !== '') return num(own, null, 10_000)
  if (provider === 'retell') return null
  return num(env?.VOICE_PROVIDER_DAILY_MINUTES, 600, 10_000)
}
export const testDailyMinutes = (env) => num(env?.VOICE_TEST_DAILY_MINUTES, 30, 600)

// Minutes of TEST usage of one business today: Lab calls (lab_ ids / retell-lab rows) and admin test sessions on the
// customer path (conversation state voice.test). Customer sessions never count here.
export async function testMinutesToday(env, customerId, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN k.ended_at IS NULL THEN MIN(?3, k.created_at + ?4) ELSE k.ended_at END - k.created_at), 0) AS ms
       FROM receptionist_calls k
       JOIN receptionist_conversations c ON c.id = k.conversation_id AND c.customer = k.customer
      WHERE k.customer = ?1 AND k.created_at >= ?2
        AND (k.provider = 'retell-lab' OR k.call_id LIKE 'lab_%' OR json_extract(c.state, '$.voice.test') = 1 OR json_extract(c.state, '$.lab.provider') IS NOT NULL)`,
  )
    .bind(customerId, dayStart(now), now, SESSION_CEILING_MS)
    .first()
  return Math.ceil(Number(r?.ms || 0) / 60_000)
}

// One budget line: used / limit → state ok | warn | exhausted (null limit = not capped).
export function budgetState(used, limit) {
  if (limit == null) return { used, limit: null, left: null, share: null, state: 'uncapped' }
  const left = Math.max(0, limit - used)
  const share = limit > 0 ? used / limit : 1
  return { used, limit, left, share: Math.round(share * 100) / 100, state: left === 0 ? 'exhausted' : share >= WARN_AT ? 'warn' : 'ok' }
}
