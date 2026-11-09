// Local stand-in for Google's token endpoint and Calendar API, used only by Playwright through the
// loopback-only GOOGLE_API_MOCK_ORIGIN binding. Holds calendar events in memory.
//   Authorization codes encode the scenario:  login:<email>  |  connect:<email>
import { createServer } from 'node:http'

const PORT = Number(process.env.E2E_GOOGLE_MOCK_PORT || 8790)
const CLIENT_ID = process.env.E2E_GOOGLE_CLIENT_ID
const SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
let events = []

const idToken = (email) =>
  `h.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: `sub-${email}`, email, email_verified: true })).toString('base64url')}.sig`

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/__health') return send(res, 200, { ok: true })
  if (url.pathname === '/__events') return send(res, 200, events)

  if (url.pathname === '/token' && req.method === 'POST') {
    const p = new URLSearchParams(raw)
    if (p.get('grant_type') === 'refresh_token') return send(res, 200, { access_token: 'mock-access-token', expires_in: 3600, scope: SCOPE })
    const [kind, email] = String(p.get('code')).split(':')
    if (kind === 'login') return send(res, 200, { access_token: 'mock-login', id_token: idToken(email), scope: 'openid email' })
    if (kind === 'connect') return send(res, 200, { access_token: 'mock-access-token', refresh_token: `mock-refresh-${email}`, id_token: idToken(email), scope: SCOPE })
    return send(res, 400, { error: 'invalid_grant' })
  }

  if (url.pathname === '/calendar/v3/freeBusy' && req.method === 'POST') {
    return send(res, 200, { calendars: { primary: { busy: events.map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })) } } })
  }

  if (url.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
    const body = JSON.parse(raw)
    if (body.id && events.some((e) => e.id === body.id)) return send(res, 409, { error: { status: 'ALREADY_EXISTS' } })
    const event = { id: body.id || `mock-event-${events.length + 1}`, ...body }
    events.push(event)
    return send(res, 200, { id: event.id })
  }

  const del = url.pathname.match(/^\/calendar\/v3\/calendars\/primary\/events\/(.+)$/)
  if (del && req.method === 'DELETE') {
    events = events.filter((e) => e.id !== decodeURIComponent(del[1]))
    return send(res, 204)
  }

  send(res, 404, { error: { status: 'NOT_FOUND' } })
}).listen(PORT, '127.0.0.1')
