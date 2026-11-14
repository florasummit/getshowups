// Capability registry: the one place a feature declares itself so Business Review (/admin) shows it automatically.
// A feature registers once (server/ops/catalog.js imports the module that calls registerCapability) and records its
// operational events with recordEvent({ capability: '<id>', ... }) (server/auditlog.js). Nothing in the review engine or
// the admin UI needs to change for a new capability.
//
// registerCapability({
//   id: 'messaging.sms',                 // stable id, '<area>.<name>'
//   name: 'Text messages (Twilio)',
//   journey: 'booking',                  // one of JOURNEY ids: where it sits in the customer journey
//   description: 'Confirmations and reminders by text.',
//   dependsOn: ['platform.database'],    // other capability ids
//   external: 'Twilio',                  // the outside service, if any
//   state: (env) => ({ mode: 'disabled', note: 'Twilio not configured', approval: 'MESSAGES_LIVE + A2P 10DLC' }),
//        // mode: live | sandbox | disabled | missing | unknown   (what the configuration says)
//   verify: async (env, now) => ({ ok: true, at: <ms>, evidence: 'Last text accepted by Twilio 2h ago' }),
//        // optional, READ-ONLY, cheap (database checks): real production activity that proves it works
//   business: async (env, customerId) => ({ status: 'ok' | 'attention' | 'off', summary: 'Connected' }),
//        // optional: how this capability stands for one business (no personal data)
//   blockers: ['Google Cloud project at Test access'],  // optional: external blockers, plain words
// })

export const JOURNEY = [
  { id: 'signup', label: 'Sign up' },
  { id: 'billing', label: 'Billing' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'website', label: 'Website' },
  { id: 'advertising', label: 'Advertising' },
  { id: 'lead', label: 'Lead' },
  { id: 'booking', label: 'Booking' },
  { id: 'showup', label: 'Show-up' },
  { id: 'results', label: 'Attributed results' },
  { id: 'account', label: 'Account lifecycle' },
  { id: 'platform', label: 'Platform' },
]
export const MODES = ['live', 'sandbox', 'disabled', 'missing', 'unknown']
const ID_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/

const capabilities = new Map()

export function registerCapability(def) {
  if (!def || !ID_RE.test(def.id || '')) throw new Error(`capability: bad id ${def?.id}`)
  if (!def.name) throw new Error(`capability ${def.id}: name required`)
  if (!JOURNEY.some((j) => j.id === def.journey)) throw new Error(`capability ${def.id}: unknown journey step ${def.journey}`)
  if (typeof def.state !== 'function') throw new Error(`capability ${def.id}: state(env) required`)
  capabilities.set(def.id, { dependsOn: [], blockers: [], description: '', external: null, ...def })
  return def.id
}

// Test hook: remove a capability registered by a test.
export const unregisterCapability = (id) => capabilities.delete(id)
export const listCapabilities = () => [...capabilities.values()]
export const getCapability = (id) => capabilities.get(id) ?? null
