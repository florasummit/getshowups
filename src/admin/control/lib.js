// Control Center helpers (not components): URL state + formatting.
import { useCallback, useEffect, useState } from 'react'
import { fmt } from '../../lib/api.js'

export const BASE = '/admin/control'
// Params that describe "where am I" in the Control Center.
const KEYS = ['view', 'incident', 'business', 'integration', 'run', 'session', 'journey', 'filter', 'q', 'for']

export const hrefFor = (params = {}) => {
  const p = new URLSearchParams()
  for (const k of KEYS) if (params[k]) p.set(k, params[k])
  const s = p.toString()
  return s ? `${BASE}?${s}` : BASE
}
const readParams = () => {
  const p = new URLSearchParams(window.location.search)
  return Object.fromEntries(KEYS.map((k) => [k, p.get(k)]).filter(([, v]) => v))
}

// The current location + navigate(). Navigating scrolls to the top and moves focus to the new page heading.
// After a navigation, the next page heading that mounts takes focus (screen readers + keyboard land on the new page,
// even when its data arrives later).
let focusPending = false
export const takeFocus = () => {
  const f = focusPending
  focusPending = false
  return f
}
export function useLocation() {
  const [params, setParams] = useState(readParams)
  useEffect(() => {
    const onPop = () => setParams(readParams())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next, { replace = false } = {}) => {
    const href = typeof next === 'string' ? next : hrefFor(next)
    window.history[replace ? 'replaceState' : 'pushState'](null, '', href)
    setParams(readParams())
    if (!replace) {
      window.scrollTo({ top: 0 })
      focusPending = true
    }
  }, [])
  return [params, go]
}

export const when = (ms) => (ms ? fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
export const day = (ms) => (ms ? fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
export function ago(ms, now = Date.now()) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
export const mins = (ms) => (ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`)
export const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`

