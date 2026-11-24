// Loads the page suggestions (Insight.jsx): on opening the dashboard, then at most every five minutes on navigation.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const FRESH_MS = 300_000

export function useInsights(view) {
  const [s, setS] = useState({ list: [], at: 0 })
  const load = useCallback(() => api('/api/dashboard/insights').then(({ status, data }) => status === 200 && setS({ list: data.insights || [], at: Date.now() })), [])
  useEffect(() => {
    if (Date.now() - s.at > FRESH_MS) load()
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener('gsu:changed', load)
    return () => window.removeEventListener('gsu:changed', load)
  }, [load])
  return [s.list, (id) => setS((x) => ({ ...x, list: x.list.filter((i) => i.id !== id) }))]
}
