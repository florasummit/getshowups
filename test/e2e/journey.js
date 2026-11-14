// Autonomous customer journey: sign-in → setup (Calendar) → Google Ads connection → ready.
// detect() reads the real backend state (never trusts navigation alone) and names the next step; runJourney()
// performs steps until the business is ready, verifying the backend after every action, and fails with a
// diagnosis when a step doesn't move the state forward. Shared by the mocked CI spec (journey.spec.js) and the
// opt-in live check (scripts/journey-live.mjs). Traces contain state names only: no tokens, emails or ids.

// What each Google authorization step asks for, in plain words (used when a human must approve it).
export const PERMISSIONS = {
  sign_in: { scopes: ['openid', 'email'], why: 'Sign in to GetShowUps with Google (identity only).' },
  calendar: { scopes: ['calendar.freebusy', 'calendar.events.owned'], why: 'Show open times from busy/free blocks and add booked appointments to the business calendar.' },
  ads: { scopes: ['adwords'], why: "Create, start, pause and report on the campaigns the owner approves in the owner's own Google Ads account." },
}

const json = async (page, path) => {
  const r = await page.request.get(path)
  return { status: r.status(), body: r.status() === 200 ? await r.json() : null }
}

// Returns { state, ready, details } where state is the next thing to do (or 'ready').
export async function detect(page, base = '') {
  const me = await json(page, `${base}/api/dashboard/me`)
  if (me.status === 401) return { state: 'sign_in', ready: false }
  if (me.status !== 200) return { state: 'error', ready: false, details: { me: me.status } }
  const m = me.body
  if (!m.customer) return { state: 'no_business', ready: false }
  const pending = (m.progress?.steps || []).find((s) => !s.done)
  if (pending) return { state: `setup_${pending.id}`, ready: false, business: m.customer.id }
  const cal = await json(page, `${base}/api/dashboard/calendar`)
  if (cal.body?.status !== 'healthy') return { state: 'setup_calendar', ready: false, business: m.customer.id, details: { calendar: cal.body?.status || cal.status } }
  if (!m.features?.ads) return { state: 'ready', ready: true, business: m.customer.id, details: { ads: 'not enabled for this business' } }
  const ads = (await json(page, `${base}/api/dashboard/ads`)).body
  if (!ads) return { state: 'error', ready: false, details: { ads: 'unavailable' } }
  if (!ads.profile) return { state: 'ads_profile', ready: false, business: m.customer.id }
  const g = ads.connections?.google
  if (!g) return { state: 'ads_connect', ready: false, business: m.customer.id }
  if (g.status === 'reconnect_required') return { state: 'ads_reconnect', ready: false, business: m.customer.id }
  if (g.status === 'needs_account') return { state: 'ads_choose_account', ready: false, business: m.customer.id }
  if (!ads.capabilities.liveLaunch && !g.testAccount) return { state: 'ads_not_test_account', ready: false, business: m.customer.id }
  return { state: 'ready', ready: true, business: m.customer.id, details: { ads: 'connected', testAccount: g.testAccount === true } }
}

// Runs actions[state] until ready. Each action must change the backend state; repeating a state twice in a row
// is a failure with a diagnosis (what the page shows), never an endless retry.
// After an action the effect can arrive asynchronously (a form POST to Google, a redirect, a background save), so
// the runner waits up to settleMs for the backend state to move before judging the step stuck.
export async function runJourney(page, actions, { base = '', maxSteps = 12, settleMs = 15000, log = () => {} } = {}) {
  const trace = []
  let last = null
  let next = null
  for (let i = 0; i < maxSteps; i++) {
    const s = next || (await detect(page, base))
    next = null
    trace.push({ step: i + 1, state: s.state, ...(s.details ? { details: s.details } : {}) })
    log(`${i + 1}. ${s.state}`)
    if (s.ready) return { ok: true, trace, final: s }
    if (s.state === last) return { ok: false, trace, final: s, diagnosis: await diagnose(page, `"${s.state}" did not change after its action`) }
    const act = actions[s.state]
    if (!act) return { ok: false, trace, final: s, diagnosis: await diagnose(page, `no action for state "${s.state}"`) }
    try {
      await act(page)
    } catch (err) {
      return { ok: false, trace, final: s, diagnosis: await diagnose(page, `action for "${s.state}" failed: ${String(err.message).split('\n')[0]}`) }
    }
    for (const end = Date.now() + settleMs; Date.now() < end; ) {
      const after = await detect(page, base).catch(() => null)
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

async function diagnose(page, reason) {
  const alerts = await page.getByRole('alert').allTextContents().catch(() => [])
  const path = (() => {
    try {
      return new URL(page.url()).pathname // path only: no query (codes/state), no host
    } catch {
      return null
    }
  })()
  return { reason, path, alerts: alerts.map((a) => a.slice(0, 160)) }
}
