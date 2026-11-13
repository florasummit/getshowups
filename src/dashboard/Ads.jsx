// Ads: results first, then a short guided setup (business details → plan → budget → accounts →
// review and launch). Every campaign is an editable draft until the owner approves it; launching
// creates it PAUSED and nothing spends until the owner presses Start.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'

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
  draft_exists: 'You already have a draft. Edit it below, or remove it to start over.',
  account_changed: 'This campaign is in a different Google Ads account than the one connected now. Switch back to manage it, or manage it in Google Ads.',
  removed_on_google: 'This campaign was removed in Google Ads.',
  campaigns_running: 'A campaign is still running. Choose whether to pause it first.',
  account_not_accessible: 'That account isn’t available with this Google sign-in. Choose one from the list.',
  invalid_account: 'Choose an account from the list.',
  invalid_budget: 'Enter a daily budget in dollars.',
  invalid_status: 'Only a created campaign (running or paused) can change its budget.',
  not_launched: 'Create the campaign on Google first.',
}
const errorText = (code) => ERRORS[code] || 'Something went wrong. Please try again.'

// What the owner sees after coming back from Google or Meta sign-in (?ads= / ?ads_error= on the URL).
const RETURNS = {
  google_connected: 'Google Ads is connected.',
  meta_connected: 'Facebook & Instagram is connected.',
  cancelled: 'Sign-in was cancelled. Nothing was connected.',
  expired: 'That sign-in timed out or was started in another tab. Click Connect to try again.',
  scope_denied: 'Google Ads access wasn’t granted. Click Connect again and allow access to Google Ads.',
  no_refresh_token: 'Google didn’t grant lasting access. Click Connect again. If it repeats, remove GetShowUps under your Google Account’s third-party access, then connect.',
  failed: 'Sign-in didn’t finish. Please try again.',
  unauthenticated: 'Sign in to GetShowUps first, then connect.',
}
function readReturn() {
  const q = new URLSearchParams(window.location.search)
  const ok = q.get('ads')
  const err = q.get('ads_error')
  if (!ok && !err) return null
  if (ok) return RETURNS[ok] ? { ok: RETURNS[ok] } : null
  return { error: RETURNS[err] || errorText(err) }
}

