// Same-origin JSON helper. Session auth rides on the HttpOnly cookie; nothing secret lives here.
export async function api(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  } catch {
    return { status: 0, data: { error: 'network_error' } }
  }
}

export const fmt = (iso, timeZone, opts) => new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(iso))

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
  } catch {
    return 'America/New_York'
  }
}

export const timeZones = () => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return [browserTimeZone()]
  }
}

// Adds a noindex robots tag while an app page is mounted.
export function noIndex() {
  const meta = document.createElement('meta')
  meta.name = 'robots'
  meta.content = 'noindex'
  document.head.appendChild(meta)
  return () => meta.remove()
}
