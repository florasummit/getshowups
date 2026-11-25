// Browser acceptance for the dashboard assistant: opens the dashboard, types questions, reads what is rendered, compares it
// with the records and the page, tries supported actions, and writes a Markdown report with screenshots.
//   node scripts/acceptance/run.mjs --local <dist dir> [--set fresh|known|arch] [--only <biz>] [--cap 0.50]   synthetic businesses, real model
//   node scripts/acceptance/run.mjs --deployed [--approve] [--mobile]                https://getshowups.com, test session
// Deployed runs: pair.mjs once (an admin approves a code). They refuse to start unless the business is on ALLOWED and
// admin-marked as a test business, and every request that could change anything is blocked in the browser
// except asking (and approving a prepared change with --approve). Exit 0 = every check passed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, devices } from '@playwright/test'
import { explain, verdict } from './accounts.mjs'
import { openSession } from './grant.mjs'
import { ARCH, DEPLOYED, DEPLOYED_AGAIN, FRESH, KNOWN, SCENARIOS } from './scenarios.mjs'
import { BUSINESSES, token } from './worlds.mjs'

const arg = (k, d = null) => (process.argv.includes(k) ? (process.argv[process.argv.indexOf(k) + 1] ?? true) : d)
const has = (k) => process.argv.includes(k)
const OUT = resolve(arg('--out', 'test-results/acceptance'))
mkdirSync(OUT, { recursive: true })
const lines = []
const fails = []
const log = (t) => (lines.push(t), console.log(t))
const fail = (where, t) => (fails.push(`${where}: ${t}`), log(`- **FAIL** ${t}`))

