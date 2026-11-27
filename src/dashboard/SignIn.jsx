// The one sign-in experience (docs/DESIGN_SYSTEM.md "Authentication"): Google first, then "or", then email.
// Email sign-in (server/email-auth.js): enter an address → "Check your email" → type the 6-digit code (or open the link
// in this browser). Used by the dashboard sign-in, the invitation page, the admin console, the claim landing and
// "sign in again" for consequential actions. It never decides access: the server does, on every request.
import { useEffect, useRef, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api } from '../lib/api.js'
import { readPending, useEmailOffered, writePending } from './signin-lib.js'

const START_ERRORS = {
  invalid_email: 'Enter your full email address, like name@example.com.',
  rate_limited: 'Too many sign-in emails for now. Wait a few minutes, then try again.',
  not_available: 'Email sign-in isn’t available right now. Continue with Google instead.',
  network_error: 'We couldn’t reach GetShowUps. Check your connection and try again.',
}
const CODE_ERRORS = {
  code_invalid: 'That code didn’t work. Check the newest email from us, or send a new code.',
  invalid_email: 'Enter your full email address, like name@example.com.',
  too_many_attempts: 'Too many tries with this code. Send a new code to continue.',
  rate_limited: 'Too many tries from this connection. Wait a few minutes, then try again.',
  not_available: 'Email sign-in isn’t available right now. Continue with Google instead.',
  network_error: 'We couldn’t reach GetShowUps. Check your connection and try again.',
}
const say = (table, code) => table[code] || 'Something went wrong on our side. Please try again.'

