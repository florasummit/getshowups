// /claim — the owner takes over the business GetShowUps set up for them (assisted enrollment, server/enrollment.js).
// Invitation → sign in with the invited email (verified by the sign-in) → accept the terms → owner, in one step → the
// configured dashboard. Also where Stripe's hosted checkout returns (?paid=1 / ?paid=0): the owner has no account yet.
// The token stays in this tab's storage, never in the address after the first load.
//
// Sign-in seam (stream A): today "Continue with Google"; the shared sign-in component (Google or email) replaces the
// the shared sign-in panel (Google or email; src/dashboard/SignIn.jsx). Whatever the method, the server compares the session's VERIFIED email with the invited one.
import { useEffect, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, endStaffMode, noIndex } from '../lib/api.js'
import '../app.css'
import SignIn from '../dashboard/SignIn.jsx'

// Bump together with CLAIM_TERMS_VERSION in server/enrollment.js (the server refuses any other version).
const TERMS = [
  'You become the owner of this business account on GetShowUps.',
  'Your subscription is billed by Stripe every month at the price shown when you paid, until you cancel. You can cancel any time from Billing in your dashboard; your plan then runs to the end of the period you paid for.',
  'The GetShowUps staff who set up your account lose access to it as soon as you claim it.',
]
const KEY = 'gsu_claim'
function pendingToken() {
  try {
    const q = new URLSearchParams(window.location.search)
    const t = q.get('token')
    if (t && /^[A-Za-z0-9_-]{43}$/.test(t)) {
      sessionStorage.setItem(KEY, t)
      window.history.replaceState(null, '', '/claim')
    }
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}
const paidParam = () => new URLSearchParams(window.location.search).get('paid')
const forget = () => {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

function Panel({ title, children, state }) {
  return (
    <main className="center-page">
      <div className="panel panel--narrow enter" data-claim={state}>
        <Logo href="/" />
        <h1 className="title">{title}</h1>
        {children}
      </div>
    </main>
  )
}


async function signOutHere() {
  await api('/api/auth/logout', { method: 'POST' })
  window.location.replace('/claim')
}

const ERRORS = {
  invite_invalid: 'This link has expired or was already used. Ask the person who set up your account for a new one.',
  wrong_account: 'You’re signed in with a different email than the one this invitation is for.',
  already_in_business: 'This email already owns a business on GetShowUps.',
  already_claimed: 'This business already has an owner.',
  payment_required: 'The subscription payment hasn’t been confirmed yet. Try again in a minute.',
  terms_required: 'Please read and accept the terms first.',
  rate_limited: 'Too many tries. Please wait a few minutes.',
}

export default function Claim() {
  const [token] = useState(pendingToken)
  const [paid] = useState(paidParam)
  const [p, setP] = useState(token ? undefined : null)
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    document.title = 'Claim your account · GetShowUps'
    const cleanup = noIndex()
    // A claim is the owner's own session: never continue a staff configure mode this tab may remember.
    endStaffMode()
    try {
      sessionStorage.removeItem('gsu_staff_enrollment')
    } catch {
      // ignore
    }
    if (token) api(`/api/claim?token=${encodeURIComponent(token)}`).then(({ status, data }) => setP(status === 200 ? data : { missing: true, error: data?.error }))
    return cleanup
  }, [token])

  const claim = async () => {
    setBusy(true)
    setError(null)
    const { status, data } = await api('/api/claim', { method: 'POST', body: { token, acceptTerms: agree, termsVersion: p.termsVersion } })
    if (status === 200) {
      forget()
      return window.location.assign('/dashboard')
    }
    setBusy(false)
    setError(ERRORS[status === 429 ? 'rate_limited' : data?.error] || 'Something went wrong. Please try again.')
  }

  if (!token) {
    if (paid === '1')
      return (
        <Panel title="Thank you, your payment is being confirmed" state="paid">
          <p className="lede">Stripe will email your receipt. We’ll send you a link to take ownership of your account as soon as it’s ready.</p>
        </Panel>
      )
    if (paid === '0')
      return (
        <Panel title="Payment not completed" state="unpaid">
          <p className="lede">You haven’t been charged. Use the payment link you were sent whenever you’re ready, or ask us for a new one.</p>
        </Panel>
      )
    return (
      <Panel title="Open your invitation link" state="no-token">
        <p className="lede">Use the link in the email we sent you to claim your account.</p>
      </Panel>
    )
  }
  if (p === undefined) return <main className="center-page" aria-busy="true" />
  if (p.missing)
    return (
      <Panel title="This link no longer works" state="invalid">
        <p className="lede">{p.error === 'rate_limited' ? ERRORS.rate_limited : ERRORS.invite_invalid}</p>
      </Panel>
    )
  if (p.state === 'signed_out')
    return (
      <Panel title={`Claim ${p.businessName}`} state="signed-out">
        <p className="lede">Your account is set up and ready. Sign in with {p.email} to take ownership.</p>
        <SignIn compact next="/claim" googleHref="/api/auth/google/start?next=/claim" />
        <p className="fine">
          We only use your email address to sign you in. <a href="/privacy">Privacy policy</a>
        </p>
      </Panel>
    )
  if (p.state === 'wrong_account')
    return (
      <Panel title="Wrong account" state="wrong-account">
        <p className="lede">
          You’re signed in as {p.signedInAs}. This invitation is for {p.email}.
        </p>
        <button type="button" className="btn btn-primary btn-block" onClick={signOutHere}>
          Sign in with a different account
        </button>
      </Panel>
    )
  if (p.state === 'has_business')
    return (
      <Panel title="This email already owns a business" state="has-business">
        <p className="lede">
          {p.signedInAs} already owns {p.ownBusiness}. One email owns one business, so {p.businessName} can’t be added to it. Ask the person who set up your account to send the invitation to another email address.
        </p>
        <a className="btn btn-quiet btn-block" href="/dashboard">
          Go to {p.ownBusiness}
        </a>
      </Panel>
    )
  return (
    <Panel title={`Claim ${p.businessName}`} state="ready">
      <p className="lede">Signed in as {p.signedInAs}. One last step before your dashboard.</p>
      <ul className="fine claim-terms" data-terms={p.termsVersion}>
        {TERMS.map((t) => (
          <li key={t}>{t}</li>
        ))}
        <li>
          How we handle your data: <a href="/privacy">Privacy policy</a>.
        </li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I agree to these terms</span>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={claim} disabled={!agree || busy}>
        {busy ? 'Claiming…' : `Claim ${p.businessName}`}
      </button>
    </Panel>
  )
}
