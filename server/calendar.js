// Read-only Google Calendar access for one customer, shared by the admin health check and the
// customer dashboard. Only free/busy data is ever requested; event details are never read.
// Results contain status codes and allowlisted error codes only: no tokens, no event data.
import { CALENDAR_SCOPES, decrypt, googleApi, googleFetch, oauthClient, refreshAccessToken } from './google-oauth.js'
const CODE_RE = /^[A-Za-z_]{1,40}$/
const safeCode = (value) => (typeof value === 'string' && CODE_RE.test(value) ? value : 'other')

// Loads google:<customer>, decrypts the refresh token, and gets a short-lived access token.
// Failure: { ok: false, httpStatus, status, extra }. Success adds accessToken (use and discard).
export async function connect(env, customer) {
  let record
  try {
    const raw = await env.GOOGLE_TOKENS.get(`google:${customer}`)
    if (!raw) return { ok: false, httpStatus: 404, status: 'not_connected', extra: {} }
    record = JSON.parse(raw)
  } catch (err) {
    console.error('calendar: KV read failed:', customer, err?.name)
    return { ok: false, httpStatus: 503, status: 'storage_error', extra: {} }
  }
  if (record?.customer !== customer || typeof record?.refreshToken !== 'string') {
    console.error('calendar: malformed record:', customer)
    return { ok: false, httpStatus: 500, status: 'record_invalid', extra: {} }
  }

  const granted = new Set(String(record.scope || '').split(' '))
  const scopes = { ok: CALENDAR_SCOPES.every((s) => granted.has(s)) }

  let refreshToken
  try {
    refreshToken = await decrypt(env, record.refreshToken)
  } catch {
    console.error('calendar: decrypt failed:', customer)
    return { ok: false, httpStatus: 500, status: 'decrypt_failed', extra: { scopes } }
  }

  const client = oauthClient(env, record.clientId)
  const token = await refreshAccessToken(env, refreshToken, client)
  if (!token.ok) {
    console.error('calendar: token refresh failed:', customer, token.httpStatus, token.error)
    const status = token.error === 'invalid_grant' ? 'reconnect_required' : 'token_refresh_failed'
    return { ok: false, httpStatus: 502, status, extra: { scopes, oauthClient: client.kind, token: { httpStatus: token.httpStatus, error: token.error } } }
  }

  return {
    ok: true,
    accessToken: token.accessToken,
    scopes,
    oauthClient: client.kind,
    token: { httpStatus: token.httpStatus },
    account: { email: record.email || null, connectedAt: record.connectedAt || null },
  }
}

// freeBusy.query on the primary calendar. Returns busy intervals only (start/end), never events.
export async function freeBusy(env, accessToken, timeMin, timeMax) {
  let res
  try {
    res = await googleFetch(env, `${googleApi(env).calendar}/freeBusy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), items: [{ id: 'primary' }] }),
    })
  } catch {
    return { ok: false, httpStatus: 0, error: 'network_error' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, httpStatus: res.status, error: safeCode(body?.error?.status) }
  // freeBusy answers 200 even when one calendar fails, with a per-calendar errors array.
  const primary = body?.calendars?.primary
  if (!primary || primary.errors?.length) {
    return { ok: false, httpStatus: res.status, error: safeCode(primary?.errors?.[0]?.reason) }
  }
  const busy = (Array.isArray(primary.busy) ? primary.busy : [])
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
  return { ok: true, httpStatus: res.status, busy }
}

// Full connection check (used by GET /api/admin/google-health). Response body shape is stable.
export async function checkConnection(env, customer) {
  const checkedAt = new Date().toISOString()
  const result = (httpStatus, status, extra = {}) => ({ httpStatus, body: { customer, status, checkedAt, ...extra } })

  const conn = await connect(env, customer)
  if (!conn.ok) return result(conn.httpStatus, conn.status, conn.extra)

  const now = Date.now()
  const calendar = await freeBusy(env, conn.accessToken, now, now + 24 * 60 * 60 * 1000)
  if (!calendar.ok) {
    console.error('calendar: freeBusy failed:', customer, calendar.httpStatus, calendar.error)
    return result(502, 'calendar_error', {
      scopes: conn.scopes,
      oauthClient: conn.oauthClient,
      token: conn.token,
      calendar: { httpStatus: calendar.httpStatus, error: calendar.error },
    })
  }
  return result(200, 'healthy', {
    scopes: conn.scopes,
    oauthClient: conn.oauthClient,
    token: conn.token,
    calendar: { httpStatus: calendar.httpStatus, check: 'freeBusy.query primary' },
  })
}

// Creates the appointment on the owner's primary calendar and invites the lead (Google emails the
// invitation and applies its normal reminders). `id` is chosen by us (base32hex) so a retry after a
// timeout cannot create a duplicate: Google answers 409 if the first attempt already landed.
// Returns { ok, eventId } or a sanitized failure with `retryable` (network/timeout/5xx).
export async function createEvent(env, accessToken, { id, start, end, timeZone, summary, description, attendee }) {
  let res
  try {
    res = await googleFetch(env, `${googleApi(env).calendar}/calendars/primary/events?sendUpdates=all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        summary,
        description,
        start: { dateTime: new Date(start).toISOString(), timeZone },
        end: { dateTime: new Date(end).toISOString(), timeZone },
        attendees: [attendee],
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 24 * 60 }, { method: 'popup', minutes: 60 }] },
      }),
    })
  } catch {
    return { ok: false, httpStatus: 0, error: 'network_error', retryable: true }
  }
  const body = await res.json().catch(() => ({}))
  if (res.status === 409) return { ok: true, eventId: id, duplicate: true }
  if (!res.ok || typeof body.id !== 'string') {
    return { ok: false, httpStatus: res.status, error: safeCode(body?.error?.status), retryable: res.status >= 500 }
  }
  return { ok: true, eventId: body.id }
}

