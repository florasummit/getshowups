// Drives the public booking page (src/booking/BookingPage.jsx) the way a visitor does, whatever the business's settings
// produce: service cards or the open "What do you need?" question, the ZIP before times (service area), a time, then
// details. Each spec asserts what it cares about; this only walks the steps.
import { expect } from './test.js'

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Step 1 (when shown): choose a service (by name, else the first) or type the need; answer a required question; ZIP.
export async function chooseService(page, { need = 'Weekly pool cleaning', zip, answer = 'Pump hums but won’t start' } = {}) {
  const see = page.getByRole('button', { name: /^(See open times|Continue to your details)$/ })
  const pick = page.getByRole('heading', { level: 1, name: /^Pick a/ })
  await expect(see.or(pick).first()).toBeVisible()
  if (!(await see.count())) return false
  const radios = page.getByRole('radio')
  if (await radios.count()) {
    const named = page.getByRole('radio', { name: new RegExp(esc(need), 'i') })
    await ((await named.count()) ? named.first() : radios.first()).click()
  }
  const open = page.getByLabel('What do you need?')
  if (await open.count()) await open.fill(need)
  const other = page.getByLabel('Tell us what you need')
  if (await other.count()) await other.fill(need)
  const question = page.locator('.bk-reveal textarea')
  if ((await question.count()) && !(await question.first().inputValue())) await question.first().fill(answer)
  const zipField = page.getByLabel(/Your ZIP code/)
  if (await zipField.count()) await zipField.fill(zip ?? '29403')
  await see.click()
  return true
}

// The time step: a day and a slot ('first' | 'last'), then Continue (or Book, on a pick-a-time link).
export async function chooseTime(page, { day = 'first', slot = 'first' } = {}) {
  await expect(page.getByRole('heading', { level: 1, name: /^Pick a/ })).toBeVisible()
  const days = page.locator('.bk-day')
  if (day === 'last') await days.last().click()
  const slots = page.locator('.bk-slot')
  await (slot === 'last' ? slots.last() : slots.first()).click()
  await page.getByRole('button', { name: /^(Continue with|Book) / }).click()
}

// Details, then Confirm / Send request. address: { street, city, state, zip } for visits.
export async function fillDetails(page, { need = 'Weekly pool cleaning', name, phone = '(555) 010-0123', email, address, submit = true } = {}) {
  await expect(page.getByLabel('Name')).toBeVisible()
  const open = page.getByLabel('What do you need?')
  if (await open.count()) await open.fill(need)
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Phone').fill(phone)
  await page.getByLabel('Email').fill(email)
  if (address && (await page.getByLabel('Street address').count())) {
    await page.getByLabel('Street address').fill(address.street)
    await page.getByLabel('City').fill(address.city)
    await page.getByLabel('State').fill(address.state)
    if (address.zip) await page.getByLabel('ZIP', { exact: true }).fill(address.zip)
  }
  if (submit) await page.getByRole('button', { name: /^(Confirm|Send request)/ }).click()
}

// The whole path for a visitor who books. Returns once the booked heading shows.
export async function bookVisit(page, opts) {
  await chooseService(page, opts)
  await chooseTime(page, opts)
  await fillDetails(page, opts)
  await expect(page.getByRole('heading', { name: /^(You’re booked|Visit booked)$/ })).toBeVisible()
}
