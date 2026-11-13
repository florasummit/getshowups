// /admin — platform console for GetShowUps staff. Access requires a Google sign-in whose email is in
// PLATFORM_ADMIN_EMAILS (checked server-side on every request). Customer lead details are never shown.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, browserTimeZone, fmt, noIndex, timeZones } from '../lib/api.js'
import { SignOut } from '../dashboard/Home.jsx'
import '../app.css'

const ONBOARDING = { invited: 'Invited', calendar: 'Connect calendar', hours: 'Set hours', live: 'Live', suspended: 'Suspended' }
const ATTENTION = {
  suspended: 'Suspended',
  past_due: 'Payment failed',
  booking_failures: 'Booking failures',
  calendar_disconnected: 'Calendar disconnected',
  setup_stalled: 'Setup stalled',
  checkout_abandoned: 'Signed up, didn’t pay',
  cancel_scheduled: 'Cancellation scheduled',
  subscription_ended: 'Subscription ended',
  invite_pending: 'Invite not accepted',
  no_owner: 'No owner',
  no_recent_bookings: 'No bookings in 14 days',
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const date = (ms) => (ms ? fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`)
const money = (cents, currency) =>
  cents === null || cents === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100)

function Gate({ title, children }) {
  return (
    <main className="center-page">
      <div className="panel panel--narrow enter">
        <Logo href="/" />
        <h1 className="title">{title}</h1>
        {children}
      </div>
    </main>
  )
}

function Metrics({ m }) {
  const [more, setMore] = useState(false)
  const b = m.billing
  const main = [
    ['Customers', m.customers.total],
    ['Activation', pct(m.activationRate)],
    ['Booking conversion', pct(m.bookingConversion30)],
    ['Show-up rate', pct(m.showUpRate30)],
    ['MRR', b ? money(b.mrrCents, b.currency) : 'No billing yet'],
  ]
  const extra = [
    ['ARR', b ? money(b.arrCents, b.currency) : '—'],
    ['Paying customers', b ? b.payingCustomers : '—'],
    ['Trialing', b ? b.trialing : '—'],
    ['Revenue (30 days)', b ? money(b.revenue30Cents, b.currency) : '—'],
    ['Revenue growth', b ? pct(b.revenueGrowth30) : '—'],
    ['Churn (30 days)', b ? pct(b.churn30) : '—'],
    ['Retention (30 days)', pct(m.retention30)],
    ['First booking rate', pct(m.firstBookingRate)],
    ['Visit rate (on-site businesses)', pct(m.visitRate30)],
    ['Job completion (on-site businesses)', pct(m.completionRate30)],
    ['Reported value of booked jobs (30 days)', m.reportedBookingValue30Cents == null ? '—' : money(m.reportedBookingValue30Cents, 'usd')],
    ['Incremental revenue from GetShowUps', 'Not measured (needs a baseline)'],
    ['CAC', 'Needs cost data'],
    ['LTV', 'Needs cost data'],
    ['Gross margin', 'Needs cost data'],
  ]
  return (
    <section aria-label="Metrics">
      <div className="stats stats--5">
        {main.map(([label, value]) => (
          <div key={label} className="stat">
            <p className={`stat-value stat-value--sm ${/[a-z]/i.test(String(value)) && !/%$/.test(String(value)) ? 'stat-value--text' : ''}`}>{value}</p>
            <p className="stat-label">{label}</p>
          </div>
        ))}
      </div>
      <button type="button" className="link-btn more-btn" aria-expanded={more} onClick={() => setMore(!more)}>
        {more ? 'Fewer metrics' : 'More metrics'}
      </button>
      {more && (
        <dl className="kv enter">
          {extra.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          {m.signupsByWeek.length > 0 && (
            <div>
              <dt>Signups by week</dt>
              <dd>{m.signupsByWeek.map((w) => `${w.weekStart}: ${w.count}`).join(' · ')}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  )
}

function InviteForm({ customer, onDone }) {
  const [form, setForm] = useState({ email: '', businessName: '', timezone: browserTimeZone() })
  const [state, setState] = useState({})
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const body = customer ? { email: form.email, customer } : form
    const { status, data } = await api('/api/platform/invites', { method: 'POST', body })
    if (status === 201) {
      setState({ result: data })
      onDone?.(data)
    } else setState({ error: data.error?.replaceAll('_', ' ') || 'Could not create the invitation.' })
  }
  if (state.result) return <InviteResult result={state.result} />
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>{customer ? 'Invite someone (Google email)' : 'Owner’s Google email'}</span>
        <input type="email" required value={form.email} onChange={set('email')} />
      </label>
      {!customer && (
        <>
          <label className="field">
            <span>Business name</span>
            <input required value={form.businessName} onChange={set('businessName')} maxLength={80} />
          </label>
          <label className="field">
            <span>Time zone</span>
            <select value={form.timezone} onChange={set('timezone')}>
              {[...new Set([form.timezone, ...timeZones()])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={state.busy}>
        {state.busy ? 'Creating…' : 'Create invitation'}
      </button>
    </form>
  )
}

function InviteResult({ result }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="form">
      <p className="fine">
        {result.email === 'sent' ? 'Invitation emailed.' : result.email === 'queued' ? 'Email queued; delivery will retry.' : 'Email delivery isn’t configured. Send this link yourself:'}
      </p>
      <input className="copy-field" readOnly value={result.url} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
      <button
        type="button"
        className="btn btn-quiet btn-block"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(result.url)
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
      {result.expiresAt && <p className="fine">Expires {date(Date.parse(result.expiresAt))}.</p>}
    </div>
  )
}

function CustomerDetail({ id, onBack, onChanged }) {
  const [d, setD] = useState(null)
  const [health, setHealth] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [linkResult, setLinkResult] = useState(null)
  const load = useCallback(() => api(`/api/platform/customer?id=${id}`).then(({ status, data }) => setD(status === 200 ? data : { error: true })), [id])
  useEffect(() => {
    load()
  }, [load])

  const check = async () => {
    setHealth({ checking: true })
    const { data } = await api(`/api/platform/customer?id=${id}&health=1`)
    setHealth(data.health || { status: 'error' })
  }
  const [testConfirm, setTestConfirm] = useState(false)
  const setTest = async (test) => {
    await api('/api/platform/test-business', { method: 'POST', body: { customer: id, test, confirm: true } })
    setTestConfirm(false)
    load()
    onChanged()
  }
  const setStatus = async (status) => {
    await api('/api/platform/status', { method: 'POST', body: { customer: id, status } })
    setConfirming(false)
    load()
    onChanged()
  }
  const inviteAction = async (inviteId, action) => {
    const { data } = await api('/api/platform/invite-action', { method: 'POST', body: { id: inviteId, action } })
    if (action === 'resend' && data.url) setLinkResult(data)
    load()
  }

  if (!d) return <p className="fine">Loading…</p>
  if (d.error) return <p className="form-error">Couldn’t load this customer.</p>
  const pendingInvites = d.invites.filter((i) => i.active)
  return (
    <div className="enter">
      <button type="button" className="link-btn back-btn" onClick={onBack}>
        ← All customers
      </button>
      <h1 className="title">{d.name}</h1>
      <p className="fine">
        {d.id} · {d.createdVia.replace('_', ' ')} · source {d.source} · since {date(d.createdAt)}
      </p>
      {d.attention.length > 0 && (
        <p className="tags">
          {d.attention.map((a) => (
            <span key={a} className="tag tag--bad">
              {ATTENTION[a]}
            </span>
          ))}
        </p>
      )}

      <section className="card">
        <dl className="kv">
          <div>
            <dt>Owners</dt>
            <dd>{d.owners || 'None yet'}</dd>
          </div>
          <div>
            <dt>Onboarding</dt>
            <dd>{ONBOARDING[d.onboarding]}</dd>
          </div>
          <div>
            <dt>Activity</dt>
            <dd>
              {plural(d.totals.leads, 'lead')} · {d.totals.booked} booked · {d.totals.showed} showed · {d.totals.no_show} no-show
            </dd>
          </div>
          <div>
            <dt>Last booking</dt>
            <dd>{date(d.lastBooking)}</dd>
          </div>
          <div>
            <dt>Subscription</dt>
            <dd>{d.subscription ? `${d.subscription.status}${d.subscription.planId ? ` · ${d.subscription.planId}` : ''}` : 'None'}</dd>
          </div>
          <div>
            <dt>Calendar</dt>
            <dd>
              {health?.checking ? 'Checking…' : health ? health.status.replaceAll('_', ' ') : d.calendarConnected ? 'Connected' : 'Not connected'}{' '}
              {d.calendarConnected && !health?.checking && (
                <button type="button" className="link-btn" onClick={check}>
                  Check now
                </button>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <h2 className="card-title">Invitations</h2>
        {pendingInvites.length > 0 && (
          <ul className="rows">
            {pendingInvites.map((i) => (
              <li key={i.id} className="row">
                <div className="row-main">
                  <p className="row-title">{i.email}</p>
                  <p className="row-sub">
                    Sent {date(i.created_at)} · expires {date(i.expires_at)}
                  </p>
                </div>
                <div className="row-actions">
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => inviteAction(i.id, 'revoke')}>
                    Revoke
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => inviteAction(i.id, 'resend')}>
                    Resend
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {linkResult ? <InviteResult result={linkResult} /> : <InviteForm customer={d.id} onDone={() => load()} />}
      </section>

      <section className="card">
        <h2 className="card-title">Account</h2>
        {d.status === 'active' ? (
          confirming ? (
            <div className="row-actions">
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setStatus('suspended')}>
                Confirm: pause booking page
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(true)}>
              Suspend account
            </button>
          )
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setStatus('active')}>
            Reactivate account
          </button>
        )}
      </section>

      <section className="card" aria-label="Test business">
        <h2 className="card-title">Test business</h2>
        <p className="fine">
          {d.testBusiness
            ? 'Marked as a test business: left out of platform metrics, and it can never use real Google Ads accounts, message real recipients or use live billing.'
            : 'A real business. Mark only businesses used for testing.'}
        </p>
        {testConfirm ? (
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setTestConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => setTest(!d.testBusiness)}>
              {d.testBusiness ? 'Confirm: treat as a real business (ad accounts must be chosen again)' : 'Confirm: mark as test business'}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setTestConfirm(true)}>
            {d.testBusiness ? 'Remove test mark' : 'Mark as test business'}
          </button>
        )}
      </section>

      {d.audit.length > 0 && (
        <section className="card">
          <h2 className="card-title">Audit trail</h2>
          <ul className="rows">
            {d.audit.map((a, i) => (
              <li key={i} className="row">
                <div className="row-main">
                  <p className="row-title">{a.action}</p>
                  <p className="row-sub">
                    {a.actor} · {fmt(new Date(a.at).toISOString(), undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Plans() {
  const [plans, setPlans] = useState([])
  const [form, setForm] = useState({ id: '', name: '', stripePriceId: '', trialDays: 0 })
  const [error, setError] = useState('')
  useEffect(() => {
    api('/api/platform/plans').then(({ status, data }) => status === 200 && setPlans(data.plans))
  }, [])
  const save = async (e) => {
    e.preventDefault()
    const { status, data } = await api('/api/platform/plans', { method: 'POST', body: { ...form, trialDays: Number(form.trialDays), entitlements: {} } })
    if (status === 200) {
      setPlans(data.plans)
      setForm({ id: '', name: '', stripePriceId: '', trialDays: 0 })
      setError('')
    } else setError(data.error?.replaceAll('_', ' ') || 'Could not save plan.')
  }
  return (
    <section className="card">
      <h2 className="card-title">Plans</h2>
      <p className="fine">Prices are set in Stripe. Each plan points to a Stripe Price.</p>
      {plans.length > 0 && (
        <ul className="rows">
          {plans.map((p) => (
            <li key={p.id} className="row">
              <div className="row-main">
                <p className="row-title">{p.name}</p>
                <p className="row-sub">
                  {p.stripePriceId} · {p.trialDays ? `${p.trialDays}-day trial` : 'no trial'} {p.active ? '' : '· inactive'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={save}>
        <div className="field-row">
          <label className="field">
            <span>Plan id</span>
            <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} required placeholder="starter" />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Stripe Price id</span>
            <input value={form.stripePriceId} onChange={(e) => setForm({ ...form, stripePriceId: e.target.value })} required placeholder="price_…" />
          </label>
          <label className="field">
            <span>Trial days</span>
            <input type="number" min="0" max="90" value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-quiet btn-block">Save plan</button>
      </form>
    </section>
  )
}

// One row per business in the platform lists (Customers, Test businesses).
function CustomerRows({ list, onOpen }) {
  return (
    <ul className="rows">
      {list.map((c) => (
        <li key={c.id} className="row row--link" onClick={() => onOpen(c.id)}>
          <div className="row-main">
            <p className="row-title">
              {c.name} <span className={`tag ${c.onboarding === 'live' ? 'tag--ok' : ''}`}>{ONBOARDING[c.onboarding]}</span>
              {c.appointmentMode === 'at_customer' && <span className="tag">On-site</span>}
              {c.testBusiness && (
                <span className="tag" data-test-business>
                  Test
                </span>
              )}
            </p>
            <p className="row-sub">
              {c.owners || 'No owner yet'} · {c.booked30} booked / {plural(c.leads30, 'lead')} (30d) · {c.subscription ? c.subscription.status : 'no plan'} · since{' '}
              {date(c.createdAt)} · {c.source}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

function Overview({ me }) {
  const [data, setData] = useState(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [inviting, setInviting] = useState(false)
  const load = useCallback(() => api('/api/platform/overview').then(({ status, data: d }) => setData(status === 200 ? d : { error: true })), [])
  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data?.customers || []).filter((c) => !q || `${c.name} ${c.id} ${c.owners}`.toLowerCase().includes(q))
  }, [data, query])

  if (!data) return <p className="fine">Loading…</p>
  if (data.error) return <p className="form-error">Couldn’t load the platform overview.</p>
  if (selected) return <CustomerDetail id={selected} onBack={() => setSelected(null)} onChanged={load} />

  const attention = data.customers.filter((c) => c.attention.length)
  const real = filtered.filter((c) => !c.testBusiness)
  const tests = filtered.filter((c) => c.testBusiness)
  return (
    <div className="enter">
      <div className="page-head">
        <h1 className="title title--page">Platform</h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setInviting(!inviting)} aria-expanded={inviting}>
          {inviting ? 'Close' : 'Invite customer'}
        </button>
      </div>
      {inviting && (
        <section className="card enter">
          <h2 className="card-title">Invite a new customer</h2>
          <InviteForm onDone={load} />
        </section>
      )}
      <Metrics m={data.metrics} />

      {attention.length > 0 && (
        <section className="card">
          <h2 className="card-title">Needs attention</h2>
          <ul className="rows">
            {attention.map((c) => (
              <li key={c.id} className="row row--link" onClick={() => setSelected(c.id)}>
                <div className="row-main">
                  <p className="row-title">
                    {c.name} {c.testBusiness && <span className="tag" data-test-business>Test</span>}
                  </p>
                  <p className="tags">
                    {c.attention.map((a) => (
                      <span key={a} className="tag tag--bad">
                        {ATTENTION[a]}
                      </span>
                    ))}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="customers-title">
        <div className="page-head">
          <h2 className="card-title" id="customers-title">
            Customers
          </h2>
          <input className="search" type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search customers" />
        </div>
        {real.length ? (
          <CustomerRows list={real} onOpen={setSelected} />
        ) : (
          <p className="empty">{data.customers.some((c) => !c.testBusiness) ? 'No matches.' : 'No customers yet.'}</p>
        )}
      </section>

      {data.customers.some((c) => c.testBusiness) && (
        <section className="card" aria-labelledby="test-businesses-title">
          <h2 className="card-title" id="test-businesses-title">
            Test businesses
          </h2>
          <p className="fine">Left out of customer counts and MRR. Never use live ads, messages or billing.</p>
          {tests.length ? <CustomerRows list={tests} onOpen={setSelected} /> : <p className="empty">No matches.</p>}
        </section>
      )}

      {me.billingConfigured && <Plans />}

      <section className="card">
        <h2 className="card-title">Email</h2>
        <p className="fine">{me.emailConfigured ? 'Delivery via Resend.' : 'Delivery isn’t configured. Messages are queued here and not sent.'}</p>
        {data.outbox.length > 0 ? (
          <ul className="rows">
            {data.outbox.slice(0, 15).map((m) => (
              <li key={m.id} className="row">
                <div className="row-main">
                  <p className="row-title">
                    {m.subject} <span className={`tag ${m.status === 'sent' ? 'tag--ok' : m.status === 'failed' ? 'tag--bad' : ''}`}>{m.status === 'pending' ? 'not sent' : m.status}</span>
                  </p>
                  <p className="row-sub">
                    {m.to_email} · {date(m.created_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No messages yet.</p>
        )}
      </section>
    </div>
  )
}

export default function Admin() {
  const [me, setMe] = useState({ loading: true })
  useEffect(() => {
    document.title = 'Admin · GetShowUps'
    const cleanup = noIndex()
    api('/api/platform/me').then(({ status, data }) => setMe(status === 200 ? { data } : { status, email: null }))
    return cleanup
  }, [])

  if (me.loading) return <main className="center-page" aria-busy="true" />
  if (me.status === 401) {
    return (
      <Gate title="Platform sign-in">
        <a className="btn btn-primary btn-lg btn-block" href="/api/auth/google/start?next=/admin">
          Continue with Google
        </a>
      </Gate>
    )
  }
  if (me.status === 403) {
    return (
      <Gate title="No platform access">
        <p className="lede">This account isn’t a GetShowUps admin.</p>
        <SignOut email="" label="Sign out" />
      </Gate>
    )
  }
  if (!me.data) return <Gate title="Admin unavailable">{null}</Gate>
  return (
    <div className="app">
      <header className="app-header">
        <Logo href="/" />
        <SignOut email={me.data.email} />
      </header>
      <main className="app-main">
        <Overview me={me.data} />
      </main>
    </div>
  )
}
