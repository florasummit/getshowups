// /admin — platform console for GetShowUps staff. Access requires a Google sign-in whose email is in
// PLATFORM_ADMIN_EMAILS (checked server-side on every request). Customer lead details are never shown.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, browserTimeZone, fmt, noIndex, timeZones } from '../lib/api.js'
import { SignOut } from '../dashboard/Home.jsx'
import '../app.css'

const Review = lazy(() => import('./Review.jsx'))
const SECTIONS = [
  ['overview', 'Overview', '/admin'],
  ['review', 'Business Review', '/admin/review'],
]

const ONBOARDING = { invited: 'Invited', calendar: 'Connect calendar', hours: 'Set hours', live: 'Live', suspended: 'Suspended' }
const ATTENTION = {
  suspended: 'Suspended',
  past_due: 'Payment failed',
  ads_running_on_hold: 'Ads still running while on hold',
  deletion_stuck: 'Deletion stuck (needs a look)',
  booking_failures: 'Booking failures',
  calendar_disconnected: 'Calendar disconnected',
  setup_stalled: 'Setup stalled',
  checkout_abandoned: 'Signed up, didn’t pay',
  cancel_scheduled: 'Cancellation scheduled',
  subscription_ended: 'Subscription ended',
  recovery_ending: 'Recovery period ends within 14 days',
  recovery_ended: 'Recovery period over',
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
  // Stripe test mode (live billing not switched on): subscriptions exist but none of it is revenue.
  const testMode = m.billing?.mode === 'test'
  const b = testMode ? null : m.billing
  const noBilling = testMode ? 'Test mode' : '—'
  // On-site businesses (the business visits the customer) are judged by completed jobs, not customer show-ups.
  const outcome = m.showUpRate30 == null && m.completionRate30 != null ? ['Job completion', pct(m.completionRate30)] : ['Show-up rate', pct(m.showUpRate30)]
  const main = [
    ['Customers', m.customers.total],
    ['Activation', pct(m.activationRate)],
    ['Booking conversion', pct(m.bookingConversion30)],
    outcome,
    ['MRR', b ? money(b.mrrCents, b.currency) : testMode ? 'Test mode (no revenue)' : 'No billing yet'],
  ]
  const extra = [
    ['ARR', b ? money(b.arrCents, b.currency) : noBilling],
    ['Paying customers', b ? b.payingCustomers : noBilling],
    ['Trialing', b ? b.trialing : noBilling],
    ['Revenue (30 days)', b ? money(b.revenue30Cents, b.currency) : noBilling],
    ['Revenue growth', b ? pct(b.revenueGrowth30) : noBilling],
    ['Churn (30 days)', b ? pct(b.churn30) : noBilling],
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
      {testMode && (
        <p className="fine" data-billing-test-mode>
          Billing is in Stripe test mode: {plural(m.billing.testSubscriptions, 'active test subscription')}, not counted as revenue.
        </p>
      )}
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
  const [statusResult, setStatusResult] = useState(null)
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
    const { data } = await api('/api/platform/status', { method: 'POST', body: { customer: id, status } })
    setStatusResult(data?.ads ?? null)
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
            <div className="stack">
              <p className="fine">Pauses the booking page and, right away, every running ad campaign (checked on Google). Reactivating never restarts ads; the owner does that.</p>
              <div className="row-actions">
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setStatus('suspended')}>
                  Confirm: pause booking page and ads
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(true)}>
              Suspend account
            </button>
          )
        ) : (
          <>
            {statusResult && (
              <p className={statusResult.failed ? 'form-error' : 'fine'} role="status" data-ads-paused={statusResult.paused}>
                Ads: {statusResult.paused} campaign{statusResult.paused === 1 ? '' : 's'} paused
                {statusResult.verified ? ` (${statusResult.verified} confirmed on Google)` : ''}
                {statusResult.failed ? `; ${statusResult.failed > 0 ? statusResult.failed : 'some'} couldn’t be paused yet, retrying every few minutes` : ''}.
              </p>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setStatus('active')}>
              Reactivate account
            </button>
          </>
        )}
      </section>

      {d.lifecycle && <Lifecycle l={d.lifecycle} />}

      {d.deletion?.enabled && <Deletion id={d.id} deletion={d.deletion} onDone={() => (load(), onChanged())} />}

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
// Where the business stands in its lifecycle: billing, hosting, ads hold, recovery window, deletion.
const STAGES = {
  subscribed: 'Subscribed',
  not_billed: 'Not billed (pilot / invited)',
  payment_problem: 'Payment problem',
  cancel_scheduled: 'Cancellation scheduled',
  canceled_recoverable: 'Canceled — recoverable',
  recovery_ended: 'Canceled — recovery period over',
  deleting: 'Being deleted',
  deleted: 'Deleted',
}
const HOLDS = { suspended: 'suspended by GetShowUps', payment_failed: 'payment failed', subscription_ended: 'subscription ended', account_deleted: 'account deleted' }
function Lifecycle({ l }) {
  return (
    <section className="card" aria-labelledby="lifecycle-title">
      <h2 className="card-title" id="lifecycle-title">
        Lifecycle
      </h2>
      <dl className="kv" data-stage={l.stage}>
        <div>
          <dt>Stage</dt>
          <dd>{STAGES[l.stage] || l.stage}</dd>
        </div>
        <div>
          <dt>Subscription</dt>
          <dd>
            {l.subscription
              ? `${l.subscription.status}${l.subscription.currentPeriodEnd ? ` · ${l.subscription.cancelAtPeriodEnd ? 'ends' : 'period ends'} ${date(l.subscription.currentPeriodEnd)}` : ''}`
              : 'none'}
          </dd>
        </div>
        <div>
          <dt>Website hosting</dt>
          <dd>{l.hosting.exempt ? 'active (not billed)' : l.hosting.status === 'grace' ? `grace until ${date(l.hosting.until)}` : l.hosting.status}</dd>
        </div>
        <div>
          <dt>Ads</dt>
          <dd data-ads-hold={l.adsHold || 'none'}>{l.adsHold ? `on hold: ${HOLDS[l.adsHold] || l.adsHold}` : 'no hold'}</dd>
        </div>
        {l.recovery && (
          <div>
            <dt>Recovery</dt>
            <dd>
              {l.recovery.expired ? `over since ${date(l.recovery.until)}` : `until ${date(l.recovery.until)} (${l.recovery.daysLeft} days)`}
              {l.recovery.retentionScheduled ? ' · then removed (retention schedule on)' : ' · no retention schedule yet (decision pending)'}
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}

// Permanent account deletion (on a verified request) and the status of a running one.
const DELETION_STEPS = { lockout: 'Turning services off', ads: 'Pausing ads', billing: 'Ending billing', integrations: 'Disconnecting integrations', data: 'Erasing data', verify: 'Verifying', done: 'Done' }
function Deletion({ id, deletion, onDone }) {
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(null)
  const send = async (action) => {
    setError(null)
    const { status, data } = await api('/api/platform/deletion', { method: 'POST', body: { customer: id, action, confirm: true, confirmId: action === 'retry' ? id : typed } })
    if (status !== 200) setError(data.error || 'failed')
    onDone()
  }
  return (
    <section className="card" aria-labelledby="deletion-title">
      <h2 className="card-title" id="deletion-title">
        Account deletion
      </h2>
      {deletion.status ? (
        <div className="stack" data-deletion={deletion.status}>
          <p className={deletion.lastError ? 'form-error' : 'fine'} role="status">
            {deletion.status === 'completed'
              ? `Deleted ${date(deletion.completedAt)}. Retained only: billing records, audit entries and this record.`
              : `In progress: ${DELETION_STEPS[deletion.step] || deletion.step}${deletion.lastError ? ` (failed ${deletion.attempts}×: ${deletion.lastError}; retrying automatically)` : ''}.`}
          </p>
          {deletion.status === 'in_progress' && (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => send('retry')}>
              Retry now
            </button>
          )}
        </div>
      ) : !open ? (
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)}>
          Delete account permanently…
        </button>
      ) : (
        <div className="stack">
          <p className="fine">For a verified deletion request. Everything stops at once and the data is erased; there is no undo.</p>
          <label className="field">
            <span>Type the business id ({id}) to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={typed.trim().toLowerCase() !== id} onClick={() => send('request')}>
              Delete permanently
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

// Billing reconciliation: Stripe vs our records (daily + on demand). Report only; resync one business on request.
function Reconciliation() {
  const [r, setR] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  useEffect(() => {
    api('/api/platform/reconcile').then(({ status, data }) => setR(status === 200 ? data : { error: true }))
  }, [])
  const run = async () => {
    setBusy(true)
    const { status, data } = await api('/api/platform/reconcile', { method: 'POST', body: { action: 'run' } })
    setBusy(false)
    if (status === 200) setR(data)
    else setNote(`Couldn’t run it (${data.error || status}).`)
  }
  const resync = async (customer) => {
    const { status, data } = await api('/api/platform/reconcile', { method: 'POST', body: { action: 'resync', customer, confirm: true } })
    setNote(status === 200 ? `${customer}: updated from Stripe (${data.status}).` : `${customer}: couldn’t resync (${data.error || status}).`)
  }
  const last = r?.last
  return (
    <section className="card" aria-labelledby="reconcile-title">
      <h2 className="card-title" id="reconcile-title">
        Billing reconciliation
      </h2>
      {!r ? (
        <p className="fine">Loading…</p>
      ) : r.error ? (
        <p className="empty">Not available.</p>
      ) : (
        <>
          <p className={last?.issues ? 'form-error' : 'fine'} role="status" data-reconcile={last ? (last.issues ? 'issues' : 'clean') : 'never'}>
            {!last
              ? 'Not run yet (it runs daily).'
              : last.issues
                ? `${last.issues} difference${last.issues === 1 ? '' : 's'} between Stripe and our records (checked ${date(last.at)}).`
                : `Stripe and our records match: ${last.checked.subscriptions} subscriptions, ${last.checked.invoices} paid invoices in ${last.checked.windowDays} days (checked ${date(last.at)}).`}
          </p>
          {last?.list?.length > 0 && (
            <ul className="rows">
              {last.list.map((i, n) => (
                <li key={n} className="row">
                  <div className="row-main">
                    <p className="row-title">{r.labels[i.type] || i.type}</p>
                    <p className="row-sub">
                      {i.customer || 'unknown business'} · {i.subscription || i.invoice}
                      {i.ours !== undefined ? ` · ours ${String(i.ours)}` : ''}
                      {i.stripe !== undefined ? ` · Stripe ${String(i.stripe)}` : ''}
                    </p>
                  </div>
                  {i.customer && ['status_mismatch', 'amount_mismatch', 'cancel_mismatch'].includes(i.type) && (
                    <button type="button" className="btn btn-sm btn-quiet" onClick={() => resync(i.customer)}>
                      Resync from Stripe
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={run}>
            {busy ? 'Checking…' : 'Run now'}
          </button>
          {note && (
            <p className="fine" role="status">
              {note}
            </p>
          )}
        </>
      )}
    </section>
  )
}

// Follow-ups and texting (counts only; no message text or contact details). Recording a registration status means:
// the PROVIDER reported it (Twilio console / carrier decision). Never mark "approved" on anything else.
const REG_STATUS = { not_configured: 'Not started', ready: 'Ready', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', suspended: 'Suspended' }
const SWITCHES = [
  ['killSwitch', 'Kill switch', true],
  ['messagesLive', 'Messages live'],
  ['smsLive', 'Texts live'],
  ['assistant', 'Assistant'],
  ['twilioConfigured', 'Twilio'],
]
function MessagingOps() {
  const [m, setM] = useState(null)
  const [tick, setTick] = useState(0)
  const [form, setForm] = useState({ customer: '', status: '', note: '', messagingService: '', senderPhone: '' })
  const [note, setNote] = useState('')
  useEffect(() => {
    api('/api/platform/messaging').then(({ status, data }) => setM(status === 200 ? data : { error: true }))
  }, [tick])
  const record = async (e) => {
    e.preventDefault()
    if (!window.confirm(`Record this for ${form.customer}? Only record what the provider reported.`)) return
    const body = { customer: form.customer, confirm: true, note: form.note }
    if (form.status) body.status = form.status
    if (form.messagingService) body.messagingService = form.messagingService
    if (form.senderPhone) body.senderPhone = form.senderPhone
    const { status, data } = await api('/api/platform/messaging', { method: 'POST', body })
    setNote(status === 200 ? 'Recorded.' : `Not recorded (${data.error || status}).`)
    if (status === 200) setTick((n) => n + 1)
  }
  const usd = (micros) => `$${(micros / 1e6).toFixed(2)}`
  return (
    <section className="card" aria-labelledby="messaging-title">
      <h2 className="card-title" id="messaging-title">
        Follow-ups and texting
      </h2>
      {!m ? (
        <p className="fine">Loading…</p>
      ) : m.error ? (
        <p className="empty">Not available.</p>
      ) : (
        <>
          <p className="tags">
            {SWITCHES.map(([k, l, bad]) => (
              <span key={k} className={`tag${m.switches[k] && bad ? ' tag--bad' : ''}`}>
                {l}: {m.switches[k] ? 'on' : 'off'}
              </span>
            ))}
          </p>
          {!m.ready ? (
            <p className="fine">Migration 0024 not applied yet: conversations are off; existing messages work as before.</p>
          ) : (
            <>
              <p className="fine" data-messaging-ops>
                Last 24 h: {m.last24h.sendFailures} send failures · {m.last24h.deliveryFailures} delivery failures · {m.last24h.aiFallbacks} assistant fallbacks · {m.last24h.optOuts} opt-outs · {m.last24h.handoffs} hand-offs · {m.last24h.webhookProblems} webhook problems. Stuck: {m.stuck.sending} sending, {m.stuck.repliesWaiting} replies waiting, {m.stuck.scheduledOverdue} overdue.
              </p>
              {m.spikes.length > 0 && <p className="form-error">Unusual volume: {m.spikes.map((x) => `${x.customer} (${x.lastHour}/h)`).join(', ')}</p>}
              {m.businesses.length > 0 && (
                <ul className="rows">
                  {m.businesses.map((b) => (
                    <li key={b.customer} className="row">
                      <div className="row-main">
                        <p className="row-title">{b.name}</p>
                        <p className="row-sub">
                          {b.texts} texts · {b.inbound} received · {b.emails} emails · {b.ai} assistant · {b.failed} failed · {usd(b.costMicros)} est.
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <h3>Texting registrations</h3>
              {m.registrations.length === 0 ? (
                <p className="fine">None yet.</p>
              ) : (
                <ul className="rows">
                  {m.registrations.map((r) => (
                    <li key={r.customer} className="row">
                      <div className="row-main">
                        <p className="row-title">
                          {r.name} <span className="tag">{REG_STATUS[r.status]}</span>
                        </p>
                        <p className="row-sub">
                          {r.customer} · owner approved: {r.ownerApproved ? 'yes' : 'no'} · sender: {r.hasSender ? 'set' : 'not set'}
                        </p>
                        <TwilioSetup customer={r.customer} onChange={() => setTick((n) => n + 1)} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form className="fu-form" onSubmit={record}>
                <p className="fine">Record what the provider reported for a business (status and/or its provisioned sender).</p>
                <input aria-label="Business id" placeholder="business id" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value.trim() })} required />
                <select aria-label="Provider status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="">Status unchanged</option>
                  <option value="pending">Pending (submitted)</option>
                  <option value="approved">Approved by the provider</option>
                  <option value="rejected">Rejected</option>
                  <option value="suspended">Suspended</option>
                </select>
                <input aria-label="Provider note" placeholder="Provider reason / next step (no personal data)" value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                <input aria-label="Messaging Service SID" placeholder="Messaging Service SID (MG...)" value={form.messagingService} onChange={(e) => setForm({ ...form, messagingService: e.target.value.trim() })} />
                <input aria-label="Sender phone" placeholder="Sender number (+1...)" value={form.senderPhone} onChange={(e) => setForm({ ...form, senderPhone: e.target.value.trim() })} />
                <button type="submit" className="btn btn-sm btn-quiet" disabled={!form.customer}>
                  Record
                </button>
                {note && (
                  <p className="fine" role="status">
                    {note}
                  </p>
                )}
              </form>
            </>
          )}
        </>
      )}
    </section>
  )
}

// One business's Twilio setup in ITS OWN subaccount: one step at a time, each confirmed and audited. Steps that submit
// to Twilio/carriers or cost money also need the release switch and an explicit approval tick for that step.
const STEP_ERRORS = {
  submission_disabled: 'Submitting and paid steps are switched off (TWILIO_REGISTRATION_SUBMIT).',
  approval_required: 'Tick the approval box for this step.',
  provider_not_configured: 'Twilio isn’t configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).',
  primary_profile_missing: 'Set TWILIO_PRIMARY_PROFILE_SID (GetShowUps’s approved ISV profile, BU…).',
  profile_email_missing: 'Set TWILIO_PROFILE_EMAIL (GetShowUps’s notifications address for Twilio).',
  owner_approval_missing: 'The owner hasn’t approved submission yet.',
  details_incomplete: 'The owner needs to re-save their details (address, representative, industry).',
  unknown_outcome: 'Twilio didn’t answer clearly. Check the Twilio console, then clear it below if nothing was created.',
  brand_not_approved: 'Wait for the brand to be approved (Sync), then continue.',
}
// Which recorded provider status belongs to each step.
const STEP_STATUS = { customer_profile: 'profile_evaluation', submit_profile: 'profile_submitted', a2p_bundle: 'bundle_evaluation', submit_bundle: 'bundle_submitted', brand: 'brand', campaign: 'campaign' }
function TwilioSetup({ customer, onChange }) {
  const [open, setOpen] = useState(false)
  const [p, setP] = useState(null)
  const [approve, setApprove] = useState(false)
  const [areaCode, setAreaCode] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) api(`/api/platform/messaging?customer=${encodeURIComponent(customer)}`).then(({ status, data }) => setP(status === 200 ? data.provisioning : { error: true }))
  }, [open, customer])
  const act = async (body, question) => {
    if (!window.confirm(question)) return
    const { status, data } = await api('/api/platform/messaging', { method: 'POST', body: { customer, confirm: true, ...body } })
    setNote(status === 200 ? 'Done.' : STEP_ERRORS[data.error] || `Not done (${data.error || status}).`)
    if (data?.provisioning) setP(data.provisioning)
    setApprove(false)
    onChange()
  }
  if (!open)
    return (
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        Twilio setup…
      </button>
    )
  if (!p) return <p className="fine">Loading…</p>
  if (p.error || !p.ready) return <p className="fine">Twilio setup isn’t available yet (migration 0025).</p>
  const next = p.steps.find((s) => s.id === p.next)
  return (
    <div className="fu-form" data-twilio-setup={customer}>
      <p className="fine">
        Path: {p.path || 'unknown'} · subaccount: {p.account ? p.account.status : 'none'} · submitting {p.submitEnabled ? 'enabled' : 'off'}
        {p.account?.usage ? ` · ${p.account.usage.messages} texts this month ($${(p.account.usage.micros / 1e6).toFixed(2)})` : ''}
      </p>
      <ol className="fine">
        {p.steps.map((s) => (
          <li key={s.id}>
            {s.done ? '✓ ' : ''}
            {s.label}
            {p.statuses[STEP_STATUS[s.id]] ? ` (${p.statuses[STEP_STATUS[s.id]]})` : ''}
          </li>
        ))}
      </ol>
      {next && (
        <>
          {(next.submits || next.charges) && (
            <label className="check">
              <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
              <span>I approve this step ({[next.submits && 'submits to Twilio/carriers', next.charges && 'Twilio charges for it'].filter(Boolean).join('; ')}).</span>
            </label>
          )}
          {next.id === 'phone_number' && (
            <input aria-label="Area code" placeholder="Area code (default: business phone)" inputMode="numeric" maxLength={3} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))} />
          )}
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => act({ action: 'provision', step: next.id, approve, areaCode: areaCode || undefined }, `${next.label} for ${customer}?`)}>
            Run: {next.label}
          </button>
        </>
      )}
      <div className="card-actions">
        <button type="button" className="link-btn" onClick={() => act({ action: 'sync' }, `Read ${customer}’s registration status from Twilio?`)}>
          Sync status
        </button>
        {p.path === 'sole_proprietor' && p.statuses.brand && (
          <button type="button" className="link-btn" onClick={() => act({ action: 'resend_otp' }, `Ask Twilio to text ${customer}’s owner a new verification code?`)}>
            Resend owner code
          </button>
        )}
        {p.account && (
          <button type="button" className="link-btn" onClick={() => act({ action: 'usage' }, `Read ${customer}’s texting usage from Twilio?`)}>
            Usage
          </button>
        )}
        {p.unknown.map((k) => (
          <button key={k} type="button" className="link-btn" onClick={() => act({ action: 'clear_unknown', kind: k }, `You checked Twilio and no ${k} was created for ${customer}? This allows that request again.`)}>
            Clear unknown {k}
          </button>
        ))}
      </div>
      {note && (
        <p className="fine" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

// Permanent audit log: chain status (recomputed on every load), newest entries, full JSON export.
function AuditLog() {
  const [a, setA] = useState(null)
  useEffect(() => {
    api('/api/platform/audit').then(({ status, data }) => setA(status === 200 ? data : { error: true }))
  }, [])
  return (
    <section className="card" aria-labelledby="audit-log-title">
      <h2 className="card-title" id="audit-log-title">
        Audit log
      </h2>
      {!a ? (
        <p className="fine">Loading…</p>
      ) : a.error ? (
        <p className="empty">The audit log isn’t available.</p>
      ) : (
        <>
          <p className={a.chain.ok ? 'fine' : 'form-error'} role="status" data-audit-chain={a.chain.ok ? 'ok' : 'broken'}>
            {a.chain.ok
              ? `Intact: all ${a.chain.checked} entries verified (append-only, hash-chained).`
              : `Integrity check failed at entry ${a.chain.brokenAt} (${a.chain.reason}). Investigate before trusting entries after it.`}{' '}
            <a href="/api/platform/audit?format=export" download>
              Download full log (JSON)
            </a>
          </p>
          {a.entries.length ? (
            <ul className="rows">
              {a.entries.slice(0, 20).map((e) => (
                <li key={e.seq} className="row">
                  <div className="row-main">
                    <p className="row-title">
                      #{e.seq} {e.action}
                      {e.customer ? ` · ${e.customer}` : ''}
                    </p>
                    <p className="row-sub">
                      {e.actorType === 'admin' ? e.actor : e.actorType} · {date(e.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No entries yet.</p>
          )}
        </>
      )}
    </section>
  )
}

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
  const real = filtered.filter((c) => !c.testBusiness && !c.deleted)
  const tests = filtered.filter((c) => c.testBusiness && !c.deleted)
  const deleted = filtered.filter((c) => c.deleted)
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
          <p className="empty">{data.customers.some((c) => !c.testBusiness && !c.deleted) ? 'No matches.' : 'No customers yet.'}</p>
        )}
      </section>

      {data.customers.some((c) => c.testBusiness && !c.deleted) && (
        <section className="card" aria-labelledby="test-businesses-title">
          <h2 className="card-title" id="test-businesses-title">
            Test businesses
          </h2>
          <p className="fine">Left out of customer counts and MRR. Never use live ads, messages or billing.</p>
          {tests.length ? <CustomerRows list={tests} onOpen={setSelected} /> : <p className="empty">No matches.</p>}
        </section>
      )}

      {deleted.length > 0 && (
        <section className="card" aria-labelledby="deleted-title">
          <h2 className="card-title" id="deleted-title">
            Deleted accounts
          </h2>
          <p className="fine">Permanently deleted (or being deleted). Not customers and never in metrics; open one to see the deletion record.</p>
          <CustomerRows list={deleted} onOpen={setSelected} />
        </section>
      )}

      {me.billingConfigured && <Plans />}

      {me.billingConfigured && <Reconciliation />}

      <MessagingOps />
      <AuditLog />

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

const LOGIN_ERRORS = {
  expired: 'That sign-in expired. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  failed: 'We couldn’t sign you in. Please try again.',
  rate_limited: 'Too many sign-in attempts. Please wait a few minutes.',
}

export default function Admin() {
  const [me, setMe] = useState({ loading: true })
  const [loginError] = useState(() => new URLSearchParams(window.location.search).get('login_error'))
  useEffect(() => {
    // Drop ?login_error= so a reload doesn't repeat the message.
    if (loginError) window.history.replaceState(null, '', window.location.pathname)
  }, [loginError])
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
        {LOGIN_ERRORS[loginError] && (
          <p className="form-error" role="alert">
            {LOGIN_ERRORS[loginError]}
          </p>
        )}
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
        <a className="btn btn-primary btn-block" href="/dashboard">
          Go to your dashboard
        </a>
        <SignOut email="" label="Sign out" to="/admin" />
      </Gate>
    )
  }
  if (!me.data) return <Gate title="Admin unavailable">{null}</Gate>
  return <Console me={me.data} />
}

function Console({ me }) {
  const [section, setSection] = useState(() => (window.location.pathname.startsWith('/admin/review') ? 'review' : 'overview'))
  const go = (id, href) => {
    window.history.pushState(null, '', href)
    setSection(id)
  }
  useEffect(() => {
    const onPop = () => setSection(window.location.pathname.startsWith('/admin/review') ? 'review' : 'overview')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return (
    <div className={`app${section === 'review' ? ' app--wide' : ''}`}>
      <header className="app-header">
        <Logo href="/" />
        <SignOut email={me.email} to="/admin" />
      </header>
      <nav className="tabs" aria-label="Admin">
        {SECTIONS.map(([id, label, href]) => (
          <a
            key={id}
            href={href}
            aria-current={section === id ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault()
              go(id, href)
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <main className="app-main">
        {section === 'review' ? (
          <Suspense fallback={<div aria-busy="true" />}>
            <Review />
          </Suspense>
        ) : (
          <Overview me={me} />
        )}
      </main>
    </div>
  )
}
