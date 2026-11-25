// Ads: results first, then a short guided setup (business details → plan → budget → accounts →
// review and launch). Every campaign is an editable draft until the owner approves it; launching
// creates it PAUSED and nothing spends until the owner presses Start.
import { useCallback, useEffect, useRef, useState } from 'react'
import { TitleHelp } from './Help.jsx'
import { api } from '../lib/api.js'
import AdsResults from './AdsResults.jsx'
import AdsImported from './AdsImported.jsx'

const money = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: c % 100 ? 2 : 0 })}`)
const toCents = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100))
const acct = (id) => String(id || '').replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3')
const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

const ERRORS = {
  profile_required: 'Save your business details first.',
  budget_approval_required: 'Approve a monthly budget first.',
  live_launch_disabled: 'Launching on Google or Meta is not switched on for your account yet. Use “Check (no spend)” for now.',
  test_account_required: 'Only a Google Ads test account can be used right now, and Google did not confirm this one is a test account.',
  exceeds_approved_budget: 'This campaign’s daily budget is above what your approved budget allows.',
  monthly_budget_reached: 'This month’s approved budget has been used. Raise your budget to restart.',
  needs_account: 'Connect and choose an ad account first.',
  not_connected: 'Connect the ad account first.',
  reconnect_required: 'Reconnect the ad account; access has expired.',
  not_approved_for_production: 'Google only lets GetShowUps use Google Ads test accounts for now, and this sign-in reached a real (production) account. Nothing was changed in it.',
  permission_denied: 'This Google sign-in doesn’t have permission for that Google Ads account.',
  transient: 'Google Ads didn’t respond. Please try again in a minute.',
  quota_exhausted: 'Google Ads is busy. Please try again in a few minutes.',
  creative_not_approved: 'Approve the image this ad uses first.',
  image_required: 'Add an approved image for this Meta ad.',
  quota_images: 'You’ve used this month’s image allowance.',
  quota_videos: 'You’ve used this month’s video allowance.',
  quota_cost: 'You’ve reached this month’s AI usage limit.',
  not_configured: 'This isn’t available yet.',
  ai_declined: 'The planner couldn’t write this plan. Try changing the services.',
  rate_limited: 'Too many tries. Please wait a few minutes.',
  subscription_required: 'Ads need an active GetShowUps subscription. Open Settings → Billing.',
  ads_on_hold: 'Ads are paused while there’s a problem with this account (see the notice at the top). Fix it, then press Start.',
  ads_on_hold_pause_first: 'Your account is on hold: pause the running campaigns first, then disconnect.',
  still_reachable_retry: 'GetShowUps can still reach this campaign; it will be paused automatically. Try again in a few minutes.',
  draft_exists: 'You already have a draft. Edit it below, or remove it to start over.',
  account_changed: 'This campaign is in a different Google Ads account than the one connected now. Switch back to manage it, or manage it in Google Ads.',
  removed_on_google: 'This campaign was removed in Google Ads.',
  campaigns_running: 'A campaign is still running. Choose whether to pause it first.',
  account_not_accessible: 'That account isn’t available with this Google sign-in. Choose one from the list.',
  invalid_account: 'Choose an account from the list.',
  invalid_budget: 'Enter a daily budget in dollars.',
  invalid_status: 'Only a created campaign (running or paused) can change its budget.',
  not_launched: 'Create the campaign on Google first.',
  too_many_creatives: 'You have as many images as this account can hold. Reject some you don’t need.',
  invalid_image: 'That photo can’t be used as an ad image.',
  creative_unavailable: 'One of the images isn’t approved any more. Choose an approved image.',
  unsupported_destination: 'Only lead ads with an instant form can be created right now.',
  app_not_approved: 'Meta hasn’t approved GetShowUps’ app for this yet.',
  account_disabled: 'Meta reports this ad account as disabled. Check it in Ads Manager.',
  creative_rejected: 'Meta rejected the ad’s image or text. Change it and try again.',
  invalid_request: 'Meta didn’t accept the campaign as drafted. Check the fields and try again.',
  invalid_key_format: 'That doesn’t look like a ChatGPT Ads API key. Copy it again from Ads Manager → Settings.',
  invalid_key: 'ChatGPT Ads didn’t accept that key. Create a new one in Ads Manager → Settings and paste it here.',
  platform_unavailable: 'ChatGPT ads aren’t switched on for GetShowUps yet.',
  not_paused: 'ChatGPT Ads reported this campaign as running, so GetShowUps paused it straight away and stopped. Check it in Ads Manager.',
}
const PLATFORM_NAME = { google: 'Google', meta: 'Meta', openai: 'ChatGPT Ads' }
const PLATFORM_TITLE = { google: 'Google Search', meta: 'Facebook & Instagram', openai: 'ChatGPT ads' }
const O = { title: 50, titleMin: 3, body: 100, hints: 10, hint: 200 } // mirrors server/ads/spec.js LIMITS.openai (the server decides)
const OPENAI_GEO = 'ChatGPT ads can only target whole metro areas or states, not your ZIP codes. Someone outside your ZIP codes can still see and click the ad: your booking page checks their ZIP and won’t offer times, but the click is still paid for.'
const CHARGING_OPENAI = 'The daily budget is the most ChatGPT Ads may spend on this campaign in a day. There is no ChatGPT Ads test account: anything created is real, and stays paused until you press Start.'
const META_CTA_LABEL = { GET_QUOTE: 'Get quote', BOOK_NOW: 'Book now', LEARN_MORE: 'Learn more', CONTACT_US: 'Contact us' }
const META_FORM_LABEL = { FULL_NAME: 'Full name', PHONE: 'Phone', EMAIL: 'Email', ZIP: 'ZIP code' }
const META_PLACEMENT_LABEL = { facebook: 'Facebook', instagram: 'Instagram' }
// Meta's charging rule, in plain words (Meta Business Help Center: daily budgets are an average; up to 25% more on
// some days, never more than 7× the daily budget in a calendar week).
const CHARGING_META = 'Meta may spend up to 25% more than the daily budget on a busy day, but never more than 7 times the daily budget in a calendar week.'
const errorText = (code) => ERRORS[code] || 'Something went wrong. Please try again.'

// What the owner sees after coming back from Google or Meta sign-in (?ads= / ?ads_error= on the URL).
const RETURNS = {
  google_connected: 'Google Ads is connected.',
  meta_connected: 'Facebook & Instagram is connected.',
  gbp_connected: 'Google Business Profile is connected.',
  gbp_cancelled: 'Sign-in was cancelled. Nothing was connected.',
  gbp_expired: 'That sign-in timed out or was started in another tab. Click Connect to try again.',
  gbp_scope_denied: 'Business Profile access wasn’t granted. Click Connect again and allow access to your Business Profile.',
  gbp_no_refresh_token: 'Google didn’t grant lasting access. Click Connect again.',
  gbp_failed: 'Sign-in didn’t finish. Please try again.',
  gbp_unauthenticated: 'Sign in to GetShowUps first, then connect.',
  gbp_not_configured: 'Business Profile connection isn’t available yet.',
  gbp_permission_denied: 'Google didn’t let GetShowUps read Business Profile listings for this account. If Google hasn’t approved GetShowUps’ access yet, this is expected.',
  gbp_quota_exhausted: 'Google’s Business Profile API is busy or GetShowUps’ access isn’t approved yet. Try again later.',
  gbp_transient: 'Google didn’t respond. Nothing was connected; try again in a minute.',
  gbp_reconnect_required: 'Google didn’t accept the sign-in. Click Connect to try again.',
  gbp_rate_limited: 'Too many sign-in attempts in a short time. Wait a few minutes, then click Connect again.',
  cancelled: 'Sign-in was cancelled. Nothing was connected.',
  expired: 'That sign-in timed out or was started in another tab. Click Connect to try again.',
  scope_denied: 'Google Ads access wasn’t granted. Click Connect again and allow access to Google Ads.',
  no_refresh_token: 'Google didn’t grant lasting access. Click Connect again. If it repeats, remove GetShowUps under your Google Account’s third-party access, then connect.',
  failed: 'Sign-in didn’t finish. Please try again.',
  unauthenticated: 'Sign in to GetShowUps first, then connect.',
  signin_required: 'Sign in to GetShowUps first, then connect.',
  not_configured: 'Connecting isn’t available for this business right now, so nothing was connected.',
  rate_limited: 'Too many sign-in attempts in a short time. Wait a few minutes, then click Connect again.',
  reconnect_required: 'Meta didn’t accept the sign-in. Click Connect to try again.',
  transient: 'Meta didn’t respond. Nothing was connected; try again in a minute.',
  permission_denied: 'Meta didn’t grant GetShowUps access to your ad accounts and Pages. Click Connect again and allow access.',
  app_not_approved: 'Meta hasn’t approved GetShowUps for this permission yet. Nothing was connected.',
  invalid_request: 'Meta refused the sign-in. Nothing was connected; try again.',
}
function readReturn() {
  const q = new URLSearchParams(window.location.search)
  const ok = q.get('ads')
  const err = q.get('ads_error')
  if (!ok && !err) return null
  if (ok) return RETURNS[ok] ? { ok: RETURNS[ok] } : null
  return { error: RETURNS[err] || errorText(err) }
}

function ProfileForm({ profile, onSaved }) {
  const p = profile || { services: [], serviceArea: { zips: [], cities: [] }, approvedClaims: [] }
  const [state, setState] = useState({})
  const submit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const body = {
      website: f.get('website').trim(),
      industry: f.get('industry').trim(),
      services: lines(f.get('services')),
      serviceArea: { zips: String(f.get('zips')).split(/[\s,]+/).filter(Boolean), cities: lines(f.get('cities')) },
      exclusions: f.get('exclusions').trim(),
      customerValueCents: toCents(f.get('value')),
      objective: 'leads',
      monthlyBudgetCents: toCents(f.get('budget')),
      approvedClaims: lines(f.get('claims')),
    }
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/ads/profile', { method: 'POST', body })
    if (status === 200) {
      setState({ saved: true })
      onSaved()
    } else setState({ error: data.fields ? `Check: ${data.fields.join(', ')}` : errorText(data.error) })
  }
  return (
    <form onSubmit={submit} className="stack">
      <label className="field">
        <span>What kind of business?</span>
        <input name="industry" defaultValue={p.industry} placeholder="Pool service" required maxLength={80} />
      </label>
      <label className="field">
        <span>Services you want customers for <em>(one per line or separated by commas)</em></span>
        <textarea name="services" rows={3} defaultValue={p.services.join('\n')} required />
      </label>
      <label className="field">
        <span>ZIP codes you serve</span>
        <input name="zips" defaultValue={p.serviceArea.zips.join(', ')} inputMode="numeric" placeholder="29403, 29407" required />
      </label>
      <label className="field">
        <span>Towns or cities <em>(optional, one per line)</em></span>
        <textarea name="cities" rows={2} defaultValue={(p.serviceArea.cities || []).join('\n')} />
      </label>
      <label className="field">
        <span>Work you don’t want <em>(optional)</em></span>
        <input name="exclusions" defaultValue={p.exclusions} placeholder="Commercial pools" maxLength={500} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Typical first job ($)</span>
          <input name="value" type="number" min="0" step="1" defaultValue={p.customerValueCents != null ? p.customerValueCents / 100 : ''} />
        </label>
        <label className="field">
          <span>Monthly ad budget ($)</span>
          <input name="budget" type="number" min="150" step="1" defaultValue={p.monthlyBudgetCents != null ? p.monthlyBudgetCents / 100 : ''} />
        </label>
      </div>
      <label className="field">
        <span>Website <em>(optional)</em></span>
        <input name="website" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck="false" maxLength={2048} defaultValue={p.website} placeholder="yourbusiness.com" />
      </label>
      <label className="field">
        <span>
          True claims ads may use <em>(optional, one per line: e.g. “Licensed and insured”. Ads never mention reviews, discounts or guarantees you don’t list.)</em>
        </span>
        <textarea name="claims" rows={2} defaultValue={p.approvedClaims.join('\n')} />
      </label>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <button className="btn btn-primary" disabled={state.busy}>
        {state.busy ? 'Saving…' : 'Save details'}
      </button>
      {state.saved && <p className="fine" role="status">Saved.</p>}
    </form>
  )
}

function BudgetCard({ budget, profile, onSaved }) {
  const [amount, setAmount] = useState(budget ? budget.monthlyCents / 100 : profile?.monthlyBudgetCents ? profile.monthlyBudgetCents / 100 : 500)
  const [ok, setOk] = useState(false)
  const [state, setState] = useState({})
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/ads/budget', { method: 'POST', body: { monthlyCents: toCents(amount), confirm: ok } })
    if (status === 200) {
      const e = data.enforced || {}
      setState({
        note:
          e.lowered || e.paused
            ? `Approved. To fit it, ${e.lowered ? `${plural(e.lowered, 'running campaign')} got a lower daily budget` : ''}${e.lowered && e.paused ? ' and ' : ''}${e.paused ? `${plural(e.paused, 'campaign')} was paused` : ''}.`
            : e.failed
              ? 'Approved, but a running campaign couldn’t be lowered on Google. Pause it in Google Ads.'
              : null,
      })
      setOk(false)
      onSaved()
    } else setState({ error: data.error === 'invalid_budget' ? 'Choose between $150 and $50,000 a month.' : errorText(data.error) })
  }
  return (
    <section className="card">
      <TitleHelp help="ad_budget">4. Approve your monthly ad budget</TitleHelp>
      {budget ? (
        <p>
          Approved: <strong>{money(budget.monthlyCents)}/month</strong>. GetShowUps sets Google’s average daily budget for you: up to {money(budget.dailyCeilingCents)}/day across
          all campaigns.
        </p>
      ) : (
        <p>No budget approved yet. Nothing can launch until you approve one.</p>
      )}
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{budget ? 'Change monthly limit ($)' : 'Monthly limit ($)'}</span>
          <input type="number" min="150" max="50000" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label className="check">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>
            I approve up to {money(toCents(amount))} a month in ad spend. Google and Meta bill my own ad account directly; GetShowUps never raises this limit.
          </span>
        </label>
        <p className="fine">{CHARGING} Lowering the limit also lowers campaigns that are running.</p>
        <dl className="who-pays" aria-label="Who pays what">
          <div>
            <dt>Ad spend</dt>
            <dd>Charged by Google, directly to the payment method in your Google Ads account.</dd>
          </div>
          <div>
            <dt>Your GetShowUps plan</dt>
            <dd>Doesn’t include ad spend.</dd>
          </div>
        </dl>
        <p className="muted">
          Advertising spend is separate from your GetShowUps subscription and is billed by Google. GetShowUps does not currently charge an additional percentage of your ad spend.
        </p>
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        {state.note && (
          <p className="fine" role="status">
            {state.note}
          </p>
        )}
        <button className="btn btn-primary" disabled={!ok || state.busy}>
          Approve budget
        </button>
      </form>
    </section>
  )
}

// Google Ads has two separate states (server/ads/connections.js):
//   1. Google sign-in: the stored, encrypted authorization. status 'reconnect_required' = it expired or was revoked.
//   2. The Google Ads account the business's ads run in: status 'connected' + accountId. 'needs_account' = signed
//      in, no account chosen yet.
// The server finds the choosable accounts (including ones under a manager); while ads are in testing it offers
// only accounts Google flags as test accounts, and it re-checks every choice.
// Ad payments are set up in Google Ads; Google bills the business directly. GetShowUps only shows the state.
const BILLING_URL = 'https://ads.google.com/aw/billing/summary'
function Payment({ state }) {
  const ok = state === 'ready'
  return (
    <p className={`conn-status conn-status--${ok ? 'ok' : 'warn'}`} data-billing={state}>
      <span className="conn-icon" aria-hidden="true">
        {ok ? '✓' : '!'}
      </span>
      <span>
        {ok ? 'Payment set up in Google Ads' : state === 'pending' ? 'Payment setup is pending in Google Ads' : state === 'missing' ? 'Add a payment method in Google Ads before ads can run' : 'Check that a payment method is set up in Google Ads'}
        {!ok && (
          <>
            {' '}
            <a href={BILLING_URL} target="_blank" rel="noreferrer">
              Open billing
            </a>
          </>
        )}
      </span>
    </p>
  )
}

function GoogleAdsAccount({ c, onChange }) {
  const [list, setList] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [changing, setChanging] = useState(false)
  const [state, setState] = useState({})
  const auto = useRef(false)
  const changed = useRef(onChange)
  useEffect(() => {
    changed.current = onChange
  }, [onChange])
  const choose = useCallback(async (accountId) => {
    setState({ busy: accountId })
    const { status, data } = await api('/api/ads/google/accounts', { method: 'POST', body: { accountId } })
    if (status === 200) {
      setState({})
      setChanging(false)
      changed.current()
    } else setState({ error: errorText(data.error) })
  }, [])
  useEffect(() => {
    api('/api/ads/google/accounts').then(({ status, data }) => {
      const l = status === 200 ? data : { error: data?.error }
      setList(l)
      // Exactly one choosable account and none chosen before: nothing to decide, so use it. Not when an earlier
      // choice was reset (e.g. a test business became real): that needs the owner's explicit choice.
      if (c.status === 'needs_account' && !l.error && l.accounts.length === 1 && !l.selected && !auto.current) {
        auto.current = true
        choose(l.accounts[0].id)
      }
    })
  }, [attempt, c.status, choose])

  const name = (a) => a.name || 'Google Ads account'
  const selected = c.status === 'connected' ? c.accountId : null
  const others = list?.accounts ? list.accounts.filter((a) => a.id !== selected) : []

  if (selected && !changing) {
    return (
      <div className="stack" data-ads-account>
        <p className="account-selected">
          <strong>{c.accountName || 'Google Ads account'}</strong> <span className="fine">{acct(selected)}</span>
          {c.testAccount && (
            <span className="badge badge--test" data-test-account title="Google Ads test account: ads never show and nothing is charged.">
              Test account · no spend
            </span>
          )}
        </p>
        {list?.billing && list.billing !== 'not_needed' && <Payment state={list.billing} />}
        {others.length > 0 && (
          <button type="button" className="link-btn" onClick={() => setChanging(true)}>
            Change account
          </button>
        )}
      </div>
    )
  }
  if (!list) return <p className="fine" aria-busy="true">Finding your Google Ads accounts…</p>
  if (list.error)
    return (
      <p className="form-error" role="alert">
        {errorText(list.error)}{' '}
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setList(null)
            setAttempt((n) => n + 1)
          }}
        >
          Try again
        </button>
      </p>
    )
  if (state.busy && !changing && list.accounts.length === 1) return <p className="fine" aria-busy="true">Selecting {name(list.accounts[0])}…</p>
  const again = (
    <button
      type="button"
      className="btn btn-quiet"
      onClick={() => {
        setList(null)
        setAttempt((n) => n + 1)
      }}
    >
      Check again
    </button>
  )
  if (!list.accounts.length)
    return list.sandbox ? (
      <div className="stack" role="status" data-no-accounts="sandbox">
        <p className="fine">
          No Google Ads test accounts found for this Google sign-in. While ads are in testing, only test accounts can be used. Reconnect with the Google
          account that has your test account.
        </p>
        {again}
      </div>
    ) : (
      <div className="stack" role="status" data-no-accounts="live">
        <p>This Google sign-in has no Google Ads account yet. Setting one up takes a few minutes:</p>
        <ol className="setup-steps">
          <li>
            Create a free account at{' '}
            <a href="https://ads.google.com/" target="_blank" rel="noreferrer">
              ads.google.com
            </a>
            . If Google starts a campaign, choose to set up the account without one (GetShowUps creates the campaign).
          </li>
          <li>Add a payment method in Google Ads (Billing). Google charges you directly for ads; GetShowUps never sees your card.</li>
          <li>Come back here and check again.</li>
        </ol>
        {again}
      </div>
    )
  return (
    <div className="stack" role="group" aria-label="Choose a Google Ads account">
      <p className="fine">{selected ? 'Choose a different account for your ads:' : 'Choose the account your ads should run in:'}</p>
      <ul className="rows account-pick">
        {list.accounts.map((a) => (
          <li key={a.id} className="row">
            <span>
              <strong>{name(a)}</strong> <span className="fine">{acct(a.id)}</span>
              {a.testAccount && <span className="chip">Test account</span>}
            </span>
            {a.id === selected ? (
              <span className="fine account-current">
                <span aria-hidden="true">✓</span> Selected
              </span>
            ) : (
              <button type="button" className="btn btn-quiet" disabled={Boolean(state.busy)} onClick={() => choose(a.id)} aria-label={`Use ${name(a)} ${acct(a.id)}`}>
                {state.busy === a.id ? 'Checking with Google…' : 'Use this account'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {list.sandbox && list.hidden > 0 && <p className="fine">Only test accounts are shown while ads are in testing.</p>}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {selected && (
        <button type="button" className="link-btn" onClick={() => setChanging(false)}>
          Keep {c.accountName || 'the current account'}
        </button>
      )}
    </div>
  )
}

// One status per connection, always as words plus an icon (never color alone).
const CONN = {
  connected: { icon: '✓', text: 'Connected', tone: 'ok' },
  needs_account: { icon: '•', text: 'Choose an ad account', tone: 'info' },
  reconnect_required: { icon: '!', text: 'Reconnect required', tone: 'warn' },
  none: { icon: '○', text: 'Not connected', tone: 'off' },
}
const connState = (c) => (!c ? 'none' : c.status === 'reconnect_required' ? 'reconnect_required' : c.status === 'connected' ? 'connected' : 'needs_account')

// Meta: the ad account AND the Page the lead form and ads belong to. One of each is chosen automatically when the
// sign-in reaches exactly one; otherwise the owner picks here (the server validates against Meta's lists).
function MetaAccounts({ c, onChange }) {
  const [list, setList] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [changing, setChanging] = useState(false)
  const [pick, setPick] = useState({ adAccountId: '', pageId: '' })
  const [state, setState] = useState({})
  const changed = useRef(onChange)
  useEffect(() => {
    changed.current = onChange
  }, [onChange])
  useEffect(() => {
    if (c.status === 'connected' && !changing) return
    api('/api/ads/meta/accounts').then(({ status, data }) => {
      const l = status === 200 ? data : { error: data?.error }
      setList(l)
      if (!l.error) setPick({ adAccountId: l.selected?.adAccountId || (l.adAccounts.filter((a) => a.active).length === 1 ? l.adAccounts.find((a) => a.active).id : ''), pageId: l.selected?.pageId || (l.pages.length === 1 ? l.pages[0].id : '') })
    })
  }, [attempt, c.status, changing])
  const choose = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const { status, data } = await api('/api/ads/meta/accounts', { method: 'POST', body: pick })
    if (status === 200) {
      setState({})
      setChanging(false)
      changed.current()
    } else setState({ error: errorText(data.error) })
  }
  if (c.status === 'connected' && !changing) {
    return (
      <div className="stack" data-meta-account>
        <p className="account-selected">
          <strong>{c.accountName || 'Meta ad account'}</strong>
          {c.pageName && <span className="fine"> · Page: {c.pageName}</span>}
          {c.sandboxAccount && (
            <span className="badge badge--test" data-meta-sandbox title="Sandbox ad account: API-only, ads never show and nothing is charged.">
              Sandbox account · no spend
            </span>
          )}
        </p>
        <button type="button" className="link-btn" onClick={() => setChanging(true)}>
          Change account or Page
        </button>
      </div>
    )
  }
  if (!list) return <p className="fine" aria-busy="true">Finding your ad accounts and Pages…</p>
  if (list.error)
    return (
      <p className="form-error" role="alert">
        {errorText(list.error)}{' '}
        <button type="button" className="link-btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </p>
    )
  const active = list.adAccounts.filter((a) => a.active)
  return (
    <form className="stack" onSubmit={choose} aria-label="Choose a Meta ad account and Page" data-meta-picker>
      <label className="field">
        <span>Ad account</span>
        <select value={pick.adAccountId} onChange={(e) => setPick((p) => ({ ...p, adAccountId: e.target.value }))} data-meta-pick-account>
          <option value="">Choose…</option>
          {active.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.id} ({a.currency})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Facebook Page (the ads and the lead form belong to it)</span>
        <select value={pick.pageId} onChange={(e) => setPick((p) => ({ ...p, pageId: e.target.value }))} data-meta-pick-page>
          <option value="">Choose…</option>
          {list.pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.id}
            </option>
          ))}
        </select>
      </label>
      {!active.length && <p className="fine">Your Meta sign-in reaches no active ad account. Create one in Ads Manager, then reconnect.</p>}
      {!list.pages.length && <p className="fine">Your Meta sign-in reaches no Facebook Page. Lead ads need a Page; create one, then reconnect.</p>}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="card-actions">
        <button type="submit" className="btn btn-primary" disabled={state.busy || !pick.adAccountId || !pick.pageId}>
          Use this account and Page
        </button>
        {changing && (
          <button type="button" className="link-btn" onClick={() => setChanging(false)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

// Disconnect: GetShowUps stops managing and reporting. Campaigns in Google Ads stay there; if any run, the owner
// chooses to pause them first or leave them running (never implied to have stopped).
function DisconnectGoogle({ running, onDone, onCancel }) {
  const [state, setState] = useState({})
  const go = async (extra) => {
    setState({ busy: true })
    const { status, data } = await api('/api/ads/google/disconnect', { method: 'POST', body: { confirm: true, ...extra } })
    if (status === 200) onDone(data)
    else setState({ error: data.error === 'pause_failed' ? 'Couldn’t pause a campaign on Google, so nothing was disconnected. Try again, or pause it in Google Ads.' : errorText(data.error) })
  }
  return (
    <div className="confirm" role="group" aria-label="Confirm disconnect">
      <p>
        Disconnect Google Ads? GetShowUps stops managing and reporting your ads.{' '}
        {running ? <strong>{plural(running, 'campaign')} still running in Google Ads will keep running and spending unless paused.</strong> : 'Campaigns already in Google Ads stay there.'}
      </p>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="card-actions">
        {running ? (
          <>
            <button type="button" className="btn btn-primary" disabled={state.busy} onClick={() => go({ pauseRunning: true })}>
              Pause and disconnect
            </button>
            <button type="button" className="btn btn-quiet" disabled={state.busy} onClick={() => go({ leaveRunning: true })}>
              Disconnect, keep running
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-danger" disabled={state.busy} onClick={() => go({})}>
            Confirm: disconnect
          </button>
        )}
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function Connections({ connections, capabilities, running = 0, runningOpenAi = 0, onChange, businessProfile = null, businessProfileReadiness = null }) {
  const [disconnecting, setDisconnecting] = useState(false)
  const [done, setDone] = useState(null)
  const row = (platform, label) => {
    const c = connections[platform]
    const available = capabilities[platform]
    const state = connState(c)
    const s = CONN[state]
    const start = `/api/ads/${platform}/start`
    const attention = state === 'none' || state === 'reconnect_required'
    return (
      <li key={platform} className="row conn-row">
        <div className="conn-main">
          <strong>{label}</strong>
          <p className={`conn-status conn-status--${s.tone}`} data-conn-status={state} data-platform={platform}>
            <span className="conn-icon" aria-hidden="true">
              {s.icon}
            </span>
            {s.text}
          </p>
          {state === 'reconnect_required' && <p className="fine">The sign-in expired. Your campaigns stay as they are.</p>}
          {platform === 'google' && (state === 'connected' || state === 'needs_account') && <GoogleAdsAccount c={c} onChange={onChange} />}
          {platform === 'meta' && (state === 'connected' || state === 'needs_account') && <MetaAccounts c={c} onChange={onChange} />}
          {available && !attention && !(platform === 'google' && disconnecting) && (
            <p className="conn-links">
              <a className="link-btn conn-secondary" href={start}>
                Reconnect
              </a>
              {platform === 'google' && (
                <button type="button" className="link-btn conn-secondary" onClick={() => setDisconnecting(true)}>
                  Disconnect
                </button>
              )}
            </p>
          )}
          {platform === 'google' && c && disconnecting && (
            <DisconnectGoogle
              running={running}
              onCancel={() => setDisconnecting(false)}
              onDone={(r) => {
                setDisconnecting(false)
                setDone(r)
                onChange()
              }}
            />
          )}
          {platform === 'google' && !c && done && (
            <p className="notice-info" role="status" data-disconnected>
              Disconnected.{' '}
              {done.leftRunning ? `${plural(done.leftRunning, 'campaign')} still running in Google Ads. Pause it there if you want it to stop. ` : done.stillInGoogleAds ? 'Your campaigns stay in Google Ads, paused. ' : ''}
              To remove GetShowUps’ access completely, use your{' '}
              <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">
                Google Account’s connections
              </a>{' '}
              (this also removes calendar access if it’s the same Google account).
            </p>
          )}
        </div>
        {!available ? (
          <span className="fine" data-platform-unavailable={platform}>
            {platform === 'meta'
              ? 'Not available yet: GetShowUps’ Facebook & Instagram connection isn’t set up on the platform. You can draft and preview Facebook & Instagram ads now; connecting your Page and ad account comes once it is. Nothing to do on your side.'
              : 'Not available yet: Google Ads sign-in isn’t set up on the platform.'}
          </span>
        ) : (
          attention && (
            <a className="btn btn-primary" href={start}>
              {state === 'none' ? 'Connect' : 'Reconnect'}
            </a>
          )
        )}
      </li>
    )
  }
  return (
    <section className="card">
      <h2 className="card-title">2. Connect your ad account</h2>
      <p className="fine">GetShowUps uses your Google Ads access only to create, change and report on the campaigns you approve here.</p>
      <ul className="rows">
        {row('google', 'Google Ads')}
        {row('meta', 'Facebook & Instagram')}
        {capabilities.openai && <OpenAiRow c={connections.openai} running={runningOpenAi} onChange={onChange} />}
        <BusinessProfileRow available={Boolean(capabilities.gbp)} profile={businessProfile} readiness={businessProfileReadiness} onChange={onChange} />
      </ul>
    </section>
  )
}

// Google Business Profile: a separate Google product and consent. States: platform access not approved yet (facts +
// Google's own setup), ready to connect, choose a location, connected (title, place, Google's verification state,
// what is missing on the profile), reconnect required. GetShowUps reads and links; it never creates or edits a listing.
const VERIFY_TONE = { verified: 'ok', pending_verification: 'info', waiting: 'info', needs_verification: 'warn', ownership_conflict: 'warn', suspended: 'bad', disabled: 'bad', guidelines: 'warn', unknown: 'neutral' }
const MISSING_LABEL = { website: 'website', phone: 'phone number', hours: 'opening hours', category: 'category' }
function BusinessProfileRow({ available, profile, readiness, onChange }) {
  const [picker, setPicker] = useState(null) // { locations, selected } | { error } | { busy }
  const state = !profile ? 'none' : profile.status === 'reconnect_required' ? 'reconnect_required' : profile.status === 'connected' ? 'connected' : 'needs_location'
  const s = state === 'needs_location' ? { icon: '•', text: 'Choose your business', tone: 'info' } : CONN[state]
  const openPicker = async () => {
    setPicker({ busy: true })
    const { status, data } = await api('/api/ads/gbp/locations')
    setPicker(status === 200 ? data : { error: data?.error === 'reconnect_required' ? 'Reconnect Google Business Profile; access has expired.' : 'Couldn’t read your Business Profile listings. Try again in a minute.' })
  }
  const choose = async (locationName) => {
    setPicker((p) => ({ ...p, busy: true }))
    const { status, data } = await api('/api/ads/gbp/locations', { method: 'POST', body: { locationName } })
    if (status === 200) {
      setPicker(null)
      onChange()
    } else setPicker((p) => ({ ...p, busy: false, error: data?.error === 'location_not_accessible' ? 'That listing isn’t one your Google account manages.' : 'Couldn’t link that listing. Try again in a minute.' }))
  }
  useEffect(() => {
    if (available && state === 'needs_location' && !picker) openPicker()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, state])
  const v = profile?.verification
  return (
    <li className="row conn-row" data-gbp-state={available ? state : 'unavailable'}>
      <div className="conn-main">
        <strong>Google Business Profile</strong>
        <p className={`conn-status conn-status--${available ? s.tone : 'off'}`} data-conn-status={available ? state : 'unavailable'} data-platform="gbp">
          <span className="conn-icon" aria-hidden="true">
            {available ? s.icon : '○'}
          </span>
          {available ? s.text : 'Not available yet'}
        </p>
        {state === 'connected' && (
          <div className="stack" data-gbp-listing>
            <p className="account-selected">
              <strong>{profile.title || 'Your business'}</strong> {profile.place && <span className="fine">{profile.place}</span>}
              {v && (
                <span className={`chip chip--${VERIFY_TONE[v.state] === 'ok' ? 'active' : VERIFY_TONE[v.state] === 'bad' ? 'error' : 'plain'}`} data-gbp-verification={v.state}>
                  {v.label}
                </span>
              )}
            </p>
            {v && !v.verified && <p className="fine">Google decides verification; until it says verified, this listing isn’t. Finish it in your Business Profile.</p>}
            {profile.missing?.length > 0 && (
              <p className="fine" data-gbp-missing>
                Missing on the profile: {profile.missing.map((m) => MISSING_LABEL[m] || m).join(', ')}. Add them in Google Business Profile; GetShowUps doesn’t edit your listing.
              </p>
            )}
            <p className="conn-links">
              {profile.mapsUri && (
                <a className="link-btn conn-secondary" href={profile.mapsUri} target="_blank" rel="noreferrer">
                  Open on Google Maps
                </a>
              )}
              {profile.choices > 1 && (
                <button type="button" className="link-btn conn-secondary" onClick={openPicker}>
                  Change business
                </button>
              )}
              <a className="link-btn conn-secondary" href="/api/ads/gbp/start">
                Reconnect
              </a>
            </p>
          </div>
        )}
        {state === 'reconnect_required' && <p className="fine">The sign-in expired. Your listing is unchanged.</p>}
        {available && picker && !picker.busy && picker.locations && (
          <div className="stack" role="group" aria-label="Choose your Business Profile listing">
            {picker.locations.length === 0 ? (
              <p className="fine">This Google account manages no Business Profile listing yet. Create or claim one with Google, then reconnect.</p>
            ) : (
              <ul className="rows account-pick">
                {picker.locations.map((l) => (
                  <li key={l.name} className="row">
                    <span>
                      <strong>{l.title}</strong> <span className="fine">{l.place}</span>
                      {l.verified && <span className="chip">Verified</span>}
                      {l.duplicate && <span className="chip">Duplicate</span>}
                    </span>
                    {l.name === picker.selected ? (
                      <span className="fine account-current">
                        <span aria-hidden="true">✓</span> Linked
                      </span>
                    ) : (
                      <button type="button" className="btn btn-quiet" onClick={() => choose(l.name)} aria-label={`Use ${l.title}`}>
                        Use this listing
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {picker?.error && (
          <p className="form-error" role="alert">
            {picker.error}
          </p>
        )}
        {!available && <span className="fine">Google must approve GetShowUps’ access to the Business Profile API first. Your listing itself is set up and verified with Google, not here.</span>}
        {state !== 'connected' && readiness && (
          <details className="more-options gbp-readiness" data-gbp-readiness>
            <summary>{state === 'none' ? 'Don’t have a Business Profile yet? What Google needs' : 'What Google needs for a Business Profile'}</summary>
            <ol className="gbp-steps">
              {readiness.items.map((i) => (
                <li key={i.id}>
                  <strong>{i.label}</strong> <span className="fine">{i.detail}</span>
                </li>
              ))}
            </ol>
            <p className="fine">
              GetShowUps never creates a listing for you (a second listing causes months of trouble) and never calls one verified until Google does.{' '}
              <a href={readiness.setupUrl} target="_blank" rel="noreferrer">
                Create or claim it with Google
              </a>
            </p>
          </details>
        )}
      </div>
      {available && (state === 'none' || state === 'reconnect_required') && (
        <a className="btn btn-primary" href="/api/ads/gbp/start">
          {state === 'none' ? 'Connect' : 'Reconnect'}
        </a>
      )}
    </li>
  )
}

function GooglePreview({ spec }) {
  const g = spec.google || {}
  const host = (() => {
    try {
      return new URL(spec.finalUrl).host
    } catch {
      return 'your-site'
    }
  })()
  return (
    <div className="ad-preview" aria-label="Ad preview">
      <p className="fine">Sponsored · {[host, g.path1, g.path2].filter(Boolean).join(' › ')}</p>
      <p className="ad-preview-title">{(g.headlines || []).slice(0, 3).join(' | ')}</p>
      <p>{(g.descriptions || [])[0]}</p>
    </div>
  )
}

function MetaPreview({ spec }) {
  const m = spec.meta || {}
  const img = (m.imageCreativeIds || [])[0]
  return (
    <div className="ad-preview ad-preview--meta" aria-label="Ad preview" data-meta-preview>
      <p className="fine">Sponsored · {(m.placements || ['facebook', 'instagram']).map((p) => META_PLACEMENT_LABEL[p]).join(' and ')}</p>
      <p>{(m.primaryTexts || [])[0]}</p>
      {img ? <img className="ad-preview-img" src={`/api/dashboard/ads/creative?id=${img}`} alt="" loading="lazy" /> : <p className="ad-preview-noimg">No image chosen yet</p>}
      <p className="ad-preview-title">{(m.headlines || [])[0]}</p>
      {m.description && <p className="fine">{m.description}</p>}
      <p className="ad-preview-cta">{META_CTA_LABEL[m.callToAction] || 'Learn more'}</p>
    </div>
  )
}

// ChatGPT chat card: what OpenAI shows under a ChatGPT answer (title, text, the site it opens).
function OpenAiPreview({ spec }) {
  const o = spec.openai || {}
  const host = (() => {
    try {
      return new URL(spec.finalUrl).host
    } catch {
      return 'your-site'
    }
  })()
  return (
    <div className="ad-preview" aria-label="Ad preview" data-openai-preview>
      <p className="fine">Sponsored · in ChatGPT · {host}</p>
      <p className="ad-preview-title">{o.title}</p>
      <p>{o.body}</p>
    </div>
  )
}

// The ChatGPT ad: chat-card text, what conversations it suits (context hints), and where (markets/regions only).
function OpenAiEditor({ spec, set, budget, server, busy, connected }) {
  const o = spec.openai || {}
  const setO = (patch) => set({ openai: { ...o, ...patch } })
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  const search = async (e) => {
    e.preventDefault()
    setFound({ busy: true })
    const { status, data } = await api(`/api/ads/openai/locations?q=${encodeURIComponent(q)}`)
    setFound(status === 200 ? { results: data.results } : { error: errorText(data.error) })
  }
  const locations = o.locations || []
  const add = (l) => setO({ locations: [...locations.filter((x) => x.id !== l.id), { id: l.id, name: l.name, type: l.type }] })
  const remove = (id) => setO({ locations: locations.filter((x) => x.id !== id) })
  const titleLen = (o.title || '').trim().length
  const bodyLen = (o.body || '').trim().length
  return (
    <div className="campaign-groups" data-openai-editor>
      <label className="field">
        <span>Title <em>({titleLen}/{O.title})</em></span>
        <input value={o.title || ''} maxLength={O.title + 10} disabled={busy} onChange={(e) => setO({ title: e.target.value })} aria-invalid={titleLen < O.titleMin || titleLen > O.title || Boolean(server['openai.title'])} />
        {server['openai.title'] && <span className="form-error">{server['openai.title']}</span>}
      </label>
      <label className="field">
        <span>Text <em>({bodyLen}/{O.body})</em></span>
        <textarea rows={2} value={o.body || ''} disabled={busy} onChange={(e) => setO({ body: e.target.value })} aria-invalid={bodyLen === 0 || bodyLen > O.body || Boolean(server['openai.body'])} />
        {server['openai.body'] && <span className="form-error">{server['openai.body']}</span>}
      </label>
      <label className="field">
        <span>
          Conversations it suits <em>(one per line, up to {O.hints}; e.g. “pool pump stopped working”)</em>
        </span>
        <textarea rows={3} value={(o.contextHints || []).join('\n')} disabled={busy} onChange={(e) => setO({ contextHints: e.target.value.split('\n') })} />
      </label>
      <label className="field">
        <span>Daily budget ($)</span>
        <input type="number" min="5" step="1" value={spec.dailyBudgetCents / 100} disabled={busy} onChange={(e) => set({ dailyBudgetCents: toCents(e.target.value) })} />
        {budget && <span className="fine">Up to {money(budget.dailyCeilingCents)}/day under your approved budget.</span>}
      </label>
      <fieldset className="field" data-openai-locations>
        <legend>Where</legend>
        <p className="notice-info" data-openai-geo>
          {OPENAI_GEO}
        </p>
        {locations.length > 0 ? (
          <ul className="rows">
            {locations.map((l) => (
              <li key={l.id} className="row">
                <span>
                  {l.name} <em className="fine">({l.type === 'market' ? 'metro area' : 'state'})</em>
                </span>
                <button type="button" className="link-btn" disabled={busy} onClick={() => remove(l.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fine">No area chosen yet.</p>
        )}
        {connected ? (
          <form className="inline-form" onSubmit={search} role="search" aria-label="Find a ChatGPT Ads area">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="City or state, e.g. Charleston" aria-label="City or state" />
            <button type="submit" className="btn btn-quiet" disabled={busy || found?.busy || q.trim().length < 2}>
              {found?.busy ? 'Searching…' : 'Find area'}
            </button>
          </form>
        ) : (
          <p className="fine">Connect your ChatGPT Ads account (step 2) to choose an area.</p>
        )}
        {found?.error && <p className="form-error" role="alert">{found.error}</p>}
        {found?.results && (
          <ul className="rows" aria-label="Areas found">
            {found.results.length === 0 && <li className="fine">Nothing found. Try the nearest big city or the state.</li>}
            {found.results
              .filter((r) => r.type !== 'country')
              .map((r) => (
                <li key={r.id} className="row">
                  <span>
                    {r.name} <em className="fine">({r.type === 'market' ? 'metro area' : 'state'})</em>
                  </span>
                  <button type="button" className="btn btn-quiet" disabled={busy || locations.some((x) => x.id === r.id)} onClick={() => add(r)}>
                    Add
                  </button>
                </li>
              ))}
          </ul>
        )}
        {server['openai.locations'] && <span className="form-error">{server['openai.locations']}</span>}
      </fieldset>
    </div>
  )
}

// ChatGPT Ads connection: the owner's own Ads API key (one per ad account, Ads Manager → Settings). Validated by
// GetShowUps with a read-only call before it is stored; only its last 4 characters are ever shown again.
function OpenAiRow({ c, running = 0, onChange }) {
  const [key, setKey] = useState('')
  const [state, setState] = useState({})
  const [confirm, setConfirm] = useState(false)
  const s = CONN[connState(c)]
  const save = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const { status, data } = await api('/api/ads/openai/key', { method: 'POST', body: { action: 'save', apiKey: key } })
    setKey('')
    if (status === 200) {
      setState({ note: data.accountChanged ? 'Connected to a different ad account than before. Campaigns created in the old one stay there.' : 'Connected.' })
      onChange()
    } else setState({ error: errorText(data.error) })
  }
  const disconnect = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/ads/openai/key', { method: 'POST', body: { action: 'disconnect', confirm: true } })
    setConfirm(false)
    if (status === 200) {
      setState({ note: 'Disconnected. GetShowUps no longer holds the key. Revoke it in ChatGPT Ads Manager → Settings to switch it off completely.' })
      onChange()
    } else setState({ error: errorText(data.error) })
  }
  return (
    <li className="row conn-row" data-platform-row="openai">
      <div className="conn-main">
        <strong>ChatGPT ads</strong>
        <p className={`conn-status conn-status--${s.tone}`} data-openai-status={connState(c)}>
          <span className="conn-icon" aria-hidden="true">
            {s.icon}
          </span>
          {s.text}
          {c?.status === 'connected' && ` · ${c.accountName || c.accountId}${c.last4 ? ` · key …${c.last4}` : ''}`}
        </p>
        {(!c || c.status === 'reconnect_required') && (
          <form className="inline-form" onSubmit={save} aria-label="Connect ChatGPT Ads">
            <input type="password" autoComplete="off" spellCheck="false" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your ChatGPT Ads API key" aria-label="ChatGPT Ads API key" />
            <button type="submit" className="btn btn-primary" disabled={state.busy || key.trim().length < 20}>
              {state.busy ? 'Checking…' : 'Connect'}
            </button>
          </form>
        )}
        {(!c || c.status === 'reconnect_required') && (
          <p className="fine">
            In{' '}
            <a href="https://ads.openai.com/settings" target="_blank" rel="noreferrer">
              ChatGPT Ads Manager → Settings
            </a>
            , create an API key for this ad account and paste it here. GetShowUps checks it, stores it encrypted, and uses it only for the ChatGPT campaigns you approve here.
          </p>
        )}
        {c && !confirm && (
          <p className="conn-links">
            <button type="button" className="link-btn conn-secondary" onClick={() => setConfirm(true)}>
              Disconnect
            </button>
          </p>
        )}
        {confirm && (
          <div className="confirm" role="group" aria-label="Confirm disconnect">
            <p>{running ? 'Pause your running ChatGPT campaign first.' : 'Remove the key from GetShowUps? Your campaigns stay in ChatGPT Ads, paused.'}</p>
            <div className="card-actions">
              <button type="button" className="btn btn-danger" disabled={state.busy || running > 0} onClick={disconnect}>
                Confirm: disconnect
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        {state.note && <p className="fine" role="status">{state.note}</p>}
      </div>
    </li>
  )
}

// Days from today to an end date (inclusive), for "the most it can spend"; null without a valid date.
const daysUntil = (ymd) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return null
  const end = Date.parse(`${ymd}T23:59:59Z`)
  if (Number.isNaN(end)) return null
  return Math.max(0, Math.ceil((end - Date.now()) / 86400000))
}

// The Meta lead-ads editor: everything Meta will be asked to create, in the order the owner thinks about it, then the
// review summary the approval covers. Images: approved creatives (AI-generated, or the owner's own website photos
// turned into creatives with one click) — an ad can only use approved ones (the server refuses otherwise).
function MetaEditor({ spec, m, set, setM, budget, server, busy, photos = [], creatives = [], onCreativesChange }) {
  const [pick, setPick] = useState('')
  const [note, setNote] = useState(null)
  const placements = m.placements?.length ? m.placements : ['facebook', 'instagram']
  const togglePlacement = (p) => {
    const next = placements.includes(p) ? placements.filter((x) => x !== p) : [...placements, p]
    if (!next.length) return
    setM(next.length === 2 ? { placements: undefined } : { placements: next })
  }
  const questions = m.formQuestions || ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP']
  const toggleQuestion = (q) => {
    const next = questions.includes(q) ? questions.filter((x) => x !== q) : [...questions, q]
    if (!next.length) return
    setM({ formQuestions: ['FULL_NAME', 'PHONE', 'EMAIL', 'ZIP'].filter((x) => next.includes(x)) })
  }
  const images = creatives.filter((c) => c.kind === 'image' && ['ready', 'approved'].includes(c.status))
  const chosen = m.imageCreativeIds || []
  const toggleImage = (id) => setM({ imageCreativeIds: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] })
  const useWebsitePhoto = async () => {
    if (!pick) return
    setNote({ busy: true })
    const { status, data } = await api('/api/dashboard/ads/creative', { method: 'POST', body: { action: 'from_asset', assetId: pick } })
    if (status === 201 || status === 200) {
      setNote({ text: 'Added. Approve it below, then tick it for this ad.' })
      onCreativesChange?.()
    } else setNote({ error: errorText(data?.error) })
  }
  const decide = async (id, action) => {
    await api('/api/dashboard/ads/creative', { method: 'POST', body: { action, id } })
    onCreativesChange?.()
  }
  const days = daysUntil(m.endDate)
  const total = days != null ? spec.dailyBudgetCents * Math.max(1, days) : null
  const L = { primaryText: 500, headline: 40, description: 60, textsMax: 5 }
  return (
    <div className="campaign-groups" data-meta-editor>
      <section className="meta-step">
        <h4>Goal</h4>
        <p className="fine">Leads: people who tap the ad fill in a short form on Facebook or Instagram (no website visit needed). Each form becomes a lead in your Appointments tab.</p>
      </section>
      <section className="meta-step">
        <h4>Where and who</h4>
        <p className="fine" data-meta-where>
          People in {plural((spec.geo?.zips || []).length, 'ZIP code')} from your business details{(spec.geo?.zips || []).length ? ` (${spec.geo.zips.slice(0, 6).join(', ')}${spec.geo.zips.length > 6 ? ', …' : ''})` : ''}. Change your area in step 1, then draft again.
        </p>
        <fieldset className="choices" disabled={busy}>
          <legend>Show on</legend>
          {['facebook', 'instagram'].map((p) => (
            <label key={p} className="check">
              <input type="checkbox" checked={placements.includes(p)} onChange={() => togglePlacement(p)} data-meta-placement={p} />
              <span>{META_PLACEMENT_LABEL[p]}</span>
            </label>
          ))}
          <span className="fine">Both = Meta chooses the placements automatically.</span>
        </fieldset>
        <div className="field-row">
          <label className="field">
            <span>Youngest</span>
            <input type="number" min="18" max="65" value={m.audience?.ageMin ?? 18} onChange={(e) => setM({ audience: { ...(m.audience || {}), ageMin: Number(e.target.value) } })} data-meta-age-min />
          </label>
          <label className="field">
            <span>Oldest <em>(blank = no limit)</em></span>
            <input type="number" min="18" max="65" value={m.audience?.ageMax ?? ''} onChange={(e) => setM({ audience: { ...(m.audience || {}), ageMax: e.target.value === '' ? undefined : Number(e.target.value) } })} data-meta-age-max />
          </label>
        </div>
        {(server['meta.audience.ageMin'] || server['meta.audience.ageMax'] || server['meta.placements']) && <p className="field-error">{server['meta.audience.ageMin'] || server['meta.audience.ageMax'] || server['meta.placements']}</p>}
      </section>
      <section className="meta-step">
        <h4>The ad</h4>
        <TextList legend="Main text" noun="Main text" items={m.primaryTexts || ['']} max={L.primaryText} min={1} maxItems={L.textsMax} field="meta.primaryTexts" server={server} disabled={busy} multiline onChange={(primaryTexts) => setM({ primaryTexts })} />
        <TextList legend="Headlines" noun="Headline" items={m.headlines || ['']} max={L.headline} min={1} maxItems={L.textsMax} field="meta.headlines" server={server} disabled={busy} onChange={(headlines) => setM({ headlines })} />
        <label className="field">
          <span>Description <em>(optional, up to {L.description} characters)</em></span>
          <input value={m.description || ''} maxLength={L.description} onChange={(e) => setM({ description: e.target.value || undefined })} />
          {server['meta.description[0]'] && <span className="field-error">{server['meta.description[0]']}</span>}
        </label>
        <label className="field">
          <span>Button</span>
          <select value={m.callToAction || 'GET_QUOTE'} onChange={(e) => setM({ callToAction: e.target.value })} data-meta-cta>
            {Object.entries(META_CTA_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="choices" disabled={busy}>
          <legend>Form asks for</legend>
          {Object.entries(META_FORM_LABEL).map(([k, v]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={questions.includes(k)} onChange={() => toggleQuestion(k)} data-meta-question={k} />
              <span>{v}</span>
            </label>
          ))}
        </fieldset>
      </section>
      <section className="meta-step" data-meta-images>
        <h4>Image</h4>
        {images.length === 0 && photos.length === 0 && <p className="fine">No images yet. Upload a photo in the Website tab (your own photos only), then use it here.</p>}
        {images.length > 0 && (
          <ul className="creative-pick">
            {images.map((c) => (
              <li key={c.id} className={chosen.includes(c.id) ? 'creative-pick--on' : ''}>
                <img src={`/api/dashboard/ads/creative?id=${c.id}`} alt={c.prompt} loading="lazy" />
                {c.status === 'approved' ? (
                  <label className="check">
                    <input type="checkbox" checked={chosen.includes(c.id)} onChange={() => toggleImage(c.id)} data-meta-image={c.id} />
                    <span>Use in this ad</span>
                  </label>
                ) : (
                  <div className="card-actions">
                    <button type="button" className="btn btn-sm btn-quiet" onClick={() => decide(c.id, 'approve')} data-approve-creative={c.id}>
                      Approve
                    </button>
                    <button type="button" className="link-btn" onClick={() => decide(c.id, 'reject')}>
                      Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {photos.length > 0 && (
          <div className="field-row">
            <label className="field">
              <span>Use a photo from your website</span>
              <select value={pick} onChange={(e) => setPick(e.target.value)} data-meta-photo-pick>
                <option value="">Choose a photo…</option>
                {photos.map((p, i) => (
                  <option key={p.id} value={p.id}>
                    Website photo {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-quiet" disabled={!pick || note?.busy} onClick={useWebsitePhoto} data-meta-photo-add>
              {note?.busy ? 'Adding…' : 'Add as ad image'}
            </button>
          </div>
        )}
        {note?.text && <p className="fine" role="status">{note.text}</p>}
        {note?.error && <p className="form-error" role="alert">{note.error}</p>}
        {server['meta'] && <p className="field-error">{server['meta']}</p>}
      </section>
      <section className="meta-step">
        <h4>Budget</h4>
        <div className="field-row">
          <label className="field">
            <span>Daily budget ($)</span>
            <input type="number" min="5" step="1" value={spec.dailyBudgetCents / 100} onChange={(e) => set({ dailyBudgetCents: toCents(e.target.value) })} />
            {budget && <span className="fine">Up to {money(budget.dailyCeilingCents)}/day under your approved budget.</span>}
          </label>
          <label className="field">
            <span>Stop on <em>(optional)</em></span>
            <input type="date" value={m.endDate || ''} onChange={(e) => setM({ endDate: e.target.value || undefined })} data-meta-end-date />
            {server['meta.endDate'] && <span className="field-error">{server['meta.endDate']}</span>}
          </label>
        </div>
        <p className="fine" data-meta-total>
          {total != null ? `Most it can spend before it stops: about ${money(total)} (${plural(Math.max(1, days), 'day')} × ${money(spec.dailyBudgetCents)}).` : 'No end date: it runs within your approved monthly budget until you pause it.'}
        </p>
      </section>
      <section className="meta-step" data-meta-review>
        <h4>Review</h4>
        <dl className="kv">
          {[
            ['Platform', `Facebook & Instagram (${placements.map((p) => META_PLACEMENT_LABEL[p]).join(' + ')})`],
            ['Goal', 'Leads through an instant form'],
            ['Where', plural((spec.geo?.zips || []).length, 'ZIP code')],
            ['Ages', `${m.audience?.ageMin ?? 18}${m.audience?.ageMax ? `–${m.audience.ageMax}` : '+'}`],
            ['Daily budget', money(spec.dailyBudgetCents)],
            ['Stops', m.endDate ? `${m.endDate} (about ${money(total)} in total)` : 'when you pause it'],
            ['Images', plural(chosen.filter((id) => images.some((c) => c.id === id && c.status === 'approved')).length, 'approved image')],
            ['Form', questions.map((q) => META_FORM_LABEL[q]).join(', ')],
            ['Button', META_CTA_LABEL[m.callToAction] || '—'],
            ['When you approve', 'It is created on Meta paused. Nothing shows or spends until you press Start, within your approved budget.'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

const STATUS_LABEL = { draft: 'Draft', approved: 'Approved', error: 'Needs changes', launching: 'Creating…', paused: 'Paused', active: 'Running', removed: 'Removed' }
const G = { headline: 30, headlinesMin: 3, headlinesMax: 15, description: 90, descriptionsMin: 2, descriptionsMax: 4 } // mirrors server/ads/spec.js (the server decides)

// Server validation messages ("google.headlines[1]: longer than 30 characters") → per-field inline text.
function byField(problems) {
  const out = {}
  for (const p of problems || []) {
    const m = String(p).match(/^([\w.]+(?:\[\d+\])?): (.+)$/)
    if (m) out[m[1]] = out[m[1]] ? `${out[m[1]]}; ${m[2]}` : m[2]
  }
  return out
}

// Browser-side hints only (instant feedback); the server re-validates on save, approve and launch.
function textProblems(list, max) {
  const seen = new Map()
  return list.map((t) => {
    const v = t.replace(/\s+/g, ' ').trim()
    if (!v) return null // a just-added empty row isn't an error yet; the server reports empties on save
    if (v.length > max) return `${v.length - max} too long`
    const k = v.toLowerCase()
    if (seen.has(k)) return 'Same as another'
    seen.set(k, true)
    return null
  })
}

function TextList({ legend, noun, items, max, min, maxItems, field, server, disabled, multiline = false, onChange }) {
  const Input = multiline ? 'textarea' : 'input'
  const local = textProblems(items, max)
  const countError = server[field] || (items.length < min ? `Add at least ${min}` : null)
  return (
    <fieldset className="text-list" disabled={disabled}>
      <legend>
        {legend} <span className="fine">({items.length} of up to {maxItems}, at least {min})</span>
      </legend>
      {items.map((t, i) => {
        const problem = local[i] || server[`${field}[${i}]`]
        const id = `${field}-${i}`
        return (
          <div key={i} className="text-row">
            <div className="text-input">
              <Input
                id={id}
                rows={multiline ? 3 : undefined}
                value={t}
                aria-label={`${noun} ${i + 1}`}
                aria-invalid={problem ? true : undefined}
                aria-describedby={`${id}-count`}
                onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <span id={`${id}-count`} className={`counter${t.trim().length > max ? ' counter--over' : ''}`}>
                {t.trim().length}/{max}
              </span>
              {items.length > min && (
                <button type="button" className="link-btn" aria-label={`Remove ${noun.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
            {problem && <p className="field-error">{problem}</p>}
          </div>
        )
      })}
      {countError && <p className="field-error">{countError}</p>}
      {items.length < maxItems && (
        <button type="button" className="link-btn" onClick={() => onChange([...items, ''])}>
          + Add {noun.toLowerCase()}
        </button>
      )}
    </fieldset>
  )
}

