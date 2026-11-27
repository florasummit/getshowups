// Guided setup. The server decides the ordered steps from saved data (server/onboarding.js), so setup
// resumes at the right place on any device. Self-serve: business → payment → details → services →
// calendar → hours → website → address → publish → launch. Older businesses keep business → calendar → hours.
import { useEffect, useRef, useState } from 'react'
import Logo from '../components/Logo.jsx'
import AiWrite from './AiWrite.jsx'
import { LoadError } from './ui.jsx'
import { api, browserTimeZone } from '../lib/api.js'
import { BusinessForm, HoursForm, TimeZoneSelect } from './forms.jsx'
import { connectCalendar } from '../lib/connect.js'
import { SignOut } from './Home.jsx'
import Readiness from './Readiness.jsx'
import WebsiteEditor, { WebsitePreview } from './WebsiteEditor.jsx'
import { useWebsite } from './website-data.js'
import DomainSettings from './DomainSettings.jsx'
import { YourAccount } from './AccountSettings.jsx'
import { PublishBox } from './WebsiteTab.jsx'
import WebsiteImport from './WebsiteImport.jsx'
import WebsiteGenerator, { ReviseBox } from './WebsiteGenerator.jsx'
import { SUGGESTED } from '../content/service-suggestions.js'
import { INDUSTRIES, SELF_SERVE_STEPS, acceptDecision, setupDecisions, stepPosition, visitsCustomers } from './setup-rules.js'

const LABELS = { business: 'Business', payment: 'Plan', details: 'Details', services: 'Services', calendar: 'Calendar', hours: 'Hours', website: 'Website', address: 'Address', publish: 'Publish', launch: 'Done', handoff: 'Handoff' }
const PLAN_KEY = 'gsu_plan'
const storedPlan = () => {
  try {
    return localStorage.getItem(PLAN_KEY) || ''
  } catch {
    return ''
  }
}

export default function Setup({ me, reload }) {
  const { progress, email } = me
  // Before the business exists the server lists one step. Someone starting a plan sees the whole path from step 1.
  const preview = progress.steps.length === 1 && Boolean(me.signupPlan) && me.checkoutOpen !== false
  // Configure mode (assisted enrollment): staff prepare the owner's setup with the same steps; payment is handled on the
  // enrollment screen (Stripe-hosted, the owner pays) and the finish belongs to the owner, so both are left out and a
  // last "Handoff" screen points back to the enrollment.
  const staff = Boolean(me.staff)
  const steps = preview ? SELF_SERVE_STEPS.map((id) => ({ id, done: false })) : staff ? [...progress.steps.filter((s) => s.id !== 'payment' && s.id !== 'launch').map((s) => (s.id === 'calendar' ? { ...s, done: true } : s)), { id: 'handoff', done: false }] : progress.steps
  const [editing, setEditing] = useState(null)
  // Back from checkout: Stripe's confirmation can arrive before this page loads, so the plan step is already behind
  // the owner and never gets to say so. The next step says it once (only when the server reports the plan paid).
  const [justPaid, setJustPaid] = useState(() => new URLSearchParams(window.location.search).get('billing') === 'success')
  const paid = steps.find((x) => x.id === 'payment')?.done === true
  useEffect(() => {
    if (paid && new URLSearchParams(window.location.search).get('billing')) window.history.replaceState(null, '', '/dashboard')
  }, [paid])
  const pos = stepPosition(steps, editing)
  const { index, current } = pos
  const done = (info) => {
    setJustPaid(info?.paid === true)
    // Continue on a step the owner went back to → the next step in order (never a jump to the first unfinished one).
    setEditing(pos.next)
    reload()
  }

  return (
    <div className="app">
      <header className="app-header">
        <Logo href="/" />
        {staff ? null : <SignOut email={email} />}
      </header>
      <main className="center-page center-page--top">
        {steps.length > 1 && (
          <ol className="steps-bar steps-bar--wrap" aria-label="Setup progress">
            {steps.map((s, i) => {
              // The last screen is the finish itself: it shows a tick, not a number still to do.
              const ticked = (s.done && i !== index) || (s.id === 'launch' && i === index)
              const inner = (
                <>
                  <span className="steps-bar-dot">{ticked ? '✓' : i + 1}</span>
                  <span className="steps-bar-label">{LABELS[s.id]}</span>
                </>
              )
              return (
                <li key={s.id} className={s.done && i !== index ? 'is-done' : i === index ? 'is-current' : ''} aria-current={i === index ? 'step' : undefined}>
                  {!preview && pos.canOpen(i) ? (
                    <button type="button" className="steps-bar-btn" aria-label={`Step ${i + 1}: ${LABELS[s.id]}`} onClick={() => setEditing(pos.target(i))}>
                      {inner}
                    </button>
                  ) : (
                    inner
                  )}
                </li>
              )
            })}
          </ol>
        )}
        <section key={current} className={`panel enter ${current === 'website' || current === 'publish' ? 'panel--wide panel--site' : current === 'address' ? 'panel--medium' : 'panel--narrow'}`} aria-labelledby="step-title">
          <Step id={current} me={me} done={done} back={!preview && pos.back !== undefined ? () => setEditing(pos.back) : null} revisit={index < pos.frontier} justPaid={justPaid && paid} />
        </section>
        {!me.customer && (
          <details className="panel panel--narrow" data-own-account>
            <summary>Your account</summary>
            <YourAccount />
          </details>
        )}
        {progress.selfServe && <p className="fine setup-foot">Your progress saves automatically. You can leave and come back any time.</p>}
      </main>
    </div>
  )
}

