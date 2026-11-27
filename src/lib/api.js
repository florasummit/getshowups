// Configure mode (assisted enrollment, server/staff-context.js): GetShowUps staff working on an enrollment's workspace.
// Dashboard requests then name the enrollment (header; the cookie lets preview frames and images show the same
// business). Not a credential: the server checks the staff session, role, assignment and stage on every request.
let staffEnrollment = null
const STAFF_COOKIE = '__Host-gsu_staff'
export function startStaffMode(id) {
  staffEnrollment = id
  try {
    document.cookie = `${STAFF_COOKIE}=${id}; Path=/; Secure; SameSite=Strict; Max-Age=43200`
  } catch {
    // no cookie: frames show nothing for staff; requests still carry the header
  }
}
export function endStaffMode() {
  staffEnrollment = null
  try {
    document.cookie = `${STAFF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`
  } catch {
    // ignore
  }
}
export const staffHeaders = () => (staffEnrollment ? { 'X-GSU-Enrollment': staffEnrollment } : {})

// Same-origin JSON helper. Session auth rides on the HttpOnly cookie; nothing secret lives here.
// keepalive: the request completes even if the page is closing (a voice session's end record on unload; small bodies only).
export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  try {
    const staff = path.startsWith('/api/dashboard/') ? staffHeaders() : {}
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json', ...staff } : { Accept: 'application/json', 'Content-Type': 'application/json', ...staff },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(keepalive ? { keepalive: true } : {}),
    })
    // The session ended while a page was open (expired, or signed out elsewhere): the app says so once (Dashboard.jsx);
    // callers still get the 401. The sign-in check itself (/me) is how a page learns it is signed out at all.
    if (res.status === 401 && path.startsWith('/api/dashboard/') && !path.startsWith('/api/dashboard/me')) window.dispatchEvent(new Event('gsu:signed-out'))
    return { status: res.status, data: await res.json().catch(() => ({})) }
  } catch {
    return { status: 0, data: { error: 'network_error' } }
  }
}

export const fmt = (iso, timeZone, opts) => new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(iso))

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// +18435550104 → (843) 555-0104 for US numbers; anything else is shown as stored. Links keep the E.164 value.
export function phoneText(p) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || ''))
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(p || '')
}

// "just now", "12 min ago", "3 h ago", "yesterday", then a date. Always paired with an absolute time in a title.
export function timeAgo(t, now = Date.now()) {
  const ms = now - new Date(t).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  if (h < 48) return 'yesterday'
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
export const whenFull = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

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
