// Booking embed, built with a (fake) Google Calendar URL. Google is mocked: no real network.
import { test, expect } from './test.js'
import { fixtures } from '../../playwright.config.js'

test.use({ baseURL: `http://127.0.0.1:${fixtures.E2E_BOOKING_PORT}` })

test('configured calendar renders as an embed with a new-tab fallback', async ({ page, context }) => {
  // Context-level so the cross-origin iframe request is intercepted too.
  await context.route('https://calendar.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>mock calendar</title><p>Mock calendar</p>' }),
  )
  // Arrive the way a visitor does. (A direct /#book-demo link does not scroll, because React
  // renders after the browser's fragment scroll; the lazy iframe would then never load.)
  await page.goto('/')
  await page.getByRole('main').getByRole('link', { name: /Book a Demo/ }).first().click()
  const section = page.locator('#book-demo')
  const frame = section.locator('iframe')
  await expect(frame).toHaveAttribute('src', fixtures.E2E_BOOKING_URL)
  await expect(frame).toHaveAttribute('title', 'Book a GetShowUps demo')
  await expect(page.frameLocator('#book-demo iframe').getByText('Mock calendar')).toBeVisible()

  const fallback = section.getByRole('link', { name: /Open booking page in a new tab/ })
  await expect(fallback).toHaveAttribute('href', fixtures.E2E_BOOKING_URL)
  await expect(fallback).toHaveAttribute('target', '_blank')
  await expect(fallback).toHaveAttribute('rel', /noopener/)
  await expect(section.getByText('Online booking isn’t connected yet')).toHaveCount(0)
})