function BudgetSummary({ dailyCents, budget }) {
  return (
    <dl className="budget-summary" aria-label="Budget">
      <div>
        <dt>Average per day</dt>
        <dd>{money(dailyCents)}</dd>
      </div>
      <div>
        <dt>Most per month</dt>
        <dd>about {money(Math.round(((dailyCents || 0) * 30.4) / 100) * 100)}</dd>
      </div>
      <div>
        <dt>Approved limit</dt>
        <dd>{budget ? `${money(budget.monthlyCents)}/month` : 'Not yet (step 4)'}</dd>
      </div>
    </dl>
  )
}

// Google's charging rule, in plain words: the daily budget is an average, not a hard daily cap.
const CHARGING = 'Google may spend up to twice the average on a busy day, but never charges more than about 30 days of the average in a month.'

function Verification({ v, platform = 'Google' }) {
  if (!v) return null
  if (v.error) return <p className="fine" data-verification="unknown">Couldn’t check this campaign on {platform} yet. We’ll try again automatically.</p>
  return v.ok ? (
    <p className="conn-status conn-status--ok" data-verification="ok">
      <span className="conn-icon" aria-hidden="true">
        ✓
      </span>
      Checked on {platform}: {platform === 'Meta' ? 'status, budget, area, placements, ages and ad match' : 'budget, area, keywords and ad match'}
    </p>
  ) : (
    <p className="conn-status conn-status--warn" data-verification="differs">
      <span className="conn-icon" aria-hidden="true">
        !
      </span>
      {platform} shows a difference: {v.failed.join(', ')}
    </p>
  )
}

