// Extension point for interchangeable conversation providers (text: Claude, OpenAI; voice: Bland AI or others;
// CRM/workflows: GoHighLevel). Nothing here calls a provider: no adapters are built yet, and none is configured.
//
// The boundary (keeps providers away from booking, customers, billing, attribution and audit):
//   - A provider adapter only turns a ConversationTurn into ProposedActions. It gets no database, no env secrets
//     of other systems, no billing or audit access.
//   - GetShowUps executes proposed actions itself through validateAction() + its own services (booking rules,
//     opt-outs, test-recipient gate, audit). A provider can never book, message or charge directly.
//   - Before acting in a conversation the provider must hold control (control.js): one automation at a time,
//     a person taking over always wins.
//
// Adapter contract (to implement later, one file per provider):
//   { id: 'claude', kind: 'text' | 'voice' | 'crm', label, configured(env) -> boolean,
//     respond(turn, { signal }) -> Promise<{ actions: ProposedAction[] }> }
//   ConversationTurn: { customer, conversationId, channel: 'sms'|'web'|'voice', business: { name, services, area,
//     hours }, history: [{ from: 'lead'|'business', text }] (bounded), offeredSlots?: [iso] }
//   ProposedAction: { type: 'reply', text } | { type: 'offer_slots' } | { type: 'book_slot', start }
//                 | { type: 'handoff_to_human', reason }
import { registerCapability } from '../ops/registry.js'

export const ACTION_TYPES = ['reply', 'offer_slots', 'book_slot', 'handoff_to_human']

// Validates one proposed action before GetShowUps does anything with it. Unknown types and bad shapes are refused.
export function validateAction(a) {
  if (!a || !ACTION_TYPES.includes(a.type)) return { ok: false, error: 'unknown_action' }
  if (a.type === 'reply' && (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 1000)) return { ok: false, error: 'invalid_reply' }
  if (a.type === 'book_slot' && !(typeof a.start === 'string' && !Number.isNaN(Date.parse(a.start)))) return { ok: false, error: 'invalid_slot' }
  if (a.type === 'handoff_to_human' && a.reason !== undefined && typeof a.reason !== 'string') return { ok: false, error: 'invalid_reason' }
  return { ok: true }
}

// Provider registry. Each provider also registers a capability, so it appears in Business Review automatically.
const providers = new Map()
export function registerConversationProvider({ id, kind, label, external, configured = () => false, adapter = null }) {
  providers.set(id, { id, kind, label, configured, adapter })
  registerCapability({
    id: `conversations.${id}`,
    name: label,
    journey: 'lead',
    external,
    dependsOn: ['conversations.control', 'lead.capture'],
    state: (env) => (!adapter ? { mode: 'missing', note: 'Extension point only; adapter not built' } : configured(env) ? { mode: 'sandbox' } : { mode: 'disabled', note: 'Not configured' }),
  })
}
export const listConversationProviders = () => [...providers.values()].map(({ id, kind, label, adapter }) => ({ id, kind, label, built: Boolean(adapter) }))

registerCapability({
  id: 'conversations.control',
  name: 'One automation per conversation (control lock)',
  journey: 'lead',
  description: 'A provider must hold control before acting; a person taking over always wins.',
  dependsOn: ['platform.database', 'platform.audit'],
  state: () => ({ mode: 'sandbox', note: 'Built and tested; no provider uses it yet (migration 0017)' }),
})

// Planned providers (no adapters yet; nothing is called, no accounts or costs).
registerConversationProvider({ id: 'claude', kind: 'text', label: 'AI text replies (Claude)', external: 'Anthropic' })
registerConversationProvider({ id: 'openai', kind: 'text', label: 'AI text replies (OpenAI)', external: 'OpenAI' })
registerConversationProvider({ id: 'voice', kind: 'voice', label: 'AI voice calls (e.g. Bland AI)', external: 'Voice provider' })
registerConversationProvider({ id: 'ghl', kind: 'crm', label: 'GoHighLevel conversations and workflows', external: 'GoHighLevel' })
