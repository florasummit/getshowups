// Website data helpers shared by the Website tab and onboarding (no components here).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../lib/api.js'

const FIELD_LABELS = { headline: 'Headline', intro: 'Introduction', about: 'About', services: 'Services', area: 'Service area', highlights: 'Facts', seoTitle: 'Search title', seoDescription: 'Search description', images: 'Photos', photos: 'Photos' }
export function problemText(fields = []) {
  const claim = fields.find((f) => f.endsWith(':unapproved_claim'))
  if (claim) return `${FIELD_LABELS[claim.split(':')[0]]}: please remove promises like guarantees, discounts, ratings or credentials unless we’ve confirmed them with you.`
  return fields.length ? `Please check: ${[...new Set(fields.map((f) => FIELD_LABELS[f] || f))].join(', ')}.` : 'Couldn’t save. Please try again.'
}

// Loads the website state once (shared by the Website tab and onboarding steps).
export function useWebsite() {
  const [data, setData] = useState(null)
  useEffect(() => {
    api('/api/dashboard/website').then(({ status, data: d }) => setData(status === 200 ? d : { failed: true }))
  }, [])
  return [data, setData]
}

// ---- An AI result the owner hasn't answered yet (three designs to choose from, or a "Describe a change" version) ----
// Kept in this browser until the owner chooses, so a reload doesn't lose what the daily allowance already paid for
// (finding WEB-10). Only the id and the design names are remembered; the server still holds the result itself, and a
// result it no longer has (or another business's) is dropped when the page checks it. Storage may be unavailable
// (private mode): then nothing is remembered and everything else works as before.
const PENDING_TTL = 24 * 60 * 60 * 1000
const pendingKey = (kind, storeKey) => `gsu-site-${kind}:${storeKey || 'site'}`
export function rememberPending(kind, storeKey, generation) {
  try {
    if (!generation) return window.localStorage.removeItem(pendingKey(kind, storeKey))
    const kept = { id: generation.id, source: generation.source, designs: (generation.designs || []).map((d) => ({ name: d?.name || '' })), at: Date.now() }
    window.localStorage.setItem(pendingKey(kind, storeKey), JSON.stringify(kept))
  } catch {
    /* nothing is remembered */
  }
}
export async function recallPending(kind, storeKey, query = '') {
  try {
    const kept = JSON.parse(window.localStorage.getItem(pendingKey(kind, storeKey)) || 'null')
    if (!kept || !/^[a-f0-9]{32}$/.test(kept.id) || Date.now() - kept.at > PENDING_TTL) return rememberPending(kind, storeKey, null) || null
    // Still this business's, still stored? (The preview route answers 404 otherwise.)
    const res = await fetch(`/api/dashboard/website/preview?generation=${kept.id}&option=0&${query}`, { credentials: 'same-origin' })
    if (res.status !== 200) return rememberPending(kind, storeKey, null) || null
    return kept
  } catch {
    return null
  }
}

// A "Describe a change" version waiting for Keep this / Go back. Shared by the revise box (which sets it) and anything
// that must not claim "saved" or let the owner walk past it meanwhile (the editor's save line, a step's Continue
// button): finding ONB-09. One website editor is on screen at a time, so one value is enough.
let pendingRevision = null
const watchers = new Set()
export function setPendingRevision(rev) {
  pendingRevision = rev || null
  for (const w of watchers) w()
}
const watch = (fn) => (watchers.add(fn), () => watchers.delete(fn))
export const usePendingRevision = () => useSyncExternalStore(watch, () => pendingRevision)
