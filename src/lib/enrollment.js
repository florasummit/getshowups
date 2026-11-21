// Is online enrollment open to the public? One request per page load, shared by every caller.
// true / false from GET /api/enrollment; null while loading or when it can't be read. Callers treat null like the
// default "Get started" (the sign-up screen and the server still say no), so a failed check never hides sign-in.
import { useEffect, useState } from 'react'
import { enrollmentClosed, getStarted } from '../content/site.js'

let pending = null
export function fetchEnrollment() {
  pending ??= fetch('/api/enrollment', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (typeof d?.open === 'boolean' ? { open: d.open, salesChat: d.salesChat === true } : null))
    .catch(() => null)
  return pending
}

function useEnrollment() {
  const [state, setState] = useState(null)
  useEffect(() => {
    let live = true
    fetchEnrollment().then((v) => live && setState(v))
    return () => {
      live = false
    }
  }, [])
  return state
}

export function useEnrollmentOpen() {
  return useEnrollment()?.open ?? null
}

// GetShowUps selling itself: true only when the GetShowUps business runs its own receptionist (server/public.js
// salesChatAvailable), so the homepage can offer that chat; false while loading or when it can't be read.
export const SALES_BUSINESS = 'getshowups'
export function useSalesChat() {
  return useEnrollment()?.salesChat === true
}

// The marketing site's start action: Get started (open or unknown) or Request early access (closed).
export function useStartAction() {
  const open = useEnrollmentOpen()
  return open === false ? { ...enrollmentClosed, closed: true } : { ...getStarted, closed: false }
}
