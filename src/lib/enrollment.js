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

// While public sign-up is closed, people we have arranged a start with (testers, businesses set up by hand) get a
// clear entry on the "Welcome back" sign-in page, never on the public homepage (founder decision: no sign-up entry of
// any form there until enrollment opens). This address opens the sign-up screen worded for them. It grants nothing:
// after Google sign-in the server decides who may create a business, exactly as for any other link.
export const INVITED_HREF = '/dashboard?plan=founding&invited=1'
export const CONTACT_EMAIL = 'hello@getshowups.com'

// GetShowUps selling itself: true only when the GetShowUps business runs its own receptionist (server/public.js
// salesChatAvailable), so the homepage can offer that chat; false while loading or when it can't be read.
export const SALES_BUSINESS = 'getshowups'
export function useSalesChat() {
  return useEnrollment()?.salesChat === true
}

// Our own booking page for a call with the founder: GetShowUps' consultation calendar, through the same booking
// product every customer gets (lead captured, qualified, booked on the calendar, attributed). Campaign codes the
// visitor arrived with are passed on unchanged; without any, the link says which homepage button was used
// (utm_source=homepage, utm_campaign=cta_<location>), so Admin → Growth can read prospects by source. Codes only.
const CODE = /^[A-Za-z0-9_.-]{1,64}$/
export function salesBookingHref(location = 'cta', search = typeof window === 'undefined' ? '' : window.location.search) {
  const inbound = new URLSearchParams(search)
  const out = new URLSearchParams()
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) if (CODE.test(inbound.get(k) || '')) out.set(k, inbound.get(k))
  if (/^[A-Za-z0-9_-]{10,200}$/.test(inbound.get('gclid') || '')) out.set('gclid', inbound.get('gclid'))
  if (!out.has('utm_source')) {
    out.set('utm_source', 'homepage')
    out.set('utm_medium', 'site')
    out.set('utm_campaign', `cta_${String(location).replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'cta'}`)
  }
  return `/book/${SALES_BUSINESS}?${out}`
}

// The marketing site's start action: Get started (open or unknown) or Request early access (closed). While closed and
// GetShowUps' own sales booking is running (enrollment.salesChat: bookable + receptionist on), early access goes
// straight to that booking page; otherwise to the section on this page (unchanged behaviour).
export function useStartAction() {
  const e = useEnrollment()
  if (e?.open !== false) return { ...getStarted, closed: false, salesBooking: false }
  return { ...enrollmentClosed, closed: true, salesBooking: e.salesChat === true }
}
