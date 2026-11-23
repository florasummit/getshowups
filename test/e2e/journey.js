// Autonomous customer journey (state-aware). detect() reads the REAL backend state of the signed-in browser and names
// the next thing a new customer has to do; runJourney() performs that step with authorized test resources, waits for
// the backend state to move, and stops with a diagnosis when a step changes nothing (never an endless retry).
// Shared by journey.spec.js (mocked Google / Stripe stand-in on local workerd). Traces hold state names only: no
// tokens, emails or ids beyond the test business's own id.
import { expect } from '@playwright/test'
import { fixtures } from '../../playwright.config.js'
import { returnFromGoogle } from './helpers.js'

export const SITE = `http://127.0.0.1:${fixtures.E2E_PORT}`
export const MOCK = `http://127.0.0.1:${fixtures.E2E_GOOGLE_MOCK_PORT}`
// Each journey is one visitor with its own address, so per-IP allowances (server/ratelimit.js) are a real customer's,
// not shared with every other spec on 127.0.0.1. In production Cloudflare sets CF-Connecting-IP itself.
let clientIp = null
export const asVisitor = (ip) => {
  clientIp = ip
}
export const headers = () => ({ Origin: SITE, ...(clientIp ? { 'CF-Connecting-IP': clientIp } : {}) })

const json = async (page, path, init) => {
  const r = init ? await page.request.post(path, { headers: headers(), ...init }) : await page.request.get(path, { headers: headers() })
  const body = await r.json().catch(() => null)
  return { status: r.status(), body }
}

// Required onboarding steps, in the order the product asks for them (server/onboarding.js onboardingSteps).
export const SETUP_ORDER = ['business', 'payment', 'details', 'services', 'calendar', 'hours', 'website', 'address', 'publish', 'launch']

// The next step for this browser: sign_in → create_business → setup_<step>… → calendar_reconnect | not_bookable → ready.
// "ready" = the business accepts real bookings on its public page (the first thing the $499 promises).
export async function detect(page) {
  const me = await json(page, '/api/dashboard/me')
  if (me.status === 401) return { state: 'sign_in' }
  if (me.status !== 200) return { state: 'error', details: { me: me.status } }
  const m = me.body
  if (!m.customer) return { state: 'create_business', details: { checkoutOpen: m.checkoutOpen, plan: m.signupPlan?.id ?? null } }
  const business = m.customer.id
  const pending = (m.progress?.steps || []).find((s) => !s.done)
  if (pending) return { state: `setup_${pending.id}`, business, details: { billing: m.progress.billing } }
  const cal = await json(page, '/api/dashboard/calendar')
  if (cal.body?.status !== 'healthy') return { state: 'calendar_reconnect', business, details: { calendar: cal.body?.status || cal.status } }
  const book = await json(page, `/api/book/${business}`)
  if (book.status !== 200 || book.body?.status !== 'ok' || !book.body.slots?.length) {
    return { state: 'not_bookable', business, details: { http: book.status, status: book.body?.status ?? book.body?.error ?? null, slots: book.body?.slots?.length ?? 0 } }
  }
  return { state: 'ready', ready: true, business, details: { slots: book.body.slots.length } }
}

