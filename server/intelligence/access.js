// Who may use Teach Your AI, and whose published rules reach real conversations. Two separate gates, both
// comma-separated business ids (no wildcard; empty/unset = nobody), parsed like ADS_BUSINESSES; both fail closed:
//   AI_STUDIO_BUSINESSES     — the owner sees Teach Your AI: edit, test, publish (nothing customer-facing changes)
//   AI_RULES_LIVE_BUSINESSES — the receptionist (chat + Retell voice) uses that business's PUBLISHED rules (approval)
// AI_RULES_ENABLED=false is the emergency off switch for live use (the receptionist ignores every published rule set).
import { CUSTOMER_RE } from '../invites.js'
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

export const studioListed = (env, id) => listed(env?.AI_STUDIO_BUSINESSES, id)
export const rulesLiveFor = (env, id) => env?.AI_RULES_ENABLED !== 'false' && listed(env?.AI_RULES_LIVE_BUSINESSES, id)

// Studio is offered to an active, listed business once migration 0033 is applied.
export async function studioAccess(env, customer) {
  if (!customer || customer.status !== 'active' || !studioListed(env, customer.id)) return false
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
