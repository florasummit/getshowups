// Stale-write protection for business settings (profile, policies, booking hours). A settings form sends `base`: the
// values it loaded. If the stored values differ (changed in another tab or device, or by onboarding meanwhile), the
// save is refused with 409 { error: 'conflict', current } instead of silently replacing newer settings.
// Value based (no version column, no migration). Optional: a page without `base` (older release) saves as before.
// The website draft uses its own version stamp (server/website.js saveDraft `expect`).

const canon = (v) =>
  JSON.stringify(v ?? null, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  )

export const hasBase = (body) => Boolean(body && typeof body.base === 'object' && body.base !== null && !Array.isArray(body.base))

// `current` and `base` in the same shape (what the GET route returns); only the keys of `current` are compared.
export function isStale(body, current) {
  if (!hasBase(body)) return false
  const cur = current ?? {}
  const base = Object.fromEntries(Object.keys(cur).map((k) => [k, body.base[k] ?? null]))
  return canon(Object.fromEntries(Object.keys(cur).map((k) => [k, cur[k] ?? null]))) !== canon(base)
}

// The booking-hours fields of a session customer, in the form's shape.
export const hoursOf = (c) => ({ workdays: c.workdays, dayStart: c.dayStart, dayEnd: c.dayEnd, slotMinutes: c.slotMinutes })