// What a new customer does at each state. `who` = { email, name, calendarCode } (authorized test identities only).
export function customerActions(who) {
  return {
    sign_in: async (page) => {
      await page.goto('/dashboard?plan=founding')
      // Enrollment is closed in this environment exactly as in production: the page says so BEFORE Google sign-in and
      // keeps sign-in for accounts, invitations, admins and testers (this tester is listed in MESSAGE_TEST_RECIPIENTS).
      await expect(page.getByRole('heading', { name: /Online enrollment isn’t open yet|Create your GetShowUps account/ })).toBeVisible()
      await page.getByRole('link', { name: 'Continue with Google' }).click()
      await expect(page.getByRole('heading', { name: /What’s your business called\?|Online sign-up opens soon/ })).toBeVisible()
    },
    create_business: async (page) => {
      await page.getByLabel('Business name').fill(who.name)
      await page.getByRole('button', { name: 'Continue to plan' }).click()
      await expect(page.getByRole('heading', { name: 'Start your Growth plan' })).toBeVisible()
    },
    setup_payment: async (page) => {
      // Stripe-hosted checkout (local stand-in) with the sandbox test card; access follows the signed webhook.
      await page.goto('/dashboard')
      await page.getByRole('button', { name: 'Continue to secure checkout' }).click()
      await expect(page.getByRole('heading', { name: 'Subscribe to GetShowUps' })).toBeVisible()
      await page.getByLabel('Card number').fill('4242424242424242')
      await page.getByRole('button', { name: 'Subscribe' }).click()
      await page.waitForURL(/\/dashboard/)
    },
    setup_details: async (page) => {
      const r = await json(page, '/api/dashboard/profile', { data: { industry: 'Pool service', phone: '843 555 0142', cities: 'Charleston', description: '' } })
      expect(r.status).toBe(200)
      // The service area is part of the business record (ZIP screening on the booking page).
      const b = await json(page, '/api/dashboard/business', { data: { name: who.name, timezone: 'America/New_York', serviceZips: '29403, 29407' } })
      expect(b.status).toBe(200)
    },
    setup_services: async (page) => {
      const r = await json(page, '/api/dashboard/profile', { data: { industry: 'Pool service', phone: '843 555 0142', cities: 'Charleston', services: [{ name: 'Weekly cleaning', price: '$45' }, { name: 'Green pool recovery' }], requireServices: true } })
      expect(r.status).toBe(200)
    },
    setup_calendar: async (page) => {
      // The real OAuth handlers (PKCE, least-privilege scopes) against mock Google; the grant is the one the fault
      // injector (mock /__faults) can later revoke, like a customer removing GetShowUps from their Google account.
      await page.goto('/dashboard')
      await expect(page.getByRole('heading', { name: 'Connect Google Calendar' })).toBeVisible()
      await page.getByRole('button', { name: 'Connect Google Calendar' }).click()
      await expect(page.getByRole('heading', { name: 'Google Calendar connected' })).toBeVisible()
    },
    setup_hours: async (page) => {
      const r = await json(page, '/api/dashboard/hours', { data: { workdays: [1, 2, 3, 4, 5, 6], dayStart: '08:00', dayEnd: '18:00', slotMinutes: 60 } })
      expect(r.status).toBe(200)
    },
    setup_website: async (page) => {
      // "I'm starting fresh": the deterministic starter site from the business's own records (no AI, no key).
      const r = await json(page, '/api/dashboard/website', { data: { action: 'starter' } })
      expect(r.status).toBe(200)
    },
    setup_address: async (page) => {
      const r = await json(page, '/api/dashboard/onboarding', { data: { action: 'address', choice: 'getshowups' } })
      expect(r.status).toBe(200)
    },
    setup_publish: async (page) => {
      // Publishing needs explicit confirmation and the draft version it was based on (409 if it moved meanwhile).
      const w = (await json(page, '/api/dashboard/website')).body
      const legal = (w.website.draft?.site?.pages || []).some((p) => p.legal)
      const r = await json(page, '/api/dashboard/website', { data: { action: 'publish', content: w.website.draft, confirm: true, baseUpdatedAt: w.website.updatedAt, ...(legal ? { legalReviewed: true } : {}) } })
      expect(r.status, JSON.stringify(r.body?.error)).toBe(200)
    },
    setup_launch: async (page) => {
      const r = await json(page, '/api/dashboard/onboarding', { data: { action: 'finish' } })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    },
    calendar_reconnect: async (page) => {
      // Settings says "Needs reconnecting" and offers the button; the owner goes through Google again.
      await page.goto('/dashboard/settings')
      await expect(page.getByText('Needs reconnecting')).toBeVisible()
      await page.getByRole('button', { name: 'Reconnect Google Calendar' }).click()
      await expect(page.getByRole('heading', { name: 'Google Calendar connected' })).toBeVisible()
    },
  }
}

