// Browser voice, microphone first: a blocked or missing microphone is reported in the page BEFORE any voice call is
// created on the server (no Retell call, nothing paid), and typing keeps working. The receptionist info route and the
// voice route are mocked at the page (no Retell in e2e); getUserMedia is stubbed so the result doesn't depend on the
// headless browser's permission default.
import { test, expect } from './test.js'

const ID = 'e2e-comms-mic'

async function setup(page, micError, voiceStatus = 'available') {
  const voiceCalls = []
  await page.addInitScript((name) => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('stubbed', name))
  }, micError)
  await page.route(`**/api/receptionist/${ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, name: 'Mic Test Co', greeting: 'Hi! Ask me anything.', phone: '', voice: voiceStatus === 'available', voiceStatus, callbacks: true, website: null }) }),
  )
  await page.route(`**/api/receptionist/${ID}/voice`, (route) => {
    voiceCalls.push(route.request().method())
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'voice_not_configured' }) })
  })
  await page.goto(`/chat/${ID}`)
  await expect(page.getByText('Hi! Ask me anything.')).toBeVisible()
  return voiceCalls
}

test('voice: microphone blocked → told how to allow it, no call is created, typing still works @mobile', async ({ page }) => {
  const voiceCalls = await setup(page, 'NotAllowedError')
  await page.getByRole('button', { name: 'Talk instead (uses your microphone)' }).click()
  await expect(page.getByText('We couldn’t use your microphone. Allow microphone access in your browser, or keep typing.')).toBeVisible()
  expect(voiceCalls).toEqual([])
  await expect(page.getByLabel('Your message')).toBeEnabled()
})

test('voice gate: voice not released for this business → no talk button, the page says voice isn’t available for this business; chat works @mobile', async ({ page }) => {
  const voiceCalls = await setup(page, 'NotAllowedError', 'testing')
  await expect(page.getByText('Talking by voice isn’t available for this business yet.')).toBeVisible()
  await expect(page.getByRole('button', { name: /Talk instead/ })).toHaveCount(0)
  await expect(page.getByLabel('Your message')).toBeEnabled()
  expect(voiceCalls).toEqual([])
})

test('voice: no microphone → says so, no call is created', async ({ page }) => {
  const voiceCalls = await setup(page, 'NotFoundError')
  await page.getByRole('button', { name: 'Talk instead (uses your microphone)' }).click()
  await expect(page.getByText('No microphone was found. Connect one, or keep typing.')).toBeVisible()
  expect(voiceCalls).toEqual([])
})
