// Small pure helpers of the owner dashboard, shared by its components and unit-tested (test/owner-lib.test.js). No React.

// Bring one card of the current page into view (the Settings menu, links that name a card). The card may not be on the
// page yet (the page was just opened): tried again for a few seconds.
export const scrollToCard = (id, tries = 30) => {
  const el = document.getElementById(id)
  if (!el) return tries > 0 && setTimeout(() => scrollToCard(id, tries - 1), 100)
  el.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  return true
}

// A service's listed price as cents, only when it is a plain amount ("$95", "$1,200", "$95 per visit"). "From $150",
// "$300+ per month", "$95 diagnostic" or a range is not the amount of one visit and is never suggested.
export const plainPrice = (price) => {
  const m = /^\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?(\s+(flat|each|per (visit|job|service|appointment)|a visit))?$/i.exec(String(price ?? '').trim())
  return m ? Math.round(Number(`${m[1].replace(/,/g, '')}${m[2] || ''}`) * 100) : null
}

// Time zones: the US ones by the names people use. The stored value stays the zone id ("America/New_York").
export const US_ZONES = [
  ['America/New_York', 'Eastern Time'],
  ['America/Chicago', 'Central Time'],
  ['America/Denver', 'Mountain Time'],
  ['America/Phoenix', 'Mountain Time: Arizona (no daylight saving)'],
  ['America/Los_Angeles', 'Pacific Time'],
  ['America/Anchorage', 'Alaska Time'],
  ['Pacific/Honolulu', 'Hawaii Time'],
]
// Zones in the United States (the named ones and the local variants browsers report), where a ZIP code is five digits.
const US_ZONE = /^America\/(New_York|Chicago|Denver|Phoenix|Los_Angeles|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Yakutat|Metlakatla|Adak|Menominee|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)$|^Pacific\/Honolulu$/
export const isUsZone = (tz) => US_ZONE.test(String(tz))

// Entries of a typed ZIP list that aren't five digits. Only for a US business: other countries' postal codes are left
// alone (the server accepts them on purpose, server/customers.js).
export const oddZips = (text, timezone) => (isUsZone(timezone) ? [...new Set(String(text).split(/[\s,]+/).filter((z) => z && !/^\d{5}$/.test(z)))] : [])
