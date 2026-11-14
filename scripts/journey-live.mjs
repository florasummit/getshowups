#!/usr/bin/env node
// Opt-in LIVE journey check against production with REAL Google accounts (authorized integration checks only).
//   JOURNEY_LIVE=1 JOURNEY_BUSINESS=gsu-stripe-test-pools node scripts/journey-live.mjs [--act]
// - Uses a dedicated Chrome profile (JOURNEY_PROFILE_DIR) launched as a normal browser; reuses its Google session.
// - Same state detection as CI (test/e2e/journey.js). Acts only for JOURNEY_BUSINESS, which must be a GetShowUps
//   test business; anything else → stop.
// - Never types, clicks or approves anything on Google pages, and never bypasses unverified-app warnings: at a
//   Google step it explains the permission, opens it from GetShowUps, and waits for the human, then resumes.
// - Without --act it only reports (plus opening Google steps); --act also chooses the Google Ads TEST account for the
//   test business. Business details (what the business sells, its area, budget) are never invented: owner only.
// - Prints state names and PASS/FAIL only: no tokens, emails, account ids or screenshots.
import { spawn, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { chromium } from 'playwright'
import { detect, PERMISSIONS } from '../test/e2e/journey.js'

const SITE = 'https://getshowups.com'
const BUSINESS = process.env.JOURNEY_BUSINESS
const PROFILE = process.env.JOURNEY_PROFILE_DIR || `${homedir()}/getshowups-demo/chrome-profile`
const ACT = process.argv.includes('--act')
const PORT = 9333
if (process.env.JOURNEY_LIVE !== '1' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(BUSINESS || '')) {
  console.error('Refusing: set JOURNEY_LIVE=1 and JOURNEY_BUSINESS=<a GetShowUps TEST business id>. Live checks need explicit authorization.')
  process.exit(2)
}
const say = (s) => console.log(s)
const notify = (msg) => {
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "GetShowUps check: your turn"`])
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
let chrome = null
if (!browser) {
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--lang=en-US', 'about:blank'], { detached: true, stdio: 'ignore' })
  for (let i = 0; i < 40 && !browser; i++) {
    await sleep(500)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
  }
}
if (!browser) throw new Error('could not open the dedicated Chrome profile')
const context = browser.contexts()[0]
const page = context.pages().find((p) => !p.url().startsWith('chrome://')) || (await context.newPage())
await page.goto(`${SITE}/dashboard`)

const onGoogle = () => {
  try {
    return /(^|\.)google\.com$/.test(new URL(page.url()).hostname)
  } catch {
    return false
  }
}
// Opens a Google authorization step from GetShowUps and waits (≤20 min) for the human to finish it on Google.
async function human(kind, open) {
  const p = PERMISSIONS[kind]
  say(`\nHUMAN STEP: ${kind} — Google will ask for: ${p.scopes.join(', ')}.\n  Why: ${p.why}\n  Approve or cancel in the Chrome window; this script never clicks on Google pages.`)
  notify(`Google is asking for ${p.scopes.join(', ')}. Review it in the Chrome window.`)
  await open()
  const end = Date.now() + 20 * 60e3
  while (Date.now() < end && (onGoogle() || page.url().startsWith('about:'))) await sleep(500)
  await page.waitForLoadState('networkidle').catch(() => {})
}

const report = []
let last = null
for (let i = 0; i < 10; i++) {
  const s = await detect(page, SITE)
  report.push(s.state)
  say(`${i + 1}. ${s.state}`)
  if (s.business && s.business !== BUSINESS) {
    say(`FAIL: signed in to a different business than JOURNEY_BUSINESS; stopping without changes.`)
    process.exitCode = 1
    break
  }
  if (s.ready) {
    say('PASS: signed in, setup complete, Calendar healthy, Google Ads connected to a test account (or Ads not enabled).')
    break
  }
  if (s.state === last) {
    say(`FAIL: "${s.state}" did not change (cancelled on Google, or an error). Stopping.`)
    process.exitCode = 1
    break
  }
  last = s.state
  if (s.state === 'sign_in') await human('sign_in', () => page.getByRole('link', { name: 'Continue with Google' }).click())
  else if (s.state === 'setup_calendar') await human('calendar', async () => (await page.goto(`${SITE}/dashboard`), page.getByRole('button', { name: 'Connect Google Calendar' }).click()))
  else if (s.state === 'ads_connect' || s.state === 'ads_reconnect')
    await human('ads', async () => {
      await page.goto(`${SITE}/dashboard/ads`)
      const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Connect your ad account' }) })
      await card.getByRole('link', { name: /^(Connect|Reconnect)$/ }).first().click()
    })
  else if (!ACT) {
    say(`NEXT: "${s.state}" is a GetShowUps-side step; rerun with --act to perform it for the test business.`)
    break
  } else if (s.state === 'ads_choose_account') {
    await page.goto(`${SITE}/dashboard/ads`)
    await page.getByRole('group', { name: 'Choose a Google Ads account' }).getByRole('listitem').filter({ hasText: 'Test account' }).first().getByRole('button').click()
    await page.locator('[data-ads-account]').waitFor({ timeout: 60000 })
  } else {
    say(`STOP: "${s.state}" needs the owner in the dashboard (not automated live).`)
    break
  }
}
say(`\nTrace: ${report.join(' → ')}`)
await browser.close().catch(() => {})
if (chrome) {
  try {
    process.kill(-chrome.pid)
  } catch {}
}
