// Who may use Teach Your AI, and whose published rules reach real conversations. Two separate gates:
//   Teach Your AI (edit, test, publish; nothing customer-facing changes): EVERY eligible business
//     (server/eligibility.js: active + hosting active; owner decision 2026-11-22, no allowlist: AI_STUDIO_BUSINESSES was
//     the pilot allowlist before and is ignored now), once migration 0033 is applied. AI_STUDIO_ENABLED === 'false' is
//     the emergency off switch (default on).
//   AI_RULES_LIVE_BUSINESSES — comma-separated business ids (no wildcard; empty/unset = nobody): the receptionist (chat +
//     Retell voice) uses that business's PUBLISHED rules (approval). AI_RULES_ENABLED=false is the emergency off switch
//     for live use (the receptionist ignores every published rule set). Unchanged.
import { CUSTOMER_RE } from '../invites.js'
import { businessEligible } from '../eligibility.js'
import { restricted } from '../restrictions.js'
import { getProfile } from '../onboarding.js'
import { withinHours } from '../receptionist/routing.js'
import { rulesReady } from './store.js'

const listed = (value, id) =>
  typeof id === 'string' &&
  CUSTOMER_RE.test(id) &&
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => CUSTOMER_RE.test(s))
    .includes(id)

export const studioEnabled = (env) => env?.AI_STUDIO_ENABLED !== 'false'
export const rulesLiveFor = (env, id) => env?.AI_RULES_ENABLED !== 'false' && listed(env?.AI_RULES_LIVE_BUSINESSES, id)

// Studio is offered to every eligible business once migration 0033 is applied (hidden, never broken, before that).
export async function studioAccess(env, customer) {
  if (!studioEnabled(env) || !(await businessEligible(env, customer)) || (await restricted(env, customer.id, 'teach_ai'))) return false
  return rulesReady(env.ONBOARDING_DB)
}

// The facts decisions are checked against, from the business's own records (one source of truth each).
export async function recordsFor(env, customer, now = Date.now()) {
  const profile = await getProfile(env.ONBOARDING_DB, customer.id).catch(() => null)
  return {
    name: customer.name,
    industry: profile?.industry || '',
    services: (profile?.services || []).filter((s) => s && s.name).map((s) => ({ name: String(s.name), price: s.price ? String(s.price) : '' })),
    towns: (profile?.cities || []).map(String).filter(Boolean),
    zips: customer.serviceZips || [],
    visit: customer.appointmentMode === 'at_customer',
    hoursConfirmed: Boolean(customer.hoursConfirmed),
    open: withinHours(customer, now),
    timezone: customer.timezone,
  }
}