function Results({ r }) {
  // Every number says where it comes from; "—" = not available yet.
  const tiles = [
    ['Ad spend', money(r.spendCents), r.spendCents == null ? 'not available yet' : 'from Google'],
    ['Qualified leads', r.qualifiedLeads, 'your bookings'],
    ['Booked', r.booked, 'your bookings'],
    ['Jobs completed', r.completedJobs, 'you marked'],
    ['Reported job value', money(r.reportedRevenueCents), r.reportedRevenueCents == null ? 'not reported' : 'you reported'],
    ['Cost per booking', money(r.costPerBookingCents), r.costPerBookingCents == null ? 'not enough data' : 'calculated'],
    ['Cost per completed job', money(r.costPerCompletedJobCents), r.costPerCompletedJobCents == null ? 'not enough data' : 'calculated'],
  ]
  return (
    <>
      <section aria-label="Ad results, last 30 days" className="stats">
        {tiles.map(([label, value, source]) => (
          <div key={label} className="stat" data-source={source}>
            <p className="stat-value stat-value--sm">{value}</p>
            <p className="stat-label">{label}</p>
            <p className="stat-source">{source}</p>
          </div>
        ))}
      </section>
      <p className="fine stats-note">
        Last 30 days, ad leads only. “—” means not enough data to measure. Job value is what you reported, not verified payments; GetShowUps does not
        measure how much of it the ads caused.
      </p>
    </>
  )
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
      <h2 className="card-title">4. Approve your monthly ad budget</h2>
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

function Connections({ connections, capabilities, running = 0, onChange }) {
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
          {platform === 'meta' && state === 'connected' && c.accountName && <p className="account-selected">{c.accountName}</p>}
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
          <span className="fine">Coming soon</span>
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
        {(capabilities.meta || connections.meta) && row('meta', 'Facebook & Instagram')}
      </ul>
    </section>
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
  return (
    <div className="ad-preview" aria-label="Ad preview">
      <p className="fine">Sponsored</p>
      <p>{(m.primaryTexts || [])[0]}</p>
      <p className="ad-preview-title">{(m.headlines || [])[0]}</p>
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

function Verification({ v }) {
  if (!v) return null
  if (v.error) return <p className="fine" data-verification="unknown">Couldn’t check this campaign on Google yet. We’ll try again automatically.</p>
  return v.ok ? (
    <p className="conn-status conn-status--ok" data-verification="ok">
      <span className="conn-icon" aria-hidden="true">
        ✓
      </span>
      Checked on Google: budget, area, keywords and ad match
    </p>
  ) : (
    <p className="conn-status conn-status--warn" data-verification="differs">
      <span className="conn-icon" aria-hidden="true">
        !
      </span>
      Google shows a difference: {v.failed.join(', ')}
    </p>
  )
}

function CampaignEditor({ c, capabilities, budget, onChange }) {
  const [saved, setSaved] = useState(c.spec)
  const [spec, setSpec] = useState(c.spec)
  const [state, setState] = useState({})
  const [confirm, setConfirm] = useState(null) // 'launch' | 'remove'
  const editable = !c.launched && ['draft', 'approved', 'error'].includes(c.status)
  const dirty = JSON.stringify(spec) !== JSON.stringify(saved)
  // Google campaigns on a verified Google Ads test account can be created and started without the live
  // switch (test accounts never serve or spend); the server re-checks with Google before every change.
  const sandbox = c.platform === 'google' && Boolean(capabilities.sandbox)
  const canServe = capabilities.liveLaunch || sandbox
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
    approve: 'Approved. Next: create it on Google (it starts paused).',
    launch: sandbox ? 'Created on Google, paused. It’s a test account, so it never shows and nothing is charged.' : 'Created on Google, paused. Nothing runs until you press Start.',
    launch_differs: 'Created on Google, paused, but Google shows a difference. See below.',
    resume: sandbox ? 'Started on the test account. It never shows and nothing is charged.' : 'Started.',
    pause: 'Paused.',
    budget: 'Daily budget changed.',
    save: 'Saved.',
    remove: 'Removed.',
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
    <article className="card campaign" aria-label={`${c.platform === 'google' ? 'Google Search' : 'Facebook & Instagram'} campaign`}>
      <header className="campaign-head">
        <h3 className="card-title">{c.platform === 'google' ? 'Google Search' : 'Facebook & Instagram'}</h3>
        <span className={`chip chip--${c.status}`}>{STATUS_LABEL[c.status] || c.status}</span>
      </header>

      {c.platform === 'google' ? <GooglePreview spec={spec} /> : <MetaPreview spec={spec} />}
      {c.platform === 'google' && (spec.geo?.zips || []).length > 0 && (
        <p className="fine" data-where>
          <strong>Where:</strong> people in {spec.geo.zips.length === 1 ? `ZIP code ${spec.geo.zips[0]}` : `${spec.geo.zips.length} ZIP codes (${spec.geo.zips.slice(0, 6).join(', ')}${spec.geo.zips.length > 6 ? ', …' : ''})`}, searching on Google.
          {editable && ' Change your area in step 1, then draft again.'}
        </p>
      )}
      <BudgetSummary dailyCents={spec.dailyBudgetCents} budget={budget} />
      <p className="fine">{CHARGING}</p>
      {c.launched && <Verification v={c.verification} />}
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
      {editable && c.platform === 'meta' && (
        <details className="campaign-edit">
          <summary>Edit ad</summary>
          <label className="field">
            <span>Main text</span>
            <textarea rows={3} value={(m.primaryTexts || []).join('\n')} onChange={(e) => setM({ primaryTexts: lines(e.target.value) })} />
          </label>
          <label className="field">
            <span>Headline <em>(up to 40 characters)</em></span>
            <input value={(m.headlines || [])[0] || ''} onChange={(e) => setM({ headlines: [e.target.value] })} />
          </label>
          <label className="field">
            <span>Daily budget ($)</span>
            <input type="number" min="5" step="1" value={spec.dailyBudgetCents / 100} onChange={(e) => set({ dailyBudgetCents: toCents(e.target.value) })} />
          </label>
        </details>
      )}

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
            Change daily budget{sandbox ? ' (test account)' : ''}
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
            {confirm === 'approve_create' ? 'Approve this ad and create it on Google? ' : 'Create this campaign on Google? '}
            It starts <strong>paused</strong>; nothing runs until you press Start.
            {sandbox && ' Test account: it never shows and nothing is charged.'}
          </p>
          <div className="card-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => (confirm === 'approve_create' ? approveAndCreate() : act('launch', { confirm: true }))}>
              {confirm === 'approve_create' ? 'Confirm: approve and create (paused)' : 'Confirm: create on Google (paused)'}
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirm === 'remove' ? (
        <div className="confirm" role="group" aria-label="Confirm remove">
          <p>Remove this draft? It disappears from this list. Nothing on Google changes.</p>
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
              <button type="button" className="btn btn-primary" disabled={busy || dirty || !budget} onClick={() => (canServe ? setConfirm('approve_create') : act('approve'))}>
                {state.busy === 'approve' ? 'Approving…' : canServe ? `Approve and create (paused)${sandbox ? ' · test account' : ''}` : 'Approve'}
              </button>
            )}
            {c.status === 'approved' && !c.launched && (
              <button type="button" className="btn btn-primary" disabled={busy || dirty || !canServe} onClick={() => setConfirm('launch')}>
                Create on {c.platform === 'google' ? 'Google' : 'Meta'} (paused){sandbox ? ' · test account' : ''}
              </button>
            )}
            {c.launched && c.status === 'paused' && (
              <button type="button" className="btn btn-primary" disabled={busy || !canServe} onClick={() => act('resume')}>
                {sandbox ? 'Start ads (test account, no spend)' : 'Start ads'}
              </button>
            )}
            {c.status === 'active' && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('pause')}>
                Pause
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
            {!c.launched && <li>Check: Google reviews the ad. Nothing is created or charged.</li>}
            {['draft', 'error'].includes(c.status) && !c.launched && (
              <li>
                {!budget
                  ? 'Approve your monthly ad budget (step 4) to approve this campaign.'
                  : canServe
                    ? 'Approve and create: puts this exact ad on Google, paused. Nothing runs until you press Start.'
                    : 'Approve: locks in this version. Connect your ad account to create it on Google.'}
              </li>
            )}
            {c.status === 'approved' && !c.launched && (
              <li>{canServe ? 'Create: puts it on Google, paused. Nothing runs until you press Start.' : ERRORS.live_launch_disabled}</li>
            )}
            {c.launched && c.status === 'paused' && <li>{sandbox ? 'Start: runs on the test account. It never shows and nothing is charged.' : 'Start: the ad can show and spend, within your approved budget.'}</li>}
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

export default function Ads() {
  const [returned] = useState(readReturn)
  useEffect(() => {
    // Drop ?ads= / ?ads_error= so a reload or bookmark doesn't repeat the message.
    if (returned) window.history.replaceState(null, '', window.location.pathname)
  }, [returned])
  const [d, setD] = useState(null)
  const [error, setError] = useState(false)
  const [plan, setPlan] = useState({})
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
          <span>Only Google Ads test accounts. Test campaigns never show ads, and nothing is ever charged.</span>
        </p>
      )}
      {anyLaunched && <Results r={d.results} />}

      <section className="card">
        <h2 className="card-title">1. Your business</h2>
        <ProfileForm profile={d.profile} onSaved={load} />
      </section>

      {d.profile && <Connections connections={d.connections} capabilities={d.capabilities} running={d.campaigns.filter((c) => c.platform === 'google' && c.launched && c.status === 'active').length} onChange={load} />}

      {d.profile && (
        <section className="card" aria-labelledby="review-title">
          <h2 className="card-title" id="review-title">
            3. Review your campaign
          </h2>
          {openGoogle.length === 0 ? (
            <>
              <p className="fine">
                {d.capabilities.ai ? 'GetShowUps drafts a plan from your details.' : 'GetShowUps creates a starter draft from your details.'} Nothing runs until you approve it.
              </p>
              <button type="button" className="btn btn-primary" disabled={plan.busy} onClick={makePlan}>
                {plan.busy ? 'Drafting…' : 'Draft my plan'}
              </button>
            </>
          ) : openGoogle.length > 1 ? (
            <p className="notice-info" role="status" data-duplicate-drafts>
              Tidy up: you have {openGoogle.length} Google Search drafts. Keep the one you want and remove the others.
            </p>
          ) : null}
          {plan.error && <p className="form-error" role="alert">{plan.error}</p>}
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
            <CampaignEditor key={c.id} c={c} capabilities={d.capabilities} budget={d.budget} onChange={load} />
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