const Back = ({ onClick }) =>
  onClick ? (
    <button type="button" className="link-btn" onClick={onClick}>
      Back
    </button>
  ) : null

function Step({ id, me, done, back, revisit, justPaid }) {
  const { progress, customer } = me
  if (id === 'business') {
    if (me.signupPlan && !customer && me.checkoutOpen === false) return <SignupClosed />
    return me.signupPlan || progress.selfServe ? <NameStep onDone={done} plan={me.signupPlan} customer={customer} /> : <LegacyBusiness customer={customer} onDone={done} />
  }
  if (id === 'payment') return revisit ? <PaidStep billing={progress.billing} onDone={done} back={back} /> : <PaymentStep me={me} onDone={done} back={back} />
  if (id === 'details') return <DetailsStep customer={customer} onDone={done} back={back} justPaid={justPaid} />
  if (id === 'services') return <ServicesStep onDone={done} back={back} />
  // Staff never connect their own Google account: the owner connects theirs from a single-use link.
  if (id === 'calendar') return me.staff ? <OwnerCalendarStep onBack={back} onDone={done} /> : <CalendarStep onBack={back} connected={revisit} onDone={done} />
  if (id === 'hours') return <HoursStep customer={customer} onDone={done} back={back} />
  if (id === 'website') return <WebsiteStep onDone={done} back={back} />
  if (id === 'address') return <AddressStep onDone={done} back={back} />
  if (id === 'publish') return <PublishStep onDone={done} back={back} />
  if (id === 'handoff') return <HandoffStep me={me} back={back} />
  return <LaunchStep me={me} onDone={done} />
}

function LegacyBusiness({ customer, onDone }) {
  return (
    <>
      <h1 id="step-title" className="title">
        {customer ? 'Your business' : 'Let’s set up your booking page'}
      </h1>
      <BusinessForm customer={customer} submitLabel="Continue" onSaved={onDone} />
    </>
  )
}

// Billing is sandbox-only and this person isn't an authorized tester: say so before anything is created.
const NOT_OPEN = 'Online sign-up isn’t open yet, so we can’t take payment here and you haven’t been charged. To get started now,'
function SignupClosed() {
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        Online sign-up opens soon
      </h1>
      <p className="notice-soft" role="status">
        {NOT_OPEN} <a href="/#book-demo">book a call with us</a>.
      </p>
    </div>
  )
}

// ---------- 1. Business name (creates the account's business on the chosen plan) ----------
function NameStep({ onDone, plan, customer }) {
  const [name, setName] = useState(customer?.name || '')
  const [state, setState] = useState({})
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    if (customer) {
      // Back to step 1 after the business exists: only the name changes; everything else is sent back as it is.
      const r = await api('/api/dashboard/business', { method: 'POST', body: { name, timezone: customer.timezone, serviceZips: customer.serviceZips || [] } })
      if (r.status === 200) return onDone()
      return setState({ error: r.data.error === 'invalid_name' ? 'Enter your business name.' : 'Something went wrong. Please try again.' })
    }
    let source
    try {
      source = localStorage.getItem('gsu_source') || undefined
    } catch {
      source = undefined
    }
    const { status, data } = await api('/api/dashboard/business', { method: 'POST', body: { name, timezone: browserTimeZone(), serviceZips: '', plan: plan?.id || storedPlan(), source } })
    if (status === 200 || status === 201 || data.error === 'already_exists') return onDone()
    if (data.error === 'signup_not_open') return setState({ error: `${NOT_OPEN} book a call with us from our home page.` })
    setState({ error: data.error === 'invalid_name' ? 'Enter your business name.' : 'Something went wrong. Please try again.' })
  }
  return (
    <form className="form" onSubmit={submit}>
      <h1 id="step-title" className="title">
        What’s your business called?
      </h1>
      <p className="lede">This is the name customers will see on your page.</p>
      <label className="field">
        <span>Business name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoComplete="organization" autoFocus />
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.busy}>
        {plan && !customer ? 'Continue to plan' : 'Continue'}
      </button>
    </form>
  )
}

