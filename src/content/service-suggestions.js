// Starting points an owner can add with one tap (setup and Settings → Services and prices). Suggestions only: a business
// offers what the owner lists, never everything in its industry. Matched on the owner's own industry words.
export const SUGGESTED = {
  'pool service': ['Weekly pool cleaning', 'Pool opening', 'Pool closing', 'Green pool cleanup', 'Equipment repair'],
  'lawn care': ['Lawn mowing', 'Fertilization', 'Aeration', 'Leaf cleanup'],
  'house cleaning': ['Standard cleaning', 'Deep cleaning', 'Move-out cleaning'],
  'pest control': ['General pest treatment', 'Termite inspection', 'Mosquito treatment'],
  hvac: ['AC repair', 'Furnace repair', 'System tune-up', 'New system estimate'],
  plumbing: ['Leak repair', 'Drain cleaning', 'Water heater service'],
  'pressure washing': ['House washing', 'Driveway cleaning', 'Deck cleaning'],
}

// The owner's industry text → suggestions not already on their list ("Pool service & repair" matches pool service).
export function suggestionsFor(industry, have = []) {
  const text = String(industry || '').toLowerCase()
  const key = Object.keys(SUGGESTED).find((k) => text === k || text.includes(k) || (k === 'pool service' && /\bpool/.test(text)) || (k === 'hvac' && /\b(hvac|heating|air condition)/.test(text)))
  const taken = new Set(have.map((n) => String(n).trim().toLowerCase()))
  return key ? { label: key, names: SUGGESTED[key].filter((n) => !taken.has(n.toLowerCase())) } : null
}
