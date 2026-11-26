// The browser tab and description of a business's public page (booking, chat): the business's own name, never
// GetShowUps' marketing title, description or price. The server already sends a neutral head for these routes
// (server/public-head.js); this names the business once its record has loaded, and covers the dev server.
export function publicHead(title, description) {
  document.title = title
  const meta = document.querySelector('meta[name="description"]')
  if (meta) meta.setAttribute('content', description)
  for (const el of document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')) el.remove()
}

// "Eastern Time" for America/New_York: the zone in plain words (the generic name, so it reads the same all year);
// older browsers fall back to the seasonal name, then to the zone id.
export function zoneName(timeZone, at = Date.now()) {
  for (const timeZoneName of ['longGeneric', 'long']) {
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')
      if (part?.value) return part.value
    } catch {
      // this style isn't supported here: try the next
    }
  }
  return String(timeZone || '').replaceAll('_', ' ')
}

export const telHref = (p) => `tel:${String(p || '').replace(/[^\d+]/g, '')}`

// "Too many attempts" with the time it ends (BOOK-10), from the server's Retry-After.
export function lockoutText(retryAfter, now = Date.now()) {
  if (!retryAfter) return 'Too many attempts. Please wait a few minutes and try again.'
  const minutes = Math.max(1, Math.ceil(retryAfter / 60))
  const at = new Date(Math.ceil((now + retryAfter * 1000) / 60000) * 60000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `Too many attempts. Please try again in ${minutes === 1 ? 'about a minute' : `about ${minutes} minutes`} (after ${at}). What you typed is kept.`
}
