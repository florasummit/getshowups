/**
 * GoHighLevel (GHL) integration points — frontend side.
 *
 * These are PUBLIC embed URLs only. Anything read from import.meta.env.VITE_*
 * is compiled into the client bundle, so never place API keys, private
 * integration tokens, or inbound-webhook secrets here. Server-side GHL calls
 * (contacts API, workflows, webhooks) belong in a backend such as a
 * Cloudflare Pages Function, not in this file.
 *
 * Integration points:
 *   1. bookingUrl  → GHL calendar widget, rendered in <BookDemo /> as an iframe.
 *   2. leadFormUrl → GHL form/survey widget, fallback lead capture in <BookDemo />.
 *   3. contactEmail → plain mailto fallback when nothing is connected.
 *
 * When a value is missing, the UI shows an honest "not connected yet" state
 * instead of a fake form.
 */

function readHttpsUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function readEmail(value) {
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}

export const ghl = {
  bookingUrl: readHttpsUrl(import.meta.env.VITE_GHL_BOOKING_URL),
  leadFormUrl: readHttpsUrl(import.meta.env.VITE_GHL_FORM_URL),
  contactEmail: readEmail(import.meta.env.VITE_CONTACT_EMAIL),
}

export const isBookingConnected = Boolean(ghl.bookingUrl)
export const isLeadFormConnected = Boolean(ghl.leadFormUrl)
