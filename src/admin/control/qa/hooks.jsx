// QA Command Center hooks: loading with the four designed states, and the plan dialog a screen opens before a run.
import { useCallback, useEffect, useRef, useState } from 'react'
import { PlanPanel } from './parts.jsx'
import * as qa from '../qa-api.js'

// Load data with the four designed states: undefined = loading, { error, status } = failed (with a retry), else the
// data. Results are kept per request key, so a changed filter shows "Loading" again instead of the previous list.
// reload() loads again from scratch; reload(true) refreshes in place (forms on the page keep what they hold).
export function useLoad(fn, deps) {
  const [n, setN] = useState(0)
  const key = JSON.stringify([...deps, n])
  const [got, setGot] = useState({ key: null, data: undefined })
  const latest = useRef({ fn, key })
  useEffect(() => {
    latest.current = { fn, key }
  })
  useEffect(() => {
    let live = true
    latest.current.fn().then((r) => live && setGot({ key, data: r.ok ? r.data : { error: r.error || 'failed', status: r.status } }))
    return () => {
      live = false
    }
  }, [key])
  const reload = useCallback((soft) => {
    if (soft !== true) return setN((x) => x + 1)
    const { fn: f, key: k } = latest.current
    f().then((r) => r.ok && setGot((g) => (g.key === k ? { key: k, data: r.data } : g)))
  }, [])
  const setData = useCallback((data) => setGot({ key: latest.current.key, data }), [])
  return [got.key === key ? got.data : undefined, reload, setData]
}

// One place that owns "which plan is open" for a screen.
export function usePlan(go) {
  const [plan, setPlan] = useState(null)
  const open = useCallback((scope, title) => setPlan({ scope, title }), [])
  const panel = plan ? <PlanPanel key={JSON.stringify(plan.scope)} scope={plan.scope} title={plan.title} go={go} onClose={() => setPlan(null)} /> : null
  return [open, panel]
}


// The product areas the server's inventory knows (one request per page load, shared by every screen that asks).
let areasOnce = null
export function useAreas() {
  const [areas, setAreas] = useState([])
  useEffect(() => {
    let live = true
    areasOnce ||= qa.getInventory({}).then((r) => (r.ok ? qa.normalizeInventory(r.data).areaList : null))
    areasOnce.then((list) => {
      if (!list) areasOnce = null // failed: ask again next time
      if (live) setAreas(list || [])
    })
    return () => {
      live = false
    }
  }, [])
  return areas
}
