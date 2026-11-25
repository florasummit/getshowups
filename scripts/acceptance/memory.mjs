// Deployed check of kept conversations (two questions): reload, names read again, nothing but references stored, delete, and
// another account's history on the same browser removed. node scripts/acceptance/memory.mjs [origin]
import { chromium } from '@playwright/test'
import { openSession, SITE } from './grant.mjs'
import { verdict } from './accounts.mjs'

const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } })
const s = await openSession(ctx)
if (!s.customer) throw new Error(`No test session: ${JSON.stringify(s)}`)
const page = await ctx.newPage()
const bad = []
const check = (name, ok) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`), ok || bad.push(name))
await page.goto(`${SITE}/dashboard`)
if (verdict(await (await page.request.get(`${SITE}/api/dashboard/me`)).json()) !== 'ok') throw new Error('not the test business')
await page.request.post(`${SITE}/api/acceptance/fixture`, { headers: { Origin: SITE } })
// Someone else's history left on this browser must go when this account opens the dashboard.
await page.evaluate(() => localStorage.setItem('gsu:assistant:v1:other-business:other@x.example', JSON.stringify([{ id: 'c', at: Date.now(), title: 'theirs', talk: [{ id: 'e', q: 'theirs', raw: 'secret' }] }])))
await page.reload()
await page.locator('[data-assistant]').first().click()
const panel = page.locator('[data-help-panel]')
const keys = () => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('gsu:assistant')))
check('another account’s history is deleted and not shown', !(await keys()).some(([k]) => k.includes('other')) && !(await panel.innerText()).includes('theirs'))
const ask = async (q) => {
  const n = await panel.locator('.ask-entry').count()
  await panel.locator('textarea').last().fill(q)
  await panel.getByRole('button', { name: 'Send question' }).click()
  await panel.locator('.ask-entry').nth(n).locator('.ask-answer, .ask-error').first().waitFor({ timeout: 60000 })
  const t = await panel.locator('.ask-entry').nth(n).innerText()
  console.log(`     Owner: ${q}\n     ${t.replace(/\n+/g, ' ').slice(0, 420)}`)
  return t
}
const one = await ask('who should i call and what do they need')
check('answered with the right person', /Vera Synthetic/.test(one))
const kept = await keys()
check('kept for this account only, without names or contact details', kept.length === 1 && kept[0][0].includes('gsu-journey-test') && !/Vera|Synthetic\b.*15|\+1555/.test(kept[0][1].replace(/"q":"[^"]*"/g, '')))
await page.reload()
await page.locator('[data-assistant]').first().click()
await panel.getByText('Vera Synthetic').first().waitFor({ timeout: 15000 })
check('after a reload the conversation is back, with names read again', (await panel.locator('.ask-entry').count()) === 1)
const two = await ask('remind me, how many filters was it')
check('a follow-up after the reload is understood', /\b2\b|two/i.test(two))
await panel.getByRole('button', { name: 'New conversation' }).click()
check('new conversation starts empty', (await panel.locator('.ask-entry').count()) === 0)
await panel.getByText('Earlier conversations').click()
await panel.getByRole('button', { name: /^Delete conversation/ }).first().click()
check('deleted', (await keys()).length === 0)
await b.close()
console.log(bad.length ? `\n${bad.length} failed` : '\nEvery check passed.')
process.exit(bad.length ? 1 : 0)