function CampaignEditor({ c, capabilities, budget, onChange, hold = null, photos = [], creatives = [] }) {
  const platformName = PLATFORM_NAME[c.platform] || c.platform
  const [saved, setSaved] = useState(c.spec)
  const [spec, setSpec] = useState(c.spec)
  const [state, setState] = useState({})
  const [confirm, setConfirm] = useState(null) // 'launch' | 'remove'
  const editable = !c.launched && ['draft', 'approved', 'error'].includes(c.status)
  const dirty = JSON.stringify(spec) !== JSON.stringify(saved)
  // Google campaigns on a verified Google Ads test account, and Meta campaigns on a sandbox ad account the operator
  // listed, can be created and started without the live switch (neither ever serves or spends); the server
  // re-checks the account before every change.
  const sandbox = c.platform === 'google' ? Boolean(capabilities.sandbox) : c.platform === 'meta' ? Boolean(capabilities.metaSandbox) : false
  const sandboxLabel = c.platform === 'meta' ? 'sandbox account' : 'test account'
  const canServe = capabilities.liveLaunch || sandbox
  // ChatGPT Ads has no test account: a business on the verification list may CREATE paused, never start (the server decides).
  const verifyOnly = c.platform === 'openai' && !capabilities.liveLaunch && Boolean(capabilities.openaiVerify)
  const canCreate = canServe || verifyOnly
  const g = spec.google || {}
  const m = spec.meta || {}
  const set = (patch) => setSpec((s) => ({ ...s, ...patch }))
  const setG = (patch) => set({ google: { ...g, ...patch } })
  const setM = (patch) => set({ meta: { ...m, ...patch } })
  const server = byField(state.problems)
  const busy = Boolean(state.busy)
  const inflight = useRef(false) // set synchronously: a double click never sends twice (the server is atomic too)

  const [daily, setDaily] = useState(c.dailyBudgetCents / 100)
  const [live, setLive] = useState(null)
  const checkGoogle = async () => {
    setLive({ busy: true })
    const { status, data } = await api('/api/ads/google/campaigns')
    if (status !== 200) return setLive({ error: errorText(data.error) })
    const found = data.campaigns.find((x) => x.gsuId === c.id)
    setLive(found ? { ...found, testAccount: data.testAccount } : { missing: true })
  }
  const NOTES = {
    validate: 'Check passed. Nothing was created and nothing was spent.',
    approve: `Approved. Next: create it on ${platformName} (it starts paused).`,
    launch: sandbox ? `Created on ${platformName}, paused. It’s a ${sandboxLabel}, so it never shows and nothing is charged.` : `Created on ${platformName}, paused. Nothing runs until you press Start.`,
    launch_differs: `Created on ${platformName}, paused, but ${platformName} shows a difference. See below.`,
    resume: sandbox ? `Started on the ${sandboxLabel}. It never shows and nothing is charged.` : 'Started.',
    pause: 'Paused.',
    budget: 'Daily budget changed.',
    save: 'Saved.',
    remove: 'Removed.',
    test_lead: 'Meta is creating a test lead on this ad’s form. It arrives through the lead webhook within a minute, marked as a test lead, and never counts in your results.',
  }
  const act = async (action, extra = {}) => {
    if (inflight.current) return
    inflight.current = true
    setState({ busy: action })
    setConfirm(null)
    const { status, data } = await api('/api/dashboard/ads/campaign', { method: 'POST', body: { action, id: c.id, ...extra } })
    inflight.current = false
    if (status === 200) {
      if (action === 'save') setSaved(extra.spec)
      const problems = data.errors?.length ? data.errors : null
      const note = action === 'save' && problems ? 'Saved. Fix the marked fields before approving.' : action === 'launch' && data.verification && !data.verification.ok && !data.verification.error ? NOTES.launch_differs : NOTES[action]
      setState({ note, problems })
      onChange()
    } else setState({ error: errorText(data.error), problems: data.errors })
  }
  // Approve, then create (paused) in one owner action. If creating fails, the ad stays approved and says why.
  const approveAndCreate = async () => {
    if (inflight.current) return
    inflight.current = true
    setState({ busy: 'approve' })
    setConfirm(null)
    const a = await api('/api/dashboard/ads/campaign', { method: 'POST', body: { action: 'approve', id: c.id } })
    if (a.status !== 200) {
      inflight.current = false
      setState({ error: errorText(a.data.error), problems: a.data.errors })
      return
    }
    setState({ busy: 'launch' })
    const l = await api('/api/dashboard/ads/campaign', { method: 'POST', body: { action: 'launch', id: c.id, confirm: true } })
    inflight.current = false
    if (l.status === 200) setState({ note: l.data.verification && !l.data.verification.ok && !l.data.verification.error ? NOTES.launch_differs : NOTES.launch })
    else setState({ error: `Approved, but not created yet: ${errorText(l.data.error)}` })
    onChange()
  }
  const general = (state.problems || []).filter((p) => !/^google\.(headlines|descriptions)(\[\d+\])?:/.test(p))

  return (
    <article className="card campaign" aria-label={`${PLATFORM_TITLE[c.platform] || c.platform} campaign`} data-campaign-platform={c.platform}>
      <header className="campaign-head">
        <h3 className="card-title">{PLATFORM_TITLE[c.platform] || c.platform}</h3>
        <span className={`chip chip--${c.status}`}>{STATUS_LABEL[c.status] || c.status}</span>
      </header>

      {c.platform === 'google' ? <GooglePreview spec={spec} /> : c.platform === 'openai' ? <OpenAiPreview spec={spec} /> : <MetaPreview spec={spec} />}
      {c.platform === 'openai' && !editable && (
        <p className="fine" data-openai-where>
          <strong>Where:</strong> {(spec.openai?.locations || []).map((l) => l.name).join(', ') || 'no area'}. {OPENAI_GEO}
        </p>
      )}
      {c.platform === 'google' && (spec.geo?.zips || []).length > 0 && (
        <p className="fine" data-where>
          <strong>Where:</strong> people in {spec.geo.zips.length === 1 ? `ZIP code ${spec.geo.zips[0]}` : `${spec.geo.zips.length} ZIP codes (${spec.geo.zips.slice(0, 6).join(', ')}${spec.geo.zips.length > 6 ? ', …' : ''})`}, searching on Google.
          {editable && ' Change your area in step 1, then draft again.'}
        </p>
      )}
      <BudgetSummary dailyCents={spec.dailyBudgetCents} budget={budget} />
      <p className="fine">{c.platform === 'meta' ? CHARGING_META : c.platform === 'openai' ? CHARGING_OPENAI : CHARGING}</p>
      {c.launched && <Verification v={c.verification} platform={platformName} />}
      {c.lastError && (
        <p className="form-error" role="alert">
          {errorText(c.lastError)}
        </p>
      )}

      {editable && c.platform === 'google' && (
        <div className="campaign-groups">
          <TextList legend="Headlines" noun="Headline" items={g.headlines || []} max={G.headline} min={G.headlinesMin} maxItems={G.headlinesMax} field="google.headlines" server={server} disabled={busy} onChange={(headlines) => setG({ headlines })} />
          <TextList legend="Descriptions" noun="Description" items={g.descriptions || []} max={G.description} min={G.descriptionsMin} maxItems={G.descriptionsMax} field="google.descriptions" server={server} disabled={busy} multiline onChange={(descriptions) => setG({ descriptions })} />
          <label className="field">
            <span>Daily budget ($)</span>
            <input type="number" min="5" step="1" value={spec.dailyBudgetCents / 100} onChange={(e) => set({ dailyBudgetCents: toCents(e.target.value) })} />
            {budget && <span className="fine">Up to {money(budget.dailyCeilingCents)}/day under your approved budget.</span>}
          </label>
          <details className="campaign-edit">
            <summary>Search terms and areas</summary>
            <label className="field">
              <span>
                Search terms <em>(one per line; [brackets] = exact match)</em>
              </span>
              <textarea
                rows={5}
                value={(g.keywords || []).map((k) => (k.match === 'EXACT' ? `[${k.text}]` : k.text)).join('\n')}
                onChange={(e) => setG({ keywords: lines(e.target.value).map((t) => (/^\[.*\]$/.test(t) ? { text: t.slice(1, -1), match: 'EXACT' } : { text: t, match: 'PHRASE' })) })}
              />
            </label>
            <label className="field">
              <span>Never show for</span>
              <textarea rows={3} value={(g.negativeKeywords || []).join('\n')} onChange={(e) => setG({ negativeKeywords: lines(e.target.value) })} />
            </label>
            <p className="fine">Shown in {plural(spec.geo?.zips?.length || 0, 'ZIP code')} from your business details.</p>
          </details>
        </div>
      )}
      {editable && c.platform === 'openai' && <OpenAiEditor spec={spec} set={set} budget={budget} server={server} busy={busy} connected={capabilities.openaiConnected} />}
      {editable && c.platform === 'meta' && <MetaEditor spec={spec} m={m} set={set} setM={setM} budget={budget} server={server} busy={busy} photos={photos} creatives={creatives} onCreativesChange={onChange} />}

      {editable && dirty && (
        <div className="save-bar" role="group" aria-label="Unsaved changes">
          <span className="fine">Unsaved changes</span>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('save', { spec })}>
            {state.busy === 'save' ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => setSpec(saved)}>
            Discard
          </button>
        </div>
      )}

      {general.length > 0 && (
        <ul className="problems" role="alert">
          {general.slice(0, 8).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.note && <p className="fine" role="status">{state.note}</p>}

      {c.launched && ['paused', 'active'].includes(c.status) && (
        <form
          className="campaign-budget"
          aria-label="Daily budget"
          onSubmit={(e) => {
            e.preventDefault()
            act('budget', { dailyCents: toCents(daily) })
          }}
        >
          <label className="field">
            <span>Daily budget ($) <em>(now {money(c.dailyBudgetCents)}/day)</em></span>
            <input type="number" min="1" step="1" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-quiet" disabled={busy || !canServe || toCents(daily) === c.dailyBudgetCents}>
            Change daily budget{sandbox ? ` (${sandboxLabel})` : ''}
          </button>
        </form>
      )}
      {c.launched && c.platform === 'google' && (
        <div className="campaign-live">
          <button type="button" className="link-btn" disabled={live?.busy} onClick={checkGoogle}>
            Check on Google
          </button>
          {live?.error && <p className="form-error" role="alert">{live.error}</p>}
          {live?.missing && <p className="fine" role="status">Google didn’t return this campaign.</p>}
          {live?.status && (
            <p className="fine" role="status" data-google-live>
              Google reports: {live.status === 'ENABLED' ? 'running' : live.status === 'PAUSED' ? 'paused' : 'other'} · {money(live.dailyBudgetCents)}/day
              {live.testAccount ? ' · test account' : ''}
            </p>
          )}
        </div>
      )}

      {confirm === 'launch' || confirm === 'approve_create' ? (
        <div className="confirm" role="group" aria-label="Confirm create">
          <p>
            {confirm === 'approve_create' ? `Approve this ad and create it on ${platformName}? ` : `Create this campaign on ${platformName}? `}
            It starts <strong>paused</strong>; nothing runs until you press Start.
            {sandbox && (c.platform === 'meta' ? ' Sandbox ad account: it never shows and nothing is charged.' : ' Test account: it never shows and nothing is charged.')}
            {c.platform === 'openai' && ' ChatGPT Ads has no test account: this creates a real campaign in your account, paused, and OpenAI reviews the ad.'}
          </p>
          <div className="card-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => (confirm === 'approve_create' ? approveAndCreate() : act('launch', { confirm: true }))}>
              {confirm === 'approve_create' ? 'Confirm: approve and create (paused)' : `Confirm: create on ${platformName} (paused)`}
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirm === 'test_lead' ? (
        <div className="confirm" role="group" aria-label="Confirm test lead">
          <p>Ask Meta to create a test lead on this ad’s form? It arrives through the lead webhook as a test lead (never counted in your results). Meta keeps one test lead per form; an earlier one is replaced. Nothing runs and nothing is charged.</p>
          <div className="card-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('test_lead', { confirm: true })} data-meta-test-lead-confirm>
              Confirm: send a test lead
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirm === 'remove' ? (
        <div className="confirm" role="group" aria-label="Confirm remove">
          <p>Remove this draft? It disappears from this list. Nothing on {platformName} changes.</p>
          <div className="card-actions">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('remove')}>
              Confirm: remove draft
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card-actions">
            {!c.launched && (
              <button type="button" className="btn btn-quiet" disabled={busy || dirty} onClick={() => act('validate')}>
                {state.busy === 'validate' ? 'Checking…' : 'Check (no spend)'}
              </button>
            )}
            {['draft', 'error'].includes(c.status) && !c.launched && (
              // One step when creating is possible (connected account); otherwise approve now, create later.
              <button type="button" className="btn btn-primary" disabled={busy || dirty || !budget} onClick={() => (canCreate ? setConfirm('approve_create') : act('approve'))}>
                {state.busy === 'approve' ? 'Approving…' : canCreate ? `Approve and create (paused)${sandbox ? ` · ${sandboxLabel}` : ''}` : 'Approve'}
              </button>
            )}
            {c.status === 'approved' && !c.launched && (
              <button type="button" className="btn btn-primary" disabled={busy || dirty || !canCreate} onClick={() => setConfirm('launch')}>
                Create on {platformName} (paused){sandbox ? ` · ${sandboxLabel}` : ''}
              </button>
            )}
            {c.launched && c.status === 'paused' && (
              <button type="button" className="btn btn-primary" disabled={busy || !canServe} onClick={() => act('resume')}>
                {sandbox ? `Start ads (${sandboxLabel}, no spend)` : 'Start ads'}
              </button>
            )}
            {c.launched && c.platform === 'meta' && ['paused', 'active'].includes(c.status) && (
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setConfirm('test_lead')} data-meta-test-lead>
                Send a test lead
              </button>
            )}
            {c.status === 'active' && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('pause')}>
                Pause
              </button>
            )}
            {c.status === 'active' && hold?.unreachable && (
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => act('confirm_paused_externally', { confirm: true })}>
                I paused it in Google Ads
              </button>
            )}
            {editable && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => setConfirm('remove')}>
                Remove draft
              </button>
            )}
          </div>
          <ul className="action-help fine">
            {dirty && editable && <li>Save your changes first.</li>}
            {!c.launched && <li>{c.platform === 'meta' || c.platform === 'openai' ? `Check: builds exactly what ${platformName} would receive, without sending it. Nothing is created or charged.` : 'Check: Google reviews the ad. Nothing is created or charged.'}</li>}
            {verifyOnly && <li data-openai-verify>Verification: GetShowUps may create this campaign paused in your real ChatGPT Ads account to check it end to end. Starting it is not switched on.</li>}
            {['draft', 'error'].includes(c.status) && !c.launched && (
              <li>
                {!budget
                  ? 'Approve your monthly ad budget (step 4) to approve this campaign.'
                  : canCreate
                    ? `Approve and create: puts this exact ad on ${platformName}, paused. Nothing runs until you press Start.`
                    : `Approve: locks in this version. Connect your ad account to create it on ${platformName}.`}
              </li>
            )}
            {c.status === 'approved' && !c.launched && (
              <li>{canCreate ? `Create: puts it on ${platformName}, paused. Nothing runs until you press Start.` : ERRORS.live_launch_disabled}</li>
            )}
            {c.launched && c.status === 'paused' && <li>{sandbox ? `Start: runs on the ${sandboxLabel}. It never shows and nothing is charged.` : 'Start: the ad can show and spend, within your approved budget.'}</li>}
            {c.launched && c.platform === 'meta' && <li>Send a test lead: Meta puts a test entry on this ad’s form and sends it to GetShowUps like a real lead, so you can see it arrive, marked as a test. Nothing runs and nothing is charged.</li>}
          </ul>
        </>
      )}
    </article>
  )
}

