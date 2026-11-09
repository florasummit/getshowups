// GET /api/google/oauth/callback — the redirect URI registered in Google Cloud.
//
// 1. Verifies the encrypted, HttpOnly state cookie (CSRF + 10-minute expiry).
// 2. Exchanges the code server-side with the client secret + PKCE verifier.
// 3. Requires every calendar scope to be granted.
// 4. Atomically consumes the invite in D1, only for the session that claimed it. A replayed
//    callback, a reused invite, or another session fails here, and the new Google grant is revoked.
// 5. Stores the encrypted refresh token under the customer from the invite record. If storage
//    fails, the new Google grant is revoked and the invite is released so the link can be retried.
// Tokens are never sent to the browser.
import {
  CALENDAR_SCOPES,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  decrypt,
  googleApi,
  googleFetch,
  encrypt,
  idTokenClaims,
  missingConfig,
  page,
  readCookie,
  revokeToken,
  stateCookie,
  timingSafeEqual,
} from '../../../../server/google-oauth.js'
import { consumeInvite, releaseInvite } from '../../../../server/invites.js'
import { track } from '../../../../server/events.js'

const clear = { 'Set-Cookie': stateCookie('', 0) }
// Storage failed after Google approved. The new Google access has already been revoked.
const saveFailed = (linkStillWorks) =>
  page(
    503,
    'Calendar not connected',
    linkStillWorks
      ? "We couldn't save your calendar connection, so we cancelled Google's access and nothing was stored. Your link still works: open it again in a few minutes to retry."
      : "We couldn't save your calendar connection, so we cancelled Google's access and nothing was stored. Please ask GetShowUps for a new link.",
    { ...clear, 'Retry-After': '120' },
  )
const expired = () =>
  page(400, 'Connection expired', 'This sign-in session is missing, expired, or could not be verified. Please start again from your link.', clear)

export async function onRequestGet({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) {
    console.error('Google OAuth not configured; missing:', missing.join(', '))
    return page(503, 'Calendar connection unavailable', 'Google Calendar connection is not configured yet.', clear)
  }

  const url = new URL(request.url)
  if (url.searchParams.get('error')) {
    return page(400, 'Calendar not connected', 'Google access was not granted. Ask GetShowUps for a new link to try again.', clear)
  }

  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const rawCookie = readCookie(request, STATE_COOKIE)
  if (!code || !returnedState || !rawCookie) return expired()

  let saved
  try {
    saved = JSON.parse(await decrypt(env, rawCookie))
  } catch {
    return expired()
  }
  if (
    !timingSafeEqual(returnedState, saved.state) ||
    !saved.inviteHash ||
    !saved.sessionId ||
    Date.now() - saved.iat > STATE_TTL_SECONDS * 1000
  ) {
    return expired()
  }

  let tokenRes
  try {
    tokenRes = await googleFetch(env, googleApi(env).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: saved.verifier,
    }),
    })
  } catch {
    console.error('Google token exchange failed: network_error')
    return page(502, 'Calendar not connected', 'Google could not complete the connection. Please try again.', clear)
  }
  const tokens = await tokenRes.json().catch(() => ({}))
  if (!tokenRes.ok) {
    console.error('Google token exchange failed:', tokenRes.status, tokens.error)
    return page(502, 'Calendar not connected', 'Google could not complete the connection. Please try again.', clear)
  }
  const grant = tokens.refresh_token || tokens.access_token

  const granted = new Set((tokens.scope || '').split(' '))
  if (!CALENDAR_SCOPES.every((s) => granted.has(s))) {
    if (grant) await revokeToken(grant, env)
    return page(400, 'Calendar access needed', 'Please allow both calendar permissions on the Google screen. Use your link again to retry.', clear)
  }
  if (!tokens.refresh_token) {
    if (grant) await revokeToken(grant, env)
    return page(400, 'Calendar not connected', 'Google did not return long-term access. Please start again from your link.', clear)
  }

  const consumedAt = Date.now()
  let invite
  try {
    invite = await consumeInvite(env.ONBOARDING_DB, saved.inviteHash, saved.sessionId, consumedAt)
  } catch (err) {
    // The invite was not changed, so the same link still works.
    console.error('Invite check failed:', err?.message)
    await revokeToken(tokens.refresh_token, env)
    return saveFailed(true)
  }
  if (!invite) {
    await revokeToken(tokens.refresh_token, env)
    return page(410, 'Link not valid', 'This calendar connection link was already used or has expired. Please ask GetShowUps for a new link.', clear)
  }

  const key = `google:${invite.customer}`
  const claims = idTokenClaims(tokens.id_token || '')
  let existing
  try {
    existing = await env.GOOGLE_TOKENS.get(key)
    if (invite.purpose === 'connect' && existing) {
      await revokeToken(tokens.refresh_token, env)
      return page(409, 'Already connected', 'A calendar is already connected for this account. Ask GetShowUps for a reconnect link to replace it.', clear)
    }
    await env.GOOGLE_TOKENS.put(
      key,
      JSON.stringify({
        customer: invite.customer,
        googleSub: claims.sub || null,
        email: claims.email || null,
        scope: tokens.scope,
        clientId: env.GOOGLE_CLIENT_ID, // Google binds the refresh token to this client
        refreshToken: await encrypt(env, tokens.refresh_token),
        connectedAt: new Date().toISOString(),
      }),
    )
  } catch (err) {
    // Nothing was stored. Undo Google's new grant, then give the invite back so the same
    // link can be retried instead of being burned.
    console.error('Saving Google connection failed:', err?.message)
    await revokeToken(tokens.refresh_token, env)
    let released = false
    try {
      released = await releaseInvite(env.ONBOARDING_DB, saved.inviteHash, saved.sessionId, consumedAt)
    } catch (releaseErr) {
      console.error('Could not release invite after failed save:', releaseErr?.message)
    }
    return saveFailed(released)
  }

  await track(env, existing ? 'calendar_reconnected' : 'calendar_connected', { id: `calendar:${invite.customer}:${consumedAt}`, customer: invite.customer })

  // Reconnect. Same OAuth client: revoke the replaced grant so the old refresh token stops working.
  // Different client (a client migration): keep the old encrypted record under an archive key and do
  // not revoke it, so the previous connection can be restored if the migration is rolled back.
  if (existing) {
    try {
      const previous = JSON.parse(existing)
      if (previous.clientId && previous.clientId === env.GOOGLE_CLIENT_ID) {
        await revokeToken(await decrypt(env, previous.refreshToken), env)
      } else {
        await env.GOOGLE_TOKENS.put(`google-archive:${invite.customer}:${consumedAt}`, existing)
      }
    } catch (err) {
      console.error('Could not retire previous Google grant:', err?.message)
    }
  }

  return page(
    200,
    'Google Calendar connected',
    `Your calendar${claims.email ? ` (${claims.email})` : ''} is now connected to GetShowUps.`,
    clear,
    '<form method="get" action="/dashboard"><button type="submit">Continue</button></form>',
    false,
  )
}