// Best effort cleanup when a booking cannot be recorded after the event was created.
export async function deleteEvent(env, accessToken, eventId) {
  try {
    await googleFetch(env, `${googleApi(env).calendar}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch (err) {
    console.error('calendar: event cleanup failed:', err?.name)
  }
}

// ---------- availability math (pure, no I/O) ----------

const partsIn = (ts, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts))
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') }
}

// Offset (ms) of timeZone from UTC at instant ts.
function offsetAt(ts, timeZone) {
  const p = partsIn(ts, timeZone)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000
}

// Converts a wall-clock time in timeZone to a UTC instant (DST-aware).
export function zonedToUtc(y, m, d, h, mi, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  let ts = guess - offsetAt(guess, timeZone)
  const corrected = guess - offsetAt(ts, timeZone)
  if (corrected !== ts) ts = corrected
  return ts
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return typeof tz === 'string' && tz.length > 0
  } catch {
    return false
  }
}

const hm = (s) => s.split(':').map(Number)

// Open slots within booking hours that do not overlap any busy interval and start after `now`.
// rules: { timezone, slotMinutes, dayStart 'HH:MM', dayEnd 'HH:MM', workdays [0-6] }
// Returns { slots: [{ start, end }] (epoch ms), rangeStart, rangeEnd }.
export function computeSlots({ busy, rules, now, days }) {
  const today = partsIn(now, rules.timezone)
  const [sh, sm] = hm(rules.dayStart)
  const [eh, em] = hm(rules.dayEnd)
  const slotMs = rules.slotMinutes * 60 * 1000
  const slots = []
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d + i))
    if (!rules.workdays.includes(date.getUTCDay())) continue
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    const dayEnd = zonedToUtc(y, m, d, eh, em, rules.timezone)
    for (let start = zonedToUtc(y, m, d, sh, sm, rules.timezone); start + slotMs <= dayEnd; start += slotMs) {
      const end = start + slotMs
      if (start < now) continue
      if (busy.some((b) => b.start < end && b.end > start)) continue
      slots.push({ start, end })
    }
  }
  const last = new Date(Date.UTC(today.y, today.m - 1, today.d + days))
  return {
    slots,
    rangeStart: now,
    rangeEnd: zonedToUtc(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate(), 0, 0, rules.timezone),
  }
}

// True when `start` is exactly one of the bookable slot starts (ignoring busy time), so a client
// can only request times that the booking hours actually offer.
export function isOfferedSlot({ rules, now, days, start }) {
  return computeSlots({ busy: [], rules, now, days }).slots.some((s) => s.start === start)
}