// Registers the mock Google returns for this page: sign-in as `email`, calendar grant `calendarCode`.
export async function useGoogle(page, { email, calendarCode }) {
  await returnFromGoogle(page, '**/api/auth/google/start', 'GET', '/api/auth/google/callback', `login:${email}`)
  await returnFromGoogle(page, '**/api/google/oauth/start', 'POST', '/api/google/oauth/callback', `connect:${calendarCode}`)
}

// Runs actions[state] until ready or stuck. After an action the effect can arrive asynchronously (the webhook after
// checkout, the Google redirect), so the runner waits up to settleMs for the backend state to move before judging
// the step stuck. The same state twice in a row is a failure with a diagnosis, never an endless retry.
// `stopAt`: return as soon as that state is reached (ok: true, stopped: true), so a spec can interrupt the journey
// there (sign out, inject a failure, check what a half-set-up business looks like) and resume with another call.
export async function runJourney(page, actions, { maxSteps = 16, settleMs = 30_000, stopAt = null, log = () => {} } = {}) {
  const trace = []
  let last = null
  let next = null
  for (let i = 0; i < maxSteps; i++) {
    const s = next || (await detect(page))
    next = null
    trace.push({ step: i + 1, state: s.state, ...(s.details ? { details: s.details } : {}) })
    log(`${i + 1}. ${s.state}${s.details ? ' ' + JSON.stringify(s.details) : ''}`)
    if (s.ready) return { ok: true, trace, final: s }
    if (stopAt && s.state === stopAt) return { ok: true, stopped: true, trace, final: s }
    if (s.state === last) return { ok: false, trace, final: s, diagnosis: await diagnose(page, `"${s.state}" did not change after its action`) }
    const act = actions[s.state]
    if (!act) return { ok: false, trace, final: s, diagnosis: await diagnose(page, `no action for state "${s.state}"`) }
    try {
      await act(page)
    } catch (err) {
      return { ok: false, trace, final: s, diagnosis: await diagnose(page, `action for "${s.state}" failed: ${String(err.message).split('\n')[0]}`) }
    }
    for (const end = Date.now() + settleMs; Date.now() < end; ) {
      const after = await detect(page).catch(() => null)
      if (after && after.state !== s.state) {
        next = after
        break
      }
      await page.waitForTimeout(500)
    }
    last = s.state
  }
  return { ok: false, trace, diagnosis: { reason: `not ready after ${maxSteps} steps` } }
}

// What the page shows when a step is stuck: the path without its query string (no codes or state) and visible alerts.
async function diagnose(page, reason) {
  const alerts = await page.getByRole('alert').allTextContents().catch(() => [])
  let path = null
  try {
    path = new URL(page.url()).pathname
  } catch {
    // about:blank
  }
  return { reason, path, alerts: alerts.map((a) => a.slice(0, 160)) }
}

// A customer books on the public page through the same API the booking page uses. Returns the appointment.
export async function bookAsCustomer(page, business, { email, zip = '29403', start } = {}) {
  const data = (await json(page, `/api/book/${business}`)).body
  const slot = start ?? data.slots[0]
  const lead = await json(page, `/api/book/${business}/lead`, { data: { name: 'Casey Customer', email, phone: '(555) 010-0177', need: 'Weekly cleaning', zip, website: '' } })
  expect(lead.status, JSON.stringify(lead.body)).toBe(201)
  const appt = await json(page, `/api/book/${business}/appointment`, { data: { leadId: lead.body.leadId, leadToken: lead.body.leadToken, start: slot } })
  return { lead: lead.body, appointment: appt, slot, offered: data.slots }
}

// Mock-provider helpers (test-only endpoints of the local stand-in).
export const mockEvents = async (page) => (await page.request.get(`${MOCK}/__events`)).json()
export const injectFault = (page, customer, fault) => page.request.post(`${MOCK}/__faults`, { data: { customer, fault } })