// ---------- 2. Growth plan checkout (Stripe-hosted; plan id `founding`, unchanged) ----------
// Configure mode only: every setup step staff can do is done. The rest (payment confirmation, the ownership
// invitation, the owner's own calendar and receptionist decisions) is on the enrollment screen.
function HandoffStep({ me, back }) {
  return (
    <div className="form" data-handoff>
      <h1 id="step-title" className="title">
        Setup is ready for {me.customer?.name}
      </h1>
      <p className="lede">Everything here is saved. Go back to the enrollment to check payment and readiness, then send the ownership invitation.</p>
      <a className="btn btn-primary btn-block" href={`/admin/sales#${me.staff.enrollmentId}`}>
        Back to the enrollment
      </a>
      <Back onClick={back} />
    </div>
  )
}

function PaymentStep({ me, onDone, back }) {
  const params = new URLSearchParams(window.location.search)
  const returned = params.get('billing')
  const [state, setState] = useState(returned === 'success' ? { confirming: true } : me.checkoutOpen === false ? { notOpen: true } : {})
  const billing = me.progress.billing
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  })

  useEffect(() => {
    if (!state.confirming) return
    // Access follows Stripe's signed webhook; poll briefly while it arrives.
    let tries = 0
    const t = setInterval(async () => {
      tries++
      const { data } = await api('/api/dashboard/me')
      if (data?.progress?.steps?.find((s) => s.id === 'payment')?.done) {
        clearInterval(t)
        window.history.replaceState(null, '', '/dashboard')
        doneRef.current({ paid: true })
      } else if (tries >= 20) {
        clearInterval(t)
        setState({ slow: true })
      }
    }, 2000)
    return () => clearInterval(t)
  }, [state.confirming])

  const checkout = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/billing', { method: 'POST', body: { action: 'checkout', plan: me.progress.planId } })
    if (status === 200 && data.url) return window.location.assign(data.url)
    if (data.error === 'use_portal') return setState({ confirming: true })
    if (data.error === 'billing_not_live') return setState({ notOpen: true })
    setState({ error: 'Checkout is unavailable right now. Please try again in a moment.' })
  }

  if (state.confirming) {
    return (
      <div className="form" aria-live="polite">
        <h1 id="step-title" className="title">
          Confirming your payment…
        </h1>
        <p className="lede">This usually takes a few seconds.</p>
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        {billing === 'canceled' ? 'Reactivate your plan' : 'Start your Growth plan'}
      </h1>
      {returned === 'canceled' && (
        <p className="notice-soft" role="status">
          Checkout was cancelled. You haven’t been charged.
        </p>
      )}
      {state.slow && (
        <p className="notice-soft" role="status">
          We haven’t received confirmation from Stripe yet. If you completed payment, refresh in a minute.
        </p>
      )}
      <div className="plan-box">
        <p className="plan-name">GetShowUps Growth</p>
        <p className="plan-price">
          $499<span>/month</span>
        </p>
        <ul className="plan-points">
          <li>No free trial. Billed monthly; cancel any time from your billing page.</li>
          <li>Advertising spend is separate and paid directly to Google or Meta.</li>
          <li>Secure payment by Stripe. We never see your card details.</li>
        </ul>
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.notOpen && (
        <p className="notice-soft" role="status">
          {NOT_OPEN} <a href="/#book-demo">book a call with us</a>.
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy || state.notOpen} onClick={checkout}>
        {state.busy ? 'Opening checkout…' : 'Continue to secure checkout'}
      </button>
      <Back onClick={back} />
    </div>
  )
}

// The plan step when the owner comes back to it after paying: what is true now, nothing to buy again.
function PaidStep({ billing, onDone, back }) {
  const active = billing === 'active' || billing === 'trialing'
  return (
    <div className="form" data-plan-paid>
      <h1 id="step-title" className="title">
        Your Growth plan
      </h1>
      {active ? (
        <p className="setup-ok" role="status">
          <span className="status-dot" aria-hidden="true" />
          <span>Payment received. Your plan is active.</span>
        </p>
      ) : (
        <p className="notice-soft" role="status">
          Your plan needs attention. You can fix it from Settings once setup is finished.
        </p>
      )}
      <p className="fine">$499/month, billed monthly. Change your card or cancel any time from Settings once setup is finished.</p>
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onDone()}>
        Continue
      </button>
      <Back onClick={back} />
    </div>
  )
}

// ---------- 3. Business details ----------
const PROFILE_ERRORS = {
  phone: 'Enter a 10-digit US phone number, or leave it empty.',
  industry: 'Tell us what kind of business this is.',
  description: 'Keep the description under 400 characters.',
  'description:unapproved_claim': 'Please remove promises like guarantees, discounts, ratings or “licensed/insured” unless we’ve verified them with you.',
  cities: 'List up to 6 towns, separated by commas.',
  services: 'Add at least one service (up to 8).',
  'services:unapproved_claim': 'Service names and prices can’t include guarantees, discounts or ratings.',
}
const profileError = (fields = []) => fields.map((f) => PROFILE_ERRORS[f]).filter(Boolean)[0] || 'Please check the form and try again.'

