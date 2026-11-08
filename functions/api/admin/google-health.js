// GET /api/admin/google-health?customer=<customer-id>
//   Authorization: Bearer <ADMIN_API_TOKEN>
//
// Read-only check that one customer's stored Google connection still works:
//   1. reads google:<customer> from KV (that key only)
//   2. decrypts the refresh token inside the Worker
//   3. exchanges it for a short-lived access token
//   4. calls freeBusy.query on the primary calendar (allowed by the calendar.freebusy scope)
// Responds with status codes and sanitized error codes only: no tokens, no credentials, no
// calendar or event data. Nothing is written to KV, D1, or Google Calendar.
// Only GET is exported, so Cloudflare Pages answers other methods with 405.
import { CALENDAR_SCOPES, decrypt, isAdmin, json, missingConfig, refreshAccessToken } from '../../../server/google-oauth.js'
import { CUSTOMER_RE } from '../../../server/invites.js'

const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy'
const CODE_RE = /^[A-Za-z_]{1,40}$/
const safeCode = (value) => (typeof value === 'string' && CODE_RE.test(value) ? value : 'other')

async function checkCalendar(accessToken) {
  const now = Date.now()
  let res
  try {
    res = await fetch(FREEBUSY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: new Date(now).toISOString(),
        timeMax: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        items: [{ id: 'primary' }],
      }),
    })
  } catch {
    return { ok: false, httpStatus: 0, error: 'network_error' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, httpStatus: res.status, error: safeCode(body?.error?.status) }
  // freeBusy answers 200 even when one calendar fails, with a per-calendar errors array.
  const calErrors = body?.calendars?.primary?.errors
  if (!body?.calendars?.primary || calErrors?.length) {
    return { ok: false, httpStatus: res.status, error: safeCode(calErrors?.[0]?.reason) }
  }
  return { ok: true, httpStatus: res.status }
}

export async function onRequestGet({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) {
    console.error('Google OAuth not configured; missing:', missing.join(', '))
    return json(503, { error: 'not_configured' })
  }
  if (!(await isAdmin(request, env))) return json(401, { error: 'unauthorized' })

  const customer = (new URL(request.url).searchParams.get('customer') || '').toLowerCase()
  if (!CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_customer' })

  const checkedAt = new Date().toISOString()
  const result = (httpStatus, status, extra = {}) => json(httpStatus, { customer, status, checkedAt, ...extra })

  let record
  try {
    const raw = await env.GOOGLE_TOKENS.get(`google:${customer}`)
    if (!raw) return result(404, 'not_connected')
    record = JSON.parse(raw)
  } catch (err) {
    console.error('google-health: KV read failed:', customer, err?.name)
    return result(503, 'storage_error')
  }
  if (record?.customer !== customer || typeof record?.refreshToken !== 'string') {
    console.error('google-health: malformed record:', customer)
    return result(500, 'record_invalid')
  }

  const granted = new Set(String(record.scope || '').split(' '))
  const scopes = { ok: CALENDAR_SCOPES.every((s) => granted.has(s)) }

  let refreshToken
  try {
    refreshToken = await decrypt(env, record.refreshToken)
  } catch {
    console.error('google-health: decrypt failed:', customer)
    return result(500, 'decrypt_failed', { scopes })
  }

  const token = await refreshAccessToken(env, refreshToken)
  if (!token.ok) {
    console.error('google-health: token refresh failed:', customer, token.httpStatus, token.error)
    const status = token.error === 'invalid_grant' ? 'reconnect_required' : 'token_refresh_failed'
    return result(502, status, { scopes, token: { httpStatus: token.httpStatus, error: token.error } })
  }

  const calendar = await checkCalendar(token.accessToken)
  if (!calendar.ok) {
    console.error('google-health: calendar check failed:', customer, calendar.httpStatus, calendar.error)
    return result(502, 'calendar_error', {
      scopes,
      token: { httpStatus: token.httpStatus },
      calendar: { httpStatus: calendar.httpStatus, error: calendar.error },
    })
  }

  return result(200, 'healthy', {
    scopes,
    token: { httpStatus: token.httpStatus },
    calendar: { httpStatus: calendar.httpStatus, check: 'freeBusy.query primary' },
  })
}
