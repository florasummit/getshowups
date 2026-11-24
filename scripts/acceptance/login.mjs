// One-time sign-in for deployed acceptance runs: opens a separate Chrome profile; a person signs in with the test business's
// Google account. Nothing is typed, read or stored by this script; the profile (outside the repository) keeps the session.
import { chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const PROFILE = join(homedir(), '.getshowups-acceptance')
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: null })
chmodSync(PROFILE, 0o700)
const page = ctx.pages()[0] || (await ctx.newPage())
await page.goto('https://getshowups.com/dashboard')
console.log('Sign in with the test business’s Google account in the window that opened. It closes by itself.')
for (let i = 0; i < 300; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const me = await ctx.request.get('https://getshowups.com/api/dashboard/me').then((r) => r.json()).catch(() => ({}))
  if (me.customer) {
    if (me.testBusiness !== true) {
      // A real business's session must not stay in the acceptance profile.
      await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' })).catch(() => {})
      await ctx.clearCookies()
      await page.goto('https://getshowups.com/dashboard')
      console.log('That account is not a test business, so it was signed out here. Choose the test account.')
      continue
    }
    console.log(me.testBusiness === true ? `Signed in to ${me.customer.id} (test business).` : 'This is NOT a test business: acceptance runs will refuse it. Sign out and use the test account.')
    break
  }
}
await ctx.close()
