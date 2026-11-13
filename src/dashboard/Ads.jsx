// Ads: results first, then a short guided setup (business details → plan → budget → accounts →
// review and launch). Every campaign is an editable draft until the owner approves it; launching
// creates it PAUSED and nothing spends until the owner presses Start.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const money = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: c % 100 ? 2 : 0 })}`)
const toCents = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100))
const acct = (id) => String(id || '').replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3')
const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean)

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
  not_approved_for_production: 'GetShowUps is still waiting for Google to approve live access.',
  creative_not_approved: 'Approve the image this ad uses first.',
  image_required: 'Add an approved image for this Meta ad.',
  quota_images: 'You’ve used this month’s image allowance.',
  quota_videos: 'You’ve used this month’s video allowance.',
  quota_cost: 'You’ve reached this month’s AI usage limit.',
  not_configured: 'This isn’t available yet.',
  ai_declined: 'The planner couldn’t write this plan. Try changing the services.',
  rate_limited: 'Too many tries. Please wait a few minutes.',
  subscription_required: 'Ads need an active GetShowUps subscription. Open Settings → Billing.',
  account_not_accessible: 'That account isn’t reachable with this Google sign-in. If it sits under a manager account, choose the manager too.',
  invalid_account: 'Enter a 10-digit Google Ads account ID (dashes are fine).',
  invalid_budget: 'Enter a daily budget in dollars.',
  invalid_status: 'Only a created campaign (running or paused) can change its budget.',
  not_launched: 'Create the campaign on Google first.',
}
const errorText = (code) => ERRORS[code] || 'Something went wrong. Please try again.'

