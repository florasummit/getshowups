// Shared state of the admin assistant (AdminAssistant.jsx): panel open/closed and the weekly brief, fetched once for the
// "This week" card, the header button and the panel's first message.
import { useSyncExternalStore } from 'react'
import { api } from '../lib/api.js'

let state = { open: false, brief: null, enabled: false, loaded: false }
const subs = new Set()
export const setAssistant = (patch) => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
export const useAssistant = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state)
export const openAssistant = () => setAssistant({ open: true })

let loading = null
export function loadBrief(force = false) {
  if (loading && !force) return loading
  loading = api('/api/platform/assist').then(({ status, data }) => setAssistant(status === 200 ? { brief: data.brief, enabled: data.enabled, loaded: true } : { brief: null, loaded: true }))
  return loading
}