// The address field. One field, the browser's own email autofill, no extra steps.
function EmailForm({ busy, error, email, setEmail, onSubmit, inputRef }) {
  return (
    <form className="signin-email" onSubmit={onSubmit} noValidate>
      <label className="field">
        <span>Email</span>
        <input
          ref={inputRef}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck="false"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'signin-email-error' : undefined}
        />
      </label>
      {error && (
        <p id="signin-email-error" className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-quiet btn-lg btn-block" disabled={busy} data-email-continue>
        {busy ? 'Sending…' : 'Continue with email'}
      </button>
    </form>
  )
}

// Code entry: one paste-friendly field (spaces and dashes ignored), the platform's one-time-code autofill, submits by
// itself once 6 digits are in.
export function CodeForm({ email, onSignedIn, onNewCode, askEmail = false }) {
  const [code, setCode] = useState('')
  const [addr, setAddr] = useState(email || '')
  const [state, setState] = useState({})
  const ref = useRef(null)
  useEffect(() => ref.current?.focus(), [])
  const submit = async (value = code) => {
    const digits = value.replace(/\D/g, '')
    if (digits.length !== 6) return setState({ error: 'Enter the 6-digit code from the email.' })
    setState({ busy: true })
    const { status, data } = await api('/api/auth/email/verify', { method: 'POST', body: { email: addr, code: digits } })
    if (status === 200) return onSignedIn(data.next)
    setState({ error: say(CODE_ERRORS, data.error), dead: data.error === 'too_many_attempts' })
  }
  const onChange = (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    if (state.error) setState({})
    if (digits.length === 6 && !state.busy && (!askEmail || addr)) submit(digits)
  }
  return (
    <form
      className="signin-code"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      noValidate
    >
      {askEmail && (
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck="false" value={addr} onChange={(e) => setAddr(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>6-digit code</span>
        <input
          ref={askEmail ? undefined : ref}
          className="signin-code-input"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={9}
          placeholder="123456"
          value={code}
          onChange={onChange}
          aria-invalid={state.error ? 'true' : undefined}
          aria-describedby={state.error ? 'signin-code-error' : undefined}
          data-code-input
        />
      </label>
      {state.error && (
        <p id="signin-code-error" className="form-error" role="alert" data-code-error>
          {state.error}
        </p>
      )}
      {state.dead && onNewCode ? (
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onNewCode}>
          Send a new code
        </button>
      ) : (
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={state.busy}>
          {state.busy ? 'Signing in…' : 'Sign in'}
        </button>
      )}
    </form>
  )
}

// "Resend" with a visible countdown; never a disabled button without a reason.
function Resend({ sentAt, wait, onResend, busy }) {
  const [now, setNow] = useState(() => Date.now())
  const left = Math.max(0, Math.ceil((sentAt + wait * 1000 - now) / 1000))
  useEffect(() => {
    if (!left) return
    const t = setTimeout(() => setNow(Date.now()), 1000)
    return () => clearTimeout(t)
  }, [left, now])
  if (left) return <span className="fine" data-resend-wait>Resend in {left} s</span>
  return (
    <button type="button" className="link-btn" onClick={onResend} disabled={busy} data-resend>
      {busy ? 'Sending…' : 'Resend email'}
    </button>
  )
}

// The page's one h1; inside another page (compact) a section heading instead.
const Title = ({ compact, children }) => (compact ? <h2 className="signin-compact-title">{children}</h2> : <h1 className="title">{children}</h1>)

// The whole panel content: logo, title, context, the two ways in, and the "Check your email" step.
//   title / lede: the screen's context ("Welcome back", "Join Bravo Electric", …) · before / after: extra content shown
//   only while choosing (e.g. "Book a call", fine print) · next: allowlisted landing (/dashboard…, /admin) ·
//   googleHref: defaults to Google sign-in with next · notice: an error to show (e.g. a failed Google sign-in) ·
//   compact: no logo, an h2 title (inside a page, e.g. "sign in again") · googleQuiet: Google as a secondary button ·
//   google: false when the page already shows its own Google link (then only the email form).
export default function SignIn({ title, lede, before = null, after = null, next = '/dashboard', googleHref, notice = '', compact = false, googleQuiet = false, google = true }) {
  const offered = useEmailOffered()
  const [pending, setPending] = useState(() => readPending(next))
  const [email, setEmail] = useState(pending?.email || '')
  const [state, setState] = useState({})
  const [resendAfter, setResendAfter] = useState(30)
  const emailRef = useRef(null)
  const href = googleHref || `/api/auth/google/start${next && next !== '/dashboard' ? `?next=${encodeURIComponent(next)}` : ''}`

  const send = async (address) => {
    const e = address.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return setState({ error: START_ERRORS.invalid_email })
    setState({ busy: true })
    const { status, data } = await api('/api/auth/email/start', { method: 'POST', body: { email: e, next } })
    if (status !== 200) return setState({ error: say(START_ERRORS, data.error) })
    setResendAfter(Number(data.resendAfter) || 30)
    const p = { email: e, sentAt: Date.now(), next }
    writePending(p)
    setPending(p)
    setState({ resent: Boolean(pending) })
  }
  const signedIn = (to) => {
    writePending(null)
    window.location.assign(to || next)
  }
  const different = () => {
    writePending(null)
    setPending(null)
    setState({})
    setTimeout(() => emailRef.current?.focus(), 0)
  }

  if (pending)
    return (
      <div className="signin" data-signin-step="code">
        {!compact && <Logo href="/" />}
        <Title compact={compact}>Check your email</Title>
        <p className="lede">
          We sent a sign-in code to <strong data-sent-to>{pending.email}</strong>. Enter it below, or open the link in the email on this device.
        </p>
        <CodeForm email={pending.email} onSignedIn={signedIn} onNewCode={() => send(pending.email)} key={pending.sentAt} />
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        {state.resent && (
          <p className="fine" role="status">
            We sent a new code. Only the newest one works.
          </p>
        )}
        <div className="signin-actions">
          <Resend sentAt={pending.sentAt} wait={resendAfter} busy={state.busy} onResend={() => send(pending.email)} />
          <button type="button" className="link-btn" onClick={different} data-different-email>
            Use a different email
          </button>
        </div>
        <p className="fine">The code works once and expires in 15 minutes. Not there? Check spam or promotions.</p>
      </div>
    )

  return (
    <div className="signin" data-signin-step="choose">
      {!compact && <Logo href="/" />}
      {title && <Title compact={compact}>{title}</Title>}
      {lede && <p className="lede">{lede}</p>}
      {before}
      {notice && (
        <p className="form-error" role="alert">
          {notice}
        </p>
      )}
      {google && (
        <a className={`btn ${googleQuiet ? 'btn-quiet' : 'btn-primary'} btn-lg btn-block`} href={href}>
          Continue with Google
        </a>
      )}
      {(offered || !google) && (
        <>
          {google && (
            <p className="signin-or" aria-hidden="true">
              <span>or</span>
            </p>
          )}
          <EmailForm
            busy={state.busy}
            error={state.error}
            email={email}
            setEmail={(v) => {
              setEmail(v)
              if (state.error) setState({})
            }}
            inputRef={emailRef}
            onSubmit={(e) => {
              e.preventDefault()
              send(email)
            }}
          />
        </>
      )}
      {after}
    </div>
  )
}
