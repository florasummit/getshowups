// One-time sign-in for deployed acceptance runs: opens a separate Chrome profile; a person signs in with a test business's
// Google account (accounts.mjs). Nothing is typed, read or stored by this script; the profile (outside the repository)
// keeps the session. Any other account is signed out of this window only, and the window says which and why.
import { chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { explain, verdict } from './accounts.mjs'

const SITE = 'https://getshowups.com'
const PROFILE = join(homedir(), '.getshowups-acceptance')
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: null })
chmodSync(PROFILE, 0o700)
const page = ctx.pages()[0] || (await ctx.newPage())
let why = ''
// Stays on every page of our site until the right account signs in.
const banner = () =>
  page
    .evaluate((text) => {
      document.querySelector('[data-acceptance]')?.remove()
      if (!text || location.origin !== 'https://getshowups.com') return
      const d = document.createElement('div')
      d.dataset.acceptance = ''
      d.textContent = text
      d.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:99999;background:#7c2d12;color:#fff;padding:14px 18px;font:16px/1.45 system-ui'
      document.body.append(d)
    }, why)
    .catch(() => {})
page.on('load', banner)
await page.goto(`${SITE}/dashboard`)
console.log('Waiting for sign-in with a test business’s Google account.')
let done = false
for (let i = 0; i < 1800 && !done; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const me = await ctx.request.get(`${SITE}/api/dashboard/me`).then((r) => (r.ok() ? r.json() : {})).catch(() => ({}))
  const v = verdict(me)
  if (v === 'signed_out') continue
  if (v === 'ok') {
    console.log(`Signed in to ${me.customer.id} (test business).`)
    done = true
  } else {
    why = explain(me, v)
    console.log(`REFUSED ${v}: ${me.email} (${me.customer?.id ?? 'no business'}). Google sign-in and our session both worked; this script ended the session.`)
    await ctx.request.post(`${SITE}/api/auth/logout`, { headers: { Origin: SITE } }).catch(() => {})
    await ctx.clearCookies({ domain: 'getshowups.com' })
    await page.goto(`${SITE}/dashboard`).catch(() => {})
    await banner()
  }
}
if (!done) console.log('No test-business sign-in.')
await ctx.close()
