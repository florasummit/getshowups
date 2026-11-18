// App response headers (functions/_middleware.js): the signed-in areas can't be framed by another site (clickjacking),
// HTTPS is required by browsers (HSTS), and a WebSocket upgrade (voice receptionist) passes through untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onRequest, withAppHeaders, FRAME_PROTECTED } from '../functions/_middleware.js'

const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), ONBOARDING_DB: {}, GOOGLE_TOKENS: {} }
const run = async (path, res = new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })) =>
  onRequest({ request: new Request(`https://getshowups.com${path}`), env, next: async () => res })

test('dashboard and admin can’t be framed by another site; HSTS everywhere on our host', async () => {
  for (const p of ['/dashboard', '/dashboard/website', '/dashboard/website?full=1', '/admin', '/admin/review']) {
    const r = await run(p)
    assert.equal(r.headers.get('X-Frame-Options'), 'DENY', p)
    assert.equal(r.headers.get('Content-Security-Policy'), "frame-ancestors 'none'", p)
    assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=15552000', p)
  }
  // Not the signed-in areas: no frame rule added (booking/chat may be embedded); HSTS still applies.
  for (const p of ['/', '/book/pools', '/chat/pools', '/dashboards-like-path', '/administrator']) {
    const r = await run(p)
    assert.equal(r.headers.get('X-Frame-Options'), null, p)
    assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=15552000', p)
  }
  assert.ok(!FRAME_PROTECTED.test('/dashboards') && FRAME_PROTECTED.test('/dashboard'))
})

test('an existing Content-Security-Policy is never replaced; status and body are kept; WebSocket upgrades pass through untouched', async () => {
  const strict = new Response('x', { status: 201, headers: { 'Content-Security-Policy': "default-src 'none'" } })
  const r = await withAppHeaders(strict, new URL('https://getshowups.com/admin'))
  assert.deepEqual([r.status, r.headers.get('Content-Security-Policy'), await r.text()], [201, "default-src 'none'", 'x'])
  const socket = { status: 101, webSocket: {}, headers: new Headers() }
  assert.equal(await withAppHeaders(socket, new URL('https://getshowups.com/api/receptionist/llm/s/c')), socket)
  // Local http (tests, dev): no HSTS.
  assert.equal((await withAppHeaders(new Response('x'), new URL('http://127.0.0.1:8788/dashboard'))).headers.get('Strict-Transport-Security'), null)
})
