// Provider-independent business tools for voice (shared interface, owned by the orchestrator).
//
// Every voice provider (Retell today; OpenAI Realtime and ElevenLabs through the Voice Lab) reuses the receptionist
// engine's tools — resolve the business, check coverage, look up real availability, collect details, prepare and make
// a booking, capture a lead, hand off to a person — through ONE runner bound to a conversation of ONE business:
//
//   runVoiceTool(env, session, name, input)  →  the tool's result (what the model is told), state persisted
//
// The model never acts by itself: a booking exists only when book_appointment returns booked: true, and in dry-run
// (the Lab's default) every guard still runs but nothing is created and the result says simulated: true.
// Tool schemas are the engine's (same names, same arguments), re-shaped per provider. Business rules stay in the
// engine and in Teach Your AI; provider prompts never duplicate them.
import { TOOLS, executeTool, event, getSettings, receptionistRequestsReady } from '../receptionist/engine.js'
import { knowledgeFor, systemPrompt } from '../receptionist/knowledge.js'
import { activeRules } from '../intelligence/runtime.js'
import { rulesInstructions } from '../intelligence/compile.js'

export const VOICE_TOOL_NAMES = TOOLS.map((t) => t.name)

// Provider-neutral catalogue: { name, description, parameters (JSON Schema) }.
export const voiceTools = () => TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }))

// OpenAI Realtime session.tools shape.
export const toolsForOpenAI = () => voiceTools().map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))

// ElevenLabs client-tool shape (the browser receives the call and forwards it to our server; the agent never executes
// anything itself). Same names and parameters, so the same runner serves it.
export const toolsForElevenLabs = () => voiceTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, expects_response: true }))

// Spoken-receptionist manner shared by every provider. The facts, the guards and the conversation rules (direct answers,
// no narration, nothing asked twice, ZIP only when needed) live in the engine's own prompt (server/receptionist/
// knowledge.js); this only adds how to speak on a provider's call and how to use the shared tools.
export const VOICE_STYLE = `# How you speak on this call
- Short, warm, natural sentences, one or two per turn. No lists, no links, no filler acknowledgements.
- For a town, neighbourhood or street address call check_service_area with place; for a ZIP code call it with zip. The tool tells you the one clarification to ask when the area is not settled; never claim or deny coverage on your own.
- Say exactly what the tools return: a confirmed area as "Yes, we service <place>", open times plainly ("We have tomorrow at 10. Does that work?"), a booking only after book_appointment returns booked: true.`

// The system prompt for a voice session on another provider: the engine's per-business prompt (facts, guards, playbook)
// + the owner's published rules when live for this business + the shared voice manner. Customer text never goes here.
export async function voiceInstructions(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const settings = await getSettings(db, customer.id)
  const k = await knowledgeFor(env, customer, settings)
  const rules = await activeRules(env, customer, now).catch(() => null)
  const base = systemPrompt(k, 'voice', { requests: await receptionistRequestsReady(db) })
  return { instructions: `${base}\n\n${rules ? `${rulesInstructions(rules.config, rules.records)}\n\n` : ''}${VOICE_STYLE}`, knowledge: k, rules, greeting: settings?.greeting || `Hi, this is ${k.name}. How can I help?` }
}

const persist = (env, customer, conv, now) =>
  env.ONBOARDING_DB.prepare('UPDATE receptionist_conversations SET state = ?3, status = ?4, outcome = ?5, lead_id = ?6, appointment_id = ?7, transcript = ?9, updated_at = ?8 WHERE id = ?1 AND customer = ?2')
    .bind(conv.id, customer.id, JSON.stringify(conv.state), conv.status, conv.outcome, conv.lead_id || null, conv.appointment_id || null, now, JSON.stringify(conv.transcript || []))
    .run()

// The caller's words go into the conversation transcript before a tool runs: the engine's checks (digits said, the
// confirming words) read what the customer actually said, never what the model claims they said.
const heard = (conv, text) => {
  if (!text) return
  conv.transcript = Array.isArray(conv.transcript) ? conv.transcript : []
  const last = [...conv.transcript].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')
  if (last?.content !== text) conv.transcript.push({ role: 'user', content: text })
}

// session = { customer, conv, userText, dryRun, provider, rules? }. `userText` is the caller's latest words as the
// provider transcribed them (digit and confirmation checks read them). Returns the tool result; the conversation's
// state, status and outcome are persisted; one receptionist_events row per call (codes only).
export async function runVoiceTool(env, session, name, input = {}, now = Date.now()) {
  const { customer, conv } = session
  if (!VOICE_TOOL_NAMES.includes(name)) return { ok: false, error: 'unknown_tool' }
  if (conv.state?.endedAt) return { ok: false, error: 'conversation_ended' }
  const rules = session.rules === undefined ? await activeRules(env, customer, now).catch(() => null) : session.rules
  const userText = String(session.userText || '').trim().slice(0, 2000)
  heard(conv, userText)
  const ctx = { env, customer, conv, now, userText, knowledge: session.knowledge || null, channel: 'voice', after: [], committed: false, rules, dryRun: session.dryRun !== false }
  let out
  try {
    out = await executeTool(ctx, name, input && typeof input === 'object' ? input : {})
  } catch (err) {
    console.error('voice tool failed:', name, err?.name)
    out = { ok: false, error: 'tool_failed', note: 'Something went wrong on our side: say so honestly and offer a callback request.' }
  }
  conv.state.tools = [...(conv.state.tools || []), { name, ok: out.ok !== false, at: now, ...(out.simulated ? { simulated: true } : {}) }].slice(-60)
  await persist(env, customer, conv, now).catch((e) => console.error('voice tool persist failed:', e?.name))
  const detail = out.ok ? (out.booked ? (out.simulated ? 'booked_simulated' : 'booked') : out.recorded ? (out.simulated ? 'recorded_simulated' : out.kind || 'recorded') : null) : out.error
  await event(env, conv, name, out.ok !== false, detail, now)
  for (const fn of ctx.after) await fn().catch(() => {})
  return out
}

// What the caller and the receptionist said, from the provider's transcript (text only), into the conversation's
// customer-visible log and transcript so the owner's view and the Lab's transcript are the same record.
export async function appendVoiceTranscript(env, customer, conv, lines, now = Date.now()) {
  const safe = (Array.isArray(lines) ? lines : []).filter((l) => l && (l.who === 'customer' || l.who === 'receptionist') && typeof l.text === 'string' && l.text.trim()).map((l) => ({ who: l.who, text: l.text.trim().slice(0, 2000), channel: 'voice', at: Number.isFinite(l.at) ? l.at : now }))
  if (!safe.length) return { ok: true, added: 0 }
  conv.state.log = [...(conv.state.log || []), ...safe].slice(-200)
  await persist(env, customer, conv, now)
  return { ok: true, added: safe.length }
}
