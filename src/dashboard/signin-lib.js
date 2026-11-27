// Email sign-in helpers for the sign-in screens (src/dashboard/SignIn.jsx): whether it is offered, and the pending
// "Check your email" step kept for this tab, so a reload keeps the code screen.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const PENDING_KEY = 'gsu_email_signin' // { email, sentAt, next } for this tab: a reload keeps the code screen
const TTL_MS = 15 * 60 * 1000

// Offered to everyone once email sign-in is live; ?email=1 shows it before that (testers; the server still decides).
let offeredOnce
export function useEmailOffered() {
  const forced = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('email') === '1'
  const [offered, setOffered] = useState(forced || offeredOnce === true)
  useEffect(() => {
    if (forced || offeredOnce !== undefined) return
    api('/api/auth/email').then(({ status, data }) => {
      offeredOnce = status === 200 && data.offered === true
      setOffered(offeredOnce)
    })
  }, [forced])
  return offered
}

export const readPending = (next) => {
  try {
    const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null')
    return p && typeof p.email === 'string' && Date.now() - p.sentAt < TTL_MS && p.next === next ? p : null
  } catch {
    return null
  }
}
export const writePending = (p) => {
  try {
    if (p) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // storage unavailable: a reload returns to the email field
  }
}