function useProfile() {
  const [profile, setProfile] = useState(undefined)
  useEffect(() => {
    api('/api/dashboard/profile').then(({ status, data }) => setProfile(status === 200 ? data.profile || null : 'failed'))
  }, [])
  return profile
}

function DetailsStep({ customer, onDone, back, justPaid }) {
  const profile = useProfile()
  const [state, setState] = useState({})
  const [typed, setTyped] = useState(null) // what the owner typed under "What do you do?" (null = untouched)
  const [picked, setPicked] = useState(null) // the place the owner chose by hand (null = not chosen)
  if (profile === undefined) return <div aria-busy="true" />
  if (profile === 'failed') return <LoadError what="your details" onRetry={() => location.reload()} />
  const p = profile || {}
  // Where appointments happen: the owner's own choice once made (now, or saved earlier with these details). Until then
  // it follows the trade they type: a pool service goes to the customer. Always editable.
  const mode = picked ?? (p.industry ? customer.appointmentMode || 'at_business' : visitsCustomers(typed ?? '') ? 'at_customer' : 'at_business')
  const submit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setState({ busy: true })
    const biz = await api('/api/dashboard/business', {
      method: 'POST',
      body: { name: f.get('name'), timezone: f.get('timezone'), serviceZips: f.get('zips'), appointmentMode: f.get('mode') },
    })
    if (biz.status !== 200) return setState({ error: biz.data.error === 'invalid_zips' ? 'Use 5-digit ZIP codes separated by commas.' : 'Please check your business name and time zone.' })
    const r = await api('/api/dashboard/profile', {
      method: 'POST',
      body: { phone: f.get('phone'), industry: f.get('industry'), description: f.get('description'), cities: f.get('cities'), services: p.services || [] },
    })
    if (r.status === 200) return onDone()
    setState({ error: profileError(r.data.fields) })
  }
  return (
    <form className="form" onSubmit={submit}>
      <h1 id="step-title" className="title">
        Let’s get your website ready
      </h1>
      {justPaid && (
        <p className="setup-ok" role="status" data-paid-notice>
          <span className="status-dot" aria-hidden="true" />
          <span>Payment received. Your Growth plan is active.</span>
        </p>
      )}
      <p className="lede">A few quick questions. We’ll build your website from your answers.</p>
      <label className="field">
        <span>Business name</span>
        <input name="name" defaultValue={customer.name} maxLength={80} required autoComplete="organization" />
      </label>
      <label className="field">
        <span>What do you do?</span>
        <input name="industry" defaultValue={p.industry || ''} list="industries" maxLength={60} required placeholder="Pool service" onChange={(e) => setTyped(e.target.value)} />
        <datalist id="industries">
          {INDUSTRIES.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
      </label>
      <label className="field">
        <span>
          Business phone <em>(optional, shown on your page)</em>
        </span>
        <input name="phone" type="tel" defaultValue={p.phone || ''} autoComplete="tel" inputMode="tel" />
      </label>
      <fieldset className="field">
        <legend>Where do appointments happen?</legend>
        <div className="choice" role="radiogroup">
          {[
            ['at_customer', 'At the customer’s home or site'],
            ['at_business', 'At my location'],
          ].map(([value, label]) => (
            <label key={value} className="choice-option">
              <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setPicked(value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>
          Towns you serve <em>(comma separated)</em>
        </span>
        <input name="cities" defaultValue={(p.cities || []).join(', ')} placeholder="Charleston, Mount Pleasant" />
      </label>
      <label className="field">
        <span>
          ZIP codes you serve <em>(optional; leads outside them are marked for you)</em>
        </span>
        <input name="zips" defaultValue={(customer.serviceZips || []).join(', ')} inputMode="numeric" placeholder="29403, 29407" />
      </label>
      <label className="field">
        <span>
          Short description <em>(optional)</em>
        </span>
        <textarea name="description" rows={3} maxLength={400} defaultValue={p.description || ''} placeholder="Family-run pool care for homes across Charleston." />
      </label>
      <AiWrite field="description" draft />
      <label className="field">
        <span>Time zone</span>
        <TimeZoneSelect name="timezone" defaultValue={customer.timezone || browserTimeZone()} />
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.busy}>
        Continue
      </button>
      <Back onClick={back} />
    </form>
  )
}

// ---------- 4. Services ----------
function ServicesStep({ onDone, back }) {
  const profile = useProfile()
  const [edited, setRows] = useState(null)
  const [state, setState] = useState({})
  if (profile === undefined) return <div aria-busy="true" />
  if (profile === 'failed') return <LoadError what="your details" onRetry={() => location.reload()} />
  // Saved services, else suggestions for the industry, until the owner edits them.
  const saved = profile?.services || []
  const suggestions = SUGGESTED[(profile?.industry || '').toLowerCase()] || []
  const rows = edited ?? (saved.length ? saved : (suggestions.length ? suggestions.slice(0, 3) : ['']).map((name) => ({ name, price: '' })))
  const set = (i, k) => (e) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)))
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const r = await api('/api/dashboard/profile', { method: 'POST', body: { ...profile, services: rows.filter((r) => r.name.trim()), requireServices: true } })
    if (r.status === 200) return onDone()
    setState({ error: profileError(r.data.fields) })
  }
  return (
    <form className="form" onSubmit={submit}>
      <h1 id="step-title" className="title">
        What can customers book?
      </h1>
      <p className="lede">We’ve suggested a few. Edit, remove or add your own. Prices are optional.</p>
      {rows.map((r, i) => (
        <div key={i} className="service-row">
          <label className="field">
            <span className={i ? 'sr-only' : undefined}>Service</span>
            <input value={r.name} onChange={set(i, 'name')} maxLength={60} aria-label={`Service ${i + 1}`} />
          </label>
          <label className="field field--price">
            <span className={i ? 'sr-only' : undefined}>Price</span>
            <input value={r.price} onChange={set(i, 'price')} maxLength={40} placeholder="From $150" aria-label={`Price for service ${i + 1}`} />
          </label>
          <button type="button" className="link-btn service-remove" aria-label={`Remove service ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>
            Remove
          </button>
        </div>
      ))}
      {rows.length < 8 && (
        <button type="button" className="btn btn-quiet" onClick={() => setRows([...rows, { name: '', price: '' }])}>
          Add a service
        </button>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.busy}>
        Continue
      </button>
      {back && (
        <button type="button" className="link-btn" onClick={back}>
          Back
        </button>
      )}
    </form>
  )
}

// ---------- 5. Calendar ----------
function CalendarStep({ onBack, connected, onDone }) {
  const [state, setState] = useState({})
  const failed = new URLSearchParams(window.location.search).get('calendar_error')
  const start = async () => {
    setState({ busy: true })
    if (!(await connectCalendar())) setState({ failed: true })
  }
  // Back on this step after connecting: say what is connected; nothing to do again.
  if (connected)
    return (
      <>
        <h1 id="step-title" className="title">
          Google Calendar
        </h1>
        <CalendarHealth />
        <p className="lede">We check when you’re free and add booked appointments to your calendar. We never read event details.</p>
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onDone()}>
          Continue
        </button>
        <Back onClick={onBack} />
      </>
    )
  return (
    <>
      <h1 id="step-title" className="title">
        Connect Google Calendar
      </h1>
      <p className="lede">We check when you’re free and add booked appointments to your calendar. We never read event details.</p>
      {(state.failed || failed) && (
        <p className="form-error" role="alert">
          That didn’t connect. Please try again and allow calendar access.
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={start} disabled={state.busy}>
        {state.busy ? 'Opening Google…' : 'Connect Google Calendar'}
      </button>
      {/* The calendar is its own connection: it never depends on how the owner signed in (Google or email). */}
      <p className="fine" data-calendar-any-account>
        Choose the Google account whose calendar you book on. It doesn’t have to be the one you sign in with.
      </p>
      <Back onClick={onBack} />
    </>
  )
}

// ---------- 6. Hours (calendar verified live first) ----------
function OwnerCalendarStep({ onBack, onDone }) {
  const [state, setState] = useState({})
  const [status, setStatus] = useState(null)
  useEffect(() => {
    api('/api/dashboard/calendar').then(({ status: s, data }) => setStatus(s === 200 ? data : null))
  }, [])
  const link = async () => {
    setState({ busy: true })
    const { status: s, data } = await api('/api/dashboard/connect-link', { method: 'POST' })
    setState(s === 201 && data.url ? { url: data.url } : { failed: true })
  }
  const connected = status?.status === 'healthy'
  return (
    <>
      <h1 id="step-title" className="title">
        Google Calendar
      </h1>
      <p className="lede">
        {connected ? 'The owner’s Google Calendar is connected.' : 'The owner connects their own Google Calendar. Send them this single-use link, or they’ll be asked after they claim the account.'}
      </p>
      {!connected && !state.url && (
        <button type="button" className="btn btn-quiet btn-block" onClick={link} disabled={state.busy} data-owner-connect>
          {state.busy ? 'Creating link…' : 'Create a connect link for the owner'}
        </button>
      )}
      {state.url && (
        <p className="fine" data-owner-connect-link>
          Send this to the owner (it works once): <code>{state.url}</code>
        </p>
      )}
      {state.failed && (
        <p className="form-error" role="alert">
          Couldn’t create the link. Try again.
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onDone()}>
        Continue
      </button>
      <Back onClick={onBack} />
    </>
  )
}

function CalendarHealth() {
  const [cal, setCal] = useState(null)
  useEffect(() => {
    api('/api/dashboard/calendar').then(({ data }) => setCal(data || {}))
  }, [])
  if (!cal) return <p className="fine">Checking your calendar connection…</p>
  if (cal.status === 'healthy')
    return (
      <p className="setup-ok" data-calendar-connected>
        <span className="status-dot" aria-hidden="true" />
        <span>
          Google Calendar connected{cal.account?.email ? ` (${cal.account.email})` : ''}
        </span>
      </p>
    )
  return (
    <div className="notice-soft" role="alert">
      <p>We can’t reach your Google Calendar right now.</p>
      <button type="button" className="btn btn-sm btn-quiet" onClick={() => connectCalendar()}>
        Reconnect
      </button>
    </div>
  )
}
function HoursStep({ customer, onDone, back }) {
  return (
    <>
      <h1 id="step-title" className="title">
        When can customers book?
      </h1>
      <CalendarHealth />
      <p className="lede">Times already busy on your Google Calendar are hidden automatically.</p>
      <HoursForm customer={customer} submitLabel="Continue" onSaved={() => onDone()} />
      <Back onClick={back} />
    </>
  )
}

// ---------- 7. Website: generate (or keep the current site) → choose design → preview → edit ----------
function WebsiteStep({ onDone, back }) {
  const [data, setData] = useWebsite()
  const latest = useRef(null)
  const [stamp, setStamp] = useState(0)
  const [editorKey, setEditorKey] = useState(0)
  const [pending, setPending] = useState(null)
  const [state, setState] = useState({})
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your website. Please refresh.</p>
  const w = data.website
  const next = async () => {
    setState({ busy: true })
    const { status } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'save', content: latest.current || w.draft } })
    if (status === 200) return onDone()
    setState({ error: 'Please check the highlighted text, then continue.' })
  }
  const keepCurrent = async () => {
    setState({ mode: 'skip', busy: true })
    const { status } = await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'keep_website', choice: 'none' } })
    if (status === 200) return onDone()
    setState({ mode: 'skip', error: 'Something went wrong. Please try again.' })
  }
  // Three ways in, one editor: create new, bring the current website, or skip (booking only). All of them land on the
  // same draft, preview, publishing and version history.
  if (w.generated) {
    const mode = state.mode || 'new'
    const reload = async () => {
      const { status, data: d } = await api('/api/dashboard/website')
      if (status === 200) {
        setData(d)
        setStamp((n) => n + 1)
      }
    }
    return (
      <div className="form">
        <h1 id="step-title" className="title">
          Your website
        </h1>
        <div className="choice-list" role="radiogroup" aria-label="How do you want to start?">
          {[
            ['new', 'Create a new website', 'We write it from your details and show you three looks to choose from. You can edit everything.'],
            ['import', 'Bring my current website', 'We read your existing site so you don’t retype anything, then you restyle it here.'],
            ['design', 'Start from a design', 'Choose one of our professional layouts, filled in with your details. No AI needed.'],
            ['skip', 'Skip for now', 'Just use your booking link. You can create a website any time.'],
          ]
            // Bringing the current website is part of Website Studio (internal pilot).
            .filter(([value]) => value !== 'import' || data.studio)
            .map(([value, label, hint]) => (
            <label key={value} className="choice-card">
              <input type="radio" name="website-start" value={value} checked={mode === value} onChange={() => setState({ mode: value })} />
              <span>
                <strong>{label}</strong>
                <span className="fine">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {mode === 'new' && (
          <WebsiteGenerator
            studio={Boolean(data.studio)}
            storeKey={data.url}
            usage={data.aiUsage}
            onUsage={(aiUsage) => setData((d) => ({ ...d, aiUsage }))}
            intro="Nothing is public until you publish."
            onApplied={(d) => {
              setData(d)
              setStamp((n) => n + 1)
            }}
          />
        )}
        {mode === 'import' && data.studio && <WebsiteImport onApplied={reload} />}
        {mode === 'design' && (
          <WebsiteGenerator
            templates
            studio={Boolean(data.studio)}
            usage={data.aiUsage}
            intro="Nothing is public until you publish."
            onApplied={(d) => {
              setData(d)
              setStamp((n) => n + 1)
            }}
          />
        )}
        {mode === 'skip' && (
          <div className="stack">
            <p className="lede">You’ll get your booking link at the end of setup to share or add to an existing website. Create a website later from the Website tab.</p>
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy} onClick={keepCurrent}>
              Skip the website for now
            </button>
          </div>
        )}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        {back && (
          <button type="button" className="link-btn" onClick={back}>
            Back
          </button>
        )}
      </div>
    )
  }
  // A multi-page website (every website made here now is one, finding WEB-01): the step shows it and takes change
  // requests in the owner's words; editing text, photos, sections and pages happens in the full editor (Website) after
  // setup, so there is one editor, not a second smaller one here. Nothing is saved by Continue (the draft already is).
  if (w.draft?.site) {
    return (
      <div className="form">
        <h1 id="step-title" className="title">
          Here’s your website
        </h1>
        <p className="lede">Check it on a computer and a phone. It stays private until you publish.</p>
        <WebsitePreview stamp={stamp} query={pending ? `generation=${pending.id}&option=0&` : ''} unsaved={Boolean(pending)} />
        <ReviseBox
          pages
          usage={data.aiUsage}
          storeKey={data.url}
          onUsage={(aiUsage) => setData((d) => ({ ...d, aiUsage }))}
          onPreview={setPending}
          onApplied={(d) => {
            setData(d)
            setStamp((n) => n + 1)
          }}
        />
        <p className="notice-soft" data-edit-later>
          You can edit everything after setup, under <strong>Website</strong>: every text and photo, sections, extra pages, colours, and earlier versions to go back to.
        </p>
        {pending && (
          <p className="notice-soft" role="status" data-undecided>
            Choose “Keep this” or “Go back” for the new version above before you continue.
          </p>
        )}
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={Boolean(pending)} onClick={onDone}>
          Continue
        </button>
        {back && (
          <button type="button" className="link-btn" onClick={back}>
            Back
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        Here’s your website
      </h1>
      <p className="lede">Check it on a computer and a phone. Ask for any change in your own words, or edit the text yourself.</p>
      <WebsitePreview stamp={stamp} query={pending ? `generation=${pending.id}&option=0&` : ''} unsaved={Boolean(pending)} />
      <ReviseBox
        usage={data.aiUsage}
        onUsage={(aiUsage) => setData((d) => ({ ...d, aiUsage }))}
        onPreview={setPending}
        onApplied={(d) => {
          setData(d)
          latest.current = null
          setEditorKey((k) => k + 1)
          setStamp((n) => n + 1)
        }}
      />
      <details className="more">
        <summary>Edit text and photos</summary>
        <WebsiteEditor key={editorKey} initial={w.draft} baseUpdatedAt={w.updatedAt} colors={data.options.colors} designOptions={data.options} compact onEdit={(c) => (latest.current = c)} onSaved={() => setStamp((n) => n + 1)} />
      </details>
      <details className="more">
        <summary>Start over with three new designs</summary>
        <WebsiteGenerator
          usage={data.aiUsage}
          onUsage={(aiUsage) => setData((d) => ({ ...d, aiUsage }))}
          hasDraft
          onApplied={(d) => {
            setData(d)
            latest.current = null
            setEditorKey((k) => k + 1)
            setStamp((n) => n + 1)
          }}
        />
      </details>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {/* ONB-09: a requested change still waiting for "Keep this" / "Go back" is never dropped silently by moving on. */}
      {pending && (
        <p className="notice-soft" role="status" data-undecided>
          Choose “Keep this” or “Go back” for the new version above before you continue.
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy || Boolean(pending)} onClick={next}>
        Continue
      </button>
      {back && (
        <button type="button" className="link-btn" onClick={back}>
          Back
        </button>
      )}
    </div>
  )
}

// ---------- 8. Address: GetShowUps address (default), your own domain, or a new one ----------
function AddressStep({ onDone, back }) {
  const [data] = useWebsite()
  const [domain, setDomain] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!data) return <div aria-busy="true" />
  const next = async () => {
    setBusy(true)
    await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'address', choice: domain || data.domain ? 'own' : 'getshowups' } })
    onDone()
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        Choose your website address
      </h1>
      <p className="lede">Start with your free GetShowUps address. You can connect your own domain now or any time later.</p>
      <DomainSettings siteUrl={data.url || ''} compact onChange={(d) => setDomain(d.domain)} />
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={next}>
        Continue
      </button>
      <p className="fine">Connecting a domain keeps going in the background. Your website works on your GetShowUps address meanwhile.</p>
      {back && (
        <button type="button" className="link-btn" onClick={back}>
          Back
        </button>
      )}
    </div>
  )
}

// ---------- 9. Preview and publish (explicit approval) ----------
function PublishStep({ onDone, back }) {
  const [data] = useWebsite()
  const [busy, setBusy] = useState(false)
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your website. Please refresh.</p>
  const later = async () => {
    setBusy(true)
    await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'keep_private' } })
    onDone()
  }
  return (
    <div className="form">
        <h1 id="step-title" className="title">
          Preview and publish
        </h1>
        <p className="lede">This is exactly what customers will see. Publish when you’re happy. You can change it any time.</p>
        <WebsitePreview stamp={0} />
        <PublishBox
          data={data}
          label="Publish my website"
          onDone={onDone}
          secondary={
            <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={later}>
              Keep it private for now
            </button>
          }
        />
        {back && (
          <button type="button" className="link-btn" onClick={back}>
            Back
          </button>
        )}
    </div>
  )
}

// ---------- 10. Done ----------
// A calendar date as people say it ("Thu, Nov 26"), the same wording the dashboard's setup check uses.
const dayText = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

// What the dashboard raises right after setup, shown here first (ONB-04): the setup check's "Fix now" and "Important"
// items (GET /api/dashboard/setup-check, the same list the Overview and Settings read). The two that have one sensible
// answer (a public holiday on a booking day in the next weeks; no minimum notice) get a one-tap choice, saved through
// the same closed-dates and minimum-notice route Settings uses. Nothing is applied until the owner taps it; "Not now"
// leaves booking exactly as it is, and the item stays in Settings → Setup check. The others link to where they are fixed.
const ONE_TAP = ['holiday_open', 'no_notice']
function Decisions() {
  const [d, setD] = useState(null)
  const [check, setCheck] = useState([])
  const [skipped, setSkipped] = useState([])
  const [applied, setApplied] = useState([])
  const [state, setState] = useState({})
  useEffect(() => {
    api('/api/dashboard/availability').then(({ status, data }) => setD(status === 200 ? data : null))
    api('/api/dashboard/setup-check').then(({ status, data }) => setCheck(status === 200 ? data.items.filter((x) => x.level !== 'optional' && !ONE_TAP.includes(x.id)) : []))
  }, [])
  const open = setupDecisions(d).filter((x) => !skipped.includes(x.id))
  if (!open.length && !applied.length && !check.length) return null
  const accept = async (x) => {
    setState({ busy: x.id })
    const { status, data } = await api('/api/dashboard/availability', { method: 'POST', body: acceptDecision(d, x) })
    if (status !== 200) return setState({ error: 'Couldn’t save that. Please try again, or set it later in Settings.' })
    setD(data)
    setApplied((a) => [...a, x.kind === 'holiday' ? `Closed on ${x.label} (${dayText(x.date)}).` : 'Customers now need to book at least 2 hours ahead.'])
    setState({})
  }
  return (
    <section className="setup-decisions" aria-labelledby="decisions-title" data-decisions>
      <h2 id="decisions-title" className="setup-decisions-title">
        {open.length || check.length ? 'Before customers book' : 'Saved'}
      </h2>
      {open.length > 0 && <p className="fine">Nothing changes unless you choose it. You can change these any time in Settings.</p>}
      <ul className="rows">
        {open.map((x) => (
          <li key={x.id} className="row" data-decision={x.kind}>
            <div className="row-main">
              <p className="row-title">{x.kind === 'holiday' ? `Customers can book ${x.label} (${dayText(x.date)})` : 'Customers can book a time that starts in minutes'}</p>
              <p className="row-sub">{x.kind === 'holiday' ? 'It’s one of your booking days and isn’t marked closed.' : 'No minimum notice is set.'}</p>
            </div>
            <div className="row-actions">
              <button type="button" className="btn btn-sm btn-quiet" disabled={Boolean(state.busy)} onClick={() => accept(x)}>
                {x.kind === 'holiday' ? `Close ${x.label}` : 'Require 2 hours’ notice'}
              </button>
              <button type="button" className="link-btn" disabled={Boolean(state.busy)} onClick={() => setSkipped((k) => [...k, x.id])}>
                Not now<span className="sr-only">: {x.kind === 'holiday' ? x.label : 'minimum notice'}</span>
              </button>
            </div>
          </li>
        ))}
        {check.map((x) => (
          <li key={x.id} className="row" data-decision="check" data-check={x.id}>
            <div className="row-main">
              <p className="row-title">{x.title}</p>
              <p className="row-sub">
                {x.why} <a href={`/dashboard/${x.where}`}>{x.fix}</a>
              </p>
            </div>
          </li>
        ))}
      </ul>
      {applied.map((t) => (
        <p key={t} className="setup-ok" role="status">
          <span className="status-dot" aria-hidden="true" />
          <span>{t}</span>
        </p>
      ))}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  )
}

// The booking address, whole and selectable, with a copy button (the address itself opens the page).
function BookingLink({ url, onSite }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false) // no clipboard permission: the address is on screen and can be selected
    }
  }
  return (
    <div className="field share-link" data-booking-link>
      <span id="booking-link-label">Your booking link</span>
      <div className="share-link-row">
        <a className="share-link-url" href={url} target="_blank" rel="noreferrer" aria-labelledby="booking-link-label">
          {url}
        </a>
        <button type="button" className="btn btn-sm btn-quiet" onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="fine" aria-live="polite">
        {onSite ? 'The Book buttons on your website already use it. Add it to your Google profile and social pages too.' : 'Add it to your website, Google profile and social pages.'}
      </p>
    </div>
  )
}

function LaunchStep({ me, onDone }) {
  const [state, setState] = useState({})
  const [ready, setReady] = useState(null)
  const finish = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/onboarding', { method: 'POST', body: { action: 'finish' } })
    if (status === 200) return onDone()
    setState({ error: data.missing ? `Please finish: ${data.missing.map((m) => LABELS[m]).join(', ')}.` : 'Something went wrong. Please try again.' })
  }
  return (
    <div className="form">
      <h1 id="step-title" className="title">
        You’re all set
      </h1>
      <Readiness onLoad={setReady} />
      <Decisions />
      <BookingLink url={me.bookingUrl} onSite={ready?.items.some((i) => i.id === 'page' && i.detail === 'published') === true} />
      <p className="fine">A booking you make there goes on your Google Calendar like a real one. We mark bookings from your own email as tests, so they don’t count in your results.</p>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={state.busy} onClick={finish}>
        Go to my dashboard
      </button>
    </div>
  )
}
