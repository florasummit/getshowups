// /api/google/oauth/start?invite=<single-use token>
//
// GET  shows which customer account the link is for and asks the user to confirm. It reads
//      the invite but changes nothing. Email link scanners often prefetch links, so a GET must
//      not consume or claim the invite.
// POST requires the confirmation checkbox and a same-origin request, then claims the invite for
//      this browser session (atomic, in D1) and redirects to Google.
// The customer identity comes only from the invite record, never from the URL or the form.
import {
  GOOGLE_AUTH_URL,
  SCOPES,
  STATE_TTL_SECONDS,
  encrypt,
  escapeHtml,
  missingConfig,
  page,
  pkceChallenge,
  randomToken,
  sha256Hex,
  stateCookie,
} from '../../../../server/google-oauth.js'
import { claimInvite, peekInvite } from '../../../../server/invites.js'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

function notConfigured(missing) {
  console.error('Google OAuth not configured; missing:', missing.join(', '))
  return page(503, 'Calendar connection unavailable', 'Google Calendar connection is not configured yet.')
}

const invalidLink = () =>
  page(410, 'Link not valid', 'This calendar connection link has expired, was already used, or is in use in another window. Please ask GetShowUps for a new link.')

// customer comes from the invite record and matches CUSTOMER_RE; it is escaped anyway.
function confirmPage(invite, customer, purpose, { status = 200, error = '' } = {}) {
  const isReconnect = purpose === 'reconnect'
  const name = escapeHtml(customer)
  const html =
    (error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : '') +
    `<p>Account: <strong>${name}</strong></p>` +
    (isReconnect ? '<p>This replaces the Google Calendar currently connected for this account.</p>' : '') +
    `<form method="post" action="/api/google/oauth/start">` +
    `<input type="hidden" name="invite" value="${escapeHtml(invite)}">` +
    `<p><label><input type="checkbox" name="confirm" value="yes" required> I confirm I'm authorized to connect a Google Calendar for <strong>${name}</strong>.</label></p>` +
    `<button type="submit">Continue to Google</button></form>`
  return page(
    status,
    isReconnect ? 'Reconnect your Google Calendar' : 'Connect your Google Calendar',
    'GetShowUps will ask Google for permission to see your availability and add appointments to calendars you own. Check the account name below before you continue. This link works once.',
    {},
    html,
  )
}

export async function onRequestGet({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) return notConfigured(missing)

  const invite = new URL(request.url).searchParams.get('invite') || ''
  if (!TOKEN_RE.test(invite)) return invalidLink()

  const found = await peekInvite(env.ONBOARDING_DB, await sha256Hex(invite))
  if (!found) return invalidLink()
  return confirmPage(invite, found.customer, found.purpose)
}

export async function onRequestPost({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) return notConfigured(missing)

  // Only accept the form from our own confirmation page. Browsers always send Origin on POST,
  // so a cross-site auto-submitted form (or a request with no Origin) is refused.
  if (request.headers.get('Origin') !== new URL(env.GOOGLE_REDIRECT_URI).origin) {
    return page(403, 'Request blocked', 'Please open your calendar connection link again and continue from that page.')
  }

  let form
  try {
    form = await request.formData()
  } catch {
    return invalidLink()
  }
  const invite = String(form.get('invite') || '')
  if (!TOKEN_RE.test(invite)) return invalidLink()
  const inviteHash = await sha256Hex(invite)

  if (form.get('confirm') !== 'yes') {
    const found = await peekInvite(env.ONBOARDING_DB, inviteHash)
    if (!found) return invalidLink()
    return confirmPage(invite, found.customer, found.purpose, {
      status: 400,
      error: 'Please tick the box to confirm the account before continuing.',
    })
  }

  const sessionId = randomToken()
  const claimed = await claimInvite(env.ONBOARDING_DB, inviteHash, sessionId)
  if (!claimed) return invalidLink()

  const state = randomToken()
  const verifier = randomToken(48)
  const cookie = await encrypt(env, JSON.stringify({ state, verifier, inviteHash, sessionId, iat: Date.now() }))

  const auth = new URL(GOOGLE_AUTH_URL)
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString()

  return new Response(null, {
    status: 303,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': stateCookie(cookie, STATE_TTL_SECONDS),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