function Creatives({ creatives, quota, capabilities, concepts, onChange }) {
  const [prompt, setPrompt] = useState(concepts?.[0] || '')
  const [state, setState] = useState({})
  if (!capabilities.images && !creatives.length) return null
  const gen = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/ads/creative', { method: 'POST', body: { action: 'image', prompt } })
    setState(status === 201 ? {} : { error: errorText(data.error) })
    onChange()
  }
  const decide = async (id, action) => {
    await api('/api/dashboard/ads/creative', { method: 'POST', body: { action, id } })
    onChange()
  }
  return (
    <section className="card">
      <h2 className="card-title">Images</h2>
      <p className="fine">
        AI-generated; never shows real customers or results. {quota.used.images}/{quota.imagesPerMonth} images used this month.
      </p>
      {capabilities.images && (
        <div className="stack">
          <label className="field">
            <span>Describe the image</span>
            <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={1500} />
          </label>
          <button type="button" className="btn btn-quiet" disabled={state.busy || prompt.trim().length < 10} onClick={gen}>
            {state.busy ? 'Creating…' : 'Create image'}
          </button>
          {state.error && <p className="form-error" role="alert">{state.error}</p>}
        </div>
      )}
      <ul className="creatives">
        {creatives
          .filter((c) => c.kind === 'image')
          .map((c) => (
            <li key={c.id}>
              {['ready', 'approved'].includes(c.status) && <img src={`/api/dashboard/ads/creative?id=${c.id}`} alt={c.prompt} loading="lazy" />}
              <p className="fine">{c.status === 'approved' ? 'Approved' : c.status === 'ready' ? 'Needs your review' : c.status}</p>
              {c.status === 'ready' && (
                <div className="card-actions">
                  <button type="button" className="btn btn-quiet" onClick={() => decide(c.id, 'approve')}>
                    Approve
                  </button>
                  <button type="button" className="link-btn" onClick={() => decide(c.id, 'reject')}>
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
      </ul>
    </section>
  )
}

// "Start with a template": curated Search templates for the trades we serve (the ones that fit the business first)
// and the business's own saved templates. Picking one creates ONE editable draft (nothing created on Google, nothing
// spent); the normal draft → approve → create-paused → Start steps follow. Templates carry no performance claim.
const TEMPLATE_ERRORS = {
  draft_exists: 'You already have a draft. Edit it below, or remove it to start from a template.',
  profile_required: 'Save your business details first.',
  not_found: 'That template isn’t available any more.',
  too_many_campaigns: 'You have the maximum number of campaigns. Remove one first.',
  not_ready: 'Templates aren’t available yet.',
}
function TemplatePicker({ onStarted, onClose }) {
  const [t, setT] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const [daily, setDaily] = useState({})
  const load = useCallback(() => api('/api/dashboard/ads/templates').then(({ status, data }) => setT(status === 200 ? data : { failed: true })), [])
  useEffect(() => {
    load()
  }, [load])
  const start = async (key, body) => {
    setBusy(key)
    setErr(null)
    const dollars = daily[key]
    const { status, data } = await api('/api/dashboard/ads/templates', { method: 'POST', body: { action: 'start', ...body, ...(dollars ? { dailyCents: Math.round(Number(dollars) * 100) } : {}) } })
    setBusy('')
    if (status === 200) onStarted(data)
    else setErr(TEMPLATE_ERRORS[data?.error] || errorText(data?.error))
  }
  const remove = async (id) => {
    setBusy(`rm:${id}`)
    await api('/api/dashboard/ads/templates', { method: 'POST', body: { action: 'remove', id } })
    setBusy('')
    load()
  }
  if (!t) return <div className="ui-skeleton-block" aria-busy="true" />
  if (t.failed)
    return (
      <p className="form-error" role="alert">
        Couldn’t load templates. Try again in a moment.
      </p>
    )
  const row = (key, { name, note, keywords, headlines, startingDailyCents, suggested, source, removable, body }) => (
    <li key={key} className="row tpl-row" data-template={key}>
      <span className="tpl-main">
        <strong>{name}</strong>
        {suggested && <span className="chip">Suggested</span>}
        {source && <span className="chip">{source === 'imported' ? 'From your Google Ads' : 'Saved by you'}</span>}
        <span className="fine tpl-meta">
          {note}
          {keywords?.length ? ` Searches like “${keywords.slice(0, 3).join('”, “')}”.` : ''}
          {headlines?.length ? ` Ad: ${headlines.slice(0, 2).join(' | ')}.` : ''}
        </span>
      </span>
      <span className="tpl-actions">
        <label className="field tpl-budget">
          <span>Daily budget ($)</span>
          <input type="number" min="5" step="1" inputMode="numeric" value={daily[key] ?? (startingDailyCents ? startingDailyCents / 100 : '')} onChange={(e) => setDaily((d) => ({ ...d, [key]: e.target.value }))} />
        </label>
        <button type="button" className="btn btn-quiet" disabled={Boolean(busy)} onClick={() => start(key, body)} data-template-use={key}>
          {busy === key ? 'Creating draft…' : 'Use this template'}
        </button>
        {removable && (
          <button type="button" className="link-btn" disabled={Boolean(busy)} onClick={() => remove(key)}>
            Remove
          </button>
        )}
      </span>
    </li>
  )
  return (
    <div className="stack" role="group" aria-label="Start with a template" data-template-picker>
      <p className="fine">A template becomes an editable draft: your business name, towns and ZIP codes are filled in, nothing is created on Google, and nothing spends. Starting budgets are a cautious first-week floor, not a promise of results.</p>
      {t.saved.length > 0 && (
        <>
          <p className="ta-label">Your templates</p>
          <ul className="rows tpl-list">{t.saved.map((s) => row(s.id, { name: s.name, note: '', keywords: s.keywords, headlines: s.headlines, startingDailyCents: s.dailyBudgetCents, source: s.source, removable: true, body: { savedId: s.id } }))}</ul>
          <p className="ta-label">GetShowUps templates</p>
        </>
      )}
      <ul className="rows tpl-list">{t.curated.map((c) => row(c.id, { name: c.name, note: `${c.industry}.`, keywords: c.keywords, headlines: c.headlines, startingDailyCents: c.startingDailyCents, suggested: c.suggested, body: { templateId: c.id } }))}</ul>
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <button type="button" className="link-btn" onClick={onClose}>
        Close
      </button>
    </div>
  )
}

export default function Ads() {
  const [returned] = useState(readReturn)
  useEffect(() => {
    // Drop ?ads= / ?ads_error= so a reload or bookmark doesn't repeat the message.
    if (returned) window.history.replaceState(null, '', window.location.pathname)
  }, [returned])
  const [d, setD] = useState(null)
  const [error, setError] = useState(false)
  const [plan, setPlan] = useState({})
  const [picking, setPicking] = useState(false)
  const [started, setStarted] = useState(null) // { name } after a template became a draft
  const load = useCallback(
    () =>
      api('/api/dashboard/ads').then(({ status, data }) => {
        if (status === 200) {
          setD(data)
          setError(false)
        } else setError(true)
      }),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  const planning = useRef(false)
  const makePlan = async () => {
    if (planning.current) return // one plan request at a time (the server also allows one open draft)
    planning.current = true
    setPlan({ busy: true })
    const { status, data } = await api('/api/dashboard/ads/plan', { method: 'POST', body: {} })
    planning.current = false
    setPlan(status === 201 ? { result: data } : { error: errorText(data.error) })
    load()
  }
  // A ChatGPT ad starter draft from the business's own details (server/ads/openai.js starterSpec).
  const startOpenAi = async () => {
    if (planning.current) return
    planning.current = true
    setPlan({ busy: true })
    const { status, data } = await api('/api/dashboard/ads/campaign', { method: 'POST', body: { action: 'start_openai' } })
    planning.current = false
    setPlan(status === 200 ? {} : { error: errorText(data.error) })
    load()
  }

  if (error)
    return (
      <p className="form-error" role="alert">
        Couldn’t load ads.{' '}
        <button type="button" className="link-btn" onClick={load}>
          Retry
        </button>
      </p>
    )
  if (!d) return <div aria-busy="true" />
  const anyLaunched = d.campaigns.some((c) => c.launched)
  // Open = never launched and still a draft/approved: one per platform (the server enforces it for new plans).
  const openGoogle = d.campaigns.filter((c) => c.platform === 'google' && !c.launched && ['draft', 'approved', 'error', 'launching'].includes(c.status))
  return (
    <div className="enter">
      <h1 className="title">Ads</h1>
      {returned?.ok && (
        <p className="notice-ok" role="status">
          <span aria-hidden="true">✓</span> {returned.ok}
        </p>
      )}
      {returned?.error && (
        <p className="form-error" role="alert">
          {returned.error}
        </p>
      )}
      {!d.capabilities.liveLaunch && (
        <p className="mode-note" data-testing-mode>
          <span className="badge badge--test">Test mode</span>
          <span>Only Google Ads test accounts and Meta sandbox ad accounts. Test campaigns never show ads, and nothing is ever charged.</span>
        </p>
      )}
      {d.hold && (
        <p className="form-error" role="alert" data-ads-hold={d.hold.reason}>
          Your ads are paused because {d.hold.text}.{' '}
          {d.hold.reason === 'suspended'
            ? 'Contact GetShowUps to restore the account.'
            : d.hold.reason === 'account_deleted'
              ? ''
              : 'Update your payment in Settings → Billing.'}{' '}
          Nothing starts again by itself: once it’s fixed, press Start on each campaign you want running.
        </p>
      )}
      {d.hold?.stillRunning > 0 && (
        <p className="form-error" role="alert" data-ads-still-running>
          {d.hold.unreachable
            ? `${d.hold.stillRunning} campaign${d.hold.stillRunning === 1 ? ' is' : 's are'} still running and GetShowUps can no longer reach ${d.hold.stillRunning === 1 ? 'it' : 'them'}. Pause ${d.hold.stillRunning === 1 ? 'it' : 'them'} in Google Ads now, then confirm below.`
            : `We couldn’t pause ${d.hold.stillRunning} campaign${d.hold.stillRunning === 1 ? '' : 's'} yet; we keep retrying every few minutes. To stop spend right away, pause ${d.hold.stillRunning === 1 ? 'it' : 'them'} in Google Ads.`}
        </p>
      )}
      {anyLaunched && <AdsResults testAccount={d.connections?.google?.testAccount === true} />}

      {anyLaunched && d.profile ? (
        // A campaign exists: the details rarely change, so the facts stand in for the form and the campaign cards come sooner.
        <details className="card profile-fold" data-profile-fold>
          <summary>
            <h2 className="card-title">1. Your business</h2>
            <span className="fine">
              {[d.profile.industry, plural(d.profile.services.length, 'service'), plural(d.profile.serviceArea.zips.length, 'ZIP code'), d.profile.monthlyBudgetCents != null ? `${money(d.profile.monthlyBudgetCents)}/month` : null].filter(Boolean).join(' · ')}
            </span>
            <span className="link-btn">Edit</span>
          </summary>
          <ProfileForm profile={d.profile} onSaved={load} />
        </details>
      ) : (
        <section className="card">
          <h2 className="card-title">1. Your business</h2>
          <ProfileForm profile={d.profile} onSaved={load} />
        </section>
      )}

      {/* Connecting an account needs no business details first (it spends nothing); the status is shown from day one. */}
      <Connections connections={d.connections} capabilities={d.capabilities} running={d.campaigns.filter((c) => c.platform === 'google' && c.launched && c.status === 'active').length} runningOpenAi={d.campaigns.filter((c) => c.platform === 'openai' && c.status === 'active').length} onChange={load} businessProfile={d.businessProfile || null} businessProfileReadiness={d.businessProfileReadiness || null} />

      {/* Already advertising: the campaigns in the connected account, read from Google (read-only). */}
      {d.connections?.google?.status === 'connected' && <AdsImported />}

      {d.profile && (
        <section className="card" aria-labelledby="review-title">
          <h2 className="card-title" id="review-title">
            3. Review your campaign
          </h2>
          {openGoogle.length === 0 ? (
            <>
              <p className="fine">
                Start from a template for your trade, or let GetShowUps {d.capabilities.ai ? 'draft a plan' : 'create a starter draft'} from your details. Either way it is an editable draft; nothing runs until you approve it.
              </p>
              <div className="ui-form-actions">
                <button type="button" className="btn btn-primary" disabled={plan.busy || picking} onClick={() => setPicking(true)} data-start-template>
                  Start with a template
                </button>
                <button type="button" className="btn btn-quiet" disabled={plan.busy || picking} onClick={makePlan}>
                  {plan.busy ? 'Drafting…' : 'Draft my plan'}
                </button>
              </div>
              {picking && (
                <TemplatePicker
                  onClose={() => setPicking(false)}
                  onStarted={(r) => {
                    setPicking(false)
                    setStarted(r.template)
                    load()
                  }}
                />
              )}
            </>
          ) : openGoogle.length > 1 ? (
            <p className="notice-info" role="status" data-duplicate-drafts>
              Tidy up: you have {openGoogle.length} Google Search drafts. Keep the one you want and remove the others.
            </p>
          ) : null}
          {d.capabilities.openai && !d.campaigns.some((c) => c.platform === 'openai' && !c.launched && ['draft', 'approved', 'error'].includes(c.status)) && (
            <div className="ui-form-actions">
              <button type="button" className="btn btn-quiet" disabled={plan.busy} onClick={startOpenAi} data-start-openai>
                Draft a ChatGPT ad
              </button>
            </div>
          )}
          {plan.error && <p className="form-error" role="alert">{plan.error}</p>}
          {started && openGoogle.length > 0 && (
            <p className="notice-info" role="status" data-template-started>
              Draft created from the {started.name} template. Edit the words, area and budget below, then approve it.
            </p>
          )}
          {plan.result && (
            <div className="plan-notes" role="status">
              {plan.result.source === 'template' && <p className="fine">Starter draft (AI planning is not switched on).</p>}
              <p>{plan.result.rationale}</p>
            </div>
          )}
        </section>
      )}

      {d.campaigns.length > 0 && (
        <section aria-label="Campaigns" className="stack">
          {d.campaigns.map((c) => (
            <CampaignEditor key={c.id} c={c} capabilities={d.capabilities} budget={d.budget} onChange={load} hold={d.hold} photos={d.photos || []} creatives={d.creatives || []} />
          ))}
        </section>
      )}

      {d.profile && <BudgetCard budget={d.budget} profile={d.profile} onSaved={load} />}
      {d.campaigns.some((c) => !c.launched) && (
        <p className="fine">5. Launch: approve the campaign above, then create it on Google (it starts paused) and start it when you’re ready.</p>
      )}
      {d.profile && (d.capabilities.images || d.creatives.length > 0) && (
        <details className="card more-options">
          <summary>More options: ad images</summary>
          <Creatives creatives={d.creatives} quota={d.quota} capabilities={d.capabilities} concepts={plan.result?.imageConcepts} onChange={load} />
        </details>
      )}

      {d.results.actions.length > 0 && (
        <section className="card">
          <h2 className="card-title">Recent activity</h2>
          <ul className="rows">
            {d.results.actions.map((a) => (
              <li key={`${a.at}:${a.kind}`} className="row">
                <span>{a.reason}</span>
                <span className="fine">{new Date(a.at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
