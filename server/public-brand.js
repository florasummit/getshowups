// A business's own brand for its public booking and chat pages: the logo and accent colour from its PUBLISHED website
// (never a draft), so the pages look like the business, not like GetShowUps. Nothing published → name only, neutral
// accent. GetShowUps' own pages use the GetShowUps brand (src/components/Logo.jsx). Fails soft: no brand, never an error.
import { COLORS, hostingStatus, isHosted, liveContent } from './website.js'
import { PALETTES } from './site-design.js'
import { SALES_BUSINESS } from './public.js'

const HEX = /^#[0-9a-f]{6}$/i
const ASSET = /^[A-Za-z0-9_-]{6,64}$/

export function accentOf(content) {
  const v2 = content?.site?.theme?.colors?.accent
  if (HEX.test(v2 || '')) return v2.toLowerCase()
  const designed = PALETTES[content?.design?.palette]?.accent
  if (HEX.test(designed || '')) return designed.toLowerCase()
  const classic = COLORS[content?.color]
  return HEX.test(classic || '') ? classic.toLowerCase() : null
}

export async function publicBrand(env, customer) {
  if (customer.id === SALES_BUSINESS) return { product: true, logo: null, accent: null }
  try {
    const db = env.ONBOARDING_DB
    if (!isHosted(await hostingStatus(db, customer.id, Date.now(), env))) return { product: false, logo: null, accent: null }
    const live = await liveContent(db, customer.id)
    const logo = typeof live?.content?.logo === 'string' && ASSET.test(live.content.logo) ? `/site-assets/${live.content.logo}` : null
    return { product: false, logo, accent: live ? accentOf(live.content) : null }
  } catch {
    return { product: false, logo: null, accent: null }
  }
}
