// GET /api/enrollment — public: can a visitor sign up and pay online right now? { open: boolean, salesChat: boolean, salesPanel: boolean }
// (salesChat: the GetShowUps business runs its own receptionist, so the homepage can offer that chat; server/public.js).
// Lets the homepage and the sign-up screen say "enrollment isn't open yet" BEFORE Google sign-in. Display only: sign-in,
// invitations, admin and tester access are unchanged, and POST /api/dashboard/business still enforces the rule.
import { json } from '../../server/google-oauth.js'
import { enrollmentOpen } from '../../server/onboarding.js'
import { salesChatAvailable, SALES_BUSINESS } from '../../server/public.js'
import { chatPanelSetting } from '../../server/chat-panel.js'
import { hitByIp, tooManyJson } from '../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  if (!env.ONBOARDING_DB) return json(503, { error: 'not_configured' })
  const rl = await hitByIp(env, 'enrollment', request)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    const [open, salesChat] = await Promise.all([enrollmentOpen(env), salesChatAvailable(env)])
    // salesPanel: the GetShowUps business turned on "chat panel on your website" (Receptionist page). Its website is this
    // homepage, so the homepage shows the same panel (server/chat-panel.js) a customer's site gets. Only with salesChat.
    const salesPanel = salesChat && (await chatPanelSetting(env.ONBOARDING_DB, SALES_BUSINESS).catch(() => ({ on: false }))).on
    return json(200, { open, salesChat, salesPanel })
  } catch {
    return json(503, { error: 'unavailable' })
  }
}