// Rules every rendered answer must meet.
function rules(text, others = [], long = false) {
  const bad = []
  if (!text || text.length < 2) bad.push('empty answer')
  if (/\[[ALR]\d+\]|\b[ALR]\d\b/.test(text)) bad.push('shows an internal reference')
  if (/\b[a-z]+_[a-z_]+\b/.test(text)) bad.push('shows an internal name')
  if (/undefined|null\b|\bNaN\b|\[object|�/.test(text)) bad.push('broken text')
  if (/\bON SCREEN\b|WAITING NOW|no_lookup|[Ll]ookup|my instructions|[Oo]nly match|I found one match|shouldn’t have|shouldn't have/.test(text)) bad.push('talks about how it works')
  if (!/[.!?)’”"]$/.test(text.trim()) && !/\n- /.test(text)) bad.push('unfinished sentence')
  for (const o of others) if (text.includes(o)) bad.push(`names another business’s record: ${o}`)
  if (/\b([A-Z][a-z]+) \1\b/.test(text)) bad.push('doubled word')
  if (/\bI(’|')?(ve| have)? (just )?opened\b/.test(text)) bad.push('claims it opened something')
  if (/\btool\b|earlier (reply|answer) was (wrong|incorrect)/i.test(text)) bad.push('talks about how it works or doubts itself')
  if (text.split(/\s+/).length > (long ? 340 : 200)) bad.push('too long')
  return bad
}

async function guard(page, blocked, approve) {
  await page.route('**/*', (r) => {
    const q = r.request()
    const path = new URL(q.url()).pathname
    if (['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.continue()
    if (path === '/api/dashboard/assist' || (approve && path === '/api/dashboard/proposal')) return r.continue()
    blocked.push(`${q.method()} ${path}`)
    return r.abort()
  })
}
const panel = (page) => page.locator('[data-help-panel]')
async function open(page, view, origin) {
  const here = new URL(page.url())
  if (here.origin !== origin) await page.goto(`${origin}/dashboard`)
  // Moving inside the app keeps the conversation, like an owner would.
  // The open phone sheet can cover the menu; the link is pressed all the same.
  await page.locator(`nav a[href="${view === 'overview' ? '/dashboard' : `/dashboard/${view}`}"]`).first().evaluate((a) => a.click())
  await page.waitForTimeout(700)
  if (!(await panel(page).count())) await page.locator('[data-assistant]').filter({ visible: true }).first().click()
}
async function ask(page, q) {
  const box = panel(page).locator('textarea[placeholder="Ask in your own words"]')
  const before = await panel(page).locator('.ask-entry').count()
  await box.fill(q)
  const t = Date.now()
  await panel(page).getByRole('button', { name: 'Send question' }).click()
  const e = panel(page).locator('.ask-entry').nth(before)
  await e.locator('.ask-answer, .ask-error').first().waitFor({ timeout: 60000 })
  const one = async (sel) => ((await e.locator(sel).count()) ? (await e.locator(sel).first().innerText()).trim() : '')
  return { e, ms: Date.now() - t, answer: await one('.ask-text'), error: await one('.ask-error'), aiOut: await one('[data-ai-out]'), people: await e.locator('.ask-records summary strong').allInnerTexts(), proposals: await e.locator('[data-proposal]').count(), title: await one('.ask-proposal-title'), tags: await e.locator('.help-tag').allInnerTexts() }
}
async function layout(page, where) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (wide > 1) fail(where, `sideways scroll of ${wide}px`)
  const ideas = await panel(page).locator('[data-ask-idea]').allInnerTexts()
  if (new Set(ideas).size !== ideas.length) fail(where, 'duplicated suggestions')
  const text = await panel(page).locator('.ask-text').last()
  const box = await text.boundingBox()
  const p = await panel(page).boundingBox()
  if (box && p && box.x + box.width > p.x + p.width + 1) fail(where, 'answer is cut off at the side')
}
async function turn(page, t, where, others = []) {
  log(`\n**Owner** (${t.view || 'same page'}): ${t.q}`)
  const r = await ask(page, t.q)
  log(`**Assistant** (${(r.ms / 1000).toFixed(1)} s): ${r.answer || r.error}${r.people.length ? `\n\n_Cards: ${r.people.join(', ')}_` : ''}${r.title ? `\n\n_Prepared: ${r.title}_` : ''}`)
  if (r.error || r.aiOut) fail(where, r.error || r.aiOut)
  for (const b of rules(r.answer, others, t.long)) fail(where, `${b} (“${t.q}”)`)
  for (const m of t.must || []) if (!m.test(`${r.answer} ${r.people.join(' ')} ${r.title}`)) fail(where, `expected ${m} (“${t.q}”)`)
  for (const m of t.never || []) if (m.test(r.answer)) fail(where, `must not say ${m} (“${t.q}”)`)
  if (t.proposal && !r.proposals) fail(where, `nothing prepared, expected ${t.proposal} (“${t.q}”)`)
  if (t.withdrawn && (await panel(page).locator('[data-proposal="review"], [data-proposal="draft"]').count())) fail(where, `a prepared change is still pending (“${t.q}”)`)
  if (t.pending !== undefined) {
    const left = await panel(page).locator('[data-proposal="review"], [data-proposal="draft"]').count()
    if (left !== t.pending) fail(where, `${left} prepared changes pending, expected ${t.pending} (“${t.q}”)`)
  }
  if (t.approve) {
    await r.e.getByRole('button', { name: 'Approve' }).click()
    await r.e.locator('.ask-saved').waitFor({ timeout: 10000 })
    log(`_Approved in the page: ${await r.e.locator('.ask-saved').innerText()}_`)
  }
  await layout(page, where)
  return r
}

async function local(dist) {
  const { serve } = await import('./local.mjs')
  if (!process.env.OPERATOR_ANTHROPIC_API_KEY) throw new Error('OPERATOR_ANTHROPIC_API_KEY is not set')
  const s = await serve(resolve(dist))
  const cap = Number(arg('--cap', '0.50'))
  const names = Object.fromEntries(Object.keys(BUSINESSES).map((id) => [id, s.sql.prepare('SELECT name FROM leads WHERE customer = ?1 UNION SELECT name FROM receptionist_requests WHERE customer = ?1').all(id).map((r) => r.name)]))
  const browser = await chromium.launch()
  for (const [i, sc] of ({ fresh: FRESH, known: KNOWN, arch: ARCH }[arg('--set')] || SCENARIOS).entries()) {
    if (arg('--only') && ![sc.biz].includes(arg('--only'))) continue
    const mobile = i % 3 === 1
    const ctx = await browser.newContext(mobile ? { ...devices['Pixel 7'] } : { viewport: { width: 1440, height: 950 } })
    await ctx.addCookies([{ name: '__Host-gsu_session', value: token(sc.biz), domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }])
    const page = await ctx.newPage()
    const blocked = []
    await guard(page, blocked, true)
    page.on('pageerror', (e) => fail(sc.biz, `page error ${e.message}`))
    await page.goto(`${s.origin}/dashboard`)
    const where = `${sc.severity ? `[known, ${sc.severity}] ` : ''}${sc.biz} / ${sc.name}`
    log(`\n## ${BUSINESSES[sc.biz]} — ${sc.name} (${mobile ? 'mobile' : 'desktop'})`)
    const others = Object.entries(names).filter(([id]) => id !== sc.biz).flatMap(([, l]) => l)
    for (const t of sc.turns) {
      s.clearLimits()
      if (s.usage().reduce((a, u) => a + u.costMicros, 0) / 1e6 > cap) throw new Error('budget cap reached')
      if (t.view || !(await panel(page).count())) await open(page, t.view || 'overview', s.origin)
      await turn(page, t, where, others.filter((n) => !names[sc.biz].includes(n)))
      s.sql.exec("DELETE FROM events WHERE type = 'insight_dismissed'")
    }
    await page.screenshot({ path: join(OUT, `${sc.biz}-${i}.png`) })
    if (blocked.length) log(`_Blocked in the browser: ${[...new Set(blocked)].join(', ')}_`)
    await ctx.close()
  }
  const u = s.usage()
  const ms = u.map((x) => x.ms).sort((a, b) => a - b)
  const cost = u.map((x) => x.costMicros).sort((a, b) => a - b)
  const mid = (l) => l[Math.floor(l.length / 2)] ?? 0
  const look = (f) => u.filter(f)
  log(`\n## Measured\n\n- Questions that reached the model: ${u.length}, answered: ${u.filter((x) => x.ok).length}; model: ${[...new Set(u.map((x) => x.model))].join(', ')}`)
  log(`- Cost per question: median $${(mid(cost) / 1e6).toFixed(5)}, highest $${((cost.at(-1) || 0) / 1e6).toFixed(5)}; total $${(cost.reduce((a, b) => a + b, 0) / 1e6).toFixed(4)}`)
  for (const [n, l] of [['one model call', look((x) => x.usage?.calls === 1)], ['two model calls', look((x) => x.usage?.calls === 2)], ['three or more', look((x) => x.usage?.calls > 2)]]) if (l.length) log(`- ${n}: ${l.length} questions, median $${(mid(l.map((x) => x.costMicros).sort((a, b) => a - b)) / 1e6).toFixed(5)}, ${(mid(l.map((x) => x.ms).sort((a, b) => a - b)) / 1000).toFixed(1)} s`)
  log(`- Time: median ${(mid(ms) / 1000).toFixed(1)} s, slowest ${((ms.at(-1) || 0) / 1000).toFixed(1)} s`)
  writeFileSync(join(OUT, 'usage.json'), JSON.stringify(u, null, 1))
  await browser.close()
  s.close()
}

async function deployed() {
  const origin = 'https://getshowups.com'
  const browser = await chromium.launch({ headless: !has('--show') })
  const ctx = await browser.newContext(has('--mobile') ? { ...devices['Pixel 7'] } : { viewport: { width: 1440, height: 950 } })
  const opened = await openSession(ctx)
  if (!opened.customer) throw new Error(opened.pending ? 'Waiting for an admin to approve the pairing code.' : `No test session (${opened.refused}). Pair first: node scripts/acceptance/pair.mjs`)
  const page = await ctx.newPage()
  const blocked = []
  await page.goto(`${origin}/dashboard`)
  const me = async () => (await page.request.get(`${origin}/api/dashboard/me`)).json().catch(() => ({}))
  let who = await me()
  const v = verdict(who)
  if (v !== 'ok') throw new Error(explain(who, v))
  who = null
  // Synthetic records back to their starting state (server/acceptance-fixture.js).
  const reset = await page.request.post(`${origin}/api/acceptance/fixture`, { headers: { Origin: origin } })
  if (!reset.ok()) throw new Error(`The synthetic records could not be prepared (${reset.status()}).`)
  await page.reload()
  await guard(page, blocked, has('--approve'))
  const build = await (await page.request.get(`${origin}/build.json`)).json().catch(() => ({}))
  log(`# Deployed acceptance\n\nBuild ${build.commit || 'unknown'}`)
  for (const t of arg('--set') === 'again' ? DEPLOYED_AGAIN : DEPLOYED) {
    if (t.view || !(await panel(page).count())) await open(page, t.view || 'overview', origin)
    const card = t.card ? (await (await page.request.get(`${origin}/api/dashboard/overview`)).json()).attention : null
    const call = card?.items.find((i) => i.id === 'callbacks')
    await turn(page, { ...t, ...(call ? { must: [/call/i], never: [/nobody is waiting|no one is waiting|all caught up/i] } : {}) }, 'deployed')
    if (card) log(`_The card shows: ${card.items.map((i) => i.text).join(' · ') || 'all caught up'}_`)
    await page.waitForTimeout(13000) // the minute limit is real here
  }
  await page.screenshot({ path: join(OUT, `deployed${has('--mobile') ? '-mobile' : ''}.png`) })
  if (blocked.length) log(`_Blocked in the browser: ${[...new Set(blocked)].join(', ')}_`)
  await browser.close()
}

try {
  await (has('--deployed') ? deployed() : local(arg('--local', 'dist')))
} catch (err) {
  fail('run', err.message)
}
log(`\n## Result\n\n${fails.length ? fails.map((f) => `- ${f}`).join('\n') : 'Every check passed.'}`)
writeFileSync(join(OUT, 'report.md'), lines.join('\n'))
process.exit(fails.length ? 1 : 0)
