// Layout checks for published-site renders (the frozen fixtures in test/fixtures/render, see test/render-golden.test.js)
// at desktop and phone width: no sideways scrolling, a visible headline and booking button on the first screen,
// thumb-sized booking button on phones, no clipped headings. Deterministic checks instead of pixel screenshots, so
// they hold across machines; they catch the layout breaks that cost bookings.
import { readFileSync, readdirSync } from 'node:fs'
import { test, expect } from './test.js'

const DIR = new URL('../fixtures/render/', import.meta.url)
const pages = readdirSync(DIR).filter((f) => f.endsWith('.html')).sort()

for (const file of pages) {
  test(`published site layout holds: ${file} @mobile`, async ({ page, baseURL }) => {
    const html = readFileSync(new URL(file, DIR), 'utf8')
    const url = `${baseURL}/__render-golden/${file}`
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
    await page.goto(url)
    const vw = page.viewportSize().width
    const vh = page.viewportSize().height
    const m = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
      }
      const box = (el) => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
      }
      const book = [...document.querySelectorAll('a[href*="/book/"]')].filter(visible).map(box)
      const h1 = [...document.querySelectorAll('h1')].filter(visible).map(box)
      const clipped = [...document.querySelectorAll('h1, h2, h3, .btn, a[href*="/book/"]')].filter((el) => visible(el) && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible').map((el) => el.textContent.trim().slice(0, 40))
      const noAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length
      return { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, book, h1, clipped, noAlt }
    })
    expect(m.scrollW, 'no sideways scrolling').toBeLessThanOrEqual(m.clientW + 1)
    expect(m.noAlt, 'every image has alt text (empty for decoration)').toBe(0)
    expect(m.clipped, 'no clipped headings or buttons').toEqual([])
    // Sub-pages (services, about, …) may open with their own heading; the home page must show the headline.
    if (!/\.(about|services|contact|privacy)\.html$/.test(file)) {
      expect(m.h1.length, 'one visible headline').toBeGreaterThan(0)
      expect(m.h1[0].top, 'headline on the first screen').toBeLessThan(vh)
      expect(m.h1[0].right, 'headline inside the screen').toBeLessThanOrEqual(vw + 1)
    }
    const firstScreen = m.book.filter((b) => b.top >= 0 && b.bottom <= vh && b.left >= 0 && b.right <= vw + 1)
    expect(firstScreen.length, 'a booking button is visible without scrolling').toBeGreaterThan(0)
    if (vw < 600) expect(Math.max(...firstScreen.map((b) => b.height)), 'phone booking button is thumb-sized').toBeGreaterThanOrEqual(40)
  })
}