function Results({ r }) {
  const tiles = [
    ['Ad spend', money(r.spendCents)],
    ['Qualified leads', r.qualifiedLeads],
    ['Booked', r.booked],
    ['Jobs completed', r.completedJobs],
    ['Reported job value', money(r.reportedRevenueCents)],
    ['Cost per booking', money(r.costPerBookingCents)],
    ['Cost per completed job', money(r.costPerCompletedJobCents)],
  ]
  return (
    <>
      <section aria-label="Ad results, last 30 days" className="stats">
        {tiles.map(([label, value]) => (
          <div key={label} className="stat">
            <p className="stat-value stat-value--sm">{value}</p>
            <p className="stat-label">{label}</p>
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
        <span>Services you want customers for <em>(one per line)</em></span>
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
        <span>Website <em>(optional, https)</em></span>
        <input name="website" type="url" defaultValue={p.website} placeholder="https://" />
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
      setState({})
      setOk(false)
      onSaved()
    } else setState({ error: data.error === 'invalid_budget' ? 'Choose between $150 and $50,000 a month.' : errorText(data.error) })
  }
  return (
    <section className="card">
      <h2 className="card-title">4. Approve your monthly ad budget</h2>
      {budget ? (
        <p>
          Approved: <strong>{money(budget.monthlyCents)}/month</strong> (up to {money(budget.dailyCeilingCents)}/day across all campaigns).
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
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        <button className="btn btn-primary" disabled={!ok || state.busy}>
          Approve budget
        </button>
      </form>
    </section>
  )
}

// Choose which Google Ads account to use. Accounts reachable only through a manager need the manager
// chosen too. While live launch is off, the server only accepts accounts Google flags as test accounts.
// Choose which Google Ads account to use. The server finds the accounts automatically (including ones
// under a manager account) and works out how to reach them; while ads are in testing it offers only
// accounts Google flags as test accounts.
function GoogleAccountPicker({ onSaved }) {
  const [list, setList] = useState(null)
  const [state, setState] = useState({})
  useEffect(() => {
    api('/api/ads/google/accounts').then(({ status, data }) => setList(status === 200 ? data : { error: data.error }))
  }, [])
  const choose = async (accountId) => {
    setState({ busy: accountId })
    const { status, data } = await api('/api/ads/google/accounts', { method: 'POST', body: { accountId } })
    if (status === 200) {
      setState({})
      onSaved()
    } else setState({ error: errorText(data.error) })
  }
  if (!list) return <p className="fine" aria-busy="true">Finding your Google Ads accounts…</p>
  if (list.error) return <p className="form-error" role="alert">{errorText(list.error)}</p>
  if (!list.accounts.length)
    return (
      <p className="fine" role="status">
        {list.sandbox
          ? 'No Google Ads test accounts found for this Google sign-in. While ads are in testing, only test accounts can be used. Reconnect with the Google account that has your test account.'
          : 'No Google Ads accounts found for this Google sign-in. Reconnect with the Google account that has access to your ad account.'}
      </p>
    )
  return (
    <div className="stack" role="group" aria-label="Choose a Google Ads account">
      <p className="fine">Choose the account your ads should run in:</p>
      <ul className="rows account-pick">
        {list.accounts.map((a) => (
          <li key={a.id} className="row">
            <span>
              <strong>{a.name || 'Google Ads account'}</strong> <span className="fine">{acct(a.id)}</span>
              {a.testAccount && <span className="chip">Test account</span>}
            </span>
            <button type="button" className="btn btn-quiet" disabled={Boolean(state.busy)} onClick={() => choose(a.id)} aria-label={`Use ${a.name || 'account'} ${acct(a.id)}`}>
              {state.busy === a.id ? 'Checking with Google…' : 'Use this account'}
            </button>
          </li>
        ))}
      </ul>
      {list.sandbox && list.hidden > 0 && <p className="fine">Only test accounts are shown while ads are in testing.</p>}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
    </div>
  )
}

function Connections({ connections, capabilities, onChange }) {
  const [picking, setPicking] = useState(false)
  const row = (platform, label) => {
    const c = connections[platform]
    const available = capabilities[platform]
    return (
      <li key={platform} className="row">
        <div>
          <strong>{label}</strong>
          <p className="fine">
            {!c ? 'Not connected' : c.status === 'connected' ? `Connected${c.accountName ? `: ${c.accountName}` : ''}` : c.status === 'needs_account' ? 'Choose an ad account' : 'Reconnect needed'}
          </p>
          {c?.status === 'connected' && c.testAccount && (
            <p className="fine" data-test-account>
              Google Ads test account{c.accountId ? ` ${acct(c.accountId)}` : ''}: ads never run and nothing is charged. Results here are test data.
            </p>
          )}
          {platform === 'google' && c && (c.status === 'needs_account' || picking) && (
            <GoogleAccountPicker
              onSaved={() => {
                setPicking(false)
                onChange()
              }}
            />
          )}
          {platform === 'google' && c?.status === 'connected' && !picking && (
            <button type="button" className="link-btn" onClick={() => setPicking(true)}>
              Use a different account
            </button>
          )}
        </div>
        {available ? (
          <a className="btn btn-quiet" href={`/api/ads/${platform}/start`}>
            {c ? 'Reconnect' : 'Connect'}
          </a>
        ) : (
          <span className="fine">Coming soon</span>
        )}
      </li>
    )
  }
  return (
    <section className="card">
      <h2 className="card-title">2. Connect your ad account</h2>
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

function CampaignEditor({ c, capabilities, budgetApproved, onChange }) {
  const [spec, setSpec] = useState(c.spec)
  const [state, setState] = useState({})
  const editable = !c.launched && ['draft', 'approved', 'error'].includes(c.status)
  // Google campaigns on a verified Google Ads test account can be created and started without the live
  // switch (test accounts never serve or spend); the server re-checks with Google before every change.
  const sandbox = c.platform === 'google' && Boolean(capabilities.sandbox)
  const canServe = capabilities.liveLaunch || sandbox
  const g = spec.google || {}
  const m = spec.meta || {}
  const set = (patch) => setSpec((s) => ({ ...s, ...patch }))
  const setG = (patch) => set({ google: { ...g, ...patch } })
  const setM = (patch) => set({ meta: { ...m, ...patch } })

  const [daily, setDaily] = useState(c.dailyBudgetCents / 100)
  const [live, setLive] = useState(null)
  const checkGoogle = async () => {
    setLive({ busy: true })
    const { status, data } = await api('/api/ads/google/campaigns')
    if (status !== 200) return setLive({ error: errorText(data.error) })
    const g = data.campaigns.find((x) => x.gsuId === c.id)
    setLive(g ? { ...g, testAccount: data.testAccount } : { missing: true })
  }
  const act = async (action, extra = {}) => {
    setState({ busy: action })
    const { status, data } = await api('/api/dashboard/ads/campaign', { method: 'POST', body: { action, id: c.id, ...extra } })
    if (status === 200) {
      const note = action === 'validate' ? 'Check passed. Nothing was created and nothing was spent.' : action === 'save' && data.errors?.length ? null : 'Done.'
      setState({ note, problems: data.errors?.length ? data.errors : null })
      onChange()
    } else setState({ error: errorText(data.error), problems: data.errors })
  }

  return (
    <article className="card campaign">
      <header className="campaign-head">
        <h3 className="card-title">{c.platform === 'google' ? 'Google Search' : 'Facebook & Instagram'}</h3>
        <span className={`chip chip--${c.status}`}>{c.status === 'active' ? 'Running' : c.status === 'paused' && c.launched ? 'Paused' : c.status}</span>
      </header>
      {c.platform === 'google' ? <GooglePreview spec={spec} /> : <MetaPreview spec={spec} />}

      {editable && (
        <details className="campaign-edit">
          <summary>Edit ad</summary>
          <label className="field">
            <span>Daily budget ($)</span>
            <input type="number" min="5" step="1" value={spec.dailyBudgetCents / 100} onChange={(e) => set({ dailyBudgetCents: toCents(e.target.value) })} />
          </label>
          {c.platform === 'google' ? (
            <>
              <label className="field">
                <span>Headlines <em>(3–15, up to 30 characters, one per line)</em></span>
                <textarea rows={6} value={(g.headlines || []).join('\n')} onChange={(e) => setG({ headlines: lines(e.target.value) })} />
              </label>
              <label className="field">
                <span>Descriptions <em>(2–4, up to 90 characters)</em></span>
                <textarea rows={3} value={(g.descriptions || []).join('\n')} onChange={(e) => setG({ descriptions: lines(e.target.value) })} />
              </label>
              <label className="field">
                <span>Search terms <em>(one per line; wrap in [brackets] for exact match)</em></span>
                <textarea
                  rows={5}
                  value={(g.keywords || []).map((k) => (k.match === 'EXACT' ? `[${k.text}]` : k.text)).join('\n')}
                  onChange={(e) => setG({ keywords: lines(e.target.value).map((t) => (/^\[.*\]$/.test(t) ? { text: t.slice(1, -1), match: 'EXACT' } : { text: t, match: 'PHRASE' })) })}
                />
              </label>
              <label className="field">
                <span>Never show for <em>(negative terms)</em></span>
                <textarea rows={3} value={(g.negativeKeywords || []).join('\n')} onChange={(e) => setG({ negativeKeywords: lines(e.target.value) })} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>Main text</span>
                <textarea rows={3} value={(m.primaryTexts || []).join('\n')} onChange={(e) => setM({ primaryTexts: lines(e.target.value) })} />
              </label>
              <label className="field">
                <span>Headline <em>(up to 40 characters)</em></span>
                <input value={(m.headlines || [])[0] || ''} onChange={(e) => setM({ headlines: [e.target.value] })} />
              </label>
            </>
          )}
          <button type="button" className="btn btn-quiet" disabled={!!state.busy} onClick={() => act('save', { spec })}>
            Save changes
          </button>
        </details>
      )}

      {state.problems?.length > 0 && (
        <ul className="problems" role="alert">
          {state.problems.slice(0, 8).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.note && <p className="fine" role="status">{state.note}</p>}
      {['draft', 'error'].includes(c.status) && !c.launched && !budgetApproved && <p className="fine">Approve your monthly ad budget (step 4) to approve this campaign.</p>}

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
          <button type="submit" className="btn btn-quiet" disabled={!!state.busy || !canServe || toCents(daily) === c.dailyBudgetCents}>
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

      <div className="card-actions">
        {['draft', 'error'].includes(c.status) && !c.launched && (
          <button type="button" className="btn btn-primary" disabled={!!state.busy || !budgetApproved} onClick={() => act('approve')} title={budgetApproved ? '' : 'Approve your monthly ad budget first'}>
            Approve
          </button>
        )}
        {!c.launched && (
          <button type="button" className="btn btn-quiet" disabled={!!state.busy} onClick={() => act('validate')}>
            Check (no spend)
          </button>
        )}
        {c.status === 'approved' && (
          <button type="button" className="btn btn-quiet" disabled={!!state.busy || !canServe} onClick={() => act('launch', { confirm: true })} title={canServe ? '' : ERRORS.live_launch_disabled}>
            Create on {c.platform === 'google' ? 'Google' : 'Meta'} (paused){sandbox ? ' · test account' : ''}
          </button>
        )}
        {c.launched && c.status === 'paused' && (
          <button type="button" className="btn btn-primary" disabled={!!state.busy || !canServe} onClick={() => act('resume')}>
            {sandbox ? 'Start ads (test account, no spend)' : 'Start ads'}
          </button>
        )}
        {c.status === 'active' && (
          <button type="button" className="btn btn-danger" disabled={!!state.busy} onClick={() => act('pause')}>
            Pause
          </button>
        )}
        {!c.launched && ['draft', 'approved', 'error'].includes(c.status) && (
          <button type="button" className="link-btn" disabled={!!state.busy} onClick={() => act('remove')}>
            Remove
          </button>
        )}
      </div>
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

  const makePlan = async () => {
    setPlan({ busy: true })
    const { status, data } = await api('/api/dashboard/ads/plan', { method: 'POST', body: {} })
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
  return (
    <div className="enter">
      <h1 className="title">Ads</h1>
      {anyLaunched && <Results r={d.results} />}

      <section className="card">
        <h2 className="card-title">1. Your business</h2>
        <ProfileForm profile={d.profile} onSaved={load} />
      </section>

      {d.profile && <Connections connections={d.connections} capabilities={d.capabilities} onChange={load} />}

      {d.profile && (
        <section className="card">
          <h2 className="card-title">3. Review your campaign</h2>
          <p className="fine">
            {d.capabilities.ai ? 'GetShowUps drafts a plan from your details.' : 'GetShowUps creates a starter draft from your details.'} Drafts are only suggestions; nothing runs
            until you approve it.
          </p>
          <button type="button" className="btn btn-primary" disabled={plan.busy} onClick={makePlan}>
            {plan.busy ? 'Planning…' : d.campaigns.length ? 'Draft another plan' : 'Draft my plan'}
          </button>
          {plan.error && <p className="form-error" role="alert">{plan.error}</p>}
          {plan.result && (
            <div className="plan-notes" role="status">
              {plan.result.source === 'template' && <p className="fine">Starter draft (AI planning is not switched on).</p>}
              <p>{plan.result.rationale}</p>
              {plan.result.landing && <p className="fine">Where clicks go: {plan.result.landing}</p>}
              {plan.result.tracking?.length > 0 && <p className="fine">Tracking: {plan.result.tracking.join(' · ')}</p>}
            </div>
          )}
        </section>
      )}


      {d.campaigns.length > 0 && (
        <section aria-label="Campaigns" className="stack">
          <h2 className="card-title">Campaigns</h2>
          {d.campaigns.map((c) => (
            <CampaignEditor key={c.id} c={c} capabilities={d.capabilities} budgetApproved={Boolean(d.budget)} onChange={load} />
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
