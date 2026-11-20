// Homepage funnel events. NOTHING IS SENT ANYWHERE: GetShowUps has no browser analytics endpoint or vendor today, and
// adding one needs approval (a public, rate-limited POST into the existing `events` table). Until then each event is
// dispatched in the page as a `gsu:analytics` CustomEvent (tests listen to it) and kept in window.__gsuEvents, so a
// future sender can be wired in ONE place without touching the components.
// Rules: event names from the allowlist only; props are short codes (industry, step, location), never personal data,
// never text a visitor typed.
const NAMES = new Set([
  'hero_cta', // { cta: 'early_access' | 'see_it_work' | 'industry', industry? }
  'demo_started', // { industry }
  'demo_industry', // { industry }
  'demo_step', // { industry, step: 'inquiry' | 'check' | 'book' | 'after', path?: 'in_area' | 'outside' }
  'demo_finished', // { industry, outcome }
  'demo_reset', // { industry }
  'demo_mode', // { mode: 'conversation' | 'booking' }
  'conversation_started', // { industry }
  'conversation_industry', // { industry }
  'conversation_finished', // { industry }
  'early_access_cta', // { location: 'header' | 'hero' | 'demo' | 'pricing' | 'footer' | 'mobile_nav' }
  'early_access_open', // { how: 'embed_visible' | 'new_tab' }
])
const CODE = /^[a-z0-9_]{1,32}$/

export function track(name, props = {}) {
  if (!NAMES.has(name) || typeof window === 'undefined') return
  const clean = {}
  for (const [k, v] of Object.entries(props)) if (CODE.test(k) && typeof v === 'string' && CODE.test(v)) clean[k] = v
  const detail = { name, props: clean, at: Date.now() }
  try {
    ;(window.__gsuEvents ||= []).push(detail)
    window.dispatchEvent(new CustomEvent('gsu:analytics', { detail }))
  } catch {
    // never break the page for analytics
  }
}
