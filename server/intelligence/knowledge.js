// One body of taught business knowledge, used by every capability within its own scope (docs/INTELLIGENCE.md §9). Source: the
// owner's PUBLISHED rules (store.js: drafted, reviewed, published, versioned, rolled back); never a draft, a conversation or
// an AI answer. Records (services, prices, hours, area, policies) stay where they are and always win.
// Scope: customer-facing roles see only what may be told to customers, and only where published rules are released for the
// business (AI_RULES_LIVE_BUSINESSES); planning roles also see the owner's own economics, seasons and goal.
import { liveRules, rulesReady } from './store.js'
import { rulesLiveFor } from './access.js'
import { economicsText, MONTHS, validateConfig } from './schema.js'

const CUSTOMER_FACING = ['receptionist', 'followups']
// website and writing produce drafts the owner approves before anyone sees them.
const CUSTOMER_TEXT = ['website', 'writing']
const PLANNING = ['owner', 'ads', 'analysis']
export const ROLES = [...CUSTOMER_FACING, ...CUSTOMER_TEXT, ...PLANNING]
const NONE = Object.freeze({ version: null, facts: [], qualify: [], team: [], economics: [], seasons: [], objective: '', urgent: [], excluded: [] })

// Never throws: without readable published knowledge a capability works exactly as before.
export async function taughtFor(env, customer, role, now = Date.now()) {
  if (!ROLES.includes(role)) throw new Error('unknown role')
  try {
    if (CUSTOMER_FACING.includes(role) && !rulesLiveFor(env, customer.id)) return NONE
    if (!(await rulesReady(env.ONBOARDING_DB))) return NONE
    const live = await liveRules(env.ONBOARDING_DB, customer.id)
    if (!live) return NONE
    // Validated again on the way out: a rule added later applies to what was stored earlier.
    const c = validateConfig(live.config, {}).config
    const out = { ...NONE, version: live.version, facts: c.knowledge.filter((k) => k.audience === 'customers').map(({ topic, text }) => ({ topic, text })), qualify: c.qualify, urgent: c.emergency.triggers, excluded: c.services.excluded }
    if (!PLANNING.includes(role)) return out
    const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: customer.timezone || 'UTC', month: 'numeric' }).format(now))
    return { ...out, team: c.knowledge.filter((k) => k.audience === 'team').map(({ topic, text }) => ({ topic, text })), economics: c.economics, seasons: c.seasons.map((s) => ({ ...s, now: s.months.includes(month) })), objective: c.objective }
  } catch (err) {
    console.error('taught knowledge unavailable:', role, err?.name)
    return NONE
  }
}

// Plain lines for a prompt or a fact list.
export function taughtLines(t, { planning = false } = {}) {
  const lines = t.facts.map((f) => `${f.topic}: ${f.text}`)
  if (!planning) return lines
  return [...lines, ...t.team.map((f) => `${f.topic} (internal): ${f.text}`), ...t.economics.map((e) => `Owner's figures for planning: ${economicsText(e)}`), ...t.seasons.map((s) => `Season ${s.months.map((m) => MONTHS[m - 1]).join(', ')}${s.now ? ' (now)' : ''}: ${s.note}`), ...(t.objective ? [`Goal: ${t.objective}`] : [])]
}
