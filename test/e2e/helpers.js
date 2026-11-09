// Shared Playwright helpers.
import { expect } from './test.js'

export async function useSession(context, token) {
  await context.addCookies([{ name: '__Host-gsu_session', value: token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }])
}

// Lets the real start handler run, then sends the browser to our callback instead of Google.
export async function returnFromGoogle(page, startPattern, method, callbackPath, code) {
  await page.route(startPattern, async (route) => {
    if (route.request().method() !== method) return route.continue()
    const res = await route.fetch({ maxRedirects: 0 })
    const google = new URL(res.headers()['location'])
    expect(google.origin).toBe('https://accounts.google.com')
    expect(google.searchParams.get('code_challenge_method')).toBe('S256')
    return route.fulfill({
      status: 302,
      headers: { location: `${callbackPath}?code=${encodeURIComponent(code)}&state=${google.searchParams.get('state')}`, 'set-cookie': res.headers()['set-cookie'] },
    })
  })
}

