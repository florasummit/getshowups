// Hooks of the shared UI kit (components live in ./ui.jsx; docs/DESIGN_SYSTEM.md "How to use the shared primitives").
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const IDLE = { status: 'idle', message: '' }
const GENERIC_ERROR = 'Couldn’t save. Please try again.'

// How long a "Saved" confirmation stays: about 2.5 s for the plain word, longer for a sentence (never over 8 s).
export const savedHoldMs = (message) => Math.min(8000, Math.max(2500, String(message || '').length * 60))

// THE save pattern: one hook per save control (a form's button, or a switch / select / field that saves on change).
//   const save = useSaveState()
//   save.run(async () => {
//     const { status, data } = await api('/api/…', { method: 'POST', body })
//     if (status !== 200) return { error: 'Use ZIP codes separated by commas.' }   // stays, role=alert
//     return { saved: 'Saved. Customers see it now.' }                              // or nothing → "Saved."
//   })                                                                              // return false → nothing to save
// Whatever happens (success, refusal, thrown error, nothing to save) the control is enabled again when run() settles.
// save.status: 'idle' | 'saving' | 'saved' | 'error' · save.pending · save.message · save.reset() · save.fail(text)
export function useSaveState() {
  const [state, setState] = useState(IDLE)
  const timer = useRef(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
  }, [])
  const set = useCallback((next) => {
    clearTimeout(timer.current)
    if (!alive.current) return // the form went away (e.g. onboarding moved to the next step): nothing to show
    setState(next)
    if (next.status === 'saved') timer.current = setTimeout(() => alive.current && setState(IDLE), savedHoldMs(next.message))
  }, [])
  const run = useCallback(
    async (fn) => {
      set({ status: 'saving', message: '' })
      let result
      try {
        result = await fn()
      } catch {
        result = { error: GENERIC_ERROR }
      }
      if (result === false) set(IDLE)
      else if (result?.error) set({ status: 'error', message: result.error === true ? GENERIC_ERROR : String(result.error) })
      else set({ status: 'saved', message: typeof result?.saved === 'string' ? result.saved : 'Saved.' })
      return result
    },
    [set],
  )
  const reset = useCallback(() => set(IDLE), [set])
  const fail = useCallback((message) => set({ status: 'error', message: message || GENERIC_ERROR }), [set])
  return useMemo(() => ({ ...state, pending: state.status === 'saving', run, reset, fail }), [state, run, reset, fail])
}

// The browser tab title of an app page: "<page> · GetShowUps". Call it where the current page is decided (the shell),
// so the title follows every in-app navigation, not only a full page load.
export function usePageTitle(title) {
  useEffect(() => {
    if (title) document.title = `${title} · GetShowUps`
  }, [title])
}
