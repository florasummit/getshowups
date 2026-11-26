// Voice provider boundary (layer B). GetShowUps owns the rules (layer A, this folder) and the actions (layer C:
// booking.js, coverage, receptionist tools); a voice provider only carries the conversation. An adapter answers ONE
// question for a published version: what, if anything, must change on the provider's side, and is that allowed now?
//
//   adapter = { id, mode, plan(env, { customerId, version }) → { providerChanges: [...], servedBy, live, notes: [...] } }
//
// Switching providers later means writing another adapter with the same shape; owners' configs (schema.js) and the
// decision engine don't change. No second provider is built (not needed now).
//
// Retell, as GetShowUps uses it today (verified in server/receptionist/voice.js + scripts/retell-setup.mjs): ONE shared
// Custom-LLM agent. Retell does speech recognition, the voice, turn-taking and interruptions, and connects back to our
// WebSocket (/api/receptionist/llm/<secret>/<call_id>) where OUR engine produces every reply. The agent holds no
// business knowledge, prompt or functions. So a published rule set needs NO Retell agent change: it takes effect
// inside our engine, per call, for businesses in AI_RULES_LIVE_BUSINESSES. Agent-level voice settings (turn-taking,
// reminders, interruption sensitivity) are shared by every business and stay in scripts/retell-setup.mjs (approval).
import { voiceStatus } from '../receptionist/voice.js'
import { rulesLiveFor } from './access.js'

export const retellAdapter = {
  id: 'retell',
  mode: 'custom_llm',
  plan(env, { customerId, version }) {
    const live = rulesLiveFor(env, customerId)
    const voice = voiceStatus(env, customerId)
    // Owner-facing sentences (the Publish panel shows them): whether customers get published rules NOW, in plain
    // words. No vendor name, no internal switch name.
    const notes = [live ? `Published version ${version ?? '—'} is used by your receptionist now (chat${voice === 'available' ? ' and voice' : ''}).` : 'Customers don’t get published rules yet: GetShowUps switches them on business by business, and until then your receptionist answers the way it does today.']
    if (live && voice !== 'available') notes.push('Browser voice isn’t on for your business yet, so the rules apply to chat.')
    return { provider: 'retell', mode: 'custom_llm', providerChanges: [], servedBy: 'getshowups_engine', live, voice, notes }
  },
}

export const voiceAdapter = () => retellAdapter
