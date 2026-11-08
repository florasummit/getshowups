// Google Calendar onboarding + admin API, running the real Pages Functions on local workerd
// with throwaway D1/KV and FAKE credentials. Google's consent screen is mocked; no real network.
// Mocked success here is not production verification. Production is checked via /api/admin/google-health.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'

const ADMIN = { Authorization: `Bearer ${fixtures.E2E_ADMIN_API_TOKEN}` }
const uniqueCustomer = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

async function createInvite(request, customer, purpose = 'connect') {
  const res = await request.post('/api/admin/google-invites', { headers: ADMIN, data: { customer, purpose } })
  expect(res.status()).toBe(201)
  const body = await res.json()
  expect(body.customer).toBe(customer)
  return body.url
}

test('customer confirms account and is sent to Google with PKCE and least-privilege scopes', async ({ page, request }) => {
  const customer = uniqueCustomer()
  const url = await createInvite(request, customer)

  // Let the real Function handle the POST, but stop at its 303 so the browser never contacts
  // Google (Playwright routes do not intercept redirects). Page-level routing would miss it.
  let googleUrl, setCookie
  await page.route('**/api/google/oauth/start', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const res = await route.fetch({ maxRedirects: 0 })
    expect(res.status()).toBe(303)
    googleUrl = new URL(res.headers()['location'])
    setCookie = res.headers()['set-cookie']
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>mock google</title><p>Mock Google consent</p>' })
  })
  await page.context().route('https://accounts.google.com/**', (route) => route.abort())

  await page.goto(url)
  await expect(page.getByRole('heading', { name: 'Connect your Google Calendar' })).toBeVisible()
  await expect(page.getByText(`Account: ${customer}`)).toBeVisible()
  const confirm = page.getByRole('checkbox')
  await expect(confirm).toHaveAttribute('required', '')
  await confirm.check()
  await page.getByRole('button', { name: 'Continue to Google' }).click()
  await expect(page.getByText('Mock Google consent')).toBeVisible()

  expect(googleUrl.origin + googleUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(setCookie).toMatch(/^__Host-gsu_google_oauth=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600/)
  const p = googleUrl.searchParams
  expect(p.get('client_id')).toBe(fixtures.E2E_GOOGLE_CLIENT_ID)
  expect(p.get('redirect_uri')).toBe(`http://127.0.0.1:${fixtures.E2E_PORT}/api/google/oauth/callback`)
  expect(p.get('response_type')).toBe('code')
  expect(p.get('code_challenge_method')).toBe('S256')
  expect(p.get('access_type')).toBe('offline')
  expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(p.get('scope').split(' ').sort()).toEqual(
    ['email', 'openid', 'https://www.googleapis.com/auth/calendar.events.owned', 'https://www.googleapis.com/auth/calendar.freebusy'].sort(),
  )
  expect(googleUrl.toString()).not.toContain(customer)

  // The same link cannot be claimed again by another browser while in use.
  const otherContext = await page.context().browser().newContext()
  await otherContext.route('https://accounts.google.com/**', (route) => route.abort())
  const other = await otherContext.newPage()
  await other.goto(url)
  await other.getByRole('checkbox').check()
  await other.getByRole('button', { name: 'Continue to Google' }).click()
  await expect(other.getByRole('heading', { name: 'Link not valid' })).toBeVisible()
  await otherContext.close()
})

test('invalid, malformed, and forged requests are rejected', async ({ page, request }) => {
  await page.goto('/api/google/oauth/start?invite=not-a-real-token')
  await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible()

  await page.goto(`/api/google/oauth/start?invite=${'A'.repeat(43)}`)
  await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible()

  await page.goto('/api/google/oauth/callback?code=fake&state=fake')
  await expect(page.getByRole('heading', { name: 'Connection expired' })).toBeVisible()

  const crossSite = await request.post('/api/google/oauth/start', {
    headers: { Origin: 'https://evil.example' },
    form: { invite: 'A'.repeat(43), confirm: 'yes' },
  })
  expect(crossSite.status()).toBe(403)
})

test('admin endpoints require the bearer token', async ({ request }) => {
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Basic ${fixtures.E2E_ADMIN_API_TOKEN}` }]) {
    expect((await request.get('/api/admin/google-health?customer=e2e-co', { headers })).status()).toBe(401)
    expect((await request.post('/api/admin/google-invites', { headers, data: { customer: 'e2e-co' } })).status()).toBe(401)
  }
  // Unexported methods never reach a handler. Pages falls through to static assets:
  // GET → the site's index.html (200), POST → 405 with no body.
  const getInvites = await request.get('/api/admin/google-invites', { headers: ADMIN })
  expect(getInvites.status()).toBe(200)
  expect(await getInvites.text()).toContain('<div id="root">')
  expect((await request.post('/api/admin/google-health?customer=e2e-co', { headers: ADMIN })).status()).toBe(405)
})

test('health check reports not_connected for a customer with no stored credentials', async ({ request }) => {
  const res = await request.get(`/api/admin/google-health?customer=${uniqueCustomer()}`, { headers: ADMIN })
  expect(res.status()).toBe(404)
  const body = await res.json()
  expect(body.status).toBe('not_connected')
  expect(res.headers()['cache-control']).toBe('no-store')

  const bad = await request.get('/api/admin/google-health?customer=../poolthru', { headers: ADMIN })
  expect(bad.status()).toBe(400)
})
