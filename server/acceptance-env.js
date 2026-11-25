// What a request made with a test session may touch. Built only by server/acceptance.js; nothing here exists in normal
// requests. Deny by default: settings not named are absent (no Google, Ads, Stripe, email, text, CRM, voice credentials, so
// nothing can be sent or connected), calendar tokens are never readable, and the database refuses every write outside a
// short list of the test business's own records (queues such as messages and email_outbox are not on it).
export const ACCEPTANCE = Symbol('acceptance')

const KEEP = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'TOKEN_ENCRYPTION_KEY', 'ADMIN_API_TOKEN', 'PLATFORM_ADMIN_EMAILS', 'OPERATOR_PROVIDER', 'OPERATOR_ANTHROPIC_API_KEY', 'OPERATOR_DAILY_USD', 'OPERATOR_BUSINESS_DAILY_USD', 'AI_ASSIST_ENABLED', 'AI_ASSIST_CHAT_ENABLED', 'AI_INSIGHTS_ENABLED', 'ADS_ENABLED', 'AI_STUDIO_ENABLED', 'ANTHROPIC_CLIENT']
// Tables a test session may write; own = the values must name its business.
const WRITES = { events: 'own', leads: 'own', appointments: 'own', appointment_outcomes: 'own', appointment_changes: 'own', receptionist_requests: 'own', customers: 'own', rate_limits: 'any', audit_log: 'any' }
const FIXTURE = { lead_threads: 'own', receptionist_conversations: 'own', coverage_requests: 'own', revenue_entries: 'own' }
const CUSTOMER_COLUMNS = /^update customers set (service_zips = \?2, updated_at = \?3|slot_minutes = \?2, day_start = \?3, day_end = \?4, workdays = \?5, hours_confirmed_at = \?6, updated_at = \?6) where id = \?1 and /i
const SECRET = /\b(sessions|acceptance_\w+|ai_credentials|email_outbox|admin_audit|sms_accounts|platform_\w+)\b/i
const VERB = /\b(insert|update|delete|replace|create|drop|alter|pragma|attach|detach|vacuum|reindex)\b/i

// → { table, own } | null for a read. Throws for anything not allowed.
export function checkSql(sql, customerId, fixture = false) {
  const s = String(sql).replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*|\/\*[^]*?\*\//g, ' ').replace(/\s+/g, ' ').trim()
  const refuse = () => {
    throw new Error('acceptance_blocked')
  }
  if (/;\s*\S/.test(s) || SECRET.test(s)) refuse()
  if (/^(select|with)\b/i.test(s) && !VERB.test(s.replace(/\b(replace)\s*\(/gi, ' '))) return null
  const m = /^(?:insert(?: or (?:ignore|replace))? into|update(?: or ignore)?|delete from) ([a-z_]+)\b/i.exec(s)
  if (!m) refuse()
  const table = m[1].toLowerCase()
  const rule = WRITES[table] || (fixture ? FIXTURE[table] : null)
  if (!rule) refuse()
  if (/^delete/i.test(s) && !['appointment_outcomes', 'rate_limits'].includes(table)) refuse()
  if (table === 'customers' && !CUSTOMER_COLUMNS.test(s)) refuse()
  if (table === 'leads' && !fixture && !/^update leads set status = /i.test(s)) refuse()
  if (table === 'appointments' && !fixture && !/^update appointments set status = /i.test(s)) refuse()
  if (table === 'receptionist_requests' && !fixture && !/^update receptionist_requests set status = /i.test(s)) refuse()
  return { table, own: rule === 'own' }
}

export function guardedDb(db, customerId, fixture = false) {
  return {
    prepare(sql) {
      const rule = checkSql(sql, customerId, fixture)
      const stmt = db.prepare(sql)
      if (!rule?.own) return stmt
      const no = () => {
        throw new Error('acceptance_blocked')
      }
      return { bind: (...a) => (a.includes(customerId) ? stmt.bind(...a) : no()), run: no, first: no, all: no }
    },
    batch: (list) => db.batch(list),
  }
}

// grant: { customer, session, recheck }. recheck() → true while the grant, session, test mark and switch all still hold.
export function acceptanceEnv(env, grant, { fixture = false } = {}) {
  const out = {}
  for (const k of KEEP) if (env[k] !== undefined) out[k] = env[k]
  out.ONBOARDING_DB = guardedDb(env.ONBOARDING_DB, grant.customer, fixture)
  // Whether a calendar is connected can be seen; the stored token never can, and nothing can be stored or removed.
  const no = async () => {
    throw new Error('acceptance_blocked')
  }
  out.GOOGLE_TOKENS = { get: async (k) => (k === `google:${grant.customer}` && (await env.GOOGLE_TOKENS.get(k)) ? '{}' : null), put: no, delete: no, list: no }
  out[ACCEPTANCE] = grant
  return Object.freeze(out)
}
// For actions and tools: normal requests pass; a test session must still be valid at this moment.
export async function stillAllowed(env) {
  const g = env[ACCEPTANCE]
  return !g || (await g.recheck().catch(() => false)) === true
}
